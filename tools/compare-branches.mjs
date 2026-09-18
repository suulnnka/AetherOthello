#!/usr/bin/env node
/* ============================================================
 * 两条分支并排对比 —— 同一批局面、同一批档位,两个实现各跑一遍,看差异。
 *
 * 存在意义:仓库里 `main`(JS 参照实现)与 `zig`(Zig + wasm)共用同一份 Worker
 * 契约(docs/WORKER-PROTOCOL.md),所以「换个实现再跑一遍」应该是零成本的 ——
 * 这个脚本就是那条零成本路径,顺便替契约守门:
 *   · 先核对四个共享文件在两条分支上**逐字节一致**(不一致 = 契约已破,直接判负)
 *   · 再用 tools/probe-contract.mjs 的同一套断言跑两边
 *   · 最后并排打印着法/评分/深度/节点/耗时,同着法与否一眼可见
 *
 * 当前分支就地跑(不动工作区);另一条分支用 git worktree 拉到临时目录跑。
 *
 * 用法:node tools/compare-branches.mjs [--branch zig] [--levels 1,2] [--keep]
 *      --levels 默认 1,2(中级/高级);大师档(3)在 JS 通道上可能要跑几十秒
 * 退出码:0 契约两边都过 / 1 有契约失败或共享文件不一致
 * ============================================================ */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEngine, runCase, CASES } from './probe-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const git = (args, cwd = ROOT) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const CUR = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const OTHER = argOf('--branch', CUR === 'zig' ? 'main' : 'zig');
const LEVELS_IDX = argOf('--levels', '1,2').split(',').map(Number);
const KEEP = argv.includes('--keep');

const SHARED = ['src/levels.js', 'docs/WORKER-PROTOCOL.md', 'tools/probe-contract.mjs', 'tools/compare-branches.mjs'];

let fails = 0;

/* ---------- 0. 共享文件必须逐字节一致 ---------- */
console.log(`\n[对比] ${CUR}  vs  ${OTHER}`);
const drifted = SHARED.filter((f) => {
  try { git(['diff', '--quiet', CUR, OTHER, '--', f]); return false; } catch { return true; }
});
if (drifted.length) {
  console.log(`  ✗ 共享文件在两条分支上不一致(契约已破):`);
  for (const f of drifted) console.log(`      ${f}`);
  console.log(`    这些文件是接口的一部分,必须在两条分支上同样地改(见 docs/WORKER-PROTOCOL.md)`);
  fails++;
} else {
  console.log(`  ✓ 共享文件逐字节一致(${SHARED.join(' · ')})`);
}

/* ---------- 1. 另一条分支的 worktree ---------- */
/** 本机 Windows 上 git 写工作区会间歇漏文件(见项目记忆),所以对关键文件做一次
 *  体检并按需自愈 —— 对比脚本本身要是因为环境问题崩掉,就白做了。 */
function ensureFiles(dir, key) {
  const missing = key.filter((f) => !fs.existsSync(path.join(dir, f)));
  if (!missing.length) return;
  console.log(`  ⚠ ${dir} 缺 ${missing.length} 个关键文件,从索引恢复:${missing.join(', ')}`);
  execFileSync('git', ['checkout', '--force', '--', '.'], { cwd: dir, stdio: 'inherit' });
  const still = key.filter((f) => !fs.existsSync(path.join(dir, f)));
  if (still.length) throw new Error(`恢复后仍缺:${still.join(', ')}`);
}

const wt = path.join(os.tmpdir(), `othello-wt-${OTHER}`);
if (!fs.existsSync(path.join(wt, '.git'))) {
  fs.rmSync(wt, { recursive: true, force: true });
  console.log(`  · git worktree add ${wt} ${OTHER}`);
  execFileSync('git', ['worktree', 'add', '--force', wt, OTHER], { cwd: ROOT, stdio: 'inherit' });
} else {
  execFileSync('git', ['checkout', '--force', OTHER], { cwd: wt, stdio: 'inherit' });
}
ensureFiles(wt, ['src/worker.js', 'src/levels.js', 'src/engine.js']);
if (OTHER === 'zig' || CUR === 'zig') {
  const zigDir = OTHER === 'zig' ? wt : ROOT;
  const wasm = path.join(zigDir, 'wasm', 'othello.wasm');
  if (!fs.existsSync(wasm)) throw new Error(`zig 通道缺 ${wasm} —— 先在引擎仓跑 node tools/build-wasm.mjs`);
}
console.log(`  · 当前分支就地跑 ${ROOT}\n  · 另一分支 worktree ${wt}`);

/* ---------- 2. 各跑一遍 ---------- */
const tables = {};
async function prep(dir) {
  const { LEVELS } = await import(pathToFileURL(path.join(dir, 'src', 'levels.js')).href);
  const eng = await loadEngine(dir);
  const pong = await eng.ask({ type: 'ping' });
  return { eng, table: LEVELS, pong };
}
const A = await prep(ROOT);
const B = await prep(wt);
tables.A = A; tables.B = B;
console.log(`  · ${CUR} → engine=${A.pong.engine}   ${OTHER} → engine=${B.pong.engine}\n`);

const fmtN = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
const rows = [];
let same = 0, total = 0;

for (const lv of LEVELS_IDX) {
  for (const c of CASES) {
    const ra = await runCase(A.eng, c, lv, { table: A.table, timeout: 600_000 });
    const rb = await runCase(B.eng, c, lv, { table: B.table, timeout: 600_000 });
    if (!ra.ok) { fails++; console.log(`  ✗ ${CUR} 契约失败 @${c.name}:${ra.notes.join(' / ')}`); }
    if (!rb.ok) { fails++; console.log(`  ✗ ${OTHER} 契约失败 @${c.name}:${rb.notes.join(' / ')}`); }
    const na = ra.row, nb = rb.row;
    const agree = na.move === nb.move;
    if (agree) same++;
    total++;
    const line = (tag, r, extra) => `   ${tag.padEnd(5)} 着法 ${String(r.move).padStart(2)}  评分 ${r.score.toFixed(2).padStart(8)}`
      + `  深度 ${String(r.depth).padStart(2)}  节点 ${fmtN(r.nodes).padStart(7)}  ${(r.ms.toFixed(0) + 'ms').padStart(7)}`
      + (r.exact ? '  精确✓' : '') + extra;
    console.log(`${c.name}  [${A.table[lv].name}]`);
    console.log(line(CUR, na));
    console.log(line(OTHER, nb));
    console.log(`        → ${agree ? '同着法 ✓' : `着法不同(见上)`}`
      + `  节点 ${(nb.nodes / Math.max(na.nodes, 1)).toFixed(2)}×  耗时 ${(nb.ms / Math.max(na.ms, 1)).toFixed(2)}×`
      + (ra.want !== null ? `  裁判精确子差 ${ra.want}` : ''));
    rows.push({ case: c.name, lv: lv, agree, na, nb });
  }
}

/* ---------- 3. 小结 ---------- */
const sum = rows.reduce((acc, r) => ({
  nodes: acc.nodes + r.na.nodes, nodes2: acc.nodes2 + r.nb.nodes,
  ms: acc.ms + r.na.ms, ms2: acc.ms2 + r.nb.ms,
}), { nodes: 0, nodes2: 0, ms: 0, ms2: 0 });
console.log(`\n[小结] 同着法 ${same}/${total}`);
console.log(`       节点合计 ${fmtN(sum.nodes)} → ${fmtN(sum.nodes2)}(${(sum.nodes2 / Math.max(sum.nodes, 1)).toFixed(2)}×)`);
console.log(`       耗时合计 ${sum.ms.toFixed(0)}ms → ${sum.ms2.toFixed(0)}ms(${(sum.ms2 / Math.max(sum.ms, 1)).toFixed(2)}×)`);
console.log(`       (评分只在同一实现内可比;标了「精确✓」的那些是真实子差,两边可直接比)${fails ? '' : ' —— 契约两边都过'}`);

if (!KEEP && fs.existsSync(path.join(wt, '.git'))) {
  execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: ROOT, stdio: 'inherit' });
  console.log(`       worktree 已清理(${wt});要留下来复用加 --keep`);
}
process.exit(fails ? 1 : 0);
