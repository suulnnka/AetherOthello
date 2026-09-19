// ============================================================
// 38 张模式表的几何 + 16 元对称折叠 + int8 权重查表。
//
// ── 38 张表到底是什么(照抄 suulnnka/kix4 的构造)──────────────
//   1..8    行:i 固定,遍历 j
//   9..16   列:j 固定,遍历 i
//   17..27  "/" 斜线(i+j 为常数):15 条 → 11 张(两端三条短斜线各并成一张)
//   28..38  "\" 斜线(i-j 为常数):15 条 → 11 张
//   每方向长度序列 [6,4,5,6,7,8,7,6,5,4,6] 合计 64 格;总计 256 格 = 64×4,
//   即**每个格子恰好被 4 张表覆盖** —— 这是这套特征"覆盖完整"的证据。
//   槽数/阶段 = 16·3^8 + 8·3^6 + 4·3^4 + 4·3^5 + 4·3^7 + 2·3^8 = 133,974
//
// ── 16 元群 D4 × C2 与符号 ────────────────────────────────────
//   权重函数必须满足 W(g·s) = sign(g)·W(s):
//     · 几何操作(旋转/镜像/转置)不改棋子颜色、不改"该谁走" → +1
//     · 换色把空→空、黑白↔白黑,同时换掉行棋方,子差整体取负  → −1
//   轨道内用带符号平均合并:一个轨道只要出现"同一槽既 +1 又 −1 地被映射到
//   同一个代表",该轨道就被强制作 0(例如全空配置)。
//   133,974 → 9,475 轨道/阶段(14.140×),其中 248 条制 0。
//   权威口径见 tools/oracle-fold.mjs(带符号并查集),本文件用等价但更省的
//   「16 个像里取槽号最小者」规则 —— oracle 已逐槽复核两者一致。
//
// ── 二进制里只放什么 ──────────────────────────────────────────
//   只放 2 × 9,475 = 18,950 字节的 int8 权重。轨道图(每槽 → 轨道号)在
//   init() 时算出来(约 1,300 万次 comptime 已知的移位/查表,几十毫秒),
//   这样二进制不带 268 KB 的映射表,体积闸门才守得住。
//
// ⚠ Zig 0.16 起块注释 /* */ 已被移除,本文件通篇行注释。
const std = @import("std");
const rules = @import("rules.zig");

pub const PTN_COUNT: usize = 38;
/// 相位数 = 6:同一局部形状的价值随局势推进变化(开局行动力为王 → 残局稳定子
/// 为王),一套权重表达不了,所以按子数分档、每档一套完整的轨道权重。
/// 分界见 `phaseOf`(14/24/34/44/54)。档数必须在**训练时**定死:事后把 6 档
/// 平均成 2 档实测差 5.2 子(kix4 实验);反过来 2 档从零训对 6 档只差 1.7 子
/// —— 这是"多档值多少"的合理预期量级。
pub const PHASES: usize = 6;
pub const PER_PHASE: u32 = 133_974;
pub const ORBITS: u32 = 9_475;

/// blob 头布局(照 installQuant 的读法,**别照字面猜**):
///   [0..4)  u32 magic  [4] u8 version  [5] u8 phases  [6..8) 保留
///   [8..12) u32 orbits [12..12+4×phases) 每相位一个 f32 scale
/// 注意 version/phases 是**单字节**,不是 u32 —— 按 u32 读会读成 0x00000201=513。
///
/// ⚠ **version 3 起 6 相位**(头 12 + 4×6 = 36 字节);v2 = 2 相位(头 20 字节),
///   v1 = 2 相位共用一个 scale(头 16 字节)。每相位一个 scale 的理由:两个相位
///   的权重幅值能差一倍,共用一个会让幅值小的那个相位白丢一半分辨率。
pub const BLOB_VERSION: u8 = 3;
pub const BLOB_MAGIC: u32 = 0x4F54_484C; // 'OTHL'
pub const BLOB_HEADER: usize = 12 + 4 * PHASES;

const POW3 = [9]u32{ 1, 3, 9, 27, 81, 243, 729, 2187, 6561 };

/// i+j(∈2..16)或 9+i-j(∈2..16) → 斜线表序号 1..11。
/// 下标 0 与 1 都是占位(照抄上游 1-based 布局,避免整体错位一格的经典坑)。
const XY2PTN = [17]u8{ 0, 0, 1, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 11, 11 };

/// 格子 (i,j)(0-based)是否属于表 p(1-based)
fn belongs(p: usize, i: usize, j: usize) bool {
    if (p <= 8) return i == p - 1;
    if (p <= 16) return j == p - 9;
    if (p <= 27) return XY2PTN[i + j + 2] == p - 16;
    return XY2PTN[9 + i - j] == p - 27;
}

/// 8 个几何操作(0-based 行列);顺序与 tools/oracle-fold.mjs 的 GEO 一致
fn geoPt(t: usize, r: usize, c: usize) [2]usize {
    return switch (t) {
        0 => .{ r, c },
        1 => .{ c, 7 - r },
        2 => .{ 7 - r, 7 - c },
        3 => .{ 7 - c, r },
        4 => .{ c, r },
        5 => .{ 7 - c, 7 - r },
        6 => .{ 7 - r, c },
        else => .{ r, 7 - c },
    };
}

pub const Model = struct {
    len: [PTN_COUNT + 1]u8 = undefined,
    tri: [PTN_COUNT + 1]u32 = undefined, // 3^len,即该表的槽数
    cell_off: [PTN_COUNT + 1]u16 = undefined,
    slot_off: [PTN_COUNT + 1]u32 = undefined,
    cells: [256]u8 = undefined,
    total: u32 = 0,
};

/// 表几何:全部在 comptime 算好,运行时零成本
pub const model: Model = blk: {
    @setEvalBranchQuota(4_000_000);
    var m: Model = .{};
    var co: u16 = 0;
    for (1..PTN_COUNT + 1) |p| {
        m.cell_off[p] = co;
        var n: u16 = 0;
        // i 外层、j 内层 —— 与上游 ptn2pos 的 push 顺序严格一致,
        // 因为格子顺序就是 3 进制幂的位序,改了顺序整张表的语义就变了。
        for (0..8) |i| {
            for (0..8) |j| {
                if (belongs(p, i, j)) {
                    m.cells[co + n] = @intCast(i * 8 + j);
                    n += 1;
                }
            }
        }
        m.len[p] = @intCast(n);
        m.tri[p] = POW3[@as(usize, n)];
        co += n;
    }
    var so: u32 = 0;
    for (1..PTN_COUNT + 1) |p| {
        m.slot_off[p] = so;
        so += m.tri[p];
    }
    m.total = so;
    if (m.total != PER_PHASE) @compileError("槽数与预期不符,模式表几何被改坏了");
    break :blk m;
};

/// 表 p 的第 k 个格子在 q 里的位置;不在返回 null
fn cellIndexIn(q: usize, sq: u8) ?u8 {
    for (0..model.len[q]) |k| {
        if (model.cells[model.cell_off[q] + k] == sq) return @intCast(k);
    }
    return null;
}

const Act = struct { q: u8 = 0, perm: [8]u8 = .{0} ** 8 };

/// act[t][p]:几何 t 把表 p 映到表 act.q,位序置换 act.perm
pub const act: [8][PTN_COUNT + 1]Act = blk: {
    @setEvalBranchQuota(40_000_000);
    var a: [8][PTN_COUNT + 1]Act = undefined;
    for (0..8) |t| {
        for (1..PTN_COUNT + 1) |p| {
            const len = model.len[p];
            var img: [8]u8 = .{0} ** 8;
            for (0..len) |k| {
                const sq = model.cells[model.cell_off[p] + k];
                const pt = geoPt(t, sq / 8, sq % 8);
                img[k] = @intCast(pt[0] * 8 + pt[1]);
            }
            var q: u8 = 0;
            for (1..PTN_COUNT + 1) |cand| {
                if (model.len[cand] != len) continue;
                var ok = true;
                for (0..len) |k| {
                    if (cellIndexIn(cand, img[k]) == null) {
                        ok = false;
                        break;
                    }
                }
                if (ok and q == 0) q = @intCast(cand);
            }
            if (q == 0) @compileError("模式族在几何操作下不闭合 —— 折叠前提不成立");
            var perm: [8]u8 = .{0} ** 8;
            for (0..len) |k| perm[k] = cellIndexIn(q, img[k]).?;
            a[t][p] = .{ .q = q, .perm = perm };
        }
    }
    break :blk a;
};

/// 每张表的"可减小槽号的群元素"候选表。
/// 槽号 = slot_off[p] + idx,而 slot_off 随 p 单调 ⇒ 若 q > p 则像的槽号必然
/// **严格大于**恒等元的槽号,不可能取到最小 ⇒ 只需考虑 q ≤ p 的元素。
/// 这一条把运行时的 16 次映射砍到平均 5~6 次。
const CandList = struct { n: u8 = 0, items: [16]u8 = .{0} ** 16 }; // items 存 t*2+swap

pub const cands: [PTN_COUNT + 1]CandList = blk: {
    @setEvalBranchQuota(4_000_000);
    var c: [PTN_COUNT + 1]CandList = [_]CandList{.{}} ** (PTN_COUNT + 1);
    for (1..PTN_COUNT + 1) |p| {
        for (0..8) |t| {
            if (act[t][p].q > p) continue;
            for (0..2) |sw| {
                const i = c[p].n;
                c[p].items[i] = @intCast(t * 2 + sw);
                c[p].n += 1;
            }
        }
    }
    break :blk c;
};

/// 几何 t + 换色 sw 作用在 (p, idx) 上 → 目标槽号
inline fn imageSlot(t: usize, sw: bool, p: usize, idx: u32) u32 {
    const a = act[t][p];
    const len = model.len[p];
    var tmp = idx;
    var nv: u32 = 0;
    inline for (0..8) |k| {
        if (k < len) {
            var d: u32 = tmp % 3;
            tmp /= 3;
            // 换色:空保持空,黑↔白(1↔2)。注意是 d != 0 才取反 ——
            // 写成 3-d 而无条件,空位会被算成 3,整张表直接错位。
            if (sw and d != 0) d = 3 - d;
            nv += d * POW3[a.perm[k]];
        }
    }
    return model.slot_off[a.q] + nv;
}

const Canon = struct { slot: u32, sign: i8, zero: bool };

/// 取 16 个像里槽号最小的那个;符号取达成者的符号。
/// 若同一个最小槽号既有 +1 又有 −1 的达成者,该槽被对称性强制作 0。
fn canonSlot(p: usize, idx: u32) Canon {
    var best: u32 = model.slot_off[p] + idx;
    var sign: i8 = 1;
    var pos = true; // 恒等元本身就是 +1,先记上
    var neg = false;
    const cl = cands[p];
    for (0..cl.n) |ci| {
        const e = cl.items[ci];
        const t = e >> 1;
        const sw = (e & 1) != 0;
        const s2 = imageSlot(t, sw, p, idx);
        const sg: i8 = if (sw) -1 else 1;
        if (s2 < best) {
            best = s2;
            sign = sg;
            pos = !sw;
            neg = sw;
        } else if (s2 == best) {
            if (sw) neg = true else pos = true;
        }
    }
    return .{ .slot = best, .sign = sign, .zero = pos and neg };
}

// ─────────────────────── 运行时状态 ───────────────────────

/// 每槽 → 轨道号。**不在二进制里携带**,init 时算出来 ——
/// 否则那张 u16 映射表(268 KB)会把体积闸门吃穿。
pub var orbit: [PER_PHASE]u16 = undefined;
/// 每槽 → W(槽) / W(轨道代表) = ±1。训练器要用,推理只要 wt。
pub var sigma: [PER_PHASE]i8 = undefined;
/// 已折入符号的查表:wt[阶段][槽] = sigma · 权重。
/// 于是求值退化成 38 次查表 + 求和,不需要在热路径上乘符号。
pub var wt: [PHASES][PER_PHASE]i8 = undefined;
/// 定标:int8 加权和 → 子数。**每相位一个** —— 两相位幅值常差一倍,
/// 共用一个 scale 会让幅值小的那个相位白丢一半分辨率。
pub var scales: [PHASES]f32 = .{1.0} ** PHASES;
pub var ready: bool = false;
/// init 失败在第几步(排障用;0 = 未失败)。返回 bool 而不是 error 是为了
/// 让调用方在 wasm 里也能拿到一个可以读的数字。
pub var failStage: u8 = 0;
/// 代表个数(排障用):正确值应当等于 ORBITS
pub var dbgNext: u32 = 0;

// init 的中间表(静态分配,避免 130 KB 级数组上栈)。
// ⚠ can_tab 必须是 u32,不能用 u16 存:轨道号只有 9,475 装得下 u16,
//   但它存的是**槽号**,最大 133,973 —— u16 一截断,不同轨道的 canon 会撞在一起,
//   ReleaseFast 下 @intCast 静默截断,表现为"轨道数变少"(实测 9,475 → 6,724)。
var can_tab: [PER_PHASE]u32 = undefined;
var zflag: [PER_PHASE]u8 = undefined;
/// 轨道是否被对称性强制作 0(248 条:全空这类"自反"配置)。
/// 训练器必须跳过它们 —— 无论怎么更新,init 都会把它们抹回 0。
pub var orb_zero: [ORBITS]u8 = undefined;

/// 阶段划分:子数 ≤14/24/34/44/54 依次落相位 0..4,更高是相位 5。
/// 分界照抄 kix4 的 6 档公式 ceil((子数−4)/10)(f = 子数 − 4,开局 4 子)。
/// **34 仍是分界之一** ⇒ 旧 2 相位的书可以按区间无损展开成 6 档当训练初始
/// (相位 0..2 ← 旧相位 0,相位 3..5 ← 旧相位 1,求值处处相等)。
/// 阶段数必须在**训练时**定死:事后归并/拆分都有实测代价(见文件头)。
pub inline fn phaseOf(discs: u32) usize {
    const f = discs -| 4; // 0..60(kix4 的 1 基 ceil(f/10) − 1,f=0 并入相位 0)
    return @min((f -| 1) / 10, PHASES - 1);
}

fn readU32(b: []const u8, o: usize) u32 {
    return @as(u32, b[o]) | (@as(u32, b[o + 1]) << 8) |
        (@as(u32, b[o + 2]) << 16) | (@as(u32, b[o + 3]) << 24);
}
fn readF32(b: []const u8, o: usize) f32 {
    return @bitCast(readU32(b, o));
}

/// 构建轨道图 + 权重查表。blob 为 @embedFile 进来的 int8 权重书。
/// 返回 false 表示 blob 损坏 —— 调用方应当直接判定引擎不可用,不要"尽力而为"。
pub fn init(blob: []const u8) bool {
    failStage = 0;
    if (blob.len != BLOB_HEADER + PHASES * ORBITS) {
        failStage = 1;
        return false;
    }
    if (readU32(blob, 0) != BLOB_MAGIC) {
        failStage = 2;
        return false;
    }
    if (blob[4] != BLOB_VERSION) { // version
        failStage = 3;
        return false;
    }
    if (blob[5] != PHASES) {
        failStage = 4;
        return false;
    }
    if (readU32(blob, 8) != ORBITS) {
        failStage = 5;
        return false;
    }
    for (0..PHASES) |ph| scales[ph] = readF32(blob, 12 + 4 * ph);

    // ① 每槽求"最小像"、符号、是否被对称性逼成 0
    @memset(&zflag, 0);
    for (1..PTN_COUNT + 1) |p| {
        const off = model.slot_off[p];
        var idx: u32 = 0;
        while (idx < model.tri[p]) : (idx += 1) {
            const r = canonSlot(p, idx);
            const s = off + idx;
            can_tab[s] = r.slot;
            sigma[s] = r.sign;
            if (r.zero) zflag[s] = 1;
        }
    }

    // ② 代表(s == canon[s],即轨道里槽号最小的那个)按升序编号
    var next: u16 = 0;
    for (0..PER_PHASE) |i| {
        if (can_tab[i] == i) {
            orbit[i] = next;
            next += 1;
        }
    }
    dbgNext = next;
    if (next != ORBITS) {
        failStage = 6;
    }

    // ③ 全表填号,同时把"制 0"标记按轨道归并。
    //    安全点:canon[s] ≤ s,而 canon[canon[s]] == canon[s],所以第二趟里
    //    读到的 orbit[canon[s]] 要么是第一趟给的号,要么是同值的自赋值。
    @memset(&orb_zero, 0);
    for (0..PER_PHASE) |i| {
        const o = orbit[can_tab[i]];
        orbit[i] = o;
        if (zflag[i] != 0) orb_zero[o] = 1;
    }

    // ④ 摊平成"符号已折入"的查表
    installQuant(blob[BLOB_HEADER..], scales);
    if (failStage != 0) return false;
    ready = true;
    return true;
}

/// 直接用「已经量化好的 int8 轨道权重」重装查表。
/// 与 init() 的第 ④ 步是**同一段逻辑** —— 训练器每轮都要换一次权重,
/// 没必要为了换权重重走一遍 blob 解析;更重要的是这样能保证
/// "训练时搜索用的表" 与 "部署时 init 出的表" 逐字节同源(不会各写一份实现而漂移)。
/// 参数是 u8 而不是 i8:blob 是字节流,让调用方 @ptrCast 会碰对齐问题,不值当。
pub fn installQuant(q: []const u8, sc: [PHASES]f32) void {
    scales = sc;
    for (0..PHASES) |ph| {
        const base = ph * ORBITS;
        for (0..PER_PHASE) |i| {
            const o = orbit[i];
            var w: i8 = if (orb_zero[o] != 0) 0 else @bitCast(q[base + o]);
            if (sigma[i] < 0) w = -w;
            wt[ph][i] = w;
        }
    }
    ready = true;
}

/// 逐张表算 base-3 下标,输出全局槽号。
/// 38 张表全部 comptime 展开:每格的移位量、幂次都是编译期常量。
pub fn slotIndices(b: rules.Board, out: *[PTN_COUNT]u32) void {
    const own = b.own;
    const opp = b.opp;
    inline for (1..PTN_COUNT + 1) |p| {
        var idx: u32 = 0;
        const off = model.cell_off[p];
        inline for (0..8) |k| {
            if (k < model.len[p]) {
                const bit = @as(u64, 1) << @intCast(model.cells[off + k]);
                // 0 = 空,1 = 行棋方,2 = 对方 —— 一律**行棋方视角**,
                // 这样求值天然服务负极大,换色对称也正好是"符号取反"。
                if (own & bit != 0) {
                    idx += POW3[k];
                } else if (opp & bit != 0) {
                    idx += 2 * POW3[k];
                }
            }
        }
        out[p - 1] = model.slot_off[p] + idx;
    }
}

/// 模式评估(行棋方视角,单位:子数)
pub fn eval(b: rules.Board) f32 {
    var s: [PTN_COUNT]u32 = undefined;
    slotIndices(b, &s);
    const ph = phaseOf(b.discs());
    const tab = &wt[ph];
    var sum: i32 = 0;
    inline for (0..PTN_COUNT) |i| sum += tab[s[i]];
    return @as(f32, @floatFromInt(sum)) * scales[ph];
}

/// 未乘 scale 的**整数**加权和。对拍专用:整数能逐位比较,浮点不能
/// (格式化位数、舍入模式都能让"其实一样"的两个数看起来不同)。
pub fn evalInt(b: rules.Board) i32 {
    var s: [PTN_COUNT]u32 = undefined;
    slotIndices(b, &s);
    const tab = &wt[phaseOf(b.discs())];
    var sum: i32 = 0;
    inline for (0..PTN_COUNT) |i| sum += tab[s[i]];
    return sum;
}

/// 浮点(未量化)权重下同一套折叠规则的评估 —— **训练自对弈的叶子求值入口**
/// (`search.eval_u` 非 null 时走这里)。
/// 与量化版共用 orbit/sigma 表,所以"自对弈看到的分值"和"落盘后跑出来的值"
/// 只差一次 int8 舍入,不会出现两套折叠口径。
///
/// ⚠ 收**指针**而不是值:`[PHASES][ORBITS]f32` 是 227,400 字节(6 相位),按值传会在
///   **每个叶子节点**上复制一遍 —— 一趟 38 个槽的乘加省下的,一次复制全赔回去。
///
/// ⚠ 与 `installQuant` 的一处不对称:那边会把 `orb_zero` 的轨道强制写成 0,
///   这里**不检查** `orb_zero`(每个叶子省 38 次判断)。所以调用方必须保证
///   传进来的表在 `orb_zero` 轨道上确实是 0 —— 否则 f32 求值和 int8 求值会
///   悄悄分叉,而且是"只在若干局面下差一点"的那种,极难定位。
///   train.zig 每轮拟合后都会清一遍,是唯一的写入方。
pub fn evalFloat(b: rules.Board, u: *const [PHASES][ORBITS]f32) f32 {
    var s: [PTN_COUNT]u32 = undefined;
    slotIndices(b, &s);
    const ph = phaseOf(b.discs());
    var sum: f32 = 0;
    for (s) |sl| {
        const i: usize = sl;
        sum += @as(f32, @floatFromInt(sigma[i])) * u[ph][@as(usize, orbit[i])];
    }
    return sum;
}

/// 让 38 张表的查表结果直接相加 —— 求和顺序固定,便于与 JS 侧逐位对拍
pub fn evalSlots(s: *const [PTN_COUNT]u32, discs: u32) f32 {
    const ph = phaseOf(discs);
    const tab = &wt[ph];
    var sum: i32 = 0;
    inline for (0..PTN_COUNT) |i| sum += tab[s[i]];
    return @as(f32, @floatFromInt(sum)) * scales[ph];
}

