#!/usr/bin/env node
/* 权重 blob 的工具箱:生成零占位 / 查看统计 / 用 JS 侧数值手搓一份(测试用)。
 *
 * 布局(小端):
 *   0   u32  magic  'OTHL'
 *   4   u8   version = 1
 *   5   u8   phases
 *   6   u8   pad
 *   7   u8   pad
 *   8   u32  orbits
 *   12  f32  scale(把 int8 加权和换算成"子数")
 *   16  i8 × phases × orbits
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

function writeBlob(path, scale, data) {
  const buf = Buffer.alloc(16 + data.length);
  buf.writeUInt32LE(0x4f54484c, 0);
  buf.writeUInt8(1, 4);
  buf.writeUInt8(PHASES, 5);
  buf.writeUInt32LE(ORBITS, 8);
  buf.writeFloatLE(scale, 12);
  for (let i = 0; i < data.length; i++) buf.writeInt8(data[i], 16 + i);
  fs.writeFileSync(path, buf);
  return buf.length;
}

function readBlob(path) {
  const b = fs.readFileSync(path);
  if (b.readUInt32LE(0) !== 0x4f54484c) throw new Error('magic 不对');
  const phases = b.readUInt8(5), orbits = b.readUInt32LE(8), scale = b.readFloatLE(12);
  const data = [];
  for (let i = 0; i < phases * orbits; i++) data.push(b.readInt8(16 + i));
  return { phases, orbits, scale, data, bytes: b.length };
}

if (has('--zero')) {
  const out = argOf('--out', 'src/zig/weights.bin');
  const n = writeBlob(out, 1 / 64, new Array(PHASES * ORBITS).fill(0));
  console.log(`已生成零占位 blob:${out}  ${n} 字节(${PHASES} 阶段 × ${ORBITS} 轨道 + 16 字节头)`);
} else if (has('--stat')) {
  const inPath = argOf('--in', 'src/zig/weights.bin');
  const { phases, orbits, scale, data, bytes } = readBlob(inPath);
  const nz = data.filter((v) => v !== 0).length;
  const hist = {};
  for (const v of data) hist[v] = (hist[v] || 0) + 1;
  const absMax = Math.max(...data.map(Math.abs));
  console.log(`${inPath}  ${bytes} 字节`);
  console.log(`  阶段 ${phases}  轨道 ${orbits}  全局定标 ${scale}`);
  console.log(`  非零 ${nz}/${data.length} (${((nz / data.length) * 100).toFixed(1)}%)  最大 |w| ${absMax}`);
  console.log(`  取值种数 ${Object.keys(hist).length}`);
} else {
  console.log('用法:--zero --out <path> | --stat --in <path>');
}
