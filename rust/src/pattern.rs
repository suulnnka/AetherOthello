//! 38 张模式表的几何 + 16 元对称折叠 + int8 权重查表 —— src/zig/pattern.zig 的移植。
//!
//! 与 zig 的一处实现差异:那边 model / act / cands 是 comptime 物化,这边在
//! pattern::init() 里先跑一遍 geometry_init()(纯表生成,毫秒级),产物同样住在
//! 静态区。轨道图(每槽 → 轨道号)依旧**不在二进制里携带**,init 时算出来 ——
//! 那张 u16 映射表 268 KB,带了体积就爆。
//!
//! 权重书(weights.bin)与开局书(book-openings.bin)**原样复用**,格式一字不改:
//!   [0..4) u32 magic  [4] u8 version  [5] u8 phases  [6..8) 保留
//!   [8..12) u32 orbits  [12..12+4×phases) 每相位一个 f32 scale
//!   之后 3 × 9,475 字节 int8 轨道权重
//!
//! 槽号/轨道/符号语义见 zig 侧头注(16 元群 D4 × C2,换色 → 符号取反;
//! 轨道内取槽号最小者为代表,同一最小槽号既有 +1 又有 −1 达成者被制 0)。

use crate::rules::Board;
use crate::{uv, ur, G};

pub const PTN_COUNT: usize = 38;
/// 相位数:按子数均分 60 手(SPAN = 60/PHASES)。**必须与训练时一致**(3 档)。
pub const PHASES: usize = 3;
const SPAN: u32 = 60 / PHASES as u32;
pub const PER_PHASE: usize = 133_974;
pub const ORBITS: usize = 9_475;

pub const BLOB_VERSION: u8 = 3;
pub const BLOB_MAGIC: u32 = 0x4F54_484C; // 'OTHL'
pub const BLOB_HEADER: usize = 12 + 4 * PHASES;

const POW3: [u32; 9] = [1, 3, 9, 27, 81, 243, 729, 2187, 6561];

/// i+j(∈2..16)或 9+i-j(∈2..16)→ 斜线表序号 1..11(下标 0/1 占位,照抄上游 1-based)
const XY2PTN: [u8; 17] = [0, 0, 1, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 11, 11];

fn belongs(p: usize, i: usize, j: usize) -> bool {
    if p <= 8 {
        i == p - 1
    } else if p <= 16 {
        j == p - 9
    } else if p <= 27 {
        XY2PTN[i + j + 2] as usize == p - 16
    } else {
        XY2PTN[9 + i - j] as usize == p - 27
    }
}

/// 8 个几何操作(0-based 行列);顺序与 tools/oracle-fold.mjs 的 GEO 一致
fn geo_pt(t: usize, r: usize, c: usize) -> (usize, usize) {
    match t {
        0 => (r, c),
        1 => (c, 7 - r),
        2 => (7 - r, 7 - c),
        3 => (7 - c, r),
        4 => (c, r),
        5 => (7 - c, 7 - r),
        6 => (7 - r, c),
        _ => (r, 7 - c),
    }
}

#[derive(Copy, Clone)]
pub struct Model {
    pub len: [u8; PTN_COUNT + 1],
    pub tri: [u32; PTN_COUNT + 1], // 3^len,即该表的槽数
    pub cell_off: [u16; PTN_COUNT + 1],
    pub slot_off: [u32; PTN_COUNT + 1],
    pub cells: [u8; 256],
    pub total: u32,
}

impl Model {
    const fn zero() -> Model {
        Model { len: [0; PTN_COUNT + 1], tri: [0; PTN_COUNT + 1], cell_off: [0; PTN_COUNT + 1], slot_off: [0; PTN_COUNT + 1], cells: [0; 256], total: 0 }
    }
}

#[derive(Copy, Clone)]
pub struct Act {
    pub q: u8,
    pub perm: [u8; 8],
}

#[derive(Copy, Clone)]
struct CandList {
    n: u8,
    items: [u8; 16], // 存 t*2+swap
}

static MODEL: G<Model> = G::new(Model::zero());
static ACT: G<[[Act; PTN_COUNT + 1]; 8]> = G::new([[Act { q: 0, perm: [0; 8] }; PTN_COUNT + 1]; 8]);
static CANDS: G<[CandList; PTN_COUNT + 1]> =
    G::new([CandList { n: 0, items: [0; 16] }; PTN_COUNT + 1]);

/// 表 p 的第 k 个格子在 q 里的位置;不在返回 None
fn cell_index_in(q: usize, sq: u8) -> Option<u8> {
    let m = MODEL.r();
    for k in 0..m.len[q] as usize {
        if m.cells[m.cell_off[q] as usize + k] == sq {
            return Some(k as u8);
        }
    }
    None
}

/// 表几何:zig 里 comptime 算好;这里 init 时一遍生成(幂等)。
/// 返回 false = 几何与预期不符(zig 侧是 comptime 编译错,这里只能运行时报)。
pub fn geometry_init() -> bool {
    let m = MODEL.w();
    let mut co: u16 = 0;
    for p in 1..PTN_COUNT + 1 {
        m.cell_off[p] = co;
        let mut n: u16 = 0;
        // i 外层、j 内层 —— 格子顺序就是 3 进制幂的位序,改了顺序整张表语义就变了
        for i in 0..8usize {
            for j in 0..8usize {
                if belongs(p, i, j) {
                    m.cells[co as usize + n as usize] = (i * 8 + j) as u8;
                    n += 1;
                }
            }
        }
        m.len[p] = n as u8;
        m.tri[p] = POW3[n as usize];
        co += n;
    }
    let mut so: u32 = 0;
    for p in 1..PTN_COUNT + 1 {
        m.slot_off[p] = so;
        so += m.tri[p];
    }
    m.total = so;
    if m.total as usize != PER_PHASE {
        return false; // 槽数与预期不符,模式表几何被改坏了
    }

    // act[t][p]:几何 t 把表 p 映到表 act.q,位序置换 act.perm
    let a = ACT.w();
    for t in 0..8 {
        for p in 1..PTN_COUNT + 1 {
            let len = MODEL.r().len[p] as usize;
            let mut img = [0u8; 8];
            for k in 0..len {
                let sq = MODEL.r().cells[MODEL.r().cell_off[p] as usize + k];
                let (r, c) = geo_pt(t, (sq / 8) as usize, (sq % 8) as usize);
                img[k] = (r * 8 + c) as u8;
            }
            let mut q: u8 = 0;
            for cand in 1..PTN_COUNT + 1 {
                if MODEL.r().len[cand] as usize != len {
                    continue;
                }
                let mut ok = true;
                for k in 0..len {
                    if cell_index_in(cand, img[k]).is_none() {
                        ok = false;
                        break;
                    }
                }
                if ok && q == 0 {
                    q = cand as u8;
                }
            }
            if q == 0 {
                return false; // 模式族在几何操作下不闭合 —— 折叠前提不成立
            }
            let mut perm = [0u8; 8];
            for k in 0..len {
                perm[k] = cell_index_in(q as usize, img[k]).unwrap();
            }
            a[t][p] = Act { q, perm };
        }
    }

    // 每张表的"可减小槽号的群元素"候选表(q > p 的像槽号必然更大,不可能取最小)
    let c = CANDS.w();
    for p in 1..PTN_COUNT + 1 {
        let mut n = 0usize;
        for t in 0..8 {
            if (ACT.r()[t][p].q as usize) > p {
                continue;
            }
            for sw in 0..2 {
                c[p].items[n] = (t * 2 + sw) as u8;
                n += 1;
            }
        }
        c[p].n = n as u8;
    }
    true
}

/// 几何 t + 换色 sw 作用在 (p, idx) 上 → 目标槽号
#[inline]
fn image_slot(t: usize, sw: bool, p: usize, idx: u32) -> u32 {
    let a = &ACT.r()[t][p];
    let len = MODEL.r().len[p] as usize;
    let mut tmp = idx;
    let mut nv: u32 = 0;
    for k in 0..8 {
        if k < len {
            let mut d: u32 = tmp % 3;
            tmp /= 3;
            // 换色:空保持空,黑↔白(1↔2)。空位必须判 d != 0 才取反
            if sw && d != 0 {
                d = 3 - d;
            }
            nv += d * POW3[a.perm[k] as usize];
        }
    }
    MODEL.r().slot_off[a.q as usize] + nv
}

struct Canon {
    slot: u32,
    sign: i8,
    zero: bool,
}

/// 取 16 个像里槽号最小的那个;符号取达成者的符号。
/// 若同一个最小槽号既有 +1 又有 −1 的达成者,该槽被对称性强制作 0。
fn canon_slot(p: usize, idx: u32) -> Canon {
    let mut best: u32 = MODEL.r().slot_off[p] + idx;
    let mut sign: i8 = 1;
    let mut pos = true; // 恒等元本身就是 +1,先记上
    let mut neg = false;
    let cl = CANDS.r()[p];
    for ci in 0..cl.n as usize {
        let e = cl.items[ci] as usize;
        let t = e >> 1;
        let sw = (e & 1) != 0;
        let s2 = image_slot(t, sw, p, idx);
        let sg: i8 = if sw { -1 } else { 1 };
        if s2 < best {
            best = s2;
            sign = sg;
            pos = !sw;
            neg = sw;
        } else if s2 == best {
            if sw {
                neg = true;
            } else {
                pos = true;
            }
        }
    }
    Canon { slot: best, sign, zero: pos && neg }
}

// ─────────────────────── 运行时状态(全部静态,单线程 wasm)────────────

static ORBIT: G<[u16; PER_PHASE]> = G::new([0; PER_PHASE]);
static SIGMA: G<[i8; PER_PHASE]> = G::new([0; PER_PHASE]);
/// 已折入符号的查表:wt[阶段][槽] = sigma · 权重。求值 = 38 次查表 + 求和
static WT: G<[[i8; PER_PHASE]; PHASES]> = G::new([[0; PER_PHASE]; PHASES]);
/// 定标:int8 加权和 → 子数(每相位一个)
static SCALES: G<[f32; PHASES]> = G::new([1.0; PHASES]);
static READY: G<bool> = G::new(false);
/// init 失败在第几步(0 = 未失败)
pub static FAIL_STAGE: G<u8> = G::new(0);
static DBG_NEXT: G<u32> = G::new(0);

static CAN_TAB: G<[u32; PER_PHASE]> = G::new([0; PER_PHASE]);
static ZFLAG: G<[u8; PER_PHASE]> = G::new([0; PER_PHASE]);
/// 轨道是否被对称性强制作 0(248 条)。installQuant 直接跳过它们
static ORB_ZERO: G<[u8; ORBITS]> = G::new([0; ORBITS]);

/// 阶段划分:均分 60 手 —— 第 i 档覆盖子数 [4+i·SPAN, 4+(i+1)·SPAN)
#[inline]
pub fn phase_of(discs: u32) -> usize {
    let f = discs.saturating_sub(4); // 0..60
    (((f.saturating_sub(1)) / SPAN) as usize).min(PHASES - 1)
}

fn read_u32(b: &[u8], o: usize) -> u32 {
    b[o] as u32 | ((b[o + 1] as u32) << 8) | ((b[o + 2] as u32) << 16) | ((b[o + 3] as u32) << 24)
}
fn read_f32(b: &[u8], o: usize) -> f32 {
    f32::from_bits(read_u32(b, o))
}

/// 构建轨道图 + 权重查表。blob 为 include_bytes! 进来的 int8 权重书。
/// 返回 false 表示 blob 损坏(失败步在 FAIL_STAGE,可读的排障数字)。
pub fn init(blob: &[u8]) -> bool {
    *FAIL_STAGE.w() = 0;
    if blob.len() != BLOB_HEADER + PHASES * ORBITS {
        *FAIL_STAGE.w() = 1;
        return false;
    }
    if read_u32(blob, 0) != BLOB_MAGIC {
        *FAIL_STAGE.w() = 2;
        return false;
    }
    if blob[4] != BLOB_VERSION {
        *FAIL_STAGE.w() = 3;
        return false;
    }
    if blob[5] as usize != PHASES {
        *FAIL_STAGE.w() = 4;
        return false;
    }
    if read_u32(blob, 8) as usize != ORBITS {
        *FAIL_STAGE.w() = 5;
        return false;
    }
    for ph in 0..PHASES {
        SCALES.w()[ph] = read_f32(blob, 12 + 4 * ph);
    }

    if !geometry_init() {
        *FAIL_STAGE.w() = 7; // 表几何与预期不符(见 geometry_init 的两个哨兵)
        return false;
    }

    // ① 每槽求"最小像"、符号、是否被对称性逼成 0
    ZFLAG.w().fill(0);
    {
        let m = MODEL.r();
        for p in 1..PTN_COUNT + 1 {
            let off = m.slot_off[p];
            for idx in 0..m.tri[p] {
                let r = canon_slot(p, idx);
                let s = off + idx;
                CAN_TAB.w()[s as usize] = r.slot;
                SIGMA.w()[s as usize] = r.sign;
                if r.zero {
                    ZFLAG.w()[s as usize] = 1;
                }
            }
        }
    }

    // ② 代表(s == canon[s])按升序编号
    let mut next: u16 = 0;
    for i in 0..PER_PHASE {
        if CAN_TAB.r()[i] as usize == i {
            ORBIT.w()[i] = next;
            next += 1;
        }
    }
    *DBG_NEXT.w() = next as u32;
    if next as usize != ORBITS {
        *FAIL_STAGE.w() = 6;
    }

    // ③ 全表填号 + "制 0"标记按轨道归并(canon[s] ≤ s 的安全点见 zig 侧注释)
    ORB_ZERO.w().fill(0);
    for i in 0..PER_PHASE {
        let o = ORBIT.r()[CAN_TAB.r()[i] as usize] as usize;
        ORBIT.w()[i] = o as u16;
        if ZFLAG.r()[i] != 0 {
            ORB_ZERO.w()[o] = 1;
        }
    }

    // ④ 摊平成"符号已折入"的查表
    install_quant(&blob[BLOB_HEADER..]);
    if FAIL_STAGE.r0() != 0 {
        return false;
    }
    *READY.w() = true;
    true
}

/// 直接用量化好的 int8 轨道权重装表(与 init 第 ④ 步同一段逻辑)
pub fn install_quant(q: &[u8]) {
    for ph in 0..PHASES {
        let base = ph * ORBITS;
        for i in 0..PER_PHASE {
            let o = ORBIT.r()[i] as usize;
            let mut w: i8 = if ORB_ZERO.r()[o] != 0 { 0 } else { q[base + o] as i8 };
            if SIGMA.r()[i] < 0 {
                w = w.wrapping_neg();
            }
            WT.w()[ph][i] = w;
        }
    }
    *READY.w() = true;
}

/// 逐张表算 base-3 下标,输出全局槽号(38 张表,每格的移位量/幂次在几何表里)
pub fn slot_indices(b: Board, out: &mut [u32; PTN_COUNT]) {
    let m = MODEL.r();
    let own = b.own;
    let opp = b.opp;
    for p in 1..PTN_COUNT + 1 {
        let mut idx: u32 = 0;
        let off = m.cell_off[p] as usize;
        let len = m.len[p] as usize;
        for k in 0..len {
            let bit = 1u64 << m.cells[off + k];
            // 0 = 空,1 = 行棋方,2 = 对方 —— 一律行棋方视角,天然服务负极大
            if own & bit != 0 {
                idx += POW3[k];
            } else if opp & bit != 0 {
                idx += 2 * POW3[k];
            }
        }
        out[p - 1] = m.slot_off[p] + idx;
    }
}

/// 模式评估(行棋方视角,单位:子数)
pub fn eval(b: Board) -> f32 {
    let mut s = [0u32; PTN_COUNT];
    slot_indices(b, &mut s);
    eval_slots(&s, b.discs())
}

/// 未乘 scale 的整数加权和(对拍专用:整数能逐位比较)
pub fn eval_int(b: Board) -> i32 {
    let mut s = [0u32; PTN_COUNT];
    slot_indices(b, &mut s);
    let tab = unsafe { ur(WT.r(), phase_of(b.discs())) };
    let mut sum: i32 = 0;
    for i in 0..PTN_COUNT {
        sum += unsafe { uv(tab, s[i] as usize) } as i32;
    }
    sum
}

/// 已有槽号时的求值(求和顺序固定,便于逐位对拍)
pub fn eval_slots(s: &[u32; PTN_COUNT], discs: u32) -> f32 {
    let ph = phase_of(discs);
    let tab = unsafe { ur(WT.r(), ph) };
    let mut sum: i32 = 0;
    for i in 0..PTN_COUNT {
        sum += unsafe { uv(tab, s[i] as usize) } as i32;
    }
    sum as f32 * SCALES.r()[ph]
}

#[inline]
pub fn ready() -> bool {
    READY.r0()
}
#[inline]
pub fn scales(ph: usize) -> f32 {
    SCALES.r()[ph]
}
/// inc 模块要按表几何派生每格特征表 —— 借静态几何表一用
pub fn model_ref() -> &'static Model {
    MODEL.r()
}
/// inc 的 sumInt 直接读"符号已折入"的查表
pub fn wt_ref() -> &'static [[i8; PER_PHASE]; PHASES] {
    WT.r()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn geometry_totals() {
        assert!(geometry_init());
        assert_eq!(MODEL.r().total as usize, PER_PHASE);
        // 256 格 = 64×4:每个格子恰好被 4 张表覆盖(覆盖完整的证据)
        let mut cover = [0u8; 64];
        for p in 1..PTN_COUNT + 1 {
            for k in 0..MODEL.r().len[p] as usize {
                cover[MODEL.r().cells[MODEL.r().cell_off[p] as usize + k] as usize] += 1;
            }
        }
        assert!(cover.iter().all(|&c| c == 4));
    }

    #[test]
    fn phase_boundaries() {
        assert_eq!(phase_of(4), 0);
        assert_eq!(phase_of(24), 0);
        assert_eq!(phase_of(25), 1); // 第 0 档覆盖 [4,24]
        assert_eq!(phase_of(44), 1);
        assert_eq!(phase_of(45), 2); // 第 1 档覆盖 [24,44]
        assert_eq!(phase_of(64), 2);
    }
}
