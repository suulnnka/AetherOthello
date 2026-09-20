# 开局资源(局面 + 精确估值 + 开局名)

供 ⑩ 开局书升级用的**数据资源**。当前是独立文件,尚未嵌入 wasm;后续嵌入时
按体积预算裁剪(`--max-discs` 或只取带值子集)。

## 文件

| 文件 | 内容 |
|---|---|
| `positions.jsonl` | 1,112 个规范化局面(≤14 子且 \|值\| ≤ 4),每行一个 JSON |
| `openings.json` | 623 条命名开局目录(回放验证后),含命中书内标记 |
| `openings-catalog.json` | 上游开局名目录原样备份(Gatliff / HKOA / 日文定石集汇编) |

## positions.jsonl 字段

```json
{"board":"<64字符>","discs":8,"value":-2,"best":["d6","e7"],"names":["No-Cat"]}
```

- `board`:**规范化局面**(8 个棋盘对称中取字典序最小键),行优先
  `i = rank*8 + file`(a1 = 0),`X` = 当前行棋方,`O` = 对方,`-` = 空。
  **不做换色折叠**——估值是行棋方视角的。
- `value`:Egaroucid 网页版书的精确值 = 终局子差(negamax 口径,正值 = 行棋方赢)。
  初始局面 = 0(与"Othello 已解为和棋"一致,可作对拍锚点)。
  **值域精简**(2026-09-20 用户决策,参考 Egaroucid min-book 思想):
  \|值\| > 4 的局面不存(±4 本身保留)—— 胜负已定的边角开局没有保留价值,
  近均势带才是开局理论区。当前值域 -4~+4,共 1,112 局面。
- `best`:书内最佳着法(已换算到规范坐标系),约 58% 局面有(其余该书未标注)。
- `names`:挂上的开局名(可多个:序列目录的命名 + OCD 图案目录按局面挂名,
  分叉点上多开局共享一个局面属正常),84 个局面有名、63 个不同名字。

## openings.json 字段

`name` / `aliases` / `moves`(坐标序列,黑先)/ `family`
(perpendicular / diagonal / parallel,日式定石三分类)/ `valid`(回放合法)/
`in_book`(终局面是否落在 positions 里,215/404 命中)/ `note` /
`duplicate_of`(重复合并标记)。

**只用英文名**(2026-09-20 用户决策):主名是英文名用主名,否则取英文别名;
纯日文命名(无既定英文译名)的 219 条整条弃用,不自造译名;
产物(含来源字段)不含日文,原文只在 openings-catalog.json 备份里。
历史修正:オセロWiki「牛」`f5f6e6f4e7` 的 e7 回放非法,应正为 e3(= Gatliff
Cow),该条目因日文名+重复双双不再单独出现,修正记录留在目录备份。
注意:Cow 一族整体 `in_book=false` —— Egaroucid 的书树不含 Cow 线
(引擎不认可这条老定石),所以书内局面上见不到 Cow 的名字;开局名显示
(如 UI 需要时)应按 moves 序列回放匹配 `openings.json`,不依赖书内命中。

## 来源与许可(重要)

- **开局名(局面键,第三来源)**:Egaroucid `bin/resources/openings/english/`
  的 `openings.txt` + `openings_fork.txt`,即经典 OCD 社区目录
  (https://berg.earthlingz.de/ocd/data/openings2/openings.txt)。
  按 64 字符 0/1/. 盘面图案标注英文名;手工目录、1 的颜色取向行间不一致,
  生成器原样/换色双试、原样优先。局面键标注能覆盖"换序到达"的同局面,
  这是序列目录做不到的。外部路径,经 `--ocd-dir` 传入,文件本体不入库。
- **估值与最佳着法**:Egaroucid 网页版开局书(`bin/web_book/web_book.csv`,
  由其 `extract_web_book.py` 从 GPL-3.0 的 `book_const.hpp` 导出)。
  **GPL-3.0 数据**——嵌入分发前必须重新确认许可取舍
  (docs/engine-improvement-plan.md 红线 4;本目录入库是 2026-09-20 的
  用户决策,分发语义仍待定)。CSV 本体不入库。
- **开局名**:`openings-catalog.json` 是事实性汇编("researched index"),
  每条出处见其 `sources`:Robert Gatliff 目录(UltraBoardGames)、
  香港定石列表、GreenOthello、オセロWiki 定石、othlog 定石集。
  开局名与着法序列是事实数据,目录按来源保留出处 URL;
  `openings.json` 的 sources 只保留 ASCII 字段(日文站点的原版标题
  看备份)。

## Zig 侧嵌入(src/zig/book-openings.bin)

`make-book.mjs` 同流程会把保留集打包成引擎用的紧凑书(914 条 = 保留集中
带最佳着法的全部局面,含根/首手入口):

- **编码**:每条 = 初始局面起的 BFS 最短路径(着法 token,PASS=64)
  + 精确值 + 最佳着法集;路径按字典序排序后存「与上一条的共享前缀长 +
  后缀」(token 7893 → 947),**全部字节对齐**(gzip 按字节匹配,6 bit
  打包反而抬高熵;解码端也免去位读取器)。
- **实测**:raw 5,721 B / gzip 2,870 B(旧自对弈书 3,602/2,609,净增 ~0.3 KB gz)。
- **运行时**:engine.zig init 回放展开成「规范化局面 → {精确值, 最佳着法
  掩码}」表;局面按 8 对称规范化存取(同一局面的任意朝向都能命中,着法
  掩码随朝向换算);think 命中出书内最佳着法,engineScore 返回书值,
  engineBook() 供 UI 标注来源。**选着 = 值容差 + 加权随机**(BOOK_TOL=2,
  权重 2 的幂:值好多占、近优保留);子局面不在书内的着法不入池,池空回退
  标注掩码;rng=0 完全确定。|值|>4 的局面本来就不在保留集,自然回退搜索。

## 再生成

```sh
node tools/make-book.mjs <Egaroucid>/bin/web_book/web_book.csv --max-discs 14   --max-abs-value 4 --ocd-dir <Egaroucid>/bin/resources/openings/english
```

`--max-discs` 控制深度(书里 ≤12 子 = 911 局面,≤14 子 = 2,718,
全量 28 子 = 52,850)。规范化键稳定,重跑输出应逐位一致(输入不变时)。
