//! 稳定子(stable discs)计算与残局剪枝 —— src/zig/stability.zig 的移植。
//!
//! 三层近似(只少报不多报,少报是安全方向):
//!   1. 边表:四条边线上的稳定性精确按线计算,256×256 组合 init 时推平;
//!   2. 全满行/列(逐字节判满)+ 全满对角线(popcount 判满):只作闭包生长支持;
//!   3. 闭包:穿过它的每条线上都有一枚已稳定同色邻居(或该线全满)⇒ 稳定,
//!      迭代到不动点。
//! 稳定子给出点差硬下界:diff ≥ 2·stab_own − 64,完全求解里用它收紧窗口。
//!
//! 边表 + 记忆化(各 64KB/128KB)在 init 生成,住静态区 —— comptime/数据段物化
//! 会把 wasm 撑爆(zig 侧实测 1MB+ 的教训)。

use crate::rules::Board;
use crate::G;

static EDGE_H: G<[[u64; 256]; 256]> = G::new([[0; 256]; 256]); // 稳定子摊在 bit 0..7(第 0 行)
static EDGE_V: G<[[u64; 256]; 256]> = G::new([[0; 256]; 256]); // 稳定子摊在第 0 列
static MEMO: G<[[u8; 256]; 256]> = G::new([[0; 256]; 256]);
static KNOWN: G<[[u8; 256]; 256]> = G::new([[0; 256]; 256]);
static READY: G<bool> = G::new(false);

/// NWS 稳定子剪枝门槛(按空位数):alpha 低于门槛时不值得花一次稳定性计算。
/// edax 同源的经验表;99 = 永不。
const NWS_THRESHOLD: [u8; 61] = [
    99, 99, 99, 4, 6, 8, 10, 12, 14, 16, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46,
    48, 48, 50, 50, 52, 52, 54, 54, 56, 56, 58, 58, 60, 60, 62, 62, 64, 64, 64, 64, 64, 64, 64,
    64, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

/// 单线模拟:owner 在 place 落子后的新局面(只处理这条线)。
fn probably_move_line(p: u8, o: u8, place: u32, np: &mut u8, no: &mut u8) {
    *np = p | (1u8 << place);
    // 向左:连续对方子走到头,尽头是己方子才翻得动
    let mut i: i32 = place as i32 - 1;
    while i >= 0 && (o >> i as u32) & 1 != 0 {
        i -= 1;
    }
    if i >= 0 && (p >> i as u32) & 1 != 0 {
        let mut j: i32 = place as i32 - 1;
        while j > i {
            *np ^= 1u8 << j as u32;
            j -= 1;
        }
    }
    let mut i: i32 = place as i32 + 1;
    while i <= 7 && (o >> i as u32) & 1 != 0 {
        i += 1;
    }
    if i <= 7 && (p >> i as u32) & 1 != 0 {
        let mut j: i32 = place as i32 + 1;
        while j < i {
            *np ^= 1u8 << j as u32;
            j += 1;
        }
    }
    *no = o & !*np;
}

/// 一条线上的精确稳定子:双方轮流把每个空格试着走一遍取交集(带记忆化)
fn calc_stability_line(b: u8, w: u8) -> u8 {
    if KNOWN.r()[b as usize][w as usize] != 0 {
        return MEMO.r()[b as usize][w as usize];
    }
    let mut res: u8 = b | w;
    let empties: u8 = !(b | w);
    for i in 0..8 {
        if (empties >> i) & 1 != 0 {
            let mut nb: u8 = 0;
            let mut nw: u8 = 0;
            probably_move_line(b, w, i, &mut nb, &mut nw);
            res &= b | nw;
            res &= calc_stability_line(nb, nw);
            probably_move_line(w, b, i, &mut nw, &mut nb);
            res &= w | nb;
            res &= calc_stability_line(nb, nw);
        }
    }
    MEMO.w()[b as usize][w as usize] = res;
    KNOWN.w()[b as usize][w as usize] = 1;
    res
}

/// 生成边表(幂等)
pub fn ensure_init() {
    if READY.r0() {
        return;
    }
    for row in KNOWN.w().iter_mut() {
        row.fill(0);
    }
    for b in 0..256u32 {
        for w in 0..256u32 {
            if b & w != 0 {
                // 同格双占,非法线型:稳定子为空(永远不该被查到)
                EDGE_H.w()[b as usize][w as usize] = 0;
                EDGE_V.w()[b as usize][w as usize] = 0;
                MEMO.w()[b as usize][w as usize] = 0;
                KNOWN.w()[b as usize][w as usize] = 1;
                continue;
            }
            let stab = calc_stability_line(b as u8, w as u8);
            let mut hb: u64 = 0;
            let mut vb: u64 = 0;
            for i in 0..8 {
                if (stab >> i) & 1 != 0 {
                    hb |= 1u64 << i;
                    vb |= 1u64 << (8 * i);
                }
            }
            EDGE_H.w()[b as usize][w as usize] = hb;
            EDGE_V.w()[b as usize][w as usize] = vb;
        }
    }
    *READY.w() = true;
}

// ── 全满行/列:逐字节判满(不用移位多项式 —— 跨行边界的幻影会多报)──

fn full_stab_h(occ: u64) -> u64 {
    let mut h: u64 = 0;
    for r in 0..8 {
        if (occ >> (8 * r)) & 0xFF == 0xFF {
            h |= 0xFFu64 << (8 * r);
        }
    }
    h
}

/// 提取一条边线的 8bit 线型(逐位收集,不用转置乘法 —— 第 7 列会丢位/串位)
#[inline]
fn col_byte(x: u64, col: u32) -> u8 {
    let mut b: u8 = 0;
    for r in 0..8 {
        b |= (((x >> (col + 8 * r)) & 1) as u8) << r;
    }
    b
}

fn full_stab_v(occ: u64) -> u64 {
    let mut v: u64 = 0;
    for c in 0..8 {
        if col_byte(occ, c) == 0xFF {
            v |= 0x0101_0101_0101_0101u64 << c;
        }
    }
    v
}

// ── 全满对角线:popcount 判满版(掩码 + popcount,避免移位幻影)──

const fn diag_rc() -> [u64; 15] {
    // r − c = d(d ∈ [-7,7])
    let mut m = [0u64; 15];
    let mut k = 0usize;
    while k < 15 {
        let d = k as i32 - 7;
        let mut bits: u64 = 0;
        let mut r: i32 = if d > 0 { d } else { 0 };
        let top: i32 = if 7 < 7 + d { 7 } else { 7 + d };
        while r <= top {
            bits |= 1u64 << ((r * 8 + (r - d)) as u32);
            r += 1;
        }
        m[k] = bits;
        k += 1;
    }
    m
}
const fn diag_rs() -> [u64; 15] {
    // r + c = s(s ∈ [0,14]);行上限 min(7, s) —— s > 7 时只到第 7 行
    let mut m = [0u64; 15];
    let mut k = 0usize;
    while k < 15 {
        let s = k as i32;
        let mut bits: u64 = 0;
        let mut r: i32 = if s - 7 > 0 { s - 7 } else { 0 };
        let top: i32 = if s < 7 { s } else { 7 };
        while r <= top {
            bits |= 1u64 << ((r * 8 + (s - r)) as u32);
            r += 1;
        }
        m[k] = bits;
        k += 1;
    }
    m
}
const DIAG_RC: [u64; 15] = diag_rc();
const DIAG_RS: [u64; 15] = diag_rs();

fn full_stab_diag(occ: u64, masks: &[u64; 15]) -> u64 {
    let mut out: u64 = 0;
    for &m in masks.iter() {
        // 线长 = popCount(m);全占 ⇔ occ 覆盖整条掩码
        if (occ & m).count_ones() == m.count_ones() {
            out |= m;
        }
    }
    out
}

/// 6×6 内部格掩码:全满线种子只用于内部格(边格由边表精确覆盖)
const INTERIOR: u64 = 0x0000_007E_7E7E_7E7E;

#[derive(Copy, Clone)]
struct FullLines {
    h: u64,
    v: u64,
    d7: u64,
    d9: u64,
}

fn closure_of(discs: u64, edge_stab: u64, full: FullLines) -> u64 {
    // 种子只放边表(全满行/列不能直接当种子 —— 沿对角线仍可能被翻;
    // 全满线作为生长支持是可靠的:线满 ⇒ 该线方向支撑条件无条件满足)
    let mut acc: u64 = edge_stab & discs;
    loop {
        let grown = ((acc >> 1) | (acc << 1) | full.h)
            & ((acc >> 8) | (acc << 8) | full.v)
            & ((acc >> 7) | (acc << 7) | full.d7)
            & ((acc >> 9) | (acc << 9) | full.d9)
            & discs
            & INTERIOR;
        let next = acc | grown;
        if next == acc {
            break;
        }
        acc = next;
    }
    acc
}

#[inline]
fn row_byte(x: u64, row: u32) -> u8 {
    (x >> (row * 8)) as u8
}

/// 双方稳定子计数(一次调用算两色 —— 全满线/边表只跑一遍,闭包各跑各的)
pub fn stable_counts(b: Board) -> (u32, u32) {
    let occ = b.own | b.opp;
    let full = FullLines {
        h: full_stab_h(occ),
        v: full_stab_v(occ),
        d7: full_stab_diag(occ, &DIAG_RS),
        d9: full_stab_diag(occ, &DIAG_RC),
    };
    // 四条边的稳定子合到一张位板上
    let eb = EDGE_H.r()[row_byte(b.own, 0) as usize][row_byte(b.opp, 0) as usize]
        | EDGE_H.r()[row_byte(b.own, 7) as usize][row_byte(b.opp, 7) as usize] << 56
        | EDGE_V.r()[col_byte(b.own, 0) as usize][col_byte(b.opp, 0) as usize]
        | EDGE_V.r()[col_byte(b.own, 7) as usize][col_byte(b.opp, 7) as usize] << 7;
    let so = closure_of(b.own, eb, full);
    let sp = closure_of(b.opp, eb, full);
    (so.count_ones(), sp.count_ones())
}

/// 稳定子剪枝的结果:value = Some ⇒ 窗口可直接判值;否则 alpha/beta 是收紧后的窗口
pub struct CutOutcome {
    pub value: Option<f32>,
    pub alpha: f32,
    pub beta: f32,
}

/// 稳定子剪枝入口(只许在 exact 搜索里调用 —— 界是子差意义的)
pub fn cut(b: Board, alpha_in: f32, beta_in: f32) -> CutOutcome {
    let empties = 64 - b.discs();
    let th = NWS_THRESHOLD[empties as usize] as f32;
    let alpha = alpha_in;
    let beta = beta_in;
    if alpha < th {
        return CutOutcome { value: None, alpha, beta };
    }
    let (own, opp) = stable_counts(b);
    let n_alpha = 2.0 * own as f32 - 64.0;
    let n_beta = 64.0 - 2.0 * opp as f32;
    if beta <= n_alpha {
        return CutOutcome { value: Some(n_alpha), alpha, beta };
    }
    if n_beta <= alpha {
        return CutOutcome { value: Some(n_beta), alpha, beta };
    }
    if n_beta <= n_alpha {
        return CutOutcome { value: Some(n_alpha), alpha, beta };
    }
    CutOutcome { value: None, alpha: alpha.max(n_alpha), beta: beta.min(n_beta) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::Board;

    #[test]
    fn line_stability_basics() {
        ensure_init();
        // 只有中心一枚己方子:两侧全空 ⇒ 不稳
        assert_eq!(calc_stability_line(0b0000_1000, 0), 0);
        // 满线:每个子都稳定
        assert_eq!(calc_stability_line(0b1100_0011, 0b0011_1100), 0xFF);
        // 角端两连子(bit0,1):全稳
        assert_eq!(calc_stability_line(0b0000_0011, 0), 0b11);
    }

    #[test]
    fn stable_counts_sanity() {
        ensure_init();
        let sc = stable_counts(Board::initial());
        assert_eq!(sc, (0, 0)); // 初始局面没有边子
        // a1 角 + 一整条满底边,对方两枚孤子
        let b = Board { own: 1 | (0xFFu64 << 56), opp: (1u64 << 19) | (1u64 << 36) };
        let (own, opp) = stable_counts(b);
        assert!(own >= 9);
        assert_eq!(opp, 0);
    }
}
