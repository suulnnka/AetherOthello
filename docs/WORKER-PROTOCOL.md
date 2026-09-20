# 引擎 Worker 协议(main 与 legacy_js 两个分支共用的接口契约)

这个仓库有两个**实现**,一份**接口**:

| 分支 | 实现 | 说明 |
|---|---|---|
| `main` | `src/zig/*` → `othello.wasm`(Zig,原生 u64 位棋盘) | 线上跑的版本(webos 黑白棋应用) |
| `legacy_js` | `src/engine.js`(纯 JS 位棋盘:PVS + 置换表 + 残局完全求解) | 参照实现 / 历史版本。研究、基准、对拍都靠它 |

**换实现不换接口**:UI、浏览器探针、对比脚本都只认下面这份契约,所以两条分支可以
直接互换而不动上层代码 —— 这是「之后方便对比」的前提。

## 必须逐字节一致的文件

改任意一个都要**在两个分支上同样地改**,否则契约就破了:

- `docs/WORKER-PROTOCOL.md`(本文)
- `tools/probe-contract.mjs` —— 契约冒烟:在任一条分支上跑都必须全绿
- `tools/compare-branches.mjs` —— 把两条分支拉到一起跑同一批局面,输出对比表
- `tools/match-branches.mjs` —— 让两条分支**互相下整局**(配对开局 + 交换执子方),
  这才回答得了"谁棋力强";单步对比回答不了

`src/worker.js` 在两个分支上**同名不同实现**(背后分别是 JS 引擎 / wasm),但必须
满足下面的消息契约。实现细节(是否用 wasm、置换表策略、评分是 centi-disc 还是子数)
不属于契约 —— 那正是对比要看的东西。

```bash
git diff main zig -- docs/WORKER-PROTOCOL.md tools/probe-contract.mjs tools/compare-branches.mjs tools/match-branches.mjs
# 应当没有任何输出
```

## 难度表属于**引擎层**,由引擎自报

**两套实现连搜索算法都不同**(JS 是 PVS + 位置权重表,Zig 是 u64 位棋盘上的另一套),
所以「同一个档位」在两边的实际深度、耗时、棋力根本对不上 —— 硬把 `depth/end/budget`
做成两边一致的共享文件是**假的统一**,只会造成「表改了但引擎没跟着标定」。
因此:

- 难度表住在引擎仓库里(`src/levels.js`),**每个分支一份、可以各自调、不要求一致**。
- UI **不 import 这张表**。启动时发一次 `{ type:'levels' }`,按回包建下拉。
- 于是「调难度」这件事只需改引擎仓库,不用动 webos。

```js
{ type: 'levels' }   // 纯声明,不触发引擎加载(见下)
// → {
//   type: 'levels', tag, engine,
//   default: 2,                                   // 建议的默认档位下标
//   levels: [ { name, desc, depth, end, budget }, ... ],
// }
```

- `levels` 数组**至少一项**,下标就是 `think.level` 用的那个下标。
- `name` / `desc` 是给人看的字符串(UI 直接拿去建 `<option>` / tooltip);
  `depth`(标称深度上限)/ `end`(进入完全求解的空格阈值)/ `budget`(节点预算,
  0 = 不限)是引擎参数,UI **只读不改**。
  UI 只用到其中两个:`end` 用来判断「进了求解区间却没给精确解」,`depth` 在回包没有
  `depthMax` 时兜底。
- `default` 由引擎层给:哪一档是「默认体验」是引擎的判断,不是 UI 的。UI 必须把下拉
  初值显式设成它(否则会出现「界面显示初级、引擎按高级跑」那类不一致)。
- 这个请求**不加载引擎**(不碰 wasm / 不建置换表),所以 UI 建下拉永远不会因为
  引擎加载失败而空掉 —— 引擎起不来是 `ping` / `think` 那条路要报的错。

> 换实现之后,**档位下标不能跨实现直接对比棋力**。要横向比,请用
> `tools/compare-branches.mjs`:它会先把两边的表都打出来(名字/参数都可能不同),
> 再用同一批局面并排跑 —— 看清楚各自跑的是什么参数,再看着法/耗时/`exact` 分数。

## 消息契约

> 一次只跑一个 `think`,发出去就等回包。要中断只能 `terminate()` Worker ——
> 两边都是同步搜索,新消息只会排队。UI 侧用请求号丢弃过期结果。

### 请求

```js
{ type: 'ping' }                    // → { type:'pong', tag, engine, ... }
{ type: 'levels' }                  // → { type:'levels', tag, engine, default, levels }
{
  type: 'state',                    // → { type:'state', id, moves, flips, oppHasMoves,
  id,                               //     ownCount, oppCount, empties, over, reason, winner }
  own: [lo, hi],                    // 行棋方位板(编码同 think)
  opp: [lo, hi],
}
{
  type: 'think',
  id,                               // 请求号,原样回传
  own: [lo, hi],                    // 行棋方位板,两个 u32(lo = 第 1–4 行)
  opp: [lo, hi],                    // 对方位板
  level,                            // **本引擎**难度表的下标(见上;跨实现不可比)
  depth,                            // 可选:覆盖该档位的搜索深度上限(见下)
  seed,                             // 可选:随机种子(number,≤2^53;0/缺省 = 完全确定)。
                                    //   开局书容差选着(值好多占、近优保留)与根同分
                                    //   随机化都由它驱动 —— UI 应每局随机、同局复用
  empties,                          // 64 - 双方子数(state 回包里有,UI 透传即可)
}
```

### think 的 `depth`:可选覆盖

`depth` **只替换该档位的深度上限**,`end` / `budget` 仍取档位。缺省(不传 /
`null` / `NaN`)时行为与不带该字段完全一致,`depthMax` 回包反映**实际生效**的值。

它存在的理由是标定与跨实现对打:两边的难度表本来就不同(zig 默认档 d10、
main 默认档 d8),不把深度钉住就分不清"棋力差"来自实现还是来自参数。
`tools/match-branches.mjs` 的 `--depth` 就走这个字段(默认 6 层)。
UI 不需要它 —— UI 要的是"这一档的完整体验",不是一个孤立的深度。

### state:局面规则事实(合法性 / 翻子 / 数子 / 终局 / 胜者)

`state` 是 UI 渲染所需的**全部规则事实**的单一来源:

- `moves` / `flips`:行棋方全部合法落点(bit = row*8+col)与各自会翻转的对方子
  (与 moves 平行的数组)。
- `oppHasMoves`:对方是否有合法落点 —— 仅当前方 `moves` 为空且 `oppHasMoves` 为真
  时跳过回合;`over` 为真时终局。**跳过由调用方推得,worker 不维护回合状态**。
- `ownCount` / `oppCount` / `empties`:双方子数与空格数(empties 即 think 的参数,
  UI 透传即可,不必自己数子)。
- `over` / `reason` / `winner`:双方都无棋(`reason: 'no-moves'`)或满盘
  (`reason: 'full'`)即终局;`winner` 是**相对方**('own' / 'opp',null = 和棋,
  子多者胜),调用方按自己查询时的行棋方映射回黑/白。

worker 收到 `state` 不思考、不加载引擎。

两个分支都必须实现本消息且结果一致(同一局面的各字段逐项相等):
main(wasm 通道)当前是 worker 内的轻量 JS 位板遍历(wasm 暂无 legal 导出,等 zig 工具链
可用可下沉为 wasm 导出),legacy_js 分支用 engine.js 的 genLegal + 位计数。
`tools/probe-contract.mjs` 里有对拍用例。

位板编码:`bit = row * 8 + col`(`row 0` = 最上面一行),`lo` 是 bit 0..31、`hi` 是 32..63。
**u64 拆成两个 u32 是刻意的**:wasm 的 i64 到 JS 是 BigInt,边界上最容易写错
(i64 参数用普通 number 传会抛 TypeError,还不报在哪一行);拆开之后全是普通 number,
只有一处拼装可能出错。

`pong` 里 `tag` / `engine` 是契约字段;其余(`orbits` / `weightBytes` / `scale` 等)
是**引擎自报的实现元信息**,字段名与个数随实现不同,不进契约 —— 探针只把它们打印出来。

### 应答

```js
{
  id,          // 原样回传
  move,        // 0..63;−1 = 无合法着法(该跳过回合)
  score,       // 行棋方视角的估值
  depth,       // 这一手实际跑完的深度(0 = 贪心;完全求解时是求解深度)
  depthMax,    // 该档位标称深度(本引擎难度表里 level 那一项的 depth)
  exact,       // score 是否为**精确终局子差**
  nodes,       // 节点数
  book,        // 开局书命中(命中时 depth=0、nodes=0、score=书内精确值,行棋方
                //   视角);可选字段,无书实现恒为 false —— UI 靠它标「开局书」
                //   来源,别拿 depth=0 外推(书着与贪心在 depth 上同形)
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
node tools/probe-contract.mjs              # 契约冒烟(当前分支);--levels 缺省用引擎的 default
node tools/compare-branches.mjs            # 当前分支 vs 另一条分支,同一批局面并排看
```
