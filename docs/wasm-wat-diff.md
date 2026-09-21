# zig wasm vs rust wasm:转成 wat 后的差异定位

产物:

| | 文件 | raw | code 段 | data 段 | 函数数 |
|---|---|---|---|---|---|
| zig | `zig-out/bin/othello.wasm` | 81,516 B | 40,966 B | 39,927 B | 41 |
| rust | `rust/target/wasm32-unknown-unknown/release/othello_engine.wasm` | 118,869 B | 70,741 B | 47,501 B | 44 |

反汇编用 `node tools/watdiff.mjs`(wat 落到 `out/zig.wat` / `out/rust.wat`,20,133 / 34,381 行;
`--cg` 看调用图、`--dump zig 21` 看函数体、`--call zig 21 21` 看递归实参怎么备好)。
wabt 是额外依赖(引擎跑起来不需要它):`npm i wabt`,或用 `WABT_PATH` 指向别处的安装。
两边导出面完全一致(23 个 `engine*` 同名导出),所以这是同一份语义的两种 lowering。

## 1. 调用约定:这是最硬的一条

同一个 PVS 函数(两边 Zobrist 混合常量逐位相同,可以确认是同一段逻辑):

zig `#21`
```wat
(func (;21;) (type 12) (param i32 i32 f32 f32 i32 i32) (result f32)
  (local i32 i64 i64 i64 i64 i64 i64 i64 i32 i64 i64 i32 ... )   ;; 36 个 local
  local.get 0
  i64.load offset=8      ;; ← opp 从参数指针读
  local.tee 10
  i64.const -4417276706812531889
  i64.mul
  local.get 0
  i64.load               ;; ← own 从参数指针读
  local.tee 11
  ...
  local.get 1            ;; 递归:第一个实参仍是 i32(栈地址)
  local.get 3
  f32.neg
  ...
  call 21
```

rust `#7`
```wat
(func (;7;) (type 7) (param i64 i64 i32 f32 f32 i32 i32) (result f32)
  (local i32 i64 ... )                                           ;; 39 个 local
  local.get 1            ;; ← opp 直接是 i64 参数
  i64.const -4417276706812531889
  i64.mul
  local.get 0            ;; ← own 直接是 i64 参数
  i64.const -7046029254386353131
  i64.mul
  ...
  local.get 0            ;; 递归:两个 i64 直接传下去
  local.get 22
  local.get 4
  f32.neg
  ...
  call 7
```

源码两侧签名一模一样(`fn search(b: Board, depth, alpha, beta, ply, exact) f32`,
`Board = {own: u64, opp: u64}`)。差别全在前端 ABI:

- **zig**:16 字节的 `Board` 按值传参时走 byval 指针(wasm 里就是一个 `i32`),
  调用方把 own/opp 写进栈、被调用方再 `i64.load` 出来。
- **rust**:LLVM 把 16 字节 struct **scalarize** 成两个 `i64` 参数,值传递。

后果(每节点必付):
1. 每次调用多一对 store/load;
2. 函数内 own/opp 每次读都要访存 —— 它们是指针背后的内存,LLVM 无法把它们
   留在寄存器里(aliasing 未知),所以整个 search 里 `b.own/b.opp` 的每次出现都是一次 load。

## 2. 热路径的访存量(同一个 search 函数体)

| | ops | i64.load | i64.store | i32.load(含 8/16 位变体) | i32.store | 其中 load8_u | local.get |
|---|---|---|---|---|---|---|---|
| zig #21 | 2074 | 32 | 17 | 77 | 50 | 48 | 531 |
| rust #7 | 3105 | 34 | 16 | 58 | 24 | 15 | 814 |

访存合计 **176(zig) vs 132(rust)** —— rust 少 25%(注意 `load8_u` 是 `i32.load` 的
子集,wat 里写作 `i32.load8_u`,统计时别把它加两遍)。rust 的静态指令反而多 50%,
多出来的全是 local/寄存器操作。
zig 的 `load8_u` 有 30 次是栈帧内 offset=1..7 这类字节读 —— 根因是 zig 侧用
`ply_moves: [MAX_PLY][MAX_MOVES]u6`(`search.zig:140`)存着法,`u6` 在 LLVM 里落成一个字节,
每次读写都是 `load8_u`/`store8`;rust 侧是 `[u32; MAX_MOVES]`(`search.rs:107`),4 字节对齐访问。

## 3. 展开策略:`inline for` 的代价

`pattern.zig` 的 `slotIndices` 用了 `inline for`(38 表 × 8 格全展开),rust 侧是普通 `for`
交给 LLVM 决定。结果:

| | 指令 | local | select | br_if | i64.and | shl/shr |
|---|---|---|---|---|---|---|
| zig #20(展开版) | 4948 | 85 | 283 | 188 | 268 | 0/0 |
| rust #12(展开版) | 1890 | 7 | 20 | 100 | 188 | 65/54 |
| rust #6(循环版) | 140 | 9 | — | — | — | — |

zig 的形态是"逐格 `and` 掩码 + `eqz` + `select` 链"(一条 8 格线要 8 次判断,38 条线
全直铺),中间值全塞进 85 个 wasm local;rust 的形态是"掩码 + 移位 + or 聚集",
一次算多位,只留 7 个 local。

注意:这个函数只被 `engineThink` / 根搜索 / `engineEval` 调用,**不在搜索内循环里** ——
所以它主要伤害体积与 V8 编译时间,不是 NPS 的主因。

## 4. 其余差异(不影响速度,只影响体积)

- `unreachable`:rust 66 处 vs zig 3 处 —— rust 侧保留的 panic 分支(`get_unchecked`
  只覆盖了热路径),执行不到,只占代码段。
- 两边都发了 `i64.popcnt`(zig 65 / rust 80),**没有**走 SWAR 软件实现。
  README 里"popcount 目前是软件实现"这句话不准确,实际缺的是 SIMD128 批量 popcount。
- data 段 rust 大 7.6 KB(47,501 vs 39,927),两边都 include 了同样的
  `weights.bin` + `book-openings.bin`,差额来自静态表的对齐/宽度不同。

## 5. 结论

rust 快的直接原因是**每节点访存更少、局面留在寄存器里**,源头是两条:

1. `Board` 的传参 ABI(zig 走内存指针,rust 被拆成两个 i64 值参数)—— 主因;
2. `u6` 打包数组让热路径的着法读写都变成单字节访存 —— 次因。

"rust 产物更大却更快"不矛盾:rust 用展开和更宽的数据类型换掉了访存,
zig 用紧凑编码(u6、查表)换来了体积。

## 6. 可以验证/修的方向(未做,需先确认要不要动)

- zig 侧把 `search(b: Board, ...)` 改成显式传 `own: u64, opp: u64`(或把 Board 声明成
  `extern struct` / 用 `packed`),让 LLVM 走值传递 —— 预期是 NPS 上最直接的那一档。
- `ply_moves` 从 `u6` 改成 `u8`/`u32`(牺牲一点 cache 密度换对齐访问)。
- `slotIndices` 的 `inline for` 改成普通 `for`,省掉 4948 指令的巨型块。
- 每条改动都要配 `node tools/bench-wasm.mjs` 背靠背同条件重测(本机 run-to-run ±25%,
  短样本不可信),节点数应保持逐位一致。
