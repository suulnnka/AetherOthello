# 引擎改进计划(2026-09 · 对标 Egaroucid web)

> 来源:与 Egaroucid web 版(本地只读参考副本 `C:\Users\thhid\fun\Egaroucid\src\web`,
> GPL-3.0 —— **只学思想不抄代码行,书与数据绝不搬运**)的逐文件对比,结论:
> 差距不在评估(权重已用 Egaroucid lv.17 数据监督拟合),而在**搜索的每节点成本
> 与剪枝手段**。本文是施工清单:11 项改动 + ID 阶梯重构,分三批落地。
> 每项独立提交;完成后在本文件勾选并附提交号。

## 体积预算基线(2026-09 实测,动任何一项前先读这节)

闸门:webos `tools/check-size.mjs` —— **gzip(wasm) + gzip(worker 胶水 chunk) ≤ 35 KB**。

| 组件 | raw | gzip | 备注 |
|---|---|---|---|
| othello.wasm | 52,690 B | 28,427 B | 其中权重书 28,449 B,gzip 后仍占 19,090 B(高熵,压不动) |
| 胶水 chunk | 3,090 B | 1,554 B | worker.js + levels.js 打包 minified |
| **合计** | | **29,981 / 35,840 B** | **余量 ≈ 5.7 KB** |

汇率(实测:wasm 权重段清零对照重压):

- **代码/rodata ≈ 2.6:1** —— +1 KB 编译产物 ≈ +380 B 预算;
- **BSS 运行时生成表 = 0 文件成本** —— 先例:TT 8 MB、`pattern.orbit/sigma`;
- **高熵数据(权重/Zobrist 常数/书)≈ 1:1** —— 预算里最贵的货币。

### 红线

1. **大表禁止 comptime**。稳定子边表(1 MB)、last-flip 表(2×512 KB)必须照
   `orbit/sigma` 先例在 `init()` 生成;顺手 comptime 会把 wasm 撑爆 1.5 MB+。
2. **不做 Egaroucid 的 `irp()` 反色特征表**(物化 78 KB)。pass 罕见,过手后
   全量重算 38 个槽号即可。
3. **开局书只做成"着法主线"**(6 bit/手打包,运行时回放展开);禁存裸局面
   (300 局面 × 18 B,gzip 后 +2.5~3.5 KB,不可接受)。
4. **书必须自生成**(宗师档自对弈);Egaroucid 的书与训练数据禁止再分发,
   GPL 与数据许可是两道独立的墙。
5. 新增可变状态一律 `threadlocal`(延续 `search.zig:44` 的训练器多线程纪律)。
6. 每项提交前:`npm run build:wasm`(wasm 入库,打印 raw/gzip/brotli 三数)
   + webos 侧 `node tools/check-size.mjs` 过闸。

### 步骤 0:先记基线(开工前跑一次,数字填回这里)

- [ ] `node bench/bench.mjs endnodes` 固定种子节点数:____(T1 各项的对照基准)
- [ ] `node bench/bench.mjs nps` / `micro`:____
- [ ] 三体积数(raw/gzip/brotli):____

---

## 批次一:残局链路(预期宗师 16 空求解 2~4× 提速;净体积 ≈ −0.1~+0.5 KB)

同改 `search.zig` 的 exact 分支,按依赖排序:**③ → ① → ② → ⑧ → ⑨**。
全部落地后 `endnodes` 总削减 ≥60% 算批次达标。

### ③ TT 改存双位板直比(先做:⑧ 的表设计依赖新布局)

- 现状:`search.zig:150` 的 `hashOf` 对双方全部棋子逐位 Zobrst,残局求解
  **每个内部节点**付一次约数百位运算;`ZA/ZB` 是 1 KB 高熵 rodata。
- 做法:TT 槽存 `own/opp` 两个 u64 + score/move/depth/flag,哈希只用
  `(own*C1 ^ opp*C2 ^ salt) & mask` 定槽,命中靠 16 字节全比对 —— 零伪命中,
  `EXACT_SALT` 语义隔离改成每条目一个 flag 位。条目 16→24 B,TT 8→12 MB(纯内存)。
- 参考:`transpose_table.hpp:57-67,138-155`;替换强度 `data_strength = mpct + 4·depth`(`:26-29`)。
- 体积:**−0.9~−1.1 KB(净省,预算回收大户)**
- 验收:`probe-exact` / `npm test` 全绿 + `endnodes` 下降 + `match-branches` 不少于基线。

### ① 稳定子剪枝(stability cut)

- 做法:8 条边按 `stability_edge_arr[256][256][2]`(u64,init 生成,~1 MB BSS,
  启动 +20~50 ms)查稳定子;内部格用已满线归纳(h/v/d7/d9 位运算)迭代闭包;
  `n_alpha = 2·己方稳定子−64`、`n_beta = 64−2·对方稳定子` 收紧窗口,配按空数
  门槛表(仅 alpha 足够高才算)。
- 参考:`stability.hpp:56-80`(边表 init)、`161-204`(calc_stability)、
  `207-222`(cut);门槛表 `search.hpp:44-53`;full_stability 位技巧 `:82-115`。
- 体积:+0.3~0.5 KB(纯代码)
- 预期:残局节点 −20~40%(edax 同源技术)
- 验收:`probe-exact` 逐局面相等 + `endnodes` 下降。

### ② last1~4 专用函数 + ≤7 空快速路径

- 做法:最后 1 空用 `count_last_flip`(方向化翻子计数表,init 生成,512 KB×2 BSS)
  直接算终局分;last2~4 用辐射掩码跳过必不合法空格 + 奇偶换位排序;
  ≤7 空(`END_FAST_DEPTH` 同款)走无 TT、无排序的快速循环。
- 参考:`endsearch.hpp:26-300`(last1~4 与 `nega_alpha_end_fast`)、
  `last_flip.hpp:63-92`(count_last_flip;表声明在 `flip.hpp:17-18`,运行时生成)。
- 体积:+0.5~1 KB(代码 + `bit_radiation` 等 ~0.3 KB rodata)
- 预期:尾部子树 1.5~2×,16 空总求解 ~1.3~1.6×
- 验收:同 ①;另 `npm test` 的完全求解对拍必须全绿。

### ⑧ 预搜着法跨盐复用

- 现状:残局前置中层搜索(`search.zig:477`)写不带盐的 TT,求解器一个条目
  都读不到,只有根 `order[]` 传了过去。
- 做法:加一张无盐"着法提示"小表(2^16 × 17 B ≈ 1.1 MB BSS,存 own/opp/move),
  预搜与求解器都读写它;界值仍只信同盐主表。
- 体积:+0.1~0.15 KB
- 验收:`endnodes` 继续下降;`probe-exact` 相等。

### ⑨ 终局预搜索加深(常量改动)

- `PRE_ENDGAME_DEPTH` 6 → **⌈E/2⌉**(2 步长爬升):16 空解算几百万节点,
  一个 8 深中局预跑只占 ~1%,换根排序 + ⑧ 的 TT 着法命中,纯赚。
- 体积:0。验收:`endnodes` 下降。

## 批次二:中局链路(≈ +0.65~1.35 KB;目标中局 NPS ~2× + 同预算有效深度 +2~4 层)

顺序:**④ → ⑤ → ID 阶梯 → ⑥**。

### ④ 增量评估(最大 NPS 杠杆)

- 现状:每个叶子 `pattern.zig:388` 全量重算 38 张表 base-3 下标(约 256 次位探测)。
- 做法:搜索路径每 ply 维护 38×u32 槽号数组(72 ply ≈ 11 KB BSS),落子只改
  受影响表 —— per-cell → (表号, 位序) 映射从现有 comptime `model` 在 init 派生
  (0 rodata);过手(pass)全量重算。叶子求值退化为 38 次查表求和(复用 `evalSlots`)。
- 参考:`evaluate.hpp:212-277`(coord_to_feature 预表)、`479-523`(eval_move/undo)。
  ⚠ 不抄 `irp` 反色表(红线 2)。
- 体积:+0.2~0.4 KB。预期:叶子求值 2~4×,中局 NPS ~2×。
- 验收:**`probe-eval` 必须逐位不变**(增量路径与全量路径同槽同和);
  `bench micro` 的 evaluate 项提速;`bench moves` 逐着一致。

### ⑤ 着法排序补项

- 现状:只有 `W64O + 翻子数`(`search.zig:244`)。
- 做法:落子后**对方行动力**(角上着法加权)、双方**潜在行动力**(邻空位
  位运算)进排序分;深层节点可选"落子后一层估值"项(等效 Egaroucid 在我们
  深度下的 `eval_depth = depth>>3` 档位)。
- 参考:`move_ordering.hpp:63-92`(openness/corner/potential)、`94-128`、`169-187`。
- 体积:+0.1~0.25 KB。
- 验收:**MPC 未进之前 `bench moves` 必须逐着一致**(排序不得改变定深结果);
  `match-branches` 同预算对打新旧。

### ⑤b ID 阶梯重构(随 ⑤ 落地)

- 中局(大师/宗师):2,4,…,d 全跑 → **{d−4, d−2, d}**(by-2 阶梯的早期轮次
  纯为排序服务,⑤ 之后不值 10~20% 的开销);小预算档保持全阶梯。
- 终局预搜索:固定 6 → 已由 ⑨ 处理(⌈E/2⌉)。
- 根 `order[]` 按上轮 `root_v` 重排**保留**(`search.zig:421`,零成本、仍是
  最强根排序信号;Egaroucid 同样把 best_move 往下一段传,`ai.hpp:63,72`)。
- ⚠ 迭代加深本身不可去:它是节点预算的执行机制(超预算返回上一完整深度,
  半途 root_v 有偏,`search.zig:441` 注释)。
- 体积:0。预期:大师/宗师总节点 −5~15%。
- 验收:`match-branches` 同预算对打;`bench moves` 一致(定深结果不变)。

### ⑥ MPC(Multi-ProbCut)

- 做法:σ(误差)模型 + 浅层验证窗口剪枝。⚠ Egaroucid 的 σ 系数
  (`probcut.hpp:21-58`,三次多项式)是对它自家评估调的,**必须自拟合**:
  原生侧工具(train.zig / tools)采样局面跑 d 与 d+k 两档搜索,按(子数,深度)
  分桶最小二乘 —— 拟合工具不进 wasm。难度表(levels.js)加 mpct 字段。
- 参考:`probcut.hpp:65-139`(mpc);档位思想 `level.hpp:22-27`(MPC_81/95/98/99);
  预段用更紧 mpct≈0.7 的做法 `ai.hpp:83-84`。
- 体积:+0.35~0.6 KB(wasm,σ 常量仅 112 B)+ ~0.1 KB(levels.js)。
- 预期:同预算有效深度 +2~4 层;落地后大师/宗师预算重标定(见"范围外")。
- 验收:`match-branches` 200 局 A/B(⑥ 之后 `bench moves` **允许**改变,
  棋力以对打论);`endnodes`/`nps` 回归不劣化。

## 批次三:收尾(≈ +0.55~0.95 KB)

### ⑦ TT 留深替换

- 碰撞时新深度 ≥ 旧深度才覆盖(现在无条件覆盖,`search.zig:322`)。
  体积 ±0。验收:`match-branches` 不劣化。

### ⑪ 根同分随机化(在 ⑩ 前:先定机制,书才有多样性可用)

- 根节点同分着法集合内做可种子化随机(xorshift);worker 协议加可选 `seed`
  字段,**缺省 0 = 完全确定**(探针 / e2e / 对打脚本的确定性不能破)。
  体积:+0.05 KB。验收:seed=0 时全部既有测试逐位不变。

### ⑩ 迷你开局书(自生成)

- 做法:宗师档自对弈(现有 duel/bench 基建)生成 40~60 条主线 × 12 手,
  6 bit/手打包(≈0.5 KB raw),运行时回放展开成局面 → 值表;按"值 ≥ 最优−容差"
  随机取用(带 ⑪ 的种子)。同分局面 4 对称注册去重。
- 参考(思想):`book.hpp:98-132`(get_random 容差)、`153-195`(对称注册)。
  ⚠ 数据红线 4。
- 体积:+0.4~0.7 KB。
- 验收:`match-branches` 棋力不掉;开局阶段着法多样性肉眼可见;`check-size` 过闸。

---

## 范围外(明确不做 / 留待再议)

- **新增 18~20 空档位**(原第 12 项):未批准。批次一落地后用 `endnodes` 实测
  数据再议 —— 若 18 空进入宗师预算,届时单独提案(levels 表 + UI 下拉)。
- **预算重标定**:全部落地后按 `match-branches` 实测再调,不与功能混在一个提交。
- **多线程**(SharedArrayBuffer 门槛)、**10 相位评估**(自家 A/B 已证无增益,
  3 档定格)、**墙钟时间难度**(节点预算是刻意设计:设备无关、可复现)。

## 验收工具箱速查

| 目的 | 命令 |
|---|---|
| 规则/折叠单测 | `zig build test` / `zig build selftest` |
| wasm 冒烟 | `node tools/probe-wasm.mjs` |
| 求值逐位对拍(④ 的硬闸) | `node tools/probe-eval.mjs` |
| 残局精确解对拍 | `node tools/probe-exact.mjs` |
| 引擎行为回归 | `npm test` |
| 节点数(固定种子) | `node bench/bench.mjs endnodes` |
| 定深着法回归(⑤ 前的硬闸) | `node bench/bench.mjs moves` |
| 速度 | `node bench/bench.mjs nps` / `micro` |
| 棋力 A/B | `node tools/match-branches.mjs`(200 局起) |
| 体积三数 + 入库 | `npm run build:wasm` |
| 闸门 | webos 侧 `node tools/check-size.mjs` |
