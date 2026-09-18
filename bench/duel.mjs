/* 双引擎对弈验证台:让两份引擎实现互相对弈,统计胜负。
 *
 * 用法:
 *   node bench/duel.mjs <引擎A文件> <引擎B文件> [局数] [深度] [随机开局手数]
 *
 * 每个引擎以 `serve` 模式常驻子进程,通过 stdin/stdout 交换着法。
 * 每局双方各执黑一次(轮流),随机开局保证局面多样性。
 * 子进程崩溃 / 返回非法着法会被记录为「异常局」,不计入胜负。
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const [fileA, fileB, gamesS = '30', depthS = '6', randS = '4'] = process.argv.slice(2);
const GAMES = +gamesS, DEPTH = +depthS, RAND_PLIES = +randS;

if (!fileA || !fileB) {
  console.error('用法: node bench/duel.mjs <A.mjs> <B.mjs> [局数] [深度] [随机开局手数]');
  process.exit(1);
}

/* ---------------- 引擎子进程 ---------------- */
class Engine {
  constructor(file, label) {
    this.label = label;
    this.dead = false;
    this.p = spawn(process.execPath, [resolve(file), 'serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.buf = '';
    this.waiters = [];
    this.err = '';
    this.p.stdout.on('data', (d) => {
      this.buf += d.toString();
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        const w = this.waiters.shift();
        if (w) w(line);
      }
    });
    this.p.on('exit', (code) => {
      this.dead = true;
      while (this.waiters.length) this.waiters.shift()('');
    });
  }

  ask(pos, depth, color) {
    return new Promise((res) => {
      // 超时保护:引擎若不支持 serve 模式或卡死,判定本局异常而不是永久挂起
      const timer = setTimeout(() => res(''), 30000);
      this.waiters.push((v) => { clearTimeout(timer); res(v); });
      this.p.stdin.write(`${pos} ${depth} ${color}\n`);
    });
  }

  kill() { try { this.p.kill(); } catch { /* ignore */ } }
}

/* ---------------- 规则(独立实现,与被测引擎无关) ---------------- */
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const inB = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
const other = (p) => (p === 'b' ? 'w' : 'b');

function initBoard() {
  const b = Array.from({ length: 8 }, () => Array(8).fill(null));
  b[3][3] = 'w'; b[3][4] = 'b'; b[4][3] = 'b'; b[4][4] = 'w';
  return b;
}

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
  return nb;
}

const toStr = (b) => b.flat().map((v) => v || '.').join('');
const counts = (b) => {
  let black = 0, white = 0;
  for (const row of b) for (const v of row) { if (v === 'b') black++; else if (v === 'w') white++; }
  return { black, white };
};

/* ---------------- 对局 ---------------- */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
}

/** 返回 'black' | 'white' | 'draw' | 'abort',winner 是执黑/执白的一方 */
async function playGame(engBlack, engWhite, seed) {
  const rng = makeRng(seed);
  let b = initBoard();
  let turn = 'b';
  let plies = 0;

  // 随机开局:保证每局局面不同
  for (let k = 0; k < RAND_PLIES; k++) {
    const ms = legalMoves(b, turn);
    if (!ms.length) {
      if (!legalMoves(b, other(turn)).length) break;
      turn = other(turn);
      continue;
    }
    const [r, c] = ms[Math.floor(rng() * ms.length)];
    b = applyMove(b, r, c, turn);
    turn = other(turn);
    plies++;
  }

  for (;;) {
    const n = counts(b);
    if (n.black + n.white === 64) break;
    const msMe = legalMoves(b, turn);
    const msOp = legalMoves(b, other(turn));
    if (!msMe.length && !msOp.length) break;
    if (!msMe.length) { turn = other(turn); continue; }

    const eng = turn === 'b' ? engBlack : engWhite;
    const mv = await eng.ask(toStr(b), DEPTH, turn);
    if (!mv || mv === '-1') return 'abort';
    const c = 'abcdefgh'.indexOf(mv[0]);
    const r = parseInt(mv.slice(1), 10) - 1;
    if (r < 0 || r > 7 || c < 0) return 'abort';
    if (!flipsFor(b, r, c, turn).length) {
      console.error(`  非法着法 ${mv}(局面 ${toStr(b)})`);
      return 'abort';
    }
    b = applyMove(b, r, c, turn);
    turn = other(turn);
    plies++;
    if (plies > 64) return 'abort';
  }

  const { black, white } = counts(b);
  if (black > white) return 'black';
  if (white > black) return 'white';
  return 'draw';
}

/* ---------------- 主流程 ---------------- */
const labelA = fileA.split(/[\\/]/).pop();
const labelB = fileB.split(/[\\/]/).pop();

const engA = new Engine(fileA, labelA);
const engB = new Engine(fileB, labelB);

let aWin = 0, bWin = 0, draw = 0, abort = 0;
const t0 = Date.now();

for (let g = 0; g < GAMES; g++) {
  // 偶数局:A 执黑;奇数局:A 执白(抵消先手优势)
  const aIsBlack = g % 2 === 0;
  const res = await playGame(aIsBlack ? engA : engB, aIsBlack ? engB : engA, 1000 + g * 7919);
  if (res === 'abort') abort++;
  else if (res === 'draw') draw++;
  else if ((res === 'black') === aIsBlack) aWin++;
  else bWin++;
  const done = g + 1;
  if (done % 5 === 0) process.stdout.write(`  ...已完成 ${done}/${GAMES} 局\n`);
}

engA.kill();
engB.kill();

const decided = aWin + bWin;
const secs = ((Date.now() - t0) / 1000).toFixed(0);
console.log('');
console.log(`对局:${GAMES} 局 · 深度 ${DEPTH} · 随机开局 ${RAND_PLIES} 手 · 用时 ${secs}s`);
console.log(`  A = ${labelA}  ${aWin} 胜`);
console.log(`  B = ${labelB}  ${bWin} 胜`);
console.log(`  和棋 ${draw} · 异常 ${abort}`);
if (decided > 0) {
  const rate = (aWin / decided * 100).toFixed(1);
  const sr = (aWin + draw / 2) / GAMES;
  console.log(`  A 的胜率(不含和棋)${rate}%  |  得分率(A胜+半和)${(sr * 100).toFixed(1)}%`);
}
