/* ============================================================
 * 38 张模式表的几何定义(黑白棋 / Othello 的模式评估特征)。
 *
 * 为什么原样照抄 suulnnka/kix4 的 Lua 构造:折叠分析(14.14×)必须作用在
 * **同一组表**上,否则研究文档里的数字和实现对不上。所以这里不求"更整齐",
 * 只求"和上游一致"。
 *
 * ── 38 张表到底是什么(2026-09-19 用代码跑出来的,不是读注释猜的)──
 *   1..8    行:i 固定,遍历 j
 *   9..16   列:j 固定,遍历 i
 *   17..27  "/" 方向斜线(row+col = 常数):i+j ∈ 2..16 共 15 条,
 *           两端的短斜线被并进同一张表({2,3,4} 并成 1 张、{14,15,16} 并成 1 张),
 *           于是 15 条 → 11 张表。
 *   28..38  "\" 方向斜线(row-col = 常数):同样 15 条 → 11 张表。
 *
 * 长度分布(每方向的斜线长度序列):
 *    [6, 4, 5, 6, 7, 8, 7, 6, 5, 4, 6]   合计 64 格/方向
 *   即 16×8 + 8×6 + 4×4 + 4×5 + 4×7 + 2×8 = 128 + 48 + 16 + 20 + 28 + 16 = 256 = 64×4
 *   —— 每个格子恰好被 4 张表覆盖,这是这套特征设计得"完整"的证据。
 *
 * 槽数(每阶段): 16·3^8 + 8·3^6 + 4·3^4 + 4·3^5 + 4·3^7 + 2·3^8
 *             = 104976 + 5832 + 324 + 972 + 8748 + 13122 = 133974
 *
 * ⚠ 研究文档与 fold.mjs 的注释里曾写作「16 条满线 + 18 条斜线 + 4 个角落三角」,
 *   那是把 kix4 注释读歪了(把"短斜线合并表"当成了角落三角)。格子覆盖数
 *   (256 = 64×4)碰巧一样,但分组完全不是那回事 —— 这里以代码为准。
 * ============================================================ */

export const PTN_COUNT = 38;

/** i+j 或 9+i-j(都落在 2..16)→ 斜线表序号 1..11(两端短斜线分别并成 1 张) */
const XY2PTN = [0, 0, 1, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 11, 11];

/** ptn2pos[p] = 该表的格子列表(1-based 坐标 (i,j) 展平: n = i*9 + j + 1) */
export const ptn2pos = [];
for (let p = 0; p <= PTN_COUNT; p++) ptn2pos[p] = [];

for (let i = 1; i <= 8; i++) {
  for (let j = 1; j <= 8; j++) {
    const n = i * 9 + j + 1;
    ptn2pos[i].push(n);                        // 1..8   行
    ptn2pos[j + 8].push(n);                    // 9..16  列
    ptn2pos[XY2PTN[i + j] + 16].push(n);       // 17..27 "/" 斜线
    ptn2pos[XY2PTN[9 + i - j] + 27].push(n);   // 28..38 "\" 斜线
  }
}

/** 0-based 方格号 sq = (i-1)*8 + (j-1) —— 与 rules.zig 的位号一致 */
export const sqOf = (n) => {
  const j = (n - 1) % 9, i = (n - j - 1) / 9;
  return (i - 1) * 8 + (j - 1);
};

/** 每张表的格子(0-based sq),顺序就是 3 进制幂的位序 —— 顺序不可随意改 */
export const CELLS = [];
for (let p = 1; p <= PTN_COUNT; p++) CELLS[p] = ptn2pos[p].map(sqOf);

export const PTN_LEN = [0];
for (let p = 1; p <= PTN_COUNT; p++) PTN_LEN[p] = CELLS[p].length;

export const PTN_SIZE = [0];
for (let p = 1; p <= PTN_COUNT; p++) PTN_SIZE[p] = 3 ** PTN_LEN[p];

export const PTN_OFF = [0];
{
  let acc = 0;
  for (let p = 1; p <= PTN_COUNT; p++) { PTN_OFF[p] = acc; acc += PTN_SIZE[p]; }
  var PER_PHASE = acc;
}
export { PER_PHASE };

/** 每格 → [ptn, 3^位序] × 4(格子被 4 张表覆盖,增量更新用) */
export const pos2ptn = [];
for (let n = 0; n <= 81; n++) pos2ptn[n] = [];
for (let p = 1; p <= PTN_COUNT; p++) {
  ptn2pos[p].forEach((n, idx) => { pos2ptn[n].push(p); pos2ptn[n].push(3 ** idx); });
}

/** 长度直方图,便于自检 */
export const LEN_HIST = (() => {
  const h = {};
  for (let p = 1; p <= PTN_COUNT; p++) h[PTN_LEN[p]] = (h[PTN_LEN[p]] || 0) + 1;
  return h;
})();
