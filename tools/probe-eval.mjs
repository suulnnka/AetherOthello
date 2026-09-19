/* 求值链路对拍:权重书(blob)→ 折叠表(orbit/sigma/zero)→ 整数加权和。
 *
 * 为什么这是**唯一**能证明中局求值无误的对拍:残局完全求解不吃启发式评估,
 * 所以它证明不了 `wt` 表;中局分值又是 38 次查表的结果,单个权重写错只会让
 * 分值"偏一点",看输出根本看不出来。只有把 JS 侧从 blob 开始**独立重算一遍**,
 * 并且逐局面比整数和,才能把「blob 解析 / 相位划分 / 符号折叠 / 槽号 → 轨道」
 * 每一环都钉死。
 *
 * 比的是**整数**(未乘 scale)而不是浮点:浮点会掺进格式化与舍入噪声,
 * "其实一样"的两个数能看出不一样,反而掩盖真差异。
 *
 * 几何表来自 tools/model.mjs(独立实现),不读 Zig 倒出来的槽号 ——
 * 否则槽号错了两边一起错。
 *
 * 用法:node tools/probe-eval.mjs <权重书> [out/evaldump.txt] [折叠表目录]
 */
import fs from 'node:fs';
import { CELLS, PTN_COUNT, PTN_OFF } from './model.mjs';

const blobPath = process.argv[2] || 'src/zig/weights.bin';
const dumpPath = process.argv[3] || 'out/evaldump.txt';
const foldDir = process.argv[4] || 'out';

const ORBITS = Number(process.argv[5] || 9475);
const MAGIC = 0x4f54484c; // 'OTHL'

const blob = fs.readFileSync(blobPath);
if (blob.length < 12) { console.log(`✗ blob 太短:${blob.length}`); process.exit(1); }
if (blob.readUInt32LE(0) !== MAGIC) { console.log('✗ magic 不对'); process.exit(1); }
if (blob[4] !== 3) { console.log('✗ version 不对(要 v3:每相位一个 scale,头 12+4×phases)'); process.exit(1); }
const PHASES = blob[5];
const HEADER = 12 + 4 * PHASES;
if (blob.length !== HEADER + PHASES * ORBITS) {
  console.log(`✗ blob 长度 ${blob.length} ≠ ${HEADER + PHASES * ORBITS}(头 ${HEADER} + ${PHASES}×${ORBITS})`);
  process.exit(1);
}
if (blob.readUInt32LE(8) !== ORBITS) { console.log('✗ orbits 不对'); process.exit(1); }
const scales = Array.from({ length: PHASES }, (_, p) => blob.readFloatLE(12 + 4 * p));
const scalesTxt = scales.map((s) => s.toFixed(6)).join(' / ');
console.log(`权重书 ${blobPath}:${blob.length} 字节 · ${PHASES} 相位 × ${ORBITS} 轨道 · scale ${scalesTxt}`);

// ── 折叠表(Zig 用的「代表升序编号」口径;oracle-fold.mjs 落的那三张)──
const orbitBuf = fs.readFileSync(`${foldDir}/orbcanon.u16`);
const sigmaBuf = fs.readFileSync(`${foldDir}/sigmacanon.i8`);
const zeroBuf = fs.readFileSync(`${foldDir}/zerocanon.u8`);
const orbit = new Uint16Array(orbitBuf.buffer, orbitBuf.byteOffset, orbitBuf.length / 2);
const sigma = new Int8Array(sigmaBuf.buffer, sigmaBuf.byteOffset, sigmaBuf.length);
const zeroed = new Uint8Array(zeroBuf.buffer, zeroBuf.byteOffset, zeroBuf.length);

// 每轨道是否被对称性强制作 0
const orbZero = new Uint8Array(ORBITS);
for (let s = 0; s < orbit.length; s++) if (zeroed[s]) orbZero[orbit[s]] = 1;

// ── 重算 wt(与 pattern.zig init 的第 ④ 步同一条公式)──
const wt = Array.from({ length: PHASES }, () => new Int8Array(orbit.length));
for (let ph = 0; ph < PHASES; ph++) {
  const base = HEADER + ph * ORBITS;
  for (let s = 0; s < orbit.length; s++) {
    const o = orbit[s];
    let w = orbZero[o] ? 0 : blob.readInt8(base + o);
    if (sigma[s] < 0) w = -w;
    wt[ph][s] = w;
  }
}

const POW3 = [1, 3, 9, 27, 81, 243, 729, 2187, 6561];
// 与 pattern.zig phaseOf 同一条公式:均分 60 手,ceil 家族(f=0 并入第 0 档)
const SPAN = 60 / PHASES;
const phaseOf = (discs) => {
  const f = Math.max(discs - 4, 0);
  return Math.min(Math.floor(Math.max(f - 1, 0) / SPAN), PHASES - 1);
};

const lines = fs.readFileSync(dumpPath, 'utf8').split('\n').filter((l) => l.trim());
let bad = 0, n = 0, maxAbs = 0;
const perPhase = new Array(PHASES).fill(0);

for (const line of lines) {
  const t = line.trim().split(/\s+/);
  const own = BigInt('0x' + t[0]), opp = BigInt('0x' + t[1]);
  const discs = Number(t[2]);
  const zigSum = Number(t[3]);
  const zigSlots = t.slice(4).map(Number);
  const jsSlots = [];

  for (let p = 1; p <= PTN_COUNT; p++) {
    let idx = 0;
    const cells = CELLS[p];
    for (let i = 0; i < cells.length; i++) {
      const bit = 1n << BigInt(cells[i]);
      const d = own & bit ? 1 : opp & bit ? 2 : 0;
      idx += d * POW3[i];
    }
    jsSlots.push(PTN_OFF[p] + idx);
  }
  for (let p = 0; p < PTN_COUNT; p++) {
    if (jsSlots[p] !== zigSlots[p]) {
      console.log(`✗ 第 ${n} 行 表 ${p + 1} 槽号:zig=${zigSlots[p]} js=${jsSlots[p]}`);
      bad++;
      break;
    }
  }

  const ph = phaseOf(discs);
  perPhase[ph]++;
  let sum = 0;
  for (let p = 0; p < PTN_COUNT; p++) sum += wt[ph][jsSlots[p]];
  if (sum !== zigSum) {
    console.log(`✗ 第 ${n} 行(子数 ${discs} 相位 ${ph}):zig=${zigSum} js=${sum}`);
    bad++;
  }
  maxAbs = Math.max(maxAbs, Math.abs(zigSum));
  n++;
}

const phaseTxt = perPhase.map((c, p) => `相位${p} ${c}`).join(' · ');
console.log(`  样本 ${phaseTxt} · |加权和| 最大 ${maxAbs}(≈ ${(maxAbs * Math.max(...scales)).toFixed(2)} 子)`);
console.log(bad === 0
  ? `✓ ${n} 个局面的槽号与整数加权和全部一致(求值链路:blob → 折叠表 → 38 张查表)`
  : `✗ ${bad} 处不一致 / 共 ${n} 行`);
process.exit(bad === 0 ? 0 : 1);
