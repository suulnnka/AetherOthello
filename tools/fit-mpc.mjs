/* MPC σ 模型拟合数据采集 + 最小二乘拟合。
 *
 * 原理:MPC 用「浅层验证搜索 + 误差界」剪枝;误差界 σ(empties, d_verify, d)
 * 必须来自**本引擎**的实测分差分布(Egaroucid 的系数对它的评估调的,不能抄)。
 * 采集:固定种子随机对局的中局局面,分别用完整深度 d 与验证深度 d/4 跑
 * 引擎,记录分差 s_shallow − s_deep,按 (empties, d) 分桶算标准差。
 * 拟合:σ ≈ c0 + c1·empties + c2·d_verify(线性模型,系数带 12% 安全余量 ——
 * σ 偏大只是少剪,偏小会剪错,宁大勿小)。
 *
 * 用法:node tools/fit-mpc.mjs [样本数] [wasm 路径]
 */
import fs from 'node:fs';

const N = Number(process.argv[2]) || 160;
const wasmPath = process.argv[3] || 'zig-out/bin/othello.wasm';
const X = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(wasmPath)), {}).exports;
if (X.engineInit() !== 0) { console.error('engineInit 失败'); process.exit(1); }

const parse = (s) => s.trim().split('\n').map((l) => [...l.trim()].map((c) => (c === 'b' ? 'b' : c === 'w' ? 'w' : null)));
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const other = (p) => (p === 'b' ? 'w' : 'b');
function flipsFor(b, r, c, color) {
  if (b[r][c]) return [];
  const out = [];
  for (const [dr, dc] of DIRS) {
    const line = [];
    let rr = r + dr, cc = c + dc;
    while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && b[rr][cc] && b[rr][cc] !== color) { line.push([rr, cc]); rr += dr; cc += dc; }
    if (line.length && rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && b[rr][cc] === color) out.push(...line);
  }
  return out;
}
function legalMoves(b, color) {
  const out = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (!b[r][c] && flipsFor(b, r, c, color).length) out.push([r, c]);
  return out;
}
function randomPosition(plies, seedIn) {
  let b = parse(`
    ........
    ........
    ........
    ...wb...
    ...bw...
    ........
    ........
    ........`);
  let seed = seedIn;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let turn = 'b';
  for (let k = 0; k < plies; k++) {
    const ms = legalMoves(b, turn);
    if (!ms.length) { if (!legalMoves(b, other(turn)).length) break; turn = other(turn); continue; }
    const [r, c] = ms[Math.floor(rnd() * ms.length)];
    const fl = flipsFor(b, r, c, turn);
    b = b.map((row) => [...row]);
    b[r][c] = turn;
    for (const [fr, fc] of fl) b[fr][fc] = turn;
    turn = other(turn);
  }
  return b;
}
const toLoHi = (b, color) => {
  let ow = 0n, op = 0n;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const bit = 1n << BigInt(r * 8 + c);
    if (b[r][c] === color) ow |= bit; else if (b[r][c]) op |= bit;
  }
  return [Number(ow & 0xFFFFFFFFn), Number(ow >> 32n), Number(op & 0xFFFFFFFFn), Number(op >> 32n)];
};
function think(b, color, depth) {
  const [a, bb, c, d] = toLoHi(b, color);
  X.engineClear();
  X.engineThink(a, bb, c, d, depth, 0, 0, 0);
  return X.engineScore();
}

/* 深度对:MPC 在节点深度 d 用 d/4 验证(search.zig:向上取整到偶数、奇偶对齐 d)。
 * PAIRS 必须贴着这个映射采样 —— 模型没有 d 项,c2·d_verify 实际是「节点更深 →
 * 误差更大」的替身,采样偏离运行时映射会把 c2 拟歪(σ 系统性偏小 → 过剪)。
 * ⚠ 只能采偶数 ds:engineThink 的中局阶梯按 by-2 走,think(3) 实际跑的是 d2,
 *   奇数验证深度(运行时 d9/d11 用 dv3)靠 ds 项在 2↔4 间线性插值,方向偏保守。 */
const PAIRS = [[8, 2], [10, 2], [12, 4]];
const samples = [];
let idx = 0;
for (let i = 0; i < N; i++) {
  const seed = 90000 + i * 131;
  const plies = 14 + (i * 37) % 40;         // 14..53 手,覆盖中局各阶段
  const b = randomPosition(plies, seed);
  const empt = b.flat().filter((v) => !v).length;
  if (empt < 16 || empt > 46) continue;      // MPC 生效带(太浅太深都不剪)
  for (const [d, ds] of PAIRS) {
    if (empt <= d + 2) continue;             // 深度不够的尾盘跳过
    const deep = think(b, 'w', d);
    const shallow = think(b, 'w', ds);
    samples.push({ empt, d, ds, diff: shallow - deep });
  }
  if (++idx % 40 === 0) console.error(`  …${idx} 局面`);
}

/* 分桶标准差 */
const buckets = new Map();
for (const s of samples) {
  const key = `${s.d}/${s.ds}/${Math.round(s.empt / 8)}`;
  (buckets.get(key) || buckets.set(key, []).get(key)).push(s.diff);
}
console.log('== 分桶分布(diff = 浅 − 深)==');
for (const [key, arr] of [...buckets].sort()) {
  const mean = arr.reduce((a, x) => a + x, 0) / arr.length;
  const sd = Math.sqrt(arr.reduce((a, x) => a + (x - mean) ** 2, 0) / arr.length);
  console.log(`${key} empt≈${key.split('/')[2] * 8} | n=${arr.length} | mean=${mean.toFixed(2)} σ=${sd.toFixed(2)}`);
}

/* 线性最小二乘:σ_bucket ≈ c0 + c1·empties + c2·d_verify(正规方程 3×3) */
const rows = [];
for (const [key, arr] of buckets) {
  if (arr.length < 8) continue;
  const mean = arr.reduce((a, x) => a + x, 0) / arr.length;
  const sd = Math.sqrt(arr.reduce((a, x) => a + (x - mean) ** 2, 0) / arr.length);
  // 零中心标准差:把均值偏移也算进误差界(浅层分差有系统性 bias,
  // 对称阈值下 bias 会把其中一侧的剪枝错误率放大到远超名义值)
  const sd0 = Math.sqrt(mean * mean + sd * sd);
  const [d, ds, e8] = key.split('/').map(Number);
  rows.push({ y: sd0 * 1.12, empt: Number(e8) * 8, ds: Number(ds) });
}
if (rows.length >= 3) {
  const A = rows.map((r) => [1, r.empt, r.ds]);
  const y = rows.map((r) => [r.y]);
  // 3x3 正规方程 (AᵀA)c = Aᵀy
  const At = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], Aty = [0, 0, 0];
  for (let i = 0; i < A.length; i++) {
    for (let r = 0; r < 3; r++) { Aty[r] += A[i][r] * y[i][0]; for (let c = 0; c < 3; c++) At[r][c] += A[i][r] * A[i][c]; }
  }
  // 高斯消元
  const M = At.map((row, i) => [...row, Aty[i]]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < 3; r++) if (r !== col) {
      const f = M[r][col] / M[col][col];
      for (let c = col; c < 4; c++) M[r][c] -= f * M[col][c];
    }
  }
  const C = M.map((row, i) => row[3] / row[i === i ? 3 : 3]); // 占位
  const c0 = M[0][3] / M[0][0], c1 = M[1][3] / M[1][1], c2 = M[2][3] / M[2][2];
  console.log('\n== 拟合系数(已含 12% 余量)==');
  console.log(`σ = ${c0.toFixed(3)} + ${c1.toFixed(4)}·empties + ${c2.toFixed(4)}·d_verify`);
  console.log(`Zig: const MPC_SIGMA = [4]f32{ ${c0.toFixed(3)}, ${c1.toFixed(4)}, ${c2.toFixed(4)}, 0 };`);
} else {
  console.log('样本桶不足,跳过拟合(只看分桶分布)');
}
