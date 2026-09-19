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
 *   v3 = 6 相位(头 36 字节)。旧 v2 书用 --expand 按区间无损升级:
 *   新相位 0..2 ← 旧相位 0(子数 ≤34),新相位 3..5 ← 旧相位 1 —— 34 恰是
 *   6 档分界之一,所以展开后求值处处与原书相等,可直接当 6 档训练的初始。
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
  const scales = new Array(6).fill(1 / 64);
  const n = writeBlob(out, scales, new Array(6 * ORBITS).fill(0));
  console.log(`已生成零占位 blob:${out}  ${n} 字节(6 阶段 × ${ORBITS} 轨道 + 36 字节头)`);
} else if (has('--expand')) {
  // v2(2 相位)→ v3(6 相位):相位 0..2 ← 旧相位 0,相位 3..5 ← 旧相位 1。
  // 求值处处与原书相等(34 是 6 档分界之一),展开只改变"结构"不改变"棋力",
  // 专门用来给 6 档训练做热启动初始。
  const inPath = argOf('--in', 'src/zig/weights.bin');
  const out = argOf('--out', inPath);
  const r = readBlob(inPath);
  if (r.version !== 2 || r.phases !== 2) {
    console.log(`✗ ${inPath} 是 v${r.version}/${r.phases} 相位,--expand 只吃 v2 的 2 相位书`);
    process.exit(1);
  }
  const [s0, s1] = r.scales;
  const scales = [s0, s0, s0, s1, s1, s1];
  const data = new Array(6 * ORBITS);
  for (let o = 0; o < ORBITS; o++) {
    for (let p = 0; p < 6; p++) data[p * ORBITS + o] = r.data[(p < 3 ? 0 : 1) * ORBITS + o];
  }
  const n = writeBlob(out, scales, data);
  console.log(`✓ v2 → v3 展开:${out}  ${r.bytes} → ${n} 字节 · scale ${s0.toFixed(6)}×3 / ${s1.toFixed(6)}×3`);
  console.log('  相位 0..2 ← 旧相位 0,相位 3..5 ← 旧相位 1(34 子仍是分界,求值处处相等)');
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
