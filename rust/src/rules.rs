//! 黑白棋位棋盘规则核心(u64 双位板)—— src/zig/rules.zig 的逐句移植。
//!
//! 表示:own / opp 各一个 u64,bit 编号 = row*8 + col(row 0 在上、col 0 在左)。
//! 不用哨兵边框:环绕完全靠方向掩码挡住。方向掩码的来历见 zig 侧注释 ——
//! 向右的移动必须先清 FILE_H,否则最右列会绕到下一行最左列;向左同理。
//!
//! 本 crate 是 no_std wasm,不分配、不依赖任何导入 —— 与 zig 的 freestanding
//! 约束一致(probe-wasm A 节会检查 import 数 = 0)。

pub const FILE_A: u64 = 0x0101_0101_0101_0101;
pub const FILE_H: u64 = 0x8080_8080_8080_8080;
pub const FULL: u64 = !0u64;

/// 棋盘状态。own 是"轮到走的那一方"的棋子(相对方视角,不固定黑白)。
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub struct Board {
    pub own: u64,
    pub opp: u64,
}

impl Board {
    /// 初始四子:黑(先手)= d5(35)、e4(28);白 = d4(27)、e5(36)
    pub const fn initial() -> Board {
        Board { own: (1u64 << 35) | (1u64 << 28), opp: (1u64 << 27) | (1u64 << 36) }
    }
    #[inline]
    pub fn empty(&self) -> u64 {
        !(self.own | self.opp)
    }
    #[inline]
    pub fn occupied(&self) -> u64 {
        self.own | self.opp
    }
    #[inline]
    pub fn discs(&self) -> u32 {
        (self.own | self.opp).count_ones()
    }
    /// 子差(own 视角),终局打分用
    #[inline]
    pub fn diff(&self) -> i32 {
        self.own.count_ones() as i32 - self.opp.count_ones() as i32
    }
    #[inline]
    pub fn swapped(&self) -> Board {
        Board { own: self.opp, opp: self.own }
    }
}

#[derive(Copy, Clone)]
pub struct Dir {
    pub mask: u64,
    pub amt: u32,
    pub left: bool,
}

impl Dir {
    #[inline]
    pub fn step(&self, x: u64) -> u64 {
        let y = x & self.mask;
        if self.left {
            y << self.amt
        } else {
            y >> self.amt
        }
    }
}

const fn dir_of(dr: i32, dc: i32) -> Dir {
    let delta: i32 = dr * 8 + dc;
    let mask: u64 = if dc > 0 {
        !FILE_H
    } else if dc < 0 {
        !FILE_A
    } else {
        FULL
    };
    Dir { mask, amt: (if delta < 0 { -delta } else { delta }) as u32, left: delta > 0 }
}

/// 方向表(与 zig SPECS 同序:N S W E NW NE SW SE)
pub const DIRS: [Dir; 8] = [
    dir_of(-1, 0),
    dir_of(1, 0),
    dir_of(0, -1),
    dir_of(0, 1),
    dir_of(-1, -1),
    dir_of(-1, 1),
    dir_of(1, -1),
    dir_of(1, 1),
];

/// 单方向"从己方子出发、越过一串对方子、落到空位"的落点累加。
/// 连做 6 次:夹翻最多跨 6 个对方子(8 格去掉两端)。
#[inline]
fn slide(d: &Dir, own: u64, opp: u64, empty: u64) -> u64 {
    let mut t = d.step(own) & opp;
    t |= d.step(t) & opp;
    t |= d.step(t) & opp;
    t |= d.step(t) & opp;
    t |= d.step(t) & opp;
    t |= d.step(t) & opp;
    d.step(t) & empty
}

/// 合法落点集合(任一方向夹得住即可)
#[inline]
pub fn moves(b: Board) -> u64 {
    let empty = b.empty();
    let mut m: u64 = 0;
    for d in DIRS.iter() {
        m |= slide(d, b.own, b.opp, empty);
    }
    m
}

/// 在 sq 落子能夹翻的所有对方子;该方向夹不住时对应位为 0
#[inline]
pub fn flips(b: Board, sq: u32) -> u64 {
    let bit = 1u64 << sq;
    let mut f: u64 = 0;
    for d in DIRS.iter() {
        let mut run: u64 = 0;
        let mut t = d.step(bit);
        let mut k = 0u32;
        while k < 6 && (t & b.opp) != 0 {
            run |= t;
            t = d.step(t);
            k += 1;
        }
        if (t & b.own) != 0 {
            f |= run;
        }
    }
    f
}

/// 落子并翻转,然后换边。要求 sq 是合法着法
#[inline]
pub fn play(b: Board, sq: u32) -> Board {
    play_move(b, sq, flips(b, sq))
}

/// 翻子掩码已经算好时的落子(搜索里着法排序阶段就顺手算过,别再算一遍)
#[inline]
pub fn play_move(b: Board, sq: u32, f: u64) -> Board {
    let bit = 1u64 << sq;
    Board { own: b.opp & !f, opp: b.own | f | bit }
}

/// 落子但不换边(逐层展开同一方连续走子时用)
#[inline]
pub fn play_same(b: Board, sq: u32) -> Board {
    let bit = 1u64 << sq;
    let f = flips(b, sq);
    Board { own: b.own | f | bit, opp: b.opp & !f }
}

/// 撤销:把 sq 上的己方子拿掉、把 f 还回己方(b 是落子之后的状态)
#[inline]
pub fn undo_play(b: Board, sq: u32, f: u64) -> Board {
    let bit = 1u64 << sq;
    Board { own: b.own & !bit & !f, opp: b.opp | f }
}

#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub enum Status {
    Ok,
    Pass,
    Over,
}

/// 走一步并处理"对方无棋可走"(probe/训练用的完整语义;搜索内联处理虚着)
pub fn step(b: Board, sq: u32) -> (Board, Status) {
    let nb = play(b, sq);
    if moves(nb) != 0 {
        return (nb, Status::Ok);
    }
    let swapped = nb.swapped();
    if moves(swapped) != 0 {
        return (swapped, Status::Pass);
    }
    (nb, Status::Over)
}

/// 当前一方是否无棋可走
#[inline]
pub fn must_pass(b: Board) -> bool {
    moves(b) == 0
}

/// 逐层展开所有合法着法的节点数。pass 会消耗一层深度。
/// 规则改动的唯一闸门 —— 数值都是公开的标准值。
pub fn perft(b: Board, depth: u32) -> u64 {
    if depth == 0 {
        return 1;
    }
    let m = moves(b);
    if m == 0 {
        if moves(b.swapped()) == 0 {
            return 1;
        }
        return perft(b.swapped(), depth - 1);
    }
    let mut n: u64 = 0;
    let mut mm = m;
    while mm != 0 {
        let sq = mm.trailing_zeros();
        mm &= mm - 1;
        let f = flips(b, sq);
        n += perft(Board { own: b.opp & !f, opp: b.own | f | (1u64 << sq) }, depth - 1);
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn perft_initial() {
        assert_eq!(moves(Board::initial()).count_ones(), 4);
        assert_eq!(perft(Board::initial(), 1), 4);
        assert_eq!(perft(Board::initial(), 2), 12);
        assert_eq!(perft(Board::initial(), 3), 56);
        assert_eq!(perft(Board::initial(), 4), 244);
        assert_eq!(perft(Board::initial(), 5), 1396);
        assert_eq!(perft(Board::initial(), 6), 8200);
        assert_eq!(perft(Board::initial(), 7), 55092);
        assert_eq!(perft(Board::initial(), 8), 390216);
    }

    #[test]
    fn initial_moves_are_d3_c4_f5_e6() {
        assert_eq!(moves(Board::initial()), (1u64 << 19) | (1u64 << 26) | (1u64 << 37) | (1u64 << 44));
    }

    #[test]
    fn play_conserves_discs() {
        let b = Board::initial();
        let mut mm = moves(b);
        while mm != 0 {
            let sq = mm.trailing_zeros();
            mm &= mm - 1;
            let nb = play(b, sq);
            assert_eq!(b.discs() + 1, nb.discs());
            // play 后已换边:nb.opp 是落子方
            assert_eq!(b.own.count_ones() + flips(b, sq).count_ones() + 1, nb.opp.count_ones());
        }
    }

    #[test]
    fn undo_round_trip() {
        let b = Board::initial();
        let mut mm = moves(b);
        while mm != 0 {
            let sq = mm.trailing_zeros();
            mm &= mm - 1;
            let f = flips(b, sq);
            let nb = play_same(b, sq);
            let back = undo_play(nb, sq, f);
            assert_eq!(b, back);
        }
    }
}
