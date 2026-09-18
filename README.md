# AetherOthello

纯 JavaScript 黑白棋(Reversi / Othello)AI 引擎:零依赖、无 DOM、浏览器与 Node 通用。
从 [WebOS](<https://github.com/suulnnka/AetherWebOS>)(纯前端网页操作系统)的黑白棋应用中抽离而来,全部自研。

本分支(`zig`)同时装着两套引擎:下面「引擎」一节讲的 JS 实现,和一份用 Zig 重写的
原生 u64 位棋盘实现(编译成 wasm,见「Zig 通道」一节)。webos 应用的对弈路径走后者。

**在线体验:** 打开 <https://suulnnka.github.io/AetherWebOS/> 启动「黑白棋」应用。
(线上跑的是 JS 通道;Zig/wasm 通道先在本地 `npm run build:wasm` 构建再进 webos 构建。)

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

## Zig 通道(原生 u64 位棋盘 → wasm)

`zig` 分支上另有一条完全独立的引擎通道:规则、评估、搜索全部用 Zig 重写,
编译成 `othello.wasm` 跑在浏览器 Worker 里。**两套实现互不依赖**:JS 那套留着当
参照实现(探针拿它跟 Zig 对拍),webos 的对弈路径走 Zig 那套。

- **位棋盘**:`own` / `opp` 各一个原生 `u64`(bit = row×8+col),方向掩码挡回绕;
  perft(1..8) = 4 / 12 / 56 / 244 / 1396 / 8200 / 55092 / 390216 是规则闸门
- **评估**:38 张模式表(8 行 + 8 列 + 11 条"/" + 11 条"\",每格恰被 4 张覆盖),
  用 16 元对称群 D4×C2 折叠 —— 133,974 槽/阶段 → **9,475 轨道**,其中 248 条
  被对称性强制作 0。权重是 **int8**,全局 `scale` 存在 blob 头里;相位按子数
  34 分界。二进制里只有 2×9,475 = 18,950 字节权重 + 16 字节头
- **搜索**:PVS 负极大 + 迭代加深 + 置换表(中局/残局共表,`EXACT_SALT` 隔开)
  + 残局奇偶排序 + 残局完全求解;**难度按节点预算**而不是墙钟时间
- **训练**:`src/zig/train.zig` 自对弈 + 稀疏最小二乘(共轭梯度,全程 f64)。
  评估是线性的,所以不需要 9,475² 的正规矩阵,只需稀疏两趟扫描

```bash
npm run build:wasm               # zig build → wasm/othello.wasm(入库产物)+ 自动验证
zig build test                   # 规则与折叠的单元测试
zig build selftest               # perft / 折叠 / 求值基准(原生 exe)
zig build train -- --games=500 --iters=4   # 自对弈训练并覆盖 src/zig/weights.bin
node tools/probe-wasm.mjs        # wasm 导出层冒烟(Node 里直接实例化)
node tools/probe-eval.mjs        # 中局求值:JS 独立重算槽号与整数加权和,逐位对拍
node tools/probe-exact.mjs       # 残局精确解:与 JS 参照实现逐局面相等
```

⚠ `wasm/othello.wasm` 是**入库**的:webos 构建直接从源码树里 import 它
(`src/worker.js` 的 `new URL('../wasm/othello.wasm', import.meta.url)`),
`zig-out/` 是 gitignore 的中间产物,不能当交付路径。**改了权重或引擎代码就必须重跑
`npm run build:wasm` 并提交** —— 它会顺带核对 wasm 里的权重书头部与
`src/zig/weights.bin` 是否一致,忘记重建的那次会被它拦住。

## License

MIT
