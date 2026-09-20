/* ============================================================
 * wasm 导出层功能冒烟 —— 证明 zig-out/bin/othello.wasm 真能在 JS 里跑起来。
 *
 * 为什么必须有这一条:selftest / probe-eval / probe-exact 全是**原生 exe**
 * 的结论,它们证明的是「引擎逻辑对」;**导出层**(C ABI 边界、u64 拆 lo/hi、
 * @embedFile 的权重书、freestanding 无 import)是另一片代码,一行都还没被
 * 执行过。体积闸门也只量字节、不证明能实例化。
 *
 * 覆盖:
 *   A 实例化:imports 必须为 0(freestanding 漏带依赖时这里会报 missing import)
 *   B 初始化:engineInit() == 0,元信息与 src/zig/weights.bin 头部一致
 *   C 位板拆装:16 元对称不变性 eval(g·p)=eval(p)、eval(换色·p)=−eval(p)
 *       —— **这条专治 lo/hi 拆装写错**:180° 旋转会把 0..3 行与 4..7 行对调,
 *          只传了 lo 的话旋转前后求值必然不等;换色不变性则要求两半都全对。
 *   D 中局 think:初始局面必须给出 4 个合法着法之一;节点预算必须真被遵守
 *   E 自对弈整局:每一手都用 JS 侧独立规则判合法,终局 64 子、计数自洽
 *   F 残局精确解:wasm 的 score 与主分支 JS 引擎逐局面相等(单位换算后)
 *
 * 用法:node tools/probe-wasm.mjs [wasm 路径] [--games N]
 * 退出码:0 全过 / 1 有失败
 * ============================================================ */
import fs from 'node:fs';
import * as E from '../src/engine.js';

const argv = process.argv.slice(2);
const wasmPath = argv.find((a) => !a.startsWith('--')) || 'zig-out/bin/othello.wasm';
const gi = argv.indexOf('--games');
const GAMES = gi >= 0 ? Number(argv[gi + 1]) : 3;

let fails = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) fails++;
  return cond;
};

/* ---------- A. 实例化 ---------- */
const bytes = fs.readFileSync(wasmPath);
const mod = new WebAssembly.Module(bytes);
const imports = WebAssembly.Module.imports(mod);
console.log(`\n[wasm] ${wasmPath}  ${bytes.length} B`);
ok(imports.length === 0, `无外部依赖(freestanding):import 数 = ${imports.length}` +
  (imports.length ? ' → ' + JSON.stringify(imports) : ''));

const X = new WebAssembly.Instance(mod, {}).exports;
const NEED = [
  'engineInit', 'engineReady', 'engineOrbits', 'engineWeightBytes', 'engineScale',
  'engineEval', 'engineThink', 'engineScore', 'engineDepth', 'engineExact',
  'engineNodesLo', 'engineNodesHi', 'engineClear',
  'engineBook', 'engineBookNamePtr', 'engineBookNameLen',
  'engineRootN', 'engineRootMove', 'engineRootScore', 'engineRootExact', 'engineRootTrue',
];
const missing = NEED.filter((n) => typeof X[n] !== 'function');
ok(missing.length === 0, `导出符号齐全(${NEED.length} 个)` + (missing.length ? ` 缺 ${missing}` : ''));

/* ---------- 位板工具(BigInt,只为探针方便;边界上仍拆 lo/hi)---------- */
const B = (r, c) => 1n << BigInt(r * 8 + c);
const lo32 = (b) => Number(b & 0xFFFF_FFFFn);
const hi32 = (b) => Number(b >> 32n);
const popcnt = (b) => {
  let n = 0n, x = b;
  while (x) { n += x & 1n; x >>= 1n; }
  return Number(n);
};
const DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

/** 在 (r,c) 落 own 子能翻掉的对方子(位掩码) */
function flipsAt(own, opp, sq) {
  const r = sq >> 3, c = sq & 7;
  let f = 0n;
  for (const [dr, dc] of DIRS) {
    let rr = r + dr, cc = c + dc;
    const acc = [];
    while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && ((opp >> BigInt(rr * 8 + cc)) & 1n)) {
      acc.push(rr * 8 + cc); rr += dr; cc += dc;
    }
    if (acc.length && rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && ((own >> BigInt(rr * 8 + cc)) & 1n)) {
      for (const s of acc) f |= 1n << BigInt(s);
    }
  }
  return f;
}
function legalMask(own, opp) {
  let m = 0n;
  for (let s = 0; s < 64; s++) {
    if (!((own >> BigInt(s)) & 1n) && !((opp >> BigInt(s)) & 1n) && flipsAt(own, opp, s)) m |= 1n << BigInt(s);
  }
  return m;
}
/** 走一手后**换手**:返回 [新 own, 新 opp] */
function applyMove(own, opp, sq) {
  const f = flipsAt(own, opp, sq);
  const b = 1n << BigInt(sq);
  return [opp & ~f, own | f | b];
}

const INIT_B = B(3, 4) | B(4, 3);
const INIT_W = B(3, 3) | B(4, 4);

const evalBB = (own, opp) => X.engineEval(lo32(own), hi32(own), lo32(opp), hi32(opp));
const thinkBB = (own, opp, depth, endg, bud = 0n) =>
  X.engineThink(lo32(own), hi32(own), lo32(opp), hi32(opp), depth, endg, lo32(bud), hi32(bud));
const lastNodes = () => X.engineNodesLo() + X.engineNodesHi() * 4294967296;

/** 16 元群:D4 的 8 个几何 + 每个再叠一次换色 */
const GEO = [
  (r, c) => [r, c],
  (r, c) => [c, 7 - r],
  (r, c) => [7 - r, 7 - c],
  (r, c) => [7 - c, r],
  (r, c) => [r, 7 - c],
  (r, c) => [7 - r, c],
  (r, c) => [c, r],
  (r, c) => [7 - c, 7 - r],
];
function xform(own, opp, g, swap) {
  let no = 0n, np = 0n;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const [rr, cc] = g(r, c);
    const src = 1n << BigInt(r * 8 + c);
    const dst = 1n << BigInt(rr * 8 + cc);
    if (own & src) no |= dst;
    if (opp & src) np |= dst;
  }
  return swap ? [np, no] : [no, np];
}

/* ---------- B. 初始化 ---------- */
console.log('\n[B] 初始化与元信息');
const failStage = X.engineInit();
ok(failStage === 0, `engineInit() = ${failStage}(0 = 就绪)`);
ok(X.engineReady() === 1, `engineReady() = ${X.engineReady()}`);
ok(X.engineOrbits() === 9475, `engineOrbits() = ${X.engineOrbits()}(期望 9475)`);

const blob = fs.readFileSync('src/zig/weights.bin');
const dvv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
// 头布局(v3):magic u32@0 / version u8@4 / phases u8@5 / 保留 2B / orbits u32@8
//              / 每相位一个 f32 scale @12..(12+4×phases)
// ⚠ v2 = 固定 2 相位(头 20 字节)、v1 = 16 字节头共用 scale —— 均已成历史。
//   改这里必须同步改 src/zig/pattern.zig 的 BLOB_HEADER/BLOB_VERSION 与 tools/gen-blob.mjs。
const bPh = blob[5];
const HEADER_V3 = 12 + 4 * bPh;
const bMagic = dvv.getUint32(0, true), bVer = blob[4];
const bOrb = dvv.getUint32(8, true);
const bScale0 = dvv.getFloat32(12, true);
const allScales = Array.from({ length: bPh }, (_, p) => dvv.getFloat32(12 + 4 * p, true));
ok(bMagic === 0x4F54_484C, `磁盘权重书 magic = 0x${bMagic.toString(16).toUpperCase()}('OTHL')`);
ok(bVer === 3, `磁盘权重书 version = ${bVer}(v3 = 每相位一个 scale,相位数由头声明)`);
ok(X.engineWeightBytes() === blob.length,
  `engineWeightBytes() = ${X.engineWeightBytes()} = ${HEADER_V3} + ${bPh}×${X.engineOrbits()} = ${blob.length} B`);
ok(bOrb === X.engineOrbits() && blob.length === HEADER_V3 + bPh * bOrb,
  `磁盘头部自洽:phases=${bPh} orbits=${bOrb},长度 ${blob.length} = ${HEADER_V3}+${bPh}×${bOrb}`);
ok(Math.abs(bScale0 - X.engineScale()) < 1e-9,
  `engineScale()(相位 0)= ${X.engineScale()} = 磁盘头部 f32 ${bScale0} · 其余 ${allScales.slice(1).map((s) => s.toFixed(4)).join(' / ')}`);

/* ---------- C. 对称不变性(专治 lo/hi 拆装)---------- */
console.log('\n[C] 16 元对称不变性(lo/hi 拆装 + 权重书加载)');
// 随机走子造局面,顺带覆盖两个相位(≤34 子 / >34 子)
function rndPos(rng) {
  let own = INIT_B, opp = INIT_W, side = 0;
  const steps = 8 + Math.floor(rng() * 44);
  for (let i = 0; i < steps; i++) {
    const m = legalMask(own, opp);
    if (!m) { [own, opp] = [opp, own]; continue; }
    const list = [];
    for (let s = 0; s < 64; s++) if ((m >> BigInt(s)) & 1n) list.push(s);
    const sq = list[Math.floor(rng() * list.length)];
    [own, opp] = applyMove(own, opp, sq);
    side ^= 1;
  }
  return [own, opp];
}
let seed = 0x9E3779B9;
const rng = () => ((seed = (seed * 1103515245 + 12345) & 0x7FFF_FFFF) / 0x8000_0000);

let symBad = 0, nSym = 0, ph0 = 0, ph1 = 0;
for (let t = 0; t < 200; t++) {
  const [own, opp] = rndPos(rng);
  const d = popcnt(own | opp);
  if (d <= 34) ph0++; else ph1++;
  const base = evalBB(own, opp);
  for (let gi2 = 0; gi2 < 8; gi2++) {
    const [go, gp] = xform(own, opp, GEO[gi2], false);
    const v1 = evalBB(go, gp);
    const [so, sp] = xform(own, opp, GEO[gi2], true);
    const v2 = evalBB(so, sp);
    nSym++;
    if (!(v1 === base || Math.abs(v1 - base) <= 4e-6) || !(v2 === -base || Math.abs(v2 + base) <= 4e-6)) {
      if (symBad < 3) console.log(`    ✗ 局面#${t} geo#${gi2}: base=${base} geo=${v1} swap=${v2}`);
      symBad++;
    }
  }
}
ok(symBad === 0, `${nSym} 组变换全部满足 eval(g·p)=eval(p)、eval(换色·p)=−eval(p)` +
  (symBad ? `(${symBad} 组失败)` : ''));
ok(ph0 > 20 && ph1 > 20, `两个相位都被覆盖:phase0(d≤34) ${ph0} 局面 / phase1 ${ph1} 局面`);
const vInit = evalBB(INIT_B, INIT_W);
ok(Math.abs(vInit) <= 1e-6, `初始局面 eval = ${vInit}(180° 旋转 + 换色双双不变 ⇒ 必须为 0)`);

/* ---------- D. 中局 think ---------- */
console.log('\n[D] 中局 think');
X.engineClear();
const m0 = thinkBB(INIT_B, INIT_W, 6, 8);
const want0 = [B(2, 3), B(3, 2), B(4, 5), B(5, 4)].map((b) => Number(b.toString(2).length - 1));
ok(m0 >= 0 && want0.includes(m0),
  `初始局面 think(6) → ${m0}(${'abcdefgh'[m0 & 7]}${(m0 >> 3) + 1}),4 个合法着法之一`);
/* ⑩ 开局书命中时 0 节点、depth 0 是合法行为(不搜索直接出着法) */
const bookHit = lastNodes() === 0;
ok(bookHit || X.engineDepth() >= 2, `engineDepth() = ${X.engineDepth()}(书命中或迭代加深至少 2 层)`);
ok(bookHit || lastNodes() > 0, `engineNodes = ${lastNodes()}(书命中则为 0)`);
ok(X.engineExact() === 0, `engineExact() = ${X.engineExact()}(中局不是精确解)`);
/* ⑩b 开局名透传:根局面(书入口)无名;走一手后的 5 子局面带名 —— 数据事实:
 * 该局面由 Diagonal/Parallel/Perpendicular 三条命名开局换位汇成,三名并列。
 * 指针指向 blob(@embedFile 常量)内部,按地址+长度读线性内存。 */
if (bookHit && typeof X.engineBookNamePtr === 'function' && X.memory) {
  ok(X.engineBookNamePtr() === 0, `初始局面书命中:无名(engineBookNamePtr() = 0)`);
  const [o1, p1] = applyMove(INIT_B, INIT_W, m0);
  thinkBB(o1, p1, 6, 8);
  const np = X.engineBookNamePtr(), nl = X.engineBookNameLen();
  const nm = np > 0 && nl > 0
    ? new TextDecoder().decode(new Uint8Array(X.memory.buffer, np, nl)) : '';
  ok(X.engineBook() === 1 && nm === 'Diagonal Opening / Parallel Opening / Perpendicular Opening',
    `首手后书命中带开局名:${JSON.stringify(nm)}`);
}
/* ⑩c 根着法清单(选着策略上移到 JS 后的输出通道):书命中 → 全部首着与
 * **精确**书值(初始 4 着全 0 分,同分位号升序 → 第 0 项 d3,与 engineThink
 * 返回一致);中局搜索 → exact=0:分数是零窗口 fail-soft 的**界**,worker 的
 * 选着只许取第 0 项(曾经引擎内拿界做 1 子容差随机,全档送角掉血)。 */
if (typeof X.engineRootN === 'function') {
  thinkBB(INIT_B, INIT_W, 6, 8);
  const rn = X.engineRootN();
  const all0 = Array.from({ length: rn }, (_, i) => X.engineRootScore(i)).every((v) => Math.abs(v) < 1e-6);
  const allTrue = Array.from({ length: rn }, (_, i) => X.engineRootTrue(i)).every((t) => t === 1);
  ok(X.engineBook() === 1 && rn === 4 && all0 && X.engineRootExact() === 1 && X.engineRootMove(0) === 19,
    `书命中根清单:4 项、全 0 分、精确、第 0 项 d3(n=${rn}, exact=${X.engineRootExact()})`);
  ok(allTrue, `书清单逐着真值标记:全 1(书内子值是精确终局子差)`);
  let mo2, mp2, discs = 0;
  do {
    [mo2, mp2] = rndPos(rng);
    discs = 0;
    for (let x = mo2 | mp2; x; x >>= 1n) discs += Number(x & 1n);
  } while (discs < 20);
  thinkBB(mo2, mp2, 6, 8);
  const rn2 = X.engineRootN();
  const trues = Array.from({ length: rn2 }, (_, i) => X.engineRootTrue(i));
  ok(X.engineBook() === 0 && X.engineRootExact() === 0 && rn2 >= 1 && X.engineRootMove(0) >= 0,
    `中局根清单(${discs} 子):exact=0 · n=${rn2}`);
  ok(X.engineRootTrue(0) === 1,
    `中局清单第 0 项(本轮最优)是真值(engineRootTrue(0)=${X.engineRootTrue(0)})`);
  ok(trues.every((t) => t === 0 || t === 1),
    `逐着真值标记合法:真值 ${trues.filter(Boolean).length} 项、界 ${trues.filter((t) => !t).length} 项(JS 随机只吃真值)`);
  ok(X.engineRootMove(999) === -1, `越界下标防御:engineRootMove(999) = ${X.engineRootMove(999)}`);
}

// 节点预算必须真被遵守:给 2 万节点、标称 20 层
const t0 = performance.now();
const mB = thinkBB(INIT_B, INIT_W, 20, 0, 20_000n);
const msB = performance.now() - t0;
const nB = lastNodes();
ok(mB >= 0 && want0.includes(mB), `预算 20k 节点时仍给出合法着法 ${mB}(用时 ${msB.toFixed(0)} ms)`);
ok(nB <= 20_000 + 512, `节点数 ${nB} 未超过预算 20,000(+512 容差)`);
ok(X.engineDepth() < 20, `标称 20 层被预算截断:实际 engineDepth() = ${X.engineDepth()} < 20`);

/* ---------- E. 自对弈整局:JS 独立规则验合法性 ---------- */
console.log(`\n[E] 自对弈整局合法性(${GAMES} 局,wasm 自己跟自己下)`);
let gBad = 0, gMoves = 0, gMs = 0, passN = 0;
let dMin = 99, dMax = 0;
for (let g = 0; g < GAMES; g++) {
  let own = INIT_B, opp = INIT_W, plies = 0, passes = 0;
  let okThis = true;
  while (plies < 80) {
    const m = legalMask(own, opp);
    if (!m) {
      const mo = legalMask(opp, own);
      if (!mo) break;               // 终局
      passes++; passN++;
      [own, opp] = [opp, own];
      continue;
    }
    X.engineClear();                 // 每手清表,免得半路吃到这一局之外的结论
    const t1 = performance.now();
    const mv = thinkBB(own, opp, 6, 8);
    gMs += performance.now() - t1;
    if (mv < 0 || !((m >> BigInt(mv)) & 1n)) {
      console.log(`    ✗ 第 ${g} 局第 ${plies} 手:wasm 返回 ${mv},不是合法着法`);
      okThis = false; gBad++; break;
    }
    dMin = Math.min(dMin, X.engineDepth()); dMax = Math.max(dMax, X.engineDepth());
    [own, opp] = applyMove(own, opp, mv);
    plies++; gMoves++;
  }
  // 双方都无子可下 ⟺ 盘面已满(黑白棋的终局条件),所以必须是 64
  const total = popcnt(own | opp);
  if (okThis && total !== 64) {
    console.log(`    ✗ 第 ${g} 局终局子数 ${total},应当是 64`);
    gBad++;
  }
}
ok(gBad === 0, `${GAMES} 局全部走完:${gMoves} 手全部合法,终局自洽(虚着 ${passN} 次)`);
ok(gMoves > GAMES * 50, `手数合理:${gMoves} 手 / ${GAMES} 局`);
console.log(`    平均每手 ${(gMs / gMoves).toFixed(1)} ms,depth ${dMin}..${dMax}`);

/* ---------- F. 残局精确解 vs 主分支 JS 引擎 ---------- */
console.log('\n[F] 残局精确解(wasm) vs 主分支 JS 引擎');
const lines = fs.readFileSync('out/e10.txt', 'utf8').split('\n').filter((l) => l.trim());
E.clearTT();
let eBad = 0, eN = 0;
for (const line of lines) {
  const [blo, bhi, wlo, whi, side, empties, want] = line.trim().split(/\s+/).map(Number);
  const black = BigInt(blo >>> 0) | (BigInt(bhi >>> 0) << 32n);
  const white = BigInt(wlo >>> 0) | (BigInt(whi >>> 0) << 32n);
  const own = side === 1 ? black : white;
  const opp = side === 1 ? white : black;

  X.engineClear();
  thinkBB(own, opp, empties + 4, empties + 4);
  const zs = X.engineScore();
  const ze = X.engineExact();

  E.__setPosition(blo >>> 0, bhi >>> 0, wlo >>> 0, whi >>> 0, side === 1 ? 'b' : 'w');
  const js = Math.round(E.search(empties + 4, -E.INF, E.INF, side === 1 ? E.BLACK : E.WHITE, 0, true) / 100);

  eN++;
  if (Math.round(zs) !== js || Math.round(zs) !== want) {
    if (eBad < 5) console.log(`    ✗ 空位 ${empties}: wasm=${zs} js=${js} 已知=${want}`);
    eBad++;
  }
  if (!ze) { if (eBad < 5) console.log(`    ✗ 空位 ${empties}: engineExact()=0,残局没走完全求解`); eBad++; }
}
ok(eBad === 0, `${eN} 个残局:wasm 精确解 = JS 引擎 = 已知值(逐局面)` + (eBad ? `(${eBad} 失败)` : ''));

// 预算截断时 engineExact() 必须为 0:残局分支在 aborted 时返回的只是前置中层
// 迭代的最后一轮,UI 若拿它当判决就会显示一场凭空的胜负。
{
  const [blo, bhi, wlo, whi, side, empties] = lines[0].trim().split(/\s+/).map(Number);
  const black = BigInt(blo >>> 0) | (BigInt(bhi >>> 0) << 32n);
  const white = BigInt(wlo >>> 0) | (BigInt(whi >>> 0) << 32n);
  const own = side === 1 ? black : white, opp = side === 1 ? white : black;
  X.engineClear();
  thinkBB(own, opp, empties + 4, empties + 4, 500n);
  ok(X.engineExact() === 0, `残局求解被 500 节点预算截断时 engineExact() = ${X.engineExact()}(必须为 0)`);
  ok(X.engineNodesLo() + X.engineNodesHi() * 4294967296 <= 500 + 512,
    `截断后节点数 ${lastNodes()} 未超预算`);
}

console.log(fails === 0 ? '\n✓ wasm 导出层冒烟全部通过' : `\n✗ wasm 导出层冒烟失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
