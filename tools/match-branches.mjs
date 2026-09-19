#!/usr/bin/env node
/* ============================================================
 * 两条分支**对打** —— 让 main(Zig + wasm)与 legacy_js(JS 参照)互相下整局,看棋力差。
 *
 * 为什么不能只看 tools/compare-branches.mjs:那只回答"同一个局面各挑哪一步"。
 * 评分/节点数/耗时都不是棋力 —— 一个引擎可能更快更深却下得更差。棋力只有**对打**
 * 能回答,而且必须:
 *   · **配对开局**:同一开局下两盘、交换执子方。只跑一盘的话,"谁先手"就能解释掉
 *     全部差异(黑白棋黑先手优势很大)。
 *   · 多开局取样:同参数同引擎是确定性的,一个开局只贡献一个样本。
 *   · 局面推进用**独立的 2D 朴素规则**(不借任何一方的位棋盘 / 不借任何一方的搜索),
 *     两边只被当成"给局面返回一手"的黑箱。
 * 最后这条正是「契约一致」换来的能力:没有同一份接口,这两套实现没法同台。
 *
 * 用法:node tools/match-branches.mjs [--branch legacy_js] [--pairs 60] [--open 6]
 *        [--depth 6|none] [--levels A:B] [--seed 1] [--keep] [--quiet]
 *      --depth  对弈深度,**默认 6 层、两边一致** —— 跨实现比棋力必须把深度钉住,
 *               否则比的是"一边 d10 一边 d8"。传 none 退回各用各的档位。
 *      --levels 是 (当前分支档位):(另一分支档位);缺省用各自自报的 default。
 *               `--depth` 只替换深度上限,end / budget 仍取档位。
 *      ⚠ 两边档位**参数可能不同**(各引擎自己定),所以报告里会把参数并排打出来:
 *        depth 已钉住 + 其余参数相同 = 纯实现对比;否则只能当开箱体验看。
 * 退出码:0 跑完 / 1 有契约问题(非法着法、回包缺字段)
 * ============================================================ */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEngine, fetchLevels } from './probe-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);
const git = (args, cwd = ROOT) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const CUR = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const OTHER = argOf('--branch', CUR === 'legacy_js' ? 'main' : 'legacy_js');
const PAIRS = Number(argOf('--pairs', 60));
const OPEN = Number(argOf('--open', 6));
const SEED = Number(argOf('--seed', 1));
const LEVELS_ARG = has('--levels') ? argOf('--levels', '') : null;
/* 对弈深度:**默认 6 层、两边一致**。跨实现对打必须把深度钉住 ——
 * 否则比的是 zig 默认档的 d10 和 main 默认档的 d8,出来的差值分不清
 * 是"实现差"还是"参数差"。传 `--depth none` 退回"各用各的档位"(开箱体验对比)。 */
const DEPTH_ARG = argOf('--depth', '6');
const DEPTH = DEPTH_ARG === 'none' ? null : Number(DEPTH_ARG);
const KEEP = has('--keep');
const QUIET = has('--quiet');

const MAX_PLIES = 200;      // 保险丝:黑白棋最多 60 手 + 跳过,超过就是规则实现有问题

/* ==================== 独立规则(第三方,不借任何引擎) ==================== */
const DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

function flipsAt(st, s, me) {
  const opp = 3 - me, r = s >> 3, c = s & 7, res = [];
  for (const [dr, dc] of DIRS) {
    let rr = r + dr, cc = c + dc;
    const acc = [];
    while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && st[rr * 8 + cc] === opp) {
      acc.push(rr * 8 + cc); rr += dr; cc += dc;
    }
    if (acc.length && rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && st[rr * 8 + cc] === me) res.push(...acc);
  }
  return res;
}
function legalFor(st, me) {
  const out = [];
  for (let s = 0; s < 64; s++) if (st[s] === 0 && flipsAt(st, s, me).length) out.push(s);
  return out;
}
function countOf(st, me) { let n = 0; for (const v of st) if (v === me) n++; return n; }
const packOf = (st, me) => {
  let lo = 0, hi = 0;
  for (let i = 0; i < 64; i++) if (st[i] === me) { if (i < 32) lo |= 1 << i; else hi |= 1 << (i - 32); }
  return [lo >>> 0, hi >>> 0];
};

/** 随机走到第 k 手作为配对开局。返回 {st, me} —— me 是接下来该走的一方,
 *  两盘都从这里开始,只是把引擎换边(标准 paired-opening)。 */
function randomOpening(k, seed) {
  let st = new Int8Array(64);
  st[27] = 2; st[28] = 1; st[35] = 1; st[36] = 2;      // d4/w e4/b d5/b e5/w,黑先
  let me = 1, rnd = seed >>> 0;
  const next = () => (rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
  for (let i = 0; i < k; i++) {
    const mv = legalFor(st, me);
    if (!mv.length) { me = 3 - me; i--; continue; }     // 被跳过的一方不消耗这一步
    const s = mv[Math.floor(next() * mv.length)];
    const ns = Int8Array.from(st);
    for (const t of flipsAt(st, s, me)) ns[t] = me;
    ns[s] = me;
    st = ns; me = 3 - me;
  }
  return { st, me };
}

/* ==================== 一局棋 ==================== */
let seq = 0;

/** 从 st0(me0 行棋)下到终局;sideA 指定 A 引擎执哪个颜色。返回 A 视角子差 */
async function playGame(st0, me0, sideA, A, lvA, B, lvB, faults) {
  let st = Int8Array.from(st0), me = me0;
  for (let ply = 0; ply < MAX_PLIES; ply++) {
    const legal = legalFor(st, me);
    if (!legal.length) {
      if (!legalFor(st, 3 - me).length) break;          // 双方都无棋 → 终局
      me = 3 - me;
      continue;
    }
    const isA = me === sideA;
    const eng = isA ? A.eng : B.eng;
    const level = isA ? lvA : lvB;
    const tag = isA ? CUR : OTHER;

    const res = await eng.ask({
      type: 'think', id: ++seq,
      own: packOf(st, me), opp: packOf(st, 3 - me),
      level, depth: DEPTH ?? undefined,
      empties: 64 - countOf(st, 1) - countOf(st, 2),
    });
    if (res.error) { faults.push(`${tag} 回包 error:${res.error}`); return null; }

    /* 引擎报 -1 = 它认为无棋可走,可独立规则说它有棋 —— 契约破了。
     * 不静默兜底:兜底会把一个坏引擎的表现伪装成"下得还行"。 */
    if (res.move === -1 || !legal.includes(res.move)) {
      faults.push(`${tag} 非法着法 ${res.move}(合法 ${legal.length} 个,局面第 ${ply} 手)`);
      return null;
    }
    const ns = Int8Array.from(st);
    for (const t of flipsAt(st, res.move, me)) ns[t] = me;
    ns[res.move] = me;
    st = ns;
    me = 3 - me;
  }
  const diff = countOf(st, sideA) - countOf(st, 3 - sideA);
  return diff;
}

/* ==================== worktree 拉另一条分支 ==================== */
function ensureFiles(dir, key) {
  const missing = key.filter((f) => !fs.existsSync(path.join(dir, f)));
  if (!missing.length) return;
  console.log(`  ⚠ ${dir} 缺 ${missing.length} 个关键文件,从索引恢复:${missing.join(', ')}`);
  execFileSync('git', ['checkout', '--force', '--', '.'], { cwd: dir, stdio: 'inherit' });
  const still = key.filter((f) => !fs.existsSync(path.join(dir, f)));
  if (still.length) throw new Error(`恢复后仍缺:${still.join(', ')}`);
}

console.log(`\n[对打] ${CUR}  vs  ${OTHER}`);
const wt = path.join(os.tmpdir(), `othello-wt-${OTHER}`);
if (!fs.existsSync(path.join(wt, '.git'))) {
  fs.rmSync(wt, { recursive: true, force: true });
  execFileSync('git', ['worktree', 'add', '--force', wt, OTHER], { cwd: ROOT, stdio: 'inherit' });
} else {
  execFileSync('git', ['checkout', '--force', OTHER], { cwd: wt, stdio: 'inherit' });
}
ensureFiles(wt, ['src/worker.js', 'src/levels.js', 'src/engine.js']);
if (OTHER === 'main' || CUR === 'main') {
  const wasmDir = OTHER === 'main' ? wt : ROOT;
  if (!fs.existsSync(path.join(wasmDir, 'wasm', 'othello.wasm'))) {
    throw new Error(`main(wasm 通道)缺 ${path.join(wasmDir, 'wasm', 'othello.wasm')} —— 先在引擎仓跑 node tools/build-wasm.mjs`);
  }
}

/* ==================== 准备两个引擎 ==================== */
async function prep(dir) {
  const eng = await loadEngine(dir);
  const pong = await eng.ask({ type: 'ping' });
  const found = await fetchLevels(eng);
  return { eng, pong, table: found.table, def: found.def };
}
const A = await prep(ROOT);
const B = await prep(wt);

const pick = (s, i) => s.table[i] ?? s.table[s.def];
const [lvA, lvB] = LEVELS_ARG
  ? LEVELS_ARG.split(':').map((x) => Number(x.trim()))
  : [A.def, B.def];

const fmtLv = (s, i, lv) => (lv ? `${s.pong.engine} 档位 ${i}「${lv.name}」d${lv.depth}/e${lv.end}/${lv.budget}` : `${s.pong.engine} 无档位 ${i}`);
const la = pick(A, lvA), lb = pick(B, lvB);
if (!la || !lb) throw new Error(`档位不存在:${fmtLv(A, lvA, la)} · ${fmtLv(B, lvB, lb)}`);
/* 深度被 --depth 钉住时,"两边参数是否相同"就只需再看 end/budget ——
 * 拿档位表里的 depth 去比会得出"参数不同"的假结论,而实际跑的深度是同一个。 */
const sameRest = la.end === lb.end && la.budget === lb.budget;
const sameParams = DEPTH != null ? sameRest : (la.depth === lb.depth && sameRest);

console.log(`  · ${CUR} → engine=${A.pong.engine}   ${OTHER} → engine=${B.pong.engine}`);
console.log(`  档位  A) ${fmtLv(A, lvA, la)}`);
console.log(`        B) ${fmtLv(B, lvB, lb)}`);
if (DEPTH == null) {
  console.log(`  深度  各用各的档位 ⇒ ${sameParams ? '参数相同 ✓(纯实现对比)' : '⚠ 参数不同(这是"各自默认体验"的对比)'}`);
} else {
  console.log(`  深度  **两边都钉在 d${DEPTH}**(只覆盖搜索深度上限)` +
    (sameRest ? ' · end/budget 也相同 ✓ ⇒ 纯实现对比' : ' · ⚠ end/budget 仍不同(取各自档位)'));
}
console.log(`  开局  ${OPEN} 手随机 · ${PAIRS} 个配对开局(每个下两盘、交换执子方 = ${PAIRS * 2} 盘)`);
console.log(`  ⚠ 两个引擎各用一个 Worker 跑完全程(置换表跨局不清)—— 两边同样处理,不影响对比\n`);

/* ==================== 开打 ==================== */
const faults = [];
const scores = [];       // A 视角:胜 1 / 平 0.5 / 负 0
const diffs = [];        // A 视角逐盘子差(SE 要从逐盘数据算,不能估)
let winA = 0, winB = 0, draw = 0;
const t0 = Date.now();

for (let p = 0; p < PAIRS; p++) {
  const { st, me } = randomOpening(OPEN, SEED * 100003 + p * 7919);
  // 两盘:同一开局,交换执子方
  const d1 = await playGame(st, me, me, A, lvA, B, lvB, faults);          // A 执 me
  const d2 = await playGame(st, me, 3 - me, A, lvA, B, lvB, faults);      // A 执对手方
  if (d1 === null || d2 === null) continue;

  for (const d of [d1, d2]) {
    diffs.push(d);
    if (d > 0) { winA++; scores.push(1); }
    else if (d < 0) { winB++; scores.push(0); }
    else { draw++; scores.push(0.5); }
  }
  if (!QUIET && (p + 1) % 10 === 0) {
    const n = scores.length;
    const r = scores.reduce((a, b) => a + b, 0) / n;
    console.log(`  … ${p + 1}/${PAIRS} 对(| ${CUR} 得分率 ${(r * 100).toFixed(1)}% · ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
}

/* ==================== 结论 ==================== */
const N = scores.length;
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
/** 样本标准差 / √n —— 配对开局下有正相关,真实 SE 只会更小,所以这个值偏保守 */
const seOf = (xs) => {
  if (xs.length < 2) return 0;
  const m = avg(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1) / xs.length);
};
const mean = avg(scores), se = seOf(scores);
const avgDiff = avg(diffs), seDiff = seOf(diffs);

console.log(`\n[结果] 以 ${CUR} 为 A 记分(${N} 盘,耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
console.log(`  胜负平   ${CUR} ${winA} 胜 / ${OTHER} ${winB} 胜 / ${draw} 平`);
console.log(`  得分率   ${CUR} ${(mean * 100).toFixed(1)}% ± ${(se * 100).toFixed(1)}%(1 SE)`);
console.log(`  平均子差 ${CUR} 视角 ${avgDiff >= 0 ? '+' : ''}${avgDiff.toFixed(2)} ± ${seDiff.toFixed(2)}(1 SE)`);
if (N) {
  const z = se > 0 ? (mean - 0.5) / se : 0;
  const verdict = Math.abs(z) < 2
    ? `无显著差异(|z| = ${Math.abs(z).toFixed(1)} < 2)`
    : (z > 0 ? `${CUR} 显著更强` : `${OTHER} 显著更强`);
  console.log(`  结论     ${verdict}(z = ${z.toFixed(2)})`);
  if (N < 60) console.log(`  ⚠ 样本只有 ${N} 盘,SE 偏大 —— 结论只能当方向看,要拍板请 ≥200 盘`);
}
if (faults.length) {
  console.log(`\n  ✗ 契约问题 ${faults.length} 条(前 5 条):`);
  for (const f of faults.slice(0, 5)) console.log(`      ${f}`);
}

if (!KEEP && fs.existsSync(path.join(wt, '.git'))) {
  execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: ROOT, stdio: 'inherit' });
}
process.exit(faults.length ? 1 : 0);
