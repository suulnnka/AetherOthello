// 残局尾部专用路径:≤7 空快速搜索 + last1~4 逐空格专用函数。
// 思想对齐 Egaroucid 的 END_FAST_DEPTH / nega_alpha_end_fast / last1..last4,
// 实现是本仓库自己的(翻子直接用 rules.flips,不建方向计数表 —— 先量测,
// 尾部路径的大头收益在"跳过通用节点流程",不在翻子计数的几个时钟周期)。
//
// 为什么快:
//   · ≤7 空不走通用 search():没有 TT 读写(这个深度 TT 命中率低、写入浪费)、
//     没有着法排序评分、没有置换表着法提升 —— 只剩"生成翻子 → 递归"。
//   · last4/last3 按象限奇偶排序空格:先占奇数空格的象限(终局"谁走最后一步"
//     的争夺),压掉一半对称子树。
//   · last4 带稳定子剪枝;last1 直接读盘算终局分,连递归都没有。
//   · 每个函数用裸参数传空格号,不再维护着法数组。
//
// 正确性契约:
//   · 全部函数返回**行棋方视角**的精确子差,与 search(exact=true) 同语义;
//     probe-exact / probe-wasm 的逐局面对拍是硬闸。
//   · 预算照守:每个入口都做 nodes 计数与 node_limit 检查,aborted 即返回
//     (engineExact() 会因 aborted 报 0,所以半途值去哪儿都无所谓)。
const std = @import("std");
const rules = @import("rules.zig");
const stability = @import("stability.zig");
const search = @import("search.zig");

/// ≤ N 空走快速路径(Egaroucid END_FAST_DEPTH 同款)
pub const END_FAST_EMPTIES: u32 = 7;

const INF: f32 = 1e30;

// ── 象限奇偶 ─────────────────────────────────────────────────────────────
// 4×4 象限:终局经典事实 —— 空格连通区域为奇数时,"在该区域走最后一手"的
// 归属由奇偶决定;先走奇象限可以把对手的着法选择压到最少。

const QMASK = [4]u64{
    0x0000_0000_0F0F_0F0F, // 行 0-3,列 0-3
    0x0000_0000_F0F0_F0F0, // 行 0-3,列 4-7
    0x0F0F_0F0F_0000_0000, // 行 4-7,列 0-3
    0xF0F0_F0F0_0000_0000, // 行 4-7,列 4-7
};

inline fn quadOf(sq: u6) u2 {
    // 行 ≥4 → bit1,列 ≥4 → bit0
    return @as(u2, @intCast((sq >> 5) & 1)) << 1 | @as(u2, @intCast((sq >> 2) & 1));
}

/// 每象限空格数的奇偶位
inline fn parityOf(empty: u64) u4 {
    var par: u4 = 0;
    inline for (QMASK, 0..) |q, i| {
        if (@popCount(empty & q) & 1 != 0) par |= @as(u4, 1) << @intCast(i);
    }
    return par;
}

// ── 记账 ─────────────────────────────────────────────────────────────────

inline fn tick() bool {
    search.nodes += 1;
    if (search.node_limit != 0 and search.nodes > search.node_limit) {
        search.aborted = true;
        return false;
    }
    return true;
}

inline fn terminal(b: rules.Board) f32 {
    return @floatFromInt(b.diff());
}

/// 空格按象限奇偶排序(奇象限优先)。n ≤ 4,插入排序足够。
fn orderCells(cells: []u6, empty: u64) void {
    const par = parityOf(empty);
    for (1..cells.len) |i| {
        const cur = cells[i];
        const cur_odd = (par >> quadOf(cur)) & 1;
        var j: usize = i;
        while (j > 0 and ((par >> quadOf(cells[j - 1])) & 1) < cur_odd) : (j -= 1) {
            cells[j] = cells[j - 1];
        }
        cells[j] = cur;
    }
}

// ── last1~4 ──────────────────────────────────────────────────────────────

/// 最后 1 空:直接算终局分。base = 64 − 2·对方子数(我方落子后满盘的点差基量)。
fn last1(b: rules.Board, p0: u6) f32 {
    if (!tick()) return 0;
    const base: f32 = @floatFromInt(64 - 2 * @as(i32, @popCount(b.opp)));
    const f = rules.flips(b, p0);
    if (f != 0) return base + 2.0 * @as(f32, @floatFromInt(@popCount(f)));
    // 我方翻不动 → 虚着,对方落最后一格
    const sw = rules.Board{ .own = b.opp, .opp = b.own };
    const nf2 = @popCount(rules.flips(sw, p0));
    if (nf2 > 0) return base - 2.0 - 2.0 * @as(f32, @floatFromInt(nf2));
    return base - 1.0; // 双方都无棋:终局,空格留着
}

fn last2(b: rules.Board, alpha_in: f32, beta_in: f32, p0: u6, p1: u6, skipped: bool) f32 {
    if (!tick()) return 0;
    var alpha = alpha_in;
    const beta = beta_in;
    var v: f32 = -INF;
    const f0 = rules.flips(b, p0);
    if (f0 != 0) {
        const g = -last1(rules.playMove(b, p0, f0), p1);
        if (g > v) v = g;
        if (g > alpha) alpha = g;
        if (alpha >= beta) return v;
    }
    const f1 = rules.flips(b, p1);
    if (f1 != 0) {
        const g = -last1(rules.playMove(b, p1, f1), p0);
        if (g > v) v = g;
        if (g > alpha) alpha = g;
    }
    if (v == -INF) {
        if (skipped) return terminal(b);
        const sw = rules.Board{ .own = b.opp, .opp = b.own };
        return -last2(sw, -beta, -alpha, p0, p1, true);
    }
    return v;
}

fn last3(b: rules.Board, alpha_in: f32, beta_in: f32, cells: [3]u6, skipped: bool) f32 {
    if (!tick()) return 0;
    var cs = cells;
    orderCells(&cs, b.empty());
    var alpha = alpha_in;
    const beta = beta_in;
    var v: f32 = -INF;
    inline for (0..3) |i| {
        const p = cs[i];
        const f = rules.flips(b, p);
        if (f != 0) {
            const rest: [2]u6 = .{ cs[(i + 1) % 3], cs[(i + 2) % 3] };
            const g = -last2(rules.playMove(b, p, f), -beta, -alpha, rest[0], rest[1], false);
            if (g > v) v = g;
            if (g > alpha) alpha = g;
            if (alpha >= beta) return v;
        }
    }
    if (v == -INF) {
        if (skipped) return terminal(b);
        const sw = rules.Board{ .own = b.opp, .opp = b.own };
        return -last3(sw, -beta, -alpha, cells, true);
    }
    return v;
}

fn last4(b: rules.Board, alpha_in: f32, beta_in: f32, cells: [4]u6, skipped: bool) f32 {
    if (!tick()) return 0;
    // 稳定子剪枝(Egaroucid last4 同款)
    const cut = stability.cut(b, alpha_in, beta_in);
    if (cut.value) |vv| return vv;
    var alpha = cut.alpha;
    const beta = cut.beta;
    var cs = cells;
    orderCells(&cs, b.empty());
    var v: f32 = -INF;
    inline for (0..4) |i| {
        const p = cs[i];
        const f = rules.flips(b, p);
        if (f != 0) {
            var rest: [3]u6 = undefined;
            var k: usize = 0;
            inline for (0..4) |jj| {
                if (jj != i) {
                    rest[k] = cs[jj];
                    k += 1;
                }
            }
            const g = -last3(rules.playMove(b, p, f), -beta, -alpha, rest, false);
            if (g > v) v = g;
            if (g > alpha) alpha = g;
            if (alpha >= beta) return v;
        }
        if (search.aborted) return v;
    }
    if (v == -INF) {
        if (skipped) return terminal(b);
        const sw = rules.Board{ .own = b.opp, .opp = b.own };
        return -last4(sw, -beta, -alpha, cells, true);
    }
    return v;
}

// ── ≤7 空快速路径 ────────────────────────────────────────────────────────

/// 从 search() 的 exact 分支派发进来。空格数 5..7;5 空时落子后进 last4。
pub fn endFast(b: rules.Board, alpha_in: f32, beta_in: f32, skipped: bool) f32 {
    if (!tick()) return 0;
    const cut = stability.cut(b, alpha_in, beta_in);
    if (cut.value) |vv| return vv;
    var alpha = cut.alpha;
    const beta = cut.beta;

    const empty = b.empty();
    const em: u32 = @popCount(empty);

    if (em == 5) {
        // 落子后剩 4 空 → last4。着法按象限奇偶排序(与 last4 的空格排序同理)。
        var cs: [5]u6 = undefined;
        var n: usize = 0;
        var mm = empty;
        while (mm != 0) : (n += 1) {
            cs[n] = @intCast(@ctz(mm));
            mm &= mm - 1;
        }
        orderCells(&cs, empty);
        var v: f32 = -INF;
        inline for (0..5) |i| {
            const p = cs[i];
            const f = rules.flips(b, p);
            if (f != 0) {
                var rest: [4]u6 = undefined;
                var k: usize = 0;
                inline for (0..5) |jj| {
                    if (jj != i) {
                        rest[k] = cs[jj];
                        k += 1;
                    }
                }
                const g = -last4(rules.playMove(b, p, f), -beta, -alpha, rest, false);
                if (g > v) v = g;
                if (g > alpha) alpha = g;
                if (alpha >= beta) return v;
            }
            if (search.aborted) return v;
        }
        if (v == -INF) {
            if (skipped) return terminal(b);
            const sw = rules.Board{ .own = b.opp, .opp = b.own };
            return -endFast(sw, -beta, -alpha, true);
        }
        return v;
    }

    // 6/7 空:象限奇偶分流 —— 先试奇象限的着法
    const par = parityOf(empty);
    var v: f32 = -INF;
    inline for (0..2) |round| {
        const want_odd: u1 = @intCast(round); // 第 0 轮奇象限,第 1 轮偶象限
        var mm = empty;
        while (mm != 0) {
            const sq: u6 = @intCast(@ctz(mm));
            mm &= mm - 1;
            if (((par >> quadOf(sq)) & 1) != want_odd) continue;
            const f = rules.flips(b, sq);
            if (f == 0) continue;
            const g = -endFast(rules.playMove(b, sq, f), -beta, -alpha, false);
            if (g > v) v = g;
            if (g > alpha) alpha = g;
            if (alpha >= beta) return v;
            if (search.aborted) return v;
        }
    }
    if (v == -INF) {
        if (skipped) return terminal(b);
        const sw = rules.Board{ .own = b.opp, .opp = b.own };
        return -endFast(sw, -beta, -alpha, true);
    }
    return v;
}
