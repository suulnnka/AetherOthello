/* 残局完全求解对拍:Zig 的精确解 vs 主分支 JS 引擎(src/engine.js)。
 *
 * 为什么这条最能说明问题:完全求解**不吃启发式评估**,两种实现算出来的都是
 * 精确子差;规则、置换表、终局记分、虚着处理任何一处不一致都会立刻暴露。
 * 两边分值单位不同(JS ×100),换算后必须逐局面相等。
 *
 * 用法:node tools/probe-exact.mjs [out/exact.txt]
 */
import fs from 'node:fs';
import * as E from '../src/engine.js';

const path = process.argv[2] || 'out/exact.txt';
const lines = fs.readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
E.clearTT();

let bad = 0, n = 0, totalMs = 0;
for (const line of lines) {
  const [blo, bhi, wlo, whi, side, empties, want] = line.trim().split(/\s+/).map(Number);
  E.__setPosition(blo >>> 0, bhi >>> 0, wlo >>> 0, whi >>> 0, side === 1 ? 'b' : 'w');
  const t0 = performance.now();
  const v = E.search(empties + 4, -E.INF, E.INF, side === 1 ? E.BLACK : E.WHITE, 0, true);
  totalMs += performance.now() - t0;
  const got = Math.round(v / 100);
  if (got !== want) {
    console.log(`✗ 空位 ${empties}: zig=${want} js=${got}`);
    bad++;
  }
  n++;
}
console.log(bad === 0
  ? `✓ ${n} 个残局的精确解完全一致(JS 侧共 ${totalMs.toFixed(0)} ms)`
  : `✗ ${bad}/${n} 个残局不一致`);
process.exit(bad === 0 ? 0 : 1);
