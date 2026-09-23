/* ============================================================
 * 单一深度对 PC(ProbCut)标定探针:为中盘/尾盘各选一个 (节点, 验证)
 * 深度对,并给出该对的单常量 σ(零中心 SD × 1.12 安全余量)。
 *
 * A. 中盘:随机中局局面,对候选 (d, dv) 对比完整深度 d 与验证深度 dv
 *    的引擎分,按空格分桶算零中心 SD —— σ 是"浅层分 vs 深层分"的误差。
 *    同时记录节点数,给出验证成本比 nodes(dv)/nodes(d)。
 * B. 尾盘:E ∈ {12..20} 空局面,先完全求解取真值(预算熔断的丢弃),
 *    再对 dv ∈ {2,4,6,8} 的中局搜索分算零中心 SD —— σ 是"浅层分 vs
 *    精确解"的跨尺度误差。同样记录成本比 nodes(dv)/nodes(exact)。
 *
 * 用法:node tools/probe-pc.mjs [wasm 路径]
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
    if (line.length && rr >= 0 && rr < 8 && cc < 8 && cc >= 0 && b[rr][cc] === color) out.push(...line);
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
  // 测量一律关剪枝,取裸搜索分(旧名 engineSetMpc 兼容重构前的 wasm)
  if (X.engineSetPc) X.engineSetPc(0, 0); else X.engineSetMpc(0, 0);
  X.engineThink(a, bb, c, d, depth, end, budgetNodes >>> 0, Math.floor(budgetNodes / 4294967296) >>> 0);
  return {
    score: X.engineScore(),
    exact: X.engineExact() === 1,
    nodes: X.engineNodesLo() + X.engineNodesHi() * 4294967296,
  };
}
const zeroCenter = (arr) => {
  const mean = arr.reduce((a, x) => a + x, 0) / arr.length;
  const sd = Math.sqrt(arr.reduce((a, x) => a + (x - mean) ** 2, 0) / arr.length);
  return { mean, sd, sd0: Math.sqrt(mean * mean + sd * sd) };
};

/* ---------------- A. 中盘 σ 网格 ---------------- */
/* MID_PAIRS 可用环境变量覆盖(格式 "d/dv,d/dv,..."),补测新候选对时
 * 不必重跑全网格;SEED_BASE 同理,便于并行多进程采样不撞局面。 */
const MID_PAIRS = (process.env.MID_PAIRS || '8/2,8/4,8/6,10/2,10/4,10/6,12/2,12/4,12/6')
  .split(',').map((s) => s.split('/').map(Number));
const SEED_BASE = Number(process.env.SEED_BASE) || 70000;
const MID_N = process.env.MID_N === undefined ? 140 : Number(process.env.MID_N) || 0;
const midBuckets = new Map(); // key: `${d}/${dv}/${band}` band = Math.floor(empt/4)*4
const midCosts = new Map();  // key: `${d}/${dv}` -> {vn:[], fn:[]}
let midIdx = 0;
for (let i = 0; i < 4000 && midIdx < MID_N; i++) {
  const seed = SEED_BASE + i * 131;
  const plies = 14 + (i * 37) % 40;          // 14..53 手
  const b = randomPosition(plies, seed);
  const empt = b.flat().filter((v) => !v).length;
  if (empt < 16 || empt > 46) continue;
  midIdx++;
  const band = Math.floor(empt / 4) * 4;
  for (const [d, dv] of MID_PAIRS) {
    if (empt <= d + 2) continue;             // 深度不够的尾盘跳过
    const deep = thinkRaw(b, 'w', d, 0, 0);
    const shal = thinkRaw(b, 'w', dv, 0, 0);
    const kk = `${d}/${dv}/${band}`;
    (midBuckets.get(kk) || midBuckets.set(kk, []).get(kk)).push(shal.score - deep.score);
    const ck = `${d}/${dv}`;
    const cc = midCosts.get(ck) || { vn: [], fn: [] };
    cc.vn.push(shal.nodes); cc.fn.push(deep.nodes);
    midCosts.set(ck, cc);
  }
  if (midIdx % 40 === 0) console.error(`  …中盘 ${midIdx}/${MID_N}`);
}
console.log('== A. 中盘 σ(浅 dv − 深 d 的零中心 SD;括号内 = ×1.12 建议)==');
console.log('d/dv | ' + [...new Set([...midBuckets.keys()].map((k) => k.split('/')[2]))].sort((a, b) => a - b).map((band) => `E${band}+`).join(' | '));
for (const [d, dv] of MID_PAIRS) {
  const cost = midCosts.get(`${d}/${dv}`);
  if (!cost || !cost.vn.length) continue; // 空网格(如 MID_N=0 只跑尾盘)
  const cells = [];
  let max0 = 0;
  for (const key of [...midBuckets.keys()].sort()) {
    const [kd, kdv, band] = key.split('/');
    if (kd !== String(d) || kdv !== String(dv)) continue;
    const arr = midBuckets.get(key);
    const { sd0 } = zeroCenter(arr);
    max0 = Math.max(max0, sd0);
    cells.push(`${sd0.toFixed(1)}(n=${arr.length})`);
  }
  const vmed = cost.vn.sort((a, b) => a - b)[Math.floor(cost.vn.length / 2)];
  const fmed = cost.fn.sort((a, b) => a - b)[Math.floor(cost.fn.length / 2)];
  console.log(`${String(d).padStart(2)}/${String(dv).padStart(2)} | ${cells.join(' | ')} | max=${max0.toFixed(1)} →σ ${(max0 * 1.12).toFixed(1)} | 成本比 ${(vmed / fmed).toFixed(3)}`);
}

/* ---------------- B. 尾盘 σ 网格 ---------------- */
const END_WANT = [
  { e: 12, n: 10 }, { e: 14, n: 10 }, { e: 16, n: 8 },
  { e: 18, n: 6 }, { e: 19, n: 4 }, { e: 20, n: 5 },
];
// dv10 是尾盘二级(深空深验证)的标定列;E19 求解方差大,60M 内常熔断,
// 拿到的 n 偏小 —— σ 按最差带取保守即覆盖。
const END_DVS = [2, 4, 6, 8, 10];
const BUDGET = 60_000_000;
const posByE = new Map(END_WANT.map(({ e }) => [e, []]));
outer:
for (let seed = 500001; seed <= 500001 + 6000; seed += 7) {
  for (let plies = 36; plies <= 56; plies += 2) {
    const b = randomPosition(plies, seed * 31 + plies);
    const empt = b.flat().filter((v) => !v).length;
    const slot = posByE.get(empt);
    if (slot && slot.length < END_WANT.find((w) => w.e === empt).n) slot.push({ b, seed });
  }
  if (END_WANT.every(({ e, n }) => posByE.get(e).length >= n)) break outer;
}
console.log(`\n== B. 尾盘采样: ${[...posByE].map(([k, v]) => `${k}空×${v.length}`).join(' ')} ==`);
console.log('空 | dv | n | mean | SD | 零中心SD(σ 目标) | ×1.12 | 成本比(中位)');
const endStats = new Map();
for (const { e } of END_WANT) {
  const rows = [];
  for (const pos of posByE.get(e)) {
    const t = thinkRaw(pos.b, 'w', e + 2, e, BUDGET);
    pos.truth = t.exact ? t.score : null;
    pos.tnodes = t.nodes;
    rows.push(t);
  }
  const ok = posByE.get(e).filter((p) => p.truth !== null);
  console.error(`  ${e} 空:完解 ${ok.length}/${rows.length}(丢弃熔断)`);
  for (const dv of END_DVS) {
    const diffs = [], ratios = [];
    for (const p of ok) {
      const v = thinkRaw(p.b, 'w', dv, 0, 0);
      diffs.push(v.score - p.truth);
      ratios.push(v.nodes / p.tnodes);
    }
    if (diffs.length < 3) continue;
    const { mean, sd, sd0 } = zeroCenter(diffs);
    const rmed = ratios.sort((a, b) => a - b)[Math.floor(ratios.length / 2)];
    endStats.set(`${e}/${dv}`, { sd0, n: diffs.length, rmed });
    console.log(`${String(e).padStart(2)} | ${String(dv).padStart(2)} | ${String(diffs.length).padStart(2)} | ${mean.toFixed(2).padStart(7)} | ${sd.toFixed(2).padStart(6)} | ${sd0.toFixed(2).padStart(8)} | ${(sd0 * 1.12).toFixed(2).padStart(5)} | ${rmed.toExponential(2)}`);
  }
}
console.log('\n(中盘 σ 取触发带上最差桶 ×1.12;尾盘同理取各空档最差 ×1.12)');
