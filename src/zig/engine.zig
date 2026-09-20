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

// ── ⑩ 开局书 v2:Egaroucid 精确书(≤14 子、|值|≤4)────────────────────
// 数据:src/zig/book-openings.bin,由 tools/make-book.mjs 从 Egaroucid 网页版
// 书生成(914 条局面 = 从初始局面的 BFS 最短路 + 精确值 + 最佳着法集;
// 生成方式/来源/许可见 book/README.md —— GPL 来源数据,入库为 2026-09-20
// 用户决策)。替代旧版自对弈主线书(genbook/book.bin 已移除)。
//
// 布局(字节对齐,gzip 友好 —— DEFLATE 按字节匹配,6 bit 打包反而吃亏):
//   u16 条数 LE + u8 passTok(=64);条目按路径字典序排序,每条 =
//   share u8 + slen u8 + slen×u8 token + (value+8) u8 + bcnt u8 + bcnt×u8
//   token = 生成器帧线性格号,过手 = passTok。
//
// **朝向规范化(表能命中的关键)**:书每条只存一条回放路径 ⇒ 单一朝向;
// 而对局里同一局面会以 8 个对称位形中任意一个出现(首手 c4 与 d3 的子局面
// 就是同一规范类的不同朝向 —— 不规范化实测 4 个里 3 个 miss)。所以表键与
// 查询都先规范化到唯一朝向,着法掩码入库/出库时按同一置换换算格号。
var sym_perm: [8][64]u8 = undefined; // 对称 t:格 i → 格 perm[t][i]
var sym_inv: [8]u8 = undefined; // t 的逆变换号
var bk_ready = false;

fn buildSymPerms() void {
    for (0..64) |i| {
        const r: u3 = @intCast(i >> 3);
        const f: u3 = @intCast(i & 7);
        const r7: u3 = 7 - r;
        const f7: u3 = 7 - f;
        sym_perm[0][i] = @intCast(@as(usize, r) * 8 + f); // id
        sym_perm[1][i] = @intCast(@as(usize, f7) * 8 + r); // rot90
        sym_perm[2][i] = @intCast(@as(usize, r7) * 8 + f7); // rot180
        sym_perm[3][i] = @intCast(@as(usize, f) * 8 + r7); // rot270
        sym_perm[4][i] = @intCast(@as(usize, r) * 8 + f7); // 纵镜(文件翻转)
        sym_perm[5][i] = @intCast(@as(usize, r7) * 8 + f); // 横镜(行翻转)
        sym_perm[6][i] = @intCast(@as(usize, f) * 8 + r); // 转置
        sym_perm[7][i] = @intCast(@as(usize, f7) * 8 + r7); // 反转置
    }
    for (0..8) |t| {
        for (0..8) |u| {
            var ok = true;
            for (0..64) |i| {
                if (sym_perm[u][sym_perm[t][i]] != i) {
                    ok = false;
                    break;
                }
            }
            if (ok) {
                sym_inv[t] = @intCast(u);
                break;
            }
        }
    }
}

const Canon = struct { own: u64, opp: u64, t: u3 };

/// 规范化:min(own, opp) 字典序的朝向;t = 本朝向 → 规范朝向的变换号
/// (掩码换算要用:规范格 perm[t][i] ↔ 本朝向格 i)。
fn canonOf(b: rules.Board) Canon {
    var best: Canon = .{ .own = 0, .opp = 0, .t = 0 };
    var first = true;
    for (0..8) |t| {
        var own: u64 = 0;
        var opp: u64 = 0;
        for (0..64) |i| {
            const bit = @as(u64, 1) << @intCast(i);
            if (b.own & bit != 0) own |= @as(u64, 1) << @intCast(sym_perm[t][i]);
            if (b.opp & bit != 0) opp |= @as(u64, 1) << @intCast(sym_perm[t][i]);
        }
        if (first or own < best.own or (own == best.own and opp < best.opp)) {
            best = .{ .own = own, .opp = opp, .t = @intCast(t) };
            first = false;
        }
    }
    return best;
}

const book_bin = @embedFile("book-openings.bin");
const BOOK_MAX_DISCS = 14;
const BK_CAP = 2048; // 2 的幂;条目 914,负载 <45%(线性探测)
const BK_MASK: u64 = BK_CAP - 1;
var bk_key_own: [BK_CAP]u64 = undefined;
var bk_key_opp: [BK_CAP]u64 = undefined;
var bk_moves: [BK_CAP]u64 = undefined; // 最佳着法位掩码(规范朝向);0 = 空槽
var bk_val: [BK_CAP]i8 = undefined; // 书内精确值(行棋方视角,子差)

fn bookHash(own: u64, opp: u64) usize {
    var h = own *% 0x9E37_79B9_7F4A_7C15;
    h ^= opp *% 0xC2B2_AE3D_27D4_EB4F;
    h ^= h >> 29;
    return @intCast(h & BK_MASK);
}

/// b 需已规范化。mask 为**规范朝向**掩码。
fn bookInsert(b: rules.Board, mask: u64, val: i8) void {
    var s = bookHash(b.own, b.opp);
    while (true) {
        if (bk_moves[s] == 0) {
            bk_key_own[s] = b.own;
            bk_key_opp[s] = b.opp;
            bk_val[s] = val;
        }
        if (bk_key_own[s] == b.own and bk_key_opp[s] == b.opp) {
            bk_moves[s] |= mask;
            return;
        }
        s = @intCast((s + 1) & BK_MASK);
    }
}

fn bookInit() void {
    buildSymPerms();
    if (book_bin.len < 3) {
        bk_ready = true;
        return;
    }
    const n: usize = @as(usize, book_bin[0]) | (@as(usize, book_bin[1]) << 8);
    const pass_tok = book_bin[2];
    var off: usize = 3;
    var path: [32]u8 = undefined; // 最长 ≤ 10 手 + 过手余量
    var prev_len: usize = 0;
    var i: usize = 0;
    while (i < n and off + 4 <= book_bin.len) : (i += 1) {
        const share: usize = book_bin[off];
        const slen: usize = book_bin[off + 1];
        off += 2;
        if (share > prev_len or share + slen > path.len) break; // 数据损坏哨兵
        if (off + slen + 2 > book_bin.len) break; // 条目截断(后续 token 读越界)
        var plen = share;
        var k: usize = 0;
        while (k < slen) : (k += 1) {
            path[plen] = book_bin[off];
            plen += 1;
            off += 1;
        }
        const val: i8 = @as(i8, @intCast(book_bin[off])) - 8;
        const bcnt: usize = book_bin[off + 1];
        off += 2;
        if (off + bcnt > book_bin.len) break;
        var mask: u64 = 0;
        k = 0;
        while (k < bcnt) : (k += 1) {
            mask |= @as(u64, 1) << @intCast(book_bin[off]);
            off += 1;
        }
        // 回放(生成器帧):过手显式记号;真着法先验翻子,非法即数据坏 → 弃条目
        var b = rules.Board.initial;
        var legal = true;
        var t: usize = 0;
        while (t < plen and legal) : (t += 1) {
            const tok = path[t];
            if (tok == pass_tok) {
                b = .{ .own = b.opp, .opp = b.own };
                continue;
            }
            if (tok >= 64 or rules.flips(b, @intCast(tok)) == 0) {
                legal = false;
                break;
            }
            b = rules.play(b, @intCast(tok));
        }
        if (legal) {
            // 入库:盘面规范化;掩码同乘该朝向的置换(回放帧 i 格 → 规范帧 perm[t][i])
            const c = canonOf(b);
            var cmask: u64 = 0;
            var mm = mask;
            while (mm != 0) {
                const sq: u6 = @intCast(@ctz(mm));
                mm &= mm - 1;
                cmask |= @as(u64, 1) << @intCast(sym_perm[c.t][sq]);
            }
            bookInsert(.{ .own = c.own, .opp = c.opp }, cmask, val);
        }
        prev_len = plen;
    }
    bk_ready = true;
}

/// 规范化局面查表 → 槽位(未命中 null)
fn bookSlot(c: Canon) ?usize {
    var s = bookHash(c.own, c.opp);
    while (true) {
        if (bk_moves[s] == 0) return null;
        if (bk_key_own[s] == c.own and bk_key_opp[s] == c.opp) return s;
        s = @intCast((s + 1) & BK_MASK);
    }
}

/// 值容差:书着法选择的多样性带宽(子数)。0 = 只走最优。
const BOOK_TOL: i8 = 2;

/// 命中开局书则返回着法,*val_out 带出书内精确值(行棋方视角,子差)。
/// depth_max ≥ 4 才用(入门/初级保持原味)。
///
/// 选着策略(2026-09-20 用户决策):**值容差 + 加权随机** —— 枚举合法着法,
/// 以子局面的书值给着法估值(我方结果 = −子值),值 ≥ 最优−tol 的入池,
/// 权重 = 1 << (值−下沿):值好的着法比例更高,近优的也保留(开局多样性,
/// 等值的垂直/斜线都能出现,不再每局平行)。子局面不在书内的着法不入池
/// (出书无法估值 —— 标注 best 指向被 ±4 滤掉子的情况由此自然化解);
/// 池空(整个着法层都不在书)回退标注 best 掩码。
/// rng_state = 0 完全确定(取最高值、并列位号最小);≠ 0 加权随机。
fn bookMove(b: rules.Board, depth_max: u32, val_out: *i8) ?u6 {
    if (!bk_ready or depth_max < 4) return null;
    if (b.discs() > BOOK_MAX_DISCS) return null;
    const c = canonOf(b);
    const s = bookSlot(c) orelse return null;
    val_out.* = bk_val[s];

    var mvs: [36]u6 = undefined; // 黑白棋单方最多 33 个合法着法(同 search)
    var outs: [36]i8 = undefined;
    var nm: usize = 0;
    var best_out: i8 = -127;
    var legal = rules.moves(b);
    while (legal != 0) {
        const sq: u6 = @intCast(@ctz(legal));
        legal &= legal - 1;
        const child = rules.play(b, sq);
        if (bookSlot(canonOf(child))) |cs| {
            const out: i8 = -bk_val[cs]; // 子局面轮对方,取负为我方结果
            mvs[nm] = sq;
            outs[nm] = out;
            nm += 1;
            if (out > best_out) best_out = out;
        }
    }
    if (nm > 0) {
        const floor_v: i8 = best_out - BOOK_TOL;
        var pool: [36]u6 = undefined;
        var wgt: [36]u32 = undefined;
        var np: usize = 0;
        for (0..nm) |i| {
            if (outs[i] >= floor_v) {
                pool[np] = mvs[i];
                wgt[np] = @as(u32, 1) << @intCast(outs[i] - floor_v);
                np += 1;
            }
        }
        val_out.* = best_out; // 报位置值(按子局面推得,比标注值更自洽)
        if (search.rng_state != 0) {
            var total: u32 = 0;
            for (0..np) |i| total += wgt[i];
            var pick: u32 = @intCast(search.rng_state % total);
            for (0..np) |i| {
                if (pick < wgt[i]) return pool[i];
                pick -= wgt[i];
            }
            return pool[np - 1];
        }
        var bi: usize = 0;
        for (0..np) |i| {
            if (wgt[i] > wgt[bi]) bi = i; // mvs 升序 → 并列最优取位号最小
        }
        return pool[bi];
    }

    // 池空:回退标注 best 掩码(换算回查询朝向后按 rng 选)
    var m: u64 = 0;
    var mm = bk_moves[s];
    while (mm != 0) {
        const sq: u6 = @intCast(@ctz(mm));
        mm &= mm - 1;
        m |= @as(u64, 1) << @intCast(sym_perm[sym_inv[c.t]][sq]);
    }
    m &= rules.moves(b);
    if (m == 0) return null; // 换算后不合法(构造上不该发生,防御)
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
/// 上一手 engineThink 是否开局书命中。worker 透传进 think 回包的 `book`
/// 字段(UI 据此显示「开局书」来源,不靠 depth=0 之类的外部推断)。
var last_book = false;

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
    // ⑩ 开局书命中:直接出书内最佳着法,score = 书内精确值(exact/endgame
    // 仍为 false —— 书值是理论值,不当终局判决)。last_book 供 engineBook()
    // 透传;nodes 清零,免得回包带上上一手的陈旧节点数
    var book_val: i8 = 0;
    if (bookMove(mk(ownLo, ownHi, oppLo, oppHi), depth, &book_val)) |mv| {
        last = .{ .move = @intCast(mv), .score = @floatFromInt(book_val), .depth = 0 };
        last_book = true;
        search.nodes = 0;
        return mv;
    }
    last_book = false;
    last = search.thinkSeeded(mk(ownLo, ownHi, oppLo, oppHi), depth, endgame, bud, search.rng_state);
    return if (last.move < 0) -1 else @intCast(last.move);
}

export fn engineScore() f32 {
    return last.score;
}
/// 上一手 engineThink 是否开局书命中(1/0)。书着 depth=0 与贪心同形,
/// 区分只能靠引擎自己说 —— UI 显示「开局书」来源就吃这个字段。
export fn engineBook() u32 {
    return if (last_book) 1 else 0;
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
