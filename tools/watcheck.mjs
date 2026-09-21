/* 反汇编对照:popcnt 是 wasm MVP 核心指令,LLVM 是否真的发了?
 * 用法:node tools/watcheck.mjs  (内部写死 zig/rust 两个产物路径) */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const wabt = await (process.env.WABT_PATH ? require(process.env.WABT_PATH) : require('wabt'))();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const files = {
  zig: path.join(ROOT, 'zig-out', 'bin', 'othello.wasm'),
  rust: path.join(ROOT, 'rust', 'target', 'wasm32-unknown-unknown', 'release', 'othello_engine.wasm'),
};

for (const [k, f] of Object.entries(files)) {
  const mod = wabt.readWasm(fs.readFileSync(f), { readDebugNames: false });
  const wat = mod.toText({ foldExprs: false });
  const count = (re) => (wat.match(re) || []).length;
  console.log(
    `${k}: i64.popcnt=${count(/i64\.popcnt/g)} i32.popcnt=${count(/i32\.popcnt/g)}` +
    ` i64.ctz=${count(/i64\.ctz/g)} i32.ctz=${count(/i32\.ctz/g)} i64.clz=${count(/i64\.clz/g)}` +
    // SWAR 软件位技巧的标志掩码 0x5555555555555555 = 6148914691236517205
    ` SWAR_0x5555…=${count(/6148914691236517205/g)} watLines=${wat.split('\n').length}`,
  );
}
