/* ============================================================
 * AetherOthello —— 黑白棋(Reversi / Othello)AI 引擎
 *
 * 位棋盘实现:每色用低/高两个 32 位字表示 64 格,移位 + 列掩码
 * 生成合法步掩码与翻子掩码(每方向"穿越填充",邻格非对方子则零展开)。
 *
 *   难度   — 初级:贪心选点(位置权重+翻子数),不搜索;
 *            中级:PVS 迭代加深至 4 层,残局 ≤8 空完全求解;
 *            高级:PVS 迭代加深至 8 层,残局 ≤14 空完全求解
 *            (求解前先跑 2→4→6 中层搜索确定根排序);
 *   搜索   — PVS 负极大 + 置换表(中局 2^16 / 残局 2^20 槽,Zobrist 双字校验)
 *            + 残局奇偶排序(奇数空格区域优先);
 *   评估   — 位置权重表 + 行动力差 + 前沿子(潜在行动力)。
 *
 * 对外入口:think(board, aiColor, level, onProgress, shouldAbort)
 *   board 为 8×8 的 'b'/'w'/null 二维数组(UI 友好);异步、带进度回调。
 * 另导出一批基准/测试钩子(rootSearch、clearTT、__setPosition 等,见文件末尾)。
 *
 * 本文件不碰 DOM、不 import 任何库 —— 浏览器、Worker、Node 通用。
 * ============================================================ */
const EMPTY = 0, BLACK = 1, WHITE = 2;

/** 难度分档:depth=0 为纯贪心;end 为进入完全求解的空格阈值 */
const LEVELS = [
  { name: '初级', desc: '贪心选点(位置权重+翻子数)', depth: 0, end: 0 },
  { name: '中级', desc: 'PVS 搜索 4 层 · 残局 8 空完全求解', depth: 4, end: 8 },
  { name: '高级', desc: 'PVS 搜索 8 层 · 残局 14 空完全求解', depth: 8, end: 14 },
];
const PRE_ENDGAME_DEPTH = 6; // 残局前置中层搜索深度(只为完全求解确定排序)
const INF = 1 << 30;
const F_EXACT = 1, F_LOWER = 2, F_UPPER = 3;

/** 位置权重表(角最贵,角旁负分;按 位序=行×8+列 展平为 64 格) */
const W64 = new Int32Array([
  120, -20, 20, 5, 5, 20, -20, 120,   // 第 1 行
  -20, -40, -5, -5, -5, -5, -40, -20, // 第 2 行
  20, -5, 15, 3, 3, 15, -5, 20,       // 第 3 行
  5, -5, 3, 3, 3, 3, -5, 5,           // 第 4 行
  5, -5, 3, 3, 3, 3, -5, 5,           // 第 5 行
  20, -5, 15, 3, 3, 15, -5, 20,       // 第 6 行
  -20, -40, -5, -5, -5, -5, -40, -20, // 第 7 行
  120, -20, 20, 5, 5, 20, -20, 120,   // 第 8 行
]);

/* 位棋盘状态:P = 行棋方,O = 对方;每色低/高两个 32 位字
 * (低字 = 第 0-3 行 = 位 0-31,高字 = 第 4-7 行 = 位 32-63,位 p = 行 r×8+列 c) */
let PLO = 0, PHI = 0, OLO = 0, OHI = 0;
let MLO = 0, MHI = 0;      // genMoves 输出:合法着掩码
let _lo = 0, _hi = 0;      // 各位棋盘原语的输出暂存
let nodes = 0;

/* 文件 A = 每字节位 0(0xfe…),文件 H = 每字节位 7(0x7f…):
 * ±1 / ±7 / ±9 的移位先掩掉源端边列,防止跨行回绕 */
const NA = 0xfefefefe, NH = 0x7f7f7f7f;

function popcnt(x) {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >>> 24;
}

/** 经典 Zobrist:每格 × 每色一对独立随机数(mulberry32 生成),异或组合。
 *  索引 = 颜色×64 + 格号(白 0-63 / 黑 64-127),保证"白@s 与 黑@s'"
 *  这类跨色跨字的组合不可能整对抵消——线性混合或错位索引都会造成
 *  精确碰撞,污染置换表精确分。双 32 位联合校验,伪命中概率约 2^-64。 */
const ZOB1 = new Int32Array(128), ZOB2 = new Int32Array(128);
{
  let s = 0x1a2b3c4d;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) | 0;
  };
  for (let i = 0; i < 128; i++) { ZOB1[i] = rnd(); ZOB2[i] = rnd(); }
}
let _k1 = 0, _k2 = 0;
function hashPos(player) {
  let k1 = 0, k2 = 0, x, b;
  x = PLO; while (x) { b = x & -x; x ^= b; const i = 31 - Math.clz32(b); k1 ^= ZOB1[i]; k2 ^= ZOB2[i]; }
  x = PHI; while (x) { b = x & -x; x ^= b; const i = 32 + 31 - Math.clz32(b); k1 ^= ZOB1[i]; k2 ^= ZOB2[i]; }
  x = OLO; while (x) { b = x & -x; x ^= b; const i = 64 + 31 - Math.clz32(b); k1 ^= ZOB1[i]; k2 ^= ZOB2[i]; }
  x = OHI; while (x) { b = x & -x; x ^= b; const i = 96 + 31 - Math.clz32(b); k1 ^= ZOB1[i]; k2 ^= ZOB2[i]; }
  k1 = (k1 ^ player) | 0;
  k2 = (k2 ^ Math.imul(player, 0x9e3779b9)) | 0;
  _k1 = k1; _k2 = k2;
}

/** 置换表:始终替换;中局 2^16 槽 / 残局 2^20 槽(完全搜索节点量大,
 *  表小冲突替换严重;两表评分语义不同,不混用) */
const TT_MASK_MID = (1 << 16) - 1, TT_MASK_END = (1 << 20) - 1;
function makeTT(mask) {
  const size = mask + 1;
  return {
    key: new Int32Array(size),
    key2: new Int32Array(size),
    depth: new Int8Array(size),
    flag: new Int8Array(size),
    score: new Int32Array(size),
    move: new Int8Array(size),
  };
}
const TT_MID = makeTT(TT_MASK_MID), TT_END = makeTT(TT_MASK_END);

/* ---- 8 方向"穿越填充":从源格集出发穿过连续 O,结果 → _lo/_hi。
 *      每步先按方向掩掉边列再移位;±1 按字内移位,±7/±8/±9 做字间进位。
 *      "走到不是 O 就停":方向线最多 6 个中间格,原实现无条件展开 6 层,
 *      但绝大多数出发点邻格不是 O,一层都不必展开。语义与 6 层展开完全等价。 */

/** 东(+1):源不得在 H 列 */
function fillE(lo, hi, olo, ohi) {
  let t = 0, th = 0, x = ((lo & NH) << 1) & olo, xh = ((hi & NH) << 1) & ohi;
  while (x | xh) { t |= x; th |= xh; x = ((x & NH) << 1) & olo; xh = ((xh & NH) << 1) & ohi; }
  _lo = t; _hi = th;
}

/** 西(-1):源不得在 A 列 */
function fillW(lo, hi, olo, ohi) {
  let t = 0, th = 0, x = ((lo & NA) >>> 1) & olo, xh = ((hi & NA) >>> 1) & ohi;
  while (x | xh) { t |= x; th |= xh; x = ((x & NA) >>> 1) & olo; xh = ((xh & NA) >>> 1) & ohi; }
  _lo = t; _hi = th;
}

/** 南(+8,下一行):字间进位取自低字高 8 位 */
function fillS(lo, hi, olo, ohi) {
  let t = 0, th = 0, x = (lo << 8) & olo, xh = ((hi << 8) | (lo >>> 24)) & ohi;
  while (x | xh) { t |= x; th |= xh; xh = ((xh << 8) | (x >>> 24)) & ohi; x = (x << 8) & olo; }
  _lo = t; _hi = th;
}

/** 北(-8,上一行):字间进位取自高字低 8 位 */
function fillN(lo, hi, olo, ohi) {
  let t = 0, th = 0, x = ((lo >>> 8) | (hi << 24)) & olo, xh = (hi >>> 8) & ohi;
  while (x | xh) { t |= x; th |= xh; x = ((x >>> 8) | (xh << 24)) & olo; xh = (xh >>> 8) & ohi; }
  _lo = t; _hi = th;
}

/** 西南(+7:下一行左一列):源不得在 A 列 */
function fillSW(lo, hi, olo, ohi) {
  let t = 0, th = 0, l = lo & NA, h = hi & NA;
  let x = (l << 7) & olo, xh = ((h << 7) | (l >>> 25)) & ohi;
  while (x | xh) { t |= x; th |= xh; l = x & NA; h = xh & NA; xh = ((h << 7) | (l >>> 25)) & ohi; x = (l << 7) & olo; }
  _lo = t; _hi = th;
}

/** 东北(-7:上一行右一列):源不得在 H 列 */
function fillNE(lo, hi, olo, ohi) {
  let t = 0, th = 0, l = lo & NH, h = hi & NH;
  let x = ((l >>> 7) | (h << 25)) & olo, xh = (h >>> 7) & ohi;
  while (x | xh) { t |= x; th |= xh; l = x & NH; h = xh & NH; x = ((l >>> 7) | (h << 25)) & olo; xh = (h >>> 7) & ohi; }
  _lo = t; _hi = th;
}

/** 东南(+9:下一行右一列):源不得在 H 列 */
function fillSE(lo, hi, olo, ohi) {
  let t = 0, th = 0, l = lo & NH, h = hi & NH;
  let x = (l << 9) & olo, xh = ((h << 9) | (l >>> 23)) & ohi;
  while (x | xh) { t |= x; th |= xh; l = x & NH; h = xh & NH; xh = ((h << 9) | (l >>> 23)) & ohi; x = (l << 9) & olo; }
  _lo = t; _hi = th;
}

/** 西北(-9:上一行左一列):源不得在 A 列 */
function fillNW(lo, hi, olo, ohi) {
  let t = 0, th = 0, l = lo & NA, h = hi & NA;
  let x = ((l >>> 9) | (h << 23)) & olo, xh = (h >>> 9) & ohi;
  while (x | xh) { t |= x; th |= xh; l = x & NA; h = xh & NA; x = ((l >>> 9) | (h << 23)) & olo; xh = (h >>> 9) & ohi; }
  _lo = t; _hi = th;
}

/** 合法着掩码(对行棋方 P 而言)→ MLO/MHI。
 *  每方向:从全部 P 子穿越 O 填充,再沿该方向走一步落在空格即合法。
 *  8 个方向的 P 侧填充缓存到模块变量,供 moveFlips 复用(双向填充求交)。 */
let feLo = 0, feHi = 0, fwLo = 0, fwHi = 0, fsLo = 0, fsHi = 0, fnLo = 0, fnHi = 0;
let fswLo = 0, fswHi = 0, fneLo = 0, fneHi = 0, fseLo = 0, fseHi = 0, fnwLo = 0, fnwHi = 0;

function genMoves(plo, phi, olo, ohi) {
  const elo = ~(plo | olo) | 0, ehi = ~(phi | ohi) | 0;
  let m = 0, mh = 0;
  fillE(plo, phi, olo, ohi); feLo = _lo; feHi = _hi;
  m |= ((feLo & NH) << 1) & elo; mh |= ((feHi & NH) << 1) & ehi;
  fillW(plo, phi, olo, ohi); fwLo = _lo; fwHi = _hi;
  m |= ((fwLo & NA) >>> 1) & elo; mh |= ((fwHi & NA) >>> 1) & ehi;
  fillS(plo, phi, olo, ohi); fsLo = _lo; fsHi = _hi;
  m |= (fsLo << 8) & elo; mh |= ((fsHi << 8) | (fsLo >>> 24)) & ehi;
  fillN(plo, phi, olo, ohi); fnLo = _lo; fnHi = _hi;
  m |= ((fnLo >>> 8) | (fnHi << 24)) & elo; mh |= (fnHi >>> 8) & ehi;
  fillSW(plo, phi, olo, ohi); fswLo = _lo; fswHi = _hi;
  m |= ((fswLo & NA) << 7) & elo; mh |= (((fswHi & NA) << 7) | ((fswLo & NA) >>> 25)) & ehi;
  fillNE(plo, phi, olo, ohi); fneLo = _lo; fneHi = _hi;
  m |= (((fneLo & NH) >>> 7) | ((fneHi & NH) << 25)) & elo; mh |= ((fneHi & NH) >>> 7) & ehi;
  fillSE(plo, phi, olo, ohi); fseLo = _lo; fseHi = _hi;
  m |= ((fseLo & NH) << 9) & elo; mh |= (((fseHi & NH) << 9) | ((fseLo & NH) >>> 23)) & ehi;
  fillNW(plo, phi, olo, ohi); fnwLo = _lo; fnwHi = _hi;
  m |= (((fnwLo & NA) >>> 9) | ((fnwHi & NA) << 23)) & elo; mh |= ((fnwHi & NA) >>> 9) & ehi;
  MLO = m; MHI = mh;
}

/** 落点位 mlo/mhi 的翻子掩码 → _lo/_hi。要求先对同一局面调过 genMoves。
 *  翻子_d = fill_d(落子点, O) ∩ fill_-d(全部 P, O):
 *  该格与落子点之间全是 O,且沿同一方向延伸出去是 P。 */
function moveFlips(mlo, mhi, olo, ohi) {
  let fl = 0, fh = 0;
  /* 每方向先就地判一次"邻格是否为 O"(即 fill 的第一步),
     落空则连函数调用都不发生 —— 绝大多数方向在此直接跳过。 */
  if ((((mlo & NH) << 1) | ((mhi & NH) << 1)) & olo | (((mhi & NH) << 1) & ohi)) { fillE(mlo, mhi, olo, ohi); fl |= _lo & fwLo; fh |= _hi & fwHi; }
  if ((((mlo & NA) >>> 1) | ((mhi & NA) >>> 1)) & olo | (((mhi & NA) >>> 1) & ohi)) { fillW(mlo, mhi, olo, ohi); fl |= _lo & feLo; fh |= _hi & feHi; }
  if (((mlo << 8) & olo) | (((mhi << 8) | (mlo >>> 24)) & ohi)) { fillS(mlo, mhi, olo, ohi); fl |= _lo & fnLo; fh |= _hi & fnHi; }
  if ((((mlo >>> 8) | (mhi << 24)) & olo) | ((mhi >>> 8) & ohi)) { fillN(mlo, mhi, olo, ohi); fl |= _lo & fsLo; fh |= _hi & fsHi; }
  if ((((mlo & NA) << 7) & olo) | ((((mhi & NA) << 7) | ((mlo & NA) >>> 25)) & ohi)) { fillSW(mlo, mhi, olo, ohi); fl |= _lo & fneLo; fh |= _hi & fneHi; }
  if (((((mlo & NH) >>> 7) | ((mhi & NH) << 25)) & olo) | (((mhi & NH) >>> 7) & ohi)) { fillNE(mlo, mhi, olo, ohi); fl |= _lo & fswLo; fh |= _hi & fswHi; }
  if ((((mlo & NH) << 9) & olo) | ((((mhi & NH) << 9) | ((mlo & NH) >>> 23)) & ohi)) { fillSE(mlo, mhi, olo, ohi); fl |= _lo & fnwLo; fh |= _hi & fnwHi; }
  if (((((mlo & NA) >>> 9) | ((mhi & NA) << 23)) & olo) | (((mhi & NA) >>> 9) & ohi)) { fillNW(mlo, mhi, olo, ohi); fl |= _lo & fseLo; fh |= _hi & fseHi; }
  _lo = fl; _hi = fh;
}

/** 前沿子(潜在行动力):|本方棋子相邻的空位|,衡量"暴露程度" ——
 *  贴空位的子越多越危险,所以己方该值越小越好。8 次走一格 + popcount,
 *  比完整着法生成便宜约 5 倍(实测单次约 25ns)。 */
function potMob(lo, hi, olo, ohi) {
  const elo = ~(lo | olo) | 0, ehi = ~(hi | ohi) | 0;
  let t = 0, th = 0, l, h;
  t |= (lo & NH) << 1; th |= (hi & NH) << 1;
  t |= (lo & NA) >>> 1; th |= (hi & NA) >>> 1;
  t |= lo << 8; th |= (hi << 8) | (lo >>> 24);
  t |= (lo >>> 8) | (hi << 24); th |= hi >>> 8;
  l = lo & NA; h = hi & NA; t |= l << 7; th |= (h << 7) | (l >>> 25);
  l = lo & NH; h = hi & NH; t |= (l >>> 7) | (h << 25); th |= h >>> 7;
  l = lo & NH; h = hi & NH; t |= l << 9; th |= (h << 9) | (l >>> 23);
  l = lo & NA; h = hi & NA; t |= (l >>> 9) | (h << 23); th |= h >>> 9;
  return popcnt(t & elo) + popcnt(th & ehi);
}
/* ---- 残局奇偶(parity):把空格按 8 连通切成区域,奇数大小的区域优先 ----
 *  终局本质是"谁在一个连通的空格区域里走最后一步"的争夺,而区域大小决定
 *  最后一步归谁。先走奇区域能显著压低搜索树。纯排序,不影响任何一手的值。
 *  实测(5 种子合并,完全求解节点数):13 空 -36% · 14 空 -48% · 15 空 -36%。 */
let _xlo = 0, _xhi = 0;
/** 8 连通膨胀(含源自身)→ _xlo/_xhi */
function expand8(lo, hi) {
  let t = lo, th = hi, l, h;
  t |= (lo & NH) << 1; th |= (hi & NH) << 1;
  t |= (lo & NA) >>> 1; th |= (hi & NA) >>> 1;
  t |= lo << 8; th |= (hi << 8) | (lo >>> 24);
  t |= (lo >>> 8) | (hi << 24); th |= hi >>> 8;
  l = lo & NA; h = hi & NA; t |= l << 7; th |= (h << 7) | (l >>> 25);
  l = lo & NH; h = hi & NH; t |= (l >>> 7) | (h << 25); th |= h >>> 7;
  l = lo & NH; h = hi & NH; t |= l << 9; th |= (h << 9) | (l >>> 23);
  l = lo & NA; h = hi & NA; t |= (l >>> 9) | (h << 23); th |= h >>> 9;
  _xlo = t; _xhi = th;
}

let _parLo = 0, _parHi = 0;
/** 奇数大小空格区域的位掩码 → _parLo/_parHi(对空格做连通分量 + 取奇体积) */
function parityMask(elo, ehi) {
  let rlo = 0, rhi = 0, rest = elo, restH = ehi;
  while (rest | restH) {
    let b, sq;
    if (rest) { b = rest & -rest; rest ^= b; sq = 31 - Math.clz32(b); }
    else { b = restH & -restH; restH ^= b; sq = 63 - Math.clz32(b); }
    let clo = sq < 32 ? b : 0, chi = sq < 32 ? 0 : b;
    for (;;) {
      expand8(clo, chi);
      const nlo = _xlo & elo, nhi = _xhi & ehi;
      if (nlo === clo && nhi === chi) break;
      clo = nlo; chi = nhi;
    }
    rest &= ~clo; restH &= ~chi;
    if ((popcnt(clo) + popcnt(chi)) & 1) { rlo |= clo; rhi |= chi; }
  }
  _parLo = rlo; _parHi = rhi;
}

/** 终局点差 ×100(行棋方视角) */
function terminalDiff() {
  return (popcnt(PLO) + popcnt(PHI) - popcnt(OLO) - popcnt(OHI)) * 100;
}

/** 启发式评估(行棋方视角):位置权重差 + 行动力差 ×8 */
function evaluate() {
  let s = 0, x, b;
  x = PLO; while (x) { b = x & -x; x ^= b; s += W64[31 - Math.clz32(b)]; }
  x = PHI; while (x) { b = x & -x; x ^= b; s += W64[63 - Math.clz32(b)]; }
  x = OLO; while (x) { b = x & -x; x ^= b; s -= W64[31 - Math.clz32(b)]; }
  x = OHI; while (x) { b = x & -x; x ^= b; s -= W64[63 - Math.clz32(b)]; }
  genMoves(PLO, PHI, OLO, OHI);
  const mobP = popcnt(MLO) + popcnt(MHI);
  genMoves(OLO, OHI, PLO, PHI);
  const mobO = popcnt(MLO) + popcnt(MHI);
  /* 加入前沿子项:己方贴空位的子越少越好 */
  const frP = potMob(PLO, PHI, OLO, OHI);
  const frO = potMob(OLO, OHI, PLO, PHI);
  return s + (mobP - mobO) * 8 + (frO - frP) * 3;
}

/* 每层搜索的暂存:着法/排序分/翻子掩码/进位前的 4 字局面 */
const MAX_PLY = 72;
const plyMoves = [], plyScores = [], plyFlipLo = [], plyFlipHi = [];
for (let i = 0; i < MAX_PLY; i++) {
  plyMoves.push(new Int8Array(32));
  plyScores.push(new Int32Array(32));
  plyFlipLo.push(new Int32Array(32));
  plyFlipHi.push(new Int32Array(32));
}
const plySave = new Int32Array(MAX_PLY * 4);

/** 应用 ply 层第 i 个着法(make;unmakeMove 恢复)。
 *  落子后换手:P' = O & ~翻子,O' = P | 落点 | 翻子 */
function makeMove(i, ply) {
  const o = ply << 2;
  plySave[o] = PLO; plySave[o + 1] = PHI; plySave[o + 2] = OLO; plySave[o + 3] = OHI;
  const fl = plyFlipLo[ply][i], fh = plyFlipHi[ply][i];
  const sq = plyMoves[ply][i];
  const mlo = sq < 32 ? 1 << sq : 0, mhi = sq < 32 ? 0 : 1 << (sq - 32);
  const plo = PLO, phi = PHI;
  PLO = OLO & ~fl; PHI = OHI & ~fh;
  OLO = plo | mlo | fl; OHI = phi | mhi | fh;
}

function unmakeMove(ply) {
  const o = ply << 2;
  PLO = plySave[o]; PHI = plySave[o + 1]; OLO = plySave[o + 2]; OHI = plySave[o + 3];
}

/** 交换行棋方(虚着用) */
function swapSides() {
  let w = PLO; PLO = OLO; OLO = w;
  w = PHI; PHI = OHI; OHI = w;
}

/**
 * PVS 负极大搜索:返回对行棋方的分值。
 * 首着全窗口,其余零窗口试探、超界时重搜;置换表提供截断与最优着法排序。
 * exact=true 为残局完全求解:只接受终局精确点差,不调用启发式评估。
 */
function search(depth, alpha, beta, player, ply, exact) {
  nodes++;
  const T = exact ? TT_END : TT_MID;
  const ttMask = exact ? TT_MASK_END : TT_MASK_MID;
  hashPos(player);
  const key = _k1, key2 = _k2;
  const slot = key & ttMask;
  let ttMove = -1;
  if (T.key[slot] === key && T.key2[slot] === key2) {
    ttMove = T.move[slot];
    if (T.depth[slot] >= depth) {
      const v = T.score[slot], f = T.flag[slot];
      if (f === F_EXACT || (f === F_LOWER && v >= beta) || (f === F_UPPER && v <= alpha)) return v;
    }
  }
  if (ply >= MAX_PLY - 2 || depth <= 0) {
    return exact ? terminalDiff() : evaluate();
  }

  genMoves(PLO, PHI, OLO, OHI);
  let mlo = MLO, mhi = MHI;
  if (!(mlo | mhi)) {
    // 无棋可走:对方也无 → 终局;否则虚着换手(不消耗深度)
    genMoves(OLO, OHI, PLO, PHI);
    if (!(MLO | MHI)) return terminalDiff();
    swapSides();
    const v = -search(depth, -beta, -alpha, 3 - player, ply + 1, exact);
    swapSides();
    return v;
  }

  /* 遍历合法着,计算翻子;静态排序分 = 位置权重 + 翻子数 ×2 */
  const moves = plyMoves[ply], scores = plyScores[ply];
  const fll = plyFlipLo[ply], flh = plyFlipHi[ply];
  /* 完全求解:先算一次"奇数空格区域",给落在其中的着法加权 */
  let pLo = 0, pHi = 0;
  if (exact) { parityMask(~(PLO | OLO) | 0, ~(PHI | OHI) | 0); pLo = _parLo; pHi = _parHi; }
  let n = 0;
  while (mlo | mhi) {
    let b, sq;
    if (mlo) { b = mlo & -mlo; mlo ^= b; sq = 31 - Math.clz32(b); }
    else { b = mhi & -mhi; mhi ^= b; sq = 63 - Math.clz32(b); }
    moveFlips(sq < 32 ? b : 0, sq < 32 ? 0 : b, OLO, OHI);
    const fc = popcnt(_lo) + popcnt(_hi);
    /* 完全求解时:奇区域 > 偶区域;同区域内翻子少的优先(减少对手行动力) */
    const par = exact ? ((sq < 32 ? (pLo >>> sq) : (pHi >>> (sq - 32))) & 1) : 0;
    moves[n] = sq; scores[n] = W64[sq] + (exact ? -fc : fc) * 2 + par * 1000; fll[n] = _lo; flh[n] = _hi;
    n++;
  }
  /* 插入排序(降序),置换表最优着法提到队首(四个平行数组同步移动) */
  for (let i = 1; i < n; i++) {
    const m = moves[i], s = scores[i], fl = fll[i], fh = flh[i];
    let j = i - 1;
    while (j >= 0 && scores[j] < s) {
      moves[j + 1] = moves[j]; scores[j + 1] = scores[j];
      fll[j + 1] = fll[j]; flh[j + 1] = flh[j];
      j--;
    }
    moves[j + 1] = m; scores[j + 1] = s; fll[j + 1] = fl; flh[j + 1] = fh;
  }
  if (ttMove >= 0 && moves[0] !== ttMove) {
    for (let i = 1; i < n; i++) {
      if (moves[i] !== ttMove) continue;
      // 先存走 ttMove 自己的翻子:右移会覆盖 fll[i]/flh[i],漏存会让
      // moves[0] 配到别人的翻子掩码,make 出非法局面(值全错)
      const fl = fll[i], fh = flh[i];
      for (let j = i; j > 0; j--) {
        moves[j] = moves[j - 1]; scores[j] = scores[j - 1];
        fll[j] = fll[j - 1]; flh[j] = flh[j - 1];
      }
      moves[0] = ttMove; fll[0] = fl; flh[0] = fh;
      break;
    }
  }

  let best = -INF, bestMove = moves[0];
  const a0 = alpha;
  for (let i = 0; i < n; i++) {
    makeMove(i, ply);
    let v;
    if (i === 0) {
      v = -search(depth - 1, -beta, -alpha, 3 - player, ply + 1, exact);
    } else {
      v = -search(depth - 1, -alpha - 1, -alpha, 3 - player, ply + 1, exact);
      if (alpha < v && v < beta) v = -search(depth - 1, -beta, -v, 3 - player, ply + 1, exact);
    }
    unmakeMove(ply);
    if (v > best) { best = v; bestMove = moves[i]; }
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  T.key[slot] = key;
  T.key2[slot] = key2;
  T.depth[slot] = depth;
  T.flag[slot] = best >= beta ? F_LOWER : best > a0 ? F_EXACT : F_UPPER;
  T.score[slot] = best;
  T.move[slot] = bestMove;
  return best;
}

/** UI 棋盘('b'/'w'/null)→ 位棋盘;P = aiColor 一方 */
function toBitboard(board, aiColor) {
  let blo = 0, bhi = 0, wlo = 0, whi = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const v = board[r][c];
    if (!v) continue;
    const p = r * 8 + c;
    if (v === 'b') { if (p < 32) blo |= 1 << p; else bhi |= 1 << (p - 32); }
    else { if (p < 32) wlo |= 1 << p; else whi |= 1 << (p - 32); }
  }
  const black = aiColor === 'b';
  PLO = black ? blo : wlo; PHI = black ? bhi : whi;
  OLO = black ? wlo : blo; OHI = black ? whi : bhi;
}

const yieldUI = () => new Promise((r) => setTimeout(r, 0));

/**
 * AI 思考入口:初级直接贪心;中/高级迭代加深 PVS,残局完全求解
 * (求解前先跑中层迭代加深确定根排序)。
 * onProgress(info, done) 把每轮结果写给界面;shouldAbort() 为真则放弃本次结果。
 */
async function think(board, aiColor, level, onProgress, shouldAbort) {
  const ai = aiColor === 'b' || aiColor === BLACK ? BLACK : WHITE; // UI 传 'b'/'w',引擎内部用 1/2
  const aiOpp = 3 - ai;
  toBitboard(board, aiColor);
  nodes = 0;
  const t0 = performance.now();
  const empties = 64 - (popcnt(PLO) + popcnt(PHI) + popcnt(OLO) + popcnt(OHI));
  const exact = empties <= level.end;

  /* 根着法:生成掩码、逐个求翻子,静态分 = 位置权重 + 翻子数 ×2(存入 ply 0 暂存区) */
  genMoves(PLO, PHI, OLO, OHI);
  const moves = plyMoves[0], scores = plyScores[0];
  const fll = plyFlipLo[0], flh = plyFlipHi[0];
  let n0 = 0;
  let mlo = MLO, mhi = MHI;
  while (mlo | mhi) {
    let b, sq;
    if (mlo) { b = mlo & -mlo; mlo ^= b; sq = 31 - Math.clz32(b); }
    else { b = mhi & -mhi; mhi ^= b; sq = 63 - Math.clz32(b); }
    moveFlips(sq < 32 ? b : 0, sq < 32 ? 0 : b, OLO, OHI);
    moves[n0] = sq;
    scores[n0] = W64[sq] + (popcnt(_lo) + popcnt(_hi)) * 2;
    fll[n0] = _lo; flh[n0] = _hi;
    n0++;
  }
  if (!n0) return null;

  /* 按静态分排好根着法顺序(后续迭代按搜索分重排) */
  const order = [];
  for (let i = 0; i < n0; i++) order.push(i);
  order.sort((a, b) => scores[b] - scores[a]);
  const rootV = new Array(n0).fill(0);

  /** 一轮根搜索(PVS):并按本轮得分重排 order 供下一轮迭代排序 */
  const runRoot = (depth, exactMode) => {
    let alpha = -INF;
    const beta = INF;
    for (let k = 0; k < order.length; k++) {
      const i = order[k];
      makeMove(i, 0);
      if (k === 0) {
        rootV[i] = -search(depth - 1, -beta, -alpha, aiOpp, 1, exactMode);
      } else {
        rootV[i] = -search(depth - 1, -alpha - 1, -alpha, aiOpp, 1, exactMode);
        if (alpha < rootV[i] && rootV[i] < beta) {
          rootV[i] = -search(depth - 1, -beta, -rootV[i], aiOpp, 1, exactMode);
        }
      }
      unmakeMove(0);
      if (rootV[i] > alpha) alpha = rootV[i];
    }
    order.sort((a, b) => rootV[b] - rootV[a]);
    return { move: moves[order[0]], score: rootV[order[0]] };
  };

  /* 初级:纯贪心,取静态分最高者 */
  if (level.depth === 0) {
    const res = { greedy: true, move: moves[order[0]], score: scores[order[0]], nodes: n0, ms: performance.now() - t0 };
    onProgress(res, true);
    if (shouldAbort()) return null;
    return res;
  }

  if (exact) {
    /* 前置中层迭代加深(启发式):结果只用于完全求解的根着法排序 */
    const preMax = Math.min(PRE_ENDGAME_DEPTH, level.depth, empties);
    for (let d = 2; d <= preMax; d += 2) {
      if (n0 === 1) break;
      const w = runRoot(d, false);
      onProgress({ warm: true, move: w.move, score: w.score, depth: d, depthMax: preMax, nodes, ms: performance.now() - t0 }, false);
      if (shouldAbort()) return null;
      await yieldUI();
    }
    onProgress({ endgame: true, empties, move: moves[order[0]], nodes: 0, ms: 0, pending: true }, false);
    await yieldUI();
    if (shouldAbort()) return null;
    const r = runRoot(empties + 4, true); // 余量 4:虚着不消耗深度,保证必搜到终局
    const ms = performance.now() - t0;
    onProgress({ endgame: true, empties, move: r.move, score: r.score, nodes, ms }, true);
    if (shouldAbort()) return null;
    return { move: r.move, score: r.score, endgame: true, empties, nodes, ms };
  }

  if (n0 === 1) {
    const res = { move: moves[0], score: 0, only: true, nodes: 0, ms: 0 };
    onProgress(res, true);
    return res;
  }

  let res = null;
  for (let d = 2; d <= level.depth; d += 2) {
    const r = runRoot(d, false);
    res = { move: r.move, score: r.score, depth: d, depthMax: level.depth, nodes, ms: performance.now() - t0 };
    onProgress(res, d === level.depth);
    if (shouldAbort()) return null;
    if (Math.abs(r.score) >= INF / 2) break; // 已搜到终局,无需继续加深
    await yieldUI();
  }
  return res;
}

/* ==================== 基准/测试驱动(不属于对弈路径) ==================== */

/** 清空中局/残局两张置换表(基准测试里保证可复现;对弈路径不清表) */
export function clearTT() {
  for (const T of [TT_MID, TT_END]) {
    T.key.fill(0); T.key2.fill(0); T.depth.fill(0);
    T.flag.fill(0); T.score.fill(0); T.move.fill(-1);
  }
}

/** 根搜索单轮:与 think() 内的 runRoot 等价,但同步执行(无 UI 让步),便于计秒。
 *  静态排序起手,单轮内不做跨深度迭代排序 —— think() 才做迭代加深。 */
export function rootSearch(board, aiColor, depth, exactMode) {
  toBitboard(board, aiColor);
  const aiNum = aiColor === 'b' ? BLACK : WHITE;
  nodes = 0;
  const t0 = performance.now();
  genMoves(PLO, PHI, OLO, OHI);
  const moves = plyMoves[0], scores = plyScores[0];
  const fll = plyFlipLo[0], flh = plyFlipHi[0];
  let n0 = 0, mlo = MLO, mhi = MHI;
  while (mlo | mhi) {
    let b, sq;
    if (mlo) { b = mlo & -mlo; mlo ^= b; sq = 31 - Math.clz32(b); }
    else { b = mhi & -mhi; mhi ^= b; sq = 63 - Math.clz32(b); }
    moveFlips(sq < 32 ? b : 0, sq < 32 ? 0 : b, OLO, OHI);
    moves[n0] = sq;
    scores[n0] = W64[sq] + (popcnt(_lo) + popcnt(_hi)) * 2;
    fll[n0] = _lo; flh[n0] = _hi;
    n0++;
  }
  if (!n0) return { move: -1, score: 0, nodes: 0, ms: 0, n0: 0 };
  const order = [];
  for (let i = 0; i < n0; i++) order.push(i);
  order.sort((a, b) => scores[b] - scores[a]);
  const rootV = new Array(n0).fill(0);
  let alpha = -INF;
  const beta = INF;
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    makeMove(i, 0);
    if (k === 0) {
      rootV[i] = -search(depth - 1, -beta, -alpha, 3 - aiNum, 1, exactMode);
    } else {
      rootV[i] = -search(depth - 1, -alpha - 1, -alpha, 3 - aiNum, 1, exactMode);
      if (alpha < rootV[i] && rootV[i] < beta) {
        rootV[i] = -search(depth - 1, -beta, -rootV[i], 3 - aiNum, 1, exactMode);
      }
    }
    unmakeMove(0);
    if (rootV[i] > alpha) alpha = rootV[i];
  }
  order.sort((a, b) => rootV[b] - rootV[a]);
  return { move: moves[order[0]], score: rootV[order[0]], nodes, ms: performance.now() - t0, n0 };
}

/* ---- 测试钩子:直接操作位棋盘状态(对拍用) ---- */
function __setPosition(blo, bhi, wlo, whi, side) {
  const black = side === 'b';
  PLO = black ? blo : wlo; PHI = black ? bhi : whi;
  OLO = black ? wlo : blo; OHI = black ? whi : bhi;
}
function __legal() { genMoves(PLO, PHI, OLO, OHI); return [MLO, MHI]; }
function __flips(sq) {
  genMoves(PLO, PHI, OLO, OHI); // 先生成 P 侧方向填充,供 moveFlips 求交
  moveFlips(sq < 32 ? 1 << sq : 0, sq < 32 ? 0 : 1 << (sq - 32), OLO, OHI);
  return [_lo, _hi];
}
function __pos() { return [PLO, PHI, OLO, OHI]; }
function __make(i, ply) { makeMove(i, ply); }
function __unmake(ply) { unmakeMove(ply); }
function __setMoveSlot(i, sq, flo, fhi) { // 测试用:把着法写入 ply 暂存区供 __make
  plyMoves[0][i] = sq; plyFlipLo[0][i] = flo; plyFlipHi[0][i] = fhi;
}

export {
  /* 对外入口 */
  think, LEVELS,
  /* 搜索原语与常量(基准/研究用) */
  search, W64, PRE_ENDGAME_DEPTH, INF, EMPTY, BLACK, WHITE,
  toBitboard, genMoves, moveFlips, hashPos, fillE, popcnt, evaluate,
  /* 位棋盘状态与输出暂存(live binding,只读视角) */
  nodes, PLO, PHI, OLO, OHI, MLO, MHI, _lo, _hi, _k1,
  /* 测试钩子 */
  __setPosition, __legal, __flips, __pos, __make, __unmake, __setMoveSlot,
};
