//! AetherOthello 引擎的 Rust 重写(rust 分支试验)—— src/zig/engine.zig 的移植。
//!
//! 与 zig 通道的关系:**同 ABI、同数据、同 worker**。
//!   · 导出面(C ABI,全部 #[no_mangle] extern "C")与 zig 版一字不差,
//!     src/worker.js 不改一行就能加载本产物;
//!   · weights.bin / book-openings.bin 用 include_bytes! 原样嵌入(模型复用,
//!     不重训);格式解析逐字段照抄 zig;
//!   · 训练器(train.zig)不移植 —— 本分支只做推理。
//!
//! 设计约定(照抄 zig):u64 位板拆 lo/hi 两个 u32 过 ABI 边界;所有导出
//! 不分配、不抛异常,出错用 engineInit() 的返回值表达(0 = 好,非 0 = 失败步)。
//! no_std:freestanding,不 import 任何东西(probe-wasm A 节的硬要求)。

// 测试时挂上 std(跑原生单测);发布目标(no_std wasm)不引入任何依赖
#![cfg_attr(not(test), no_std)]

mod endgame;
mod inc;
mod pattern;
mod rules;
mod search;
mod stability;

/// 单线程全局状态的容器(wasm 单线程;UnsafeCell 只是对 zig 全局变量的直译)
pub struct G<T>(core::cell::UnsafeCell<T>);
unsafe impl<T> Sync for G<T> {}
impl<T> G<T> {
    pub const fn new(v: T) -> Self {
        G(core::cell::UnsafeCell::new(v))
    }
    #[inline]
    pub fn r(&self) -> &T {
        unsafe { &*self.0.get() }
    }
    #[inline]
    pub fn w(&self) -> &mut T {
        unsafe { &mut *self.0.get() }
    }
}

impl<T: Copy> G<T> {
    /// 标量静态的按值直读(NODES.r0() 这种;结构体请用 .r() 拿引用)
    #[inline]
    pub fn r0(&self) -> T {
        *self.r()
    }
}

#[cfg(not(test))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    // freestanding 没有恐慌输出;release 下不可达,走到这里即死循环
    loop {}
}

/// 编译期嵌进 wasm 数据段。int8 权重是高熵数据,gzip 基本压不动 ——
/// 它是体积预算里躲不掉的那块,与 zig 侧 @embedFile 同一份文件。
static WEIGHTS: &[u8] = include_bytes!("../../src/zig/weights.bin");

// ══════════════════ ⑩ 开局书:Egaroucid 精确书(≤14 子)══════════════════
// 布局(字节对齐,gzip 友好):u16 条数 LE + u8 passTok;条目按路径字典序排序,
// 每条 = share u8 + slen u8 + slen×u8 token + (value+8) u8 + bcnt u8 + bcnt×u8
// + nameRef u8(名字池下标+1,0 = 无名);条目区之后是名字池(u16 数量 +
// 每串 u8 len + ASCII)。**朝向规范化**是表能命中的关键:书每条只存一条回放
// 路径 ⇒ 单一朝向,而查询局面会以 8 个对称位形出现 —— 键与查询都规范化到
// 唯一朝向,着法掩码按同一置换换算格号。

static BOOK_BIN: &[u8] = include_bytes!("../../src/zig/book-openings.bin");
const BOOK_MAX_DISCS: u32 = 14;
const BK_CAP: usize = 2048; // 2 的幂;条目 914,负载 <45%(线性探测)
const BK_MASK: u64 = (BK_CAP - 1) as u64;
const BK_NAMES_MAX: usize = 256;
static BK_KEY_OWN: G<[u64; BK_CAP]> = G::new([0; BK_CAP]);
static BK_KEY_OPP: G<[u64; BK_CAP]> = G::new([0; BK_CAP]);
static BK_MOVES: G<[u64; BK_CAP]> = G::new([0; BK_CAP]); // 最佳着法位掩码(规范朝向);0 = 空槽
static BK_VAL: G<[i8; BK_CAP]> = G::new([0; BK_CAP]); // 书内精确值(行棋方视角,子差)
static BK_NAME: G<[u8; BK_CAP]> = G::new([0; BK_CAP]); // 名字池下标+1;0 = 无名(同槽首插优先)
static BK_POOL_N: G<usize> = G::new(0);
static BK_POOL_OFF: G<[usize; BK_NAMES_MAX]> = G::new([0; BK_NAMES_MAX]);
static BK_POOL_LEN: G<[u8; BK_NAMES_MAX]> = G::new([0; BK_NAMES_MAX]);
static BK_READY: G<bool> = G::new(false);

static SYM_PERM: G<[[u8; 64]; 8]> = G::new([[0; 64]; 8]); // 对称 t:格 i → 格 perm[t][i]
static SYM_INV: G<[u8; 8]> = G::new([0; 8]); // t 的逆变换号

fn build_sym_perms() {
    for i in 0..64usize {
        let r = (i >> 3) as u32;
        let f = (i & 7) as u32;
        let r7 = 7 - r;
        let f7 = 7 - f;
        SYM_PERM.w()[0][i] = i as u8; // id
        SYM_PERM.w()[1][i] = (f7 * 8 + r) as u8; // rot90
        SYM_PERM.w()[2][i] = (r7 * 8 + f7) as u8; // rot180
        SYM_PERM.w()[3][i] = (f * 8 + r7) as u8; // rot270
        SYM_PERM.w()[4][i] = (r * 8 + f7) as u8; // 纵镜(文件翻转)
        SYM_PERM.w()[5][i] = (r7 * 8 + f) as u8; // 横镜(行翻转)
        SYM_PERM.w()[6][i] = (f * 8 + r) as u8; // 转置
        SYM_PERM.w()[7][i] = (f7 * 8 + r7) as u8; // 反转置
    }
    for t in 0..8usize {
        for u in 0..8usize {
            let mut ok = true;
            for i in 0..64usize {
                if SYM_PERM.r()[u][SYM_PERM.r()[t][i] as usize] as usize != i {
                    ok = false;
                    break;
                }
            }
            if ok {
                SYM_INV.w()[t] = u as u8;
                break;
            }
        }
    }
}

struct Canon {
    own: u64,
    opp: u64,
    t: u32,
}

/// 规范化:min(own, opp) 字典序的朝向;t = 本朝向 → 规范朝向的变换号
fn canon_of(b: rules::Board) -> Canon {
    let mut best = Canon { own: 0, opp: 0, t: 0 };
    let mut first = true;
    for t in 0..8usize {
        let mut own: u64 = 0;
        let mut opp: u64 = 0;
        for i in 0..64usize {
            let bit = 1u64 << i;
            if b.own & bit != 0 {
                own |= 1u64 << SYM_PERM.r()[t][i] as usize;
            }
            if b.opp & bit != 0 {
                opp |= 1u64 << SYM_PERM.r()[t][i] as usize;
            }
        }
        if first || own < best.own || (own == best.own && opp < best.opp) {
            best = Canon { own, opp, t: t as u32 };
            first = false;
        }
    }
    best
}

fn book_hash(own: u64, opp: u64) -> usize {
    let mut h = own.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    h ^= opp.wrapping_mul(0xC2B2_AE3D_27D4_EB4F);
    h ^= h >> 29;
    (h & BK_MASK) as usize
}

/// b 需已规范化。mask 为规范朝向掩码。name_ref = 名字池下标+1(0 = 无名)
fn book_insert(b: rules::Board, mask: u64, val: i8, name_ref: u8) {
    let mut s = book_hash(b.own, b.opp);
    loop {
        if BK_MOVES.r()[s] == 0 {
            BK_KEY_OWN.w()[s] = b.own;
            BK_KEY_OPP.w()[s] = b.opp;
            BK_VAL.w()[s] = val;
            BK_NAME.w()[s] = name_ref;
        }
        if BK_KEY_OWN.r()[s] == b.own && BK_KEY_OPP.r()[s] == b.opp {
            BK_MOVES.w()[s] |= mask;
            return;
        }
        s = ((s + 1) as u64 & BK_MASK) as usize;
    }
}

fn book_init() {
    build_sym_perms();
    if BOOK_BIN.len() < 3 {
        *BK_READY.w() = true;
        return;
    }
    let n = BOOK_BIN[0] as usize | ((BOOK_BIN[1] as usize) << 8);
    let pass_tok = BOOK_BIN[2];
    let mut off: usize = 3;
    let mut path = [0u8; 32]; // 最长 ≤ 10 手 + 过手余量
    let mut prev_len: usize = 0;
    let mut i = 0usize;
    while i < n && off + 4 <= BOOK_BIN.len() {
        let share = BOOK_BIN[off] as usize;
        let slen = BOOK_BIN[off + 1] as usize;
        off += 2;
        if share > prev_len || share + slen > path.len() {
            break; // 数据损坏哨兵
        }
        if off + slen + 2 > BOOK_BIN.len() {
            break; // 条目截断
        }
        let mut plen = share;
        for k in 0..slen {
            path[plen] = BOOK_BIN[off];
            plen += 1;
            off += 1;
        }
        let val = (BOOK_BIN[off] as i8).wrapping_sub(8);
        let bcnt = BOOK_BIN[off + 1] as usize;
        off += 2;
        if off + bcnt > BOOK_BIN.len() {
            break;
        }
        let mut mask: u64 = 0;
        for _k in 0..bcnt {
            mask |= 1u64 << BOOK_BIN[off];
            off += 1;
        }
        if off >= BOOK_BIN.len() {
            break; // 名字下标读越界
        }
        let name_ref = BOOK_BIN[off];
        off += 1;
        // 回放(生成器帧):过手显式记号;真着法先验翻子,非法即数据坏 → 弃条目
        let mut b = rules::Board::initial();
        let mut legal = true;
        for t in 0..plen {
            let tok = path[t];
            if tok == pass_tok {
                b = b.swapped();
                continue;
            }
            if tok >= 64 || rules::flips(b, tok as u32) == 0 {
                legal = false;
                break;
            }
            b = rules::play(b, tok as u32);
        }
        if legal {
            // 入库:盘面规范化;掩码同乘该朝向的置换
            let c = canon_of(b);
            let mut cmask: u64 = 0;
            let mut mm = mask;
            while mm != 0 {
                let sq = mm.trailing_zeros();
                mm &= mm - 1;
                cmask |= 1u64 << SYM_PERM.r()[c.t as usize][sq as usize];
            }
            book_insert(rules::Board { own: c.own, opp: c.opp }, cmask, val, name_ref);
        }
        prev_len = plen;
        i += 1;
    }
    // 名字池(blob 尾部):u16 数量 + 每串 u8 len + ASCII。截断只影响已解析数
    if off + 2 <= BOOK_BIN.len() {
        let pn = BOOK_BIN[off] as usize | ((BOOK_BIN[off + 1] as usize) << 8);
        off += 2;
        let mut pi = 0usize;
        while pi < pn && pi < BK_NAMES_MAX && off < BOOK_BIN.len() {
            let nlen = BOOK_BIN[off] as usize;
            off += 1;
            if off + nlen > BOOK_BIN.len() {
                break;
            }
            BK_POOL_OFF.w()[pi] = off;
            BK_POOL_LEN.w()[pi] = nlen as u8;
            off += nlen;
            pi += 1;
        }
        *BK_POOL_N.w() = pi;
    }
    *BK_READY.w() = true;
}

/// 规范化局面查表 → 槽位(未命中 None)
fn book_slot(c: &Canon) -> Option<usize> {
    let mut s = book_hash(c.own, c.opp);
    loop {
        if BK_MOVES.r()[s] == 0 {
            return None;
        }
        if BK_KEY_OWN.r()[s] == c.own && BK_KEY_OPP.r()[s] == c.opp {
            return Some(s);
        }
        s = ((s + 1) as u64 & BK_MASK) as usize;
    }
}

// ── 上一手的结果状态(engine.zig 的 last / last_book / last_book_name)──

#[derive(Copy, Clone)]
struct Last {
    mv: i32,
    score: f32,
    depth: u32,
    exact: bool,
    endgame: bool,
}
static LAST: G<Last> = G::new(Last { mv: -1, score: 0.0, depth: 0, exact: false, endgame: false });
static LAST_BOOK: G<bool> = G::new(false);
/// 上一手书命中根局面的名字池下标+1(0 = 无名/未命中)
static LAST_BOOK_NAME: G<u8> = G::new(0);

/// 命中开局书则返回着法并发布根清单。**只定序,不选** —— 枚举合法着法,
/// 子局面在书内的按「我方结果 = −子值」给精确值,publish_root(exact=true),
/// worker 的 JS 按值容差加权随机;子局面不在书内的着法不入表;表空回退
/// 标注 best 集。返回值 = 清单第 0 项(完全确定)。
fn book_move(b: rules::Board, depth_max: u32) -> Option<u32> {
    if !BK_READY.r0() || depth_max < 4 {
        return None;
    }
    if b.discs() > BOOK_MAX_DISCS {
        return None;
    }
    let c = canon_of(b);
    let s = book_slot(&c)?;
    // 根局面的名字(供 engineBookNamePtr 透传;下面子局面探测不改它)
    *LAST_BOOK_NAME.w() = BK_NAME.r()[s];

    let mut mvs = [0u32; 36];
    let mut outs = [0f32; 36];
    let mut trs = [false; 36]; // 书值全是精确终局子差 → 全真值
    let mut n: usize = 0;
    let mut best_out: i8 = -127;
    let mut legal = rules::moves(b);
    while legal != 0 {
        let sq = legal.trailing_zeros();
        legal &= legal - 1;
        let child = rules::play(b, sq);
        if let Some(cs) = book_slot(&canon_of(child)) {
            let out = -BK_VAL.r()[cs]; // 子局面轮对方,取负为我方结果
            mvs[n] = sq;
            outs[n] = out as f32;
            n += 1;
            if out > best_out {
                best_out = out;
            }
        }
    }
    if n > 0 {
        for t in 0..n {
            trs[t] = true;
        }
        search::publish_root(&mvs[..n], &outs[..n], &trs[..n], n as u32, true);
        return Some(search::root_move0());
    }

    // 表空:回退标注 best 掩码(换算回查询朝向)。单着真值未知,统一取局面书值
    let mut m: u64 = 0;
    let mut mm = BK_MOVES.r()[s];
    while mm != 0 {
        let sq = mm.trailing_zeros();
        mm &= mm - 1;
        m |= 1u64 << SYM_PERM.r()[SYM_INV.r()[c.t as usize] as usize][sq as usize];
    }
    m &= rules::moves(b);
    if m == 0 {
        return None; // 换算后不合法(构造上不该发生,防御)
    }
    let pos_val = BK_VAL.r()[s] as f32;
    n = 0;
    let mut mm2 = m;
    while mm2 != 0 {
        let sq = mm2.trailing_zeros();
        mm2 &= mm2 - 1;
        mvs[n] = sq;
        outs[n] = pos_val;
        n += 1;
    }
    for t in 0..n {
        trs[t] = true;
    }
    search::publish_root(&mvs[..n], &outs[..n], &trs[..n], n as u32, true);
    Some(search::root_move0())
}

// ══════════════════ wasm 导出面(C ABI)══════════════════

/// ⑥ MPC 开关与置信度系数(mpct,典型 1.64 ≈ 95% 单侧)。flag=0 关闭
#[no_mangle]
pub extern "C" fn engineSetMpc(flag: u32, mpct: f32) {
    search::set_mpc(flag != 0, mpct);
}

/// ⑥b 尾盘 MPC:exact 求解的纯精确带下沿(空位数)。0 = 关闭
#[no_mangle]
pub extern "C" fn engineSetEndMpc(pure: u32) {
    search::set_end_mpc(pure);
}

/// 0 = 就绪;非 0 = 失败步(pattern 的 failStage,可读的排障数字)
#[no_mangle]
pub extern "C" fn engineInit() -> u32 {
    if !pattern::init(WEIGHTS) {
        return pattern::FAIL_STAGE.r0() as u32;
    }
    book_init();
    inc::init_tables(); // ④ 增量评估的每格特征表(搜索入口还有懒建兜底)
    0
}

#[no_mangle]
pub extern "C" fn engineReady() -> u32 {
    if pattern::ready() {
        1
    } else {
        0
    }
}
#[no_mangle]
pub extern "C" fn engineOrbits() -> u32 {
    pattern::ORBITS as u32
}
#[no_mangle]
pub extern "C" fn engineWeightBytes() -> u32 {
    WEIGHTS.len() as u32
}
/// 定标:eval = scale × Σ int8(诊断字段,只报相位 0 —— 同 zig)
#[no_mangle]
pub extern "C" fn engineScale() -> f32 {
    pattern::scales(0)
}

#[inline]
fn mk(own_lo: u32, own_hi: u32, opp_lo: u32, opp_hi: u32) -> rules::Board {
    rules::Board {
        own: own_lo as u64 | ((own_hi as u64) << 32),
        opp: opp_lo as u64 | ((opp_hi as u64) << 32),
    }
}

/// 行棋方视角的模式评估(单位:子数)
#[no_mangle]
pub extern "C" fn engineEval(own_lo: u32, own_hi: u32, opp_lo: u32, opp_hi: u32) -> f32 {
    pattern::eval(mk(own_lo, own_hi, opp_lo, opp_hi))
}

/// 迭代加深主入口。返回着法 0..63;-1 = 没有合法着法。budget 0 = 不限
#[no_mangle]
pub extern "C" fn engineThink(
    own_lo: u32,
    own_hi: u32,
    opp_lo: u32,
    opp_hi: u32,
    depth: u32,
    endgame: u32,
    budget_lo: u32,
    budget_hi: u32,
) -> i32 {
    if !pattern::ready() {
        return -1;
    }
    let bud = budget_lo as u64 | ((budget_hi as u64) << 32);
    let b = mk(own_lo, own_hi, opp_lo, opp_hi);
    // ⑩ 开局书命中:直接出书内最佳着法,score = 书内精确值(exact/endgame 仍为
    // false —— 书值是理论值,不当终局判决)。nodes 清零免得带上陈旧计数
    if let Some(mv) = book_move(b, depth) {
        let book_val = search::root_score(0);
        *LAST.w() = Last { mv: mv as i32, score: book_val, depth: 0, exact: false, endgame: false };
        *LAST_BOOK.w() = true;
        search::set_nodes(0);
        return mv as i32;
    }
    *LAST_BOOK.w() = false;
    *LAST_BOOK_NAME.w() = 0;
    let r = search::think(b, depth, endgame, bud);
    *LAST.w() = Last { mv: r.mv, score: r.score, depth: r.depth, exact: r.exact, endgame: r.endgame };
    if r.mv < 0 {
        -1
    } else {
        r.mv
    }
}

#[no_mangle]
pub extern "C" fn engineScore() -> f32 {
    LAST.r0().score
}
/// 上一手 engineThink 是否开局书命中(1/0)
#[no_mangle]
pub extern "C" fn engineBook() -> u32 {
    if LAST_BOOK.r0() {
        1
    } else {
        0
    }
}
#[no_mangle]
pub extern "C" fn engineRootN() -> u32 {
    search::root_n()
}
#[no_mangle]
pub extern "C" fn engineRootMove(i: u32) -> i32 {
    search::root_move(i)
}
#[no_mangle]
pub extern "C" fn engineRootScore(i: u32) -> f32 {
    search::root_score(i)
}
#[no_mangle]
pub extern "C" fn engineRootExact() -> u32 {
    if search::root_exact() {
        1
    } else {
        0
    }
}
#[no_mangle]
pub extern "C" fn engineRootTrue(i: u32) -> u32 {
    if search::root_true(i) {
        1
    } else {
        0
    }
}
/// 上一手书命中局面的开局名(名字池 ASCII 串)。返回 wasm 线性内存里的地址;
/// 0 = 无名/未命中。worker 用 memory.buffer + engineBookNameLen 读出。
#[no_mangle]
pub extern "C" fn engineBookNamePtr() -> u32 {
    let n = LAST_BOOK_NAME.r0() as usize;
    if n == 0 || n > *BK_POOL_N.r() {
        return 0;
    }
    let off = BK_POOL_OFF.r()[n - 1];
    (&BOOK_BIN[off] as *const u8) as u32
}
#[no_mangle]
pub extern "C" fn engineBookNameLen() -> u32 {
    let n = LAST_BOOK_NAME.r0() as usize;
    if n == 0 || n > *BK_POOL_N.r() {
        return 0;
    }
    BK_POOL_LEN.r()[n - 1] as u32
}
/// 这一手实际跑完的深度(节点预算先用满时它会低于标称深度)
#[no_mangle]
pub extern "C" fn engineDepth() -> u32 {
    LAST.r0().depth
}
/// 这一手是否给出了可信的精确解。
/// 预算耗尽 / ⑥b 尾盘 MPC 命中过剪枝时必须报 0(概率分不得当终局判决)
#[no_mangle]
pub extern "C" fn engineExact() -> u32 {
    if search::aborted() || search::mpc_end_used() {
        return 0;
    }
    if LAST.r0().exact || LAST.r0().endgame {
        1
    } else {
        0
    }
}
#[no_mangle]
pub extern "C" fn engineNodesLo() -> u32 {
    search::nodes() as u32
}
#[no_mangle]
pub extern "C" fn engineNodesHi() -> u32 {
    (search::nodes() >> 32) as u32
}
/// 换局 / 换难度时清置换表(不清也不会算错,但会带着上一局的结论跑)
#[no_mangle]
pub extern "C" fn engineClear() {
    search::clear_tt();
}

// ── 原生单测(x86_64 跑,不进 wasm)──
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_and_eval_initial_zero() {
        assert_eq!(engineInit(), 0);
        // 初始局面:180° 旋转 + 换色双双不变 ⇒ eval 必须为 0
        let b = rules::Board::initial();
        assert!(pattern::eval(b).abs() <= 1e-6);
    }

    #[test]
    fn book_root_is_d3() {
        assert_eq!(engineInit(), 0);
        let b = rules::Board::initial();
        let mv = engineThink(
            b.own as u32,
            (b.own >> 32) as u32,
            b.opp as u32,
            (b.opp >> 32) as u32,
            6,
            8,
            0,
            0,
        );
        assert_eq!(engineBook(), 1);
        assert_eq!(mv, 19); // d3:书清单 4 着全 0 分,同分位号升序 → 第 0 项
        assert_eq!(engineRootN(), 4);
        assert_eq!(engineRootExact(), 1);
        assert_eq!(engineRootMove(0), 19);
    }

    #[test]
    fn symmetry_invariance() {
        assert_eq!(engineInit(), 0);
        // 简单手造一个局面:初始 + 走 d3 后换手
        let b = rules::Board::initial();
        let nb = rules::play(b, 19);
        let v = pattern::eval(nb);
        // 转置(对称 6)后求值应当不变
        let mut to = 0u64;
        let mut tp = 0u64;
        for i in 0..64usize {
            let bit = 1u64 << i;
            if nb.own & bit != 0 {
                to |= 1u64 << SYM_PERM.r()[6][i];
            }
            if nb.opp & bit != 0 {
                tp |= 1u64 << SYM_PERM.r()[6][i];
            }
        }
        let v2 = pattern::eval(rules::Board { own: to, opp: tp });
        assert!((v - v2).abs() <= 1e-5, "v={} v2={}", v, v2);
        // 换色后求值取反
        let v3 = pattern::eval(nb.swapped());
        assert!((v + v3).abs() <= 1e-5, "v={} v3={}", v, v3);
    }
}
