/* 残局独立裁判:用**最朴素**的 8×8 数组规则(不碰位棋盘、不碰置换表、不玩 PVS)
 * 暴力枚举,给 out/exact*.txt 里的每个局面算出精确子差。
 * 目的:当 Zig 与主分支 JS 引擎吵架时,有一个不站边的第三方说了算。
 * 用法:node tools/referee.mjs [out/exact_s.txt]
 */
import fs from 'node:fs';

const DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

function flipsAt(st, s, me) {
  const opp = 3 - me, r = s >> 3, c = s & 7, res = [];
  for (const [dr, dc] of DIRS) {
    let rr = r + dr, cc = c + dc;
    const acc = [];
    while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && st[rr * 8 + cc] === opp) {
      acc.push(rr * 8 + cc); rr += dr; cc += dc;
    }
    if (acc.length && rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && st[rr * 8 + cc] === me) res.push(...acc);
  }
  return res;
}

function legalFor(st, me) {
  const out = [];
  for (let s = 0; s < 64; s++) if (st[s] === 0 && flipsAt(st, s, me).length) out.push(s);
  return out;
}

function count(st, me) { let n = 0; for (const v of st) if (v === me) n++; return n; }

function solve(st, me, memo) {
  const key = st.join('') + me;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const mv = legalFor(st, me);
  let val;
  if (!mv.length) {
    val = legalFor(st, 3 - me).length ? -solve(st, 3 - me, memo) : count(st, me) - count(st, 3 - me);
  } else {
    let best = -99;
    for (const s of mv) {
      const ns = Int8Array.from(st);
      for (const t of flipsAt(st, s, me)) ns[t] = me;
      ns[s] = me;
      const v = -solve(ns, 3 - me, memo);
      if (v > best) best = v;
    }
    val = best;
  }
  memo.set(key, val);
  return val;
}

const path = process.argv[2] || 'out/exact_s.txt';
const lines = fs.readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());

let badZig = 0, badJs = 0, n = 0, both = 0;
for (const line of lines) {
  const [blo, bhi, wlo, whi, side, empties, zig] = line.trim().split(/\s+/).map(Number);
  if (empties > 12) continue;
  const st = new Int8Array(64);
  for (let p = 0; p < 32; p++) if (blo >>> p & 1) st[p] = 1;
  for (let p = 0; p < 32; p++) if (bhi >>> p & 1) st[32 + p] = 1;
  for (let p = 0; p < 32; p++) if (wlo >>> p & 1) st[p] = 2;
  for (let p = 0; p < 32; p++) if (whi >>> p & 1) st[32 + p] = 2;
  const e = st.filter((v) => v === 0).length;
  if (e !== empties) { console.log(`✗ 空位数不符:文件 ${empties} 实算 ${e}`); continue; }
  const ref = solve(st, side, new Map());
  const okZ = ref === zig;
  if (!okZ) badZig++;
  n++;
  if (!okZ) console.log(`  ✗ 真值 ${ref}  zig ${zig}  (空位 ${empties})`);
}
console.log(`裁判(纯数组暴力)判:${n} 个局面中 Zig 错 ${badZig}`);
