/* ============================================================
 * 构建浏览器用的 wasm 产物并落到 wasm/othello.wasm(这个是**入库**的)。
 *
 * 为什么要入库:webos 侧 `vite build` 是从源码树里直接 import 这个 .wasm 的
 *   (src/worker.js 里的 new URL('../wasm/othello.wasm', import.meta.url))。
 *   仓库里没有它就构建不起来 —— zig-out/ 是 gitignore 的构建产物,不能作为
 *   交付路径。代价是**权重改了必须重跑本脚本并提交**,所以脚本最后会跑一遍
 *   tools/probe-wasm.mjs:它会核对 wasm 里的权重书头部与 src/zig/weights.bin
 *   是否一致(忘了重建的那次会在这里被拦住)。
 *
 * 用法:node tools/build-wasm.mjs [--skip-probe]
 * 退出码:0 成功 / 1 构建或验证失败
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const ZIG = process.env.ZIG || 'zig';
const OUT = path.join(ROOT, 'wasm', 'othello.wasm');
const BUILT = path.join(ROOT, 'zig-out', 'bin', 'othello.wasm');

/** WinGet 装的 zig 在 Windows 上会间歇 AccessDenied(杀软/文件占用),
 *  重试几次就好 —— 之前每次都靠人肉重跑,这里包成循环。 */
function zigBuild() {
  for (let i = 1; i <= 4; i++) {
    try {
      execFileSync(ZIG, ['build'], { stdio: 'inherit', cwd: ROOT });
      return;
    } catch (err) {
      const txt = String((err && (err.stdout || err.stderr || err.message)) || err);
      const transient = /AccessDenied|Access is denied|另一个程序正在使用|EBUSY|EPERM/i.test(txt);
      console.error(`\n✗ zig build 第 ${i} 次失败${transient ? '(瞬时占用,重试)' : ''}`);
      if (!transient || i === 4) throw err;
    }
  }
}

console.log('» zig build');
zigBuild();

const raw = fs.readFileSync(BUILT);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.copyFileSync(BUILT, OUT);

const gz = zlib.gzipSync(raw, { level: 9 }).length;
const br = zlib.brotliCompressSync(raw, {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
}).length;
const kb = (n) => (n / 1024).toFixed(2) + ' KB';
console.log(`\n» zig-out/bin/othello.wasm → wasm/othello.wasm`);
console.log(`  raw    ${String(raw.length).padStart(7)} B   ${kb(raw.length)}`);
console.log(`  gzip   ${String(gz).padStart(7)} B   ${kb(gz)}`);
console.log(`  brotli ${String(br).padStart(7)} B   ${kb(br)}`);
  console.log('  (webos 体积闸门:gzip 后与 worker 胶水 chunk 求和 ≤ 70 KB —— 6 相位权重书时代的预算)');

if (!process.argv.includes('--skip-probe')) {
  console.log('\n» 验证产物(node tools/probe-wasm.mjs wasm/othello.wasm)');
  execFileSync(process.execPath, ['tools/probe-wasm.mjs', 'wasm/othello.wasm'], { stdio: 'inherit', cwd: ROOT });
}
console.log('\n✓ wasm 产物已就绪:wasm/othello.wasm');
