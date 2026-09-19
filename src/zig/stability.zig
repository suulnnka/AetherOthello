// 稳定子(stable discs)计算与残局剪枝 —— 思想对齐 Egaroucid/edax 的
// stability cut,表结构与生成方式为本仓库自己的实现。
//
// 定义:一枚子是**稳定的**,指任何后续着法序列都不可能把它翻掉。稳定子给出
// 点差的硬下界:己方最终至少保住 stab_own 枚、对方至多拿到 64 − stab_own 枚,
// 于是 diff ≥ 2·stab_own − 64(对方视角同理取上界)。在完全求解里用这组界
// 收紧 [alpha, beta],等价于免费砍掉一大片子树。
//
// 计算 = 三层近似(只会**少报**不会多报,少报是安全方向 —— 多报会让剪枝界
// 变松,完全求解给出错误精确分):
//   1. 边表:四条边线上的稳定性可以**精确**按线计算 —— 一条 8 格线内能否翻
//      只取决于这条线本身(边格唯一的可翻线就是它所在的边线,见下方论证)。
//      全部 256×256 个 (己方线型, 对方线型) 组合在 init 时推平,运行时查表。
//   2. 全满行/列:一整行(列)全占满 ⇒ 线上没有空格 ⇒ 谁也翻不动。逐字节判满。
//   3. 闭包:一枚子若在穿过它的每条线上都有一枚**已稳定**的同色邻居(或该线
//      全满),它自己也不可能被翻(翻它需要从两端夹,稳定端先翻 ⇒ 矛盾)。
//      迭代到不动点。对角线没有"全满"种子(移位多项式难以证明无幻影),但
//      闭包的移位项照常工作 —— 少一层种子只是收敛慢一点,不会算错。
//
// ── 为什么这些近似是可靠的 ────────────────────────────────────
//   · 边格的可翻性:边格 (r,0) 在它的行线与两条对角线上都是**线端**(另一端
//     出界),翻子需要两端夹 ⇒ 只有列线能翻它;列线恰是边线,被边表精确覆盖。
//     角格四条线全是线端,恒稳定。
//   · 闭包移位的幻影:>>1/<<1 不带边掩码时,列 0 的格子会从上一行借来幻影
//     左邻;但那是在**行线**上 —— 列 0 格子在行线上是线端、本来翻不动,该
//     条件空转,幻影无害。8/7/9 移位同理(幻影只出现在边格的无害方向上)。
//
// ⚠ 边表与记忆化表(64KB + 64KB)在 init 生成,放 BSS —— 写成 comptime 会把
//   wasm 撑爆 1MB+,红线见 docs/engine-improvement-plan.md。
const std = @import("std");
const rules = @import("rules.zig");

/// 边表:[己方线型][对方线型] → 稳定子位板(分别摊在 row0 / col0 上,取用时移位)。
/// 线型 = 8 bit,bit i = 线上第 i 格(横线:col=i;竖线:row=i)。
var edge_h: [256][256]u64 = undefined; // 稳定子摊在 bit 0..7(第 0 行)
var edge_v: [256][256]u64 = undefined; // 稳定子摊在 bit 0,8,..,56(第 0 列)

/// NWS 稳定子剪枝门槛(按空位数):alpha 低于门槛时不值得花一次稳定性计算。
/// edax 同源的经验表;99 = 永不。
const nws_threshold = [61]u8{
    99, 99, 99, 4,  6,  8,  10, 12,
    14, 16, 20, 22, 24, 26, 28, 30,
    32, 34, 36, 38, 40, 42, 44, 46,
    48, 48, 50, 50, 52, 52, 54, 54,
    56, 56, 58, 58, 60, 60, 62, 62,
    64, 64, 64, 64, 64, 64, 64, 64,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99,
};

// ── 单线精确稳定子(带记忆化)──────────────────────────────────────────
// 裸递归是 O(n!·2^n)(每层对每个空格试黑白两手):一条全空线 ~10M 次模拟,
// 3 万个线型对直接算要几十秒。所有中间局面都是 256×256 状态空间里的点,
// 记忆化后总工作量 = 不相交状态数 3^8 = 6561 × 常数,毫秒级。

var memo: [256][256]u8 = undefined;
var known: [256][256]u1 = undefined;

/// 单线模拟:owner 在 place 落子后的新局面(只处理这条线)。
/// np = owner 落子并翻子;no = 对方被翻走之后剩下的。
fn probablyMoveLine(p: u8, o: u8, place: u3, np: *u8, no: *u8) void {
    np.* = p | (@as(u8, 1) << place);
    // 向左:连续对方子走到头,尽头是己方子才翻得动(i>0 先判,防负移位)
    var i: i32 = @as(i32, place) - 1;
    while (i > 0 and (o >> @as(u3, @intCast(i))) & 1 != 0) : (i -= 1) {}
    if ((p >> @as(u3, @intCast(i))) & 1 != 0) {
        var j: i32 = @as(i32, place) - 1;
        while (j > i) : (j -= 1) np.* ^= @as(u8, 1) << @as(u3, @intCast(j));
    }
    i = @as(i32, place) + 1;
    while (i < 7 and (o >> @as(u3, @intCast(i))) & 1 != 0) : (i += 1) {}
    if ((p >> @as(u3, @intCast(i))) & 1 != 0) {
        var j: i32 = @as(i32, place) + 1;
        while (j < i) : (j += 1) np.* ^= @as(u8, 1) << @as(u3, @intCast(j));
    }
    no.* = o & ~np.*;
}

/// 一条线上的精确稳定子:双方轮流把每个空格试着走一遍取交集
/// (空格被走掉之后局面变化,剩余稳定子必须在每个后续局面里都稳定)。
fn calcStabilityLine(b: u8, w: u8) u8 {
    if (known[b][w] != 0) return memo[b][w];
    var res: u8 = b | w;
    const empties: u8 = ~(b | w);
    var i: u6 = 0;
    while (i < 8) : (i += 1) {
        if ((empties >> @as(u3, @intCast(i))) & 1 != 0) {
            var nb: u8 = undefined;
            var nw: u8 = undefined;
            probablyMoveLine(b, w, @intCast(i), &nb, &nw);
            res &= b | nw;
            res &= calcStabilityLine(nb, nw);
            probablyMoveLine(w, b, @intCast(i), &nw, &nb);
            res &= w | nb;
            res &= calcStabilityLine(nb, nw);
        }
    }
    memo[b][w] = res;
    known[b][w] = 1;
    return res;
}

var ready = false;

/// 生成边表。幂等:首次调用后 no-op(多线程同时首调会重复算一遍,结果相同,
/// 字节级幂等 —— 训练器的线程池先于首局建好,实际不会撞)。
pub fn ensureInit() void {
    if (ready) return;
    for (&known) |*row| @memset(row, 0);
    var b: u16 = 0;
    while (b < 256) : (b += 1) {
        var w: u16 = 0;
        while (w < 256) : (w += 1) {
            if (b & w != 0) { // 同格双占,非法线型:稳定子为空(永远不该被查到)
                edge_h[b][w] = 0;
                edge_v[b][w] = 0;
                memo[b][w] = 0;
                known[b][w] = 1;
                continue;
            }
            const stab = calcStabilityLine(@intCast(b), @intCast(w));
            var hb: u64 = 0;
            var vb: u64 = 0;
            var i: u6 = 0;
            while (i < 8) : (i += 1) {
                if ((stab >> @as(u3, @intCast(i))) & 1 != 0) {
                    hb |= @as(u64, 1) << @as(u6, @intCast(i));
                    vb |= @as(u64, 1) << @intCast(8 * i);
                }
            }
            edge_h[b][w] = hb;
            edge_v[b][w] = vb;
        }
    }
    ready = true;
}

// ── 全满行/列:线内 8 格全有子 ⇒ 该线谁也翻不动 ─────────────────────────
//
// ⚠ 只做行/列,不做对角线;且**逐字节判满**,不用 Egaroucid 那套移位多项式:
//   它的 full_stability_v 用 (f>>8)|(f<<56) 循环移位,把"第 7 行与第 0 行相邻"
//   当真 —— 8 行缺 1 的列会被判成全满(稳定子多报 ⇒ 精确界出错 ⇒ 剪错);
//   full_stability_h 的 >>1 同样跨行边界制造幻影。这里宁可少报(安全方向)。

fn fullStabH(occ: u64) u64 {
    var h: u64 = 0;
    inline for (0..8) |r| {
        if ((occ >> @as(u6, @intCast(8 * r))) & 0xFF == 0xFF) h |= @as(u64, 0xFF) << @intCast(8 * r);
    }
    return h;
}

/// 提取一条边线的 8bit 线型。**逐位收集**,不用转置乘法 ——
/// 那个经典技巧 (g*K)>>56 只对 col 0 的收集成立,第 7 列会丢位/串位(实测推演)。
inline fn colByte(x: u64, comptime col: u3) u8 {
    var b: u8 = 0;
    inline for (0..8) |r| {
        b |= @as(u8, @intCast((x >> @as(u6, @intCast(col + 8 * r))) & 1)) << @intCast(r);
    }
    return b;
}

fn fullStabV(occ: u64) u64 {
    var v: u64 = 0;
    inline for (0..8) |c| {
        if (colByte(occ, c) == 0xFF) v |= 0x0101_0101_0101_0101 << @intCast(c);
    }
    return v;
}

// ── 全满对角线:popcount 判满版 ──────────────────────────────────────────
// 对角线没有干净的移位判满法(移位会跨边界制造幻影),但"整条对角线全占"
// 等价于"占子数 == 线长",用预生成的对角掩码 + popcount 即可,每方向 15 条。
// 全满线**只作闭包的生长支持**,不进种子 —— 种子规则见 closureOf 的说明。

const DIAG_RC: [15]u64 = blk: { // r − c = d(d ∈ [-7,7]),位板移位方向 ±9
    var m: [15]u64 = undefined;
    for (0..15) |k| {
        const d: i32 = @as(i32, @intCast(k)) - 7;
        var bits: u64 = 0;
        var r: i32 = @max(0, d);
        while (r <= @min(7, 7 + d)) : (r += 1) bits |= @as(u64, 1) << @intCast(r * 8 + (r - d));
        m[k] = bits;
    }
    break :blk m;
};
const DIAG_RS: [15]u64 = blk: { // r + c = s(s ∈ [0,14]),位板移位方向 ±7
    var m: [15]u64 = undefined;
    for (0..15) |k| {
        const s: i32 = @intCast(k);
        var bits: u64 = 0;
        var r: i32 = @max(0, s - 7);
        while (r <= @min(7, s)) : (r += 1) bits |= @as(u64, 1) << @intCast(r * 8 + (s - r));
        m[k] = bits;
    }
    break :blk m;
};

fn fullStabDiag(occ: u64, comptime masks: [15]u64) u64 {
    var out: u64 = 0;
    inline for (masks) |m| {
        // 线长 = popCount(m);全占 ⇔ occ 覆盖整条掩码
        if (@popCount(occ & m) == @popCount(m)) out |= m;
    }
    return out;
}

/// 6×6 内部格掩码:全满线种子只用于内部格(边格由边表精确覆盖)
const INTERIOR: u64 = 0x0000_007E_7E7E_7E7E;

// d7 = ±7 移位那条线(r+c 常数),d9 = ±9 移位那条线(r−c 常数)——
// 全满豁免必须与移位邻居条件**同线**,配错线会退化成单线支撑(实测踩过)。
const FullLines = struct { h: u64, v: u64, d7: u64, d9: u64 };

fn closureOf(discs: u64, edge_stab: u64, full: FullLines) u64 {
    // ⚠ 种子**只放边表**。全满行/列不能直接当种子 —— 行满+列满的子仍可能沿
    //   对角线被翻;种子必须逐枚都是真稳定,否则闭包把过高的稳定性滚雪球,
    //   精确界出错(probe 实测踩过)。全满线作为**生长支持**是可靠的:线满 ⇒
    //   该线永远不会被落子 ⇒ 该线方向的支撑条件可以无条件满足。四线全满的
    //   子会在第一轮生长就被标稳定,与"四线种子"同不动点、且每步都可靠。
    var acc: u64 = edge_stab & discs;
    while (true) {
        const grown = ((acc >> 1) | (acc << 1) | full.h) &
            ((acc >> 8) | (acc << 8) | full.v) &
            ((acc >> 7) | (acc << 7) | full.d7) &
            ((acc >> 9) | (acc << 9) | full.d9) & discs & INTERIOR;
        const next = acc | grown;
        if (next == acc) break;
        acc = next;
    }
    return acc;
}

inline fn rowByte(x: u64, comptime row: u3) u8 {
    return @truncate(x >> @as(u6, @as(u6, row) * 8));
}

/// 双方稳定子计数(一次调用算两色 —— 全满线/边表只跑一遍,闭包各跑各的)
pub fn stableCounts(b: rules.Board) struct { own: u32, opp: u32 } {
    const occ = b.own | b.opp;
    const full = FullLines{
        .h = fullStabH(occ),
        .v = fullStabV(occ),
        .d7 = fullStabDiag(occ, DIAG_RS),
        .d9 = fullStabDiag(occ, DIAG_RC),
    };
    // 四条边(上下横线、左右竖线)的稳定子合到一张位板上
    const eb = edge_h[rowByte(b.own, 0)][rowByte(b.opp, 0)] |
        edge_h[rowByte(b.own, 7)][rowByte(b.opp, 7)] << 56 |
        edge_v[colByte(b.own, 0)][colByte(b.opp, 0)] |
        edge_v[colByte(b.own, 7)][colByte(b.opp, 7)] << 7;
    const so = closureOf(b.own, eb, full);
    const sp = closureOf(b.opp, eb, full);
    return .{ .own = @popCount(so), .opp = @popCount(sp) };
}

/// 稳定子剪枝的结果:value 非 null = 窗口可直接判值(不再搜子树);
/// 否则 alpha/beta 是收紧后的窗口(可能未变),搜索继续。
pub const CutOutcome = struct { value: ?f32, alpha: f32, beta: f32 };

/// 稳定子剪枝入口。单位:子差(f32,与 search 一致)。
/// **只许在 exact 搜索里调用** —— "diff ≥ 2·stab−64" 是子差意义的界,
/// 中局启发式分不适用。
pub fn cut(b: rules.Board, alpha_in: f32, beta_in: f32) CutOutcome {
    const empties = 64 - b.discs();
    const th = nws_threshold[empties];
    const alpha = alpha_in;
    const beta = beta_in;
    if (alpha < @as(f32, @floatFromInt(th))) return .{ .value = null, .alpha = alpha, .beta = beta };
    const sc = stableCounts(b);
    const n_alpha = 2.0 * @as(f32, @floatFromInt(sc.own)) - 64.0;
    const n_beta = 64.0 - 2.0 * @as(f32, @floatFromInt(sc.opp));
    if (beta <= n_alpha) return .{ .value = n_alpha, .alpha = alpha, .beta = beta };
    if (n_beta <= alpha) return .{ .value = n_beta, .alpha = alpha, .beta = beta };
    if (n_beta <= n_alpha) return .{ .value = n_alpha, .alpha = alpha, .beta = beta };
    return .{ .value = null, .alpha = @max(alpha, n_alpha), .beta = @min(beta, n_beta) };
}

// ── 单元测试 ─────────────────────────────────────────────────────────────

test "单线稳定子:单子不稳,满线全稳,端部连子稳" {
    ensureInit();
    // 只有中心一枚己方子:两侧全空 ⇒ 对方占任一侧即可夹 ⇒ 不稳
    try std.testing.expectEqual(@as(u8, 0), calcStabilityLine(0b0000_1000, 0));
    // 满线:每个子都稳定
    try std.testing.expectEqual(@as(u8, 0xFF), calcStabilityLine(0b1100_0011, 0b0011_1100));
    // 角端两连子(bit0,1):bit1 要被翻需 bit0 先翻,bit0 是线端翻不动 ⇒ 全稳
    try std.testing.expectEqual(@as(u8, 0b11), calcStabilityLine(0b0000_0011, 0));
    // 记忆化幂等:再查一遍同值
    try std.testing.expectEqual(@as(u8, 0b11), calcStabilityLine(0b0000_0011, 0));
}

test "稳定子计数:整条满边全稳,空盘角不凭空多报" {
    ensureInit();
    // a1 角 + 一整条满底边,对方散两枚内部子
    const corner: u64 = 1;
    const full_bottom = @as(u64, 0xFF) << 56;
    const b = rules.Board{ .own = corner | full_bottom, .opp = (@as(u64, 1) << 19) | (@as(u64, 1) << 36) };
    const sc = stableCounts(b);
    // a1 角稳定 + 底边 8 枚全稳定(h1 角也在其中)
    try std.testing.expect(sc.own >= 9);
    // 对方两枚孤子不得被算成稳定
    try std.testing.expectEqual(@as(u32, 0), sc.opp);
}

test "初始局面:没有边子,双方稳定子都是 0" {
    ensureInit();
    const sc = stableCounts(rules.Board.initial);
    try std.testing.expectEqual(@as(u32, 0), sc.own);
    try std.testing.expectEqual(@as(u32, 0), sc.opp);
}
