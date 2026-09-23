/* ============================================================
 * PC(ProbCut)开关 A/B:同一批局面、同一档位参数,engineSetPc(0/1) 各跑
 * 一遍,对比节点数 / 耗时 / 分差 / 着法一致率 / exact 契约。
 *
 * 用法:node tools/ab-pc.mjs [wasm 路径]
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
function think(b, color, depth, end, budget, pc) {
  const [a, bb, c, d] = toLoHi(b, color);
  X.engineClear();
  X.engineSetPc(pc ? 1 : 0, pc || 0);
  const t0 = performance.now();
  X.engineThink(a, bb, c, d, depth, end, budget >>> 0, Math.floor(budget / 4294967296) >>> 0);
  return {
    root0: X.engineRootMove(0),
    score: X.engineScore(),
    depth: X.engineDepth(),
    exact: X.engineExact() === 1,
    nodes: X.engineNodesLo() + X.engineNodesHi() * 4294967296,
    ms: performance.now() - t0,
  };
}

/* 局面组:中盘三个阶段(不限预算,节点数即真实树规模)+ 尾盘四个空档 */
const groups = [];
for (const plies of [16, 30, 40]) {
  const arr = [];
  for (let i = 0; i < 400 && arr.length < 8; i++) {
    const b = randomPosition(plies, 31000 + plies * 97 + i * 13);
    const empt = b.flat().filter((v) => !v).length;
    if (empt >= 18 && empt <= 46) arr.push(b);
  }
  groups.push({ name: `中盘${plies}手`, arr, cfg: { depth: 12, end: 0, budget: 0 } });
}
for (const e of [12, 14, 16, 18, 20]) {
  const arr = [];
  for (let seed = 500001; seed <= 500001 + 6000 && arr.length < 5; seed += 7) {
    for (let plies = 36; plies <= 56; plies += 2) {
      const b = randomPosition(plies, seed * 31 + plies);
      if (b.flat().filter((v) => !v).length === e) { arr.push(b); break; }
    }
  }
  groups.push({ name: `尾盘${e}空`, arr, cfg: { depth: 12, end: e, budget: 60_000_000 } });
}

console.log('组 | n | 节点(关→开,中位) | 省比 | 耗时(关→开,中位ms) | |Δscore|中位/最大 | 着法一致 | exact(关→开)');
for (const g of groups) {
  if (!g.arr.length) { console.log(`${g.name} | 0 | (无采样)`); continue; }
  const off = [], on = [], ds = [];
  let same = 0;
  const exO = [], exN = [];
  for (const b of g.arr) {
    const r0 = think(b, 'w', g.cfg.depth, g.cfg.end, g.cfg.budget, 0);
    const r1 = think(b, 'w', g.cfg.depth, g.cfg.end, g.cfg.budget, 1.64);
    off.push(r0); on.push(r1);
    ds.push(Math.abs(r1.score - r0.score));
    if (r1.root0 === r0.root0) same++;
    exO.push(r0.exact); exN.push(r1.exact);
  }
  const med = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const no = med(off.map((r) => r.nodes)), nn = med(on.map((r) => r.nodes));
  const to = med(off.map((r) => r.ms)), tn = med(on.map((r) => r.ms));
  const dO = med(off.map((r) => r.depth)), dN = med(on.map((r) => r.depth));
  console.log(`${g.name} | ${g.arr.length} | ${no.toLocaleString()}→${nn.toLocaleString()} | ${((1 - nn / no) * 100).toFixed(1)}% | ${to.toFixed(0)}→${tn.toFixed(0)} | ${med(ds).toFixed(1)}/${Math.max(...ds).toFixed(1)} | ${same}/${g.arr.length} | ${exO.filter(Boolean).length}→${exN.filter(Boolean).length} | 深度${dO}→${dN}`);
}
