//! 增量模式槽号(④ 增量评估)—— src/zig/inc.zig 生产路径的移植。
//! 训练专用的验证驱动(dfsCheck / randomMidgame / undoMoveUpdate)不搬:
//! 本 crate 只做推理,训练仍在 zig 侧。
//!
//! 核心是**固定帧属方视角**:slots[i] = 第 i 张表在"帧属方是行棋方"口径下的
//! 全局槽号。帧属方 = 根行棋方。落子只动落点与翻子格(其余格子真的不动),
//! 虚着一格不变只翻行棋方记账;行棋方视角求值 = (行棋方是帧属方 ? +1 : −1)
//! × Σ wt[帧属方视角槽] —— 符号精确性依据折叠对称性 W(换色·s) = −W(s)。

use crate::pattern::{self, PTN_COUNT};
use crate::rules::Board;
use crate::{uv, ur, uvw, G};

/// 每格 → 4 组 (表号 0-based, 3^位序)。格子恰被 4 张表覆盖(256 = 64×4)
static CELL_PTN: G<[[u8; 4]; 64]> = G::new([[0; 4]; 64]);
static CELL_POW: G<[[u32; 4]; 64]> = G::new([[0; 4]; 64]);
static TABLES_READY: G<bool> = G::new(false);

/// 从 pattern 的表几何派生每格特征表(必须先于一切增量操作;幂等)
pub fn init_tables() {
    let m = pattern::model_ref();
    for sq in 0..64usize {
        let mut n: usize = 0;
        for p in 1..PTN_COUNT + 1 {
            for k in 0..m.len[p] as usize {
                if m.cells[m.cell_off[p] as usize + k] as usize != sq {
                    continue;
                }
                CELL_PTN.w()[sq][n] = (p - 1) as u8; // slots[] 是 0-based
                let mut w: u32 = 1;
                for _ in 0..k {
                    w *= 3;
                }
                CELL_POW.w()[sq][n] = w;
                n += 1;
            }
        }
        if n != 4 {
            return; // 每格特征数不是 4:几何被改坏,表保持未就绪(pattern::init 的哨兵会先报)
        }
    }
    *TABLES_READY.w() = true;
}

#[inline]
pub fn ensure_tables() {
    if !TABLES_READY.r0() {
        init_tables();
    }
}

/// 增量槽号状态(帧属方视角)
#[derive(Copy, Clone)]
pub struct State {
    pub slots: [u32; PTN_COUNT],
    pub discs: u32,           // 子数记账,只喂 phaseOf
    pub home_to_move: bool,   // 行棋方是否为帧属方:符号位的全部成本
}

impl State {
    pub const fn new() -> State {
        State { slots: [0; PTN_COUNT], discs: 0, home_to_move: true }
    }
}

/// 全量重算(开局 / 根重置走这里)
pub fn set(b: Board, home_to_move: bool, s: &mut State) {
    let (black, white) = if home_to_move { (b.own, b.opp) } else { (b.opp, b.own) };
    pattern::slot_indices(Board { own: black, opp: white }, &mut s.slots);
    s.discs = b.discs();
    s.home_to_move = home_to_move;
}

/// 落子增量(固定帧属方视角):
///   落点:空 → 帧属方 +1w / 空 → 对方 +2w;翻子格:颜色互换 ±1w
pub fn move_update(s: &mut State, sq: u32, f: u64, by_home: bool) {
    add_cell(s, sq, if by_home { 1 } else { 2 });
    let fd: i32 = if by_home { -1 } else { 1 }; // 落属方翻对方(2→1)为负
    let mut ff = f;
    while ff != 0 {
        let c = ff.trailing_zeros();
        ff &= ff - 1;
        add_cell(s, c, fd);
    }
    s.discs += 1;
    s.home_to_move = !by_home;
}

/// 虚着:棋盘一格不变,只流行棋方翻转
#[inline]
pub fn pass_flip(s: &mut State) {
    s.home_to_move = !s.home_to_move;
}

#[inline]
fn add_cell(s: &mut State, sq: u32, d: i32) {
    // 免检:sq < 64(位板尾零),cell_* 表的每格恰 4 条、表号 < 38
    let row = unsafe { uv(CELL_PTN.r(), sq as usize) }; // [u8; 4]
    let pow = unsafe { uv(CELL_POW.r(), sq as usize) }; // [u32; 4]
    for k in 0..4 {
        let idx = row[k] as usize;
        let v = unsafe { uv(&s.slots, idx) } as i64 + d as i64 * pow[k] as i64;
        unsafe { uvw(&mut s.slots, idx, v as u32) };
    }
}

/// 增量状态的整数加权和(**行棋方视角**)—— 叶子求值的全部成本:
/// 38 次查表求和 + 按帧属方取号
#[inline]
pub fn sum_int(s: &State) -> i32 {
    let tab = unsafe { ur(pattern::wt_ref(), pattern::phase_of(s.discs)) };
    let mut sum: i32 = 0;
    for i in 0..PTN_COUNT {
        sum += unsafe { uv(tab, uv(&s.slots, i) as usize) } as i32;
    }
    if s.home_to_move {
        sum
    } else {
        -sum
    }
}
