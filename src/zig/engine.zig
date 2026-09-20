// wasm 导出层:C ABI,**不 import 任何东西**(freestanding)。
//
// 设计约定(应用侧/worker 侧要照着写):
//   · u64 位板不走 wasm 的 i64(JS 侧要 BigInt,边界上很容易出错),而是拆成
//     lo/hi 两个 u32 传 —— 拼装在这儿做一次,只有一处可能写错。
//   · 所有导出函数都**不分配**、不抛异常、不返回错误,只返回数字。
//     出错(int8 权重书坏了)用 `engineInit()` 的返回值表达:0 = 好,
//     非 0 = pattern.failStage,直接是个可读的排障数字。
//   · `engineThink` 是唯一"重"的函数,同步跑完;要中断只能 terminate worker
//     (worker 里的搜索是同步的,消息只会排队)。
const std = @import("std");
const rules = @import("rules.zig");
const pattern = @import("pattern.zig");
const search = @import("search.zig");
const inc = @import("inc.zig");

/// 编译期嵌进 wasm 数据段。int8 权重是高熵数据,gzip 基本压不动,
/// 所以它就是体积预算里那块"躲不掉的" —— 别指望靠压缩省它。
const weights = @embedFile("weights.bin");

// ── ⑩ 迷你开局书:着法主线 →「局面 → 可行着法集」查找表 ────────────────
// book.bin 由 `zig build genbook` 自对弈生成(400 条主线 × 12 手,6 bit/手),
// 只含引擎自己下出来的着法 —— 无外部数据。init 时回放展开成开放寻址表,
// think 命中则直接出着法(跳过搜索):开局阶段零延迟、着法多样、不呆板。
const book_bin = @embedFile("book.bin");
const BOOK_PLY = 12;
const BK_CAP = 8192; // 2 的幂;≤400×12 = 4800 项,负载 <60%
const BK_MASK: u64 = BK_CAP - 1;
var bk_key_own: [BK_CAP]u64 = undefined;
var bk_key_opp: [BK_CAP]u64 = undefined;
var bk_next: [BK_CAP]u64 = undefined; // 可行着法位掩码;0 = 空槽
var bk_ready = false;

fn bookHash(own: u64, opp: u64) usize {
    var h = own *% 0x9E37_79B9_7F4A_7C15;
    h ^= opp *% 0xC2B2_AE3D_27D4_EB4F;
    h ^= h >> 29;
    return @intCast(h & BK_MASK);
}

fn bookInsert(b: rules.Board, mv: u6) void {
    var s = bookHash(b.own, b.opp);
    while (true) {
        if (bk_next[s] == 0) {
            bk_key_own[s] = b.own;
            bk_key_opp[s] = b.opp;
        }
        if (bk_key_own[s] == b.own and bk_key_opp[s] == b.opp) {
            bk_next[s] |= @as(u64, 1) << mv;
            return;
        }
        s = @intCast((s + 1) & BK_MASK);
    }
}

fn bookInit() void {
    const n: usize = book_bin[0] | (@as(usize, book_bin[1]) << 8);
    var i: usize = 0;
    while (i < n) : (i += 1) {
        const off = 2 + i * 9;
        var v: u72 = 0;
        var by: usize = 0;
        while (by < 9) : (by += 1) v = (v << 8) | book_bin[off + by];
        var b = rules.Board.initial;
        var k: usize = 0;
        while (k < BOOK_PLY) : (k += 1) {
            const mv: u6 = @intCast((v >> @intCast(66 - 6 * k)) & 0x3F);
            bookInsert(b, mv);
            b = rules.play(b, mv);
        }
    }
    bk_ready = true;
}

/// 命中开局书则返回着法。depth_max ≥ 4 才用(入门/初级保持原味);
/// rng_state ≠ 0 时在书内着法里随机(⑪ 的种子),否则取最低位(确定)。
fn bookMove(b: rules.Board, depth_max: u32) ?u6 {
    if (!bk_ready or depth_max < 4) return null;
    if (b.discs() > 4 + 2 * BOOK_PLY) return null;
    var s = bookHash(b.own, b.opp);
    while (true) {
        if (bk_next[s] == 0) return null;
        if (bk_key_own[s] == b.own and bk_key_opp[s] == b.opp) break;
        s = @intCast((s + 1) & BK_MASK);
    }
    var m = bk_next[s] & rules.moves(b);
    if (m == 0) return null;
    if (search.rng_state != 0) {
        const cnt: u64 = @popCount(m);
        var pick = search.rng_state % cnt;
        while (m != 0) {
            const low: u6 = @intCast(@ctz(m));
            if (pick == 0) return low;
            m &= m - 1;
            pick -= 1;
        }
    }
    return @intCast(@ctz(m));
}

var last: search.Result = .{};

/// ⑥ MPC 开关与置信度系数(mpct,典型 1.64 ≈ 95% 单侧)。flag=0 关闭。
export fn engineSetMpc(flag: u32, mpct: f32) void {
    search.mpc_enabled = flag != 0;
    search.mpc_mpct = mpct;
}

/// ⑥b 尾盘 MPC:exact 求解的纯精确带下沿(空位数)。>0 时「空数 > 下沿+1」
/// 的求解节点允许中局验证剪枝(概率性,engineExact() 届时报 0);
/// 0 = 关闭(现状)。典型用法:engineThink 的 end 抬到 20,这里给 16。
export fn engineSetEndMpc(pure: u32) void {
    search.mpc_end_pure = @intCast(pure);
}

/// ⑪ 根同分随机化种子(lo/hi 拼 u64)。0 = 完全确定(缺省)。
export fn engineSetSeed(lo: u32, hi: u32) void {
    search.rng_state = @as(u64, lo) | (@as(u64, hi) << 32);
}
/// 0 = 就绪;非 0 = 失败步(见 pattern.failStage 的取值)
export fn engineInit() u32 {
    if (!pattern.init(weights)) return pattern.failStage;
    bookInit();
    inc.initTables(); // ④ 增量评估的每格特征表(搜索入口还有懒建兜底)
    return 0;
}

export fn engineReady() u32 {
    return if (pattern.ready) 1 else 0;
}
export fn engineOrbits() u32 {
    return pattern.ORBITS;
}
export fn engineWeightBytes() u32 {
    return @intCast(weights.len);
}
/// 定标:eval = scale × Σ int8。应用侧要显示"子数"时乘它。
/// ⚠ 每相位一个 scale(v2 起);这个导出是 `pong` 里的**诊断字段**,只报相位 0。
///   严格换算要按子数选相位 —— 但没有任何应用逻辑依赖它。
export fn engineScale() f32 {
    return pattern.scales[0];
}

inline fn mk(ownLo: u32, ownHi: u32, oppLo: u32, oppHi: u32) rules.Board {
    return .{
        .own = @as(u64, ownLo) | (@as(u64, ownHi) << 32),
        .opp = @as(u64, oppLo) | (@as(u64, oppHi) << 32),
    };
}

/// 行棋方视角的模式评估(单位:子数)
export fn engineEval(ownLo: u32, ownHi: u32, oppLo: u32, oppHi: u32) f32 {
    return pattern.eval(mk(ownLo, ownHi, oppLo, oppHi));
}

/// 迭代加深主入口。返回着法 0..63;-1 = 没有合法着法。
/// budgetLo/budgetHi 拼成 u64 节点预算,**0 = 不限**。
/// 难度请用节点预算而不是纯深度:真权重书下 depth 8 最慢约 0.5 s/手。
export fn engineThink(
    ownLo: u32,
    ownHi: u32,
    oppLo: u32,
    oppHi: u32,
    depth: u32,
    endgame: u32,
    budgetLo: u32,
    budgetHi: u32,
) i32 {
    if (!pattern.ready) return -1;
    const bud = @as(u64, budgetLo) | (@as(u64, budgetHi) << 32);
    // ⑩ 开局书命中:直接出着法,不搜索(score=0,exact/endgame 均 false)
    if (bookMove(mk(ownLo, ownHi, oppLo, oppHi), depth)) |mv| {
        last = .{ .move = @intCast(mv), .score = 0, .depth = 0 };
        return mv;
    }
    last = search.thinkSeeded(mk(ownLo, ownHi, oppLo, oppHi), depth, endgame, bud, search.rng_state);
    return if (last.move < 0) -1 else @intCast(last.move);
}

export fn engineScore() f32 {
    return last.score;
}
/// 这一手实际跑完的深度(节点预算先用满时它会低于标称深度)
export fn engineDepth() u32 {
    return last.depth;
}
/// 这一手是否给出了**可信的精确解**。
/// ⚠ 预算耗尽时必须报 0:残局分支在 aborted 时返回的是「前置中层迭代的最后一轮」,
///   只是个启发式估值,UI 若拿它当终局判决就会显示凭空的"胜 N 子"(踩过)。
/// ⚠ ⑥b 尾盘 MPC 命中过剪枝的求解同样必须报 0:结果含概率成分,不是精确解。
export fn engineExact() u32 {
    if (search.aborted or search.mpc_end_used) return 0;
    return if (last.exact or last.endgame) 1 else 0;
}
export fn engineNodesLo() u32 {
    return @truncate(search.nodes);
}
export fn engineNodesHi() u32 {
    return @truncate(search.nodes >> 32);
}

/// 换局 / 换难度时清置换表。不清也不会算错(键里有 Zobrist 校验),
/// 但会带着上一局的结论跑,容易出"同一局面两次给不同着法"的观感问题。
export fn engineClear() void {
    search.clearTT();
}
