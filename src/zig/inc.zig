// ============================================================
// 增量模式槽号(④ 增量评估的候选实现)+ **搜索同形**的验证驱动。
//
// 背景(为什么这个文件长这样):④ 首轮施工"原生线性对拍正确、wasm 槽号
// 状态漂移",回退(见 docs/engine-improvement-plan.md 完成记录)。当时的原生
// 验证是**线性对局逐步对拍**,而搜索对增量状态的真实用法是:
//   · 一份状态被**兄弟子树反复复用**(每个着法都从父状态出发增量一次);
//   · 每落一手**行棋方就换**,槽号的 1(己)/2(敌)语义整体翻转;
//   · 迭代加深**从根反复重降**,上一层留下的状态必须被根重置盖掉。
// 线性对局对"复用污染"这类漂移盖不住,所以验证驱动做成和 search() 同形:
// 每个节点「快照 → 增量 → 递归 → 恢复」,原生与 wasm 跑**同一份代码**
// (incprobe.zig 把 dfsCheck 导出给 tools/probe-inc.mjs)。
//
// ── 关键教训(本文件的第一次实现就被自己的对拍当场打回)──────────────
//   计划里"落子只改受影响表(落点 +2w、翻子格 −1w)"按字面理解是**错的**:
//   槽号是**行棋方视角**编码,每落一手行棋方就换 —— 不止落点/翻子格,
//   盘上**所有有子格子**的 1↔2 全部互换(翻子格反而是唯一不变的:它从
//   "旧视角的 2"变"新视角的 2")。想在行棋方视角里做局部增量,就得给
//   38 张表各配一张"1↔2 换色"反色下标表 —— 那正是红线 2 拒收的
//   Egaroucid irp(78 KB)。
//
//   ✅ 正确姿势:**固定帧属方视角**维护槽号(1=帧属方的子,2=对方的子,
//     与谁行棋无关)。帧属方任取一个固定参照玩家即可 —— 生产搜索里取
//     **根行棋方**(搜索全程不知道绝对颜色,也不用知道):
//     · 落子只动落点(空→属方 +1w / 空→对方 +2w)与翻子格(互换 ±1w),
//       其余格子**真的**不动 —— 局部增量成立;
//     · 虚着一格都不变,连重算都不用,只流行棋方记账翻转;
//     · 行棋方视角的求值 = (行棋方是帧属方 ? +1 : −1) × Σ wt[帧属方视角槽]。
//       符号精确性的根据是折叠对称性 W(换色·s) = −W(s)(train 折叠按轨道
//       建表时强制,probe-wasm C 节逐局面验证)—— int8 权重取负无舍入,
//       所以"固定视角 + 符号"与"全量行棋方视角重算"**逐位相等**。
//
// ── 对拍铁律 ──
//   一律比**整数**(槽号、加权和),不比浮点(格式化/舍入噪声会掩盖真差异,
//   这是 probe-eval 立过的规矩)。signSumInt 就是 ④ 落地后叶子求值的全部
//   成本:38 次查表求和 + 一次按行棋方取号,相位由子数决定。
// ============================================================
const std = @import("std");
const rules = @import("rules.zig");
const pattern = @import("pattern.zig");

pub const PTN_COUNT = pattern.PTN_COUNT;

/// 每格 → 4 组 (表号 0-based, 3^位序)。格子恰被 4 张表覆盖
/// (256 = 64×4,pattern.zig 头注的"覆盖完整"证据)。
/// 运行时生成而不是 comptime 物化:1.5 KB 的表 comptime 会进 rodata,
/// 按体积汇率 ≈ +460 B gzip;照 orbit/sigma 的先例放 BSS,0 文件成本。
pub threadlocal var cell_ptn: [64][4]u8 = undefined;
pub threadlocal var cell_pow: [64][4]u32 = undefined;
pub var tables_ready: bool = false;

/// 从 pattern.model 派生每格特征表。**必须先于一切增量操作调用**
/// (probeInit / 单测的开头都调;幂等)。
pub fn initTables() void {
    for (0..64) |sq| {
        var n: usize = 0;
        for (1..PTN_COUNT + 1) |p| {
            for (0..pattern.model.len[p]) |k| {
                if (pattern.model.cells[pattern.model.cell_off[p] + k] != sq) continue;
                if (n >= 4) @panic("每格特征数超过 4,模式表几何被改坏");
                cell_ptn[sq][n] = @intCast(p - 1); // slots[] 是 0-based
                // 3^k:表内位序的幂(与 model 的 POW3 同源,k ≤ 8)
                var w: u32 = 1;
                for (0..k) |_| w *= 3;
                cell_pow[sq][n] = w;
                n += 1;
            }
        }
        if (n != 4) @panic("每格特征数不足 4,模式表几何被改坏");
    }
    tables_ready = true;
}

/// 懒建表:任何线程首次走增量路径前调一次即可(threadlocal 表,线程各自建)。
/// 挂在 search 的公开入口上 —— train 的 A/B 分片线程这类"没经过
/// engineInit 的调用方"因此不需要各自接初始化。
pub inline fn ensureTables() void {
    if (!tables_ready) initTables();
}

/// 增量槽号状态。slots[i] = 第 i 张表的**帧属方视角**全局槽号
/// (把棋盘当成"帧属方是行棋方"喂给 pattern.slotIndices 的口径)。
/// 帧属方 = 任意固定的参照玩家:生产搜索里取**根行棋方**(搜索全程不知道
/// 绝对颜色),探针里取黑方。行棋方语义只在求值时用一个符号位折回来。
pub const State = struct {
    slots: [PTN_COUNT]u32 = undefined,
    discs: u32 = 0, // 子数记账,只喂 phaseOf
    home_to_move: bool = true, // 行棋方是否为帧属方:符号位 + 虚着的全部成本
};

/// 全量重算(开局 / 根重置走这里)。home_to_move 由调用方记账 ——
/// Board 的 own/opp 本身不带颜色,这个参数就是"own 是不是帧属方"。
pub fn set(b: rules.Board, home_to_move: bool, s: *State) void {
    const black = if (home_to_move) b.own else b.opp;
    const white = if (home_to_move) b.opp else b.own;
    pattern.slotIndices(.{ .own = black, .opp = white }, &s.slots);
    s.discs = b.discs();
    s.home_to_move = home_to_move;
}

/// 落子增量(固定帧属方视角,与谁在行棋无关、不需要任何换色表):
///   落点:空 → 帧属方 +1w / 空 → 对方 +2w;
///   翻子格:颜色互换,属方→对方 +1w、对方→属方 −1w;
///   其余格子(包括双方所有不受影响的子)**真的**一格不动。
/// f 必须是同一局面上 rules.flips(b, sq) 的结果(与搜索的着法生成共用)。
pub fn moveUpdate(s: *State, sq: u6, f: u64, by_home: bool) void {
    addCell(s, sq, if (by_home) 1 else 2);
    const fd: i32 = if (by_home) -1 else 1; // 落属方翻对方(2→1)为负,反之(1→2)为正
    var ff = f;
    while (ff != 0) {
        const c: u6 = @intCast(@ctz(ff));
        ff &= ff - 1;
        addCell(s, c, fd);
    }
    s.discs += 1;
    s.home_to_move = !by_home; // 落子后换行棋方(虚着另记)
}

/// 落子增量的精确逆(撤销用)。存在意义:如果 ④ 落地时选择
/// "单工作缓冲 + undo"而不是 per-ply 快照,可逆性是前提。
/// (该方案在 search.zig 实测过:行为逐位一致但慢 ~15%,已否决留档;
/// undoMoveUpdate 与其单测保留,undo 语义本身仍被 dfsCheck 依赖。)
pub fn undoMoveUpdate(s: *State, sq: u6, f: u64, by_home: bool) void {
    addCell(s, sq, if (by_home) -1 else -2);
    const fd: i32 = if (by_home) 1 else -1;
    var ff = f;
    while (ff != 0) {
        const c: u6 = @intCast(@ctz(ff));
        ff &= ff - 1;
        addCell(s, c, fd);
    }
    s.discs -= 1;
    s.home_to_move = by_home;
}

/// 虚着:棋盘一格不变,只流行棋方翻转 —— 这就是固定视角换来的第四份红利。
pub fn passFlip(s: *State) void {
    s.home_to_move = !s.home_to_move;
}

inline fn addCell(s: *State, sq: u6, d: i32) void {
    // i64 中转:增量 ≤2w(13122)不会把合法状态推出 u32,但漂移状态下的
    // 回绕应该在对拍处爆炸,而不是在这里静默。
    for (0..4) |i| {
        const v = @as(i64, s.slots[cell_ptn[sq][i]]) + @as(i64, d) * @as(i64, cell_pow[sq][i]);
        s.slots[cell_ptn[sq][i]] = @intCast(v);
    }
}

/// 全量重算并与增量状态比对(黑方视角口径)。null = 一致;
/// 非 null = 首个不一致处:0..37 为表号,38 = 子数记账漂移。
/// 注意:行棋方记账(home_to_move)对不上时不在这里炸 —— 它会在
/// sumInt vs evalInt 的符号位上炸(两种口径对不上的局面必然和不等)。
pub fn firstMismatch(b: rules.Board, s: *const State) ?u8 {
    if (b.discs() != s.discs) return 38;
    var t: [PTN_COUNT]u32 = undefined;
    const black = if (s.home_to_move) b.own else b.opp;
    const white = if (s.home_to_move) b.opp else b.own;
    pattern.slotIndices(.{ .own = black, .opp = white }, &t);
    for (0..PTN_COUNT) |i| {
        if (t[i] != s.slots[i]) return @intCast(i);
    }
    return null;
}

/// 增量状态的整数加权和(**行棋方视角**)—— ④ 落地后叶子求值的全部成本:
/// 38 次查表求和 + 按帧属方取号。符号的精确性依据 = 折叠对称性
/// W(换色·s) = −W(s)(int8 取负无舍入,详见文件头注)。
pub fn sumInt(s: *const State) i32 {
    const tab = &pattern.wt[pattern.phaseOf(s.discs)];
    var sum: i32 = 0;
    inline for (0..PTN_COUNT) |i| sum += tab[s.slots[i]];
    return if (s.home_to_move) sum else -sum;
}

// ───────────────────── 搜索同形 DFS 验证驱动 ─────────────────────

pub const DFS_NODE_CAP: u64 = 2_000_000; // 兜底:有 bug 时别把探针挂死

pub var dfs_nodes: u64 = 0;
pub var dfs_bad: u64 = 0; // 槽号不一致的节点数
pub var dfs_eval_bad: u64 = 0; // 加权和不一致的节点数
pub var dfs_passes: u64 = 0; // 走到虚着分支的节点数
pub var dfs_capped: bool = false;
// 首个不一致的细节(排障用)
pub var dfs_bad_ptn: u32 = 0;
pub var dfs_bad_expect: u32 = 0;
pub var dfs_bad_got: u32 = 0;
pub var dfs_eval_expect: i32 = 0;
pub var dfs_eval_got: i32 = 0;

pub fn resetStats() void {
    dfs_nodes = 0;
    dfs_bad = 0;
    dfs_eval_bad = 0;
    dfs_passes = 0;
    dfs_capped = false;
    dfs_bad_ptn = 0;
    dfs_bad_expect = 0;
    dfs_bad_got = 0;
    dfs_eval_expect = 0;
    dfs_eval_got = 0;
}

fn checkNode(b: rules.Board, s: *const State) void {
    if (firstMismatch(b, s)) |p| {
        dfs_bad += 1;
        if (dfs_bad == 1) {
            dfs_bad_ptn = p;
            if (p < PTN_COUNT) {
                var t: [PTN_COUNT]u32 = undefined;
                const black = if (s.home_to_move) b.own else b.opp;
                const white = if (s.home_to_move) b.opp else b.own;
                pattern.slotIndices(.{ .own = black, .opp = white }, &t);
                dfs_bad_expect = t[p];
                dfs_bad_got = s.slots[p];
            }
        }
    }
    if (pattern.ready) {
        const a = sumInt(s);
        const c = pattern.evalInt(b);
        if (a != c) {
            dfs_eval_bad += 1;
            if (dfs_eval_bad == 1) {
                dfs_eval_expect = c;
                dfs_eval_got = a;
            }
        }
    }
}

/// 与 search() 同形的验证遍历:每个节点
///   「快照状态 → 增量落子 → 递归 → 恢复状态」,
/// 兄弟子树共用同一份父状态 —— 线性对拍盖不住的"复用污染"只有这种遍历能打中。
/// 虚着分支与 search 一致:不消耗深度;固定视角下状态零成本,只翻行棋方。
/// 契约:b 的行棋方 = s.home_to_move(与未来 search 的接法一致;
/// 记账说谎会在 checkNode 的 evalInt 对拍处现形)。
pub fn dfsCheck(b: rules.Board, depth: u32, s: *State) void {
    dfs_nodes += 1;
    if (dfs_nodes > DFS_NODE_CAP) {
        dfs_capped = true;
        return;
    }
    checkNode(b, s);
    if (depth == 0 or dfs_capped) return;

    const m = rules.moves(b);
    if (m == 0) {
        const sw = rules.Board{ .own = b.opp, .opp = b.own };
        if (rules.moves(sw) == 0) return; // 终局
        dfs_passes += 1;
        const saved = s.*;
        passFlip(s);
        dfsCheck(sw, depth, s);
        s.* = saved;
        return;
    }
    var mm = m;
    while (mm != 0) {
        const sq: u6 = @intCast(@ctz(mm));
        mm &= mm - 1;
        const f = rules.flips(b, sq);
        const saved = s.*;
        moveUpdate(s, sq, f, s.home_to_move);
        dfsCheck(rules.playMove(b, sq, f), depth - 1, s);
        s.* = saved; // 恢复:兄弟着法从**父状态**重新出发
        if (dfs_capped) return;
    }
}

/// 随机走到中途的局面(合法对局意义下,不是乱撒子)。仅验证用。
pub fn randomMidgame(rnd: std.Random) ?rules.Board {
    var b = rules.Board.initial;
    var steps = rnd.intRangeLessThan(u32, 3, 58);
    while (steps > 0) : (steps -= 1) {
        const m = rules.moves(b);
        if (m == 0) {
            const sw = rules.Board{ .own = b.opp, .opp = b.own };
            if (rules.moves(sw) == 0) return null;
            b = sw;
            continue;
        }
        var k = rnd.intRangeLessThan(u32, 0, @as(u32, @popCount(m)));
        var mm = m;
        var sq: u6 = 0;
        while (true) {
            sq = @intCast(@ctz(mm));
            if (k == 0) break;
            mm &= mm - 1;
            k -= 1;
        }
        b = rules.play(b, sq);
    }
    return b;
}

// ───────────────────── 原生单元测试 ─────────────────────

const weights = @embedFile("weights.bin");

fn setup() void {
    initTables();
    if (!pattern.ready) {
        if (!pattern.init(weights)) @panic("weights.bin 装载失败");
    }
}

test "增量特征表:每格恰 4 条,且与 pattern.model 几何逐项一致" {
    initTables();
    for (0..64) |sq| {
        for (0..4) |i| {
            const p = cell_ptn[sq][i];
            const k = cell_pow[sq][i];
            // 反查:model 里该表该幂次上的格子必须是 sq
            var ok = false;
            for (1..PTN_COUNT + 1) |q| {
                if (q - 1 != p) continue;
                for (0..pattern.model.len[q]) |kk| {
                    var w: u32 = 1;
                    for (0..kk) |_| w *= 3;
                    if (w == k and pattern.model.cells[pattern.model.cell_off[q] + kk] == sq) ok = true;
                }
            }
            try std.testing.expect(ok);
        }
    }
}

test "增量槽号:线性随机对局逐 ply 与全量对拍(槽号 + 带符号整数和)" {
    setup();
    var prng = std.Random.DefaultPrng.init(0x1AC_2026_0920);
    const rnd = prng.random();
    var passes: u32 = 0;
    var plies: u32 = 0;
    var dmin: u32 = 64;
    var dmax: u32 = 0;
    for (0..40) |_| {
        var b = rules.Board.initial;
        var s: State = .{};
        set(b, true, &s); // 黑先
        var gp: u32 = 0; // 每局独立手数上限:总手数才能上千
        while (gp < 70) : (gp += 1) {
            try std.testing.expectEqual(@as(?u8, null), firstMismatch(b, &s));
            try std.testing.expectEqual(pattern.evalInt(b), sumInt(&s));
            const m = rules.moves(b);
            if (m == 0) {
                const sw = rules.Board{ .own = b.opp, .opp = b.own };
                if (rules.moves(sw) == 0) break;
                passes += 1;
                b = sw;
                passFlip(&s); // 固定视角:虚着只流行棋方
                continue;
            }
            var k = rnd.intRangeLessThan(u32, 0, @as(u32, @popCount(m)));
            var mm = m;
            var sq: u6 = 0;
            while (true) {
                sq = @intCast(@ctz(mm));
                if (k == 0) break;
                mm &= mm - 1;
                k -= 1;
            }
            const f = rules.flips(b, sq);
            moveUpdate(&s, sq, f, s.home_to_move);
            b = rules.playMove(b, sq, f);
            plies += 1;
            dmin = @min(dmin, b.discs());
            dmax = @max(dmax, b.discs());
        }
    }
    try std.testing.expect(plies > 1000);
    try std.testing.expect(dmin <= 24 and dmax >= 44); // 三个相位都被踩过
}

test "增量槽号:搜索同形 DFS,兄弟子树复用无漂移" {
    setup();
    var prng = std.Random.DefaultPrng.init(0xDF5_2026_0920);
    const rnd = prng.random();
    var total: u64 = 0;
    var roots2: u32 = 0; // 根分支数 ≥ 2 的局面数(复用路径真的被踩到)
    for (0..12) |_| {
        const b = randomMidgame(rnd) orelse continue;
        var s: State = .{};
        set(b, true, &s);
        resetStats();
        dfsCheck(b, 4, &s);
        try std.testing.expectEqual(@as(u64, 0), dfs_bad);
        try std.testing.expectEqual(@as(u64, 0), dfs_eval_bad);
        try std.testing.expect(!dfs_capped);
        try std.testing.expect(dfs_nodes > 20); // 残局浅树可能很小,总量另有下限
        if (rules.moves(b) >= 2) roots2 += 1;
        total += dfs_nodes;
    }
    try std.testing.expect(roots2 >= 8);
    try std.testing.expect(total > 5000);
}

test "增量槽号:虚着局面为根的 DFS 走到 pass 分支且无漂移" {
    setup();
    var prng = std.Random.DefaultPrng.init(0xCA55_2026);
    const rnd = prng.random();
    var found: u32 = 0;
    var guard: u32 = 0;
    while (found < 3 and guard < 4000) : (guard += 1) {
        const b = (randomMidgame(rnd) orelse continue);
        // 找"行棋方无子可走、对方有"的局面:根节点必然进虚着分支
        if (rules.moves(b) != 0) continue;
        const sw = rules.Board{ .own = b.opp, .opp = b.own };
        if (rules.moves(sw) == 0) continue;
        var s: State = .{};
        set(b, true, &s);
        resetStats();
        dfsCheck(b, 3, &s);
        try std.testing.expectEqual(@as(u64, 0), dfs_bad);
        try std.testing.expectEqual(@as(u64, 0), dfs_eval_bad);
        try std.testing.expect(dfs_passes >= 1);
        found += 1;
    }
    try std.testing.expectEqual(@as(u32, 3), found);
}

test "增量槽号:落子增量被反向增量精确还原" {
    setup();
    var prng = std.Random.DefaultPrng.init(0xFA11_2026);
    const rnd = prng.random();
    var tries: u32 = 0;
    while (tries < 200) {
        const b = randomMidgame(rnd) orelse continue;
        const m = rules.moves(b);
        if (m == 0) continue;
        var k = rnd.intRangeLessThan(u32, 0, @as(u32, @popCount(m)));
        var mm = m;
        var sq: u6 = 0;
        while (true) {
            sq = @intCast(@ctz(mm));
            if (k == 0) break;
            mm &= mm - 1;
            k -= 1;
        }
        var s: State = .{};
        set(b, true, &s);
        const saved = s;
        const f = rules.flips(b, sq);
        moveUpdate(&s, sq, f, true);
        undoMoveUpdate(&s, sq, f, true);
        try std.testing.expectEqual(saved.slots, s.slots);
        try std.testing.expectEqual(saved.discs, s.discs);
        try std.testing.expectEqual(saved.home_to_move, s.home_to_move);
        tries += 1;
    }
}
