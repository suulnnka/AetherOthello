/* 黑白棋引擎测试:位棋盘规则模糊测试 + 完全求解对拍 + 各难度行为。
 * 运行:node test/engine-test.mjs
 * 原理:直接 import src/engine.js,与一份独立的 2D 数组朴素实现
 * 对拍(规则、合法步、翻子、终局精确分)。 */
import * as api from '../src/engine.js';

/* ---------- 独立参考实现(2D 数组,'b'/'w') ---------- */
const oppC = (p) => (p === 'b' ? 'w' : 'b');
const DIRS2 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
function initBd() {
  const bd = Array.from({ length: 8 }, () => Array(8).fill(null));
  bd[3][3] = 'w'; bd[3][4] = 'b'; bd[4][3] = 'b'; bd[4][4] = 'w';
  return bd;
}
function bfFlips(bd, r, c, color) {
  if (bd[r][c]) return [];
  const out = [];
  for (const [dr, dc] of DIRS2) {
    const line = [];
    let rr = r + dr, cc = c + dc;
    while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && bd[rr][cc] && bd[rr][cc] !== color) { line.push([rr, cc]); rr += dr; cc += dc; }
    if (line.length && rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && bd[rr][cc] === color) out.push(...line);
  }
  return out;
}
function bfMoves(bd, color) {
  const out = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++)
    if (!bd[r][c] && bfFlips(bd, r, c, color).length) out.push([r, c]);
  return out;
}
function bfApply(bd, r, c, color) {
  const nb = bd.map((row) => [...row]);
  nb[r][c] = color;
  for (const [fr, fc] of bfFlips(bd, r, c, color)) nb[fr][fc] = color;
  return nb;
}
function bfCount(bd) {
  let b = 0, w = 0;
  for (const row of bd) for (const v of row) { if (v === 'b') b++; else if (v === 'w') w++; }
  return b - w;
}
/** 朴素 alpha-beta 完全搜索:对 color 的精确点差 */
function bf(bd, color, alpha, beta) {
  const moves = bfMoves(bd, color);
  if (!moves.length) {
    if (!bfMoves(bd, oppC(color)).length) {
      const d = bfCount(bd);
      return color === 'b' ? d : -d;
    }
    return -bf(bd, oppC(color), -beta, -alpha);
  }
  let best = -1e9;
  for (const [r, c] of moves) {
    const v = -bf(bfApply(bd, r, c, color), oppC(color), -beta, -alpha);
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}
function bfTop(bd, color) {
  let best = -1e9, bm = -1;
  for (const [r, c] of bfMoves(bd, color)) {
    const v = -bf(bfApply(bd, r, c, color), oppC(color), -1e9, 1e9);
    if (v > best) { best = v; bm = r * 8 + c; }
  }
  return [best, bm];
}
const nameOf = (p) => 'abcdefgh'[p & 7] + ((p >> 3) + 1);
function popcnt(x) {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >>> 24;
}
function bitsOf(lo, hi) {
  const out = [];
  while (lo) { const b = lo & -lo; lo ^= b; out.push(31 - Math.clz32(b)); }
  while (hi) { const b = hi & -hi; hi ^= b; out.push(32 + 31 - Math.clz32(b)); }
  return out;
}

function collectPositions(games, lo, hi) {
  const positions = [];
  for (let g = 0; g < games; g++) {
    let bd = initBd(), color = 'b', passes = 0;
    while (passes < 2) {
      let empties = 0;
      for (const row of bd) for (const v of row) if (!v) empties++;
      if (empties >= lo && empties <= hi && bfMoves(bd, color).length) positions.push({ bd: bd.map((r) => [...r]), color });
      if (empties <= Math.max(4, lo - 2)) break;
      const moves = bfMoves(bd, color);
      if (!moves.length) { passes++; color = oppC(color); continue; }
      passes = 0;
      const m = moves[(Math.random() * moves.length) | 0];
      bd = bfApply(bd, m[0], m[1], color);
      color = oppC(color);
    }
  }
  return positions;
}

let fails = 0;
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { fails++; console.error('FAIL:', msg); } };

/* ---------- 1. 规则模糊测试:合法步集 + 翻子数(位棋盘 vs 2D 参考) ---------- */
async function t1() {
  const positions = collectPositions(500, 4, 60);
  let legalChecks = 0, flipChecks = 0;
  for (const { bd, color } of positions) {
    for (const side of ['b', 'w']) {
      api.__setPosition(...toWords(bd), side);
      const [mlo, mhi] = api.__legal();
      const bb = new Set(bitsOf(mlo, mhi));
      const ref = new Set(bfMoves(bd, side).map(([r, c]) => r * 8 + c));
      ok(bb.size === ref.size && [...bb].every((p) => ref.has(p)),
        `合法步集不一致(${side}): bb=${[...bb].sort().join(',')} ref=${[...ref].sort().join(',')}\n${bdStr(bd)}`);
      legalChecks++;
      for (const p of bb) {
        const [flo, fhi] = api.__flips(p);
        const nbb = popcnt(flo) + popcnt(fhi);
        const nref = bfFlips(bd, p >> 3, p & 7, side).length;
        ok(nbb === nref, `翻子数不一致(${side} @${nameOf(p)}): bb=${nbb} ref=${nref}\n${bdStr(bd)}`);
        ok(nbb > 0, `合法步翻子数为 0 @${nameOf(p)}\n${bdStr(bd)}`);
        flipChecks++;
      }
    }
  }
  console.log(`1) 规则模糊测试 ✓ ${legalChecks} 组合法步 / ${flipChecks} 格翻子 全一致`);
}
function toWords(bd) {
  let blo = 0, bhi = 0, wlo = 0, whi = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const v = bd[r][c];
    if (!v) continue;
    const p = r * 8 + c;
    if (v === 'b') { if (p < 32) blo |= 1 << p; else bhi |= 1 << (p - 32); }
    else { if (p < 32) wlo |= 1 << p; else whi |= 1 << (p - 32); }
  }
  return [blo, bhi, wlo, whi];
}
function bdStr(bd) {
  return '  ' + bd.map((row) => row.map((v) => v === 'b' ? 'X' : v === 'w' ? 'O' : '.').join(' ')).join('\n  ');
}

/* ---------- 1b. make/unmake 落子转换对拍 ---------- */
async function t1b() {
  const positions = collectPositions(400, 4, 60);
  let transChecks = 0;
  for (const { bd, color } of positions) {
    api.__setPosition(...toWords(bd), color);
    const [mlo, mhi] = api.__legal();
    const legal = bitsOf(mlo, mhi);
    for (const sq of legal) {
      const before = api.__pos();
      const [flo, fhi] = api.__flips(sq);
      // 参考落子后局面
      const nb = bfApply(bd, sq >> 3, sq & 7, color);
      const [rlo, rhi, olo2, ohi2] = toWords(nb); // 黑、白
      // 引擎 make:P=落子方 → 落子后 P=原对方,O=落子方
      api.__setMoveSlot(0, sq, flo, fhi);
      api.__make(0, 0);
      const after = api.__pos();
      const opp = oppC(color);
      const expP = color === 'b' ? [olo2, ohi2] : [rlo, rhi];
      const expO = color === 'b' ? [rlo, rhi] : [olo2, ohi2];
      ok(after[0] === expP[0] && after[1] === expP[1] && after[2] === expO[0] && after[3] === expO[1],
        `make 转换不一致(${color} @${nameOf(sq)})\n${bdStr(bd)}`);
      api.__unmake(0);
      const restored = api.__pos();
      ok(restored.every((v, k) => v === before[k]), `unmake 未恢复原局面 @${nameOf(sq)}\n${bdStr(bd)}`);
      transChecks++;
    }
  }
  console.log(`1b) make/unmake 转换 ✓ ${transChecks} 次落子全部一致`);
}

/* ---------- 2. 残局完全求解对拍(6-9 空,高级) ---------- */
async function t2() {
  const positions = collectPositions(300, 6, 9);
  let maxE = 0;
  for (const { bd, color } of positions) {
    const t0 = performance.now();
    const res = await api.think(bd, color, api.LEVELS[2], () => {}, () => false);
    maxE = Math.max(maxE, performance.now() - t0);
    const [refScore] = bfTop(bd, color);
    ok(res && res.endgame === true, `应走残局路径: ${JSON.stringify(res)}`);
    ok(res && res.score === refScore * 100, `分数不等: engine=${res && res.score} ref=${refScore * 100}`);
    const moves = bfMoves(bd, color).map(([r, c]) => r * 8 + c);
    ok(res && moves.includes(res.move) &&
      (res.score !== refScore * 100 ||
        res.score === -bf(bfApply(bd, res.move >> 3, res.move & 7, color), oppC(color), -1e9, 1e9) * 100),
      `最佳步非最优: engine=${res && nameOf(res.move)}`);
  }
  console.log(`2) 6-9 空完全求解对拍 ✓ ${positions.length} 局,最大耗时 ${maxE.toFixed(0)}ms`);
}

/* ---------- 3. 10-12 空对拍(抽样) ---------- */
async function t3() {
  const positions = collectPositions(40, 10, 12);
  let tE = 0;
  for (const { bd, color } of positions) {
    const t0 = performance.now();
    const res = await api.think(bd, color, api.LEVELS[2], () => {}, () => false);
    tE += performance.now() - t0;
    const [refScore] = bfTop(bd, color);
    ok(res && res.endgame === true && res.score === refScore * 100,
      `分数不等: engine=${res && res.score} ref=${refScore * 100}`);
  }
  console.log(`3) 10-12 空对拍 ✓ ${positions.length} 局,合计 ${(tE / 1000).toFixed(1)}s`);
}

/* ---------- 4. 阈值边界与难度行为 ---------- */
async function t4() {
  const lv = api.LEVELS;
  ok(lv[0].depth === 0 && lv[1].depth === 4 && lv[1].end === 8 && lv[2].depth === 8 && lv[2].end === 14,
    `难度配置异常: ${JSON.stringify(lv.map((l) => [l.depth, l.end]))}`);
  const p14 = collectPositions(400, 14, 14)[0];
  const p15 = collectPositions(400, 15, 15)[0];
  if (p14) {
    const res = await api.think(p14.bd, p14.color, lv[2], () => {}, () => false);
    ok(res && res.endgame === true && res.empties === 14, `14 空应完全求解: ${JSON.stringify(res)}`);
    console.log(`4a) 高级 14 空 → 完全求解 ✓ ${nameOf(res.move)} 精确 ${res.score / 100} 子 ${res.ms.toFixed(0)}ms 节点 ${res.nodes}`);
  }
  if (p15) {
    const res = await api.think(p15.bd, p15.color, lv[2], () => {}, () => false);
    ok(res && res.endgame !== true && res.depthMax === 8, `15 空应中局深度 8: ${JSON.stringify(res)}`);
    console.log(`4b) 高级 15 空 → 中局 ✓ ${nameOf(res.move)} ${res.ms.toFixed(0)}ms`);
  }
  const p9 = collectPositions(400, 9, 9)[0];
  const p7 = collectPositions(400, 7, 7)[0];
  if (p9) {
    const res = await api.think(p9.bd, p9.color, lv[1], () => {}, () => false);
    ok(res && res.endgame !== true && res.depthMax === 4, `中级 9 空应中局 4 层: ${JSON.stringify(res)}`);
  }
  if (p7) {
    const res = await api.think(p7.bd, p7.color, lv[1], () => {}, () => false);
    ok(res && res.endgame === true, `中级 7 空应完全求解: ${JSON.stringify(res)}`);
    const moves = bfMoves(p7.bd, p7.color).map(([r, c]) => r * 8 + c);
    ok(res && moves.includes(res.move), '中级着法应合法');
    console.log(`4c) 中级 9 空中局 / 7 空完全求解 ✓`);
  }
  const g = collectPositions(50, 8, 40)[0];
  const res = await api.think(g.bd, g.color, lv[0], () => {}, () => false);
  const moves = bfMoves(g.bd, g.color).map(([r, c]) => r * 8 + c);
  ok(res && res.greedy === true && moves.includes(res.move), `初级应贪心且合法: ${JSON.stringify(res)}`);
  const flips = bfFlips(g.bd, res.move >> 3, res.move & 7, g.color).length;
  ok(res && res.score === api.W64[res.move] + flips * 2, `初级评分应=权重+2×翻子: ${res.score} vs ${api.W64[res.move] + flips * 2}`);
  console.log(`4d) 初级贪心 ✓ ${nameOf(res.move)} 评分 ${res.score}`);
}

/* ---------- 5. 中局性能(随机中盘局面,高级) ---------- */
async function t5() {
  const positions = collectPositions(3, 20, 32);
  for (const { bd, color } of positions) {
    let empties = 0;
    for (const row of bd) for (const v of row) if (!v) empties++;
    if (empties <= api.LEVELS[2].end) continue;
    const res = await api.think(bd, color, api.LEVELS[2], () => {}, () => false);
    const nps = res.ms > 0 ? Math.round(res.nodes / res.ms * 1000) : 0;
    console.log(`5) 中局(${empties} 空): ${nameOf(res.move)} 评估 ${res.score} 节点 ${res.nodes} ${res.ms.toFixed(0)}ms(${fmtNps(nps)})`);
  }
  function fmtNps(n) { return n >= 10000 ? (n / 10000).toFixed(0) + '万/s' : n + '/s'; }
}

/* ---------- 6. 已捕获回归用例(确定性,调试中抓到过的错误局面) ---------- */
async function t6() {
  /* 每项:棋盘(X黑 O白 .空)、行棋方、当时的症状(修复后应全部与参考一致) */
  const CASES = [
    ['6 空 NODE-MAX-WRONG:TT 碰撞返回错值(引擎-600/真值+200)', [
      'XXXXXXXX', 'XX.XXXXX', '.XXXOOOX', 'XXXXOOXX',
      'OXXXXXXX', 'OXXXXOX.', 'OOXOXOXO', 'OO.OOO..',
    ], 'w'],
    ['1 空终局:翻子掩码参数错误(引擎-1600/真值-2200)', [
      'XXXXXXXX', 'XXOXXXXX', 'XXOXXOOX', 'OXOXOOXX',
      'OXXXXXXX', 'XXXXXOXO', 'XXXXXXXO', 'OOXXXXX.',
    ], 'w'],
    ['2 空虚着节点:哈希碰撞(引擎-2800/真值-2600)', [
      'XXXXXXXX', 'XXOXXXXX', 'XXOXXOOX', 'OXOXOOXX',
      'OXXXXXXX', 'XXXXXOXO', 'XXXXXXXO', 'OOXXXXX.',
    ], 'w'],
  ];
  for (let i = 0; i < CASES.length; i++) {
    const [desc, rows, color] = CASES[i];
    const bd = rows.map((s) => [...s].map((ch) => (ch === 'X' ? 'b' : ch === 'O' ? 'w' : null)));
    const res = await api.think(bd, color, api.LEVELS[2], () => {}, () => false);
    const ref = bf(bd, color, -1e9, 1e9) * 100;
    ok(res && res.score === ref,
      `回归用例 #${i + 1} 失败(${desc}): engine=${res && res.score} 真值=${ref}\n${bdStr(bd)}`);
    console.log(`6.${i + 1}) 回归用例(${desc.slice(0, desc.indexOf(':'))}) ✓ engine=${res.score} 真值=${ref}`);
  }
}

/* ---------- 用例选择(与 e2e.mjs 的分组参数一致):
 *   node test/engine-test.mjs          全部
 *   node test/engine-test.mjs 2        只跑第 2 节
 *   node test/engine-test.mjs 1 1b 4   跑指定多节
 *   node test/engine-test.mjs --list   列出全部用例 ---------- */
const TESTS = [
  ['1', '规则模糊测试(合法步集+翻子数)', t1],
  ['1b', 'make/unmake 落子转换对拍', t1b],
  ['2', '残局完全求解对拍 6-9 空', t2],
  ['3', '10-12 空对拍(抽样)', t3],
  ['4', '阈值边界与难度行为', t4],
  ['5', '中局性能', t5],
  ['6', '已捕获回归用例(确定性)', t6],
];
const argv = process.argv.slice(2);
if (argv.includes('--list')) {
  for (const [id, name] of TESTS) console.log(`  ${id.padEnd(3)} ${name}`);
  process.exit(0);
}
const picked = argv.length
  ? TESTS.filter(([id]) => argv.some((a) => a.replace(/^t/i, '') === id))
  : TESTS;
if (!picked.length) {
  console.error(`未识别的用例编号: ${argv.join(', ')}(--list 查看全部)`);
  process.exit(2);
}
for (const [, , fn] of picked) await fn();
console.log(fails === 0 ? `\n全部通过 ✓(共 ${checks} 项断言)` : `\n${fails} 项失败 ✗`);
process.exit(fails === 0 ? 0 : 1);
