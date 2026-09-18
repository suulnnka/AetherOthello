/* 端到端对拍:Zig 侧输出的 (own, opp, 38 个槽号) 里,槽号必须能被 JS
 * 用 model.mjs 独立重算出来 —— 这条链路覆盖「位棋盘取位 → 模式表格位序 → 3 进制下标」,
 * 是求值正确性的源头。
 * 用法:node tools/probe-slots.mjs [out/slots.txt]
 */
import fs from 'node:fs';
import { CELLS, PTN_COUNT, PTN_OFF } from './model.mjs';

const path = process.argv[2] || 'out/slots.txt';
const lines = fs.readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
const POW3 = [1, 3, 9, 27, 81, 243, 729, 2187, 6561];

let bad = 0, checked = 0, maxDiscs = 0;
for (const line of lines) {
  const t = line.trim().split(/\s+/);
  const own = BigInt('0x' + t[0]), opp = BigInt('0x' + t[1]);
  const got = t.slice(2).map(Number);
  if (got.length !== PTN_COUNT) { console.log('✗ 槽号个数', got.length); bad++; continue; }
  if (own & opp) { console.log('✗ 两个位板相交'); bad++; continue; }
  const discs = popcount(own) + popcount(opp);
  if (discs <= 4 || discs > 64) { console.log('✗ 子数异常', discs); bad++; continue; }
  maxDiscs = Math.max(maxDiscs, discs);

  for (let p = 1; p <= PTN_COUNT; p++) {
    let idx = 0;
    const cells = CELLS[p];
    for (let i = 0; i < cells.length; i++) {
      const bit = 1n << BigInt(cells[i]);
      const d = (own & bit) ? 1 : (opp & bit) ? 2 : 0;
      idx += d * POW3[i];
    }
    const want = PTN_OFF[p] + idx;
    if (got[p - 1] !== want) {
      console.log(`✗ 第 ${checked} 行 表 ${p}:zig=${got[p - 1]} js=${want}`);
      bad++;
      break;
    }
  }
  checked++;
}
function popcount(x) { let n = 0; while (x) { x &= x - 1n; n++; } return n; }

console.log(bad === 0
  ? `✓ ${checked} 个局面 × 38 张表的槽号全部一致(最大子数 ${maxDiscs})`
  : `✗ ${bad} 处不一致`);
process.exit(bad === 0 ? 0 : 1);
