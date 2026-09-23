/* ============================================================
 * 黑白棋引擎 Worker —— **wasm 通道**(main 分支,线上跑的就是这套)
 *
 * 消息契约见 docs/WORKER-PROTOCOL.md —— 与 legacy_js 分支的 src/worker.js
 * (JS 参照实现)是**同一份接口**,所以 UI、探针、对比脚本换实现都不用改。
 * 那边也有同名文件、同样的消息进出,只是背后换成 src/engine.js;两边并排跑用
 * `node tools/compare-branches.mjs`。
 *
 *   ping                    → { type:'pong', tag, engine, orbits, weightBytes, scale }
 *                             (顺带强制加载 wasm:回包里能证明引擎真起来了)
 *   levels                  → { type:'levels', tag, engine, default, levels:[...] }
 *                             (纯声明本引擎的难度表,**不加载引擎**)
 *   { type:'state', id, own:[lo,hi], opp:[lo,hi] }
 *                           → { type:'state', id, moves, flips, oppHasMoves,
 *                               ownCount, oppCount, empties, over, reason, winner }
 *                             规则查询的单一入口:行棋方的全部合法落点与各自翻转的
 *                             己方子(flips 与 moves 平行)、对方有无棋、双方子数、
 *                             空格数、终局(满盘/双方无棋)与胜者(相对方)。
 *                             跳过回合由调用方推得:moves 空且 over=false → 查对方
 *   { type:'think', id, own:[lo,hi], opp:[lo,hi], level, depth?, empties }
 *                           → { id, move, score, depth, depthMax, nodes,
 *                               exact, empties, ms, engine, book, name?, root? }
 *                             root = { moves, scores, trues, exact } 根着法清单
 *                               原样透传,选着策略在 UI 层(src/policy.js)
 *                             book = 开局书命中(depth=0、nodes=0、score 为书内
 *                               精确值);UI 靠它标「开局库」来源,无书实现恒 false
 *                             name = 书命中局面的开局名(blob 名字池的 ASCII 单名;
 *                               并列局面不展示、无名局面继承最近单名祖先 —— 生成
 *                               器单一化策略,见 make-book.mjs ⑤);仅 book=1 且
 *                               非空时携带
 *                               —— UI 显示「开局库 · 名字 · 估值」,同 chess
 *                             move = -1 表示无合法着法(该跳过回合)
 *                             depth 可选:覆盖该档位的深度上限 —— 标定与跨实现
 *                             对打要"同深度比棋力"时用,缺省完全不变
 *
 * state 的实现在本文件里是一段**轻量 JS 位板遍历**(逐空格 8 方向扫描):
 * wasm 暂无 legal 导出(zig 工具链现已有,要下沉为 engineLegal/engineState
 * 导出随时可做,消息契约不变)—— 落子合法性、翻转子与胜负判定是规则,
 * 必须住在引擎仓库,所以放 worker.js 而不是 UI。
 *
 * 难度表住在引擎层(src/levels.js),**两套实现各一份、不要求一致** —— 搜索算法
 * 不同,同样的 depth/end/budget 在两边根本不是一回事。UI 只问不改,见上面 levels。
 *
 * 置换表在一个 Worker 的生命周期内**不清**:键里有 Zobrist 校验,跨手复用是安全的,
 * 残局里还实打实省时间。所以「清表」不是消息,而是换一个新 Worker(app 侧新对局/
 * 悔棋/换难度都直接 terminate —— 反正那些场景本来也要掐掉在途搜索)。
 *
 * ── 为什么这版走 wasm 而不是 port 一份 JS ────────────────────
 *   引擎逻辑(u64 位棋盘 + 38 表折叠 + PVS + 置换表 + 残局完全求解)整个在
 *   othello.wasm 里,Worker 只做「拆 lo/hi → 调 → 回填」,所以这边一行规则
 *   都没有,也就不可能和引擎吵架。src/engine.js 仍在(探针和基准用它当参照
 *   实现,compare-branches 也拿它跟这边对打),但**对弈路径不用它**。
 *
 * ── 位板为什么拆 lo/hi 两个 u32 ──────────────────────────────
 *   wasm 的 i64 到 JS 是 BigInt,边界上很容易出错(i64 参数用 Number 传会抛
 *   TypeError,而且不报在哪一行);拆两个 u32 之后全是普通 number,只有
 *   engine.zig 里那一处拼装有出错的可能,值不值得的信封算得清。
 *
 * ── 搜索是同步的 ────────────────────────────────────────────
 *   一次 engineThink 跑完才返回,中途没有进度可报(所以 UI 看不到深度一层层
 *   涨,只有最后的结果行)。要真中断只能 terminate() 再造一个 Worker;
 *   app 侧用请求序号丢弃过期结果即可。
 * ============================================================ */
import { LEVELS, DEFAULT_LEVEL } from './levels.js';

/* ENGINE_TAG 让下游 webos 的体积闸门(tools/check-size.mjs)能在 dist 里认出
 * 这个 chunk(字符串不会被压缩改名)。注意黑白棋是 wasm 通道:闸门会把
 * 这个 chunk 与 othello.wasm 的 gzip 体积**求和**再比预算。 */
const ENGINE_TAG = 'othello-engine-v1';
self.__engineTag = ENGINE_TAG;

/* 相对本文件的静态 URL:Vite 会改写成带 hash 的产物路径,原生浏览器
 * (直接跑模块 Worker)下也能按相对路径取到 —— 不写 ?url 是为了不把引擎
 * 仓库绑死在打包器上。 */
const WASM_URL = new URL('../wasm/othello.wasm', import.meta.url);

/* ---- 局面规则(JS 位板;wasm 暂无 legal 导出,规则事实住这里)----
 * bit = row*8+col,row0 = 最上一行,lo 装 bit0..31、hi 装 bit32..63 —— 与 think
 * 的位板编码一致。每个空格沿 8 方向扫描:连续的对方子之后必须接一枚己方子。
 * 这些全是黑白棋的规则事实(合法性 / 翻子 / 数子 / 终局 / 胜者),UI 不复判。 */
const STATE_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const bitAt = (lo, hi, i) => (i < 32 ? (lo >>> i) & 1 : (hi >>> (i - 32)) & 1);
const pop32 = (x) => {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >>> 24;
};

function legalWithFlips(ownLo, ownHi, oppLo, oppHi) {
  const moves = [], flips = [];
  for (let cell = 0; cell < 64; cell++) {
    if (bitAt(ownLo, ownHi, cell) || bitAt(oppLo, oppHi, cell)) continue;
    const r0 = cell >> 3, c0 = cell & 7;
    const here = [];
    for (const [dr, dc] of STATE_DIRS) {
      let r = r0 + dr, c = c0 + dc;
      const line = [];
      while (r >= 0 && r < 8 && c >= 0 && c < 8 && bitAt(oppLo, oppHi, r * 8 + c)) {
        line.push(r * 8 + c);
        r += dr; c += dc;
      }
      if (line.length && r >= 0 && r < 8 && c >= 0 && c < 8 && bitAt(ownLo, ownHi, r * 8 + c)) {
        here.push(...line);
      }
    }
    if (here.length) { moves.push(cell); flips.push(here); }
  }
  return { moves, flips };
}

/** state 回包的规则事实(own/opp 是相对方;winner 也用 'own'/'opp' 表达,
 *  由调用方按自己查询时的行棋方映射回黑/白):
 *   - moves/flips:行棋方全部合法落点与各自翻子
 *   - oppHasMoves:对方是否有棋(仅当前方无棋 → 跳过回合;双方都无 → 终局)
 *   - ownCount/oppCount/empties:双方子数与空格数(empties 即 think 的参数)
 *   - over/reason/winner:满盘('full')或双方无棋('no-moves')终局;子多者胜 */
function describeState(ownLo, ownHi, oppLo, oppHi) {
  const mine = legalWithFlips(ownLo, ownHi, oppLo, oppHi);
  const theirs = legalWithFlips(oppLo, oppHi, ownLo, ownHi);
  const ownCount = pop32(ownLo) + pop32(ownHi);
  const oppCount = pop32(oppLo) + pop32(oppHi);
  const empties = 64 - ownCount - oppCount;
  const over = mine.moves.length === 0 && theirs.moves.length === 0;
  let reason = null, winner = null;
  if (over) {
    reason = empties === 0 ? 'full' : 'no-moves';
    winner = ownCount > oppCount ? 'own' : ownCount < oppCount ? 'opp' : null;   // null = 和棋
  }
  return {
    moves: mine.moves,
    flips: mine.flips,
    oppHasMoves: theirs.moves.length > 0,
    ownCount, oppCount, empties,
    over, reason, winner,
  };
}

let booting = null;

/** 懒加载 + 只实例化一次。引擎内部是全局状态,本来就是「一个 Worker 一个引擎」。 */
function boot() {
  if (!booting) {
    booting = (async () => {
      const res = await fetch(WASM_URL);
      if (!res.ok) throw new Error(`othello.wasm HTTP ${res.status}`);
      /* 用 arrayBuffer + instantiate 而不是 instantiateStreaming:体积才 41 KB,
       * 流式编译省不下什么,却要对 Content-Type 是不是 application/wasm 提心
       * 吊胆(静态服务器/CDN 常配错),失败回退还要再发一次请求。 */
      const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {});
      const X = instance.exports;
      const stage = X.engineInit();
      if (stage !== 0) throw new Error(`engineInit 失败(步 ${stage},权重书损坏?)`);
      return X;
    })().catch((err) => { booting = null; throw err; });   // 失败不缓存,下次可重试
  }
  return booting;
}

self.onmessage = (e) => {
  const d = e.data;
  if (!d) return;

  if (d.type === 'levels') {
    /* 故意**不 boot()**:UI 建难度下拉不该被 wasm 取没取到绑住 —— 引擎起不来时
     * 下拉至少还在,报错交给 ping / think 那条路去报到状态栏。 */
    self.postMessage({
      type: 'levels', tag: ENGINE_TAG, engine: 'wasm',
      default: DEFAULT_LEVEL, levels: LEVELS,
    });
    return;
  }

  if (d.type === 'state') {
    /* 规则查询,不依赖 wasm:纯位板遍历,见文件头说明 */
    const s = describeState(d.own[0], d.own[1], d.opp[0], d.opp[1]);
    self.postMessage({ type: 'state', id: d.id, tag: ENGINE_TAG, ...s });
    return;
  }

  if (d.type === 'ping') {
    /* ping 也走 boot():回包里带上权重书元信息,于是「Worker 活着」与
     * 「wasm 取到并初始化成功」这两件事一次问清 —— 否则探针只能看到
     * 「Worker 没报错」,那是什么都没证明。 */
    boot()
      .then((X) => self.postMessage({
        type: 'pong', tag: ENGINE_TAG, engine: 'wasm',
        orbits: X.engineOrbits(), weightBytes: X.engineWeightBytes(), scale: X.engineScale(),
      }))
      .catch((err) => self.postMessage({ type: 'pong', tag: ENGINE_TAG, engine: 'wasm', error: String((err && err.message) || err) }));
    return;
  }
  if (d.type !== 'think') return;

  boot().then((X) => {
    const lv = LEVELS[d.level] ?? LEVELS[DEFAULT_LEVEL] ?? LEVELS[0];
    /* `depth` 是**可选覆盖**:只替换该档位的深度上限,end / budget 照旧取档位。
     * 给标定与跨实现对打用 —— 两边难度表本来就不同(wasm 默认 d12、
     * legacy_js 默认 d8),想"同深度比棋力"就必须能从外面把深度钉住,
     * 否则比的是两套参数而不是两种实现。
     * 缺省(undefined / null / NaN)时行为与原来一字不差。 */
    const depthMax = Number.isFinite(d.depth) ? d.depth : lv.depth;
    const bud = Number(lv.budget) || 0;
    /* `seed` 已退役(2026-09-20 随机化事故后重构):引擎侧选着随机整体移除,
     * 旧客户端多发的 seed 字段直接忽略 —— think 行为不再随任何种子变化。 */
    /* ⑥ PC:按档位的置信度系数开关(缺省/老回包无 pc 字段 = 关)。中盘
     * dv4 + 尾盘 dv4/dv10,全部由引擎内常量定,协议不再暴露第二字段。 */
    if (typeof X.engineSetPc === 'function') {
      X.engineSetPc(lv.pc ? 1 : 0, Number(lv.pc) || 0);
    }
    const t0 = performance.now();
    const mv = X.engineThink(
      d.own[0], d.own[1], d.opp[0], d.opp[1],
      depthMax, lv.end,
      bud >>> 0, Math.floor(bud / 4294967296) >>> 0,
    );
    const ms = performance.now() - t0;
    // 开局书命中标志(书着 depth=0 与贪心同形,只能引擎自己说);typeof 防御
    // 还没带 engineBook 导出的旧 wasm
    const book = typeof X.engineBook === 'function' && X.engineBook() === 1;
    // 书命中的开局名:引擎给的是 blob 内字符串的地址+长度(@embedFile 常量在
    // 线性内存里,零拷贝),这里按 ASCII 解出。仅 book=1 且非空才带 name 字段。
    let bookName = '';
    if (book && typeof X.engineBookNamePtr === 'function' && X.memory) {
      const p = X.engineBookNamePtr(), l = X.engineBookNameLen();
      if (p > 0 && l > 0) bookName = new TextDecoder('ascii').decode(new Uint8Array(X.memory.buffer, p, l));
    }
    /* 根着法清单原样透传:选着策略在 **UI 层**(src/policy.js,webos 应用与
     * 独立页共用同一份)—— move 字段是引擎确定最优(清单第 0 项)兼做 UI 的
     * 回退;清单格式见 WORKER-PROTOCOL.md「选着策略」。 */
    let root;
    if (typeof X.engineRootN === 'function') {
      const rn = X.engineRootN();
      const moves = [], scores = [], trues = [];
      for (let i = 0; i < rn; i++) {
        moves.push(X.engineRootMove(i));
        scores.push(X.engineRootScore(i));
        trues.push(typeof X.engineRootTrue === 'function' && X.engineRootTrue(i) === 1);
      }
      root = { moves, scores, trues, exact: X.engineRootExact() === 1 };
    }
    self.postMessage({
      id: d.id,
      move: mv,
      ...(root ? { root } : {}),
      score: X.engineScore(),
      depth: X.engineDepth(),
      depthMax,
      exact: X.engineExact() === 1,
      book,
      ...(bookName ? { name: bookName } : {}),
      // 引擎的节点计数是 u64,emscripten 那套 BigInt 返回值这里用不上 —— 拆两半拼
      nodes: X.engineNodesLo() + X.engineNodesHi() * 4294967296,
      empties: d.empties,
      ms,
      engine: 'wasm',
    });
  }).catch((err) => {
    self.postMessage({ id: d.id, error: String((err && err.message) || err) });
  });
};
