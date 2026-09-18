# 引擎 Worker 协议(main 与 zig 两个分支共用的接口契约)

这个仓库有两个**实现**,一份**接口**:

| 分支 | 实现 | 说明 |
|---|---|---|
| `main` | `src/engine.js`(纯 JS 位棋盘:PVS + 置换表 + 残局完全求解) | 参照实现 / 历史版本。研究、基准、对拍都靠它 |
| `zig` | `src/zig/*` → `othello.wasm`(Zig,原生 u64 位棋盘) | 线上跑的版本(webos 黑白棋应用) |

**换实现不换接口**:UI、浏览器探针、对比脚本都只认下面这份契约,所以两条分支可以
直接互换而不动上层代码 —— 这是「之后方便对比」的前提。

## 必须逐字节一致的文件

改任意一个都要**在两个分支上同样地改**,否则契约就破了:

- `src/levels.js` —— 难度表(name/depth/end/budget)。同一个档位在两边指同一组参数。
- `docs/WORKER-PROTOCOL.md`(本文)
- `tools/probe-contract.mjs` —— 契约冒烟:在任一条分支上跑都必须全绿
- `tools/compare-branches.mjs` —— 把两条分支拉到一起跑同一批局面,输出对比表

`src/worker.js` 在两个分支上**同名不同实现**(背后分别是 JS 引擎 / wasm),但必须
满足下面的消息契约。实现细节(是否用 wasm、置换表策略、评分是 centi-disc 还是子数)
不属于契约 —— 那正是对比要看的东西。

```bash
git diff main zig -- src/levels.js docs/WORKER-PROTOCOL.md tools/probe-contract.mjs tools/compare-branches.mjs
# 应当没有任何输出
```

## 消息契约

> 一次只跑一个 `think`,发出去就等回包。要中断只能 `terminate()` Worker ——
> 两边都是同步搜索,新消息只会排队。UI 侧用请求号丢弃过期结果。

### 请求

```js
{ type: 'ping' }                    // → { type:'pong', tag, engine, ... }
{
  type: 'think',
  id,                               // 请求号,原样回传
  own: [lo, hi],                    // 行棋方位板,两个 u32(lo = 第 1–4 行)
  opp: [lo, hi],                    // 对方位板
  level,                            // LEVELS 的下标
  empties,                          // 64 - 双方子数(UI 已经算好,原样回传)
}
```

位板编码:`bit = row * 8 + col`(`row 0` = 最上面一行),`lo` 是 bit 0..31、`hi` 是 32..63。
**u64 拆成两个 u32 是刻意的**:wasm 的 i64 到 JS 是 BigInt,边界上最容易写错
(i64 参数用普通 number 传会抛 TypeError,还不报在哪一行);拆开之后全是普通 number,
只有一处拼装可能出错。

### 应答

```js
{
  id,          // 原样回传
  move,        // 0..63;−1 = 无合法着法(该跳过回合)
  score,       // 行棋方视角的估值
  depth,       // 这一手实际跑完的深度(0 = 贪心;完全求解时是求解深度)
  depthMax,    // 档位标称深度(LEVELS[level].depth)
  exact,       // score 是否为**精确终局子差**
  nodes,       // 节点数
  empties,     // 原样回传
  ms,          // 耗时(毫秒,含引擎内部搜索;不含消息往返)
  engine,      // 信息字段:实现名('js' / 'wasm'),不参与断言
  error,       // 失败原因;出现它时其余字段无意义
}
```

字段语义里几条**必须守死**的:

- `score` 一律是**行棋方视角**,单位是子数。JS 引擎内部用 centi-disc(终局 100/子),
  所以在 Worker 里 ÷100 之后再回包 —— 否则 UI 会显示 `+5700`。
  中局分是**启发式**,两边量级不同(JS 的位置权重表 vs Zig 的 38 表折叠),只在同一实现内
  可比;`exact: true` 时的分才是两边都等于真实子差的数,那才是能直接对比的地方。
- `exact` 必须是**可信**的:节点预算把求解截断时(剩下的是前置中层迭代的最后一轮)
  必须报 `false`。UI 拿它当终局判决,报错了就会显示一场凭空的胜负。
- `move` 必须是合法着法(或 −1)。UI 仍会自己复核一遍 legality 再落子,但引擎不该让它
  兜底 —— `tools/probe-contract.mjs` 里的合法性检查就是为这条准备的。
- `nodes` 可能超过预算:两边都是"在迭代之间检查预算",超了只是不再往下加深,不会中断
  当前这一层。语义是"返回最后一个跑完的深度",这一点两个实现必须一致。

## 验证

```bash
node tools/probe-contract.mjs              # 契约冒烟(当前分支)
node tools/compare-branches.mjs            # 当前分支 vs 另一条分支,同一批局面并排看
```
