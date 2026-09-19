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
const stability = @import("stability.zig");
const endgame = @import("endgame.zig");

pub const INF: f32 = 1e30;

/// 搜索层难度(与主分支 LEVELS 对齐:初级贪心 / 中级 4 层 / 高级 8 层)
pub const Level = struct { name: []const u8, depth: u32, end: u32 };
pub const LEVELS = [_]Level{
    .{ .name = "初级", .depth = 0, .end = 0 },
    .{ .name = "中级", .depth = 4, .end = 8 },
    .{ .name = "高级", .depth = 8, .end = 14 },
};
/// 完全求解前的中层预搜深度 = ⌈E/2⌉(原固定 6;Egaroucid 的终局预搜到
/// depth/2 甚至 3/4)。预搜只为根排序 + 提示表喂着法,节点限制在预算的 1/3
/// 内(PRE_ENDGAME_FRAC),吃不完完全求解的份额,保住 engineExact() 契约。
pub const PRE_ENDGAME_FRAC: u32 = 3;

pub const F_EXACT: u8 = 1;
pub const F_LOWER: u8 = 2;
pub const F_UPPER: u8 = 3;

pub const MAX_PLY: usize = 72;
const MAX_MOVES: usize = 36; // 黑白棋单方最多 33 个合法着法

/// 置换表:2^19 × 24 B = 12 MB。放 BSS,不占二进制体积(零页不进文件)。
///
/// 条目直接存 **own/opp 两个 u64**,命中靠 16 字节全比对 —— 这是 Egaroucid/edax
/// 的做法,好处有两层:
///   1. 每节点不再做 Zobrist 全盘逐位异或(那是对双方全部棋子的扫描,残局求解
///      **每个内部节点**都要付一次);定位用一次乘法散列,命中判定是两次比较。
///   2. **零伪命中**。Zobrist 键总有碰撞概率,两个不同局面撞键时返回的分数是
///      静默的错误 —— 全比对从结构上消灭了这一类 bug。
/// 中局/残局仍共一张表,靠 EXACT_SALT 参与散列把两种评分语义隔开(同一局面在
/// 两个语义下落不同的槽),免得残局的精确点差被中局的启发式分污染。
///
/// ⚠ 本文件所有**可变**状态(tt / tt_ready / ply_* / nodes / evals / aborted /
///   node_limit)一律 `threadlocal`:训练器多线程自对弈时每线程一份,无锁无竞争。
///   wasm 侧永远单线程,threadlocal 退化为普通全局,行为不受影响
///   (体积闸门与 probe-wasm 会把关这一点)。
const TT_BITS = 19;
const TT_SIZE: usize = 1 << TT_BITS;
const TT_MASK: u64 = TT_SIZE - 1;

const Entry = extern struct {
    own: u64,
    opp: u64,
    score: f32,
    move: i8,
    depth: i8,
    flag: u8,
    pad: [6]u8 = .{ 0, 0, 0, 0, 0, 0 },
}; // 恰 24 B:8+8+4+1+1+1+6,对齐 8

threadlocal var tt: [TT_SIZE]Entry = undefined;
threadlocal var tt_ready = false;

/// 中局/残局共表时必须把两种评分语义隔开,否则一次伪命中就能让残局求解给出错着
const EXACT_SALT: u64 = 0x5DEE_CE66_D000_0000;

/// 定槽散列。两段都有讲究:
///   1. 乘法摊熵 —— 但**乘积的低位只依赖输入的低位**,残局盘面极满、低位几乎
///      全 1,直接取低位当槽号会让冲突率暴涨(TT 命中率崩掉,节点数实测 ×2.65);
///   2. 所以末尾加一道 splitmix 式 finalizer,再用**高位**做槽号 —— 乘积的高位
///      依赖输入全部位,稀疏/稠密都摊得开。
/// 不承担正确性:撞槽只会损失一次命中(own/opp 全比对兜底),不会返回错误数据。
inline fn slotOf(b: rules.Board, exact: bool) usize {
    var h = b.own *% 0x9E37_79B9_7F4A_7C15;
    h ^= b.opp *% 0xC2B2_AE3D_27D4_EB4F;
    if (exact) h ^= EXACT_SALT;
    h = h *% 0xFF51_AFD7_ED55_8CCD;
    h ^= h >> 29;
    return @intCast((h >> (64 - TT_BITS)) & TT_MASK);
}

// ── 着法提示表(跨盐)─────────────────────────────────────────────────
// 残局求解前的中层预搜索写的是不带盐的 TT,求解器(带盐)一个条目都读不到,
// 只有根排序 order[] 传得过去 —— 求解树内部的首着法只能靠排序猜。
// 这张小表不存评分语义,只记"这个局面上一轮搜出来的最佳着法",预搜与求解器
// 都读写;命中靠 own/opp 全比对,过期/撞键最多损失一次提示,不会出错。
// 界值仍然只信同盐主表。跨手不清:着法信息按局面寻址,永不过期。
const HINT_BITS = 16;
const HINT_SIZE = 1 << HINT_BITS;
const HINT_MASK: u64 = HINT_SIZE - 1;

const Hint = extern struct {
    own: u64,
    opp: u64,
    move: i8,
    pad: [7]u8 = .{ 0, 0, 0, 0, 0, 0, 0 },
};

threadlocal var hint: [HINT_SIZE]Hint = undefined;

inline fn hintSlotOf(b: rules.Board) usize {
    var h = b.own *% 0x2545_F491_4F6C_DD1D;
    h ^= b.opp *% 0x9E37_79B9_97F4_A7C1;
    h ^= h >> 31;
    return @intCast((h >> (64 - HINT_BITS)) & HINT_MASK);
}

inline fn hintStore(b: rules.Board, mv: u6) void {
    const h = &hint[hintSlotOf(b)];
    h.own = b.own;
    h.opp = b.opp;
    h.move = @intCast(mv);
}

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
threadlocal var ply_moves: [MAX_PLY][MAX_MOVES]u6 = undefined;
threadlocal var ply_flips: [MAX_PLY][MAX_MOVES]u64 = undefined;
threadlocal var ply_scores: [MAX_PLY][MAX_MOVES]i32 = undefined;
threadlocal var ply_cnt: [MAX_PLY]u32 = undefined;

pub threadlocal var nodes: u64 = 0;
pub threadlocal var node_limit: u64 = 0; // 0 = 不限
pub threadlocal var aborted: bool = false;

/// 训练用的 **f32 权重表影子**。非 null 时叶子求值走它(pattern.evalFloat),
/// 训练自对弈因此全程不经过 int8 量化 —— 这是 PTQ 的前提:量化只在训练结束后
/// 做一次,循环里既不夹取也不舍入,量化误差不会逐轮累积进标签。
///
/// ⚠ 谁能置它,必须守住:
///   · `train.zig` 在循环前置上、循环后清掉;
///   · **A/B 必须清掉** —— A/B 的语义就是"打量化后的产物",留着影子表会拿
///     f32 的分值去指导双方着法,对战结果直接失去意义(与 clearTT 那条同级);
///   · wasm(`engine.zig`)永远不置 ⇒ 生产路径行为一行都没变。
///
/// ⚠ 另一处连带:`eps()` 用的是 `pattern.scales`。走影子表时它**仍是从起始书读的**
///   (训练中不再 installQuant),比"真分辨率"大一点 —— 零窗口宽一点点只会少几次
///   重搜,不会吞掉着法,可以接受。
pub var eval_u: ?*const [pattern.PHASES][pattern.ORBITS]f32 = null;

pub fn clearTT() void {
    @memset(std.mem.asBytes(&tt), 0);
    tt_ready = true;
}

/// 增量统计用:本次搜索里 evaluation 被调用的次数(调试/训练统计)
pub threadlocal var evals: u64 = 0;

pub fn terminalScore(b: rules.Board) f32 {
    return @floatFromInt(b.diff());
}

/// 零窗口宽度。必须**小于**分值的量化步长,否则 PVS 会把"同分但更差"的着法
/// 当成超出窗口而白重搜一遍;反过来太大会把真正更好的着法吞掉。
/// 完全求解时分数是整数子差 → 0.5 足够;中局是整数加权和 × scale。
/// ⚠ 相位各有一个 scale,这里取**全部相位的最小者**:eps 的要求是"小于量化
///   步长",偏小是安全方向(偏大会吞掉真正更好的着法),取最小对每个相位都成立。
inline fn eps(exact: bool) f32 {
    if (exact) return 0.5;
    var m = pattern.scales[0];
    for (pattern.scales[1..]) |s| m = @min(m, s);
    return @max(m * 0.25, 1e-4);
}

/// 潜在行动力:与 x 方棋子 8 邻接的空格数(Egaroucid get_potential_mobility 同式)
inline fn potentialMob(x: u64, empty: u64) u64 {
    const h: u64 = x & 0x7E7E_7E7E_7E7E_7E7E;
    const v: u64 = x & 0x00FF_FFFF_FFFF_FF00;
    const hv: u64 = x & 0x007E_7E7E_7E7E_7E00;
    return empty & ((h << 1) | (h >> 1) | (v << 8) | (v >> 8) |
        (hv << 7) | (hv >> 7) | (hv << 9) | (hv >> 9));
}

/// 角上着法数(0..4):排序加权用 —— 对方角行动力比普通行动力贵好几倍
inline fn cornerMob(legal: u64) i32 {
    var n: i32 = 0;
    inline for ([_]u6{ 0, 7, 56, 63 }) |k| {
        if (legal & (@as(u64, 1) << k) != 0) n += 1;
    }
    return n;
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
fn search(b: rules.Board, depth: i32, alpha_in: f32, beta_in: f32, ply: u32, exact: bool) f32 {
    nodes += 1;
    if (node_limit != 0 and nodes > node_limit) {
        aborted = true;
        return 0;
    }

    // ≤7 空:尾部快速路径 —— 不查 TT、不做排序,象限奇偶分流 + last4~1 专用函数。
    // exact 求解里 depth 恒 ≥ 空格数(endgame 分支给 +2 余量),不会误入。
    if (exact) {
        if (64 - b.discs() <= endgame.END_FAST_EMPTIES) {
            return endgame.endFast(b, alpha_in, beta_in, false);
        }
    }

    var alpha = alpha_in;
    var beta = beta_in;
    // 只在 depth > 0 时查表:叶子节点占绝大多数,而叶子的 TT 命中率极低。
    // 定槽只算一次,后面排序提升/写回都复用同一个 slot。
    var slot: usize = 0;
    var promo: i8 = -1; // TT / 提示表给出的首着法(排序提升用)
    if (depth > 0) {
        slot = slotOf(b, exact);
        const e = &tt[slot];
        if (e.own == b.own and e.opp == b.opp) {
            if (e.depth >= depth) {
                if (e.flag == F_EXACT or (e.flag == F_LOWER and e.score >= beta) or (e.flag == F_UPPER and e.score <= alpha)) {
                    return e.score;
                }
            }
            promo = e.move;
        }
        if (promo < 0) {
            const h = &hint[hintSlotOf(b)];
            if (h.own == b.own and h.opp == b.opp) promo = h.move;
        }
    }

    if (ply + 2 >= MAX_PLY or depth <= 0) {
        if (exact) return terminalScore(b);
        evals += 1;
        if (eval_u) |u| return pattern.evalFloat(b, u);
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

    // 稳定子剪枝(仅完全求解:剪枝界是**子差**意义的,中局启发式分不适用)。
    // 窗口足够高时才算稳定性;算出的界要么直接判值,要么收紧 [alpha,beta]。
    if (exact) {
        const c = stability.cut(b, alpha, beta);
        if (c.value) |v| return v;
        alpha = c.alpha;
        beta = c.beta;
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
        if (!exact) {
            // ⑤ 排序补项(Egaroucid move_evaluate 同思想,纯排序不改值):
            //   落一子看落子后的局面 —— 对方行动力(角邻加权)越少越好,
            //   己方潜在行动力越多越好、对方越少越好。每候选一次 playMove+moves,
            //   换 PVS 零窗口试探命中率的提升。
            const nb = rules.playMove(b, sq, f);
            const om = rules.moves(.{ .own = nb.opp, .opp = nb.own });
            s -= (@as(i32, @intCast(@popCount(om))) * 2 + cornerMob(om)) * 8;
            const emp = nb.empty();
            s += @as(i32, @intCast(@popCount(potentialMob(nb.own, emp)))) * 8;
            s -= @as(i32, @intCast(@popCount(potentialMob(nb.opp, emp)))) * 10;
        }
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

    // 置换表/提示表最优着法提到队首。**必须连翻子掩码一起搬** ——
    // 漏搬会让队首着法配到别人的翻子掩码,make 出非法局面(值全错,且很难查)。
    if (promo >= 0) {
        const want: u6 = @intCast(promo);
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
        // ⑦ 留深替换:同槽撞上**同局面**的更深记录时不覆盖(浅结果对深节点
        // 没用,还顶掉了能直接命中的深条目);异局面照常覆盖
        if (!(e.own == b.own and e.opp == b.opp and e.depth > depth)) {
            e.own = b.own;
            e.opp = b.opp;
            e.score = best;
            e.depth = @intCast(depth);
            e.flag = if (best >= beta) F_LOWER else if (best > alpha0) F_EXACT else F_UPPER;
            e.move = @intCast(best_move);
        }
        hintStore(b, best_move);
    }
    return best;
}

/// 残局完全求解(对拍/训练用):depth 给到空位数 + 4 的余量。
/// 虚着不消耗深度,所以虽然加了余量,搜索也一定会走到终局。
pub fn solveExact(b: rules.Board) f32 {
    if (!tt_ready) clearTT();
    stability.ensureInit();
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
    stability.ensureInit();
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
        const pre = @min(@min((empties + 1) / 2, depth_max), empties);
        // 预搜限吃预算的 1/3:预算被预搜耗尽时,完全求解还留得下大头,
        // engineExact() 不会因为"预搜炫技"而丢掉精确性。
        const saved_limit = node_limit;
        if (node_budget != 0) node_limit = @min(node_limit, nodes + node_budget / PRE_ENDGAME_FRAC);
        var last: Result = .{};
        while (d <= pre) : (d += 2) {
            last = rootSearch(b, @intCast(d), false, &order, &rv) catch break;
            if (aborted or last.only) break;
        }
        node_limit = saved_limit;
        if (last.only) {
            // 唯一着法不是"免求解通行证":残局里唯一着法很常见(随机局面 ~5%),
            // 直接返回会带着 score=0 且不带 endgame/exact 标记 ⇒ engineExact()
            // 假报 0、UI 显示凭空的和棋分。落子后递归一次完全求解,把真值补上。
            // ⚠ 不能用 solveExact:它会清掉 node_limit 无限制地解 —— 那就破坏了
            //   "预算截断时 engineExact() 必须为 0"的契约。内联调 search,预算
            //   耗尽时 aborted 置位,engineExact() 照旧报 0。
            // (训练标签不受影响:playGame 对 only 的分数本来就不采信。)
            if (!aborted) {
                const nb = rules.play(b, @intCast(last.move));
                last.score = -search(nb, @intCast(64 - nb.discs() + 4), -INF, INF, 0, true);
                last.exact = true;
                last.endgame = true;
            }
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
    if (top >= 8) {
        // ⑤b 三段阶梯 {top-4, top-2, top}:排序补项(⑤)之后,内部节点有了
        // 像样的先验排序,by-2 全阶梯的早期轮次只剩 TT 预热价值,不值 10~20%
        // 的节点(Egaroucid 同为分段预搜)。浅档(top < 8)保持全阶梯,反正跑不深。
        for ([_]u32{ top -| 4, top -| 2, top }) |dd| {
            if (dd < 2) continue;
            const r = rootSearch(b, @intCast(dd), false, &order, &rv) catch break;
            if (aborted) break;
            res = r;
            res.nodes = nodes;
        }
    } else while (d <= top) : (d += 2) {
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
