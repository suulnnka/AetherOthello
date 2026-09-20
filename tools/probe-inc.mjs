/* ============================================================
 * ④ 增量评估的最小 wasm 复现 + 验收探针。
 *
 * 为什么必须有这一条(呼应 docs/engine-improvement-plan.md 完成记录"遗留 1"):
 * ④ 首轮"原生线性对拍正确、wasm 槽号状态漂移",4 轮结构重排不改行为,
 * 最后回退 —— 但**拿不出最小复现**,因为当时没有一条通道能直接驱动 wasm
 * 里的增量路径并与全量重算逐位比对。本探针补上这条通道,且驱动形状与
 * search() 同形(快照 → 增量 → 递归 → 恢复,兄弟子树共用父状态)——
 * 线性对拍盖不住的"复用污染"只有这种遍历能打中。
 *
 * 三条通道夹同一份 inc.zig(原生单测跑的也是它,zig build test):
 *   A wasm 内部自检:probeCheck 全量重算 vs 增量状态(免拷贝、无对齐歧义)
 *   B JS 独立重算:model.mjs 几何重算 38 个槽号,与 wasm 内存逐字比对
 *       —— 顺带盯住 lo/hi 拆装、side 记账、导出层(probe-wasm 的纪律)
 *   C wasm 内部搜索同形 DFS:probeDfs 一调进树,含虚着分支
 *
 * 另一条被本探针钉死的结论(2026-09-20,写进 inc.zig 头注):
 *   「行棋方视角槽号 + 落点/翻子局部增量」的直觉写法**必然漂移** ——
 *   每落一手行棋方就换,盘上全部有子格子的 1↔2 语义整体翻转,
 *   翻子格反而是唯一不变的格子。第一次实现就是这么写的,本探针的
 *   原生前身(单测)第一步就把它打了回来。正确姿势 = 固定黑方视角
 *   维护槽号,求值时按行棋方取号(折叠对称性 W(换色·s) = −W(s),
 *   int8 取负无舍入 ⇒ 与全量重算逐位相等)。
 *
 * 用法:node tools/probe-inc.mjs [wasm 路径] [--games N]
 * 退出码:0 全过 / 1 有失败
 * ============================================================ */
import fs from 'node:fs';
import { CELLS, PTN_OFF, PTN_COUNT } from './model.mjs';

const argv = process.argv.slice(2);
const wasmPath = argv.find((a) => !a.startsWith('--')) || 'zig-out/bin/incprobe.wasm';
const gi = argv.indexOf('--games');
const GAMES = gi >= 0 ? Number(argv[gi + 1]) : 8;
const DFS_DEPTH = 4;
const DFS_POS = 14; // 含 2 个"根必然虚着"的局面

let fails = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) fails++;
  return cond;
};

/* ---------- 实例化 ---------- */
const bytes = fs.readFileSync(wasmPath);
const mod = new WebAssembly.Module(bytes);
const imports = WebAssembly.Module.imports(mod);
console.log(`\n[wasm] ${wasmPath}  ${bytes.length} B`);
ok(imports.length === 0, `无外部依赖(freestanding):import 数 = ${imports.length}`);

const X = new WebAssembly.Instance(mod, {}).exports;
ok(typeof X.memory === 'object', 'memory 已导出(内存窗口用)');
const NEED = ['probeInit', 'probePtnCount', 'probeOpen', 'probePlay', 'probePass', 'probeCheck',
  'probeSumInt', 'probeEvalIntFull', 'probeStatePtr', 'probeTruthPtr', 'probeBlackToMove',
  'probeDiscs', 'probeOwnLo', 'probeOwnHi', 'probeOppLo', 'probeOppHi', 'probeMovesLo', 'probeMovesHi',
  'probeDfs', 'probeDfsNodesLo', 'probeDfsNodesHi', 'probeDfsPasses', 'probeDfsEvalBad',
  'probeDfsCapped', 'probeDfsBadPtn', 'probeDfsBadExpect', 'probeDfsBadGot'];
const missing = NEED.filter((n) => typeof X[n] !== 'function');
ok(missing.length === 0, `导出符号齐全(${NEED.length} 个)` + (missing.length ? ` 缺 ${missing}` : ''));

/* ---------- 位板工具(BigInt,与 probe-wasm 同款、JS 独立实现)---------- */
const B = (r, c) => 1n << BigInt(r * 8 + c);
const lo32 = (b) => Number(b & 0xFFFF_FFFFn);
const hi32 = (b) => Number(b >> 32n);
const popcnt = (b) => {
  let n = 0n, x = b;
  while (x) { n += x & 1n; x >>= 1n; }
  return Number(n);
};
const DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

function flipsAt(own, opp, sq) {
  const r = sq >> 3, c = sq & 7;
  let f = 0n;
  for (const [dr, dc] of DIRS) {
    let rr = r + dr, cc = c + dc;
    const acc = [];
    while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && ((opp >> BigInt(rr * 8 + cc)) & 1n)) {
      acc.push(rr * 8 + cc); rr += dr; cc += dc;
    }
    if (acc.length && rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && ((own >> BigInt(rr * 8 + cc)) & 1n)) {
      for (const s of acc) f |= 1n << BigInt(s);
    }
  }
  return f;
}
function legalMask(own, opp) {
  let m = 0n;
  for (let s = 0; s < 64; s++) {
    if (!((own >> BigInt(s)) & 1n) && !((opp >> BigInt(s)) & 1n) && flipsAt(own, opp, s)) m |= 1n << BigInt(s);
  }
  return m;
}
/** 走一手后**换手**:返回 [新 own, 新 opp] */
function applyMove(own, opp, sq) {
  const f = flipsAt(own, opp, sq);
  const b = 1n << BigInt(sq);
  return [opp & ~f, own | f | b];
}

const INIT_B = B(3, 4) | B(4, 3);
const INIT_W = B(3, 3) | B(4, 4);

/* 种子随机(mulberry 风格 LCG,与 probe-wasm 同款;固定种子 = 完全可复现) */
function mkRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x80000000;
  };
}

/* ---------- JS 独立重算:model.mjs 几何 → 38 个黑方视角槽号 ---------- */
const POW3 = [1, 3, 9, 27, 81, 243, 729, 2187, 6561];
function slotsJS(black, white) {
  const out = [];
  for (let p = 1; p <= PTN_COUNT; p++) {
    let idx = 0;
    const cells = CELLS[p];
    for (let i = 0; i < cells.length; i++) {
      const bit = 1n << BigInt(cells[i]);
      idx += (black & bit ? 1 : white & bit ? 2 : 0) * POW3[i];
    }
    out.push(PTN_OFF[p] + idx);
  }
  return out;
}

const memU32 = (ptr, n) => new Uint32Array(X.memory.buffer, ptr, n);
/** 三通道全查:wasm 自检 + JS 独立重算 + 整数和 + 面板一致性 */
function fullCheck(own, opp, blackToMove, tag) {
  const d = popcnt(own | opp);
  const black = blackToMove ? own : opp;
  const white = blackToMove ? opp : own;
  const c = X.probeCheck();
  if (c !== 255) return `${tag}: probeCheck = ${c}(${c === 38 ? '子数记账漂移' : '表 ' + c + ' 不一致'})`;
  const state = memU32(X.probeStatePtr(), PTN_COUNT);
  const js = slotsJS(black, white);
  for (let i = 0; i < PTN_COUNT; i++) {
    if (state[i] !== js[i]) return `${tag}: 表 ${i} 内存=${state[i]} JS=${js[i]}(导出层/几何不一致)`;
  }
  const truth = memU32(X.probeTruthPtr(), PTN_COUNT);
  for (let i = 0; i < PTN_COUNT; i++) {
    if (truth[i] !== js[i]) return `${tag}: 表 ${i} truth=${truth[i]} JS=${js[i]}`;
  }
  if (X.probeSumInt() !== X.probeEvalIntFull()) {
    return `${tag}: 增量和 ${X.probeSumInt()} ≠ 全量和 ${X.probeEvalIntFull()}`;
  }
  if (X.probeBlackToMove() !== (blackToMove ? 1 : 0)) return `${tag}: 行棋方记账不一致`;
  if (X.probeDiscs() !== d) return `${tag}: 子数 ${X.probeDiscs()} ≠ ${d}`;
  const o = BigInt(X.probeOwnLo() >>> 0) | (BigInt(X.probeOwnHi() >>> 0) << 32n);
  const p2 = BigInt(X.probeOppLo() >>> 0) | (BigInt(X.probeOppHi() >>> 0) << 32n);
  if (o !== own || p2 !== opp) return `${tag}: wasm 位板与 JS 棋盘散了`;
  return null;
}

/* ---------- A. 初始化 ---------- */
console.log('\n[A] 初始化与元信息');
const failStage = X.probeInit();
ok(failStage === 0, `probeInit() = ${failStage}(0 = 就绪;非 0 = pattern.failStage)`);
ok(X.probePtnCount() === PTN_COUNT, `表数一致:zig ${X.probePtnCount()} = JS model ${PTN_COUNT}`);

/* ---------- B. 线性随机对局(JS 驱动,三通道逐 ply 对拍)---------- */
console.log(`\n[B] 线性随机对局(${GAMES} 局,固定种子,逐 ply 三通道对拍)`);
const rng = mkRng(0x1AC_2026);
let bBad = 0, bPlies = 0, bPasses = 0;
let dMin = 64, dMax = 0, bErr = '';
for (let g = 0; g < GAMES; g++) {
  let own = INIT_B, opp = INIT_W, blackToMove = true;
  X.probeOpen(lo32(own), hi32(own), lo32(opp), hi32(opp), blackToMove ? 1 : 2);
  let err = fullCheck(own, opp, blackToMove, `局${g} 开局`);
  if (err) { bErr ||= err; bBad++; continue; }
  for (let ply = 0; ply < 70; ply++) {
    const m = legalMask(own, opp);
    if (!m) {
      if (!legalMask(opp, own)) break; // 终局
      X.probePass();
      [own, opp] = [opp, own];
      blackToMove = !blackToMove;
      bPasses++;
      continue;
    }
    const list = [];
    for (let s = 0; s < 64; s++) if ((m >> BigInt(s)) & 1n) list.push(s);
    const sq = list[Math.floor(rng() * list.length)];
    X.probePlay(sq);
    [own, opp] = applyMove(own, opp, sq);
    blackToMove = !blackToMove;
    bPlies++;
    dMin = Math.min(dMin, popcnt(own | opp));
    dMax = Math.max(dMax, popcnt(own | opp));
    err = fullCheck(own, opp, blackToMove, `局${g} ply${ply}`);
    if (err) { bErr ||= err; bBad++; break; }
  }
}
ok(bBad === 0, `${GAMES} 局 × ${bPlies} 手逐 ply 一致(槽号/内存/整数和/记账)` + (bBad ? ` → ${bErr}` : ''));
ok(bPasses > 0, `覆盖到虚着路径(虚着 ${bPasses} 次)`);
ok(dMin <= 24 && dMax >= 44, `三个相位都被踩过(子数 ${dMin}..${dMax})`);

/* ---------- C. wasm 内部搜索同形 DFS ---------- */
console.log(`\n[C] wasm 内部 DFS(快照→增量→递归→恢复,深 ${DFS_DEPTH})`);
/* 随机对局造局面(带行棋方)。空位数检查在虚着处理**之前**:
 * 把僵局局面(行棋方无子可走)原样返回而不是当虚着路过 —— 第一版把检查放在
 * 虚着之后,要找的局面被生成器自己消费掉,2 万次采样 0 命中(死循环的根源) */
function rndPos(rng2, emptiesWant) {
  let own = INIT_B, opp = INIT_W, blackToMove = true;
  while (64 - popcnt(own | opp) > emptiesWant) {
    const m = legalMask(own, opp);
    if (!m) {
      if (!legalMask(opp, own)) break; // 终局
      [own, opp] = [opp, own];
      blackToMove = !blackToMove;
      continue;
    }
    const list = [];
    for (let s = 0; s < 64; s++) if ((m >> BigInt(s)) & 1n) list.push(s);
    const sq = list[Math.floor(rng2() * list.length)];
    [own, opp] = applyMove(own, opp, sq);
    blackToMove = !blackToMove;
  }
  return { own, opp, blackToMove };
}
/* 找"行棋方无子可走、对方有"的根局面:DFS 根节点必然进虚着分支。
 * 空位越少僵局越常见,10 空找不到就降到 8/6;有预算上限,绝不挂死 */
function findStalemate(rng2) {
  for (const want of [10, 8, 6]) {
    for (let i = 0; i < 3000; i++) {
      const pos = rndPos(rng2, want);
      if (popcnt(pos.own | pos.opp) === 64) break; // 满盘,换一批
      if (!legalMask(pos.own, pos.opp) && legalMask(pos.opp, pos.own)) return pos;
    }
  }
  return null;
}
const dfsRng = mkRng(0xDF5_2026);
let cBad = 0, cErr = '', cNodes = 0, cPasses = 0, cMinNodes = Infinity;
for (let t = 0; t < DFS_POS; t++) {
  // 后两盘特意用"行棋方无子可走"的根:根节点必然进虚着分支
  const pos = t < DFS_POS - 2 ? rndPos(dfsRng, 34 - t * 2) : findStalemate(dfsRng);
  if (!pos) { cErr ||= `局面#${t}:没找到僵局局面`; cBad++; continue; }
  const side = pos.blackToMove ? 1 : 2;
  const bad = X.probeDfs(lo32(pos.own), hi32(pos.own), lo32(pos.opp), hi32(pos.opp), side, DFS_DEPTH);
  const nodes = X.probeDfsNodesLo() + X.probeDfsNodesHi() * 4294967296;
  cNodes += nodes;
  cPasses += X.probeDfsPasses();
  cMinNodes = Math.min(cMinNodes, nodes);
  if (bad !== 0 || X.probeDfsEvalBad() !== 0 || X.probeDfsCapped() || nodes < 10) {
    cErr ||= `局面#${t}(空 ${64 - popcnt(pos.own | pos.opp)}):bad=${bad} evalBad=${X.probeDfsEvalBad()}`
      + ` 表${X.probeDfsBadPtn()} expect=${X.probeDfsBadExpect()} got=${X.probeDfsBadGot()} nodes=${nodes}`;
    if (cBad < 3) console.log(`    ✗ ${cErr}`);
    cBad++;
  }
}
ok(cBad === 0, `${DFS_POS} 个局面 × 深 ${DFS_DEPTH} 全部逐节点一致(兄弟复用 + 虚着)` + (cBad ? '' : ` · ${cNodes} 节点`));
ok(cPasses > 0, `DFS 覆盖到虚着分支(虚着节点 ${cPasses} 个)`);

/* ---------- D. 重置卫生:中途换局面,旧状态不得泄漏 ---------- */
console.log('\n[D] 重置卫生(跨局面状态泄漏)');
{
  const p1 = rndPos(mkRng(0xBEEF), 30);
  X.probeOpen(lo32(p1.own), hi32(p1.own), lo32(p1.opp), hi32(p1.opp), p1.blackToMove ? 1 : 2);
  X.probePlay(64 - 1); // 故意来一手(不合法也行,probeCheck 会抓)
  const p2 = rndPos(mkRng(0xF00D), 26);
  X.probeOpen(lo32(p2.own), hi32(p2.own), lo32(p2.opp), hi32(p2.opp), p2.blackToMove ? 1 : 2);
  const err = fullCheck(p2.own, p2.opp, p2.blackToMove, '重开后');
  ok(err === null, '中途换局面后状态完全重派生(无上一局的残留)' + (err ? ` → ${err}` : ''));
}

console.log(fails === 0 ? '\n✓ 增量评估探针全部通过(④ 的最小 wasm 复现通道就绪)' : `\n✗ 增量评估探针失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
