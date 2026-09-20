/* ============================================================
 * 选着策略(2026-09-20 随机化事故后重构)—— 引擎只报「全部根着法 + 分数 +
 * 逐着真值标记」,选着住在 **UI 层**(本模块被 webos 应用与独立对弈页共同
 * import;worker 只透传清单,不选)。铁律:**界值一个都不许进随机池** ——
 * 中局非首着的分数是零窗口 fail-soft 的界(engineRootTrue=0,真值可以任意
 * 差),曾经引擎内 1 子容差的随机就拿这些界当真值,中局大昏着(送角)整批
 * 入池、全档掉血。三档:
 *   · 开局书(book=true,书值=精确终局子差,逐着恒真值):容差 ±2 内按
 *     2^(值−下沿) 加权 —— 值好多占、近优保留,开局多样性;
 *   · 残局完全求解(root.exact 且非书):**严格同值**内均匀随机,且只吃真值
 *     项 —— 结局(精确子差)不变,只换达成路径;
 *   · 中局(启发式):**真值着法 ±1 子**内均匀随机 —— 有一点多样性,又不拿
 *     界当真值;第 0 项(本轮最优)恒真值,池永不空,每手损失构造性 ≤1 子。
 * 随机源 = Math.random(每局天然多样);要确定行为就不调本函数,直接用回包
 * 的 move(= 清单第 0 项,引擎确定最优)。
 * ============================================================ */

export const BOOK_TOL = 2;   // 书:值容差(子)—— 与旧引擎 BOOK_TOL 同值
export const MID_TOL = 1;    // 中盘:真值着法容差(子)

/** 在根清单上选一手。root = worker 透传的 { moves, scores, trues?, exact },
 *  book = 回包 book 字段。返回选中的着法(0..63);-1 = 清单不可用/不满足
 *  随机条件,调用方应沿用回包 move(引擎确定最优)。 */
export function pickOthelloMove(root, book) {
  if (!root || !Array.isArray(root.moves) || root.moves.length <= 1) return -1;
  const scores = root.scores ?? [];
  const best = scores[0];
  if (!Number.isFinite(best)) return -1;
  // 书:容差加权(书值全精确,无需真值过滤);终局解:严格同值、只吃真值;
  // 中盘:±1 子、只吃真值。需要真值过滤而清单没带 trues → 不随机。
  const tol = book ? BOOK_TOL : root.exact ? 0 : MID_TOL;
  const needTrue = !book;
  const trues = root.trues;
  if (needTrue && !Array.isArray(trues)) return -1;
  const pool = [], wgt = [];
  let total = 0;
  for (let i = 0; i < root.moves.length; i++) {
    const v = scores[i];
    if (!Number.isFinite(v) || best - v > tol + 1e-6) continue;
    if (needTrue && trues[i] !== true) continue;            // 界值不进池
    const w = book ? 2 ** Math.round(v - (best - tol)) : 1;
    pool.push(root.moves[i]);
    wgt.push(w);
    total += w;
  }
  if (!pool.length) return -1;                              // 防御:构造上不该发生
  let pick = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    pick -= wgt[i];
    if (pick < 0) return pool[i];
  }
  return pool[pool.length - 1];
}
