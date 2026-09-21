/* ============================================================
 * 开局资源生成器:开局局面 + 精确估值 + 开局名。
 *
 * 输入(两份外部数据,均不入库):
 *   1. Egaroucid 网页版书导出的 web_book.csv(52,850 局面,含精确终局
 *      子差与最佳着法)。生成方式见 Egaroucid 仓库 bin/web_book/
 *      extract_web_book.py;许可 GPL-3.0——估值数据由使用方自担,
 *      本仓库不再分发该 CSV 本身。
 *   2. book/openings-catalog.json:623 个命名开局的研究性索引
 *      (Gatliff 目录 / 香港定石列表 / 日文定石集,出处 URL 在文件内)。
 *
 * 输出(入库):
 *   book/positions.jsonl  规范化局面(8 对称取最小键)+ 值 + 最佳着法
 *                         + 挂上的开局名
 *   book/openings.json    开局名目录 —— 只收终局面命中开局库的条目(书外的
 *                         名字运行时不会出现,不收;完整原始目录在
 *                         openings-catalog.json 备份里)
 *
 * 用法:node tools/make-book.mjs <web_book.csv 路径> [--max-discs 14]
 * ============================================================ */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSV = process.argv[2] ?? '';
const argIdx = process.argv.indexOf('--max-discs');
const MAX_DISCS = argIdx > 0 ? Number(process.argv[argIdx + 1]) : 14;
const ocdIdx = process.argv.indexOf('--ocd-dir');
const OCD_DIR = ocdIdx > 0 ? process.argv[ocdIdx + 1] : '';
const mavIdx = process.argv.indexOf('--max-abs-value');
const MAX_ABS_VALUE = mavIdx > 0 ? Number(process.argv[mavIdx + 1]) : 0;

/* ── 棋盘坐标约定 ──────────────────────────────────────────────
 * 与 Egaroucid web_book.csv 一致:64 字符行优先串,下标 i = rank*8 + file
 * (rank 0 = 1 线,a1 是 0)。'X' = 当前行棋方,'O' = 对方,'-' = 空。
 * 着法 = file 字母 + rank 数字(如 f5)。 */
const FILES = 'abcdefgh';
const sqName = (f, r) => FILES[f] + (r + 1);
const parseSq = (s) => [FILES.indexOf(s[0]), Number(s[1]) - 1];
const idxOf = (f, r) => r * 8 + f;

// 8 个棋盘对称(二面体群):(f,r) → (f',r')。规范化 = 8 个变换后的串取最小。
const TRANSFORMS = [
  ['id', (f, r) => [f, r]],
  ['rot90', (f, r) => [7 - r, f]],
  ['rot180', (f, r) => [7 - f, 7 - r]],
  ['rot270', (f, r) => [r, 7 - f]],
  ['mirrorF', (f, r) => [7 - f, r]],
  ['mirrorR', (f, r) => [f, 7 - r]],
  ['transpose', (f, r) => [r, f]],
  ['antiT', (f, r) => [7 - r, 7 - f]],
];
function applyTransform(board, fn) {
  const out = new Array(64);
  for (let r = 0; r < 8; r++)
    for (let f = 0; f < 8; f++) out[idxOf(f, r)] = board[idxOf(...fn(f, r))];
  return out;
}
// 规范化:返回 [规范串, 达成规范所用的变换](用于换算最佳着法)
function canonicalize(board) {
  let best = null, bestT = null;
  for (const [name, fn] of TRANSFORMS) {
    const s = applyTransform(board, fn).join('');
    if (best === null || s < best) { best = s; bestT = fn; }
  }
  return [best, bestT];
}

/* ── 回放器:从初始局面按坐标序列走子,返回终局盘面 ───────────── */
const DIRS = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
function flipsFor(b, f, r, color) {
  if (b[idxOf(f, r)] !== '-') return null;
  const opp = color === 'X' ? 'O' : 'X';
  const out = [];
  for (const [df, dr] of DIRS) {
    const line = [];
    let ff = f + df, rr = r + dr;
    while (ff >= 0 && ff < 8 && rr >= 0 && rr < 8 && b[idxOf(ff, rr)] === opp) {
      line.push(idxOf(ff, rr)); ff += df; rr += dr;
    }
    if (line.length && ff >= 0 && ff < 8 && rr >= 0 && rr < 8 && b[idxOf(ff, rr)] === color)
      out.push(...line);
  }
  return out.length ? out : null;
}
function initialBoard() {
  const b = new Array(64).fill('-');
  b[idxOf(3, 3)] = 'O'; b[idxOf(4, 4)] = 'O'; // d4 e5 白
  b[idxOf(4, 3)] = 'X'; b[idxOf(3, 4)] = 'X'; // e4 d5 黑(先手)
  return b;
}
function replay(moves) {
  const b = initialBoard();
  let color = 'X';
  for (const mv of moves) {
    const [f, r] = parseSq(mv);
    const flips = flipsFor(b, f, r, color);
    if (!flips) return { ok: false, err: `非法着法 ${mv}` };
    b[idxOf(f, r)] = color;
    for (const i of flips) b[i] = color;
    const opp = color === 'X' ? 'O' : 'X';
    // 对方有棋则换手,否则行棋方继续(虚着)
    let oppHas = false;
    for (let i = 0; i < 64 && !oppHas; i++)
      if (b[i] === '-') oppHas = flipsFor(b, i % 8, (i / 8) | 0, opp) !== null;
    if (oppHas) color = opp;
  }
  // Egaroucid 书的口径:'X' = 当前行棋方。奇数手之后轮白方,须把颜色对调
  // 成"行棋方 = X"再规范化,否则与书内局面全部错位(偶数手命中、奇数手全丢)。
  const board = color === 'O'
    ? b.map((c) => (c === 'X' ? 'O' : c === 'O' ? 'X' : '-'))
    : b;
  return { ok: true, board };
}

/* ── 1. Egaroucid 书:抽取浅层局面并规范化 ───────────────────── */
const text = fs.readFileSync(CSV, 'utf8');
const lines = text.split(/\r?\n/);
const header = lines[0].split(',');
const col = Object.fromEntries(header.map((h, i) => [h, i]));
const positions = new Map(); // 规范串 → 记录
let rawRows = 0, keptRows = 0, dupMerged = 0;
for (let li = 1; li < lines.length; li++) {
  const line = lines[li];
  if (!line) continue;
  const c = line.split(',');
  rawRows++;
  const discs = Number(c[col.n_discs]);
  if (discs > MAX_DISCS) continue;
  const value = Number(c[col.value]);
  // 值域精简(用户决策 2026-09-20,借鉴 Egaroucid min-book 思想):
  // |值| > 阈值的局面不存 —— 胜负已定的边角开局没有保留价值,近均势带才是
  // 开局理论区。阈值本身(±4)保留。0 = 不过滤。
  if (MAX_ABS_VALUE > 0 && Math.abs(value) > MAX_ABS_VALUE) continue;
  keptRows++;
  const board = c[col.board];
  const legal = c[col.legal_moves] ? c[col.legal_moves].trim().split(/\s+/) : [];
  const best = c[col.best_moves] ? c[col.best_moves].trim().split(/\s+/).filter(Boolean) : [];
  const [key, t] = canonicalize(board.split(''));
  const bestT = best.map((m) => { const [f, r] = parseSq(m); const [tf, tr] = t(f, r); return sqName(tf, tr); });
  const rec = { board: key, discs, value, legal_count: legal.length, best: bestT };
  if (positions.has(key)) {
    dupMerged++;
    const old = positions.get(key);
    if (bestT.length > old.best.length) old.best = bestT;
  } else positions.set(key, rec);
}

/* ── 2. 开局名:回放验证 + 挂到规范局面 ─────────────────────── */
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'book', 'openings-catalog.json'), 'utf8').replace(/^\uFEFF/, ''));
// 英文化(用户决策 2026-09-20):输出只用英文名。主名是 ASCII 词名用主名,
// 否则取第一个 ASCII 别名;两者皆无(纯日文命名、无既定英文译名)的条目
// 整条弃用 —— 不自造译名。日文名一律不进产物(目录备份里保留原文)。
const asciiName = (s) => /^[ -~]+$/.test(s);
function englishOf(o) {
  if (asciiName(o.primary_name))
    return { name: o.primary_name, aliases: (o.aliases ?? []).filter(asciiName) };
  const alt = (o.aliases ?? []).find(asciiName);
  if (alt)
    return { name: alt, aliases: (o.aliases ?? []).filter((a) => a !== alt && asciiName(a)) };
  return null;
}
/* 目录只收**命中开局库**的条目(用户决策 2026-09-20:开局库里不会出现的
 * 名字没有存在价值):duplicate_of 重选项、回放非法、终局面被 ≤14 子 / |值|≤4
 * 滤出书外的都直接弃 —— 它们的名字在运行时任何路径都不会显示。挂名逻辑
 * 不变:命中才 pos.names.push。 */
const openingsOut = [];
let hit = 0, merged = 0, dropped = 0, outOfBook = 0;
for (const o of catalog.openings) {
  const en = englishOf(o);
  if (!en) { dropped++; continue; }
  const moves = o.moves.map((m) => m.toLowerCase());
  // duplicate_of:与已有条目规范化终局面相同的重复项(如 オセロWiki「牛」修正后
  // 与 Gatliff Cow 同局面)。名字经目标条目保留,不单独进目录。
  if (o.duplicate_of) { merged++; continue; }
  const r = replay(moves);
  if (!r.ok) { outOfBook++; continue; }
  const [key] = canonicalize(r.board);
  const pos = positions.get(key);
  if (!pos) { outOfBook++; continue; }   // 终局面不在开局库 → 名字不会出现,弃
  hit++;
  pos.names ??= [];
  // 同一开局在目录里常以 4 个对称首手变体各挂一条,规范化后落到同一局面 → 去重。
  // 别名不进局面的名字集(2026-09-21 用户决策):主名+别名并列是**假并列**,
  // 会把本可单名显示的局面顶成「不展示」;别名保留在 openings.json 目录里。
  if (!pos.names.includes(en.name)) pos.names.push(en.name);
  openingsOut.push({ name: en.name, aliases: en.aliases,
    moves, family: o.family ?? '', discs: moves.length + 4 });
}

/* ── 2b. OCD 英文目录:按局面图案直接挂名(第三来源)────────────── */
// berg.earthlingz.de 的经典 openings.txt(经 Egaroucid bin/resources/openings/
// english 转带):`1/0/.` 盘面图案 + 英文名,fork 文件是"同一局面多个名字"的
// 分叉表。局面键挂名,不需要着法序列;手工目录,1 的颜色取向行间不一致,
// 原样/换色两条都试,原样优先。
let ocdPatterns = 0, ocdHit = 0, ocdNewNames = 0;
const namedBeforeOcd = [...positions.values()].filter((p) => p.names).length;
if (OCD_DIR) {
  const patterns = new Map();
  const eat = (file) => {
    for (const ln of fs.readFileSync(path.join(OCD_DIR, file), 'utf8').split(/\r?\n/)) {
      if (ln.length < 65) continue;
      const pat = ln.slice(0, 64);
      const names = ln.slice(64).trim();
      if (!names) continue;
      const set = patterns.get(pat) ?? new Set();
      for (const n of names.split('|')) { const t = n.trim(); if (t) set.add(t); }
      patterns.set(pat, set);
    }
  };
  eat('openings.txt');
  eat('openings_fork.txt');
  for (const [pat, names] of patterns) {
    ocdPatterns++;
    const b = [...pat].map((c) => (c === '1' ? 'X' : c === '0' ? 'O' : '-'));
    const bSwap = b.map((c) => (c === 'X' ? 'O' : c === 'O' ? 'X' : '-'));
    const pos = positions.get(canonicalize(b)[0]) ?? positions.get(canonicalize(bSwap)[0]);
    if (!pos) continue;
    ocdHit++;
    pos.names ??= [];
    for (const n of names) if (!pos.names.includes(n)) { pos.names.push(n); ocdNewNames++; }
  }
}

/* ── 2c. 生成 Zig 侧开局书 blob(src/zig/book-openings.bin)───────────────
 * 数据:保留局面 = 初始局面起的 BFS 最短路径(token 序列;token = 线性格号
 * 0..63,过手 = 64)+ 精确值 + 最佳着法集(含根:零长路径 = 首手书内入口)
 * + 开局名(**单一化**策略见 ⑤ 的解析:单名局面显名、并列局面不展示、
 * 无名局面沿树继承最近命名祖先 —— 名字池里没有「 / 」并列串;
 * engine.zig 零拷贝直读,UI 显示「开局库 · 名字 · 估值」,同 chess 的开局库行)。
 * 格式:**字节对齐**(用户决策 2026-09-20)。最终产物经 gzip 传输/计费,
 * DEFLATE 按字节匹配:字节对齐的小字母表重复 token 对 LZ77/Huffman 友好,
 * 6 bit 打包反而打散字节边界抬高熵;解码侧也免去位读取器。
 * 布局:u16 条数 LE + u8 passTok(=64);条目按路径字典序排序,每条 =
 *   share u8(与上一条共享前缀长)+ slen u8 + slen×u8 token
 *   + (value+8) u8 + bcnt u8 + bcnt×u8 token + nameRef u8
 *   (nameRef = 名字池下标+1,0 = 无名)
 * 尾接名字池:u16 池大小 LE + 每串 u8 len + len×u8 ASCII(单名串、u8 域内;
 * 名字串按条目序首次出现入池,确定性)。
 * 前缀共享把 ~9K token 压到 ~1.4K。自检:独立解码回放,校验终局面键、
 * 值一致与最佳着法合法性,不过就抛错;名字段按 ⑤ 策略独立走父链复核。 */
const STD_INITIAL = (() => {
  const b = new Array(64).fill('-');
  b[idxOf(3, 3)] = 'O'; b[idxOf(4, 4)] = 'O'; // d4 e5
  b[idxOf(4, 3)] = 'X'; b[idxOf(3, 4)] = 'X'; // e4 d5,X = 黑 = 先行方
  return b;
})();
const PASS_TOK = 64; // u8 空间充裕,过手专用记号,不与格号冲突
// ⚠ canonicalize 返回的变换是**函数**;下标访问前必须物化成置换数组
// (这里踩过:t[i] 对函数取值全是 undefined → 盘面全空、BFS 全断)。
const permOf = (fn) => {
  const p = new Array(64);
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) p[idxOf(f, r)] = idxOf(...fn(f, r));
  return p;
};
const PERMS = TRANSFORMS.map(([, fn]) => permOf(fn));
const invPerm = (p) => { const q = new Array(64); for (let i = 0; i < 64; i++) q[p[i]] = i; return q; };

// ①+② 行数据:规范键 + 行置换。**不用全局 σ**(每行的规范化变换 t 各不相同,
// t∘σ 拼出的帧逐行漂移、坐标跟着串帧,实测 legal 恰好差一个镜像;而"盘面+
// 坐标一起变"的校验永远自洽、发现不了)。树结构完全用**我方帧**自己生成:
// BFS 从 STD_INITIAL 出发,合法着法自己算,token 就是我方帧格号 —— 与
// engine.zig 的回放帧天然一致;CSV 的 best_moves 经逐行置换映回我方帧。
// rows:key → {pT(C-idx→csv-idx 的置换), bestCsv[], n_discs}
const rows = new Map();
for (let li = 1; li < lines.length; li++) {
  const line = lines[li];
  if (!line) continue;
  const c = line.split(',');
  if (Number(c[col.n_discs]) > MAX_DISCS) continue;
  const [key, tFn] = canonicalize(c[col.board].split(''));
  if (rows.has(key)) continue;
  const best = (c[col.best_moves] || '').trim().split(/\s+/).filter(Boolean);
  rows.set(key, { pT: permOf(tFn), bestCsv: best, n: Number(c[col.n_discs]) });
}

// ③ BFS(我方帧):节点 =「行键 + 我方帧盘面(X = 行棋方)」。
// 只展开 CSV 树里存在的键;过手边 = 盘面换色。
const swapColor = (board) => board.map((ch) => (ch === 'X' ? 'O' : ch === 'O' ? 'X' : '-'));
const flipFor = (board, tok) => { // 行棋方 = X 视角的翻子(tok 为线性下标)
  const flips = [];
  for (const [df, dr] of DIRS) {
    const l2 = [];
    let ff = (tok % 8) + df, rr = (tok >> 3) + dr;
    while (ff >= 0 && ff < 8 && rr >= 0 && rr < 8 && board[idxOf(ff, rr)] === 'O') {
      l2.push(idxOf(ff, rr)); ff += df; rr += dr;
    }
    if (l2.length && ff >= 0 && ff < 8 && rr >= 0 && rr < 8 && board[idxOf(ff, rr)] === 'X') flips.push(...l2);
  }
  return flips;
};
const nodes = new Map(); // key → {boardMy, parent, tok}
{
  const rootKey = canonicalize(STD_INITIAL)[0];
  if (!rows.has(rootKey)) throw new Error('书内没有初始局面行');
  nodes.set(rootKey, { boardMy: STD_INITIAL.slice(), parent: null, tok: -1 });
  const queue = [rootKey];
  while (queue.length) {
    const key = queue.shift();
    const node = nodes.get(key);
    let legal = [];
    for (let tok = 0; tok < 64; tok++) if (flipFor(node.boardMy, tok).length) legal.push(tok);
    if (legal.length === 0) { // 过手:盘面不动,行棋方换边
      const child = swapColor(node.boardMy);
      const ck = canonicalize(child)[0];
      if (rows.has(ck) && !nodes.has(ck)) {
        nodes.set(ck, { boardMy: child, parent: key, tok: PASS_TOK });
        queue.push(ck);
      }
      continue;
    }
    for (const tok of legal) {
      const flips = flipFor(node.boardMy, tok);
      const child = node.boardMy.slice();
      child[tok] = 'X';
      for (const i of flips) child[i] = 'X';
      const ck = canonicalize(swapColor(child))[0];
      if (rows.has(ck) && !nodes.has(ck)) {
        nodes.set(ck, { boardMy: swapColor(child), parent: key, tok });
        queue.push(ck);
      }
    }
  }
}

// ④ 抽路径 + best 映射回我方帧。
// 映射:C[i] = csv[pT[i]] = my[pM[i]] ⇒ csv[j] 对应 my[pM[invPT[j]]]。
const entries = [];
let unreachable = 0, badBest = 0;
for (const [key, node] of nodes) {
  if (!positions.has(key)) continue;
  const row = rows.get(key);
  if (!row.bestCsv.length) continue; // 无最佳着法的局面运行时用不上
  const toks = [];
  for (let k = key; nodes.get(k).parent !== null; ) {
    const n = nodes.get(k);
    toks.push(n.tok);
    k = n.parent;
  }
  toks.reverse();
  const pM = permOf(canonicalize(node.boardMy)[1]);
  const invPT = invPerm(row.pT);
  const best = row.bestCsv.map((m) => pM[invPT[idxOf(...parseSq(m))]]).sort((a, b) => a - b);
  // best 必须在该盘面合法 —— 数据哨兵(Egaroucid best ⊆ legal,违反即映射错)
  let ok = best.length > 0;
  for (const t of best) if (!flipFor(node.boardMy, t).length) ok = false;
  if (!ok) { badBest++; continue; }
  entries.push({ key, path: toks, value: positions.get(key).value, best: best.slice(0, 255), names: positions.get(key).names });
}
if (badBest) throw new Error(`best 映射合法性失败 ${badBest} 条(帧推导有误)`);
entries.sort((a, b) => {
  const n = Math.min(a.path.length, b.path.length);
  for (let i = 0; i < n; i++) if (a.path[i] !== b.path[i]) return a.path[i] - b.path[i];
  return a.path.length - b.path.length;
});

// ── ⑤ 开局名单一化 + 沿树继承(2026-09-21 用户决策)────────────────────
// 旧版把同局面的全部名字「 / 」拼接进名字池 —— 换位汇合点上常出现五六个
// 名字并列,一行放不下也说明不了"现在下的是哪个开局"。新策略:
//   · 单名局面 → 显示该名;
//   · 并列局面(≥2 名)→ **不展示**:书着是值容差随机选的,挑"最强着法"
//     的名字展示可能和实际走出的着法对不上,误导;并列局面本就是开局
//     未定形的换位点,无名最诚实。**继承链穿过它不断**——本格空一格,
//     后代照常引用更上层的单名祖先;
//   · 无名局面 → 继承最近单名祖先:开局名随行棋推进**持续显示**(后续
//     书着也有名字),行至更具体的定式局面被覆盖(Heath → Heath-Bat → …)。
// nodes 的 Map 插入序 = BFS 发现序,父必先于子解析;根局面(初始局面)
// 无名、无父 → ''。
const displayName = new Map(); // 规范键 → 单名或 ''
const ancestorName = new Map(); // 规范键 → 最近单名祖先的名(无名/并列局面的继承源)
for (const [key, node] of nodes) {
  const ns = positions.get(key)?.names;
  if (ns && ns.length === 1) {
    displayName.set(key, ns[0]);
    ancestorName.set(key, ns[0]);
  } else {
    displayName.set(key, ns && ns.length >= 2 ? '' : (ancestorName.get(node.parent) ?? ''));
    ancestorName.set(key, ancestorName.get(node.parent) ?? '');
  }
}

// 名字池:⑤ 解析出的单名入池;按条目序首次出现入池(确定性),u8 下标域内。
const namePool = new Map(); // 串 → 池下标(1 起)
const nameRefOf = (s) => {
  if (!s) return 0;
  if (!/^[\x20-\x7e]*$/.test(s)) throw new Error(`开局名非 ASCII:${JSON.stringify(s)}`);
  if (s.length > 255) throw new Error(`开局名超 u8 长度(${s.length}):${JSON.stringify(s)}`);
  if (!namePool.has(s)) namePool.set(s, namePool.size + 1);
  return namePool.get(s);
};
const refs = entries.map((e) => nameRefOf(displayName.get(e.key) ?? ''));
if (namePool.size > 255) throw new Error(`名字池超 u8 下标域(${namePool.size})`);
const namedEntries = refs.filter((r) => r !== 0).length;
const multiPos = [...nodes.keys()].filter((k) => (positions.get(k)?.names?.length ?? 0) >= 2).length;

const blobArr = [entries.length & 0xFF, (entries.length >> 8) & 0xFF, PASS_TOK];
let tokFlat = 0, tokShared = 0, prevPath = [];
for (let i = 0; i < entries.length; i++) {
  const e = entries[i];
  let share = 0;
  while (share < prevPath.length && share < e.path.length && prevPath[share] === e.path[share]) share++;
  const suffix = e.path.slice(share);
  if (share > 255 || suffix.length > 255) throw new Error('前缀/后缀超出 u8 范围');
  tokFlat += e.path.length; tokShared += suffix.length;
  blobArr.push(share, suffix.length, ...suffix, e.value + 8, e.best.length, ...e.best, refs[i]);
  prevPath = e.path;
}
// 名字池(u16 数量 + 每串 u8 len + ASCII 字节)拼在条目区之后
const poolStrs = [...namePool.keys()];
blobArr.push(poolStrs.length & 0xFF, (poolStrs.length >> 8) & 0xFF);
for (const s of poolStrs) blobArr.push(s.length, ...[...s].map((ch) => ch.charCodeAt(0)));
const blob = Buffer.from(blobArr);

// ⑤ 自检:独立解码回放 —— 终局面必须在保留集、值一致、最佳着法合法、
// 名字与 positions.jsonl 逐条对上(nameRef 复用 refs[] 就不是独立解码了)
{
  let off = 3;
  let prev = [];
  const decodedNames = [];
  for (let i = 0; i < entries.length; i++) {
    const share = blob[off++], slen = blob[off++];
    const path = prev.slice(0, share);
    for (let k = 0; k < slen; k++) path.push(blob[off++]);
    const val = blob[off++] - 8;
    const bcnt = blob[off++];
    const best = [];
    for (let k = 0; k < bcnt; k++) best.push(blob[off++]);
    const nameRef = blob[off++];
    const b = STD_INITIAL.slice();
    let color = 'X';
    for (const tok of path) {
      if (tok === PASS_TOK) { color = color === 'X' ? 'O' : 'X'; continue; }
      const f = tok % 8, r = tok >> 3;
      const opp = color === 'X' ? 'O' : 'X';
      const flips = [];
      for (const [df, dr] of DIRS) {
        const l2 = [];
        let ff = f + df, rr = r + dr;
        while (ff >= 0 && ff < 8 && rr >= 0 && rr < 8 && b[idxOf(ff, rr)] === opp) {
          l2.push(idxOf(ff, rr)); ff += df; rr += dr;
        }
        if (l2.length && ff >= 0 && ff < 8 && rr >= 0 && rr < 8 && b[idxOf(ff, rr)] === color) flips.push(...l2);
      }
      if (!flips.length) throw new Error(`自检失败:第 ${i} 条路径着法不合法`);
      b[idxOf(f, r)] = color;
      for (const x of flips) b[x] = color;
      color = color === 'X' ? 'O' : 'X';
    }
    // 终局面要按「行棋方 = X」口径规范化(与 CSV/书一致):
    // 奇数手后轮对方,盘面整体换色再取键 —— 漏了这步,奇数手条目全错位。
    if (color === 'O')
      for (let k = 0; k < 64; k++)
        b[k] = b[k] === 'X' ? 'O' : b[k] === 'O' ? 'X' : '-';
    const key = canonicalize(b)[0];
    const rec = positions.get(key);
    if (!rec) throw new Error(`自检失败:第 ${i} 条终局面不在保留集 ${JSON.stringify({ path, key })}`);
    if (rec.value !== val) throw new Error(`自检失败:第 ${i} 条值不一致(${rec.value} vs ${val})`);
    if (!best.length) throw new Error(`自检失败:第 ${i} 条无最佳着法`);
    for (const t of best) {
      const f = t % 8, r = t >> 3;
      if (!flipsFor(b, f, r, 'X')) {
        const tn = tree.get(key);
        const realLegal = [];
        for (let sq = 0; sq < 64; sq++) if (flipsFor(b, sq % 8, sq >> 3, 'X')) realLegal.push(sq);
        throw new Error(`自检失败:第 ${i} 条 ${JSON.stringify({ path, best, tok: t, treeLegal: tn ? tn.legal : null, treeBest: tn ? tn.best : null, realLegal, board: b.join('') })}`);
      }
    }
    decodedNames.push({ key, nameRef });
    prev = path;
  }
  // 名字池解码 + 与 positions.jsonl 复核
  const poolN = blob[off] | (blob[off + 1] << 8);
  off += 2;
  const pool = [];
  for (let i = 0; i < poolN; i++) {
    const len = blob[off++];
    pool.push(blob.subarray(off, off + len).toString('latin1'));
    off += len;
  }
  for (const { key, nameRef } of decodedNames) {
    // ⑤ 策略的独立走查(不共用 displayName,沿 nodes 父链重推):
    // 单名 → 该名;并列(≥2)→ '';无名 → 最近**单名**祖先(并列祖先只空
    // 本格、不断链,走查跳过它继续上溯)。
    let want = '';
    const ns = positions.get(key)?.names;
    if (ns && ns.length === 1) want = ns[0];
    else if (!ns || ns.length === 0) {
      let p = nodes.get(key)?.parent ?? null;
      while (p !== null) {
        const pn = positions.get(p)?.names;
        if (pn && pn.length === 1) { want = pn[0]; break; }
        p = nodes.get(p)?.parent ?? null;
      }
    }
    const got = nameRef ? pool[nameRef - 1] : '';
    if (got !== want) throw new Error(`自检失败:名字不符 ${JSON.stringify({ key, want, got })}`);
    if (got.includes(' / ')) throw new Error(`自检失败:名字池出现并列串 ${JSON.stringify(got)}`);
  }
  if (off !== blob.length) throw new Error(`自检失败:长度不匹配(${off} vs ${blob.length})`);
}
fs.writeFileSync(path.join(ROOT, 'src', 'zig', 'book-openings.bin'), blob);

const bookDir = path.join(ROOT, 'book');
const posSorted = [...positions.values()].sort((a, b) => a.discs - b.discs || a.board.localeCompare(b.board));
fs.writeFileSync(path.join(bookDir, 'positions.jsonl'),
  posSorted.map((p) => JSON.stringify({ board: p.board, discs: p.discs, value: p.value, best: p.best, ...(p.names ? { names: p.names } : {}) })).join('\n') + '\n');
fs.writeFileSync(path.join(bookDir, 'openings.json'),
  // 来源只保留 ASCII 字段(日文站点的原版标题留在 openings-catalog.json 备份里);
  // v1:只收命中开局库的条目,in_book/valid/duplicate_of 标记随全量目录一起退役
  JSON.stringify({ schema: 'aetherothello-opening-names.v1', note: catalog.license_note,
    scope: '仅收录终局面命中开局库(≤14 子、|值|≤4)的开局;书外条目与日文原名见 openings-catalog.json',
    sources: catalog.sources.map((s) => Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v === 'string' ? asciiName(v) : true))),
    openings: openingsOut }, null, 2));

const named = posSorted.filter((p) => p.names).length;
const withBest = posSorted.filter((p) => p.best.length).length;
console.log(`Egaroucid 书:读 ${rawRows} 行,≤${MAX_DISCS} 子 ${keptRows} 行 → 规范化去重 ${positions.size} 局面(合并 ${dupMerged})`);
console.log(`  带最佳着法 ${withBest};带开局名 ${named}`);
console.log(`开局目录:${catalog.openings.length} 条,英文名采用 ${catalog.openings.length - dropped} 条(纯日文弃用 ${dropped}),重复合并 ${merged},终局面命中书内 ${hit}(书外弃 ${outOfBook},目录只收命中项)`);
if (OCD_DIR) {
  const namedAfter = [...positions.values()].filter((p) => p.names).length;
  console.log(`OCD 目录:${ocdPatterns} 图案,命中书内局面 ${ocdHit},新增名字 ${ocdNewNames},挂名局面 ${namedBeforeOcd} → ${namedAfter}`);
}
console.log(`开局书 blob:${entries.length} 条(不可达跳过 ${unreachable}),路径 token 平铺 ${tokFlat} → 前缀共享后 ${tokShared},名字池 ${poolStrs.length} 串,命名条目 ${namedEntries}/${entries.length}(并列局面 ${multiPos} 不展示),raw ${blob.length} B / gzip ${zlib.gzipSync(blob).length} B → src/zig/book-openings.bin`);
console.log(`✓ 已写 book/positions.jsonl(${posSorted.length} 局面)与 book/openings.json`);
