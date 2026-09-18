/* 把 Zig 侧 comptime 建出的几何表(out/geo.txt)与 JS 侧 model.mjs 逐项对拍。
 * 用法:node tools/probe-geo.mjs [out/geo.txt] */
import fs from 'node:fs';
import { PTN_COUNT, CELLS, PTN_SIZE, PTN_OFF } from './model.mjs';

const path = process.argv[2] || 'out/geo.txt';
const lines = fs.readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());

const GEO = [
  (r, c) => [r, c], (r, c) => [c, 7 - r], (r, c) => [7 - r, 7 - c], (r, c) => [7 - c, r],
  (r, c) => [c, r], (r, c) => [7 - c, 7 - r], (r, c) => [7 - r, c], (r, c) => [r, 7 - c],
];
const geoPerm = GEO.map((f) => {
  const m = new Int8Array(64);
  for (let s = 0; s < 64; s++) { const [r, c] = [s >> 3, s & 7]; const [r2, c2] = f(r, c); m[s] = r2 * 8 + c2; }
  return m;
});
const posOf = [new Map()];
for (let p = 1; p <= PTN_COUNT; p++) posOf[p] = new Map(CELLS[p].map((s, i) => [s, i]));
// JS 的 ACT 用**全 8 个几何**(含镜像),顺序同 GEO
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
    ACT[t][p] = { q, perm: img.map((s) => posOf[q].get(s)) };
  }
}

let bad = 0;
const note = (...a) => { console.log('✗', ...a); bad++; };

for (const line of lines) {
  const kind = line[0];
  if (kind === 'P') {
    const m = line.match(/^P (\d+) len=(\d+) tri=(\d+) off=(\d+) cells=(.*)$/);
    if (!m) { note('无法解析', line); continue; }
    const p = +m[1];
    const cells = m[5] ? m[5].split(',').map(Number) : [];
    if (+m[2] !== CELLS[p].length) note(`p=${p} len ${m[2]} ≠ ${CELLS[p].length}`);
    if (+m[3] !== PTN_SIZE[p]) note(`p=${p} tri ${m[3]} ≠ ${PTN_SIZE[p]}`);
    if (+m[4] !== PTN_OFF[p]) note(`p=${p} off ${m[4]} ≠ ${PTN_OFF[p]}`);
    if (cells.join() !== CELLS[p].join()) note(`p=${p} cells 不同\n   zig ${cells.join()}\n    js ${CELLS[p].join()}`);
  } else if (kind === 'A') {
    const m = line.match(/^A (\d+) (\d+) q=(\d+) perm=(.*)$/);
    if (!m) { note('无法解析', line); continue; }
    const [t, p] = [+m[1], +m[2]];
    const perm = m[4] ? m[4].split(',').map(Number) : [];
    if (+m[3] !== ACT[t][p].q) note(`act t=${t} p=${p} q ${m[3]} ≠ ${ACT[t][p].q}`);
    if (perm.join() !== ACT[t][p].perm.join()) note(`act t=${t} p=${p} perm 不同\n   zig ${perm.join()}\n    js ${ACT[t][p].perm.join()}`);
  } else if (kind === 'C') {
    const m = line.match(/^C (\d+) cand=(.*)$/);
    if (!m) { note('无法解析', line); continue; }
    const p = +m[1];
    const zig = m[2] ? m[2].split(',').map(Number) : [];
    const js = [];
    for (let t = 0; t < 8; t++) { if (ACT[t][p].q > p) continue; for (let sw = 0; sw < 2; sw++) js.push(t * 2 + sw); }
    if (zig.join() !== js.join()) note(`cands p=${p} 不同\n   zig ${zig.join()}\n    js ${js.join()}`);
  } else note('未知行', line);
}

console.log(bad === 0 ? '✓ 几何表完全一致' : `✗ ${bad} 处不一致`);
process.exit(bad === 0 ? 0 : 1);
