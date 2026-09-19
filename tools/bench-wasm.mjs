/* ============================================================
 * wasm 引擎基准(直接驱动 othello.wasm;bench.mjs 那套测的是 JS 参照实现,
 * 对 zig 通道的改动要用这份才有意义)。
 *
 * 固定种子生成局面 ⇒ 节点数与着法签名完全可复现:
 *   endnodes  残局完全求解节点数(按空位数分组)—— 纯加速/剪枝类改动的度量
 *   moves     固定深度中局:着法:分:节点 签名 —— 语义回归(排序不得改分)
 *   nps       各阶段中局速度
 *
 * 用法:node tools/bench-wasm.mjs [endnodes|moves|nps|all] [wasm 路径]
 * ============================================================ */
import fs from 'node:fs';

const argv = process.argv.slice(2);
const MODE = argv.find((a) => !a.startsWith('--') && !a.endsWith('.wasm')) || 'all';
const wasmPath = argv.find((a) => a.endsWith('.wasm')) || 'zig-out/bin/othello.wasm';

const bytes = fs.readFileSync(wasmPath);
const X = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports;
if (X.engineInit() !== 0) { console.error('engineInit 失败'); process.exit(1); }

/* ---- 固定种子局面生成(与 bench/bench.mjs 的 randomPosition 同一套 LCG)---- */
const parseBoard = (s) => {
  const lines = s.trim().split('\n').map((l) => l.trim());
  return lines.map((row) => [...row].map((ch) => (ch === 'b' ? 'b' : ch === 'w' ? 'w' : null)));
};
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
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++)
    if (!b[r][c] && flipsFor(b, r, c, color).length) out.push([r, c]);
  return out;
}
function applyMove(b, r, c, color) {
  const flips = flipsFor(b, r, c, color);
  const nb = b.map((row) => [...row]);
  nb[r][c] = color;
  for (const [fr, fc] of flips) nb[fr][fc] = color;
  return nb;
}
const emptiesOf = (b) => b.flat().filter((v) => !v).length;
function randomPosition(plies, seedIn = 12345) {
  let b = parseBoard(`
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
    if (!ms.length) {
      if (!legalMoves(b, other(turn)).length) break;
      turn = other(turn); continue;
    }
    const [r, c] = ms[Math.floor(rnd() * ms.length)];
    b = applyMove(b, r, c, turn);
    turn = other(turn);
  }
  return b;
}
/* board('b'/'w'/null + 行棋方)→ wasm 的 own/opp lo/hi(own = 行棋方) */
function toLoHi(b, color) {
  let ow = 0n, op = 0n;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const bit = 1n << BigInt(r * 8 + c);
    if (b[r][c] === color) ow |= bit;
    else if (b[r][c]) op |= bit;
  }
  const l32 = (x) => Number(x & 0xFFFFFFFFn);
  const h32 = (x) => Number(x >> 32n);
  return [l32(ow), h32(ow), l32(op), h32(op)];
}
const fmt = (n) => n.toLocaleString('en-US');
const moveName = (p) => 'abcdefgh'[p & 7] + ((p >> 3) + 1);
function think(b, color, depth, end, budget = 0) {
  const [olo, ohi, opplo, opphi] = toLoHi(b, color);
  X.engineClear();
  const t0 = performance.now();
  const mv = X.engineThink(olo, ohi, opplo, opphi, depth, end, budget >>> 0, Math.floor(budget / 4294967296) >>> 0);
  const ms = performance.now() - t0;
  const nodes = X.engineNodesLo() + X.engineNodesHi() * 4294967296;
  return { mv, score: X.engineScore(), exact: X.engineExact() === 1, nodes, ms };
}

let fails = 0;
if (MODE === 'endnodes' || MODE === 'all') {
  console.log('== endnodes(残局完全求解,固定种子)==');
  const byE = {};
  for (const seed of [1, 2, 3, 4, 5]) {
    for (let plies = 40; plies <= 56; plies++) {
      const b = randomPosition(plies, seed * 7919);
      const e = emptiesOf(b);
      if (e >= 8 && e <= 15) (byE[e] = byE[e] || []).push({ b, e });
    }
  }
  let totAll = 0n, msAll = 0;
  for (const e of Object.keys(byE).map(Number).sort((a, c) => a - c)) {
    const group = byE[e];
    let tot = 0n, ms = 0;
    const sig = [];
    for (const { b } of group) {
      const r = think(b, 'w', e + 4, e + 4);
      if (!r.exact) { console.log(`  ✗ 空 ${e}:exact=0`); fails++; }
      tot += BigInt(r.nodes); ms += r.ms;
      sig.push(`${moveName(r.mv)}:${Math.round(r.score)}`);
    }
    totAll += tot; msAll += ms;
    console.log(`空 ${String(e).padStart(2)} | 局面 ${String(group.length).padStart(2)} | 节点 ${fmt(tot).padStart(14)} | ${ms.toFixed(0).padStart(6)}ms | ${sig.join(' ')}`);
  }
  console.log(`合计节点 ${fmt(totAll)} | ${msAll.toFixed(0)}ms`);
}

if (MODE === 'moves' || MODE === 'all') {
  console.log('== moves(固定深度语义回归:排序/加速类改动不得改分)==');
  const out = [];
  for (const plies of [12, 20, 28, 36]) {
    const b = randomPosition(plies);
    for (const d of [4, 6, 8, 10]) {
      const r = think(b, 'w', d, 0);
      out.push(`${plies}/${d}:${moveName(r.mv)}:${Math.round(r.score)}:${r.nodes}`);
    }
  }
  console.log('MOVES ' + out.join(' '));
}

if (MODE === 'nps' || MODE === 'all') {
  console.log('== nps(中局速度)==');
  for (const plies of [12, 24, 40, 52]) {
    const b = randomPosition(plies);
    const e = emptiesOf(b);
    for (const d of [6, 8, 10]) {
      if (e <= 14 && d >= 10) { /* 52 手的 10 层会进残局,跳过保持纯中局 */ }
      const r = think(b, 'w', d, 0);
      const nps = r.ms > 0 ? Math.round(r.nodes / r.ms * 1000) : 0;
      console.log(`${String(plies).padStart(2)} 手(空 ${String(e).padStart(2)}) d${d} | 节点 ${fmt(r.nodes).padStart(12)} | ${r.ms.toFixed(1).padStart(8)}ms | ${fmt(nps)} NPS | ${moveName(r.mv)} ${Math.round(r.score)}`);
    }
  }
}

if (fails) { console.error(`✗ ${fails} 项失败`); process.exit(1); }
console.log('✓ bench-wasm 完成');
