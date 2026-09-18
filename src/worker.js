/* ============================================================
 * 黑白棋引擎 Worker —— **JS 通道**(main 分支,参照实现)
 *
 * 契约见 docs/WORKER-PROTOCOL.md,与 zig 分支的 src/worker.js 完全一致:
 *   收 { type:'think', id, own:[lo,hi], opp:[lo,hi], level, empties }
 *   回 { id, move, score, depth, depthMax, exact, nodes, empties, ms, engine }
 * 换实现不换接口 —— UI、探针、对比脚本都不用改。
 *
 * 背后是 src/engine.js(纯 JS 位棋盘:PVS + 置换表 + 残局完全求解)。
 * 与 zig 通道的差异**全在实现层**,接口上等价,共三处值得说明:
 *
 *   ① JS 引擎吃 8×8 数组 + 颜色,所以这里要把位板摊回数组。行棋方一律记成
 *      'b' —— 黑白棋对颜色是**对称**的,位板只表达"我方/对方",引擎内部也只认
 *      me/opp 与子差,把行棋方贴成黑只是给它一个自洽的标签(分值仍是行棋方视角)。
 *   ② JS 引擎内部评分是 centi-disc(终局 100/子),回包前统一 ÷100 换成子数,
 *      与 wasm 通道单位一致 —— 否则同一个 UI 会一边显示 +5.7 一边显示 +5700。
 *   ③ JS 引擎没有节点预算参数,这里用 shouldAbort 在**每层迭代之间**检查(引擎只在
 *      这两个时刻把控制权交回来)。语义与 zig 通道相同:返回最后一个跑完的深度,
 *      所以 aborted 时 exact 必须报 false(留下的是启发式估值,不是终局判决)。
 * ============================================================ */
import { think, toBitboard, genMoves, PLO, PHI, OLO, OHI, MLO, MHI } from './engine.js';
import { LEVELS } from './levels.js';

/* ENGINE_TAG 让下游 webos 的体积闸门(tools/check-size.mjs)能在 dist 里认出
 * 这个 chunk。两条分支用同一个标记:它就是「黑白棋引擎」,实现不同不是标记的事。 */
const ENGINE_TAG = 'othello-engine-v1';
self.__engineTag = ENGINE_TAG;

/** 位板两半 → 8×8 数组(我方记 'b'、对方记 'w';理由见文件头 ①) */
function toArray(ownLo, ownHi, oppLo, oppHi) {
  const flat = new Array(64).fill(null);
  for (let i = 0; i < 64; i++) {
    const lo = i < 32, bit = 1 << (lo ? i : i - 32);
    if (lo ? ownLo & bit : ownHi & bit) flat[i] = 'b';
    else if (lo ? oppLo & bit : oppHi & bit) flat[i] = 'w';
  }
  const out = [];
  for (let r = 0; r < 8; r++) out.push(flat.slice(r * 8, r * 8 + 8));
  return out;
}

/** 行棋方还有没有合法着法 —— 借引擎自己的规则(genMoves 把结果写进 MLO/MHI),
 *  免得在 Worker 里再手写一遍合法步生成。棋盘为空/无子时引擎会当终局处理。 */
function hasMove(board) {
  toBitboard(board, 'b');
  genMoves(PLO, PHI, OLO, OHI);
  return (MLO | MHI) !== 0;
}

self.onmessage = async (e) => {
  const d = e.data;
  if (!d) return;

  if (d.type === 'ping') {
    self.postMessage({ type: 'pong', tag: ENGINE_TAG, engine: 'js', levels: LEVELS.length });
    return;
  }
  if (d.type !== 'think') return;

  const lv = LEVELS[d.level] ?? LEVELS[0];
  const board = toArray(d.own[0], d.own[1], d.opp[0], d.opp[1]);

  /* 无合法着法:引擎会直接返回 null(还没有任何进度回调可退回),而契约要求
   * 报 move = −1,所以这里先自己判一次。 */
  if (!hasMove(board)) {
    self.postMessage({
      id: d.id, move: -1, score: 0, depth: 0, depthMax: lv.depth,
      exact: false, nodes: 0, empties: d.empties, ms: 0, engine: 'js',
    });
    return;
  }

  const budget = Number(lv.budget) || 0;
  let aborted = false;
  let last = null;                       // 最后一条进度 = 最后一个跑完的深度
  const onProgress = (info) => {
    last = info;
    if (budget && info.nodes > budget) aborted = true;
  };

  let res;
  try {
    res = await think(board, 'b', lv, onProgress, () => aborted);
  } catch (err) {
    self.postMessage({ id: d.id, error: String((err && err.message) || err) });
    return;
  }

  const r = res || last;                 // 预算截断时引擎返回 null,退回最后一层
  if (!r) { self.postMessage({ id: d.id, error: 'no-result' }); return; }

  self.postMessage({
    id: d.id,
    move: r.move ?? -1,
    score: (r.score || 0) / 100,         // centi-disc → 子数(见文件头 ②)
    depth: r.endgame ? r.empties + 4 : (r.depth ?? (r.only ? lv.depth : 0)),
    depthMax: lv.depth,
    exact: !!(r.endgame && !aborted),    // 截断过的求解不是判决(见文件头 ③)
    nodes: r.nodes || 0,
    empties: d.empties,
    ms: r.ms || 0,
    engine: 'js',
  });
};
