/* ============================================================
 * 黑白棋引擎基准/驱动台(直接驱动 src/engine.js,不再是源码快照)
 *
 * 用法:
 *   node bench/bench.mjs <micro|bench|nps|endgame|endnodes|selfplay|moves|endmoves|all>
 *   node bench/bench.mjs serve     # 引擎服务模式:stdin 读「局面 深度 行棋方」,stdout 吐着法
 *                                   (bench/duel.mjs 的被测端就是这个)
 *
 * 注:旧版的 stats / idstats 两个模式在此版本中移除 —— 它们依赖一份
 * 带插桩计数器的引擎快照,而该插桩早已不在生产引擎里(迁移前这两个
 * 模式就已 ReferenceError);历史输出数据见 docs/reversi-ai-optimization.md。
 *
 * micro 模式说明:PLO/PHI/OLO/OHI、_lo/_k1、nodes 等以 live binding
 * 形式从引擎模块导入(只读),读到的始终是引擎当前状态。
 * ============================================================ */
import {
  LEVELS, W64, PRE_ENDGAME_DEPTH, INF, BLACK, WHITE,
  toBitboard, genMoves, moveFlips, hashPos, fillE, popcnt, evaluate,
  rootSearch, clearTT,
  nodes, PLO, PHI, OLO, OHI, MLO, MHI, _lo, _k1,
  __setPosition, __legal, __flips, __pos, __make, __unmake, __setMoveSlot,
} from '../src/engine.js';

/* ==================== 基准测试驱动(不属于应用代码) ==================== */

/* UI 侧的同名工具函数(引擎部分未抽取,这里补上) */
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const inB = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
const other = (p) => (p === 'b' ? 'w' : 'b');
const moveName = (p) => 'abcdefgh'[p & 7] + ((p >> 3) + 1);

function flipsFor(b, r, c, color) {
  if (b[r][c]) return [];
  const flips = [];
  for (const [dr, dc] of DIRS) {
    const line = [];
    let rr = r + dr, cc = c + dc;
    while (inB(rr, cc) && b[rr][cc] && b[rr][cc] !== color) { line.push([rr, cc]); rr += dr; cc += dc; }
    if (line.length && inB(rr, cc) && b[rr][cc] === color) flips.push(...line);
  }
  return flips;
}

function legalMoves(b, color) {
  const out = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    if (!b[r][c] && flipsFor(b, r, c, color).length) out.push([r, c]);
  }
  return out;
}

function applyMove(b, r, c, color) {
  const flips = flipsFor(b, r, c, color);
  const nb = b.map((row) => [...row]);
  nb[r][c] = color;
  for (const [fr, fc] of flips) nb[fr][fc] = color;
  return { board: nb, flipped: flips };
}

function parseBoard(s) {
  const lines = s.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const b = [];
  for (let r = 0; r < 8; r++) {
    const row = [];
    for (let c = 0; c < 8; c++) {
      const ch = lines[r][c];
      row.push(ch === 'b' ? 'b' : ch === 'w' ? 'w' : null);
    }
    b.push(row);
  }
  return b;
}

const emptiesOf = (b) => {
  let n = 0;
  for (const row of b) for (const v of row) if (!v) n++;
  return n;
};

/** 从起始局面确定性地走出 plies 手,得到测试局面(用固定种子伪随机) */
function randomPosition(plies, seedIn = 12345) {
  let b = parseBoard(`
    ........
    ........
    ........
    ...wb...
    ...bw...
    ........
    ........
    ........`);
  let seed = seedIn;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let turn = 'b';
  for (let k = 0; k < plies; k++) {
    const ms = legalMoves(b, turn);
    if (!ms.length) {
      if (!legalMoves(b, other(turn)).length) break;
      turn = other(turn); continue;
    }
    const [r, c] = ms[Math.floor(rnd() * ms.length)];
    b = applyMove(b, r, c, turn).board;
    turn = other(turn);
  }
  return b;
}

/** 与 think() 内部一致的完整流程(含残局完全求解),用于端到端计时 */
async function fullThink(board, aiColor, level) {
  const pre = PRE_ENDGAME_DEPTH;
  clearTT();
  const ai = aiColor === 'b' ? BLACK : WHITE;
  toBitboard(board, aiColor);
  const t0 = performance.now();
  const empties = 64 - (popcnt(PLO) + popcnt(PHI) + popcnt(OLO) + popcnt(OHI));
  if (empties <= level.end) {
    // 残局:前置中层 + 完全求解(rootSearch 无 UI 让步,需自行算预搜深度)
    const preMax = Math.min(pre, level.depth, empties);
    for (let d = 2; d <= preMax; d += 2) rootSearch(board, aiColor, d, false);
    const r = rootSearch(board, aiColor, empties + 4, true);
    return { move: r.move, score: r.score, nodes, ms: performance.now() - t0, endgame: true, empties };
  }
  let res = null;
  for (let d = 2; d <= level.depth; d += 2) {
    // 与 think() 一致:迭代之间不清表,浅层结果供深层复用
    res = rootSearch(board, aiColor, d, false);
  }
  return { move: res.move, score: res.score, nodes, ms: performance.now() - t0, endgame: false, empties };
}

/* ---- 自对弈:N 手固定深度,统计总节点/总耗时 ---- */

function selfPlay(plies, depth) {
  let plo = 0, phi = 0, olo = 0, ohi = 0;
  /* 本函数的 plo/olo 是「行棋方/对方」语义,而 __setPosition 的四个参数是
   * 「黑/白」语义 —— 必须按 player 的实际颜色摆放,否则白方行棋时引擎的
   * P/O 装反,求翻子与 makeMove 都会算到对方头上(webos 原版 selfPlay 就
   * 带着这个错,自对弈统计的手数/节点因此失真,此处已修正)。 */
  const setEngineToPlayer = () => {
    if (player === BLACK) __setPosition(plo, phi, olo, ohi, 'b');
    else __setPosition(olo, ohi, plo, phi, 'w');
  };
  // 起始局面
  for (const [p, color] of [[27, 'w'], [28, 'b'], [35, 'b'], [36, 'w']]) {
    if (color === 'b') { if (p < 32) plo |= 1 << p; else phi |= 1 << (p - 32); }
    else { if (p < 32) olo |= 1 << p; else ohi |= 1 << (p - 32); }
  }
  let player = BLACK;
  let totalNodes = 0, totalMs = 0, moves = 0;
  for (let k = 0; k < plies; k++) {
    setEngineToPlayer();
    const [mlo, mhi] = __legal();
    if (!(mlo | mhi)) {
      // 换对方视角看是否有棋:无 → 终局,有 → 虚着换手
      if (player === BLACK) __setPosition(plo, phi, olo, ohi, 'w');
      else __setPosition(olo, ohi, plo, phi, 'b');
      const [nlo, nhi] = __legal();
      if (!(nlo | nhi)) break;
      const w = plo; plo = olo; olo = w;
      const w2 = phi; phi = ohi; ohi = w2;
      player = 3 - player;
      continue;
    }
    const boardArr = bitToBoard(plo, phi, olo, ohi, player);
    const res = rootSearch(boardArr, player === BLACK ? 'b' : 'w', depth, false);
    totalNodes += nodes; totalMs += res.ms; moves++;
    setEngineToPlayer();
    const [flo, fhi] = __flips(res.move);
    __setMoveSlot(0, res.move, flo, fhi);
    __make(0, 0);
    [plo, phi, olo, ohi] = __pos();
    player = 3 - player;
  }
  return { moves, totalNodes, totalMs };
}

function bitToBoard(plo, phi, olo, ohi, player) {
  const b = Array.from({ length: 8 }, () => Array(8).fill(null));
  const put = (lo, hi, ch) => {
    for (let p = 0; p < 64; p++) {
      const bit = p < 32 ? (lo >>> p) & 1 : (hi >>> (p - 32)) & 1;
      if (bit) b[p >> 3][p & 7] = ch;
    }
  };
  if (player === BLACK) { put(plo, phi, 'b'); put(olo, ohi, 'w'); }
  else { put(plo, phi, 'w'); put(olo, ohi, 'b'); }
  return b;
}

/* ---- 主流程 ---- */

const MODE = process.argv[2] || 'nps';
const LEVELS_FOR_BENCH = [
  { name: '中级(4层)', depth: 4, end: 8 },
  { name: '高级(8层)', depth: 8, end: 14 },
];
function fmt(n) { return n.toLocaleString('en-US'); }

/** 64 字符串(row-major,'b'/'w'/'.')→ UI 棋盘 */
function parseBoard64(s) {
  const b = [];
  for (let r = 0; r < 8; r++) {
    const row = [];
    for (let c = 0; c < 8; c++) {
      const ch = s[r * 8 + c];
      row.push(ch === 'b' ? 'b' : ch === 'w' ? 'w' : null);
    }
    b.push(row);
  }
  return b;
}


/* ---- 引擎服务模式:从 stdin 逐行读「局面 深度 行棋方」,向 stdout 吐着法 ---- */
if (process.argv[2] === 'serve') {
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const [pos, depthS, color] = line.split(' ');
      const b = parseBoard64(pos);
      // 不清表:与真实对局一致(think() 全程复用同一张表)
      const r = rootSearch(b, color, +depthS, false);
      process.stdout.write(moveName(r.move) + '\n');
    }
  });
}


if (MODE === 'micro') {
  const b = randomPosition(24);
  toBitboard(b, 'w');
  const N = 3000000;
  const bench = (label, fn) => {
    fn(); // 预热/JIT
    const t = performance.now();
    fn();
    const ms = performance.now() - t;
    console.log(`${label.padEnd(24)} ${(ms * 1e6 / N).toFixed(1).padStart(8)} ns/次   (${ms.toFixed(0)}ms / ${fmt(N)} 次)`);
  };
  let acc = 0;
  const plo = PLO, phi = PHI, olo = OLO, ohi = OHI;
  bench('hashPos(全盘扫描)', () => { for (let i = 0; i < N; i++) { hashPos(1); acc ^= _k1; } });
  bench('genMoves(8 次 fill)', () => { for (let i = 0; i < N; i++) { genMoves(plo, phi, olo, ohi); acc ^= MLO; } });
  bench('fillE ×1', () => { for (let i = 0; i < N; i++) { fillE(plo, phi, olo, ohi); acc ^= _lo; } });
  bench('popcnt ×4', () => { for (let i = 0; i < N; i++) { acc ^= popcnt(plo) + popcnt(phi) + popcnt(olo) + popcnt(ohi); } });
  bench('evaluate()', () => { for (let i = 0; i < N; i++) { acc ^= evaluate(); } });
  genMoves(plo, phi, olo, ohi);
  const sq0 = 31 - Math.clz32((MLO || MHI) & -(MLO || MHI));
  bench('moveFlips ×1', () => {
    for (let i = 0; i < N; i++) {
      moveFlips(sq0 < 32 ? 1 << sq0 : 0, sq0 < 32 ? 0 : 1 << (sq0 - 32), olo, ohi);
      acc ^= _lo;
    }
  });
  console.log('(校验位 ' + acc + ')');
  const r = (clearTT(), rootSearch(b, 'w', 8, false));
  console.log(`参考:该局面 8 层搜索 ${fmt(r.nodes)} 节点 / ${r.ms.toFixed(0)}ms → ${(r.ms * 1e6 / r.nodes).toFixed(0)} ns/节点`);
}


if (MODE === 'micro') {
  const b = randomPosition(24);
  toBitboard(b, 'w');
  const N = 3000000;
  const bench = (label, fn) => {
    fn(); // 预热/JIT
    const t = performance.now();
    fn();
    const ms = performance.now() - t;
    console.log(`${label.padEnd(24)} ${(ms * 1e6 / N).toFixed(1).padStart(8)} ns/次   (${ms.toFixed(0)}ms / ${fmt(N)} 次)`);
  };
  let acc = 0;
  const plo = PLO, phi = PHI, olo = OLO, ohi = OHI;
  bench('hashPos(全盘扫描)', () => { for (let i = 0; i < N; i++) { hashPos(1); acc ^= _k1; } });
  bench('genMoves(8 次 fill)', () => { for (let i = 0; i < N; i++) { genMoves(plo, phi, olo, ohi); acc ^= MLO; } });
  bench('fillE ×1', () => { for (let i = 0; i < N; i++) { fillE(plo, phi, olo, ohi); acc ^= _lo; } });
  bench('popcnt ×4', () => { for (let i = 0; i < N; i++) { acc ^= popcnt(plo) + popcnt(phi) + popcnt(olo) + popcnt(ohi); } });
  bench('evaluate()', () => { for (let i = 0; i < N; i++) { acc ^= evaluate(); } });
  genMoves(plo, phi, olo, ohi);
  const sq0 = 31 - Math.clz32((MLO || MHI) & -(MLO || MHI));
  bench('moveFlips ×1', () => {
    for (let i = 0; i < N; i++) {
      moveFlips(sq0 < 32 ? 1 << sq0 : 0, sq0 < 32 ? 0 : 1 << (sq0 - 32), olo, ohi);
      acc ^= _lo;
    }
  });
  console.log('(校验位 ' + acc + ')');
  const r = (clearTT(), rootSearch(b, 'w', 8, false));
  console.log(`参考:该局面 8 层搜索 ${fmt(r.nodes)} 节点 / ${r.ms.toFixed(0)}ms → ${(r.ms * 1e6 / r.nodes).toFixed(0)} ns/节点`);
}

/* stats / idstats 模式已移除:依赖早已不存在的插桩计数器(见文件头注释) */

if (MODE === 'bench') {
  const positions = [12, 20, 28, 36, 44, 52].map(randomPosition);
  const usable = positions.filter((b) => emptiesOf(b) > 14);
  for (const depth of [5, 6, 7, 8]) {
    let totNodes = 0, best = Infinity;
    for (let rep = 0; rep < 4; rep++) {
      let ms = 0, nd = 0;
      for (const b of usable) {
        clearTT();
        const r = rootSearch(b, 'w', depth, false);
        ms += r.ms; nd += r.nodes;
      }
      if (rep > 0 && ms < best) best = ms;
      if (rep === 0) totNodes = nd;
    }
    console.log(`${fmt(usable.length)} 局面 深度 ${depth} | 合计 ${fmt(totNodes)} 节点 | 最快一轮 ${best.toFixed(0)}ms | ${fmt(Math.round(totNodes / best * 1000))} NPS`);
  }
}

if (MODE === 'nps' || MODE === 'all') {
  const cases = [
    ['开局后 12 手', randomPosition(12)],
    ['中局 24 手', randomPosition(24)],
    ['中后期 40 手', randomPosition(40)],
    ['残局 52 手', randomPosition(52)],
  ];
  for (const [name, b] of cases) {
    for (const lv of LEVELS_FOR_BENCH) {
      if (emptiesOf(b) <= lv.end) continue;
      clearTT();
      const warm = rootSearch(b, 'w', lv.depth, false); // 预热
      clearTT();
      const r = rootSearch(b, 'w', lv.depth, false);
      const nps = r.ms > 0 ? Math.round(r.nodes / r.ms * 1000) : 0;
      console.log(`${name} | ${lv.name} | 空 ${emptiesOf(b)} | 节点 ${fmt(r.nodes)} | ${r.ms.toFixed(1)}ms | ${fmt(nps)} NPS | 最佳 ${moveName(r.move)} 分 ${r.score}`);
    }
  }
}

if (MODE === 'endgame' || MODE === 'all') {
  for (const plies of [46, 47, 48, 49]) {
    const b = randomPosition(plies);
    const e = emptiesOf(b);
    clearTT();
    const r0 = rootSearch(b, 'w', e + 4, true);
    clearTT();
    const t0 = performance.now();
    const r = rootSearch(b, 'w', e + 4, true);
    const ms = performance.now() - t0;
    const nps = ms > 0 ? Math.round(r.nodes / ms * 1000) : 0;
    console.log(`残局完全求解 | 空 ${e} | 节点 ${fmt(r.nodes)} | ${ms.toFixed(1)}ms | ${fmt(nps)} NPS | 最佳 ${moveName(r.move)} 分 ${r.score / 100} 子`);
  }
}

if (MODE === 'endnodes') {
  /* 残局完全求解的节点数。局面由固定种子生成 ⇒ 节点数完全可复现,
     是"纯加速/纯排序"类改动最干净的度量(不受机器噪声影响)。 */
  const bs = [];
  for (const seed of [1, 2, 3, 4, 5]) {
    for (let plies = 40; plies <= 56; plies++) {
      const b = randomPosition(plies, seed * 7919);
      const e = emptiesOf(b);
      if (e >= 8 && e <= 15) bs.push({ b, e, plies, seed });
    }
  }
  const byE = {};
  for (const x of bs) (byE[x.e] = byE[x.e] || []).push(x);
  for (const e of Object.keys(byE).map(Number).sort((a, c) => a - c)) {
    const group = byE[e];
    let tot = 0, ms = 0, ok = true, sig = [];
    for (const x of group) {
      clearTT();
      const r = rootSearch(x.b, 'w', x.e + 4, true);
      tot += r.nodes; ms += r.ms;
      sig.push(`${moveName(r.move)}:${r.score}`);
    }
    console.log(`空 ${String(e).padStart(2)} | 局面 ${group.length} | 合计节点 ${fmt(tot).padStart(14)} | ${ms.toFixed(0).padStart(6)}ms | ${sig.join(' ')}`);
  }
}

if (MODE === 'selfplay' || MODE === 'all') {
  for (const d of [4, 6, 8]) {
    clearTT();
    const r = selfPlay(56, d);
    const nps = r.totalMs > 0 ? Math.round(r.totalNodes / r.totalMs * 1000) : 0;
    console.log(`自对弈 深度 ${d} | ${r.moves} 手 | 总节点 ${fmt(r.totalNodes)} | 总耗时 ${(r.totalMs / 1000).toFixed(2)}s | 平均 ${fmt(nps)} NPS`);
  }
}

if (MODE === 'moves' || MODE === 'all') {
  // 语义回归:固定深度下的最佳着法与分数(优化前后必须一致)
  const cases = [12, 20, 28, 36].map((p) => randomPosition(p));
  const out = [];
  for (const b of cases) {
    for (const d of [4, 6, 8]) {
      clearTT();
      const r = rootSearch(b, 'w', d, false);
      out.push(`${d}:${moveName(r.move)}:${r.score}:${r.nodes}`);
    }
  }
  console.log('MOVES ' + out.join(' '));
}

if (MODE === 'endmoves' || MODE === 'all') {
  const out = [];
  for (const plies of [46, 47, 48, 49]) {
    const b = randomPosition(plies);
    const e = emptiesOf(b);
    clearTT();
    const r = rootSearch(b, 'w', e + 4, true);
    out.push(`${e}:${moveName(r.move)}:${r.score}`);
  }
  console.log('ENDMOVES ' + out.join(' '));
}
