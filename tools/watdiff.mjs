/* ============================================================
 * 把两个 wasm 产物反汇编成 wat,并排比较它们"长得哪里不一样"。
 *
 * 用途:同一个引擎的两条实现通道(zig / rust)共用同一个 LLVM 后端,
 * 节点数能逐位对上、速度却差一截时,差异只在前端 lowering —— 这件事
 * 只能看 wat 才能说清(段结构、指令直方图、传参约定、访存次数)。
 *
 * 用法:
 *   node tools/watdiff.mjs                 # 段结构 + 指令直方图 + 导出函数并排
 *   node tools/watdiff.mjs --cg            # 追加调用图(找自递归 = 搜索/尾盘函数)
 *   node tools/watdiff.mjs --dump rust 7   # dump 某产物某个函数的开头 + 调用者
 *   node tools/watdiff.mjs --call zig 21 21  # 看 call N 前 10 条指令(判传参方式)
 *
 * 依赖:wabt(不在 package.json 里,它不是引擎运行所需)。
 *   npm i wabt                              # 装到当前项目
 *   WABT_PATH=<wabt 入口> node tools/watdiff.mjs   # 或指向别处的安装
 * 产物落在 out/(已 gitignore)。
 * ============================================================ */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let wabt;
try {
  wabt = await (process.env.WABT_PATH ? require(process.env.WABT_PATH) : require('wabt'))();
} catch {
  console.error('缺 wabt:先 npm i wabt(或用 WABT_PATH 指定已装的位置)。引擎本身不需要它。');
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const FILES = {
  zig: 'zig-out/bin/othello.wasm',
  rust: 'rust/target/wasm32-unknown-unknown/release/othello_engine.wasm',
};
// cargo/zig 的构建目录被清掉是常事(体积大、可重建),而 wasm/othello.wasm 是已落地的
// 当前分支产物 —— 找不到构建目录时回退到它,并在输出里标明,免得把两边认错。
const FALLBACK = 'wasm/othello.wasm';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cnt = (s, re) => (s.match(new RegExp(esc(re), 'g')) || []).length;

/** 逐段读 wasm 二进制的段头(段 id → 字节数),用来看 code/data 各占多少 */
function sections(buf) {
  const names = { 0: 'custom', 1: 'type', 2: 'import', 3: 'func', 4: 'table', 5: 'mem', 6: 'global', 7: 'export', 8: 'start', 9: 'elem', 10: 'code', 11: 'data', 12: 'datacount' };
  const out = [];
  let p = 8;
  while (p < buf.length) {
    const id = buf[p];
    let n = 0, shift = 0, q = p + 1;
    do { n |= (buf[q] & 0x7f) << shift; shift += 7; } while (buf[q++] & 0x80);
    out.push((names[id] ?? 'tag' + id) + ':' + n);
    p = q + n;
  }
  return out;
}

/** 把一个 wasm 切成函数数组:wat 顶层函数缩进固定 2 空格,按 "\n  (func" 切最省事 */
function parse(tag) {
  let file = FILES[tag];
  if (!fs.existsSync(file)) {
    if (fs.existsSync(FALLBACK)) {
      console.log(`(注意:${file} 不在,回退到落地产物 ${FALLBACK} —— 它属于当前分支,切分支前先确认)`);
      file = FALLBACK;
    } else {
      console.error(`找不到 ${file} —— 先构建对应通道(zig: node tools/build-wasm.mjs;rust: node tools/build-rust.mjs)`);
      process.exit(1);
    }
  }
  const buf = fs.readFileSync(file);
  const mod = wabt.readWasm(buf, { readDebugNames: false });
  mod.validate();
  const wat = mod.toText({ foldExprs: false });
  fs.mkdirSync('out', { recursive: true });
  fs.writeFileSync(`out/${tag}.wat`, wat);

  const exports = new Map();
  for (const m of wat.matchAll(/\(export "([^"]+)" \(func (\d+)\)\)/g)) exports.set(+m[2], m[1]);
  const funcs = wat.split(/\n  \(func/).slice(1).map((p, i) => {
    const body = '  (func' + p.split(/\n  \(/)[0];
    return {
      i, name: exports.get(i) || '', body,
      sig: body.split('\n')[0].replace('(func ', '').replace(/\(;.*?;\) /, ''),
      ops: body.split('\n').filter((l) => /^\s{4,}[a-z]/.test(l)).length,
      i64load: cnt(body, 'i64.load'), i64store: cnt(body, 'i64.store'),
      i32load: cnt(body, 'i32.load'), i32store: cnt(body, 'i32.store'),
      load8: cnt(body, 'load8_u'), pop: cnt(body, '.popcnt'), ctz: cnt(body, '.ctz'),
      br_if: cnt(body, 'br_if'), loop: cnt(body, 'loop'), sel: cnt(body, 'select'),
      and: cnt(body, 'i64.and'), or: cnt(body, 'i64.or'),
      shl: cnt(body, 'i64.shl'), shr: cnt(body, 'i64.shr_u'),
      lget: cnt(body, 'local.get'), unreachable: cnt(body, 'unreachable'),
      nloc: body.split('\n')[1]?.startsWith('    (local ') ? body.split('\n')[1].split(/\s+/).length - 3 : 0,
      calls: [...body.matchAll(/\bcall (\d+)\b/g)].map((m) => +m[1]),
    };
  });
  return { buf, wat, exports, funcs };
}

const args = process.argv.slice(2);
const A = parse('zig');
const B = parse('rust');

if (args[0] === '--dump') {
  const P = args[1] === 'zig' ? A : B;
  const f = P.funcs[Number(args[2])];
  const callers = P.funcs.filter((x) => x.calls.includes(f.i)).map((c) => '#' + c.i + (c.name || ''));
  console.log(`===== ${args[1]} #${f.i} ${f.name || '(internal)'} callers=${callers.join(',')}`);
  console.log(f.body.split('\n').slice(0, 62).join('\n'));
  process.exit(0);
}
if (args[0] === '--call') {
  const P = args[1] === 'zig' ? A : B;
  const lines = P.funcs[Number(args[2])].body.split('\n');
  const target = Number(args[3] ?? args[2]);
  const hits = lines.map((l, i) => (new RegExp(`\\bcall ${target}\\b`).test(l) ? i : -1)).filter((i) => i >= 0);
  console.log(`${args[1]} #${args[2]} 中 call ${target} 共 ${hits.length} 次;每次前 10 条指令(看实参怎么备好的):`);
  for (const i of hits.slice(0, 4)) console.log('--- @' + i + '\n' + lines.slice(i - 10, i + 1).map((x) => x.trim()).join('\n'));
  process.exit(0);
}

// 段结构 + 指令直方图
for (const [tag, P] of [['zig', A], ['rust', B]]) {
  console.log(`===== ${tag}  raw=${P.buf.length} B  wat=${(P.wat.length / 1024).toFixed(0)}KB 函数=${P.funcs.length}`);
  console.log('  sections: ' + sections(P.buf).join(' '));
  const ops = {};
  for (const m of P.wat.matchAll(/\b(i32|i64|f32|f64|v128)\.([a-z0-9_.]+)/g)) ops[m[0]] = (ops[m[0]] || 0) + 1;
  console.log('  top ops: ' + Object.entries(ops).sort((a, b) => b[1] - a[1]).slice(0, 16).map(([k, v]) => `${k}=${v}`).join(' '));
  console.log('');
}

// 导出函数同名并排(导出面一致是"同语义不同 lowering"的前提)
console.log('== 导出函数并排(ops=指令行数, mem=load+store) ==');
console.log('name'.padEnd(20) + 'zig:ops mem pop call unr | rust:ops mem pop call unr');
for (const [idx, name] of A.exports) {
  const a = A.funcs[idx];
  const b = B.funcs[[...B.exports.entries()].find(([, n]) => n === name)?.[0]];
  const f = (x) => (x === undefined ? '-' : String(x));
  console.log(
    name.padEnd(20) +
      f(a.ops).padStart(6) + f(a.i64load + a.i64store + a.i32load + a.i32store).padStart(5) +
      f(a.pop).padStart(4) + f(a.calls.length).padStart(5) + f(a.unreachable).padStart(4) + '  | ' +
      f(b?.ops).padStart(6) + f(b ? b.i64load + b.i64store + b.i32load + b.i32store : '-').padStart(5) +
      f(b?.pop).padStart(4) + f(b?.calls.length).padStart(5) + f(b?.unreachable).padStart(4),
  );
}

if (!args.includes('--cg')) process.exit(0);

// 调用图:自递归函数就是搜索/尾盘,静态分布差异主要看它们
for (const [tag, P] of [['zig', A], ['rust', B]]) {
  console.log(`\n===== ${tag} 调用图(≥200 ops)`);
  console.log('  自递归: ' + P.funcs.filter((f) => f.calls.includes(f.i)).map((f) => '#' + f.i + (f.name || '')).join(' '));
  for (const f of P.funcs.filter((x) => x.ops >= 200)) {
    console.log(
      ('#' + f.i + ' ' + (f.name || '(in)')).padEnd(22) +
        ('ops=' + f.ops).padStart(9) + (' mem=' + (f.i64load + f.i64store + f.i32load + f.i32store)).padStart(8) +
        (' l8=' + f.load8).padStart(6) + (' br_if=' + f.br_if).padStart(9) + (' sel=' + f.sel).padStart(6) +
        (' and/or=' + f.and + '/' + f.or).padStart(13) + (' shl/shr=' + f.shl + '/' + f.shr).padStart(13) +
        (' loc=' + f.nloc).padStart(7),
    );
    console.log('      sig: ' + f.sig.slice(0, 100));
    console.log('      → ' + f.calls.map((c) => '#' + c + (P.funcs[c]?.name || '')).join(' ').slice(0, 200));
  }
}
