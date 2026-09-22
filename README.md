# AetherOthello

纯 JavaScript 黑白棋(Reversi / Othello)AI 引擎:零依赖、无 DOM、浏览器与 Node 通用。
从 [WebOS](<https://github.com/suulnnka/AetherWebOS>)(纯前端网页操作系统)的黑白棋应用中抽离而来,全部自研。

本分支(`main`)同时装着两套引擎 —— 分工与接口见下一节「两条分支」。

**在线体验:** 打开 <https://suulnnka.github.io/AetherWebOS/> 启动「黑白棋」应用。
(线上跑的就是 wasm 通道;`wasm/othello.wasm` 是入库产物,改引擎或权重后
本地重跑 `npm run build:wasm` 再提交。)

## 在线对弈页(GitHub Pages,免 CI)

本仓库自带一个**开箱即玩的对弈页**:布局与交互取自 WebOS 的黑白棋应用,
同一份 Worker 契约接的也是本仓库的引擎 —— wasm 通道(zig → othello.wasm)。**没有构建、没有 CI**:站点即仓库本身,GitHub Pages 原样引用仓库文件直接出页面:

**<https://suulnnka.github.io/AetherOthello/>**

页面即仓库布局:`index.html`(根)+ `pages/`(页面资产),引擎入口在 `src/`、
wasm 在 `wasm/`,全部按相对路径引用 —— 本地预览无需构建,仓库根起任意静态
服务器即可:

```bash
python3 -m http.server 8000     # 仓库根起服
# 打开 http://localhost:8000/
```

线上开启只需一次:仓库 **Settings → Pages → Build and deployment → Source 选
「Deploy from a branch」,Branch 选默认分支 + `/(root)`**;此后每次推送自动更新,
不走任何 Actions。

功能与 WebOS 应用一致:新对局 / 难度(引擎自报表)/ 人机或双人 / 换边 / 悔棋
(提示点标合法落点,残局自动完全求解并给出精确子差),底栏左侧行棋状态、右侧实时引擎搜索信息。


## 两条分支:一个接口,两份实现

- `main` —— 在 legacy_js 的基础上多一份 Zig 实现(`src/zig/*` → `wasm/othello.wasm`,
  原生 u64 位棋盘 + 38 张模式表评估);WebOS 黑白棋应用线上跑的是这套。
- `legacy_js` —— `src/engine.js`(纯 JS 位棋盘:PVS + 置换表 + 残局完全求解),作为
  **参照实现 / 历史版本**保留。

两边共用**同一份 Worker 契约**(`docs/WORKER-PROTOCOL.md`),所以上层(UI、浏览器探针、
对比脚本)换实现不用改代码 —— 这也是两手准备的意义:同一个局面,两条分支的结果可以
直接并排看。

**难度表不属于契约**:两套实现连搜索算法都不同,同一个 `depth`/`end`/`budget` 在两边
根本不是一回事,所以 `src/levels.js` **每个分支各一份、可以各自调**。UI 不 import 它,
而是发 `{type:'levels'}` 问引擎(回包里的 `default` 就是 UI 下拉的初值)——
于是「调难度」这件事只需改这个仓库。

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

- `docs/reversi-ai-optimization.md`:引擎优化全过程 —— 提前收尾、跳过空方向、
  残局奇偶排序、前沿子估值、置换表设计(Zobrist 跨色碰撞分析),每项都有
  对弈/节点数实测数据与验收方法(JS 参照实现时代的历史记述,文首有迁移说明)。
- `docs/engine-improvement-plan.md`:对标 Egaroucid web 的 11 项施工清单,
  已全部落地(附完成记录、对打验收与遗留清单)。
- `docs/endgame-mpc-study.md`:残局 MPC 专项研究(⑥b 已按草图实现,默认关)。
- `docs/WORKER-PROTOCOL.md`:Worker 消息契约(两条分支共用)。
- `book/README.md`:开局书数据资源 —— 局面/开局名/估值的来源、许可与再生成。

## Zig 通道(原生 u64 位棋盘 → wasm)

`main` 分支上另有一条完全独立的引擎通道:规则、评估、搜索全部用 Zig 重写,
编译成 `othello.wasm` 跑在浏览器 Worker 里。**两套实现互不依赖**:JS 那套留着当
参照实现(探针拿它跟 Zig 对拍),webos 的对弈路径走 Zig 那套。

- **位棋盘**:`own` / `opp` 各一个原生 `u64`(bit = row×8+col),方向掩码挡回绕;
  perft(1..8) = 4 / 12 / 56 / 244 / 1396 / 8200 / 55092 / 390216 是规则闸门
- **评估**:38 张模式表(8 行 + 8 列 + 11 条"/" + 11 条"\",每格恰被 4 张覆盖),
  用 16 元对称群 D4×C2 折叠 —— 133,974 槽/阶段 → **9,475 轨道**,其中 248 条
  被对称性强制作 0。权重是 **int8**,每相位一个 `scale` 存在 blob 头里;按子数
  **均分 60 手分 3 个相位**(24/44 分界)。二进制里只有 3×9,475 = 28,425
  字节权重 + 24 字节头
- **搜索**:PVS 负极大 + 迭代加深 + 置换表(中局/残局共表,`EXACT_SALT` 隔开)
  + 残局奇偶排序 + 残局完全求解;**难度按节点预算**而不是墙钟时间
- **训练**:`src/zig/train.zig` 自对弈 + 稀疏最小二乘(LSQR,共轭梯度已退役)。
  评估是线性的,所以不需要 9,475² 的正规矩阵,只需稀疏两趟扫描。
  另有**监督模式**(推荐):`--data=<Egaroucid Train Data>` 直接对
  2,551 万条「局面 + lv.17 终局子差」标注做最小二乘,163 秒完赛,棋力
  远超同等成本的自对弈(实测 A/B +11.3±1.3 子)。

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

## 致谢

当前权重书使用 **Egaroucid**(作者:Takuto Yamana)公开的训练数据训练:
[Training Data by Egaroucid 7.4.0 lv.17 & 7.5.1 lv.17](https://www.egaroucid.nyanyan.dev/en/technology/train-data/)
—— "I used Egaroucid's self-play data for training my Othello AI"。
该数据**禁止再分发**,因此不进本仓库;要复现训练请自行下载并放 `out/`,
解压后合并成单文件供 `--data` 使用:
`unzip Egaroucid_Train_Data.zip -d out/ && cat out/<数据目录>/*.txt > out/egaroucid_all.txt`。

## License

MIT
