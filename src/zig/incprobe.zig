// ④ 增量评估的 wasm 探针导出层 —— **独立产物 incprobe.wasm**,不进生产
// othello.wasm、不占 webos 体积闸门。
//
// 存在的理由(呼应 docs/engine-improvement-plan.md 完成记录"遗留 1"):
// ④ 首轮"原生对、wasm 漂"却拿不出最小复现,因为当时没有一条能把 wasm 里的
// 增量路径**直接**驱动起来、又与全量重算逐位比对的通道。本文件补上:
// 同一份 inc.zig(原生单测跑的就是它)编译进 wasm,Node 侧
// tools/probe-inc.mjs 从三条通道夹它 ——
//   ① wasm 内部自检:probeCheck 全量重算 vs 增量状态(免拷贝、无对齐歧义);
//   ② JS 独立重算:model.mjs 的几何表重算 38 个槽号,与 probeStatePtr 的
//      内存逐字比对(顺带盯住 lo/hi 拆装与导出层);
//   ③ wasm 内部搜索同形 DFS:probeDfs 一调进树,兄弟子树复用/虚着全在里面。
// 驱动接口与 engine.zig 同约定:u64 拆 lo/hi、不分配、只返回数字。
// side 约定:1 = 黑先,2 = 白先(Board.own/opp 不带颜色,必须显式给)。
const std = @import("std");
const rules = @import("rules.zig");
const pattern = @import("pattern.zig");
const inc = @import("inc.zig");

const weights = @embedFile("weights.bin");

var cur: rules.Board = rules.Board.initial;
var state: inc.State = .{};
var truth: [inc.PTN_COUNT]u32 = undefined; // probeCheck 里的全量重算结果,可从 JS 读

inline fn mk(ownLo: u32, ownHi: u32, oppLo: u32, oppHi: u32) rules.Board {
    return .{
        .own = @as(u64, ownLo) | (@as(u64, ownHi) << 32),
        .opp = @as(u64, oppLo) | (@as(u64, oppHi) << 32),
    };
}
inline fn blackFirst(side: u32) bool {
    return side != 2;
}

/// 装权重 + 生成增量特征表。0 = 就绪;非 0 = pattern.failStage。
export fn probeInit() u32 {
    if (!pattern.init(weights)) return pattern.failStage;
    inc.initTables();
    return 0;
}
export fn probePtnCount() u32 {
    return inc.PTN_COUNT;
}

/// 从局面全量建状态(set = 开局/根重置的唯一入口)。
export fn probeOpen(ownLo: u32, ownHi: u32, oppLo: u32, oppHi: u32, side: u32) void {
    cur = mk(ownLo, ownHi, oppLo, oppHi);
    inc.set(cur, blackFirst(side), &state);
}

/// 增量落一手(要求 sq 对 cur 合法;非法局面会在 probeCheck 处炸出来)。
/// 落子方由状态的行棋方记账给出 —— JS 与 wasm 各记各的账,记岔了对拍就炸。
export fn probePlay(sq: u32) void {
    const s: u6 = @intCast(sq & 63);
    const f = rules.flips(cur, s);
    inc.moveUpdate(&state, s, f, state.home_to_move);
    cur = rules.playMove(cur, s, f);
}

/// 虚着:棋盘不变,只流行棋方记账(固定视角下的零成本 pass)。
/// ⚠ 换视角必须经临时变量:`cur = .{ .own = cur.opp, .opp = cur.own }` 是
/// 结果位置别名陷阱 —— 结构体字面量逐字段写入目标,第二个字段读到的是
/// 已被覆盖的第一个字段,结果 own == opp,棋盘永久损坏。这正是新验证
/// 程序抓到的第一枚真 bug(probe-inc B 段第 3 局虚着后立刻散板)。
export fn probePass() void {
    const t = cur;
    cur = .{ .own = t.opp, .opp = t.own };
    inc.passFlip(&state);
}

/// wasm 内部自检:全量重算 vs 增量状态(黑方视角口径)。
/// 返回 255 = 一致;0..37 = 首个不一致的表号;38 = 子数记账漂移。
export fn probeCheck() u32 {
    pattern.slotIndices(blackView(cur, state.home_to_move), &truth);
    if (cur.discs() != state.discs) return 38;
    for (0..inc.PTN_COUNT) |i| {
        if (truth[i] != state.slots[i]) return @intCast(i);
    }
    return 255;
}

inline fn blackView(b: rules.Board, home_to_move: bool) rules.Board {
    return .{
        .own = if (home_to_move) b.own else b.opp,
        .opp = if (home_to_move) b.opp else b.own,
    };
}

/// 增量路径的整数加权和(带行棋方符号;相位按增量状态的子数记账)
export fn probeSumInt() i32 {
    return inc.sumInt(&state);
}
/// 全量路径的整数加权和(pattern.evalInt,行棋方视角,同一张 wt)
export fn probeEvalIntFull() i32 {
    return pattern.evalInt(cur);
}

// 内存窗口:JS 侧独立重算后逐字比对用(u32 × 38)
export fn probeStatePtr() u32 {
    return @intFromPtr(&state.slots);
}
export fn probeTruthPtr() u32 {
    return @intFromPtr(&truth);
}
/// 行棋方记账读回(0/1):JS 侧核对两边没记岔
export fn probeBlackToMove() u32 {
    return if (state.home_to_move) 1 else 0;
}

// 面板:JS 侧维护自己的棋盘并核对两边没散
export fn probeDiscs() u32 {
    return cur.discs();
}
export fn probeOwnLo() u32 {
    return @truncate(cur.own);
}
export fn probeOwnHi() u32 {
    return @truncate(cur.own >> 32);
}
export fn probeOppLo() u32 {
    return @truncate(cur.opp);
}
export fn probeOppHi() u32 {
    return @truncate(cur.opp >> 32);
}
export fn probeMovesLo() u32 {
    return @truncate(rules.moves(cur));
}
export fn probeMovesHi() u32 {
    return @truncate(rules.moves(cur) >> 32);
}

/// wasm 内部搜索同形 DFS:快照 → 增量 → 递归 → 恢复,虚着只翻记账,
/// 每个节点槽号 + 带符号整数和双对拍。返回槽号不一致的节点数;细节读 probeDfs*。
export fn probeDfs(ownLo: u32, ownHi: u32, oppLo: u32, oppHi: u32, side: u32, depth: u32) u32 {
    cur = mk(ownLo, ownHi, oppLo, oppHi);
    inc.set(cur, blackFirst(side), &state);
    inc.resetStats();
    inc.dfsCheck(cur, @min(depth, 6), &state);
    return @intCast(@min(inc.dfs_bad, std.math.maxInt(u32)));
}
export fn probeDfsNodesLo() u32 {
    return @truncate(inc.dfs_nodes);
}
export fn probeDfsNodesHi() u32 {
    return @truncate(inc.dfs_nodes >> 32);
}
export fn probeDfsPasses() u32 {
    return @intCast(@min(inc.dfs_passes, std.math.maxInt(u32)));
}
export fn probeDfsEvalBad() u32 {
    return @intCast(@min(inc.dfs_eval_bad, std.math.maxInt(u32)));
}
export fn probeDfsCapped() u32 {
    return if (inc.dfs_capped) 1 else 0;
}
export fn probeDfsBadPtn() u32 {
    return inc.dfs_bad_ptn;
}
export fn probeDfsBadExpect() u32 {
    return inc.dfs_bad_expect;
}
export fn probeDfsBadGot() u32 {
    return inc.dfs_bad_got;
}
