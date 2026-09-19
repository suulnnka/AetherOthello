// PVS 负极大搜索 + 置换表 + 残局完全求解。
//
// 与主分支 src/engine.js 的关系:**搜索骨架照搬,状态载体换了**。
//   · 那边把局面放在 4 个模块级变量(PLO/PHI/OLO/OHI)里,make/unmake 靠
//     ply 栈存快照;这边 Board 是值类型,落子就是返回一个新 Board,
//     连 unmake 都不需要 —— 但**每层暂存区仍然按 ply 索引**(照旧是全局数组),
//     per-ply 数组重复分配的开销比省下的拷贝贵。
//   · 那边排序用 W64 + 翻子数;这边多一个"残局奇偶区域"排序(完全求解用)。
//   · 那边中局/残局各一张置换表;这边一张,靠 EXACT_SALT 把两种评分语义隔开,
//     免得残局的精确点差被中局的启发式分污染(这是很容易写出来的静默错误)。
//
// 评分单位:**子数**(f32)。终局 = 子差,中局 = scale × Σ int8 权重。
// 两者同量纲 ⇒ 不需要像 JS 版那样用 ×100 硬撑,也就不会出现
// "终局值 100 倍于中局值、结果搜索被终局分带跑" 的隐患。
const std = @import("std");
const rules = @import("rules.zig");
const pattern = @import("pattern.zig");

pub const INF: f32 = 1e30;

/// 搜索层难度(与主分支 LEVELS 对齐:初级贪心 / 中级 4 层 / 高级 8 层)
pub const Level = struct { name: []const u8, depth: u32, end: u32 };
pub const LEVELS = [_]Level{
    .{ .name = "初级", .depth = 0, .end = 0 },
    .{ .name = "中级", .depth = 4, .end = 8 },
    .{ .name = "高级", .depth = 8, .end = 14 },
};
/// 完全求解前先跑的中层迭代加深深度(只为给根着法排序)
pub const PRE_ENDGAME_DEPTH: u32 = 6;

pub const F_EXACT: u8 = 1;
pub const F_LOWER: u8 = 2;
pub const F_UPPER: u8 = 3;

pub const MAX_PLY: usize = 72;
const MAX_MOVES: usize = 36; // 黑白棋单方最多 33 个合法着法

/// 置换表:2^19 × 16 B = 8 MB。放 BSS,不占二进制体积(零页不进文件)。
/// 用 u64 键而不是"两个 32 位字":后者要额外维护两组键,漏一处就静默出伪命中。
const TT_BITS: u5 = 19;
const TT_SIZE: usize = 1 << TT_BITS;
const TT_MASK: u64 = TT_SIZE - 1;

const Entry = extern struct {
    key: u64,
    score: f32,
    move: i8,
    depth: i8,
    flag: u8,
    pad: [3]u8 = .{ 0, 0, 0 },
};

var tt: [TT_SIZE]Entry = undefined;
var tt_ready = false;

/// 中局/残局共表时必须把两种评分语义隔开,否则一次伪命中就能让残局求解给出错着
const EXACT_SALT: u64 = 0x5DEE_CE66_D000_0000;

/// Zobrist:每个 (格, 归属) 一把 u64 键。用 xorshift64 生成,`|1` 保证非 0
/// —— 0 是置换表的"空槽"哨兵,键撞 0 就变成开机即伪命中。
const ZA: [64]u64 = blk: {
    var z: [64]u64 = undefined;
    var s: u64 = 0x9E37_79B9_7F4A_7C15;
    for (0..64) |i| {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        z[i] = s | 1;
    }
    break :blk z;
};
const ZB: [64]u64 = blk: {
    var z: [64]u64 = undefined;
    var s: u64 = 0xD1B5_4A32_D192_ED03;
    for (0..64) |i| {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        z[i] = s | 1;
    }
    break :blk z;
};

/// 排序用位置权重(与主分支 W64 同表,i8 装得下):角贵、角邻负分。
const W64O = [64]i8{
    120, -20, 20,  5,  5, 20, -20, 120,
    -20, -40, -5, -5, -5, -5, -40, -20,
    20,  -5,  15,  3,  3, 15,  -5,  20,
    5,   -5,   3,  3,  3,  3,  -5,   5,
    5,   -5,   3,  3,  3,  3,  -5,   5,
    20,  -5,  15,  3,  3, 15,  -5,  20,
    -20, -40, -5, -5, -5, -5, -40, -20,
    120, -20, 20,  5,  5, 20, -20, 120,
};

/// 每层暂存区(照抄主分支做法:按 ply 索引的全局数组,避免每层重新分配)
var ply_moves: [MAX_PLY][MAX_MOVES]u6 = undefined;
var ply_flips: [MAX_PLY][MAX_MOVES]u64 = undefined;
var ply_scores: [MAX_PLY][MAX_MOVES]i32 = undefined;
var ply_cnt: [MAX_PLY]u32 = undefined;

pub var nodes: u64 = 0;
pub var node_limit: u64 = 0; // 0 = 不限
pub var aborted: bool = false;

pub fn clearTT() void {
    @memset(std.mem.asBytes(&tt), 0);
    tt_ready = true;
}

/// 增量统计用:本次搜索里 evaluation 被调用的次数(调试/训练统计)
pub var evals: u64 = 0;

pub fn terminalScore(b: rules.Board) f32 {
    return @floatFromInt(b.diff());
}

/// 零窗口宽度。必须**小于**分值的量化步长,否则 PVS 会把"同分但更差"的着法
/// 当成超出窗口而白重搜一遍;反过来太大会把真正更好的着法吞掉。
/// 完全求解时分数是整数子差 → 0.5 足够;中局是整数加权和 × scale。
inline fn eps(exact: bool) f32 {
    return if (exact) 0.5 else @max(pattern.scale * 0.25, 1e-4);
}

fn hashOf(b: rules.Board, exact: bool) u64 {
    var h: u64 = if (exact) EXACT_SALT else 0;
    var x = b.own;
    while (x != 0) : (x &= x - 1) h ^= ZA[@as(usize, @ctz(x))];
    x = b.opp;
    while (x != 0) : (x &= x - 1) h ^= ZB[@as(usize, @ctz(x))];
    return h;
}

/// 8 连通膨胀(含源自身),u64 位板版。
/// 先横后纵即可覆盖四个对角:横扩后的集合再纵移,等价于同时横纵各移一格。
inline fn expand8(x: u64) u64 {
    const ew = x | ((x & ~rules.FILE_A) >> 1) | ((x & ~rules.FILE_H) << 1);
    return ew | (ew << 8) | (ew >> 8);
}

/// 奇数大小的空格连通区域。终局本质是"谁在某连通空区里走最后一步"的争夺,
/// 区域大小决定最后一步归谁 —— 先走奇区域能显著压树。纯排序,不影响任何一手的值。
/// 实测(主分支 JS,完全求解节点数):13 空 −36% · 14 空 −48% · 15 空 −36%。
fn parityMask(empty: u64) u64 {
    var rest = empty;
    var out: u64 = 0;
    while (rest != 0) {
        const seed = rest & (~rest +% 1);
        var comp = seed;
        while (true) {
            const grown = expand8(comp) & empty;
            if (grown == comp) break;
            comp = grown;
        }
        rest &= ~comp;
        if (@popCount(comp) & 1 == 1) out |= comp;
    }
    return out;
}

/// PVS 负极大。返回**行棋方视角**的分值。
/// exact = true 时:depth ≤ 0 不调用启发式评估,而是给终局点差的兜底值 ——
/// 因为完全求解只接受精确点差,掺一点启发式进去整棵树的胜负判断就废了。
fn search(b: rules.Board, depth: i32, alpha_in: f32, beta: f32, ply: u32, exact: bool) f32 {
    nodes += 1;
    if (node_limit != 0 and nodes > node_limit) {
        aborted = true;
        return 0;
    }

    var alpha = alpha_in;
    // 只在 depth > 0 时算键:叶子节点占绝大多数,而叶子的 TT 命中率极低,
    // 白算一次 Zobrist 不划算。键只算**一次**,后面排序/写回都复用 ——
    // 每处各算一次的话每个节点要跑 3 遍 64 位扫描。
    var key: u64 = 0;
    var slot: usize = 0;
    if (depth > 0) {
        key = hashOf(b, exact);
        slot = @intCast(key & TT_MASK);
        const e = &tt[slot];
        if (e.key == key and e.depth >= depth) {
            if (e.flag == F_EXACT or (e.flag == F_LOWER and e.score >= beta) or (e.flag == F_UPPER and e.score <= alpha)) {
                return e.score;
            }
        }
    }

    if (ply + 2 >= MAX_PLY or depth <= 0) {
        if (exact) return terminalScore(b);
        evals += 1;
        return pattern.eval(b);
    }

    const m = rules.moves(b);
    if (m == 0) {
        // 无棋可走:对方也无 → 终局;否则虚着换手(**不消耗深度**,
        // 所以残局求解的 depth 只要给到空位数就够了,主分支给 +4 是留余量)。
        const sw = rules.Board{ .own = b.opp, .opp = b.own };
        if (rules.moves(sw) == 0) return terminalScore(b);
        return -search(sw, depth, -beta, -alpha, ply + 1, exact);
    }

    const moves = &ply_moves[ply];
    const flips = &ply_flips[ply];
    const scores = &ply_scores[ply];

    const par: u64 = if (exact) parityMask(b.empty()) else 0;
    var n: u32 = 0;
    var mm = m;
    while (mm != 0) {
        const sq: u6 = @intCast(@ctz(mm));
        mm &= mm - 1;
        const f = rules.flips(b, sq);
        const fc: i32 = @intCast(@popCount(f));
        moves[n] = sq;
        flips[n] = f;
        // 中局:翻子多优先;残局:翻子**少**优先(少给对手留行动力)
        var s: i32 = W64O[sq] + (if (exact) -fc else fc) * 2;
        if (exact and (par >> sq) & 1 == 1) s += 1000;
        scores[n] = s;
        n += 1;
    }
    ply_cnt[ply] = n;

    // 插入排序(降序)。着法数 ≤ 33,插入排序比任何"更聪明"的排序都快。
    var i: u32 = 1;
    while (i < n) : (i += 1) {
        const mv = moves[i];
        const sc = scores[i];
        const fl = flips[i];
        var j: i32 = @intCast(i - 1);
        while (j >= 0 and scores[@intCast(j)] < sc) : (j -= 1) {
            const jj: u32 = @intCast(j);
            moves[jj + 1] = moves[jj];
            scores[jj + 1] = scores[jj];
            flips[jj + 1] = flips[jj];
        }
        const dst: u32 = @intCast(j + 1);
        moves[dst] = mv;
        scores[dst] = sc;
        flips[dst] = fl;
    }

    // 置换表最优着法提到队首。**必须连翻子掩码一起搬** ——
    // 漏搬会让队首着法配到别人的翻子掩码,make 出非法局面(值全错,且很难查)。
    if (depth > 0) {
        const e = &tt[slot];
        if (e.key == key and e.move >= 0) {
            const want: u6 = @intCast(e.move);
            var k: u32 = 0;
            while (k < n) : (k += 1) {
                if (moves[k] != want) continue;
                if (k == 0) break;
                const mv = moves[k];
                const sc = scores[k];
                const fl = flips[k];
                var j = k;
                while (j > 0) : (j -= 1) {
                    moves[j] = moves[j - 1];
                    scores[j] = scores[j - 1];
                    flips[j] = flips[j - 1];
                }
                moves[0] = mv;
                scores[0] = sc;
                flips[0] = fl;
                break;
            }
        }
    }

    var best: f32 = -INF;
    var best_move: u6 = moves[0];
    const alpha0 = alpha;
    i = 0;
    while (i < n) : (i += 1) {
        const nb = rules.playMove(b, moves[i], flips[i]);
        var v: f32 = undefined;
        if (i == 0) {
            v = -search(nb, depth - 1, -beta, -alpha, ply + 1, exact);
        } else {
            // 零窗口试探,超界再重搜(principal variation search)
            v = -search(nb, depth - 1, -alpha - eps(exact), -alpha, ply + 1, exact);
            if (alpha < v and v < beta) {
                v = -search(nb, depth - 1, -beta, -v, ply + 1, exact);
            }
        }
        if (v > best) {
            best = v;
            best_move = moves[i];
        }
        if (v > alpha) alpha = v;
        if (alpha >= beta) break;
        if (aborted) break;
    }

    if (depth > 0 and !aborted) {
        const e = &tt[slot];
        e.key = key;
        e.score = best;
        e.depth = @intCast(depth);
        e.flag = if (best >= beta) F_LOWER else if (best > alpha0) F_EXACT else F_UPPER;
        e.move = @intCast(best_move);
    }
    return best;
}

/// 残局完全求解(对拍/训练用):depth 给到空位数 + 4 的余量。
/// 虚着不消耗深度,所以虽然加了余量,搜索也一定会走到终局。
pub fn solveExact(b: rules.Board) f32 {
    if (!tt_ready) clearTT();
    nodes = 0;
    evals = 0;
    aborted = false;
    node_limit = 0;
    return search(b, @intCast(64 - b.discs() + 4), -INF, INF, 0, true);
}

pub const Result = struct {
    move: i8 = -1,
    score: f32 = 0,
    depth: u32 = 0,
    nodes: u64 = 0,
    exact: bool = false,
    only: bool = false,
    endgame: bool = false,
};

/// 根搜索一轮:照主分支的 runRoot,按上一轮得分重排 order 以便下一轮迭代。
fn rootSearch(b: rules.Board, depth: i32, exact: bool, order: []u32, root_v: []f32) !Result {
    const moves = &ply_moves[0];
    const flips = &ply_flips[0];
    const scores = &ply_scores[0];

    const m = rules.moves(b);
    if (m == 0) return .{ .move = -1 };
    const par: u64 = if (exact) parityMask(b.empty()) else 0;
    var n: u32 = 0;
    var mm = m;
    while (mm != 0) {
        const sq: u6 = @intCast(@ctz(mm));
        mm &= mm - 1;
        const f = rules.flips(b, sq);
        const fc: i32 = @intCast(@popCount(f));
        moves[n] = sq;
        flips[n] = f;
        var s: i32 = W64O[sq] + (if (exact) -fc else fc) * 2;
        if (exact and (par >> sq) & 1 == 1) s += 1000;
        scores[n] = s;
        n += 1;
    }
    ply_cnt[0] = n;
    if (n == 1) {
        return .{ .move = @intCast(moves[0]), .score = 0, .depth = @intCast(depth), .only = true, .exact = exact };
    }

    // 首轮按静态分排;之后由调用方传入上一轮的 order
    var first = true;
    for (order[0..n]) |x| {
        if (x != 0) {
            first = false;
            break;
        }
    }
    if (first) {
        for (0..n) |k| order[k] = @intCast(k);
        var i: u32 = 1;
        while (i < n) : (i += 1) {
            const oi = order[i];
            const sc = scores[oi];
            var j: i32 = @intCast(i - 1);
            while (j >= 0 and scores[order[@intCast(j)]] < sc) : (j -= 1) {
                order[@intCast(j + 1)] = order[@intCast(j)];
            }
            order[@intCast(j + 1)] = oi;
        }
    }

    var alpha: f32 = -INF;
    const beta = INF;
    var k: u32 = 0;
    while (k < n) : (k += 1) {
        const idx = order[k];
        const nb = rules.playMove(b, moves[idx], flips[idx]);
        var v: f32 = undefined;
        if (k == 0) {
            v = -search(nb, depth - 1, -beta, -alpha, 1, exact);
        } else {
            v = -search(nb, depth - 1, -alpha - eps(exact), -alpha, 1, exact);
            if (alpha < v and v < beta) v = -search(nb, depth - 1, -beta, -v, 1, exact);
        }
        root_v[idx] = v;
        if (v > alpha) alpha = v;
        if (aborted) break;
    }
    // 按本轮得分重排,供下一轮迭代使用
    var i: u32 = 1;
    while (i < n) : (i += 1) {
        const oi = order[i];
        const sc = root_v[oi];
        var j: i32 = @intCast(i - 1);
        while (j >= 0 and root_v[order[@intCast(j)]] < sc) : (j -= 1) {
            order[@intCast(j + 1)] = order[@intCast(j)];
        }
        order[@intCast(j + 1)] = oi;
    }
    const best = order[0];
    return .{
        .move = @intCast(moves[best]),
        .score = root_v[best],
        .depth = @intCast(depth),
        .exact = exact,
    };
}

/// 迭代加深主入口。node_budget = 0 表示不限;超预算时返回**上一个完整深度**的结果
/// (半途而废的那轮结果一律丢弃 —— 零窗口搜索被打断时 root_v 是有偏的)。
pub fn think(b: rules.Board, depth_max: u32, endgame_empty: u32, node_budget: u64) Result {
    if (!tt_ready) clearTT();
    nodes = 0;
    evals = 0;
    aborted = false;
    node_limit = node_budget;

    const empties = 64 - b.discs();

    // 初级:纯贪心(位置权重 + 翻子数),不搜索
    if (depth_max == 0) {
        // order / rv **必须先清零**。rootSearch 判断"是不是首轮"的方式是
        // 看 order 里有没有非 0 —— 传进去的是栈垃圾时它会误判成"已经排过序",
        // 于是跳过排序、直接拿垃圾值当 moves 的下标:
        //   · 轻则返回一个非法着法(实测 58 子/6 空局面返回过 63,合法着法是 0,1,10,40,56,57)
        //   · 重则 `root_v[idx] = v` 越界写全局缓冲
        // depth>0 那条路一直是清零的,只有这一处漏了。**别把这里的两行删掉**。
        var order: [MAX_MOVES]u32 = undefined;
        var rv: [MAX_MOVES]f32 = undefined;
        for (&order) |*x| x.* = 0;
        for (&rv) |*x| x.* = 0;
        var r = rootSearch(b, 0, false, &order, &rv) catch return .{};
        r.nodes = nodes;
        return r;
    }

    var order: [MAX_MOVES]u32 = undefined;
    var rv: [MAX_MOVES]f32 = undefined;
    for (&order) |*x| x.* = 0;
    for (&rv) |*x| x.* = 0;

    if (empties <= endgame_empty) {
        // 残局:先前置中层迭代加深定根排序,再完全求解
        var d: u32 = 2;
        const pre = @min(@min(PRE_ENDGAME_DEPTH, depth_max), empties);
        var last: Result = .{};
        while (d <= pre) : (d += 2) {
            last = rootSearch(b, @intCast(d), false, &order, &rv) catch break;
            if (aborted or last.only) break;
        }
        if (last.only) {
            last.nodes = nodes;
            return last;
        }
        // 空位数 +2 余量:虚着不消耗深度
        var r = rootSearch(b, @intCast(empties + 2), true, &order, &rv) catch return last;
        r.nodes = nodes;
        if (aborted) {
            last.nodes = nodes;
            last.endgame = true;
            return last;
        }
        r.endgame = true;
        return r;
    }

    var res: Result = .{};
    var d: u32 = 2;
    const top = @min(depth_max, empties + 2);
    while (d <= top) : (d += 2) {
        const r = rootSearch(b, @intCast(d), false, &order, &rv) catch break;
        if (aborted) break;
        res = r;
        res.nodes = nodes;
    }
    if (res.move == -1) {
        // 一个深度都没跑完(预算极小):退回单层静态结果,至少给出一个合法着法
        var r = rootSearch(b, 1, false, &order, &rv) catch return .{};
        r.nodes = nodes;
        return r;
    }
    return res;
}
