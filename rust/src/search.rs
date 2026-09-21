//! PVS 负极大搜索 + 置换表 + 残局完全求解 —— src/zig/search.zig 的移植。
//!
//! 与 zig 版的一处刻意简化:训练专用的 eval_u 影子表路径(f32 权重)不搬,
//! 叶子求值恒走 ④ 增量槽号(inc::sumInt)—— 这正是 zig 在 wasm 下的行为,
//! 生产语义一行没变。solveExact / train 相关导出同样不搬。
//!
//! 置换表条目直接存 own/opp 两个 u64,命中靠 16 字节全比对(零伪命中);
//! 中局/残局共一张表,EXACT_SALT 参与散列隔开两种评分语义。
//! 评分单位:子数(f32)。终局 = 子差,中局 = scale × Σ int8 权重。

use crate::endgame;
use crate::inc;
use crate::pattern;
use crate::rules::{self, Board};
use crate::stability;
use crate::G;

pub const INF: f32 = 1e30;

pub const MAX_PLY: usize = 72;
const MAX_MOVES: usize = 36; // 黑白棋单方最多 33 个合法着法

/// 置换表:2^20 × 24 B = 24 MB,放静态区(零页不进 wasm 文件)
const TT_BITS: u32 = 20;
const TT_SIZE: usize = 1 << TT_BITS;
const TT_MASK: u64 = (TT_SIZE - 1) as u64;

#[derive(Copy, Clone)]
#[repr(C)]
struct Entry {
    own: u64,
    opp: u64,
    score: f32,
    mv: i8,
    depth: i8,
    flag: u8,
    _pad: [u8; 6],
} // 恰 24 B

pub const F_EXACT: u8 = 1;
pub const F_LOWER: u8 = 2;
pub const F_UPPER: u8 = 3;

static TT: G<[Entry; TT_SIZE]> = G::new([Entry { own: 0, opp: 0, score: 0.0, mv: 0, depth: 0, flag: 0, _pad: [0; 6] }; TT_SIZE]);
static TT_READY: G<bool> = G::new(false);

/// 中局/残局共表时必须把两种评分语义隔开,否则一次伪命中就能让残局求解给出错着
const EXACT_SALT: u64 = 0x5DEE_CE66_D000_0000;

/// 定槽散列:乘法摊熵 + splitmix 式 finalizer,取**高位**做槽号
/// (残局盘面低位几乎全 1,直接取低位当槽号冲突率会暴涨)。不承担正确性:
/// 撞槽只损失一次命中(own/opp 全比对兜底),不会返回错误数据。
#[inline]
fn slot_of(b: Board, exact: bool) -> usize {
    let mut h = b.own.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    h ^= b.opp.wrapping_mul(0xC2B2_AE3D_27D4_EB4F);
    if exact {
        h ^= EXACT_SALT;
    }
    h = h.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
    h ^= h >> 29;
    ((h >> (64 - TT_BITS)) & TT_MASK) as usize
}

// ── 着法提示表(跨盐):只记"这个局面上一轮搜出来的最佳着法" ──
const HINT_BITS: u32 = 16;
const HINT_SIZE: usize = 1 << HINT_BITS;
const HINT_MASK: u64 = (HINT_SIZE - 1) as u64;

#[derive(Copy, Clone)]
struct Hint {
    own: u64,
    opp: u64,
    mv: i8,
    _pad: [u8; 7],
}
static HINT: G<[Hint; HINT_SIZE]> = G::new([Hint { own: 0, opp: 0, mv: 0, _pad: [0; 7] }; HINT_SIZE]);

#[inline]
fn hint_slot_of(b: Board) -> usize {
    let mut h = b.own.wrapping_mul(0x2545_F491_4F6C_DD1D);
    h ^= b.opp.wrapping_mul(0x9E37_79B9_97F4_A7C1);
    h ^= h >> 31;
    ((h >> (64 - HINT_BITS)) & HINT_MASK) as usize
}

#[inline]
fn hint_store(b: Board, mv: u32) {
    let h = &mut HINT.w()[hint_slot_of(b)];
    h.own = b.own;
    h.opp = b.opp;
    h.mv = mv as i8;
}

/// 排序用位置权重(角贵、角邻负分)
const W64O: [i8; 64] = [
    120, -20, 20, 5, 5, 20, -20, 120, -20, -40, -5, -5, -5, -5, -40, -20, 20, -5, 15, 3, 3, 15,
    -5, 20, 5, -5, 3, 3, 3, 3, -5, 5, 5, -5, 3, 3, 3, 3, -5, 5, 20, -5, 15, 3, 3, 15, -5, 20,
    -20, -40, -5, -5, -5, -5, -40, -20, 120, -20, 20, 5, 5, 20, -20, 120,
];

// ── 全部可变状态(单线程 wasm,静态区)──
static NODES: G<u64> = G::new(0);
static EVALS: G<u64> = G::new(0);
static NODE_LIMIT: G<u64> = G::new(0); // 0 = 不限
static ABORTED: G<bool> = G::new(false);
static PLY_MOVES: G<[[u32; MAX_MOVES]; MAX_PLY]> = G::new([[0; MAX_MOVES]; MAX_PLY]);
static PLY_FLIPS: G<[[u64; MAX_MOVES]; MAX_PLY]> = G::new([[0; MAX_MOVES]; MAX_PLY]);
static PLY_SCORES: G<[[i32; MAX_MOVES]; MAX_PLY]> = G::new([[0; MAX_MOVES]; MAX_PLY]);
static PLY_CNT: G<[u32; MAX_PLY]> = G::new([0; MAX_PLY]);
// ④ 增量评估:per-ply 槽号状态(帧属方 = 根行棋方)
static PLY_INC: G<[inc::State; MAX_PLY]> = G::new([inc::State::new(); MAX_PLY]);

pub fn nodes() -> u64 {
    NODES.r0()
}
pub fn set_nodes(n: u64) {
    *NODES.w() = n;
}
pub fn aborted() -> bool {
    ABORTED.r0()
}
/// endgame 尾部路径的记账要读写(与 zig 的 search.node_limit 同一全局)
pub fn node_limit() -> u64 {
    NODE_LIMIT.r0()
}
pub fn set_aborted() {
    *ABORTED.w() = true;
}

/// ⑥ MPC 状态
static MPC_ENABLED: G<bool> = G::new(false);
static MPC_MPCT: G<f32> = G::new(0.0);
static MPC_ROOT_DEPTH: G<i32> = G::new(0);
const MPC_SIGMA: [f32; 4] = [11.667, -0.0665, -0.7164, 0.0];
const MPC_MIN_DEPTH: i32 = 8;
const MPC_IGNORE: i32 = 2;
/// ⑥b 尾盘 MPC:纯精确带下沿(空位数);0 = 关闭
static MPC_END_PURE: G<i32> = G::new(0);
static MPC_END_USED: G<bool> = G::new(false);

// ── 根着法清单(选着策略在 worker 的 JS,引擎只发清单)──
static ROOT_N: G<u32> = G::new(0);
static ROOT_MOVES: G<[u8; MAX_MOVES]> = G::new([0; MAX_MOVES]);
static ROOT_SCORES: G<[f32; MAX_MOVES]> = G::new([0.0; MAX_MOVES]);
static ROOT_EXACT: G<bool> = G::new(false);
static ROOT_TRUE: G<[bool; MAX_MOVES]> = G::new([false; MAX_MOVES]);
/// root_search 的暂存(按着法下标,与 root_v 平行)
static ROOT_TRUE_BUF: G<[bool; MAX_MOVES]> = G::new([false; MAX_MOVES]);

pub fn clear_tt() {
    let bytes = unsafe {
        core::slice::from_raw_parts_mut(TT.w().as_mut_ptr() as *mut u8, core::mem::size_of_val(TT.w()))
    };
    bytes.fill(0);
    *TT_READY.w() = true;
}

#[inline]
fn terminal_score(b: Board) -> f32 {
    b.diff() as f32
}

/// 零窗口宽度。必须**小于**分值的量化步长;取全部相位 scale 的最小者
/// (偏小是安全方向:偏大会吞掉真正更好的着法)
#[inline]
fn eps(exact: bool) -> f32 {
    if exact {
        return 0.5;
    }
    let mut m = pattern::scales(0);
    for ph in 1..pattern::PHASES {
        m = m.min(pattern::scales(ph));
    }
    (m * 0.25).max(1e-4)
}

/// 潜在行动力:与 x 方棋子 8 邻接的空格数
#[inline]
fn potential_mob(x: u64, empty: u64) -> u64 {
    let h: u64 = x & 0x7E7E_7E7E_7E7E_7E7E;
    let v: u64 = x & 0x00FF_FFFF_FFFF_FF00;
    let hv: u64 = x & 0x007E_7E7E_7E7E_7E00;
    empty
        & ((h << 1) | (h >> 1) | (v << 8) | (v >> 8) | (hv << 7) | (hv >> 7) | (hv << 9) | (hv >> 9))
}

/// 角上着法数(0..4):对方角行动力比普通行动力贵好几倍
#[inline]
fn corner_mob(legal: u64) -> i32 {
    let mut n: i32 = 0;
    for k in [0u32, 7, 56, 63] {
        if legal & (1u64 << k) != 0 {
            n += 1;
        }
    }
    n
}

/// 8 连通膨胀(含源自身):先横后纵即可覆盖四个对角
#[inline]
fn expand8(x: u64) -> u64 {
    let ew = x | ((x & !rules::FILE_A) >> 1) | ((x & !rules::FILE_H) << 1);
    ew | (ew << 8) | (ew >> 8)
}

/// 奇数大小的空格连通区域(终局"谁在某连通空区里走最后一步"的争夺;纯排序)
fn parity_mask(empty: u64) -> u64 {
    let mut rest = empty;
    let mut out: u64 = 0;
    while rest != 0 {
        let seed = rest & rest.wrapping_neg();
        let mut comp = seed;
        loop {
            let grown = expand8(comp) & empty;
            if grown == comp {
                break;
            }
            comp = grown;
        }
        rest &= !comp;
        if comp.count_ones() & 1 == 1 {
            out |= comp;
        }
    }
    out
}

/// ④ 增量路径的量化求值:与 pattern::eval 逐位相等(同一整数和 × 同一 scale)
#[inline]
fn eval_inc(_b: Board, ply: u32) -> f32 {
    let s = &PLY_INC.r()[ply as usize];
    let ph = pattern::phase_of(s.discs);
    inc::sum_int(s) as f32 * pattern::scales(ph)
}

/// PVS 负极大。返回**行棋方视角**的分值。
/// exact = true 时 depth ≤ 0 不调用启发式评估,给终局点差兜底值。
fn search(b: Board, depth: i32, alpha_in: f32, beta_in: f32, ply: u32, exact: bool) -> f32 {
    *NODES.w() += 1;
    if NODE_LIMIT.r0() != 0 && NODES.r0() > NODE_LIMIT.r0() {
        *ABORTED.w() = true;
        return 0.0;
    }

    // ≤7 空:尾部快速路径 —— 不查 TT、不做排序,象限奇偶分流 + last4~1 专用函数
    if exact && 64 - b.discs() <= endgame::END_FAST_EMPTIES {
        return endgame::end_fast(b, alpha_in, beta_in, false);
    }

    let mut alpha = alpha_in;
    let mut beta = beta_in;
    // 只在 depth > 0 时查表:叶子占绝大多数而叶子 TT 命中率极低
    let mut slot: usize = 0;
    let mut promo: i32 = -1; // TT / 提示表给出的首着法(排序提升用)
    if depth > 0 {
        slot = slot_of(b, exact);
        let e = &TT.r()[slot];
        if e.own == b.own && e.opp == b.opp {
            if e.depth as i32 >= depth
                && (e.flag == F_EXACT
                    || (e.flag == F_LOWER && e.score >= beta)
                    || (e.flag == F_UPPER && e.score <= alpha))
            {
                return e.score;
            }
            promo = e.mv as i32;
        }
        if promo < 0 {
            let h = &HINT.r()[hint_slot_of(b)];
            if h.own == b.own && h.opp == b.opp {
                promo = h.mv as i32;
            }
        }
    }

    if ply + 2 >= MAX_PLY as u32 || depth <= 0 {
        if exact {
            // ⑥b 混合残局:叶子落在纯精确带内 → 窗口内完全求解(子解共享 TT)
            if MPC_END_PURE.r0() > 0 && (64 - b.discs()) as i32 <= MPC_END_PURE.r0() {
                return search(b, (64 - b.discs() + 4) as i32, alpha, beta, ply, true);
            }
            return terminal_score(b);
        }
        *EVALS.w() += 1;
        return eval_inc(b, ply);
    }

    let m = rules::moves(b);
    if m == 0 {
        // 无棋可走:对方也无 → 终局;否则虚着换手(不消耗深度)
        let sw = b.swapped();
        if rules::moves(sw) == 0 {
            return terminal_score(b);
        }
        PLY_INC.w()[ply as usize + 1] = PLY_INC.r()[ply as usize];
        inc::pass_flip(&mut PLY_INC.w()[ply as usize + 1]);
        return -search(sw, depth, -beta, -alpha, ply + 1, exact);
    }

    // 稳定子剪枝(仅完全求解:剪枝界是子差意义的)
    if exact {
        let c = stability::cut(b, alpha, beta);
        if let Some(v) = c.value {
            return v;
        }
        alpha = c.alpha;
        beta = c.beta;
    }

    // ⑥b 尾盘 MPC:exact 求解在纯精确带之上,用中局 dv2 全窗搜索估计真实分值,
    // 远离窗口即剪。命中剪枝必须置 MPC_END_USED(engineExact() 会报 0)
    if exact && MPC_END_PURE.r0() > 0 && MPC_MPCT.r0() > 0.0 {
        let empt_i: i32 = (64 - b.discs()) as i32;
        if empt_i > MPC_END_PURE.r0() + 1 {
            let thr = MPC_MPCT.r0() * mpc_end_sigma(empt_i as f32);
            let saved = *MPC_ENABLED.w();
            *MPC_ENABLED.w() = false;
            let v = search(b, 2, -INF, INF, ply, false);
            *MPC_ENABLED.w() = saved;
            if !ABORTED.r0() {
                if v >= beta + thr {
                    *MPC_END_USED.w() = true;
                    return beta;
                }
                if v <= alpha - thr {
                    *MPC_END_USED.w() = true;
                    return alpha;
                }
            }
        }
    }

    // ⑥ MPC:中局节点估值远离窗口时,浅层零窗口验证代替完整搜索
    if MPC_ENABLED.r0() && !exact && depth >= MPC_MIN_DEPTH && MPC_ROOT_DEPTH.r0() - depth >= MPC_IGNORE {
        // dv = 深度的 1/4,向上取整到偶数,再对齐原深度奇偶(取整方向见 zig 侧注释)
        let dv: i32 = ((((depth as u32) >> 2) + 1) & 0xFE ^ (depth as u32 & 1)) as i32;
        let eval0 = eval_inc(b, ply);
        let sig = MPC_MPCT.r0() * mpc_sigma((64 - b.discs()) as f32, dv as f32);
        let err0 = sig;
        let err_s = sig;
        // 上截
        if eval0 >= beta + err0 && beta + err_s < 64.0 {
            let saved = *MPC_ENABLED.w();
            *MPC_ENABLED.w() = false;
            let v = search(b, dv, beta + err_s - eps(false), beta + err_s, ply, exact);
            *MPC_ENABLED.w() = saved;
            if !ABORTED.r0() && v >= beta + err_s {
                return beta;
            }
        }
        // 下截
        if eval0 <= alpha - err0 && alpha - err_s > -64.0 {
            let saved = *MPC_ENABLED.w();
            *MPC_ENABLED.w() = false;
            let v = search(b, dv, alpha - err_s, alpha - err_s + eps(false), ply, exact);
            *MPC_ENABLED.w() = saved;
            if !ABORTED.r0() && v <= alpha - err_s {
                return alpha;
            }
        }
    }

    let par: u64 = if exact { parity_mask(b.empty()) } else { 0 };
    let mut n: usize = 0;
    let mut mm = m;
    while mm != 0 {
        let sq = mm.trailing_zeros();
        mm &= mm - 1;
        let f = rules::flips(b, sq);
        let fc = f.count_ones() as i32;
        PLY_MOVES.w()[ply as usize][n] = sq;
        PLY_FLIPS.w()[ply as usize][n] = f;
        // 中局:翻子多优先;残局:翻子少优先(少给对手留行动力)
        let mut s: i32 = W64O[sq as usize] as i32 + (if exact { -fc } else { fc }) * 2;
        if exact && (par >> sq) & 1 == 1 {
            s += 1000;
        }
        if !exact {
            // ⑤ 排序补项:落一子看落子后的局面 —— 对方行动力(角邻加权)越少越好
            let nb = rules::play_move(b, sq, f);
            let om = rules::moves(nb.swapped());
            s -= (om.count_ones() as i32 * 2 + corner_mob(om)) * 8;
            let emp = nb.empty();
            s += potential_mob(nb.own, emp).count_ones() as i32 * 8;
            s -= potential_mob(nb.opp, emp).count_ones() as i32 * 10;
        }
        PLY_SCORES.w()[ply as usize][n] = s;
        n += 1;
    }
    PLY_CNT.w()[ply as usize] = n as u32;

    // 置换表/提示表最优着法换到队首。必须连翻子掩码一起换 ——
    // 漏搬会让队首着法配到别人的翻子掩码,make 出非法局面
    let mut promo_first = false;
    if promo >= 0 {
        let want = promo as u32;
        let mut k = 0usize;
        while k < n && PLY_MOVES.w()[ply as usize][k] != want {
            k += 1;
        }
        if k < n {
            if k > 0 {
                let p = ply as usize;
                PLY_MOVES.w()[p].swap(0, k);
                PLY_SCORES.w()[p].swap(0, k);
                PLY_FLIPS.w()[p].swap(0, k);
            }
            promo_first = true;
        }
    }

    let mut best: f32 = -INF;
    let mut best_move = PLY_MOVES.r()[ply as usize][0];
    let alpha0 = alpha;
    let mut i = 0usize;
    while i < n {
        // 懒选择:搜到第 i 个着法前才在 [i..n) 里选剩余最大者换上来。
        // 第 0 轮在首着提升命中时必须跳过(TT/提示表着法优先于一切静态分)
        if !(i == 0 && promo_first) {
            let p = ply as usize;
            let mut sel = i;
            let mut k = i + 1;
            while k < n {
                if PLY_SCORES.r()[p][k] > PLY_SCORES.r()[p][sel] {
                    sel = k;
                }
                k += 1;
            }
            if sel != i {
                PLY_MOVES.w()[p].swap(i, sel);
                PLY_SCORES.w()[p].swap(i, sel);
                PLY_FLIPS.w()[p].swap(i, sel);
            }
        }
        let p = ply as usize;
        let sq = PLY_MOVES.r()[p][i];
        let f = PLY_FLIPS.r()[p][i];
        let nb = rules::play_move(b, sq, f);
        // ④ 子节点状态 = 父状态整份抄过来再打增量;父状态永不被就地改写
        PLY_INC.w()[p + 1] = PLY_INC.r()[p];
        inc::move_update(&mut PLY_INC.w()[p + 1], sq, f, PLY_INC.r()[p].home_to_move);
        let v: f32;
        if i == 0 {
            v = -search(nb, depth - 1, -beta, -alpha, ply + 1, exact);
        } else {
            // 零窗口试探,超界再重搜(principal variation search)
            let probe = -search(nb, depth - 1, -alpha - eps(exact), -alpha, ply + 1, exact);
            if alpha < probe && probe < beta {
                v = -search(nb, depth - 1, -beta, -probe, ply + 1, exact);
            } else {
                v = probe;
            }
        }
        if v > best {
            best = v;
            best_move = sq;
        }
        if v > alpha {
            alpha = v;
        }
        if alpha >= beta {
            break;
        }
        if ABORTED.r0() {
            break;
        }
        i += 1;
    }

    if depth > 0 && !ABORTED.r0() {
        let e = &mut TT.w()[slot];
        // ⑦ 留深替换:同槽撞上同局面的更深记录时不覆盖;异局面照常覆盖
        if !(e.own == b.own && e.opp == b.opp && e.depth as i32 > depth) {
            e.own = b.own;
            e.opp = b.opp;
            e.score = best;
            e.depth = depth as i8;
            e.flag = if best >= beta { F_LOWER } else if best > alpha0 { F_EXACT } else { F_UPPER };
            e.mv = best_move as i8;
        }
        hint_store(b, best_move);
    }
    best
}

#[inline]
fn mpc_sigma(empties: f32, d_verify: f32) -> f32 {
    (MPC_SIGMA[0] + MPC_SIGMA[1] * empties + MPC_SIGMA[2] * d_verify).max(2.0)
}

/// σ_end(E):中局 dv2 搜索分 vs 精确解的零中心 SD 线性模型,已含 12% 余量
#[inline]
fn mpc_end_sigma(empt: f32) -> f32 {
    (23.5 - 0.73 * empt).max(4.0)
}

/// 发布一份根着法清单(稳定排序:分数降序,同分保持传入顺序 = 位号升序)
pub fn publish_root(mvs: &[u32], scs: &[f32], trues: &[bool], n: u32, exact: bool) {
    *ROOT_N.w() = n;
    *ROOT_EXACT.w() = exact;
    if n == 0 {
        return;
    }
    let mut order: [u32; MAX_MOVES] = [0; MAX_MOVES];
    for i in 0..n as usize {
        order[i] = i as u32;
    }
    let mut i = 1usize;
    while i < n as usize {
        let oi = order[i];
        let sc = scs[oi as usize];
        let mut j = i as isize - 1;
        while j >= 0 && scs[order[j as usize] as usize] < sc {
            order[j as usize + 1] = order[j as usize];
            j -= 1;
        }
        order[j as usize + 1] = oi;
        i += 1;
    }
    for k in 0..n as usize {
        ROOT_MOVES.w()[k] = mvs[order[k] as usize] as u8;
        ROOT_SCORES.w()[k] = scs[order[k] as usize];
        ROOT_TRUE.w()[k] = trues[order[k] as usize];
    }
}

#[derive(Copy, Clone)]
pub struct Result {
    pub mv: i32,
    pub score: f32,
    pub depth: u32,
    pub exact: bool,
    pub only: bool,
    pub endgame: bool,
}

impl Result {
    pub fn none() -> Result {
        Result { mv: -1, score: 0.0, depth: 0, exact: false, only: false, endgame: false }
    }
}

/// 根搜索一轮:按上一轮得分重排 order 以便下一轮迭代
fn root_search(b: Board, depth: i32, exact: bool, order: &mut [u32; MAX_MOVES], root_v: &mut [f32; MAX_MOVES]) -> Result {
    // ④ 增量状态每轮从根全量重置(帧属方 = 根行棋方)
    inc::ensure_tables();
    inc::set(b, true, &mut PLY_INC.w()[0]);

    let m = rules::moves(b);
    if m == 0 {
        return Result::none();
    }
    let par: u64 = if exact { parity_mask(b.empty()) } else { 0 };
    let mut n: usize = 0;
    let mut mm = m;
    while mm != 0 {
        let sq = mm.trailing_zeros();
        mm &= mm - 1;
        let f = rules::flips(b, sq);
        let fc = f.count_ones() as i32;
        PLY_MOVES.w()[0][n] = sq;
        PLY_FLIPS.w()[0][n] = f;
        let mut s: i32 = W64O[sq as usize] as i32 + (if exact { -fc } else { fc }) * 2;
        if exact && (par >> sq) & 1 == 1 {
            s += 1000;
        }
        PLY_SCORES.w()[0][n] = s;
        n += 1;
    }
    PLY_CNT.w()[0] = n as u32;
    *MPC_ROOT_DEPTH.w() = depth;
    if n == 1 {
        // 唯一着法也真搜(用户决策):score 是真搜索值;only 标记保留
        let sq = PLY_MOVES.r()[0][0];
        let f = PLY_FLIPS.r()[0][0];
        let nb = rules::play_move(b, sq, f);
        PLY_INC.w()[1] = PLY_INC.r()[0];
        inc::move_update(&mut PLY_INC.w()[1], sq, f, PLY_INC.r()[0].home_to_move);
        let v = -search(nb, depth - 1, -INF, INF, 1, exact);
        let om = [sq];
        let os = [v];
        let ot = [true];
        publish_root(&om, &os, &ot, 1, exact);
        return Result { mv: sq as i32, score: v, depth: depth as u32, exact, only: true, endgame: false };
    }

    // 首轮按静态分排;之后由调用方传入上一轮的 order
    let mut first = true;
    for k in 0..n {
        if order[k] != 0 {
            first = false;
            break;
        }
    }
    if first {
        for k in 0..n {
            order[k] = k as u32;
        }
        let mut i = 1usize;
        while i < n {
            let oi = order[i];
            let sc = PLY_SCORES.r()[0][oi as usize];
            let mut j = i as isize - 1;
            while j >= 0 && PLY_SCORES.r()[0][order[j as usize] as usize] < sc {
                order[j as usize + 1] = order[j as usize];
                j -= 1;
            }
            order[j as usize + 1] = oi;
            i += 1;
        }
    }

    let mut alpha: f32 = -INF;
    let beta = INF;
    let mut k = 0usize;
    while k < n {
        let idx = order[k] as usize;
        let sq = PLY_MOVES.r()[0][idx];
        let f = PLY_FLIPS.r()[0][idx];
        let nb = rules::play_move(b, sq, f);
        PLY_INC.w()[1] = PLY_INC.r()[0];
        inc::move_update(&mut PLY_INC.w()[1], sq, f, PLY_INC.r()[0].home_to_move);
        let mut v: f32;
        // v_true:返回值是否被搜索窗口定死为真值 —— JS 的随机只吃真值项
        let mut v_true: bool;
        if k == 0 {
            v = -search(nb, depth - 1, -beta, -alpha, 1, exact);
            v_true = alpha < v; // 本轮首轮 alpha=-INF,恒真值;规则照写防将来改窗
        } else {
            let probe = -search(nb, depth - 1, -alpha - eps(exact), -alpha, 1, exact);
            v = probe;
            v_true = false; // 零窗口:两个失败方向都只是界
            if alpha < probe && probe < beta {
                let full = -search(nb, depth - 1, -beta, -probe, 1, exact);
                v = full;
                v_true = full > probe; // 重搜窗口 (probe, INF):> probe 即真值
            }
        }
        root_v[idx] = v;
        ROOT_TRUE_BUF.w()[idx] = v_true;
        if v > alpha {
            alpha = v;
        }
        if ABORTED.r0() {
            break;
        }
        k += 1;
    }
    // 按本轮得分重排,供下一轮迭代使用
    let mut i = 1usize;
    while i < n {
        let oi = order[i];
        let sc = root_v[oi as usize];
        let mut j = i as isize - 1;
        while j >= 0 && root_v[order[j as usize] as usize] < sc {
            order[j as usize + 1] = order[j as usize];
            j -= 1;
        }
        order[j as usize + 1] = oi;
        i += 1;
    }
    let best = order[0] as usize;
    // 只在整轮完整跑完时发布清单:中断轮里未搜到的着法 root_v 是陈旧值
    if !ABORTED.r0() {
        let mvs: [u32; MAX_MOVES] = {
            let mut a = [0u32; MAX_MOVES];
            for t in 0..n {
                a[t] = PLY_MOVES.r()[0][t];
            }
            a
        };
        publish_root(&mvs[..n], &root_v[..n], &ROOT_TRUE_BUF.r().clone()[..n], n as u32, exact);
    }
    Result { mv: PLY_MOVES.r()[0][best] as i32, score: root_v[best], depth: depth as u32, exact, only: false, endgame: false }
}

/// 完全求解前的中层预搜限吃预算的 1/3:预算被预搜耗尽时,完全求解还留得下大头
pub const PRE_ENDGAME_FRAC: u64 = 3;

/// 迭代加深主入口。node_budget = 0 表示不限;超预算时返回上一个完整深度的结果。
/// 选着(容差/同分随机)不在这里:策略住在 worker 的 JS 里。
pub fn think(b: Board, depth_max: u32, endgame_empty: u32, node_budget: u64) -> Result {
    if !TT_READY.r0() {
        clear_tt();
    }
    stability::ensure_init();
    inc::ensure_tables();
    *NODES.w() = 0;
    *EVALS.w() = 0;
    *ABORTED.w() = false;
    *MPC_END_USED.w() = false;
    *NODE_LIMIT.w() = node_budget;

    let empties = 64 - b.discs();

    // 初级:纯贪心(位置权重 + 翻子数),不搜索。
    // order/rv 必须先清零:root_search 靠"order 里有没有非 0"判断是不是首轮
    if depth_max == 0 {
        let mut order = [0u32; MAX_MOVES];
        let mut rv = [0f32; MAX_MOVES];
        return root_search(b, 0, false, &mut order, &mut rv);
    }

    let mut order = [0u32; MAX_MOVES];
    let mut rv = [0f32; MAX_MOVES];

    if empties <= endgame_empty {
        // 残局:先前置中层迭代加深定根排序,再(混合)求解
        let hybrid: bool = MPC_END_PURE.r0() > 0 && empties as i32 > MPC_END_PURE.r0() + 2;
        let solve_depth: i32 =
            if hybrid { empties as i32 - MPC_END_PURE.r0() } else { empties as i32 + 2 };
        let mut d: u32 = 2;
        let mut pre = ((empties + 1) / 2).min(depth_max).min(empties);
        if hybrid {
            pre = pre.min(solve_depth as u32);
        }
        // 预搜限吃预算的 1/3:完全求解保住大头,engineExact() 不因预搜丢精确性
        let saved_limit = NODE_LIMIT.r0();
        if node_budget != 0 {
            *NODE_LIMIT.w() = NODE_LIMIT.r0().min(NODES.r0() + node_budget / PRE_ENDGAME_FRAC);
        }
        let mut last = Result::none();
        while d <= pre {
            last = root_search(b, d as i32, false, &mut order, &mut rv);
            if ABORTED.r0() || last.only {
                break;
            }
            d += 2;
        }
        *NODE_LIMIT.w() = saved_limit;
        if last.only {
            // 唯一着法不是"免求解通行证":落子后递归一次完全求解,把真值补上。
            // 不能无限制地解 —— 预算耗尽时 aborted 置位,engineExact() 照旧报 0
            if !ABORTED.r0() {
                let nb = rules::play(b, last.mv as u32);
                // 这条直搜不经 root_search,ply 0 状态在这里补上
                inc::set(nb, true, &mut PLY_INC.w()[0]);
                last.score = -search(nb, (64 - nb.discs() + 4) as i32, -INF, INF, 0, true);
                last.exact = true;
                last.endgame = true;
            }
            return last;
        }
        // 纯精确:空数 +2 余量(虚着不消耗深度);混合:空数 − 下沿(叶子即带内)
        let r = root_search(b, solve_depth, true, &mut order, &mut rv);
        if ABORTED.r0() {
            let mut last2 = last;
            last2.endgame = true;
            return last2;
        }
        let mut r2 = r;
        r2.endgame = true;
        return r2;
    }

    let mut res = Result::none();
    let top = depth_max.min(empties + 2);
    if top >= 8 {
        // ⑤b 三段阶梯 {top-4, top-2, top}:内部节点有了像样的先验排序,
        // by-2 全阶梯的早期轮次只剩 TT 预热价值,不值 10~20% 的节点
        for dd in [top.saturating_sub(4), top.saturating_sub(2), top] {
            if dd < 2 {
                continue;
            }
            let r = root_search(b, dd as i32, false, &mut order, &mut rv);
            if ABORTED.r0() {
                break;
            }
            res = r;
        }
    } else {
        let mut d: u32 = 2;
        while d <= top {
            let r = root_search(b, d as i32, false, &mut order, &mut rv);
            if ABORTED.r0() {
                break;
            }
            res = r;
            d += 2;
        }
    }
    if res.mv == -1 {
        // 一个深度都没跑完(预算极小):退回单层静态结果,至少给出一个合法着法
        return root_search(b, 1, false, &mut order, &mut rv);
    }
    res
}

// ── 引擎层(engine.zig 对应物)要读的状态 ──
pub fn root_n() -> u32 {
    ROOT_N.r0()
}
pub fn root_move(i: u32) -> i32 {
    if i >= ROOT_N.r0() {
        return -1;
    }
    ROOT_MOVES.r()[i as usize] as i32
}
pub fn root_score(i: u32) -> f32 {
    if i >= ROOT_N.r0() {
        return 0.0;
    }
    ROOT_SCORES.r()[i as usize]
}
pub fn root_exact() -> bool {
    ROOT_EXACT.r0()
}
pub fn root_true(i: u32) -> bool {
    if i >= ROOT_N.r0() {
        return false;
    }
    ROOT_TRUE.r()[i as usize]
}
pub fn set_mpc(flag: bool, mpct: f32) {
    *MPC_ENABLED.w() = flag;
    *MPC_MPCT.w() = mpct;
}
pub fn set_end_mpc(pure: u32) {
    *MPC_END_PURE.w() = pure as i32;
}
pub fn mpc_end_used() -> bool {
    MPC_END_USED.r0()
}
/// bookMove 的清单发布要读 root_moves[0]
pub fn root_move0() -> u32 {
    ROOT_MOVES.r()[0] as u32
}
