/* ============================================================
 * 16 元对称群在 38×3^len 个槽上的轨道 —— 折叠的**权威口径**。
 *
 * 群 G = D4(8 个几何)× {保色, 换色} = 16 元。
 * 权重函数必须满足一致性约束:
 *      W(g·s) = sign(g) · W(s)        sign(g) = (−1)^换色位
 * 几何操作(旋转/镜像/转置)不改棋子颜色,也不改"行棋方"这个身份 → +1;
 * 换色把空→空、黑↔白,同时把行棋方换掉,子差整体取负 → −1。
 *
 * 本脚本用**带符号并查集**求解(最稳的写法,能自动检出 x = −x 的矛盾),
 * 输出:
 *   - 轨道数 / 被对称性强制作 0 的轨道数 / 轨道大小直方图
 *   - out/orbit.u16  每槽 → 轨道号(= blob 里的下标)
 *   - out/sigma.i8   每槽 → W(s) / W(轨道代表) = ±1
 *   - 顺带复核"取 16 个像里槽号最小者"这个廉价规则能否得到同一套轨道
 *     (Zig 侧运行时就用它,不必实现并查集)
 *
 * 用法:node tools/oracle-fold.mjs [--out dir]
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { PTN_COUNT, CELLS, PTN_SIZE, PTN_OFF, PER_PHASE } from './model.mjs';

const argv = process.argv.slice(2);
const OUT = (() => { const i = argv.indexOf('--out'); return i >= 0 ? argv[i + 1] : 'out'; })();

const N = PER_PHASE;
const S = (p, idx) => PTN_OFF[p] + idx;   // 0-based 全局槽号

/* ── 8 个几何操作在 0-based 方格上的置换 ─────────────────────
 * (r,c) 是 0-based 行列;kix4 的 (i,j) = (r+1,c+1)。
 * 顺序照抄 fold.mjs 的 T,保证与既有研究结果对得上。 */
const GEO = [
  (r, c) => [r, c],           // 0 恒等
  (r, c) => [c, 7 - r],       // 1 旋转 90°
  (r, c) => [7 - r, 7 - c],   // 2 旋转 180°
  (r, c) => [7 - c, r],       // 3 旋转 270°
  (r, c) => [c, r],           // 4 转置
  (r, c) => [7 - c, 7 - r],   // 5 反对角转置
  (r, c) => [7 - r, c],       // 6 上下镜像
  (r, c) => [r, 7 - c],       // 7 左右镜像
];
const geoPerm = GEO.map((f) => {
  const m = new Int8Array(64);
  for (let s = 0; s < 64; s++) { const [r, c] = [s >> 3, s & 7]; const [r2, c2] = f(r, c); m[s] = r2 * 8 + c2; }
  return m;
});

/* ── 每个 (几何 t, 表 p) → 像在哪张表、进制位怎么排 ── */
const cellSet = CELLS.map((cells) => new Set(cells));   // index 1..38
const ACT = [];   // ACT[t][p] = { q, perm } | null
for (let t = 0; t < 8; t++) {
  ACT[t] = [];
  for (let p = 1; p <= PTN_COUNT; p++) {
    const img = CELLS[p].map((s) => geoPerm[t][s]);
    let q = -1;
    for (let k = 1; k <= PTN_COUNT; k++) {
      if (PTN_SIZE[k] !== PTN_SIZE[p]) continue;
      let ok = true;
      for (const s of img) if (!cellSet[k].has(s)) { ok = false; break; }
      if (ok) { q = k; break; }
    }
    if (q < 0) { ACT[t][p] = null; continue; }
    const pos = new Map();
    CELLS[q].forEach((s, i) => pos.set(s, i));
    const perm = img.map((s) => pos.get(s));
    if (new Set(perm).size !== perm.length) { ACT[t][p] = null; continue; }
    ACT[t][p] = { q, perm };
  }
}

const closed = (() => {
  let bad = 0;
  for (let t = 0; t < 8; t++) for (let p = 1; p <= PTN_COUNT; p++) if (!ACT[t][p]) bad++;
  return bad;
})();

/* ── 16 元作用在一个槽上 ── */
/** 返回 [槽号, 符号] */
function actOnSlot(p, idx, t, swap) {
  const a = ACT[t][p];
  if (!a) return null;
  const len = CELLS[p].length;
  let tmp = idx, nv = 0;
  for (let i = 0; i < len; i++) {
    let d = tmp % 3; tmp = (tmp - d) / 3;
    if (swap && d) d = 3 - d;
    nv += d * (3 ** a.perm[i]);
  }
  return [S(a.q, nv), swap ? -1 : 1];
}

/* ── 带符号并查集 ── */
const parent = new Int32Array(N), rel = new Int8Array(N), sz = new Int32Array(N);
const forced = new Uint8Array(N);
for (let i = 0; i < N; i++) { parent[i] = i; rel[i] = 1; sz[i] = 1; }

function find(x) {
  let r = x, s = 1;
  while (parent[r] !== r) { s *= rel[r]; r = parent[r]; }
  let cur = x, acc = s;
  while (parent[cur] !== cur) {
    const nxt = parent[cur], ns = rel[cur];
    parent[cur] = r; rel[cur] = acc;
    acc *= ns; cur = nxt;
  }
  return [r, s];
}

let conflicts = 0;
function union(a, b, k) {              // 约束:W(a) = k · W(b)
  const [ra, sa] = find(a), [rb, sb] = find(b);
  if (ra === rb) { if (sa !== k * sb) { if (!forced[ra]) conflicts++; forced[ra] = 1; } return; }
  const rr = sa * k * sb;              // W(ra) = rr · W(rb)
  if (sz[ra] < sz[rb]) { parent[ra] = rb; rel[ra] = rr; sz[rb] += sz[ra]; if (forced[ra]) forced[rb] = 1; }
  else { parent[rb] = ra; rel[rb] = rr; sz[ra] += sz[rb]; if (forced[rb]) forced[ra] = 1; }
}

for (let t = 0; t < 8; t++) {
  for (let p = 1; p <= PTN_COUNT; p++) {
    const a = ACT[t][p];
    if (!a) continue;
    for (let swap = 0; swap < 2; swap++) {
      for (let idx = 0; idx < PTN_SIZE[p]; idx++) {
        const r = actOnSlot(p, idx, t, swap === 1);
        if (!r) continue;
        union(S(p, idx), r[0], r[1]);
      }
    }
  }
}

/* ── 归号 ── */
const rootId = new Map();
const orbitRoot = [];
const orbitForced = [];
const orbitOf = new Int32Array(N);
const sigmaUF = new Int8Array(N);
for (let s = 0; s < N; s++) {
  const [r, sg] = find(s);
  let id = rootId.get(r);
  if (id === undefined) { id = orbitRoot.length; rootId.set(r, id); orbitRoot.push(r); orbitForced.push(forced[r] ? 1 : 0); }
  orbitOf[s] = id;
  sigmaUF[s] = sg;
}
const ORBITS = orbitRoot.length;
const NZERO = orbitForced.reduce((a, b) => a + b, 0);

/* 轨道大小直方图(按**轨道**计,不是按槽计) */
const sizeHist = {};
for (let id = 0; id < ORBITS; id++) {
  const n = sz[find(orbitRoot[id])[0]];
  sizeHist[n] = (sizeHist[n] || 0) + 1;
}
const sizeHistSlots = {};
for (let s = 0; s < N; s++) sizeHistSlots[sz[find(s)[0]]] = (sizeHistSlots[sz[find(s)[0]]] || 0) + 1;

/* ── 复核:廉价规则「16 个像里取槽号最小者」 ── */
const canon = new Int32Array(N), sigmaMin = new Int8Array(N), zeroMin = new Uint8Array(N);
for (let p = 1; p <= PTN_COUNT; p++) {
  for (let idx = 0; idx < PTN_SIZE[p]; idx++) {
    let best = Infinity, bestSign = 1, bestSigns = [];
    for (let t = 0; t < 8; t++) {
      for (let swap = 0; swap < 2; swap++) {
        const r = actOnSlot(p, idx, t, swap === 1);
        if (!r) continue;
        if (r[0] < best) { best = r[0]; bestSign = r[1]; bestSigns = [r[1]]; }
        else if (r[0] === best) bestSigns.push(r[1]);
      }
    }
    const s = S(p, idx);
    canon[s] = best; sigmaMin[s] = bestSign;
    zeroMin[s] = bestSigns.some((x) => x !== bestSign) ? 1 : 0;
  }
}
/* 同一轨道内 canon 必须恒定 */
let canonConsistent = true;
{
  const seen = new Map();
  for (let s = 0; s < N; s++) {
    const id = orbitOf[s];
    if (!seen.has(id)) seen.set(id, canon[s]);
    else if (seen.get(id) !== canon[s]) { canonConsistent = false; break; }
  }
}
/* zeroMin 与并查集口径一致?(按轨道比较) */
let zeroAgree = true;
{
  const per = new Map();
  for (let s = 0; s < N; s++) {
    const id = orbitOf[s];
    per.set(id, (per.get(id) || 0) | zeroMin[s]);
  }
  for (const [id, z] of per) if ((z ? 1 : 0) !== orbitForced[id]) { zeroAgree = false; break; }
}
/* 槽号最小者 → 轨道号 的落点是否唯一 */
let minRuleUnique = true;
{
  const m = new Map();
  for (let s = 0; s < N; s++) {
    if (canon[s] !== s) continue;         // 只关心代表
    if (m.has(canon[s]) && m.get(canon[s]) !== orbitOf[s]) { minRuleUnique = false; break; }
    m.set(canon[s], orbitOf[s]);
  }
}

console.log('模式表几何');
console.log(`  表数 ${PTN_COUNT}   槽数/阶段 ${N}`);
console.log(`  长度直方图 ${JSON.stringify(countHist())}`);
console.log(`  8 个几何操作闭包失败次数 ${closed}(必须为 0,否则 D4 不是该特征族的对称)`);
console.log('');
console.log('16 元群 G = D4 × C2 的轨道');
console.log(`  轨道数/阶段        ${ORBITS}   (折叠倍数 ${(N / ORBITS).toFixed(3)}×)`);
console.log(`  强制作 0 的轨道    ${NZERO}`);
console.log(`  矛盾检测次数       ${conflicts}(同一条轨道可能被多次检出,故 ≥ 制 0 轨道数)`);
console.log(`  轨道大小直方图     ${JSON.stringify(sizeHist)}   (轨道数)`);
console.log(`  槽按轨道大小分布   ${JSON.stringify(sizeHistSlots)}   (槽数,合计 ${N})`);
/* 被制 0 的轨道里有"自映射单点轨"吗?有的话训练时必须显式钉 0 ——
 * 因为这种轨道只有自己一个成员,平均算子拿不到 ±σ 相消,会训出一个非零值。 */
{
  const fh = {};
  for (let id = 0; id < ORBITS; id++) if (orbitForced[id]) {
    const n = sz[find(orbitRoot[id])[0]];
    fh[n] = (fh[n] || 0) + 1;
  }
  console.log(`  制 0 轨道的尺寸分布 ${JSON.stringify(fh)}   (轨道数)`);
}
console.log('');
console.log('廉价规则(取 16 个像里槽号最小者)复核');
console.log(`  轨道内 canon 恒定  ${canonConsistent ? '✓' : '✗'}`);
console.log(`  制 0 集合一致      ${zeroAgree ? '✓' : '✗'}`);
console.log(`  代表→轨道号唯一    ${minRuleUnique ? '✓' : '✗'}`);

function countHist() {
  const h = {};
  for (let p = 1; p <= PTN_COUNT; p++) {
    const L = CELLS[p].length;
    h[`len${L}`] = (h[`len${L}`] || 0) + 1;
  }
  return h;
}

/* ── 落盘供 Zig 侧交叉验证 ──
 * 两套编号都写出来:
 *   orbit.u16 / sigma.i8 / zero.u8        —— 并查集口径(权威:轨道数是结论)
 *   orbcanon.u16 / sigmacanon.i8 / zerocanon.u8
 *                                         —— 「最小像」规则口径,且**轨道号按代表升序分配**,
 *                                            与 Zig 运行时 init() 的编号逐位相同,可直接对拍
 * 为什么两套编号不同还能对拍:sigmacanon 就是 sigmaMin(两边定义相同:达成最小槽号的
 * 那个群元素的符号,且候选遍历顺序一致),orbcanon 是同一划分的另一种编号。 */
fs.mkdirSync(OUT, { recursive: true });
const orbitBuf = Buffer.alloc(N * 2), sigmaBuf = Buffer.alloc(N), zeroBuf = Buffer.alloc(N);
const orbCanonBuf = Buffer.alloc(N * 2), sigmaCanonBuf = Buffer.alloc(N), zeroCanonBuf = Buffer.alloc(N);

const orbCanon = new Int32Array(N);
{
  let next = 0;
  for (let s = 0; s < N; s++) if (canon[s] === s) orbCanon[s] = next++;
  if (next !== ORBITS) { console.error(`✗ 代表数 ${next} ≠ 轨道数 ${ORBITS}`); process.exit(1); }
  for (let s = 0; s < N; s++) orbCanon[s] = orbCanon[canon[s]];
}

for (let s = 0; s < N; s++) {
  orbitBuf.writeUInt16LE(orbitOf[s], s * 2);
  sigmaBuf.writeInt8(sigmaUF[s], s);
  zeroBuf.writeUInt8(zeroMin[s], s);
  orbCanonBuf.writeUInt16LE(orbCanon[s], s * 2);
  sigmaCanonBuf.writeInt8(sigmaMin[s], s);
  zeroCanonBuf.writeUInt8(zeroMin[s], s);
}
fs.writeFileSync(path.join(OUT, 'orbit.u16'), orbitBuf);
fs.writeFileSync(path.join(OUT, 'sigma.i8'), sigmaBuf);
fs.writeFileSync(path.join(OUT, 'zero.u8'), zeroBuf);
fs.writeFileSync(path.join(OUT, 'orbcanon.u16'), orbCanonBuf);
fs.writeFileSync(path.join(OUT, 'sigmacanon.i8'), sigmaCanonBuf);
fs.writeFileSync(path.join(OUT, 'zerocanon.u8'), zeroCanonBuf);
console.log(`\n已写出 ${path.join(OUT, '/')}{orbit,orbcanon}.u16 等 6 个文件(每槽 ${N} 项)`);

if (!canonConsistent || !zeroAgree || !minRuleUnique || closed !== 0 || NZERO === 0 || conflicts < NZERO) {
  console.error('\n✗ 自检未通过');
  process.exit(1);
}
console.log('✓ 自检通过');
