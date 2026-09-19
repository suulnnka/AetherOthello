// ⑩ 开局书生成器(原生):宗师强度自对弈,记录每局前 12 手成"着法主线",
// 去重后按 6 bit/手打包 → src/zig/book.bin(体积 ≈ 2 KB,gzip 后更小)。
//
// 书的质量来自引擎自身(⑪ 的种子化同分随机 + tie_tol 放宽提供主线多样性),
// 不引入任何外部数据 —— 许可红线见 docs/engine-improvement-plan.md。
// 运行时(engine.zig)把主线回放展开成「局面 → 可行着法集」查找表,think 时
// 命中则直接出着法;seed=0 时取最低位(完全确定),seed≠0 在书内随机。
//
// 用法:zig build genbook -- [输出路径](缺省 src/zig/book.bin)
const std = @import("std");
const rules = @import("rules.zig");
const search = @import("search.zig");
const stability = @import("stability.zig");

const BOOK_PLY = 12;
const GAMES = 400;
const GEN_DEPTH = 8; // 大师档强度:够强,单局 ~1s

var gio: std.Io = undefined;

pub fn main(init: std.process.Init) !void {
    gio = init.io;
    const alloc = init.arena.allocator();
    stability.ensureInit();

    var lines: std.ArrayList([BOOK_PLY]u6) = .empty;

    var rng: u64 = 0x5EED_2026_0920_0001;
    var attempts: usize = 0;
    while (lines.items.len < GAMES and attempts < GAMES * 3) : (attempts += 1) {
        // 每局推进种子:同分随机让主线分叉
        rng = rng *% 0x9E37_79B9_7F4A_7C15 +% 0x5150_1977;
        search.rng_state = rng;
        search.tie_tol = 3.0;
        search.clearTT();

        var b = rules.Board.initial;
        var line: [BOOK_PLY]u6 = undefined;
        var plies: usize = 0;
        var ok = true;
        while (plies < BOOK_PLY) {
            const res = search.thinkSeeded(b, GEN_DEPTH, 0, 0, rng);
            if (res.move < 0) {
                const sw = rules.Board{ .own = b.opp, .opp = b.own };
                if (rules.moves(sw) == 0) { // 12 手内终局:理论不可能,防御
                    ok = false;
                    break;
                }
                b = sw;
                continue;
            }
            line[plies] = @intCast(res.move);
            plies += 1;
            b = rules.play(b, @intCast(res.move));
        }
        if (!ok) continue;
        var dup = false;
        for (lines.items) |*l| {
            if (std.mem.eql(u6, l, &line)) {
                dup = true;
                break;
            }
        }
        if (dup) continue;
        try lines.append(alloc, line);
    }

    // 打包:u16 线数 + 每线 12×6bit = 9 字节(MSB 先行)
    var out: std.ArrayList(u8) = .empty;
    const n: u16 = @intCast(lines.items.len);
    try out.append(alloc, @truncate(n & 0xFF));
    try out.append(alloc, @truncate(n >> 8));
    for (lines.items) |line| {
        var buf: [9]u8 = undefined;
        var v: u72 = 0;
        for (line) |mv| v = (v << 6) | mv;
        // 72 bit 大端切成 9 字节:byte0 = bits 64..71(含首手高 6 位)
        var bi: usize = 0;
        while (bi < 9) : (bi += 1) {
            buf[bi] = @truncate(v >> @intCast(72 - 8 * @as(u8, @intCast(bi + 1))));
        }
        try out.appendSlice(alloc, &buf);
    }

    const argv = try init.minimal.args.toSlice(alloc);
    const path = if (argv.len > 1) argv[1] else "src/zig/book.bin";
    try std.Io.Dir.cwd().writeFile(gio, .{ .sub_path = path, .data = out.items });

    // 统计
    var first: [64]u32 = .{0} ** 64;
    for (lines.items) |l| first[l[0]] += 1;
    std.debug.print("✓ {d} 条主线 → {s}({d} 字节)\n", .{ lines.items.len, path, out.items.len });
    for (0..64) |sq| {
        if (first[sq] > 0) std.debug.print("  首手 {c}{d}: {d} 条\n", .{ 'a' + @as(u8, @intCast(sq & 7)), (sq >> 3) + 1, first[sq] });
    }
}
