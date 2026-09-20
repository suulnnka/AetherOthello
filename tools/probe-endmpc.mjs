/* ============================================================
 * 残局 MPC 可行性测量(docs/endgame-mpc-study.md 的数据来源)
 *
 * A. 精确求解成本:各空位数下 end=E 完全求解的节点/耗时(带预算熔断)
 *    → 回答"end 阈值不靠 MPC 能提到多少"
 * B. σ_end 数据:验证值(浅层中局搜索 dv / 静态估值)与精确解的误差分布
 *    → 回答"残局 MPC 的误差模型可不可拟合、误差量级多大"
 *
 * 用法:node tools/probe-endmpc.mjs [wasm 路径]
 * ============================================================ */
import fs from 'node:fs';

const wasmPath = process.argv[2] || 'zig-out/bin/othello.wasm';
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
function thinkRaw(b, color, depth, end, budgetNodes) {
  const [a, bb, c, d] = toLoHi(b, color);
  X.engineClear();
  X.engineSetMpc(0, 0);
  const t0 = performance.now();
  X.engineThink(a, bb, c, d, depth, end, budgetNodes >>> 0, Math.floor(budgetNodes / 4294967296) >>> 0);
  return {
    score: X.engineScore(),
    exact: X.engineExact() === 1,
    nodes: X.engineNodesLo() + X.engineNodesHi() * 4294967296,
    ms: performance.now() - t0,
  };
}
const staticEval = (b, color) => {
  const [a, bb, c, d] = toLoHi(b, color);
  return X.engineEval(a, bb, c, d);
};

/* 按目标空位数采样 */
const WANT = [
  { e: 14, n: 8 }, { e: 16, n: 8 }, { e: 18, n: 8 },
  { e: 20, n: 5 }, { e: 22, n: 4 }, { e: 24, n: 3 },
];
const BUDGET = 60_000_000; // 熔断:60M 节点(≈20s)
const posByE = new Map(WANT.map(({ e }) => [e, []]));
outer:
for (let seed = 500001; seed <= 500001 + 6000; seed += 7) {
  for (let plies = 36; plies <= 56; plies += 2) {
    const b = randomPosition(plies, seed * 31 + plies);
    const empt = b.flat().filter((v) => !v).length;
    const slot = posByE.get(empt);
    if (slot && slot.length < WANT.find((w) => w.e === empt).n) slot.push({ b, seed });
  }
  if (WANT.every(({ e, n }) => posByE.get(e).length >= n)) break outer;
}
console.log(`采样: ${[...posByE].map(([k, v]) => `空${k}×${v.length}`).join(' ')}`);

/* ---- A. 精确求解成本(顺带缓存精确真值)---- */
console.log('\n== A. 精确求解成本(end=E,预算 60M 节点)==');
console.log('空 | n | 完解率 | 节点(中位) | 节点(最大) | 耗时(中位 ms)');
for (const { e } of WANT) {
  const rows = [];
  for (const pos of posByE.get(e)) {
    const r = thinkRaw(pos.b, 'w', e + 2, e, BUDGET);
    rows.push(r);
    pos.truth = r.exact ? r.score : null; // 真值直接挂在局面上(同 seed 会落多个桶,不能按键共享)
  }
  const okNodes = rows.filter((r) => r.exact).map((r) => r.nodes).sort((a, c) => a - c);
  const med = (a) => (a.length ? a[Math.floor(a.length / 2)] : NaN);
  const medMs = med([...rows.map((r) => r.ms)].sort((a, c) => a - c));
  const aborted = rows.filter((r) => !r.exact).length;
  console.log(`${String(e).padStart(2)} | ${rows.length} | ${rows.length - aborted}/${rows.length} | ${okNodes.length ? med(okNodes).toLocaleString() : '-'} | ${okNodes.length ? okNodes[okNodes.length - 1].toLocaleString() : '-'} | ${medMs.toFixed(0)}${aborted ? ` (${aborted} 熔断)` : ''}`);
}

/* ---- B. σ_end 误差分布(只用有真值的局面)---- */
console.log('\n== B. 验证值 − 精确解 的误差 ==');
console.log('空 | 验证 | n | mean | SD | 零中心SD(=σ_end 目标)');
const stats = new Map();
const bump = (e, kind, v) => {
  const kk = `${e}/${kind}`;
  if (!stats.has(kk)) stats.set(kk, []);
  stats.get(kk).push(v);
};
for (const { e } of WANT) {
  for (const { b, truth } of posByE.get(e)) {
    if (truth === null || truth === undefined) continue;
    bump(e, 'eval', staticEval(b, 'w') - truth);
    for (const dv of [2, 4]) {
      const v = thinkRaw(b, 'w', dv, 0, 0).score;
      bump(e, `dv${dv}`, v - truth);
    }
  }
}
for (const [kk, arr] of [...stats].sort()) {
  const [e, kind] = kk.split('/');
  const mean = arr.reduce((a, x) => a + x, 0) / arr.length;
  const sd = Math.sqrt(arr.reduce((a, x) => a + (x - mean) ** 2, 0) / arr.length);
  const sd0 = Math.sqrt(mean * mean + sd * sd);
  console.log(`${String(e).padStart(2)} | ${kind.padEnd(4)} | ${String(arr.length).padStart(2)} | ${mean.toFixed(2).padStart(7)} | ${sd.toFixed(2).padStart(6)} | ${sd0.toFixed(2).padStart(6)}`);
}
console.log('\n(零中心SD = σ_end 拟合目标;模型拟合留待 ⑥ 再修时做,本探针只出数据)');
