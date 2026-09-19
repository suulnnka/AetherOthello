# AetherOthello

纯 JavaScript 黑白棋(Reversi / Othello)AI 引擎:零依赖、无 DOM、浏览器与 Node 通用。
从 [WebOS](<https://github.com/suulnnka/AetherWebOS>)(纯前端网页操作系统)的黑白棋应用中抽离而来,全部自研。

**在线体验:** 打开 <https://suulnnka.github.io/AetherWebOS/> 启动「黑白棋」应用 —— 那里面跑的就是本引擎
(默认高级档:8 层迭代加深 + 残局完全求解,窗口信息行实时显示搜索过程)。

## 两条分支:一个接口,两份实现

- `main` —— `src/engine.js`(纯 JS 位棋盘:PVS + 置换表 + 残局完全求解),作为
  **参照实现 / 历史版本**保留。
- `zig` —— 在它的基础上多一份 Zig 实现(`src/zig/*` → `wasm/othello.wasm`,原生
  u64 位棋盘 + 38 张模式表评估);WebOS 黑白棋应用线上跑的是这套。

两边共用**同一份 Worker 契约**(`docs/WORKER-PROTOCOL.md`),所以上层(UI、浏览器探针、
对比脚本)换实现不用改代码 —— 这也是两手准备的意义:同一个局面,两条分支的结果可以
直接并排看。

**难度表不属于契约**:两套实现连搜索算法都不同,同一个 `depth`/`end`/`budget` 在两边
根本不是一回事,所以 `src/levels.js` **每个分支各一份、可以各自调**(本分支三档,
`zig` 分支四档)。UI 不 import 它,而是发 `{type:'levels'}` 问引擎(回包里的 `default`
就是 UI 下拉的初值)—— 于是「调难度」这件事只需改这个仓库。

```bash
node tools/probe-contract.mjs     # 契约冒烟(当前分支):脚本自己向引擎要难度表再核对
node tools/compare-branches.mjs   # 当前分支 vs 另一条分支,先打两边的表再并排跑单步
node tools/match-branches.mjs     # 让两条分支**互相下整局** —— 棋力只有对打能回答
```

四个共享文件 —— `docs/WORKER-PROTOCOL.md`、`tools/probe-contract.mjs`、
`tools/compare-branches.mjs`、`tools/match-branches.mjs` —— **必须逐字节一致**
(要改就两边一起改)。`compare-branches.mjs` 开头会先核对这一点,不一致直接判负。

`match-branches.mjs` 用配对开局(同一局面下两盘、交换执子方)消除先手优势,
`--levels A:B` 分别指定两边档位(缺省用各自自报的 `default`)。**参数不同的档位
之间对打只能回答"开箱谁强",不能当纯实现对比** —— 脚本会把两边的参数并排列出来。

## 引擎

`src/engine.js` 单文件,位棋盘(bitboard)实现:每色用低/高两个 32 位字表示 64 格,
移位 + 列掩码生成合法步掩码与翻子掩码(每方向"穿越填充",邻格非对方子则零展开)。

- **难度三档**
  - 初级:贪心选点(位置权重 + 翻子数),不搜索
  - 中级:PVS 迭代加深至 4 层,残局 ≤8 空完全求解
  - 高级:PVS 迭代加深至 8 层,残局 ≤14 空完全求解(求解前先跑 2→4→6 中层搜索确定根排序)
- **搜索**:PVS 负极大 + 置换表(中局 2^16 / 残局 2^20 槽,Zobrist 双 32 位校验)
  + 残局奇偶排序(奇数大小空格连通区域优先,13~15 空完全求解节点数 -36%~-48%)
- **评估**:位置权重表 + 行动力差 ×8 + 前沿子(潜在行动力)×3
- 性能:约 **110~150 万节点/s**(2026 年的桌面 Chrome/V8)

## 用法

```js
import { think, LEVELS } from './src/engine.js';

// board:8×8 二维数组,'b'/'w'/null;异步思考,带进度回调
const res = await think(board, 'w', LEVELS[2], (info, done) => {
  console.log(info.depth, info.move, info.score, info.nodes, info.ms);
}, () => false);
// res = { move: 平铺格号, score, depth, nodes, ms, endgame?, empties? }
```

完全求解(高级档残局)返回的是**精确终局点差**(±100/子),不是启发式分。

## 测试与基准

```bash
npm test                        # 位棋盘规则模糊测试 + 完全求解对拍 + 难度行为,与独立 2D 朴素实现对拍
node test/engine-test.mjs 1 1b  # 只跑指定节(--list 查看全部)

node bench/bench.mjs nps        # 各阶段局面的节点速度
node bench/bench.mjs endnodes   # 残局完全求解节点数(固定种子,可复现,优化前后对比用)
node bench/bench.mjs micro      # 位棋盘原语微基准(hashPos/genMoves/fillE/popcnt/evaluate/moveFlips)
node bench/bench.mjs moves      # 语义回归:固定深度下的最佳着法与分数

# 双引擎对弈台:两个版本互打,统计胜负(引擎以 serve 模式常驻子进程)
node bench/duel.mjs bench/bench.mjs <你的版本>.mjs 200 5 4
```

注:`stats` / `idstats` 两个旧模式未随迁移保留 —— 它们依赖一份早已不存在的带插桩引擎快照,
迁移前就已无法运行;历史数据见 `docs/`。

## 文档

`docs/reversi-ai-optimization.md`:引擎优化全过程 —— 提前收尾、跳过空方向、残局奇偶排序、
前沿子估值、置换表设计(Zobrist 跨色碰撞分析),每项都有对弈/节点数实测数据与验收方法。

## License

MIT
