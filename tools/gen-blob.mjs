#!/usr/bin/env node
/* 权重 blob 的工具箱:生成零占位 / 查看统计 / v2(2 相位)→ v3(6 相位)展开。
 *
 * 布局(小端,v3):
 *   0   u32  magic  'OTHL'
 *   4   u8   version = 3
 *   5   u8   phases = 6
 *   6   u8   pad
 *   7   u8   pad
 *   8   u32  orbits
 *   12  f32 × phases  每相位一个 scale(把 int8 加权和换算成"子数")
 *   12+4×phases  i8 × phases × orbits
 *
 * 历史:v1 头 16 字节两相位共用 scale;v2 头 20 字节(2 相位各一 scale)。
 *   v3 = 每相位一个 scale、相位数由头声明(当前引擎是 3 相位,头 24 字节)。
 *   旧 v2 书用 --expand 按区间无损升级:新相位 0 ← 旧相位 0(子数 ≤34),
 *   新相位 1/2 ← 旧相位 1 —— 34 恰是新分界之一,展开后求值处处与原书相等,
 *   可直接当 3 档训练的初始。
 *   改这里必须同步改 src/zig/pattern.zig 的 BLOB_HEADER / BLOB_VERSION
 *   与 tools/probe-eval.mjs / tools/probe-wasm.mjs 的读法。
 *
 * 用法:
 *   node tools/gen-blob.mjs --zero --out src/zig/weights.bin
 *   node tools/gen-blob.mjs --expand --in <v2 书> --out <v3 书>
 *   node tools/gen-blob.mjs --stat [--in src/zig/weights.bin]
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);

const ORBITS = 9475;

function writeBlob(path, scales, data) {
  const phases = scales.length;
  const header = 12 + 4 * phases;
  const buf = Buffer.alloc(header + data.length);
  buf.writeUInt32LE(0x4f54484c, 0);
  buf.writeUInt8(3, 4);
  buf.writeUInt8(phases, 5);
  buf.writeUInt32LE(ORBITS, 8);
  for (let p = 0; p < phases; p++) buf.writeFloatLE(scales[p], 12 + 4 * p);
  for (let i = 0; i < data.length; i++) buf.writeInt8(data[i], header + i);
  fs.writeFileSync(path, buf);
  return buf.length;
}

function readBlob(path) {
  const b = fs.readFileSync(path);
  if (b.readUInt32LE(0) !== 0x4f54484c) throw new Error('magic 不对');
  const version = b.readUInt8(4);
  const phases = b.readUInt8(5), orbits = b.readUInt32LE(8);
  const scales = Array.from({ length: phases }, (_, p) => b.readFloatLE(12 + 4 * p));
  const h = 12 + 4 * phases;
  const data = [];
  for (let i = 0; i < phases * orbits; i++) data.push(b.readInt8(h + i));
  return { version, phases, orbits, scales, data, bytes: b.length };
}

if (has('--zero')) {
  const out = argOf('--out', 'src/zig/weights.bin');
  const scales = new Array(3).fill(1 / 64);
  const n = writeBlob(out, scales, new Array(3 * ORBITS).fill(0));
  console.log(`已生成零占位 blob:${out}  ${n} 字节(3 阶段 × ${ORBITS} 轨道 + 24 字节头)`);
} else if (has('--expand')) {
  // v2(2 相位)→ v3(P 相位,P 由 --phases 指定,须整除 60):
  // 新相位 p ← 按该档**中点子数**落在 34 的哪一侧取旧相位。
  // 34 恰是新分界之一时(P=2/4/6/10…)展开逐点无损;不是时(如 P=3/5 的
  // 中点跨 34)只代表多数区域,展开书比源书略弱 —— 扫描这类 P 时 A/B 基线
  // 偏弱,读数要打折扣。
  const inPath = argOf('--in', 'src/zig/weights.bin');
  const out = argOf('--out', inPath);
  const P = Number(argOf('--phases', 3));
  if (!Number.isInteger(P) || P < 1 || 60 % P !== 0) {
    console.log(`✗ --phases ${P} 非法(须为 60 的约数)`);
    process.exit(1);
  }
  const r = readBlob(inPath);
  if (r.version !== 2 || r.phases !== 2) {
    console.log(`✗ ${inPath} 是 v${r.version}/${r.phases} 相位,--expand 只吃 v2 的 2 相位书`);
    process.exit(1);
  }
  const span = 60 / P;
  // ceil 家族的档区间:第 p 档(p≥1)覆盖 f ∈ [p·span+1, (p+1)·span],
  // 即子数 [4+p·span+1, 4+(p+1)·span];第 0 档 [4, 4+span]。
  // 映射与"无损"判定都按这个区间算(中点定旧相位;整档在 34 一侧才算无损)。
  const scales = [], src = [];
  let lossless = true;
  for (let p = 0; p < P; p++) {
    const lo = p === 0 ? 4 : 4 + p * span + 1;
    const hi = 4 + (p + 1) * span;
    if (hi <= 34) src.push(0);
    else if (lo >= 35) src.push(1);
    else { src.push((lo + hi) / 2 <= 34 ? 0 : 1); lossless = false; } // 跨 34:取中点侧
    scales.push(r.scales[src[p]]);
  }
  const data = new Array(P * ORBITS);
  for (let o = 0; o < ORBITS; o++) {
    for (let p = 0; p < P; p++) data[p * ORBITS + o] = r.data[src[p] * ORBITS + o];
  }
  const n = writeBlob(out, scales, data);
  console.log(`✓ v2 → v3(P=${P})展开:${out}  ${r.bytes} → ${n} 字节 · 档映射 ${src.join('')}${lossless ? '(34 对齐,无损)' : '(34 不对齐,基线略弱)'}`);
} else if (has('--stat')) {
  const inPath = argOf('--in', 'src/zig/weights.bin');
  const { version, phases, orbits, scales, data, bytes } = readBlob(inPath);
  const nz = data.filter((v) => v !== 0).length;
  const hist = {};
  for (const v of data) hist[v] = (hist[v] || 0) + 1;
  const absMax = Math.max(...data.map(Math.abs));
  console.log(`${inPath}  ${bytes} 字节 · version ${version}`);
  console.log(`  阶段 ${phases}  轨道 ${orbits}  定标 ${scales.map((s) => s.toFixed(6)).join(' / ')}`);
  console.log(`  非零 ${nz}/${data.length} (${((nz / data.length) * 100).toFixed(1)}%)  最大 |w| ${absMax}`);
  console.log(`  取值种数 ${Object.keys(hist).length}`);
} else {
  console.log('用法:--zero --out <path> | --expand --in <v2 书> [--out <v3 书>] | --stat --in <path>');
}
