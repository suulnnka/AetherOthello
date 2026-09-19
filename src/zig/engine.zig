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

/// 编译期嵌进 wasm 数据段。int8 权重是高熵数据,gzip 基本压不动,
/// 所以它就是体积预算里那块"躲不掉的" —— 别指望靠压缩省它。
const weights = @embedFile("weights.bin");

var last: search.Result = .{};

/// 0 = 就绪;非 0 = 失败步(见 pattern.failStage 的取值)
export fn engineInit() u32 {
    if (!pattern.init(weights)) return pattern.failStage;
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
    last = search.think(mk(ownLo, ownHi, oppLo, oppHi), depth, endgame, bud);
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
export fn engineExact() u32 {
    if (search.aborted) return 0;
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
