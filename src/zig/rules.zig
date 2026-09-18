// 黑白棋位棋盘规则核心(u64 双位板)。
//
// 表示:
//   own / opp 各一个 u64,bit 编号 = row*8 + col,row 0 在上、col 0 在左。
//   不使用"哨兵边框"(那是 10x10 数组写法的活儿);环绕完全靠方向掩码挡住,
//   所以整块棋盘就是 64 个 bit,popCount 直接就是子数。
//
// 方向掩码的来历(很容易写错,写错的现象是"棋子在棋盘左右边界循环跳"):
//   向右的移动(col+1 / col+1 且 row+1)必须先清掉 FILE_H,否则最右列会绕到下一行最左列;
//   向左的移动同理先清 FILE_A。纵向移动(dc=0)不会环绕,不用掩码。
//
// 不依赖 std 之外的东西,更不碰 DOM/分配器 —— 这样同一份代码既能被 wasm 导出,
// 也能直接被原生 exe(perft / 自对弈训练)拿来用。
//
// 注意:Zig 0.16 起**块注释 /* */ 已被移除**,只能写 // ——本文件因此通篇行注释。
const std = @import("std");

pub const FILE_A: u64 = 0x0101_0101_0101_0101;
pub const FILE_H: u64 = 0x8080_8080_8080_8080;
pub const FULL: u64 = ~@as(u64, 0);

// 棋盘状态。own 是"轮到走的那一方"的棋子,不是固定的黑方 ——
// 这样搜索里顺手,但记谱/UI 侧要自己记住当前是黑是白。
pub const Board = struct {
    own: u64,
    opp: u64,

    // 初始四子(位号):
    //   黑(先手)= d5(3*8+3=35)、e4(3*8+4=28)
    //   白       = d4(3*8+3? 不:d4 = col3,row4=下标3 → 27)、e5(col4,row5=下标4 → 36)
    pub const initial = Board{
        .own = (@as(u64, 1) << 35) | (@as(u64, 1) << 28),
        .opp = (@as(u64, 1) << 27) | (@as(u64, 1) << 36),
    };

    pub inline fn empty(self: Board) u64 {
        return ~(self.own | self.opp);
    }
    pub inline fn occupied(self: Board) u64 {
        return self.own | self.opp;
    }
    pub inline fn discs(self: Board) u32 {
        return @popCount(self.own | self.opp);
    }
    // 子差(own 视角),终局打分用
    pub inline fn diff(self: Board) i32 {
        return @as(i32, @popCount(self.own)) - @as(i32, @popCount(self.opp));
    }
};

const Spec = struct { dr: i8, dc: i8 };

// 方向表。顺序无所谓,但八条都要有。
const SPECS = [8]Spec{
    .{ .dr = -1, .dc = 0 }, // N
    .{ .dr = 1, .dc = 0 }, // S
    .{ .dr = 0, .dc = -1 }, // W
    .{ .dr = 0, .dc = 1 }, // E
    .{ .dr = -1, .dc = -1 }, // NW
    .{ .dr = -1, .dc = 1 }, // NE
    .{ .dr = 1, .dc = -1 }, // SW
    .{ .dr = 1, .dc = 1 }, // SE
};

const Dir = struct {
    mask: u64,
    amt: u6,
    left: bool,

    inline fn step(self: Dir, x: u64) u64 {
        const y = x & self.mask;
        return if (self.left) y << self.amt else y >> self.amt;
    }
};

fn dirOf(comptime s: Spec) Dir {
    const delta: i32 = @as(i32, s.dr) * 8 + s.dc;
    const mask: u64 = if (s.dc > 0) ~FILE_H else if (s.dc < 0) ~FILE_A else FULL;
    return .{
        .mask = mask,
        .amt = @intCast(if (delta < 0) -delta else delta),
        .left = delta > 0,
    };
}

pub const DIRS = blk: {
    var d: [8]Dir = undefined;
    for (SPECS, 0..) |s, i| d[i] = dirOf(s);
    break :blk d;
};

// 单方向"从己方子出发、越过一串对方子、落到空位"的落点累加。
// 连做 6 次是因为夹翻最多跨 6 个对方子(8 格去掉两端)。
inline fn slide(d: Dir, own: u64, opp: u64, empty: u64) u64 {
    var t = d.step(own) & opp;
    t |= d.step(t) & opp;
    t |= d.step(t) & opp;
    t |= d.step(t) & opp;
    t |= d.step(t) & opp;
    t |= d.step(t) & opp;
    return d.step(t) & empty;
}

// 合法落点集合(任一方向夹得住即可)
pub fn moves(b: Board) u64 {
    const empty = b.empty();
    var m: u64 = 0;
    inline for (DIRS) |d| m |= slide(d, b.own, b.opp, empty);
    return m;
}

// 在 sq 落子能夹翻的所有对方子;该方向夹不住时对应位为 0
pub fn flips(b: Board, sq: u6) u64 {
    const bit = @as(u64, 1) << sq;
    var f: u64 = 0;
    inline for (DIRS) |d| {
        var run: u64 = 0;
        var t = d.step(bit);
        var k: u3 = 0;
        while (k < 6 and (t & b.opp) != 0) : (k += 1) {
            run |= t;
            t = d.step(t);
        }
        if ((t & b.own) != 0) f |= run;
    }
    return f;
}

// 落子并翻转,然后换边。要求 sq 是合法着法
pub inline fn play(b: Board, sq: u6) Board {
    return playMove(b, sq, flips(b, sq));
}

// 翻子掩码已经算好时的落子(搜索里着法排序阶段就顺手算过,别再算一遍)
pub inline fn playMove(b: Board, sq: u6, f: u64) Board {
    const bit = @as(u64, 1) << sq;
    return .{ .own = b.opp & ~f, .opp = b.own | f | bit };
}

// 落子但**不**换边(逐层展开同一方连续走子时用)
pub inline fn playSame(b: Board, sq: u6) Board {
    const bit = @as(u64, 1) << sq;
    const f = flips(b, sq);
    return .{ .own = b.own | f | bit, .opp = b.opp & ~f };
}

// 撤销:把 sq 上的己方子拿掉、把 f 还回己方(b 是落子之后的状态)
pub inline fn undoPlay(b: Board, sq: u6, f: u64) Board {
    const bit = @as(u64, 1) << sq;
    return .{ .own = (b.own & ~bit & ~f), .opp = b.opp | f };
}

pub const Status = enum { ok, pass, over };

// 走一步并处理"对方无棋可走":
//   .ok   正常换边
//   .pass 换边后对方必须跳过(own/opp 已经交换)
//   .over 双方都无棋可走,对局结束(board 保持未换边的落子结果)
pub fn step(b: Board, sq: u6) struct { board: Board, status: Status } {
    const nb = play(b, sq);
    if (moves(nb) != 0) return .{ .board = nb, .status = .ok };
    const swapped = Board{ .own = nb.opp, .opp = nb.own };
    if (moves(swapped) != 0) return .{ .board = swapped, .status = .pass };
    return .{ .board = nb, .status = .over };
}

// 当前一方是否无棋可走
pub inline fn mustPass(b: Board) bool {
    return moves(b) == 0;
}

// 逐层展开所有合法着法的节点数。pass 会消耗一层深度。
// 这是规则改动的唯一闸门 —— 数值都是公开的标准值。
pub fn perft(b: Board, depth: u32) u64 {
    if (depth == 0) return 1;
    const m = moves(b);
    if (m == 0) {
        if (moves(Board{ .own = b.opp, .opp = b.own }) == 0) return 1;
        return perft(Board{ .own = b.opp, .opp = b.own }, depth - 1);
    }
    var n: u64 = 0;
    var mm = m;
    while (mm != 0) {
        const sq: u6 = @intCast(@ctz(mm));
        mm &= mm - 1;
        const f = flips(b, sq);
        n += perft(.{ .own = b.opp & ~f, .opp = b.own | f | (@as(u64, 1) << sq) }, depth - 1);
    }
    return n;
}

test "初始局面:合法着法 4 个,perft(1..6) 对上标准值" {
    try std.testing.expectEqual(@as(u32, 4), @popCount(moves(Board.initial)));
    try std.testing.expectEqual(@as(u64, 4), perft(Board.initial, 1));
    try std.testing.expectEqual(@as(u64, 12), perft(Board.initial, 2));
    try std.testing.expectEqual(@as(u64, 56), perft(Board.initial, 3));
    try std.testing.expectEqual(@as(u64, 244), perft(Board.initial, 4));
    try std.testing.expectEqual(@as(u64, 1396), perft(Board.initial, 5));
    try std.testing.expectEqual(@as(u64, 8200), perft(Board.initial, 6));
    try std.testing.expectEqual(@as(u64, 55092), perft(Board.initial, 7));
    try std.testing.expectEqual(@as(u64, 390216), perft(Board.initial, 8));
}

test "初始局面的四个开局点确实是 d3 c4 f5 e6" {
    const m = moves(Board.initial);
    // d3=19 c4=26 f5=37 e6=44
    try std.testing.expectEqual(@as(u64, (@as(u64, 1) << 19) | (@as(u64, 1) << 26) | (@as(u64, 1) << 37) | (@as(u64, 1) << 44)), m);
}

test "落子后棋子数守恒 +1,且翻转数等于子数增量" {
    const b = Board.initial;
    var mm = moves(b);
    while (mm != 0) {
        const sq: u6 = @intCast(@ctz(mm));
        mm &= mm - 1;
        const f = flips(b, sq);
        const nb = play(b, sq);
        // play() 之后已经换边:nb.own 是"原来的对方减掉被翻的",nb.opp 才是落子方
        try std.testing.expectEqual(b.discs() + 1, nb.discs());
        try std.testing.expectEqual(@popCount(b.own) + @popCount(f) + 1, @as(u32, @popCount(nb.opp)));
        try std.testing.expectEqual(b.opp & ~f, nb.own);
        // 落子方全盘的子数 = 原子数 + 翻来的 + 新落的
        try std.testing.expectEqual(b.discs() + 1, nb.discs());
    }
}

test "往返:play 之后 undoPlay 能还原(在同一方视角下)" {
    const b = Board.initial;
    var mm = moves(b);
    while (mm != 0) {
        const sq: u6 = @intCast(@ctz(mm));
        mm &= mm - 1;
        const f = flips(b, sq);
        // playSame 不换边,方便直接对拍还原
        const nb = playSame(b, sq);
        const back = undoPlay(nb, sq, f);
        try std.testing.expectEqual(b.own, back.own);
        try std.testing.expectEqual(b.opp, back.opp);
    }
}
