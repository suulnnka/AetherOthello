#!/usr/bin/env node
/* 权重 blob 的工具箱:生成零占位 / 查看统计 / 用 JS 侧数值手搓一份(测试用)。
 *
 * 布局(小端):
 *   0   u32  magic  'OTHL'
 *   4   u8   version = 2
 *   5   u8   phases
 *   6   u8   pad
 *   7   u8   pad
 *   8   u32  orbits
 *   12  f32  scale(相位 0)(把 int8 加权和换算成"子数")
 *   16  f32  scale(相位 1)—— version 2 起每相位一个
 *   20  i8 × phases × orbits
 *
 * ⚠ version 1 头只有 16 字节、两相位共用一个 scale;v1 → v2 可无损迁移
 *   (两个相位填同一个 scale 即可)。改这里必须同步改 src/zig/pattern.zig 的
 *   BLOB_HEADER / BLOB_VERSION 与 tools/probe-eval.mjs 的读法。
 *
 * 用法:
 *   node tools/gen-blob.mjs --zero --out src/zig/weights.bin
 *   node tools/gen-blob.mjs --stat [--in src/zig/weights.bin]
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);

const PHASES = 2, ORBITS = 9475;

const HEADER = 20; // version 2:头 20 字节(两个 f32 scale)

function writeBlob(path, scales, data) {
  const buf = Buffer.alloc(HEADER + data.length);
  buf.writeUInt32LE(0x4f54484c, 0);
  buf.writeUInt8(2, 4);
  buf.writeUInt8(PHASES, 5);
  buf.writeUInt32LE(ORBITS, 8);
  for (let p = 0; p < PHASES; p++) buf.writeFloatLE(scales[p], 12 + 4 * p);
  for (let i = 0; i < data.length; i++) buf.writeInt8(data[i], HEADER + i);
  fs.writeFileSync(path, buf);
  return buf.length;
}

function readBlob(path) {
  const b = fs.readFileSync(path);
  if (b.readUInt32LE(0) !== 0x4f54484c) throw new Error('magic 不对');
  const version = b.readUInt8(4);
  const phases = b.readUInt8(5), orbits = b.readUInt32LE(8);
  // v1 头只有 16 字节、共用一个 scale —— 兼容读进来,对外一律按"每相位一个"暴露
  const scales = version === 1
    ? [b.readFloatLE(12), b.readFloatLE(12)]
    : [b.readFloatLE(12), b.readFloatLE(16)];
  const h = version === 1 ? 16 : HEADER;
  const data = [];
  for (let i = 0; i < phases * orbits; i++) data.push(b.readInt8(h + i));
  return { version, phases, orbits, scales, data, bytes: b.length };
}

if (has('--zero')) {
  const out = argOf('--out', 'src/zig/weights.bin');
  const n = writeBlob(out, [1 / 64, 1 / 64], new Array(PHASES * ORBITS).fill(0));
  console.log(`已生成零占位 blob:${out}  ${n} 字节(${PHASES} 阶段 × ${ORBITS} 轨道 + ${HEADER} 字节头)`);
} else if (has('--migrate')) {
  // v1 → v2:头 16 → 20 字节,两相位填同一个 scale。int8 数据一个字节都不动
  // ⇒ 语义完全等价,原来的书不会因此变差。
  const inPath = argOf('--in', 'src/zig/weights.bin');
  const out = argOf('--out', inPath);
  const r = readBlob(inPath);
  if (r.version !== 1) {
    console.log(`✗ ${inPath} 已经是 v${r.version},不用迁移`);
    process.exit(1);
  }
  const n = writeBlob(out, [r.scales[0], r.scales[0]], r.data);
  console.log(`✓ v1 → v2:${out}  ${r.bytes} → ${n} 字节 · scale ${r.scales[0]} 填给两个相位`);
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
  console.log('用法:--zero --out <path> | --stat --in <path> | --migrate --in <v1> [--out <v2>]');
}
