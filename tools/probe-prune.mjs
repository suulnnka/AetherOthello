/* 临时探针:验证「只保留 q ≤ p 的群元素」这条剪枝是否等价于全 16 元。
 * 起因:Zig 侧用剪枝算出的代表数是 6,724,而全量是 9,475 —— 必须先把
 * 「剪枝错了」还是「Zig 实现错了」分清楚。 */
import { PTN_COUNT, CELLS, PTN_SIZE, PTN_OFF, PER_PHASE } from './model.mjs';

const GEO = [
  (r, c) => [r, c], (r, c) => [c, 7 - r], (r, c) => [7 - r, 7 - c], (r, c) => [7 - c, r],
  (r, c) => [c, r], (r, c) => [7 - c, 7 - r], (r, c) => [7 - r, c], (r, c) => [r, 7 - c],
];
const geoPerm = GEO.map((f) => {
  const m = new Int8Array(64);
  for (let s = 0; s < 64; s++) { const [r, c] = [s >> 3, s & 7]; const [r2, c2] = f(r, c); m[s] = r2 * 8 + c2; }
  return m;
});
const S = (p, idx) => PTN_OFF[p] + idx;
const posOf = [];
posOf[0] = new Map();
for (let p = 1; p <= PTN_COUNT; p++) posOf[p] = new Map(CELLS[p].map((s, i) => [s, i]));

const ACT = [];
for (let t = 0; t < 8; t++) {
  ACT[t] = [];
  for (let p = 1; p <= PTN_COUNT; p++) {
    const img = CELLS[p].map((s) => geoPerm[t][s]);
    let q = -1;
    for (let k = 1; k <= PTN_COUNT; k++) {
      if (PTN_SIZE[k] !== PTN_SIZE[p]) continue;
      let ok = true;
      for (const s of img) if (!posOf[k].has(s)) { ok = false; break; }
      if (ok) { q = k; break; }
    }
    ACT[t][p] = q < 0 ? null : { q, perm: img.map((s) => posOf[q].get(s)) };
  }
}
let actBad = 0;
for (let t = 0; t < 8; t++) for (let p = 1; p <= PTN_COUNT; p++) if (!ACT[t][p]) actBad++;
console.log('闭包失败', actBad);

function img(p, idx, t, sw) {
  const a = ACT[t][p], len = CELLS[p].length;
  let tmp = idx, nv = 0;
  for (let i = 0; i < len; i++) { let d = tmp % 3; tmp = (tmp - d) / 3; if (sw && d) d = 3 - d; nv += d * (3 ** a.perm[i]); }
  return S(a.q, nv);
}

const full = new Int32Array(PER_PHASE), pruned = new Int32Array(PER_PHASE);
let candTotal = 0;
for (let p = 1; p <= PTN_COUNT; p++) {
  for (let t = 0; t < 8; t++) if (ACT[t][p].q <= p) candTotal += 2;
  for (let idx = 0; idx < PTN_SIZE[p]; idx++) {
    let bf = S(p, idx), bp = S(p, idx);
    for (let t = 0; t < 8; t++) for (let sw = 0; sw < 2; sw++) {
      const v = img(p, idx, t, sw === 1);
      if (v < bf) bf = v;
      if (ACT[t][p].q <= p && v < bp) bp = v;
    }
    full[S(p, idx)] = bf; pruned[S(p, idx)] = bp;
  }
}
console.log('剪枝后候选条目总数', candTotal, '平均/表', (candTotal / PTN_COUNT).toFixed(2));
let diff = 0; const firstDiff = [];
for (let s = 0; s < PER_PHASE; s++) if (full[s] !== pruned[s]) { diff++; if (firstDiff.length < 5) firstDiff.push([s, full[s], pruned[s]]); }
console.log('剪枝与全量结果不同的槽数', diff, JSON.stringify(firstDiff));
const uniq = (a) => new Set(a).size;
console.log('代表数:全量', uniq(full), ' 剪枝', uniq(pruned));
