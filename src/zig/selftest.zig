// 原生自测 / 基准。**不参与 wasm** —— 只是让"规则对不对、折叠对不对、求值多快"
// 这三件事能在命令行上问清楚。
//
// ⚠ Zig 0.16 的破坏性变更(逐个踩过,写在这儿省得下次再查):
//   ① 入口是 `pub fn main(init: std.process.Init)`,参数从 init.minimal.args 拿;
//      `std.process.argsAlloc` 已从标准库整体删除。
//   ② 文件系统搬到 `std.Io.Dir`(`std.fs.Dir` 没了),读写都要传 Io 实例:
//        std.Io.Dir.cwd().readFileAlloc(io, path, gpa, .limited(n))
//        std.Io.Dir.cwd().writeFile(io, .{ .sub_path = ..., .data = ... })
//   ③ `std.time.Timer` 没了,计时走 `std.Io.Timestamp.now(io, .awake)`。
//   ④ `Step.dependOn` 返回 void,不能链式调用两遍。
//
// 子命令:
//   selftest                      规则 perft + 折叠自检 + 求值基准
//   selftest oracle <dir>         与 tools/oracle-fold.mjs 的落盘结果逐位对拍
//   selftest slots <out> [n]      造 n 个随机中途局面 + 38 个槽号(供 JS 重算对拍)
//   selftest geodump <out>        倒出 comptime 建出的几何表(供 JS 逐项对拍)
//   selftest evaldump <out> [n]   倒出局面 + 槽号 + 整数加权和(供 JS 重算求值)
//   selftest bench [轮数]         只跑基准
const std = @import("std");
const rules = @import("rules.zig");
const pattern = @import("pattern.zig");
const search = @import("search.zig");

const weights = @embedFile("weights.bin");

var gio: std.Io = undefined;
var failed: bool = false;

fn say(comptime fmt: []const u8, args: anytype) void {
    std.debug.print(fmt ++ "\n", args);
}

fn check(ok: bool, comptime what: []const u8, args: anytype) void {
    std.debug.print("  {s} ", .{if (ok) "✓" else "✗"});
    std.debug.print(what ++ "\n", args);
    if (!ok) failed = true;
}

pub fn main(init: std.process.Init) !void {
    gio = init.io;
    const arena = init.arena.allocator();
    const argv = try init.minimal.args.toSlice(arena);
    const cmd = if (argv.len > 1) argv[1] else "all";

    if (std.mem.eql(u8, cmd, "oracle")) {
        if (argv.len < 3) return say("用法:selftest oracle <dir>", .{});
        try oracleCheck(arena, argv[2]);
        return;
    }
    if (std.mem.eql(u8, cmd, "slots")) {
        if (argv.len < 3) return say("用法:selftest slots <out> [n]", .{});
        const n: u32 = if (argv.len > 3) try std.fmt.parseInt(u32, argv[3], 10) else 400;
        try dumpSlots(arena, argv[2], n);
        return;
    }
    if (std.mem.eql(u8, cmd, "exact")) {
        if (argv.len < 3) return say("用法:selftest exact <out> [n] [空位下限] [空位上限]", .{});
        const n: u32 = if (argv.len > 3) try std.fmt.parseInt(u32, argv[3], 10) else 60;
        const lo: u32 = if (argv.len > 4) try std.fmt.parseInt(u32, argv[4], 10) else 8;
        const hi: u32 = if (argv.len > 5) try std.fmt.parseInt(u32, argv[5], 10) else 12;
        try exactDump(arena, argv[2], n, lo, hi);
        return;
    }
    if (std.mem.eql(u8, cmd, "geodump")) {
        if (argv.len < 3) return say("用法:selftest geodump <out>", .{});
        try geoDump(arena, argv[2]);
        return;
    }
    if (std.mem.eql(u8, cmd, "evaldump")) {
        if (argv.len < 3) return say("用法:selftest evaldump <out> [n]", .{});
        const n: u32 = if (argv.len > 3) try std.fmt.parseInt(u32, argv[3], 10) else 500;
        try evalDump(arena, argv[2], n);
        return;
    }
    if (std.mem.eql(u8, cmd, "sbench")) {
        if (argv.len < 4) return say("用法:selftest sbench <权重书> <深度> [局面数]", .{});
        const d: u32 = try std.fmt.parseInt(u32, argv[3], 10);
        const n: u32 = if (argv.len > 4) try std.fmt.parseInt(u32, argv[4], 10) else 24;
        try searchBench(arena, argv[2], d, n);
        return;
    }
    if (std.mem.eql(u8, cmd, "bench")) {
        const n: u32 = if (argv.len > 2) try std.fmt.parseInt(u32, argv[2], 10) else 200_000;
        try bench(n);
        return;
    }

    try ruleChecks();
    try foldChecks();
    try bench(200_000);
    if (failed) {
        say("\n✗ 自测未通过", .{});
        std.process.exit(1);
    }
    say("\n✓ 自测通过", .{});
}

/// 把局面按 16 元群的第 g 个元素变换:g < 8 是几何(不改颜色),
/// g ≥ 8 是"几何 + 换色"。几何表必须与 pattern.zig 的 geoPt **同一张** ——
/// 两边不一致的话这条断言会以"看起来像折叠写错了"的样子失败。
fn geoBoard(b: rules.Board, g: usize) rules.Board {
    const t = g & 7;
    const swap = g >= 8;
    var own: u64 = 0;
    var opp: u64 = 0;
    for (0..64) |sq| {
        const bit = @as(u64, 1) << @intCast(sq);
        if ((b.own | b.opp) & bit == 0) continue;
        const r = sq / 8;
        const c = sq % 8;
        const p = switch (t) {
            0 => [2]usize{ r, c },
            1 => [2]usize{ c, 7 - r },
            2 => [2]usize{ 7 - r, 7 - c },
            3 => [2]usize{ 7 - c, r },
            4 => [2]usize{ c, r },
            5 => [2]usize{ 7 - c, 7 - r },
            6 => [2]usize{ 7 - r, c },
            else => [2]usize{ r, 7 - c },
        };
        const dst = @as(u64, 1) << @intCast(p[0] * 8 + p[1]);
        if (b.own & bit != 0) {
            if (swap) opp |= dst else own |= dst;
        } else {
            if (swap) own |= dst else opp |= dst;
        }
    }
    return .{ .own = own, .opp = opp };
}

fn ruleChecks() !void {
    say("规则(位棋盘 + perft)", .{});
    const want = [_]u64{ 4, 12, 56, 244, 1396, 8200, 55092, 390216 };
    for (want, 1..) |w, d| {
        const got = rules.perft(rules.Board.initial, @intCast(d));
        check(got == w, "perft({d}) = {d}", .{ d, got });
    }
    // 满盘:双方都无棋可走,必须立刻判终局,不能无限递归
    const full = rules.Board{ .own = 0, .opp = ~@as(u64, 0) };
    check(rules.moves(full) == 0, "满盘无着法", .{});
    check(rules.perft(full, 3) == 1, "满盘 perft 立即终局", .{});
}

fn foldChecks() !void {
    say("\n折叠(D4 × C2,16 元)", .{});
    const ok = pattern.init(weights);
    check(ok, "weights.bin 载入({d} 字节,失败步 {d},轨道数 {d})", .{ weights.len, pattern.failStage, pattern.dbgNext });
    if (!ok) return;

    say("  · 槽数/阶段 = {d}(comptime 断言),总槽 = {d}", .{ pattern.PER_PHASE, @as(usize, pattern.PER_PHASE) * pattern.PHASES });

    // ① 被对称性强制作 0 的轨道,查表里必须真的是 0
    var nz: u32 = 0;
    var nchk: u32 = 0;
    for (0..pattern.ORBITS) |o| {
        if (pattern.orb_zero[o] == 0) continue;
        for (0..pattern.PER_PHASE) |sl| {
            if (pattern.orbit[sl] != o) continue;
            nchk += 1;
            if (pattern.wt[0][sl] != 0 or pattern.wt[1][sl] != 0) nz += 1;
        }
    }
    check(nz == 0, "制 0 轨道共 {d} 个查表项,全为 0", .{nchk});

    // ② **16 元对称不变性** —— 这是折叠这件事的全部意义所在,也是最强的一条断言:
    //     几何操作 g:W(g·p) = +W(p)
    //     换色     c:W(c·p) = −W(p)
    //    只要轨道图/符号有一处建错,这条立刻炸。
    //    (权重书是训出来的,不再是全零,所以不能再拿"恒为 0"当体检 —— 那只会
    //     在换成真书之后变成假失败。)
    var inv_bad: u32 = 0;
    var tried: u32 = 0;
    var b = rules.Board.initial;
    for (0..8) |_| {
        const mm = rules.moves(b);
        if (mm == 0) break;
        b = rules.play(b, @intCast(@ctz(mm)));
    }
    for (0..16) |g| {
        const gp = geoBoard(b, g);
        const want = if (g < 8) pattern.eval(b) else -pattern.eval(b);
        if (pattern.eval(gp) != want) inv_bad += 1;
        tried += 1;
    }
    check(inv_bad == 0, "16 元对称不变性({d} 个像全部对得上)", .{tried});

    var ocnt = [_]u32{0} ** (pattern.ORBITS + 1);
    for (0..pattern.PER_PHASE) |s| ocnt[pattern.orbit[s]] += 1;
    var hist = [_]u32{0} ** 65;
    for (0..pattern.ORBITS) |i| {
        if (ocnt[i] == 0) {
            check(false, "轨道 {d} 没有任何成员", .{i});
            return;
        }
        hist[ocnt[i]] += 1;
    }
    say("  · 轨道大小直方图:2→{d}, 4→{d}, 8→{d}, 16→{d}", .{ hist[2], hist[4], hist[8], hist[16] });
    check(hist[2] == 1 and hist[4] == 89 and hist[8] == 2068 and hist[16] == 7317, "轨道大小分布与 oracle 一致", .{});
}

/// 与 JS oracle 的逐槽对拍。两边都按「最小像 + 代表升序编号」的规则编号,
/// 所以 orbit / sigma 两张表应当**逐位相同**,不做任何"松弛比较"。
fn oracleCheck(arena: std.mem.Allocator, dir: []const u8) !void {
    say("与 tools/oracle-fold.mjs 对拍({s})", .{dir});
    const orbitRef = try readFile(arena, dir, "orbcanon.u16", pattern.PER_PHASE * 2);
    const sigRef = try readFile(arena, dir, "sigmacanon.i8", pattern.PER_PHASE);
    const zeroRef = try readFile(arena, dir, "zerocanon.u8", pattern.PER_PHASE);

    if (!pattern.init(weights)) {
        say("✗ pattern.init 失败(步 {d},轨道数 {d})", .{ pattern.failStage, pattern.dbgNext });
        std.process.exit(1);
    }

    var orbitBad: u32 = 0;
    var sigBad: u32 = 0;
    var zSlots: u32 = 0;
    for (0..pattern.PER_PHASE) |s| {
        const r: u16 = @as(u16, orbitRef[s * 2]) | (@as(u16, orbitRef[s * 2 + 1]) << 8);
        if (pattern.orbit[s] != r) orbitBad += 1;
        if (pattern.sigma[s] != @as(i8, @bitCast(sigRef[s]))) sigBad += 1;
        if (zeroRef[s] != 0) zSlots += 1;
    }
    check(orbitBad == 0, "轨道号逐位相同({d} 处不一致)", .{orbitBad});
    check(sigBad == 0, "符号 σ 逐位相同({d} 处不一致)", .{sigBad});

    var zset = [_]u8{0} ** pattern.ORBITS;
    for (0..pattern.PER_PHASE) |s| {
        if (zeroRef[s] != 0) zset[pattern.orbit[s]] = 1;
    }
    var n: u32 = 0;
    for (0..pattern.ORBITS) |i| n += zset[i];
    say("  · 被标记的槽 {d} 个,落在 {d} 条轨道里", .{ zSlots, n });
    check(n == 248, "被对称性强制作 0 的轨道数 = 248(实得 {d})", .{n});

    if (failed) std.process.exit(1);
    say("✓ 折叠与 JS oracle 完全一致", .{});
}

fn readFile(arena: std.mem.Allocator, dir: []const u8, name: []const u8, want: usize) ![]u8 {
    const p = try std.fs.path.join(arena, &.{ dir, name });
    const b = try std.Io.Dir.cwd().readFileAlloc(gio, p, arena, .limited(1 << 24));
    if (b.len != want) {
        std.debug.print("✗ {s} 长度 {d} ≠ 预期 {d}\n", .{ name, b.len, want });
        std.process.exit(1);
    }
    return b;
}

/// 随机走到"空位数落在 [lo,hi]"的残局,完全求解后把局面 + 分值倒出来。
/// 这是 search/规则/终局记分三者**唯一能逐位对拍**的地方:完全求解只输出精确子差,
/// 不吃启发式评估,所以 Zig 与主分支 JS 引擎的结论必须一模一样。
fn exactDump(arena: std.mem.Allocator, outPath: []const u8, count: u32, lo: u32, hi: u32) !void {
    if (!pattern.init(weights)) {
        say("✗ pattern.init 失败(步 {d})", .{pattern.failStage});
        std.process.exit(1);
    }
    const out = try arena.alloc(u8, @as(usize, count) * 160 + 64);
    var n: usize = 0;
    var prng = std.Random.DefaultPrng.init(0xBADC0FFE_5EED);
    const rnd = prng.random();

    var done: u32 = 0;
    var guard: u32 = 0;
    while (done < count and guard < count * 400) : (guard += 1) {
        var b = rules.Board.initial;
        var own_black = true;
        // 先快进到接近残局
        const target = lo + rnd.intRangeLessThan(u32, 0, hi - lo + 1);
        var steps: u32 = 64 - target - 4;
        while (steps > 0) : (steps -= 1) {
            const m = rules.moves(b);
            if (m == 0) {
                b = rules.Board{ .own = b.opp, .opp = b.own };
                own_black = !own_black;
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
            own_black = !own_black;
        }
        const empties = 64 - b.discs();
        if (empties < lo or empties > hi) continue;
        if (rules.moves(b) == 0) {
            const sw = rules.Board{ .own = b.opp, .opp = b.own };
            if (rules.moves(sw) == 0) continue;
            b = sw;
            own_black = !own_black;
        }
        const score = search.solveExact(b);
        var tmp: [160]u8 = undefined;
        // 主分支 JS 的 __setPosition 收 (blo,bhi,wlo,whi,'b'),所以这里要拆回绝对颜色
        const blo = if (own_black) @as(u32, @truncate(b.own)) else @as(u32, @truncate(b.opp));
        const bhi = if (own_black) @as(u32, @truncate(b.own >> 32)) else @as(u32, @truncate(b.opp >> 32));
        const wlo = if (own_black) @as(u32, @truncate(b.opp)) else @as(u32, @truncate(b.own));
        const whi = if (own_black) @as(u32, @truncate(b.opp >> 32)) else @as(u32, @truncate(b.own >> 32));
        // ⚠ 必须把"该谁走"一起写出去:只写黑白两个位板是不够的 ——
        //   同一个摆法,黑先和白先是**两个不同的局面**,分值互为反号。
        //   漏了这一列,对拍脚本会拿"算了白先的 Zig"去比"算了黑先的 JS",
        //   表现是"约三成局面不一致",极容易误判成搜索写错了(踩过)。
        const side: u8 = if (own_black) 1 else 2;
        const t = try std.fmt.bufPrint(&tmp, "{d} {d} {d} {d} {d} {d} {d}\n", .{ blo, bhi, wlo, whi, side, empties, @as(i32, @intFromFloat(score)) });
        @memcpy(out[n .. n + t.len], t);
        n += t.len;
        done += 1;
    }
    try std.Io.Dir.cwd().writeFile(gio, .{ .sub_path = outPath, .data = out[0..n] });
    say("已写出 {d} 个残局 + 精确解({d} 字节)到 {s}", .{ done, n, outPath });
}

/// 随机走一局、在中途停下,得到"合法对局中途的局面"。
/// 不是随便撒棋子:撒出来的局面往往双方都不该走子,求值/模式统计会失真。
fn randomMidgame(rnd: std.Random) ?rules.Board {
    var b = rules.Board.initial;
    var steps = rnd.intRangeLessThan(u32, 3, 58);
    while (steps > 0) : (steps -= 1) {
        const m = rules.moves(b);
        if (m == 0) {
            const sw = rules.Board{ .own = b.opp, .opp = b.own };
            if (rules.moves(sw) == 0) return null; // 对局已结束
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

/// 造局面 + 38 个槽号写出去。这是"位棋盘 → 模式表几何"这条链路的端到端对拍源:
/// JS 侧只读 (own,opp) 就能独立重算槽号,两边必须逐位相同。
fn dumpSlots(arena: std.mem.Allocator, outPath: []const u8, count: u32) !void {
    if (!pattern.init(weights)) {
        say("✗ pattern.init 失败(步 {d})", .{pattern.failStage});
        std.process.exit(1);
    }
    const out = try arena.alloc(u8, @as(usize, count) * 256 + 64);
    var n: usize = 0;
    var prng = std.Random.DefaultPrng.init(0xC0FFEE_1234);
    const rnd = prng.random();

    var lines: u32 = 0;
    var guard: u32 = 0;
    while (lines < count and guard < count * 20) : (guard += 1) {
        const b = randomMidgame(rnd) orelse continue;
        var slots: [pattern.PTN_COUNT]u32 = undefined;
        pattern.slotIndices(b, &slots);
        var tmp: [512]u8 = undefined;
        var w = try std.fmt.bufPrint(&tmp, "{x} {x}", .{ b.own, b.opp });
        @memcpy(out[n .. n + w.len], w);
        n += w.len;
        for (slots) |v| {
            w = try std.fmt.bufPrint(&tmp, " {d}", .{v});
            @memcpy(out[n .. n + w.len], w);
            n += w.len;
        }
        out[n] = '\n';
        n += 1;
        lines += 1;
    }
    try std.Io.Dir.cwd().writeFile(gio, .{ .sub_path = outPath, .data = out[0..n] });
    say("已写出 {d} 个局面 + 槽号({d} 字节)到 {s}", .{ lines, n, outPath });
}

/// 把 comptime 建出来的几何表原样倒出来,供 JS 侧逐项对拍。
/// 折叠出问题时,第一步永远是先证明"两边的模式表/群作用表是同一张"。
fn geoDump(arena: std.mem.Allocator, outPath: []const u8) !void {
    const out = try arena.alloc(u8, 1 << 20);
    var n: usize = 0;
    for (1..pattern.PTN_COUNT + 1) |p| {
        var t = try std.fmt.bufPrint(out[n..], "P {d} len={d} tri={d} off={d} cells=", .{ p, pattern.model.len[p], pattern.model.tri[p], pattern.model.slot_off[p] });
        n += t.len;
        for (0..pattern.model.len[p]) |k| {
            t = try std.fmt.bufPrint(out[n..], "{s}{d}", .{ if (k == 0) "" else ",", pattern.model.cells[pattern.model.cell_off[p] + k] });
            n += t.len;
        }
        out[n] = '\n';
        n += 1;
    }
    for (0..8) |t| {
        for (1..pattern.PTN_COUNT + 1) |p| {
            const a = pattern.act[t][p];
            var w = try std.fmt.bufPrint(out[n..], "A {d} {d} q={d} perm=", .{ t, p, a.q });
            n += w.len;
            for (0..pattern.model.len[p]) |k| {
                w = try std.fmt.bufPrint(out[n..], "{s}{d}", .{ if (k == 0) "" else ",", a.perm[k] });
                n += w.len;
            }
            out[n] = '\n';
            n += 1;
        }
    }
    for (1..pattern.PTN_COUNT + 1) |p| {
        var w = try std.fmt.bufPrint(out[n..], "C {d} cand=", .{p});
        n += w.len;
        for (0..pattern.cands[p].n) |i| {
            w = try std.fmt.bufPrint(out[n..], "{s}{d}", .{ if (i == 0) "" else ",", pattern.cands[p].items[i] });
            n += w.len;
        }
        out[n] = '\n';
        n += 1;
    }
    try std.Io.Dir.cwd().writeFile(gio, .{ .sub_path = outPath, .data = out[0..n] });
    say("已写出几何表({d} 字节)到 {s}", .{ n, outPath });
}

/// 求值链路对拍源:局面 + 38 个槽号 + **整数**加权和(未乘 scale)。
/// 整数是有意为之 —— 对拍比的是"两边的 wt 表和相位划分是不是同一张",
/// 用浮点比会掺进格式化与舍入噪声,反而看不出真假差异。
fn evalDump(arena: std.mem.Allocator, outPath: []const u8, count: u32) !void {
    if (!pattern.init(weights)) {
        say("✗ pattern.init 失败(步 {d})", .{pattern.failStage});
        std.process.exit(1);
    }
    const out = try arena.alloc(u8, @as(usize, count) * 512 + 64);
    var n: usize = 0;
    var prng = std.Random.DefaultPrng.init(0xE7A1_D0C5);
    const rnd = prng.random();

    var lines: u32 = 0;
    var guard: u32 = 0;
    while (lines < count and guard < count * 20) : (guard += 1) {
        const b = randomMidgame(rnd) orelse continue;
        var slots: [pattern.PTN_COUNT]u32 = undefined;
        pattern.slotIndices(b, &slots);
        var tmp: [512]u8 = undefined;
        var w = try std.fmt.bufPrint(&tmp, "{x} {x} {d} {d}", .{ b.own, b.opp, b.discs(), pattern.evalInt(b) });
        @memcpy(out[n .. n + w.len], w);
        n += w.len;
        for (slots) |v| {
            w = try std.fmt.bufPrint(&tmp, " {d}", .{v});
            @memcpy(out[n .. n + w.len], w);
            n += w.len;
        }
        out[n] = '\n';
        n += 1;
        lines += 1;
    }
    try std.Io.Dir.cwd().writeFile(gio, .{ .sub_path = outPath, .data = out[0..n] });
    say("已写出 {d} 个局面 + 槽号 + 整数分({d} 字节)到 {s}", .{ lines, n, outPath });
}

/// 中局搜索的性能体检。**必须能换权重书** —— 零权重下叶子值全等,
/// 零窗口搜索一次都剪不掉,量出来的节点数是"退化的那棵树",不是真实性能
/// (这就是训练器第 0 轮慢到 60 s/盘的原因)。所以要能喂一本真书再测。
fn searchBench(arena: std.mem.Allocator, blobPath: []const u8, depth: u32, count: u32) !void {
    const blob = try std.Io.Dir.cwd().readFileAlloc(gio, blobPath, arena, .limited(1 << 20));
    if (!pattern.init(blob)) {
        say("✗ pattern.init 失败(步 {d})", .{pattern.failStage});
        std.process.exit(1);
    }
    say("中局搜索体检 · 深度 {d} · 权重 {s}(scale {d:.6})", .{ depth, blobPath, pattern.scale });

    var prng = std.Random.DefaultPrng.init(0x5EA5_C4ED);
    const rnd = prng.random();
    var bx0: u32 = 1 << 30;
    var bx1: u32 = 0;
    var tot_nodes: u64 = 0;
    var tot_ms: f64 = 0;
    var tot_eval: u64 = 0;
    var lines: u32 = 0;
    var guard: u32 = 0;
    var mid: [64]rules.Board = undefined;
    while (lines < count and guard < count * 20) : (guard += 1) {
        const b = randomMidgame(rnd) orelse continue;
        mid[lines] = b;
        lines += 1;
    }
    for (mid[0..lines]) |b| {
        search.clearTT();
        const t0 = nanos();
        const r = search.think(b, depth, 0, 0);
        const dt = @as(f64, @floatFromInt(nanos() - t0)) / 1e6;
        _ = r;
        tot_nodes += search.nodes;
        tot_eval += search.evals;
        tot_ms += dt;
        const nd: u32 = @intCast(@min(search.nodes, 1 << 30));
        if (nd < bx0) bx0 = nd;
        if (nd > bx1) bx1 = nd;
    }
    const f: f64 = @floatFromInt(@max(lines, 1));
    say("  局面 {d} · 平均 {d:.0} 节点 / {d:.2} ms · 最快/最慢 {d} / {d} 节点 · 求值调用 {d:.0}",
        .{ lines, @as(f64, @floatFromInt(tot_nodes)) / f, tot_ms / f, bx0, bx1, @as(f64, @floatFromInt(tot_eval)) / f });
    if (tot_ms > 0) say("  {d:.2} M节点/秒", .{@as(f64, @floatFromInt(tot_nodes)) / tot_ms / 1000.0});
}

/// Zig 0.16 删掉了 std.time.Timer,计时统一走 Io 时钟接口
fn nanos() i96 {
    return std.Io.Timestamp.now(gio, .awake).nanoseconds;
}

const BENCH_POOL = 512;

fn bench(rounds: u32) !void {
    if (!pattern.ready) {
        if (!pattern.init(weights)) {
            say("✗ pattern.init 失败(步 {d})", .{pattern.failStage});
            std.process.exit(1);
        }
    }
    say("\n基准", .{});
    var prng = std.Random.DefaultPrng.init(0x1234_5678);
    const rnd = prng.random();

    // 必须换局面:同一个局面反复 eval 会被 LLVM 整个提到循环外,
    // 量出来是 1.2 ns 的假数(踩过)。这里预生成一池子中途局面轮着用。
    var pool: [BENCH_POOL]rules.Board = undefined;
    var k: usize = 0;
    var attempts: u32 = 0;
    while (k < BENCH_POOL and attempts < BENCH_POOL * 40) : (attempts += 1) {
        if (randomMidgame(rnd)) |b| {
            pool[k] = b;
            k += 1;
        }
    }
    if (k == 0) {
        say("✗ 生成基准局面失败", .{});
        return;
    }
    var f = k;
    while (f < BENCH_POOL) : (f += 1) pool[f] = pool[f % k];
    std.mem.doNotOptimizeAway(&pool);

    var t0 = nanos();
    var acc: f32 = 0;
    var i: u32 = 0;
    while (i < rounds) : (i += 1) acc += pattern.eval(pool[(i *% 2654435761) >> 23 & (BENCH_POOL - 1)]);
    const nsEval = @as(f64, @floatFromInt(nanos() - t0)) / @as(f64, @floatFromInt(rounds));

    t0 = nanos();
    var nm: u32 = 0;
    i = 0;
    while (i < rounds) : (i += 1) nm +%= @as(u32, @popCount(rules.moves(pool[(i *% 40503) >> 3 & (BENCH_POOL - 1)])));
    const nsMoves = @as(f64, @floatFromInt(nanos() - t0)) / @as(f64, @floatFromInt(rounds));

    say("  求值   {d:.1} ns/次({d} 次,防优化 {d:.1})", .{ nsEval, rounds, acc });
    say("  着法   {d:.1} ns/次(防优化 {d})", .{ nsMoves, nm });
}
