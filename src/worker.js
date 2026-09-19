/* ============================================================
 * 黑白棋引擎 Worker —— **zig 通道**(zig 分支,线上跑的就是这套)
 *
 * 消息契约见 docs/WORKER-PROTOCOL.md —— 与 main 分支的 src/worker.js
 * (JS 参照实现)是**同一份接口**,所以 UI、探针、对比脚本换实现都不用改。
 * 那边也有同名文件、同样的消息进出,只是背后换成 src/engine.js;两边并排跑用
 * `node tools/compare-branches.mjs`。
 *
 *   ping                    → { type:'pong', tag, engine, orbits, weightBytes, scale }
 *                             (顺带强制加载 wasm:回包里能证明引擎真起来了)
 *   levels                  → { type:'levels', tag, engine, default, levels:[...] }
 *                             (纯声明本引擎的难度表,**不加载引擎**)
 *   { type:'think', id, own:[lo,hi], opp:[lo,hi], level, empties }
 *                           → { id, move, score, depth, depthMax, nodes,
 *                               exact, empties, ms, engine }
 *                             move = -1 表示无合法着法(该跳过回合)
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
    const bud = Number(lv.budget) || 0;
    const t0 = performance.now();
    const mv = X.engineThink(
      d.own[0], d.own[1], d.opp[0], d.opp[1],
      lv.depth, lv.end,
      bud >>> 0, Math.floor(bud / 4294967296) >>> 0,
    );
    const ms = performance.now() - t0;
    self.postMessage({
      id: d.id,
      move: mv,
      score: X.engineScore(),
      depth: X.engineDepth(),
      depthMax: lv.depth,
      exact: X.engineExact() === 1,
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
