/* ============================================================
 * 构建 Rust 引擎的 wasm 产物并落到 wasm/othello.wasm(rust 分支)。
 *
 * 与 tools/build-wasm.mjs(zig 通道)同一落点、同一验证:worker.js 只认
 * ../wasm/othello.wasm,换引擎不改一行胶水。构建后自动跑一遍
 * tools/probe-wasm.mjs —— 它核对产物与 src/zig/weights.bin 的一致性,
 * 忘了重建/权重换了没重编都在这里被拦住。
 *
 * 用法:node tools/build-rust.mjs [--skip-probe]
 * 退出码:0 成功 / 1 构建或验证失败
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const OUT = path.join(ROOT, 'wasm', 'othello.wasm');
const BUILT = path.join(ROOT, 'rust', 'target', 'wasm32-unknown-unknown', 'release', 'othello_engine.wasm');

console.log('» cargo build --release --target wasm32-unknown-unknown');
execFileSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown'], {
  stdio: 'inherit', cwd: path.join(ROOT, 'rust'),
});

const raw = fs.readFileSync(BUILT);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.copyFileSync(BUILT, OUT);

const gz = zlib.gzipSync(raw, { level: 9 }).length;
const br = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
const kb = (n) => (n / 1024).toFixed(2) + ' KB';
console.log(`\n» rust/target/.../othello_engine.wasm → wasm/othello.wasm`);
console.log(`  raw    ${String(raw.length).padStart(7)} B   ${kb(raw.length)}`);
console.log(`  gzip   ${String(gz).padStart(7)} B   ${kb(gz)}`);
console.log(`  brotli ${String(br).padStart(7)} B   ${kb(br)}`);
console.log('  (webos 体积闸门:gzip 后与 worker 胶水 chunk 求和 ≤ 50 KB)');

if (!process.argv.includes('--skip-probe')) {
  console.log('\n» 验证产物(node tools/probe-wasm.mjs wasm/othello.wasm)');
  execFileSync(process.execPath, ['tools/probe-wasm.mjs', 'wasm/othello.wasm'], { stdio: 'inherit', cwd: ROOT });
}
console.log('\n✓ wasm 产物已就绪:wasm/othello.wasm(Rust 引擎)');
