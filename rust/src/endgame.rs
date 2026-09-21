//! 残局尾部专用路径:≤7 空快速搜索 + last1~4 逐空格专用函数。
//! src/zig/endgame.zig 的移植 —— 思想对齐 Egaroucid 的 nega_alpha_end_fast /
//! last1..last4:跳过通用节点流程(TT/排序),只剩"生成翻子 → 递归";
//! last4/last3 按象限奇偶排序空格;last1 直接读盘算终局分。
//!
//! 正确性契约:全部函数返回**行棋方视角**的精确子差;预算照守(每个入口都
//! 计 nodes 并检查 node_limit,aborted 即返回 —— engineExact() 会因 aborted 报 0)。

use crate::rules::{self, Board};
use crate::search;
use crate::stability;

/// ≤ N 空走快速路径(Egaroucid END_FAST_DEPTH 同款)
pub const END_FAST_EMPTIES: u32 = 7;

const INF: f32 = 1e30;

// ── 象限奇偶:4×4 象限,先走奇象限把对手的着法选择压到最少 ──

const QMASK: [u64; 4] = [
    0x0000_0000_0F0F_0F0F, // 行 0-3,列 0-3
    0x0000_0000_F0F0_F0F0, // 行 0-3,列 4-7
    0x0F0F_0F0F_0000_0000, // 行 4-7,列 0-3
    0xF0F0_F0F0_0000_0000, // 行 4-7,列 4-7
];

#[inline]
fn quad_of(sq: u32) -> u32 {
    // 行 ≥4 → bit1,列 ≥4 → bit0
    (((sq >> 5) & 1) << 1) | ((sq >> 2) & 1)
}

/// 每象限空格数的奇偶位
#[inline]
fn parity_of(empty: u64) -> u32 {
    let mut par: u32 = 0;
    for (i, &q) in QMASK.iter().enumerate() {
        if (empty & q).count_ones() & 1 != 0 {
            par |= 1 << i;
        }
    }
    par
}

// ── 记账(tick 撞 search 的全局 nodes/node_limit/aborted)──

#[inline]
fn tick() -> bool {
    // 与 zig 相同:search.nodes += 1,超限置 aborted
    let n = search::nodes() + 1;
    search::set_nodes(n);
    if search::node_limit() != 0 && n > search::node_limit() {
        search::set_aborted();
        return false;
    }
    true
}

#[inline]
fn terminal(b: Board) -> f32 {
    b.diff() as f32
}

#[inline]
fn is_aborted() -> bool {
    search::aborted()
}

/// 空格按象限奇偶排序(奇象限优先)。n ≤ 5,插入排序足够
fn order_cells(cells: &mut [u32], empty: u64) {
    let par = parity_of(empty);
    for i in 1..cells.len() {
        let cur = cells[i];
        let cur_odd = (par >> quad_of(cur)) & 1;
        let mut j = i;
        while j > 0 && ((par >> quad_of(cells[j - 1])) & 1) < cur_odd {
            cells[j] = cells[j - 1];
            j -= 1;
        }
        cells[j] = cur;
    }
}

// ── last1~4 ──────────────────────────────────────────────────────────────

/// 最后 1 空:直接算终局分。base = 64 − 2·对方子数(落子后满盘的点差基量)
fn last1(b: Board, p0: u32) -> f32 {
    if !tick() {
        return 0.0;
    }
    let base = (64 - 2 * b.opp.count_ones() as i32) as f32;
    let f = rules::flips(b, p0);
    if f != 0 {
        return base + 2.0 * f.count_ones() as f32;
    }
    // 我方翻不动 → 虚着,对方落最后一格
    let sw = b.swapped();
    let nf2 = rules::flips(sw, p0).count_ones();
    if nf2 > 0 {
        return base - 2.0 - 2.0 * nf2 as f32;
    }
    base - 1.0 // 双方都无棋:终局,空格留着
}

fn last2(b: Board, alpha_in: f32, beta: f32, p0: u32, p1: u32, skipped: bool) -> f32 {
    if !tick() {
        return 0.0;
    }
    let mut alpha = alpha_in;
    let mut v: f32 = -INF;
    let f0 = rules::flips(b, p0);
    if f0 != 0 {
        let g = -last1(rules::play_move(b, p0, f0), p1);
        if g > v {
            v = g;
        }
        if g > alpha {
            alpha = g;
        }
        if alpha >= beta {
            return v;
        }
    }
    let f1 = rules::flips(b, p1);
    if f1 != 0 {
        let g = -last1(rules::play_move(b, p1, f1), p0);
        if g > v {
            v = g;
        }
        if g > alpha {
            alpha = g;
        }
    }
    if v == -INF {
        if skipped {
            return terminal(b);
        }
        let sw = b.swapped();
        return -last2(sw, -beta, -alpha, p0, p1, true);
    }
    v
}

fn last3(b: Board, alpha_in: f32, beta: f32, cells: [u32; 3], skipped: bool) -> f32 {
    if !tick() {
        return 0.0;
    }
    let mut cs = cells;
    order_cells(&mut cs, b.empty());
    let mut alpha = alpha_in;
    let mut v: f32 = -INF;
    for i in 0..3 {
        let p = cs[i];
        let f = rules::flips(b, p);
        if f != 0 {
            let rest = [cs[(i + 1) % 3], cs[(i + 2) % 3]];
            let g = -last2(rules::play_move(b, p, f), -beta, -alpha, rest[0], rest[1], false);
            if g > v {
                v = g;
            }
            if g > alpha {
                alpha = g;
            }
            if alpha >= beta {
                return v;
            }
        }
    }
    if v == -INF {
        if skipped {
            return terminal(b);
        }
        let sw = b.swapped();
        return -last3(sw, -beta, -alpha, cells, true);
    }
    v
}

fn last4(b: Board, alpha_in: f32, beta_in: f32, cells: [u32; 4], skipped: bool) -> f32 {
    if !tick() {
        return 0.0;
    }
    // 稳定子剪枝(Egaroucid last4 同款)
    let cut = stability::cut(b, alpha_in, beta_in);
    if let Some(vv) = cut.value {
        return vv;
    }
    let mut alpha = cut.alpha;
    let beta = cut.beta;
    let mut cs = cells;
    order_cells(&mut cs, b.empty());
    let mut v: f32 = -INF;
    for i in 0..4 {
        let p = cs[i];
        let f = rules::flips(b, p);
        if f != 0 {
            let mut rest = [0u32; 3];
            let mut k = 0usize;
            for jj in 0..4 {
                if jj != i {
                    rest[k] = cs[jj];
                    k += 1;
                }
            }
            let g = -last3(rules::play_move(b, p, f), -beta, -alpha, rest, false);
            if g > v {
                v = g;
            }
            if g > alpha {
                alpha = g;
            }
            if alpha >= beta {
                return v;
            }
        }
        if is_aborted() {
            return v;
        }
    }
    if v == -INF {
        if skipped {
            return terminal(b);
        }
        let sw = b.swapped();
        return -last4(sw, -beta, -alpha, cells, true);
    }
    v
}

// ── ≤7 空快速路径 ────────────────────────────────────────────────────────

/// 从 search() 的 exact 分支派发进来。空格数 5..7;5 空时落子后进 last4
pub fn end_fast(b: Board, alpha_in: f32, beta_in: f32, skipped: bool) -> f32 {
    if !tick() {
        return 0.0;
    }
    let cut = stability::cut(b, alpha_in, beta_in);
    if let Some(vv) = cut.value {
        return vv;
    }
    let mut alpha = cut.alpha;
    let beta = cut.beta;

    let empty = b.empty();
    let em = empty.count_ones();

    if em == 5 {
        // 落子后剩 4 空 → last4。着法按象限奇偶排序
        let mut cs = [0u32; 5];
        let mut n = 0usize;
        let mut mm = empty;
        while mm != 0 {
            cs[n] = mm.trailing_zeros();
            mm &= mm - 1;
            n += 1;
        }
        order_cells(&mut cs, empty);
        let mut v: f32 = -INF;
        for i in 0..5 {
            let p = cs[i];
            let f = rules::flips(b, p);
            if f != 0 {
                let mut rest = [0u32; 4];
                let mut k = 0usize;
                for jj in 0..5 {
                    if jj != i {
                        rest[k] = cs[jj];
                        k += 1;
                    }
                }
                let g = -last4(rules::play_move(b, p, f), -beta, -alpha, rest, false);
                if g > v {
                    v = g;
                }
                if g > alpha {
                    alpha = g;
                }
                if alpha >= beta {
                    return v;
                }
            }
            if is_aborted() {
                return v;
            }
        }
        if v == -INF {
            if skipped {
                return terminal(b);
            }
            let sw = b.swapped();
            return -end_fast(sw, -beta, -alpha, true);
        }
        return v;
    }

    // 6/7 空:象限奇偶分流 —— 先试奇象限的着法
    let par = parity_of(empty);
    let mut v: f32 = -INF;
    for round in 0..2 {
        let want_odd = round; // 第 0 轮奇象限,第 1 轮偶象限
        let mut mm = empty;
        while mm != 0 {
            let sq = mm.trailing_zeros();
            mm &= mm - 1;
            if ((par >> quad_of(sq)) & 1) as u32 != want_odd {
                continue;
            }
            let f = rules::flips(b, sq);
            if f == 0 {
                continue;
            }
            let g = -end_fast(rules::play_move(b, sq, f), -beta, -alpha, false);
            if g > v {
                v = g;
            }
            if g > alpha {
                alpha = g;
            }
            if alpha >= beta {
                return v;
            }
            if is_aborted() {
                return v;
            }
        }
    }
    if v == -INF {
        if skipped {
            return terminal(b);
        }
        let sw = b.swapped();
        return -end_fast(sw, -beta, -alpha, true);
    }
    v
}
