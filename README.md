# AetherOthello

黑白棋(Reversi / Othello)AI 引擎。线上跑的是 **Zig 写的 u64 位棋盘引擎**,
编译成 `othello.wasm` 在浏览器 Worker 里运行;`src/engine.js` 是纯 JS 参照实现,
留作探针对拍与 bench 的基准。零依赖、无 DOM、浏览器与 Node 通用。

从 [WebOS](<https://github.com/suulnnka/AetherWebOS>)(纯前端网页操作系统)的
黑白棋应用中抽离而来。引擎代码全部自研;权重与开局书用了公开数据与第三方
中间产物,来源与取舍见文末「致谢」和 `book/README.md`。

**在线体验:** 打开 <https://suulnnka.github.io/AetherWebOS/> 启动「黑白棋」应用
(线上跑的就是 wasm 通道)。

## 在线对弈页(GitHub Pages)

本仓库自带一个**开箱即玩的对弈页**:<https://suulnnka.github.io/AetherOthello/>,
布局与交互取自 WebOS 的黑白棋应用,接的也是本仓库的引擎(wasm 通道)。
站点即仓库本身(`index.html` + `pages/` + `src/` + `wasm/` 全按相对路径引用,
Pages 原样出文件),本地预览无需构建,仓库根起任意静态服务器即可:

```bash
python3 -m http.server 8000     # 仓库根起服,打开 http://localhost:8000/
```

功能与 WebOS 应用一致:新对局 / 难度(引擎自报表)/ 人机或双人 / 换边 / 悔棋;
提示点标合法落点,高难度档残局自动完全求解并给出精确子差;开局书命中时
秒回,底栏标注「开局库 · 名字 · 估值」。布局:底栏左侧行棋状态、右侧实时
引擎搜索信息。


## 分支

- `main`(本分支)—— 线上引擎:Zig → `othello.wasm`。
- `legacy_js` —— 纯 JS 通道的历史版本,已冻结(JS 版本淘汰中,仅存档)。
- `rust` —— **Rust 重写试验**:`rust/` 把 zig 通道逐句移植成 Rust(cargo →
  wasm32),导出面与 zig 同名同签名、`src/worker.js` 零改动,`weights.bin` /
  `book-openings.bin` 原样复用(训练器不搬);搜索树与 zig 逐节点一致。
  **rust/zig 性能对比**(bench-wasm 同条件背靠背重测,只看 >20ms 长样本):
  **Rust 快约 10~23%**(机器 run-to-run 噪声可达 ±25%,毫秒级短样本不可信)。
  两边共用同一个 LLVM 后端(zig 0.16 的 wasm32 默认即 LLVM,`-fllvm` 与默认
  构建逐字节相同),差异来自前端 IR 细节 —— wat 级差异定位见该分支
  `docs/wasm-wat-diff.md`(popcnt 两边都是原生指令,不是差异来源)。
  体积代价:gzip 44.2KB(zig 38.5,体积闸门内)。构建:`node tools/build-rust.mjs`。

## Zig 通道(线上引擎:原生 u64 位棋盘 → wasm)

线上对弈路径跑的这套:规则、评估、搜索、开局书全部用 Zig 写,编译成
`othello.wasm` 跑在浏览器 Worker 里。与 JS 参照实现互不依赖 —— 探针拿两边
逐位对拍,对弈路径只用这套。

- **位棋盘**:`own` / `opp` 各一个原生 `u64`(bit = row×8+col),方向掩码挡回绕;
  perft(1..8) = 4 / 12 / 56 / 244 / 1396 / 8200 / 55092 / 390216 是规则闸门
- **评估**:38 张模式表(8 行 + 8 列 + 11 条"/" + 11 条"\",每格恰被 4 张覆盖),
  用 16 元对称群 D4×C2 折叠 —— 133,974 槽/阶段 → **9,475 轨道**,其中 248 条
  被对称性强制作 0。权重是 **int8**,每相位一个 `scale` 存在 blob 头里;按子数
  **均分 60 手分 3 个相位**(24/44 分界)。二进制里只有 3×9,475 = 28,425
  字节权重 + 24 字节头
- **开局书**:Egaroucid 精确书裁剪(≤14 子、|值|≤4,914 条)经 `@embedFile` 嵌入。
  局面与开局名是公开数据收集,估值借自其开局书省时间 —— 自家求解同样能算出
  (来源与许可见 `book/README.md`)。命中 0 节点秒回,值容差加权随机保持
  开局多样性,UI 标注「开局库 · 名字 · 估值」
- **搜索**:PVS 负极大 + 迭代加深 + 置换表(中局/残局共表,`EXACT_SALT` 隔开)
  + 残局奇偶排序 + 残局完全求解 + 中局 MPC(大师及以上档启用);**难度按节点
  预算**而不是墙钟时间
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
node tools/probe-contract.mjs    # Worker 消息层冒烟(levels/ping/state/think 全链路)
node tools/probe-eval.mjs        # 中局求值:JS 独立重算槽号与整数加权和,逐位对拍
node tools/probe-exact.mjs       # 残局精确解:与 JS 参照实现逐局面相等
```

⚠ `wasm/othello.wasm` 是**入库**的:webos 构建直接从源码树里 import 它
(`src/worker.js` 的 `new URL('../wasm/othello.wasm', import.meta.url)`),
`zig-out/` 是 gitignore 的中间产物,不能当交付路径。**改了权重或引擎代码就必须重跑
`npm run build:wasm` 并提交** —— 它会顺带核对 wasm 里的权重书头部与
`src/zig/weights.bin` 是否一致,忘记重建的那次会被它拦住。

## 文档

- `docs/reversi-ai-optimization.md`:引擎优化全过程 —— 提前收尾、跳过空方向、
  残局奇偶排序、前沿子估值、置换表设计(Zobrist 跨色碰撞分析),每项都有
  对弈/节点数实测数据与验收方法(JS 参照实现时代的历史记述,文首有迁移说明)。
- `docs/engine-improvement-plan.md`:对标 Egaroucid web 的 11 项施工清单,
  已全部落地(附完成记录、对打验收、遗留清单与**验收工具箱命令速查** ——
  全部测试/基准/探针命令以那张表为准)。
- `docs/endgame-mpc-study.md`:残局 MPC 专项研究(⑥b 已按草图实现,默认关)。
- `docs/WORKER-PROTOCOL.md`:Worker 消息接口(请求/应答字段与语义)。
- `book/README.md`:开局书数据资源 —— 局面/开局名/估值的来源、许可与再生成。

## 致谢

- **权重训练数据**:当前权重书使用 **Egaroucid**(作者:Takuto Yamana)公开的
  训练数据训练:
  [Training Data by Egaroucid 7.4.0 lv.17 & 7.5.1 lv.17](https://www.egaroucid.nyanyan.dev/en/technology/train-data/)
  —— "I used Egaroucid's self-play data for training my Othello AI"。
  该数据**禁止再分发**,因此不进本仓库;要复现训练请自行下载并放 `out/`,
  解压后合并成单文件供 `--data` 使用:
  `unzip Egaroucid_Train_Data.zip -d out/ && cat out/<数据目录>/*.txt > out/egaroucid_all.txt`。
- **开局书估值**:开局库的**局面与开局名均为公开数据收集**(公开定石树 +
  社区目录);唯一取自 Egaroucid 开局书的是估值与最佳着法 —— 那是可自算的
  搜索结果(本引擎的残局完全求解跑一遍同样能得出),取现成纯粹为了省时间,
  不是不可替代的数据依赖。上游文件为 GPL-3.0,本体不入库、不再分发;
  明细与自算备案见 `book/README.md`。

## License

MIT
