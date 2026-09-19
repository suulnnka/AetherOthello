#!/usr/bin/env node
/* ============================================================
 * 引擎 Worker 契约冒烟 —— **两个分支共用同一份**(见 docs/WORKER-PROTOCOL.md)
 *
 * 为什么需要它:仓库里有两套实现(JS 参照 / Zig + wasm),UI 与探针只认一份
 * 消息契约。没有一条能同时在两条分支上跑的检查,「接口一致」就只是句口号 ——
 * 改一边的字段名/单位/旗标语义,谁都不会发现。
 *
 * 它检查什么(每条都是对**契约**的,不是对某个实现):
 *   · ping → pong,带 tag(以及实现名 engine)
 *   · levels → 引擎自报的难度表:至少一项、每项字段齐全、default 在下标范围内
 *   · think 回包字段齐全、类型正确、id 原样回传、empties 原样回传
 *   · move 是合法着法;无合法着法时必须报 −1
 *   · depthMax === 难度表里 level 那一项的 depth(请求带 depth 覆盖时等于覆盖值);
 *     nodes/ms/depth ≥ 0
 *   · think 的 `depth` 覆盖只替换深度上限,end/budget 仍取档位(CLI 有专用用例)
 *   · exact 为真时,score 必须等于**独立重算**的精确终局子差(所以它同时是
 *     一条功能断言:两边的完全求解都得真的精确)
 *   · 用独立的 2D 朴素规则判合法性(不借用任何一方的位棋盘代码)
 *
 * 难度表**不由本脚本假设**:两套实现的算法不同,档位参数不通用,所以这里一律先问
 * 引擎({type:'levels'}),再按**它自己报的表**去核对回包。—— 这就是「难度表属于
 * 引擎层」这条在测试上的落点。
 *
 * 用法:node tools/probe-contract.mjs [引擎目录=.] [--levels 1,2] [--verbose]
 *      --levels 缺省用引擎自报的 default:够覆盖搜索 + 残局完全求解,
 *      又不至于把 JS 通道拖到分钟级
 * 退出码:0 全过 / 1 有失败
 *
 * 导出:loadEngine(dir) / runCase(eng, c, level, opts) / CASES —— tools/compare-branches.mjs 复用
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ==================== 在 Node 里冒充 Worker 环境 ==================== */

/** worker.js 里的 fetch 是给浏览器的;Node 的 fetch 不支持 file:(而 zig 通道的
 *  worker 正是用 import.meta.url 拼出 file: URL 去取 wasm),所以把 file: 顶掉。 */
function installFetchShim() {
  if (globalThis.__fetchShimInstalled) return;
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('file:')) {
      return new Response(fs.readFileSync(fileURLToPath(url)), { status: 200 });
    }
    return real(input, init);
  };
  globalThis.__fetchShimInstalled = true;
}

let importSeq = 0;

/** 把一个引擎目录下的 src/worker.js 当成 Worker 跑起来。
 *  ⚠ 同一进程里加载多个实现时它们共用 globalThis.self —— worker.js 在模块求值时写
 *  self.onmessage、在回调里又读 self.postMessage,所以每次派发前必须把 self 换回
 *  自己那个,否则消息会送到别的引擎去(踩过)。 */
export async function loadEngine(dir) {
  installFetchShim();
  const root = path.resolve(dir);
  const workerFile = path.join(root, 'src', 'worker.js');
  if (!fs.existsSync(workerFile)) throw new Error(`找不到 ${workerFile}`);

  const sink = { onMessage: null };
  const fake = { postMessage: (m) => { const f = sink.onMessage; sink.onMessage = null; if (f) f(m); } };
  globalThis.self = fake;
  // 加 query 破坏 import 缓存:同一路径第二次加载必须重新求值,否则拿到的是
  // 上一轮那个把 onmessage 挂到旧 fake 上的模块实例
  await import(pathToFileURL(workerFile).href + `?probe=${++importSeq}`);
  if (typeof fake.onmessage !== 'function') throw new Error('worker.js 没有挂 self.onmessage');

  return {
    root,
    name: path.basename(root),
    /** 发一条消息并等回包;超时抛错(引擎卡住要能看出是卡住,而不是没结果) */
    ask(msg, timeoutMs = 240_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等回包超时(${timeoutMs} ms)`)), timeoutMs);
        sink.onMessage = (m) => { clearTimeout(timer); resolve(m); };
        globalThis.self = fake;              // 见上面的 ⚠
        fake.onmessage({ data: msg });
      });
    },
  };
}

/* ==================== 独立规则(第三方裁判,不借任何引擎) ==================== */

const DIRS8 = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

function flipsAt(st, s, me) {
  const opp = 3 - me, r = s >> 3, c = s & 7, res = [];
  for (const [dr, dc] of DIRS8) {
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
function countsOf(st, me) { let n = 0; for (const v of st) if (v === me) n++; return n; }

/** 精确终局子差(me 视角)。只给小空位数用(≤10 空),当裁判用。 */
function solveExact(st, me, memo) {
  const key = st.join('') + me;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const mv = legalFor(st, me);
  let val;
  if (!mv.length) {
    val = legalFor(st, 3 - me).length ? -solveExact(st, 3 - me, memo) : countsOf(st, me) - countsOf(st, 3 - me);
  } else {
    let best = -99;
    for (const s of mv) {
      const ns = Int8Array.from(st);
      for (const t of flipsAt(st, s, me)) ns[t] = me;
      ns[s] = me;
      const v = -solveExact(ns, 3 - me, memo);
      if (v > best) best = v;
    }
    val = best;
  }
  memo.set(key, val);
  return val;
}

/* ==================== 局面取样(固定种子,两边跑同一批) ==================== */

const pack = (bits) => {
  let lo = 0, hi = 0;
  for (const i of bits) { if (i < 32) lo |= 1 << i; else hi |= 1 << (i - 32); }
  return [lo >>> 0, hi >>> 0];
};

/** 从开局随机走到只剩 empty 个空格;返回 {own, opp, empties, st} */
function randomAt(empty, seed) {
  let st = new Int8Array(64);
  st[27] = 2; st[28] = 1; st[35] = 1; st[36] = 2;      // d4/w e4/b d5/b e5/w
  let me = 1, rnd = seed >>> 0;
  const next = () => (rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
  let guard = 0;
  while (64 - countsOf(st, 1) - countsOf(st, 2) > empty && guard++ < 200) {
    const mv = legalFor(st, me);
    if (!mv.length) { me = 3 - me; continue; }
    const s = mv[Math.floor(next() * mv.length)];
    const ns = Int8Array.from(st);
    for (const t of flipsAt(st, s, me)) ns[t] = me;
    ns[s] = me;
    st = ns; me = 3 - me;
  }
  const own = [], opp = [];
  for (let i = 0; i < 64; i++) { if (st[i] === me) own.push(i); else if (st[i]) opp.push(i); }
  return { st, me, own: pack(own), opp: pack(opp), empties: 64 - countsOf(st, 1) - countsOf(st, 2) };
}

/** 默认用例集:开局 / 中局 / 残局(残局那两个同时用来验完全求解的精确性) */
const mk = (empty, seed) => {
  const pos = randomAt(empty, seed);
  const discs = 64 - pos.empties;
  return { name: `${discs} 子 / ${pos.empties} 空`, pos };
};
export const CASES = [
  { name: '开局(4 子 / 60 空)', pos: { st: null, me: 1, own: pack([28, 35]), opp: pack([27, 36]), empties: 60 } },
  mk(40, 0x1234),
  mk(20, 0x5678),
  mk(8, 0x9abc),
  mk(6, 0xdef0),
];

/* ==================== 契约断言 ==================== */

const NUM = (x) => typeof x === 'number' && Number.isFinite(x);

/** 向引擎要难度表并按契约校验;返回 { table, def, notes[] }
 *  这是**唯一**合法的取表方式 —— 不要在测试里 import src/levels.js:
 *  那张表是引擎的实现细节,两套实现本来就允许不同。 */
export async function fetchLevels(eng, timeout = 10_000) {
  const res = await eng.ask({ type: 'levels' }, timeout);
  const notes = [];
  if (res.error) notes.push('levels 回包带 error:' + res.error);
  if (res.type !== 'levels') notes.push(`type 应为 'levels',得到 ${res.type}`);
  if (res.tag !== 'othello-engine-v1') notes.push(`tag 应为 othello-engine-v1,得到 ${res.tag}`);
  if (!['js', 'wasm'].includes(res.engine)) notes.push(`engine 应为 js/wasm,得到 ${res.engine}`);
  const table = res.levels;
  if (!Array.isArray(table) || !table.length) {
    notes.push('levels 必须是非空数组');
    return { table: [], def: 0, notes };
  }
  table.forEach((lv, i) => {
    const at = `levels[${i}]`;
    if (typeof lv?.name !== 'string' || !lv.name) notes.push(`${at}.name 必须是非空字符串`);
    if (lv?.desc !== undefined && typeof lv.desc !== 'string') notes.push(`${at}.desc 必须是字符串`);
    for (const k of ['depth', 'end', 'budget']) {
      if (!NUM(lv?.[k]) || lv[k] < 0 || !Number.isInteger(lv[k])) notes.push(`${at}.${k} 必须是非负整数,得到 ${lv?.[k]}`);
    }
    if (NUM(lv?.end) && lv.end > 64) notes.push(`${at}.end 不能超过 64`);
    if (NUM(lv?.depth) && NUM(lv?.end) && lv.depth > 0 && lv.end > 64) notes.push(`${at} 参数越界`);
  });
  const def = res.default;
  if (!Number.isInteger(def) || def < 0 || def >= table.length) notes.push(`default 应是 0..${table.length - 1} 的整数,得到 ${def}`);
  return { table, def: Number.isInteger(def) && def >= 0 && def < table.length ? def : 0, notes };
}

/** 发一手并按契约检查;返回 { ok, notes[], want, row }
 *  opts.table = 引擎自报的难度表(由 fetchLevels 得来),opts.timeout 毫秒 */
export async function runCase(eng, c, level, { table, timeout = 240_000, depth = null } = {}) {
  const pos = c.pos;
  const lv = table[level];
  const req = { type: 'think', id: 1, own: pos.own, opp: pos.opp, level,
                depth: depth ?? undefined, empties: pos.empties };
  const res = await eng.ask(req, timeout);
  const notes = [];
  const bad = (s) => notes.push(s);

  if (res.error) bad('回包带 error:' + res.error);
  if (res.id !== req.id) bad(`id 没原样回传(${res.id} ≠ ${req.id})`);
  if (!NUM(res.move) || res.move < -1 || res.move > 63 || !Number.isInteger(res.move)) bad(`move 非法:${res.move}`);
  if (!NUM(res.score)) bad(`score 不是数字:${res.score}`);
  if (!NUM(res.depth) || res.depth < 0) bad(`depth 非法:${res.depth}`);
  const wantMax = depth ?? lv.depth;   // depth 覆盖档位上限时,回包必须反映覆盖值
  if (res.depthMax !== wantMax) bad(`depthMax 应为 ${wantMax},得到 ${res.depthMax}`);
  if (typeof res.exact !== 'boolean') bad(`exact 不是布尔:${res.exact}`);
  if (!NUM(res.nodes) || res.nodes < 0) bad(`nodes 非法:${res.nodes}`);
  if (!NUM(res.ms) || res.ms < 0) bad(`ms 非法:${res.ms}`);
  if (res.empties !== pos.empties) bad(`empties 没原样回传(${res.empties} ≠ ${pos.empties})`);

  // 合法性:用独立规则判,并核对"无棋可走必须报 −1"
  const legal = pos.st ? legalFor(pos.st, pos.me) : [19, 26, 37, 44];
  if (!legal.length) {
    if (res.move !== -1) bad(`无合法着法时报了 ${res.move},应为 −1`);
  } else if (res.move >= 0 && !legal.includes(res.move)) {
    bad(`move ${res.move} 不是合法着法(合法:${legal.join(',')})`);
  }

  // 完全求解必须精确:拿独立裁判算一遍精确子差
  let want = null;
  if (pos.st && res.exact && pos.empties <= 10) {
    want = solveExact(pos.st, pos.me, new Map());
    if (Math.abs(res.score - want) > 0.5) bad(`exact 但 score=${res.score},独立重算是 ${want}`);
  } else if (res.exact && !pos.st) {
    bad('开局局面不该报 exact');
  }
  if (res.exact && pos.empties > lv.end) bad(`空位 ${pos.empties} > end ${lv.end} 却报了 exact`);

  return {
    ok: notes.length === 0, notes, want,
    row: { case: c.name, level, lvName: lv.name, move: res.move, score: res.score, depth: res.depth, nodes: res.nodes, ms: res.ms, exact: res.exact },
  };
}

/* ==================== CLI ==================== */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const argv = process.argv.slice(2);
  const dir = argv.find((a) => !a.startsWith('--')) || '.';
  const li = argv.indexOf('--levels');
  const asked = li >= 0 ? argv[li + 1].split(',').map(Number) : null;   // null = 用引擎的 default
  const verbose = argv.includes('--verbose');

  const eng = await loadEngine(dir);
  const pong = await eng.ask({ type: 'ping' });
  const meta = Object.keys(pong)
    .filter((k) => !['type', 'tag', 'engine', 'error'].includes(k))
    .map((k) => `${k}=${typeof pong[k] === 'number' && !Number.isInteger(pong[k]) ? Number(pong[k]).toFixed(6) : pong[k]}`)
    .join(' ');
  console.log(`\n[契约] 引擎目录 ${eng.root}`);
  console.log(`  ping   → tag=${pong.tag} engine=${pong.engine}${meta ? ' ' + meta : ''}${pong.error ? ' error=' + pong.error : ''}`);

  let fails = 0;
  if (pong.tag !== 'othello-engine-v1') { console.log(`  ✗ tag 应为 othello-engine-v1,得到 ${pong.tag}`); fails++; }
  if (!['js', 'wasm'].includes(pong.engine)) { console.log(`  ✗ engine 字段应为 js/wasm,得到 ${pong.engine}`); fails++; }
  if (pong.error) fails++;

  /* 难度表:问引擎要,不假设 —— 两套实现的档位参数本来就不通用 */
  const found = await fetchLevels(eng);
  const LEVELS = found.table;
  for (const n of found.notes) { console.log(`  ✗ levels 契约:${n}`); fails++; }
  console.log(`  levels → 引擎自报 ${LEVELS.length} 档,默认第 ${found.def} 档「${LEVELS[found.def]?.name ?? '?'}」`);
  for (let i = 0; i < LEVELS.length; i++) {
    const lv = LEVELS[i];
    console.log(`      [${i}] ${String(lv.name).padEnd(4)} depth ${String(lv.depth).padStart(2)} · end ${String(lv.end).padStart(2)} · budget ${String(lv.budget).padStart(9)}`);
  }

  /* 缺省跑:引擎的 default **加上第 0 档**。第 0 档(最便宜那档,通常是"不搜索"的
   * 贪心)走的是**另一条代码路径**,高深度那几档永远覆盖不到它 —— zig 通道就因此在
   * 初级档漏过一次"未初始化 order 数组 → 返回非法着法"的 bug,直到对打脚本
   * (tools/match-branches.mjs)才暴露出来。第 0 档最便宜,白扫一遍不亏。 */
  const levels = asked ?? [...new Set([found.def, 0])].filter((i) => LEVELS[i]).sort((a, b) => a - b);

  /* state 契约:规则事实的单一来源(合法位 / 翻子 / 数子 / 终局 / 胜者)。
   * 两个用例都是**确定局面**,不依赖搜索:
   *   初始局面 → 4 个合法位(d3/c4/f5/e6)、各翻 1 子、2:2、60 空、未终局;
   *   满盘(黑 40 白 24)→ over、reason='full'、黑(own)胜。
   * 两分支的 moves/flips/计数字段必须逐项一致。 */
  {
    const mk = (cells) => {
      let lo = 0, hi = 0;
      for (const i of cells) { if (i < 32) lo |= 1 << i; else hi |= 1 << (i - 32); }
      return [lo >>> 0, hi >>> 0];
    };
    const s0 = await eng.ask({ type: 'state', own: mk([28, 35]), opp: mk([27, 36]) });
    const stNotes = [];
    if (s0.type !== 'state') stNotes.push(`type 应为 'state',得到 ${s0.type}`);
    if (JSON.stringify(s0.moves) !== JSON.stringify([19, 26, 37, 44])) stNotes.push('moves 应为 [19,26,37,44](d3/c4/f5/e6)');
    if (!s0.flips || s0.flips.length !== 4 || s0.flips.some((f) => f.length !== 1)) stNotes.push('每手应各翻 1 子');
    if (s0.oppHasMoves !== true) stNotes.push('oppHasMoves 应为 true(白方在初始局面也有棋)');
    if (s0.ownCount !== 2 || s0.oppCount !== 2 || s0.empties !== 60) stNotes.push('子数/空格数应为 2/2/60');
    if (s0.over !== false) stNotes.push('初始局面不应 over');

    const all = Array.from({ length: 64 }, (_, i) => i);
    const sf = await eng.ask({ type: 'state', own: mk(all.slice(0, 40)), opp: mk(all.slice(40)) });
    if (sf.over !== true || sf.reason !== 'full' || sf.winner !== 'own') {
      stNotes.push('满盘(黑 40 白 24)应 over / reason=full / winner=own');
    }
    if (stNotes.length) { fails += stNotes.length; for (const n of stNotes) console.log(`  ✗ state 契约:${n}`); }
    else console.log('  state  → 初始 4 合法位 / 计数 2:2/60 空 ✓;满盘终局 reason=full winner=own ✓');
  }

  /* depth 覆盖契约:think 的 `depth` 只替换该档位的**深度上限**,end/budget 不变。
   * 标定与跨实现对打靠它把深度钉住(两边难度表本来不同)。这里专门要一个**比档位
   * 更浅**的深度:若实现忽略该字段,回包会给出档位表里的 depthMax,当场露馅。 */
  {
    const DK = 2;
    const li = LEVELS.findIndex((l) => l.depth > DK);
    if (li < 0) {
      console.log(`  (跳过 depth 覆盖检查:没有 depth > ${DK} 的档位)`);
    } else {
      const r = await eng.ask({
        type: 'think', id: 99,
        own: [0x10000000, 0x8], opp: [0x08000000, 0x10],   // 初始局面(黑先)
        level: li, depth: DK, empties: 60,
      }, 240_000);
      const dn = [];
      if (r.error) dn.push(`回包带 error:${r.error}`);
      if (r.depthMax !== DK) dn.push(`depthMax 应被 ${DK} 覆盖,得到 ${r.depthMax}(档位 ${li} 是 d${LEVELS[li].depth})`);
      if (!NUM(r.depth) || r.depth > DK) dn.push(`实际 depth 不该超过覆盖值 ${DK},得到 ${r.depth}`);
      if (dn.length) { fails += dn.length; for (const n of dn) console.log(`  ✗ depth 覆盖契约:${n}`); }
      else console.log(`  depth  → 覆盖 d${LEVELS[li].depth} → d${DK} 生效(depthMax=${r.depthMax} · 实到 d${r.depth})✓`);
    }
  }

  console.log(`\n  用例                      档位   着法  评分      深度  节点      耗时      精确`);
  for (const li2 of levels) {
    if (!LEVELS[li2]) { console.log(`  ✗ 没有第 ${li2} 档难度(引擎只报了 ${LEVELS.length} 档)`); fails++; continue; }
    for (const c of CASES) {
      const r = await runCase(eng, c, li2, { table: LEVELS, timeout: 240_000 });
      if (!r.ok) fails++;
      const w = r.row;
      console.log(`  ${r.ok ? '✓' : '✗'} ${w.case.padEnd(22)} ${w.lvName.padEnd(5)} `
        + `${String(w.move).padStart(4)}  ${w.score.toFixed(2).padStart(8)}  ${String(w.depth).padStart(4)}  `
        + `${String(w.nodes).padStart(8)}  ${(w.ms.toFixed(0) + 'ms').padStart(8)}  ${w.exact ? '✓' : ' '}`
        + (r.want !== null ? `  (裁判 ${r.want})` : ''));
      for (const n of r.notes) console.log(`      ✗ ${n}`);
      if (verbose) console.log(`      raw ${JSON.stringify({ move: w.move, score: w.score, depth: w.depth, nodes: w.nodes, exact: w.exact })}`);
    }
  }
  console.log(fails === 0 ? '\n✓ Worker 契约冒烟全部通过' : `\n✗ Worker 契约冒烟失败 ${fails} 项`);
  process.exit(fails === 0 ? 0 : 1);
}
