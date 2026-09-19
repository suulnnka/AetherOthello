// 自对弈训练器(原生 exe,**不参与 wasm**)。
//
// ── 为什么不是 SGD ────────────────────────────────────────────────
// 评估是**线性**的:分值 = Σ_t sigma_t · u[orbit_t],u 是"轨道 → 子数"的浮点权重。
// 线性 + 平方误差 ⇒ 这是个稀疏最小二乘问题,可以直接解出来,
// 不必去手调学习率、批大小、动量这些 SGD 旋钮(旋钮没调好就是"训了一晚上
// MSE 没降"的经典事故)。每个局面只有 38 个非零项(折叠后平均约 30),
// 所以正规方程 (AᵀA + λI)x = Aᵀb 的乘法能做成一趟 **O(样本数 × 38)** 的稀疏扫描
// ⇒ 不需要把 9,475² 的正规矩阵存下来(存下来 360 MB 还没法直接求逆),
// 直接上共轭梯度(CGNR)。9,475 个未知数、几万行,几百次迭代就收敛。
//
// ── 标签从哪来(三路,缺一不可)────────────────────────────────────
//   ① **精确**:自对弈时若空位 ≤ endgame,引擎本来就在走完全求解,
//      这一手的分值就是精确子差 —— 免费拿到的最优标签。
//   ② **引导**:否则用"这一手搜索返回的值"。它等于"评估自己搜 D 层时的看法",
//      把深搜的结构(行动力、稳定子、奇偶)灌进评估。纯靠对局结果回归时,
//      早期局面(空位 40+)与终局子差相关性极弱,要几千局才出信号。
//   ③ **对局结果**:终局子差(mover 视角)。它提供**绝对锚点** ——
//      只有①②的话评估会收敛到"与自己的搜索自洽"的退化解(u ≡ 0 就是那个
//      平凡不动点),对局结果把它钉在真实刻度上。
//
// ⚠ 引导样本在**第 0 轮必须关掉**:那一轮权重是 0 ⇒ 搜索值恒为 0 ⇒
//   引导项全在喊"评估应该是 0",而它和对局结果约束的是同一批特征,
//   两边一平均就把信号稀释掉(踩过)。
//
//   ⚠ 但请注意这条(以及下面 `depth0` 的同款注释)描述的是**从零权书冷启动**。
//   现在 `--load` 缺省用嵌入的那本(非零),第 0 轮的搜索值**并不**恒为 0。
//   两个设置本身都还合理,但要拿"权重是 0"去解释某个观测到的现象之前,
//   先确认这一次的起始书到底是不是零 —— 曾经照着这句话查过一个不存在的问题。
//
// ── 量化:PTQ(训练后量化)──────────────────────────────────────────
// 训练**全程 f32**:循环里既不做幅值夹取、也不做 int8 舍入;自对弈的叶子值
// 由 `pattern.evalFloat` 直接读浮点权重表(经 `search.eval_u` 挂上去)。
// 定标 → 量化 → 落盘 → A/B 全在循环**结束后**做一次。
//
// 为什么不是"每轮都量化"(旧做法,已改掉):那等于付了 QAT 的代价却拿不到
// QAT 的好处 —— 标签被量化误差污染(下一轮自对弈拿的是上一轮拍平过的表),
// 而 `solveCg` 解的是干净的最小二乘,**根本不知道自己会被量化**,所以也不会去
// 补偿。代价是实测的:每轮夹取把 27%~57% 的轨道钉在上限上,训出来的书是
// "近似二值"的(见 out/whist.mjs 的幅值分布)。
//
// ── 量程:自动定标,**没有手调旋钮** ──────────────────────────────
// 旧的 `--umax`(单轨道浮点上限)已删。它当初身兼两职,所以怎么调都别扭:
//   一半是**量化量程**(该由数据定);
//   一半是**正则化**("不许有超过 X 子的模式",在改模型)。
// 现在拆开:模型该多大由最小二乘说了算(循环里不夹取),量化量程由
// `calibrate` 扫一组候选、取**评估误差最小**的那个(见那里的注释)。
// ⇒ 副作用是好的:选中的那档会自己报"截了多少、误差多大",不用再去猜
//   "u_max 是不是定小了"(以前只能靠反推 ±127 的占比,猜出来 27%~57%)。
//
// 附带好处:量化方案从"每换一个都要重训一整轮自对弈"变成"在同一份 f32 权重
// 上重算一次"。想换定标方式时,不必再付自对弈的钱。
//
// ⚠ 颜色:Board.own 是"该谁走"而不是固定黑方,Board 里**没有**颜色信息。
//   自对弈必须自己记 own_black,否则终局子差会按反的颜色算出来 ——
//   标签整体反号的后果是"怎么训都训不上去",极难定位。
//
// 所有随机性走固定种子,整条训练链**可复现** —— 与项目里"难度按节点预算、
// 不按墙钟"是同一条原则:能复现才谈得上断言。
const std = @import("std");
const rules = @import("rules.zig");
const pattern = @import("pattern.zig");
const search = @import("search.zig");

/// 起始权重(上一次训练出来的书)。用来热启动 + 当 A/B 的基准。
const weights0 = @embedFile("weights.bin");

var gio: std.Io = undefined;

fn say(comptime fmt: []const u8, args: anytype) void {
    std.debug.print(fmt ++ "\n", args);
}
fn nanos() i96 {
    return std.Io.Timestamp.now(gio, .awake).nanoseconds;
}
/// ⚠ 这里是**秒**。曾经写成 `... / 1e6` 却把打印文案写成 "s" ——
/// 于是 1.9 s 的整轮训练被读成 "1887 s",我对着一个不存在的性能问题查了半天。
/// 单位和文案必须一起改,注释留在这儿防复发。
fn secs(from: i96) f64 {
    return span(from, nanos());
}
/// 两时刻之间的秒数。**别用 secs(a) - secs(b) 代替** —— 那里面有两次独立的
/// now() 调用,减出来不是区间长度(踩过)。
fn span(from: i96, to: i96) f64 {
    return @as(f64, @floatFromInt(to - from)) / 1e9;
}

const Cfg = struct {
    games: u32 = 300, // 每轮自对弈局数
    /// 自对弈搜索深度(第 1 轮起)。**约定:6 层,不要为了"标签更准"去加深。**
    /// 深度每 +2 层成本大约乘一个量级(300 局 d6 约 67 s),而标签质量并不随深度
    /// 线性变好;6 层已经够把行动力 / 稳定子 / 奇偶这些结构灌进评估。
    /// 跨实现对打也走这个深度(tools/match-branches.mjs 的 --depth 默认 6)。
    depth: u32 = 6,
    // ⚠ 第 0 轮必须用浅搜:那一轮权重是 0 ⇒ 叶子值全等 ⇒ 零窗口搜索**一次都剪不掉**
    //   (窗口 (α,α+ε) 里所有值都恰好等于 α,谁都不 fail-high),整棵深树被完整展开。
    //   实测 depth=6 时一盘要 60 s,300 局就是一晚上。浅搜把这一轮的成本压到可忽略,
    //   拿到非零权重后第 1 轮起再上深搜(那时叶子值有区分度,剪枝就正常了)。
    depth0: u32 = 2,
    endgame: u32 = 10, // 空位 ≤ 此值时走完全求解(顺带产出精确标签)
    open: u32 = 6, // 开局随机步数:确定性引擎不加这个,300 局等于 1 局
    iters: u32 = 3, // 外层轮次(每轮 = 自对弈 + 最小二乘 + 换权重)
    cg: u32 = 400, // CG 最大迭代数
    mu: f32 = 0.1, // 岭正则(相对正规矩阵对角均值)。实测 0.5 就把信号压没了(A/B 29:29)
    w_out: f32 = 0.35, // 对局结果样本权重
    w_boot: f32 = 1.0, // 引导样本权重(第 0 轮强制 0)
    w_exact: f32 = 4.0, // 精确样本权重
    ab: u32 = 40, // 训练后 new vs old 的成对局数(每局双方各执黑一次)
    seed: u64 = 0, // 0 ⇒ 用默认种子
    out: []const u8 = "src/zig/weights.bin",
    /// 非空 ⇒ 额外落一本**对照书**:同一个 f32 权重、但用**起始书那套定标**
    /// (先夹到 ±127·scale 再量化)。两本书只差定标 ⇒ 可以直接对打,
    /// 把"自动定标值多少"从"新一轮训练值多少"里**隔离**出来。
    ref_out: []const u8 = "",
    load: []const u8 = "", // 非空 ⇒ 从该文件热启动(而不是嵌入的那本)
    no_ab: bool = false,
};

// ─────────────────────── 训练行 ───────────────────────

const MAXT: usize = pattern.PTN_COUNT;

/// 一个稀疏特征行。同一行里若两张表映到同一轨道,符号直接相加合并 ——
/// 行更短,CG 更快,而且数学上完全等价(线性模型里同轨道项本来就该合并)。
const Row = struct {
    o: [MAXT]u16 = undefined,
    s: [MAXT]i8 = undefined,
    n: u8 = 0,
    phase: u8 = 0,
    /// 样本权重。**不能只让 sqrt(w) 乘到目标值上。**
    /// 加权最小二乘是 min Σ wᵢ(aᵢ·x − tᵢ)²,正规方程 AᵀWA x = AᵀWt ——
    /// 权重必须**同时**作用在 AᵀA 与 Aᵀb 两条链上。曾经的做法是让 t 乘
    /// sqrt(w) 而 A 不动,那解出来的是 min‖Ax − W^½t‖²:不同权重的样本被
    /// 摆到了不同刻度上(精确样本 w=4 的目标被放大 2 倍、结果样本 w=0.35
    /// 被压到 0.59 倍),而结果样本恰恰是唯一提供**绝对刻度**的锚。
    /// s 是 i8 装不下小数,所以权重单独带着走而不是乘进特征。
    w: f32 = 1,
    t: f32 = 0, // 目标值(原始子差,不预先乘任何权重)
};

/// 把局面摊成一行。所有权重都在**折叠空间**里拟合 ——
/// 于是"几何/换色对称"不是靠损失函数约束出来的,而是压根不在参数里,
/// 训完必然严格对称,不可能训出一个破坏对称性的解。
fn rowOf(b: rules.Board, target: f32, w: f32) ?Row {
    if (w <= 0) return null;
    var slots: [pattern.PTN_COUNT]u32 = undefined;
    pattern.slotIndices(b, &slots);
    var r = Row{ .n = 0, .phase = @intCast(pattern.phaseOf(b.discs())), .w = w, .t = target };
    for (slots) |sl| {
        const i: usize = sl;
        const o = pattern.orbit[i];
        // 被对称性强制作 0 的轨道永远是 0,放进模型只会让正规矩阵多一堆零列
        if (pattern.orb_zero[o] != 0) continue;
        const sg = pattern.sigma[i];
        var k: usize = 0;
        while (k < r.n) : (k += 1) {
            if (r.o[k] == o) break;
        }
        if (k < r.n) {
            const sum: i16 = @as(i16, r.s[k]) + sg;
            if (sum == 0) {
                r.n -= 1;
                r.o[k] = r.o[r.n];
                r.s[k] = r.s[r.n];
            } else {
                r.s[k] = @intCast(sum);
            }
        } else if (r.n < MAXT) {
            r.o[r.n] = o;
            r.s[r.n] = sg;
            r.n += 1;
        }
    }
    if (r.n == 0) return null;
    return r;
}

// ─────────────────────── 共轭梯度(CGNR)───────────────────────

/// 解 min Σᵢ wᵢ(aᵢ·x − tᵢ)² + λ‖x‖²(加权最小二乘 + 岭)。
/// 正规矩阵不显式构造:A 的第 i 行就是 rows[i] 那 ≤38 个 (o,s),样本权重在 row.w;
/// (AᵀWA)p 用"先 A 后 Aᵀ"两趟稀疏扫描算出来。x 热启动(上一轮的 u)⇒ 收敛很快。
///
/// ⚠ **内部一律 f64**。正规方程的条件数是 κ(A)²,这套特征又高度相关
///   (38 张斜线/行列表大面积重叠)、而且相位 0 基本是欠定的。
///   用 f32 实测:残差²从 1.3e1 一路"收敛"到 8.3e11,拟合后 MSE 1e15 ——
///   整个解被舍入噪声带飞。多花 300 KB 内存换"不会算出 NaN 权重",很值。
///
/// ⚠ 还要留一份**历史最优解**:CG 在精确算术下残差单调下降,浮点下不保证。
///   发散保护触发时回退到最优那一步,至少不比热启动点差。
fn solveCg(alloc: std.mem.Allocator, rows: []const Row, x: []f32, lambda: f32, max_iter: u32, verbose: bool) !void {
    const n = x.len;
    if (rows.len == 0) return;
    const xd = try alloc.alloc(f64, n);
    const r = try alloc.alloc(f64, n);
    const p = try alloc.alloc(f64, n);
    const ap = try alloc.alloc(f64, n);
    const best = try alloc.alloc(f64, n);
    const cbuf = try alloc.alloc(f64, rows.len);
    for (0..n) |i| xd[i] = @floatCast(x[i]);

    // r = AᵀWb − (AᵀWA + λI)x
    @memset(r, 0);
    for (rows) |row| {
        const wt: f64 = @as(f64, row.w) * @as(f64, row.t);
        var k: usize = 0;
        while (k < row.n) : (k += 1) r[row.o[k]] += @as(f64, @floatFromInt(row.s[k])) * wt;
    }
    mulAtA(rows, xd, ap, cbuf);
    for (0..n) |i| r[i] -= ap[i] + @as(f64, lambda) * xd[i];

    @memcpy(p, r);
    @memcpy(best, xd);
    var rs = dot(r, r);
    var best_rs = rs;
    const rs0 = if (rs > 0) rs else 1e-300;
    var it: u32 = 0;
    while (it < max_iter) {
        mulAtA(rows, p, ap, cbuf);
        const denom = dot(p, ap);
        if (!(denom > 0) or !std.math.isFinite(denom)) break;
        const alpha = rs / denom;
        for (0..n) |i| {
            xd[i] += alpha * p[i];
            r[i] -= alpha * ap[i];
        }
        const rs2 = dot(r, r);
        it += 1;
        if (rs2 < best_rs) {
            best_rs = rs2;
            @memcpy(best, xd);
        }
        if (rs2 <= 1e-26 * rs0) break; // 已经到机器精度,再迭代只是噪声
        if (!(rs2 < rs * 1e6)) break; // 发散保护:回退到 best
        const beta = rs2 / rs;
        for (0..n) |i| p[i] = r[i] + beta * p[i];
        rs = rs2;
    }
    for (0..n) |i| x[i] = @floatCast(best[i]);
    if (verbose) {
        say("    CG {d} 次迭代 · 残差²/初值 {e:.3}", .{ it, best_rs / rs0 });
    }
}

/// y ← AᵀWA x(λ 由调用方并在外面减:x 那一步会把 λ 混进残差,藏进去会让
/// 收敛判据和真实残差脱钩,是最容易写错的"顺手优化")。
fn mulAtA(rows: []const Row, x: []const f64, y: []f64, cbuf: []f64) void {
    @memset(y, 0);
    for (rows, 0..) |row, i| {
        var c: f64 = 0;
        var k: usize = 0;
        while (k < row.n) : (k += 1) c += @as(f64, @floatFromInt(row.s[k])) * x[row.o[k]];
        // 权重在这一步混进中间量:y_j = Σᵢ a_ij·(wᵢ·cᵢ) 恰好就是 (AᵀWA x)_j。
        cbuf[i] = c * @as(f64, row.w);
        k = 0;
        while (k < row.n) : (k += 1) y[row.o[k]] += @as(f64, @floatFromInt(row.s[k])) * cbuf[i];
    }
}

fn dot(a: []const f64, b: []const f64) f64 {
    var s: f64 = 0;
    for (a, b) |x, y| s += x * y;
    return s;
}

/// 训练集上的**加权**均方误差(诊断用;必须随轮次下降,不降说明哪里写错了)
/// 用 Σw 归一化,换权重方案或换样本数时数值仍可跨轮比较。
/// (旧版是"未加权 MSE",但那时 row.t 里带着 sqrt(w),量出来的本来也不是干净误差。)
fn mse(rows: []const Row, x: []const f32) f64 {
    var se: f64 = 0;
    var sw: f64 = 0;
    for (rows) |row| {
        var c: f64 = 0;
        var k: usize = 0;
        while (k < row.n) : (k += 1) c += @as(f64, @floatFromInt(row.s[k])) * @as(f64, x[row.o[k]]);
        const d = c - @as(f64, row.t);
        const w: f64 = row.w;
        se += w * d * d;
        sw += w;
    }
    return if (sw > 0) se / sw else 0;
}

/// **加权**正规矩阵 AᵀWA 的对角均值,把 λ 定成相对量级 —— 绝对 λ 在样本数变 10 倍时
/// 行为完全不同,是不该存在的隐性耦合。
/// ⚠ 必须带上 w:λ 的参照物一旦和真正参与求解的那个矩阵不是同一个,`--mu` 的语义就漂了。
fn diagMean(rows: []const Row) f32 {
    var s: f64 = 0;
    for (rows) |r| {
        var k: usize = 0;
        while (k < r.n) : (k += 1) {
            const a: f64 = @floatFromInt(r.s[k]);
            s += @as(f64, r.w) * a * a;
        }
    }
    const orb = @as(f64, @floatFromInt(pattern.ORBITS));
    return @floatCast(@max(s / orb, 1e-3));
}

// ─────────────────────── 自对弈 ───────────────────────

const Log = struct {
    own: u64,
    opp: u64,
    score: f32,
    has_score: bool, // 这个分值真的搜出来了吗(唯一着法会短路成 0,不能当标签)
    exact: bool, // 是精确子差吗
    black: bool, // 落子前是黑方走
};

const Emitter = struct {
    rows: []Row,
    n: usize = 0,
    boot_w: f32 = 0,
    dropped: usize = 0,

    fn add(self: *Emitter, b: rules.Board, target: f32, w: f32) void {
        if (w <= 0) return;
        const r = rowOf(b, target, w) orelse {
            self.dropped += 1;
            return;
        };
        if (self.n >= self.rows.len) {
            self.dropped += 1;
            return;
        }
        self.rows[self.n] = r;
        self.n += 1;
    }
};

/// 一局自对弈的统计量。黑子差均值是**最灵敏的体检指标**:
/// 引擎确定性 + 开局随机的话,它应该接近 0;恒定偏一个方向说明先/后手处理反了。
const GameStat = struct { plies: u32, diff: i32 };

fn pick(rnd: std.Random, n: u32) u32 {
    return rnd.intRangeLessThan(u32, 0, n);
}

fn nthBit(m: u64, k: u32) u6 {
    var mm = m;
    var i = k;
    while (i > 0) : (i -= 1) mm &= mm - 1;
    return @intCast(@ctz(mm));
}

/// 自对弈一局。走完以后把每个局面摊成训练行。
/// final_diff 是**黑视角**子差,换算到 mover 视角要按 own_black 定符号。
fn playGame(cfg: Cfg, depth: u32, rnd: std.Random, log: []Log, em: *Emitter) !GameStat {
    var b = rules.Board.initial;
    var own_black = true;
    var togo = cfg.open;
    var np: u32 = 0;

    while (true) {
        const m = rules.moves(b);
        if (m == 0) {
            const sw = rules.Board{ .own = b.opp, .opp = b.own };
            if (rules.moves(sw) == 0) break;
            b = sw;
            own_black = !own_black;
            continue;
        }
        if (togo > 0 and @popCount(m) > 1) {
            const sq = nthBit(m, pick(rnd, @popCount(m)));
            togo -= 1;
            if (np < log.len) {
                log[np] = .{ .own = b.own, .opp = b.opp, .score = 0, .has_score = false, .exact = false, .black = own_black };
                np += 1;
            }
            const st = rules.step(b, sq);
            b = st.board;
            switch (st.status) {
                .ok, .pass => own_black = !own_black,
                .over => break,
            }
            continue;
        }
        const res = search.think(b, depth, cfg.endgame, 0);
        if (res.move < 0) break;
        if (np < log.len) {
            log[np] = .{
                .own = b.own,
                .opp = b.opp,
                .score = res.score,
                // res.only = 根上只有唯一着法 ⇒ 直接返回,score 是 0,不是真的搜索值;
                // depth == 0(纯贪心)同理:分值只是排序用的静态分,不是搜索值
                .has_score = !res.only and depth > 0,
                .exact = res.exact and !res.only,
                .black = own_black,
            };
            np += 1;
        }
        const st = rules.step(b, @intCast(res.move));
        b = st.board;
        switch (st.status) {
            .ok, .pass => own_black = !own_black,
            .over => break,
        }
    }

    const own = @as(i32, @popCount(b.own));
    const opp = @as(i32, @popCount(b.opp));
    const black = if (own_black) own else opp;
    const white = if (own_black) opp else own;
    const diff = black - white;

    for (log[0..np]) |rec| {
        const board = rules.Board{ .own = rec.own, .opp = rec.opp };
        const outcome: f32 = if (rec.black) @floatFromInt(diff) else @floatFromInt(-diff);
        if (rec.exact) {
            // 精确标签是唯一可信的锚:再叠一个噪声样本只会把解往回拉
            em.add(board, rec.score, cfg.w_exact);
            continue;
        }
        if (rec.has_score) em.add(board, rec.score, em.boot_w);
        em.add(board, outcome, cfg.w_out);
    }
    return .{ .plies = np, .diff = diff };
}

// ─────────────────────── 量化 / 落盘 ───────────────────────

/// 浮点轨道权重 → int8,用**给定**的 scale(由 `calibrate` 定,这里不再自己算)。
/// 返回被 ±127 截断的轨道数。
///
/// ⚠ 这里的 `clamp(±127)` 不是"削模型",是 **int8 的物理上限**,任何定标方案都躲不掉。
///   区别在于"削多少"由谁说了算:以前是"先按人定的 u_max 削成 ±u_max,scale 跟着变成
///   u_max/127";现在是"由评估误差挑"(见 `calibrate`)。
fn quantize(u: [pattern.PHASES][pattern.ORBITS]f32, out_q: []u8, sc: [pattern.PHASES]f32) u32 {
    var clipped: u32 = 0;
    for (0..pattern.PHASES) |ph| {
        const scale = sc[ph];
        for (0..pattern.ORBITS) |o| {
            const v = u[ph][o] / scale;
            if (@abs(v) > 127.5) clipped += 1;
            const c = std.math.clamp(v, -127.0, 127.0);
            out_q[ph * pattern.ORBITS + o] = @bitCast(@as(i8, @intFromFloat(@round(c))));
        }
    }
    return clipped;
}

// ─────────────────────── 自动定标(PTQ calibration)───────────────────────

const Calib = struct { scales: [pattern.PHASES]f32, err: f64, clipped: u32 };

/// 一组候选 scale 的**加权评估误差**:量化 → 反量化 → 在样本上算一遍分值,
/// 看它相对 f32 原值偏了多少(单位:子²)。
///
/// ⚠ 量的是 **eval 的误差**,不是"权重表本身的重建误差 Σ(û−u)²"。评估是 38 项求和,
///   量化误差在求和时会部分抵消,而大幅值轨道主导结果 —— 直接量最终关心的那个量,
///   省得再去解释"两套口径为什么结论不同"。
///
/// `ph` 为 null 时统计全部行;否则**只统计该相位的行**(定标是分相位做的)。
fn calibErr(rows: []const Row, u: *const [pattern.PHASES][pattern.ORBITS]f32, q: []const u8, sc: [pattern.PHASES]f32, ph: ?usize) f64 {
    var se: f64 = 0;
    var sw: f64 = 0;
    for (rows) |row| {
        if (ph) |p| {
            if (row.phase != p) continue;
        }
        var d: f64 = 0;
        var k: usize = 0;
        while (k < row.n) : (k += 1) {
            const sg: f64 = @floatFromInt(row.s[k]);
            const o: usize = row.o[k];
            const qv: f64 = @floatFromInt(@as(i8, @bitCast(q[row.phase * pattern.ORBITS + o])));
            d += sg * (qv * @as(f64, sc[row.phase]) - @as(f64, u[row.phase][o]));
        }
        const w: f64 = row.w;
        se += w * d * d;
        sw += w;
    }
    return if (sw > 0) se / sw else 0;
}

/// 单个相位撞 ±127 的轨道数(诊断用;quantize 返回的是两相位合计)
fn countClip(u: [pattern.PHASES][pattern.ORBITS]f32, sc: [pattern.PHASES]f32, ph: usize) u32 {
    var n: u32 = 0;
    for (0..pattern.ORBITS) |o| {
        if (@abs(u[ph][o]) / sc[ph] > 127.5) n += 1;
    }
    return n;
}

/// PTQ 的 calibration:**自动**挑 scale。手调的量程旋钮(`--umax`)已删。
///
/// ── 为什么还需要"挑" ────────────────────────────────────────────────
/// scale 越小 ⇒ 格子越细,但 ±127 只能表示 ±127·scale,超出的权重被**截断**。
/// 所以这是一条"截断 vs 分辨率"的取舍曲线,两头都差、中间有谷:
///   scale 大(格子粗)⇒ 大量小权重被拍成 0,书变成"近似二值";
///   scale 小(格子细)⇒ 大权重被削顶,最强信号(角/边)失真。
/// 以前这个点是**人手挑**的(先按 u_max 削,scale 跟着变成 u_max/127);
/// 现在让**数据**挑:扫一组候选,取评估误差最小的那个。
///
/// ── 顺带解决的老问题 ────────────────────────────────────────────────
/// 以前只能靠"±127 占比"去猜 u_max 是不是定小了(猜出来是 27%~57%,很吓人)。
/// 现在选中的那个点会**自己报**它截了多少、误差多大,不用猜。
///
/// ── 网格 ────────────────────────────────────────────────────────────
/// 等比从"恰好不截断"的 smax = max|u|/127 往下扫 10 档(k 每 +3 档减半),
/// 再在最优档的左右邻档之间均匀插 8 个点细化(粗扫步长 26%,不够定位)。
///
/// ⚠ 定标用的是训练这批 rows 自己。严格说该留一份独立定标集,但这里只有
///   **1 个自由度**,几万行对 1 个参数,过拟合余地基本没有 —— 和"用训练集挑
///   9475 个权重"完全不是一回事。
fn calibrate(rows: []const Row, u: *const [pattern.PHASES][pattern.ORBITS]f32, q: []u8, ref_sc: [pattern.PHASES]f32) Calib {
    const K: usize = 10;
    const total = @as(f64, @floatFromInt(pattern.ORBITS)); // 每相位的轨道数
    var sc: [pattern.PHASES]f32 = .{1.0 / 64.0} ** pattern.PHASES;

    for (0..pattern.PHASES) |ph| {
        var mx: f32 = 0;
        for (0..pattern.ORBITS) |o| {
            if (pattern.orb_zero[o] != 0) continue;
            const v = @abs(u[ph][o]);
            if (v > mx) mx = v;
        }
        if (mx <= 1e-6) { // 空相位:没有可定的标,退回一个不会除零的步长
            say("  相位 {d} 定标:权重全 0,退回 scale {d:.6}", .{ ph, sc[ph] });
            continue;
        }
        const smax = mx / 127.0; // 恰好不截断;再大只是白丢分辨率
        say("  相位 {d} 定标:max|u| {d:.3} 子 ⇒ 无截断点 scale {d:.6}(1 步 = {d:.4} 子)", .{ ph, mx, smax, smax });

        var best_k: f64 = 0; // 用**连续**的 k 记位置(k 每 +3 ⇒ scale 减半),便于细化
        var best_e: f64 = std.math.inf(f64);
        var es: [K]f64 = undefined;
        var ss: [K]f32 = undefined;
        var cs: [K]u32 = undefined;
        for (0..K) |k| {
            const kk: f64 = @floatFromInt(k);
            ss[k] = smax * std.math.pow(f32, 2.0, @floatCast(-kk / 3.0));
            var trial = sc; // 只动当前相位;另一相位保持已选中的值
            trial[ph] = ss[k];
            cs[k] = countClip(u.*, trial, ph);
            _ = quantize(u.*, q, trial);
            es[k] = calibErr(rows, u, q, trial, ph);
            if (es[k] < best_e) {
                best_e = es[k];
                best_k = kk;
            }
        }
        const best_ki: usize = @intFromFloat(best_k);
        for (0..K) |k| {
            const pct = @as(f64, @floatFromInt(cs[k])) * 100.0 / total;
            say("    档 {d:2}  scale {d:.6}  截断 {d:>4.1}%  RMSE {d:.3} 子{s}", .{
                k, ss[k], pct, @sqrt(es[k]), if (k == best_ki) "   ← 最优" else "",
            });
        }
        // 细化:在最优档的左右邻档之间均匀插 8 个点(粗扫步长 26%,不够定位)
        const lo = @max(best_k - 1.0, 0.0);
        const hi = @min(best_k + 1.0, @as(f64, @floatFromInt(K - 1)));
        var j: usize = 0;
        while (j < 8) : (j += 1) {
            const kk = lo + (hi - lo) * (@as(f64, @floatFromInt(j)) / 7.0);
            var trial = sc;
            trial[ph] = smax * std.math.pow(f32, 2.0, @floatCast(-kk / 3.0));
            const e = blk: {
                _ = quantize(u.*, q, trial);
                break :blk calibErr(rows, u, q, trial, ph);
            };
            if (e < best_e) {
                best_e = e;
                best_k = kk;
            }
        }
        sc[ph] = smax * std.math.pow(f32, 2.0, @floatCast(-best_k / 3.0));
        say("    ⇒ 相位 {d} 选中 scale {d:.6}(1 步 = {d:.4} 子)· RMSE {d:.3} 子", .{ ph, sc[ph], sc[ph], @sqrt(best_e) });
    }

    // 对照:把**起始书的定标方案**套到这份 f32 表上,直接读出"手调量程 vs 自动定标"
    // 差多少。这个数以前只能靠反推 ±127 的占比去猜(猜出来 27%~57%,但那只是个占比)。
    // 起始书是"先夹到 ±R 再按 scale 量化"的产物,而 quantize 内部 clamp 到 ±127
    // 恰好等价于"先夹到 ±127·scale" ⇒ 传 ref_sc 进去复现的就是那套方案。
    //
    // ⚠ 它量的是**方案**,不是"那本书本身":那本书对应的 f32 权重是上一代的,
    //   和现在这份 u 不是同一个模型。热启动时两者接近,所以这个数有参考价值,
    //   但别把它当成"旧书自带 10 子误差"的严格结论。
    if (ref_sc[0] > 0) {
        const e = blk: {
            _ = quantize(u.*, q, ref_sc);
            break :blk calibErr(rows, u, q, ref_sc, null);
        };
        var parts: [pattern.PHASES]f64 = undefined;
        var cp: [pattern.PHASES]u32 = undefined;
        for (0..pattern.PHASES) |ph| {
            cp[ph] = countClip(u.*, ref_sc, ph);
            parts[ph] = @as(f64, @floatFromInt(cp[ph])) * 100.0 / total;
        }
        say("    对照 · 起始书方案(夹到 ±{d:.1}/±{d:.1})套到这份表上 ⇒ 截断 {d:.1}%/{d:.1}% · RMSE {d:.3} 子", .{
            ref_sc[0] * 127.0, ref_sc[1] * 127.0, parts[0], parts[1], @sqrt(e),
        });
    }
    const clipped = quantize(u.*, q, sc); // q 落定在选中那两档
    const err = calibErr(rows, u, q, sc, null);
    say("  ⇒ 两相位 scale {d:.6} / {d:.6} · 合计截断 {d} 条 · RMSE {d:.3} 子", .{ sc[0], sc[1], clipped, @sqrt(err) });
    return Calib{ .scales = sc, .err = err, .clipped = clipped };
}

fn makeBlob(alloc: std.mem.Allocator, q: []const u8, sc: [pattern.PHASES]f32) ![]u8 {
    const blob = try alloc.alloc(u8, pattern.BLOB_HEADER + q.len);
    @memset(blob, 0);
    std.mem.writeInt(u32, blob[0..4], pattern.BLOB_MAGIC, .little);
    blob[4] = pattern.BLOB_VERSION; // 2 = 每相位一个 scale(头 20 字节)
    blob[5] = pattern.PHASES;
    std.mem.writeInt(u32, blob[8..12], pattern.ORBITS, .little);
    for (0..pattern.PHASES) |ph| {
        std.mem.writeInt(u32, blob[12 + 4 * ph ..][0..4], @bitCast(sc[ph]), .little);
    }
    @memcpy(blob[pattern.BLOB_HEADER..], q);
    return blob;
}

fn blobScales(blob: []const u8) [pattern.PHASES]f32 {
    var sc: [pattern.PHASES]f32 = undefined;
    for (0..pattern.PHASES) |ph| {
        sc[ph] = @bitCast(std.mem.readInt(u32, blob[12 + 4 * ph ..][0..4], .little));
    }
    return sc;
}

fn loadFloat(blob: []const u8, u: *[pattern.PHASES][pattern.ORBITS]f32) void {
    const sc = blobScales(blob);
    for (0..pattern.PHASES) |ph| {
        for (0..pattern.ORBITS) |o| {
            const raw: i8 = @bitCast(blob[pattern.BLOB_HEADER + ph * pattern.ORBITS + o]);
            u[ph][o] = @as(f32, @floatFromInt(raw)) * sc[ph];
        }
    }
}

fn countZero() u32 {
    var n: u32 = 0;
    for (0..pattern.ORBITS) |o| {
        if (pattern.orb_zero[o] != 0) n += 1;
    }
    return n;
}

// ─────────────────────── A/B ───────────────────────

/// A 用 qa,B 用 qb。返回黑视角子差。
/// 每次落子前把该方的权重装回去 —— 权重换一次只是 27 万次表写入(<1 ms),
/// 比"两边各存一份搜索"要少得多。
///
/// ⚠ 每手前 clearTT:置换表里存的是**用上一手那方的权重**算出来的分值,
///   不换清楚就会拿 A 的结论去指导 B 的着法,对战结果直接失去意义。
fn playAb(cfg: Cfg, rnd: std.Random, qa: []const u8, sa: [pattern.PHASES]f32, qb: []const u8, sb: [pattern.PHASES]f32, a_black: bool) !i32 {
    var b = rules.Board.initial;
    var own_black = true;
    var togo = cfg.open;
    while (true) {
        const m = rules.moves(b);
        if (m == 0) {
            const sw = rules.Board{ .own = b.opp, .opp = b.own };
            if (rules.moves(sw) == 0) break;
            b = sw;
            own_black = !own_black;
            continue;
        }
        var sq: u6 = undefined;
        if (togo > 0 and @popCount(m) > 1) {
            sq = nthBit(m, pick(rnd, @popCount(m)));
            togo -= 1;
        } else {
            search.clearTT();
            if (own_black == a_black) pattern.installQuant(qa, sa) else pattern.installQuant(qb, sb);
            const res = search.think(b, cfg.depth, cfg.endgame, 0);
            if (res.move < 0) break;
            sq = @intCast(res.move);
        }
        const st = rules.step(b, sq);
        b = st.board;
        switch (st.status) {
            .ok, .pass => own_black = !own_black,
            .over => break,
        }
    }
    const own = @as(i32, @popCount(b.own));
    const opp = @as(i32, @popCount(b.opp));
    const black = if (own_black) own else opp;
    const white = if (own_black) opp else own;
    return black - white;
}

fn abTest(cfg: Cfg, blob_new: []const u8, blob_old: []const u8, title: []const u8) !void {
    // A/B 的语义是"打量化后的产物" ⇒ 必须摘掉 f32 影子表。
    // 否则 search 会拿 f32 分值去指导**双方**着法,而 installQuant 装进去的表
    // 根本没人读 —— 打出来的结论与这两本书无关。与下面 clearTT 那条同级:
    // 都是"状态没换干净 ⇒ 结论失去意义"的静默错误。
    const saved_u = search.eval_u;
    search.eval_u = null;
    defer search.eval_u = saved_u;

    const q_new = blob_new[pattern.BLOB_HEADER..];
    const q_old = blob_old[pattern.BLOB_HEADER..];
    const sc_new = blobScales(blob_new);
    const sc_old = blobScales(blob_old);
    const pairs = @max(cfg.ab / 2, 1);
    say("\nA/B:{s} · {d} 对(每对同一开局、双方各执黑一次)· 深度 {d}", .{ title, pairs, cfg.depth });
    const t0 = nanos();
    var w: u32 = 0;
    var l: u32 = 0;
    var d: u32 = 0;
    var margin: i64 = 0;
    for (0..pairs) |g| {
        // 每一对都换一个新开局编号:同种子必然同一盘棋
        var oa = std.Random.DefaultPrng.init(cfg.seed +% @as(u64, g) *% 0x9E37_79B9_7F4A_7C15);
        const d1 = try playAb(cfg, oa.random(), q_new, sc_new, q_old, sc_old, true);
        if (d1 > 0) {
            w += 1;
        } else if (d1 < 0) {
            l += 1;
        } else {
            d += 1;
        }
        margin += d1;
        var ob = std.Random.DefaultPrng.init(cfg.seed +% @as(u64, g) *% 0x9E37_79B9_7F4A_7C15);
        const d2 = try playAb(cfg, ob.random(), q_new, sc_new, q_old, sc_old, false);
        if (d2 < 0) {
            w += 1;
        } else if (d2 > 0) {
            l += 1;
        } else {
            d += 1;
        }
        margin -= d2;
    }
    const tot = w + l + d;
    const mg = @as(f64, @floatFromInt(margin)) / @as(f64, @floatFromInt(@max(tot, 1)));
    // ⚠ 判决用 **margin(平均子差)**,不要用胜负场数:胜负是二项(200 局时 SE 11%),
    //   子差是**配对**统计,功效高一个量级。子差单局 SD ≈ 25 ⇒ 200 局时
    //   SE ≈ 25/√200 ≈ 1.8 子,2 SE ≈ ±3.6 子。下面这行把 SE 一并打出来,
    //   免得对着一个"看起来不小"的数下结论。
    const se = 25.0 / @sqrt(@as(f64, @floatFromInt(@max(tot, 1))));
    say("  新书 {d} 胜 / {d} 负 / {d} 平(共 {d} 局)· 平均子差 {d:.2} ± {d:.1}(1 SE)· {d:.1} s",
        .{ w, l, d, tot, mg, se, secs(t0) });
    if (mg > 2.0 * se) {
        say("  ✓ 显著更强(margin > 2 SE)", .{});
    } else if (mg < -2.0 * se) {
        say("  ✗ 显著更弱 —— 这一轮的权重不要落盘", .{});
    } else {
        say("  = 在噪声内(|margin| < 2 SE = {d:.1} 子)· 胜负场数更不可信,别拿它下结论", .{ 2.0 * se });
    }
}

// ─────────────────────── 主流程 ───────────────────────

pub fn main(init: std.process.Init) !void {
    gio = init.io;
    const arena = init.arena.allocator();
    const argv = try init.minimal.args.toSlice(arena);

    var cfg = Cfg{};
    var ai: usize = 1;
    while (ai < argv.len) : (ai += 1) {
        const a = argv[ai];
        // 无值开关先判掉:下面一律按 key=value 拆
        if (std.mem.eql(u8, a, "--no-ab")) {
            cfg.no_ab = true;
            continue;
        }
        const eq = std.mem.indexOfScalar(u8, a, '=') orelse {
            say("无法识别的参数:{s}", .{a});
            return usage();
        };
        const k = a[0..eq];
        const v = a[eq + 1 ..];
        if (std.mem.eql(u8, k, "--games")) {
            cfg.games = try std.fmt.parseInt(u32, v, 10);
        } else if (std.mem.eql(u8, k, "--depth")) {
            cfg.depth = try std.fmt.parseInt(u32, v, 10);
        } else if (std.mem.eql(u8, k, "--depth0")) {
            cfg.depth0 = try std.fmt.parseInt(u32, v, 10);
        } else if (std.mem.eql(u8, k, "--load")) {
            cfg.load = v;
        } else if (std.mem.eql(u8, k, "--endgame")) {
            cfg.endgame = try std.fmt.parseInt(u32, v, 10);
        } else if (std.mem.eql(u8, k, "--open")) {
            cfg.open = try std.fmt.parseInt(u32, v, 10);
        } else if (std.mem.eql(u8, k, "--iters")) {
            cfg.iters = try std.fmt.parseInt(u32, v, 10);
        } else if (std.mem.eql(u8, k, "--cgi")) {
            cfg.cg = try std.fmt.parseInt(u32, v, 10);
        } else if (std.mem.eql(u8, k, "--mu")) {
            cfg.mu = try std.fmt.parseFloat(f32, v);
        } else if (std.mem.eql(u8, k, "--wout")) {
            cfg.w_out = try std.fmt.parseFloat(f32, v);
        } else if (std.mem.eql(u8, k, "--wboot")) {
            cfg.w_boot = try std.fmt.parseFloat(f32, v);
        } else if (std.mem.eql(u8, k, "--wexact")) {
            cfg.w_exact = try std.fmt.parseFloat(f32, v);
        } else if (std.mem.eql(u8, k, "--ab")) {
            cfg.ab = try std.fmt.parseInt(u32, v, 10);
        } else if (std.mem.eql(u8, k, "--seed")) {
            cfg.seed = try std.fmt.parseInt(u64, v, 0);
        } else if (std.mem.eql(u8, k, "--out")) {
            cfg.out = v;
        } else if (std.mem.eql(u8, k, "--ref-out")) {
            cfg.ref_out = v;
        } else {
            say("无法识别的参数:{s}", .{k});
            return usage();
        }
    }
    if (cfg.seed == 0) cfg.seed = 0x07_4E_11_0A_2026; // 'OTHELLO'

    // 起始权重:默认用嵌入的那本;--load 时从文件读(便于接着上一版继续训)。
    var base: []const u8 = weights0;
    if (cfg.load.len != 0) base = try std.Io.Dir.cwd().readFileAlloc(gio, cfg.load, arena, .limited(1 << 20));
    if (base.len != pattern.BLOB_HEADER + pattern.PHASES * pattern.ORBITS) {
        say("✗ 起始权重书长度 {d} 不对(应为 {d})", .{ base.len, pattern.BLOB_HEADER + pattern.PHASES * pattern.ORBITS });
        std.process.exit(1);
    }

    // 折叠图(orbit/sigma/orb_zero)与起始权重都来自 blob。
    if (!pattern.init(base)) {
        say("✗ pattern.init 失败(步 {d})", .{pattern.failStage});
        std.process.exit(1);
    }
    say("轨道 {d} 条/阶段 · 制 0 {d} 条 · 起始 scale {d:.6} / {d:.6}", .{ pattern.ORBITS, countZero(), pattern.scales[0], pattern.scales[1] });
    // 起始书的 scale 留一份:④ 定标时拿它当对照("手调量程"量出来是多少误差)。
    // ⚠ 必须现在抄 —— 循环结束后 installQuant 会改写 pattern.scales。
    const base_scales = pattern.scales;

    var u: [pattern.PHASES][pattern.ORBITS]f32 = undefined;
    loadFloat(base, &u);
    // 训练全程 f32:自对弈的叶子值直接读这张表,不经过 int8 查表。
    // pattern.init(base) 已经把 orbit / sigma / orb_zero 建好了,evalFloat 要用。
    search.eval_u = &u;

    const max_rows = @as(usize, cfg.games) * 62 * 3 + 4096;
    const rows = try arena.alloc(Row, max_rows);
    const log = try arena.alloc(Log, 80);
    const q = try arena.alloc(u8, pattern.PHASES * pattern.ORBITS);
    var n_rows: usize = 0; // 最后一轮的有效行数(④ 定标要用,见循环内赋值处)

    const t_all = nanos();
    for (0..cfg.iters) |iter| {
        const bootw: f32 = if (iter == 0) 0.0 else cfg.w_boot;
        const dply: u32 = if (iter == 0) cfg.depth0 else cfg.depth;
        say("\n━━ 第 {d}/{d} 轮 · 深度 {d} · 引导权重 {d:.2} ━━", .{ iter + 1, cfg.iters, dply, bootw });

        // ① 自对弈 + 摊行
        const t0 = nanos();
        search.clearTT();
        var prng = std.Random.DefaultPrng.init(cfg.seed +% iter *% 0x9E37_79B9);
        const rnd = prng.random();
        var em = Emitter{ .rows = rows, .boot_w = bootw };
        var tot_plies: u64 = 0;
        var black_diff: i64 = 0;
        var g: u32 = 0;
        while (g < cfg.games) : (g += 1) {
            const st = try playGame(cfg, dply, rnd, log, &em);
            tot_plies += st.plies;
            black_diff += st.diff;
        }
        say("  自对弈 {d} 局 · 平均 {d} 手 · 黑子差均值 {d:.1} · {d} 行({d} 丢)· {d:.1} s",
            .{
                cfg.games,
                tot_plies / cfg.games,
                @as(f64, @floatFromInt(black_diff)) / @as(f64, @floatFromInt(cfg.games)),
                em.n,
                em.dropped,
                secs(t0),
            });

        // ② 分相位(同一相位才是同一张表;两相位必须各解各的)
        const t1 = nanos();
        var fidx: usize = 0;
        var i: usize = 0;
        while (i < em.n) : (i += 1) {
            if (rows[i].phase == 0) {
                std.mem.swap(Row, &rows[i], &rows[fidx]);
                fidx += 1;
            }
        }
        const r0 = rows[0..fidx];
        const r1 = rows[fidx..em.n];
        // em 是本轮的局部变量,出循环就没了 —— 行数得先抄出来,④ 定标要用
        n_rows = em.n;
        say("  相位 0(子数 ≤34)行 {d} · 相位 1 行 {d}", .{ r0.len, r1.len });

        const x0 = try arena.alloc(f32, pattern.ORBITS);
        const x1 = try arena.alloc(f32, pattern.ORBITS);
        @memcpy(x0, &u[0]);
        @memcpy(x1, &u[1]);
        const m0 = mse(r0, x0);
        const m1 = mse(r1, x1);
        const lam0 = cfg.mu * diagMean(r0);
        const lam1 = cfg.mu * diagMean(r1);
        say("  岭 λ:{d:.4} / {d:.4} · 起始 MSE {d:.3} / {d:.3}", .{ lam0, lam1, m0, m1 });
        const t2 = nanos();
        try solveCg(arena, r0, x0, lam0, cfg.cg, true);
        try solveCg(arena, r1, x1, lam1, cfg.cg, true);
        const t3 = nanos();
        say("  拟合后 MSE {d:.3} / {d:.3} · CG {d:.2} s · 统计 {d:.2} s",
            .{ mse(r0, x0), mse(r1, x1), span(t2, t3), span(t1, t2) });

        // ③ 换权重 —— **纯 f32,不夹取、不量化**
        //    旧版在这里做 clamp + quantize + installQuant 并当场生效,
        //    已移除:那会把每一轮的量化误差喂进下一轮的自对弈标签(见文件头)。
        for (0..pattern.ORBITS) |o| {
            if (pattern.orb_zero[o] != 0) {
                // 对称性强制作 0 的轨道必须清干净:evalFloat 不像 installQuant
                // 那样跳过它们,留了残值会让 f32 求值和 int8 求值悄悄分叉
                u[0][o] = 0;
                u[1][o] = 0;
                continue;
            }
            u[0][o] = x0[o];
            u[1][o] = x1[o];
        }
        // 未夹取的幅值每轮都打:它是定 u_max 的唯一依据(PTQ 就这一个旋钮),
        // 也是"拟合到底想把权重拉到多大"的直接读数 —— 这个数以前看不到
        var mm = [_]f32{0} ** pattern.PHASES;
        for (0..pattern.ORBITS) |o| {
            if (pattern.orb_zero[o] != 0) continue;
            for (0..pattern.PHASES) |ph| {
                const v = @abs(u[ph][o]);
                if (v > mm[ph]) mm[ph] = v;
            }
        }
        say("  换权重(f32 · 不量化) · 未夹取 max|u| {d:.3} / {d:.3} 子", .{ mm[0], mm[1] });
    }

    // ④ PTQ:自动定标 + 量化 + 落盘 —— 全程只做这一次
    //    先摘掉影子表:往下全是"打量化后的产物",A/B 尤其不能带着 f32 分值打。
    search.eval_u = null;
    for (0..pattern.ORBITS) |o| {
        if (pattern.orb_zero[o] != 0) {
            u[0][o] = 0;
            u[1][o] = 0;
            continue;
        }
    }
    const cal = calibrate(rows[0..n_rows], &u, q, base_scales);
    const sc = cal.scales;

    // 对照书:同一个 f32 权重,但按**起始书那套定标**量化(quantize 内部 clamp 到 ±127
    // 等价于"先夹到 ±127·scale")。两本书只差定标 ⇒ 对打就能把"自动定标值多少"
    // 从"这一轮训练值多少"里隔离出来 —— 否则 A/B 是两个变量混在一起。
    const blob_ref = blk: {
        if (cfg.ref_out.len == 0) break :blk @as([]const u8, &.{});
        const qref = try arena.alloc(u8, pattern.PHASES * pattern.ORBITS);
        _ = quantize(u, qref, base_scales);
        const rb = try makeBlob(arena, qref, base_scales);
        try std.Io.Dir.cwd().writeFile(gio, .{ .sub_path = cfg.ref_out, .data = rb });
        say("  对照书(手调定标)已写出 {s} · scale {d:.6} / {d:.6}", .{ cfg.ref_out, base_scales[0], base_scales[1] });
        break :blk rb;
    };

    // 装一次量化表:只为让下面"落盘回读自检"有可比对象
    pattern.installQuant(q, sc);
    var ref: [pattern.PHASES][pattern.PER_PHASE]i8 = undefined;
    @memcpy(std.mem.asBytes(&ref), std.mem.asBytes(&pattern.wt));

    const blob = try makeBlob(arena, q, sc);
    try std.Io.Dir.cwd().writeFile(gio, .{ .sub_path = cfg.out, .data = blob });

    if (!pattern.init(blob)) {
        say("✗ 落盘后 init 失败(步 {d})", .{pattern.failStage});
        std.process.exit(1);
    }
    const same = std.mem.eql(u8, std.mem.asBytes(&ref), std.mem.asBytes(&pattern.wt));
    say("\n已写出 {d} 字节到 {s} · scale {d:.6} / {d:.6}", .{ blob.len, cfg.out, sc[0], sc[1] });
    say("落盘回读自检:{s}", .{if (same) "✓ 与量化后的查表逐字节相同" else "✗ 不一致(量化/折叠口径分叉)"});

    if (!cfg.no_ab and cfg.ab > 0) {
        // ⚠ 基准必须是 **base**(本次训实际用的起始书),不能写死 `weights0`。
        //   用了 `--load` 时两者是不同的书(`weights0` 是**编译期内嵌**的那本),
        //   而下面 abTest 的文案打的是"新书 vs 起始书" —— 写死 weights0 就会
        //   在报告里说一套、实际打另一套:你以为在验"比起点强了多少",
        //   其实是在验"比内嵌那本强了多少",甚至可能起点就是内嵌那本之外的第三本。
        try abTest(cfg, blob, base, "新书 vs 起始书(整体:新一轮训练 + 自动定标)");
        // 第二组:两本书**只差定标**(同一个 f32 权重)⇒ 这一组才是在量"自动定标值多少"
        if (blob_ref.len > 0) try abTest(cfg, blob, blob_ref, "自动定标 vs 手调定标(同一个 f32 权重,只差定标)");
    }
    say("\n总用时 {d:.1} s", .{secs(t_all)});
    if (!same) std.process.exit(1);
}

fn usage() void {
    say(
        \\用法:train [--games=N] [--depth=N] [--depth0=N] [--endgame=N] [--open=N]
        \\            [--iters=N] [--cgi=N] [--mu=F] [--wout=F] [--wboot=F]
        \\            [--wexact=F] [--ab=N] [--seed=N] [--out=path]
        \\            [--ref-out=path] [--load=path] [--no-ab]
        \\
        \\  --games   每轮自对弈局数(默认 300)
        \\  --depth   第 1 轮起的自对弈深度(默认 6)
        \\  --depth0  第 0 轮的深度(默认 2;权重为 0 时深搜不剪枝,一盘要 60 s)
        \\  --endgame 空位 ≤ 此值时走完全求解,顺带得到精确标签(默认 10)
        \\  --open    开局随机步数,保证对局多样(默认 6)
        \\  --iters   外层轮次(默认 3)
        \\  --cgi     共轭梯度最大迭代数(默认 400)
        \\  --mu      岭正则系数,相对正规矩阵对角均值(默认 0.1)
        \\  --wout/--wboot/--wexact  三路标签的样本权重
        \\  (量化量程**没有**旋钮:scale 由 PTQ 在最后自动定标,
        \\   扫一组候选取评估误差最小者,日志里会打出整条取舍曲线)
        \\  --ab      训练后 A/B 成对局数(默认 40)
        \\  --out     权重落盘路径(默认 src/zig/weights.bin)
        \\  --ref-out 额外落一本**对照书**:同一个 f32 权重、但用起始书那套定标。
        \\            两本只差定标 ⇒ 对打即可把"自动定标值多少"隔离出来
        \\  --load    起始权重书路径(默认用嵌入的那本,即上一版落盘的)
        \\
    , .{});
}
