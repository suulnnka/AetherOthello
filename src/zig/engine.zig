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
// 书生成(914 条局面 = 从初始局面的 BFS 最短路 + 精确值 + 最佳着法集
// + 开局名池 —— 单名:并列局面不展示、无名局面沿树继承最近单名祖先;
// 生成方式/来源/许可见 book/README.md:局面与开局名是公开数据收集,
// 唯一借自其他软件开局库的是估值,而估值自家求解也能算出,取现成只为
// 省时间)。替代旧版自对弈主线书(genbook/book.bin 已移除)。
//
// 布局(字节对齐,gzip 友好 —— DEFLATE 按字节匹配,6 bit 打包反而吃亏):
//   u16 条数 LE + u8 passTok(=64);条目按路径字典序排序,每条 =
//   share u8 + slen u8 + slen×u8 token + (value+8) u8 + bcnt u8 + bcnt×u8
//   token = 生成器帧线性格号,过手 = passTok;尾随 nameRef u8(名字池下标+1,
//   0 = 无名)。条目区之后是名字池:u16 池大小 + 每串 u8 len + ASCII 字节。
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
var bk_name: [BK_CAP]u8 = undefined; // 名字池下标+1;0 = 无名(同槽首插优先)
// 名字池:切片直指 book_bin(线性内存里的 @embedFile 常量)—— 零拷贝,
// worker 拿 engineBookNamePtr 的地址 + Len 直接读 ASCII。
const BK_NAMES_MAX = 256;
var bk_pool_n: usize = 0;
var bk_pool_off: [BK_NAMES_MAX]usize = undefined;
var bk_pool_len: [BK_NAMES_MAX]u8 = undefined;

fn bookHash(own: u64, opp: u64) usize {
    var h = own *% 0x9E37_79B9_7F4A_7C15;
    h ^= opp *% 0xC2B2_AE3D_27D4_EB4F;
    h ^= h >> 29;
    return @intCast(h & BK_MASK);
}

/// b 需已规范化。mask 为**规范朝向**掩码。name_ref = 名字池下标+1(0 = 无名)。
fn bookInsert(b: rules.Board, mask: u64, val: i8, name_ref: u8) void {
    var s = bookHash(b.own, b.opp);
    while (true) {
        if (bk_moves[s] == 0) {
            bk_key_own[s] = b.own;
            bk_key_opp[s] = b.opp;
            bk_val[s] = val;
            bk_name[s] = name_ref;
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
        if (off >= book_bin.len) break; // 名字下标读越界
        const name_ref = book_bin[off];
        off += 1;
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
            bookInsert(.{ .own = c.own, .opp = c.opp }, cmask, val, name_ref);
        }
        prev_len = plen;
    }
    // 名字池(blob 尾部):u16 数量 + 每串 u8 len + ASCII。截断只影响已解析数,
    // bk_pool_n 记**实际**条数 —— 越界的 name_ref 在导出处按无名兜底。
    if (off + 2 <= book_bin.len) {
        const pn: usize = @as(usize, book_bin[off]) | (@as(usize, book_bin[off + 1]) << 8);
        off += 2;
        var pi: usize = 0;
        while (pi < pn and pi < BK_NAMES_MAX and off < book_bin.len) : (pi += 1) {
            const nlen: usize = book_bin[off];
            off += 1;
            if (off + nlen > book_bin.len) break;
            bk_pool_off[pi] = off;
            bk_pool_len[pi] = @intCast(nlen);
            off += nlen;
        }
        bk_pool_n = pi;
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

/// 值容差(开局多样性带宽,子数)住在 worker.js(BOOK_TOL 同值);引擎只发
/// 「着法 + 精确书值」清单,不再自己选。

/// 命中开局书则返回着法,*val_out 带出书内精确值(行棋方视角,子差)。
/// depth_max ≥ 4 才用(入门/初级保持原味)。
///
/// 选着(2026-09-20 重构,随机化事故后整体移出引擎):**只定序,不选**——
/// 枚举合法着法,子局面在书内的按「我方结果 = −子值」给精确值,整表经
/// search.publishRoot 发布(root_exact=true),worker 的 JS 按值容差 ±2 加权
/// 随机(值好多占、近优保留,开局多样性);子局面不在书内的着法不入表
/// (出书无法估值 —— 标注 best 指向被 ±4 滤掉子的情况由此自然化解);
/// 表空(整个着法层都不在书)回退标注 best 集,值取局面书值(JS 等权随机)。
/// 返回值 = 清单第 0 项(最高值、并列位号最小)—— 完全确定。
fn bookMove(b: rules.Board, depth_max: u32, val_out: *i8) ?u6 {
    if (!bk_ready or depth_max < 4) return null;
    if (b.discs() > BOOK_MAX_DISCS) return null;
    const c = canonOf(b);
    const s = bookSlot(c) orelse return null;
    val_out.* = bk_val[s];
    // 根局面的名字(供 engineBookNamePtr 透传;下面子局面探测不改它)
    last_book_name = bk_name[s];

    var mvs: [36]u6 = undefined; // 黑白棋单方最多 33 个合法着法(同 search)
    var outs: [36]f32 = undefined;
    var trs: [36]bool = undefined; // 书值全是精确终局子差 → 全真值
    var n: u32 = 0;
    var best_out: i8 = -127;
    var legal = rules.moves(b);
    while (legal != 0) {
        const sq: u6 = @intCast(@ctz(legal));
        legal &= legal - 1;
        const child = rules.play(b, sq);
        if (bookSlot(canonOf(child))) |cs| {
            const out: i8 = -bk_val[cs]; // 子局面轮对方,取负为我方结果
            mvs[n] = sq;
            outs[n] = @floatFromInt(out);
            n += 1;
            if (out > best_out) best_out = out;
        }
    }
    if (n > 0) {
        // 报位置值(按子局面推得,比标注值更自洽);清单分数是精确书值
        val_out.* = best_out;
        for (0..n) |i| trs[i] = true;
        search.publishRoot(mvs[0..n], outs[0..n], trs[0..n], n, true);
        return @intCast(search.root_moves[0]);
    }

    // 表空:回退标注 best 掩码(换算回查询朝向)。单着真值未知,统一取局面
    // 书值 → JS 侧等权随机;引擎确定着法 = 位号最小。
    var m: u64 = 0;
    var mm = bk_moves[s];
    while (mm != 0) {
        const sq: u6 = @intCast(@ctz(mm));
        mm &= mm - 1;
        m |= @as(u64, 1) << @intCast(sym_perm[sym_inv[c.t]][sq]);
    }
    m &= rules.moves(b);
    if (m == 0) return null; // 换算后不合法(构造上不该发生,防御)
    n = 0;
    const pos_val: f32 = @floatFromInt(bk_val[s]);
    mm = m;
    while (mm != 0) {
        const sq: u6 = @intCast(@ctz(mm));
        mm &= mm - 1;
        mvs[n] = sq;
        outs[n] = pos_val;
        n += 1;
    }
    for (0..n) |i| trs[i] = true;
    search.publishRoot(mvs[0..n], outs[0..n], trs[0..n], n, true);
    return @intCast(search.root_moves[0]);
}

var last: search.Result = .{};
/// 上一手 engineThink 是否开局书命中。worker 透传进 think 回包的 `book`
/// 字段(UI 据此显示「开局库」来源,不靠 depth=0 之类的外部推断)。
var last_book = false;
/// 上一手书命中**根局面**的名字池下标+1(0 = 无名/未命中)。名字串本体在
/// book_bin(线性内存常量)里,导出直接给地址,零拷贝。
var last_book_name: u8 = 0;

/// ⑥ PC(ProbCut)开关与置信度系数(pct,典型 1.64 ≈ 95% 单侧)。
/// flag=0 关闭。中盘:dv4 单一深度对零窗口验证(见 search.zig PC_STAGES);
/// 尾盘:exact 求解内 dv4@E≥12 + dv10@E≥18 两级全窗验证剪枝(概率性,
/// engineExact() 届时报 0)。
export fn engineSetPc(flag: u32, pct: f32) void {
    search.pc_enabled = flag != 0;
    search.pc_pct = pct;
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
    last_book_name = 0;
    last = search.think(mk(ownLo, ownHi, oppLo, oppHi), depth, endgame, bud);
    return if (last.move < 0) -1 else @intCast(last.move);
}

export fn engineScore() f32 {
    return last.score;
}
/// 上一手 engineThink 是否开局书命中(1/0)。书着 depth=0 与贪心同形,
/// 区分只能靠引擎自己说 —— UI 显示「开局库」来源就吃这个字段。
export fn engineBook() u32 {
    return if (last_book) 1 else 0;
}
/// ── 根着法清单(engineThink 之后读;选着策略在 worker 的 JS,见 search.zig
///    「根着法清单」段):全部根着法与分数,分数降序、同分位号升序,第 0 项 =
///    引擎的确定着法。engineRootExact()=1(开局书书值 / 残局完全求解)时 JS
///    才允许在清单上做容差/同分随机;中局启发式分数是零窗口界,只取第 0 项。
export fn engineRootN() u32 {
    return search.root_n;
}
export fn engineRootMove(i: u32) i32 {
    if (i >= search.root_n) return -1;
    return @intCast(search.root_moves[i]);
}
export fn engineRootScore(i: u32) f32 {
    if (i >= search.root_n) return 0;
    return search.root_scores[i];
}
export fn engineRootExact() u32 {
    return if (search.root_exact) 1 else 0;
}
/// 清单第 i 项的分数是否为**窗口内真值**(全窗/升窗重搜定死):1 = 真值,
/// 0 = 零窗口 fail-soft 的界(真值可能任意差)。JS 的随机只吃真值项 ——
/// 中盘 ±1 子随机、终局完全解同分随机都靠它挡住界值混入。
export fn engineRootTrue(i: u32) u32 {
    if (i >= search.root_n) return 0;
    return if (search.root_true[i]) 1 else 0;
}
/// 上一手书命中局面的开局名(blob 名字池内的 ASCII 串,可能多名「 / 」拼接)。
/// 返回串在 wasm 线性内存里的地址;0 = 无名/未命中/名字池损坏。worker 用
/// memory.buffer + engineBookNameLen 读出,think 回包带 `name` 字段,UI 显示
/// 「开局库 · 名字 · 估值」(同 chess 的开局库行)。
export fn engineBookNamePtr() u32 {
    if (last_book_name == 0 or last_book_name > bk_pool_n) return 0;
    return @intCast(@intFromPtr(&book_bin[bk_pool_off[last_book_name - 1]]));
}
export fn engineBookNameLen() u32 {
    if (last_book_name == 0 or last_book_name > bk_pool_n) return 0;
    return bk_pool_len[last_book_name - 1];
}
/// 这一手实际跑完的深度(节点预算先用满时它会低于标称深度)
export fn engineDepth() u32 {
    return last.depth;
}
/// 这一手是否给出了**可信的精确解**。
/// ⚠ 预算耗尽时必须报 0:残局分支在 aborted 时返回的是「前置中层迭代的最后一轮」,
///   只是个启发式估值,UI 若拿它当终局判决就会显示凭空的"胜 N 子"(踩过)。
/// ⚠ 尾盘 PC 命中过剪枝的求解同样必须报 0:结果含概率成分,不是精确解。
export fn engineExact() u32 {
    if (search.aborted or search.pc_end_used) return 0;
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
