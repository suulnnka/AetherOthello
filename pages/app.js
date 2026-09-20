/* ============================================================
 * 黑白棋在线对弈页 —— UI 移植自 AetherWebOS 的黑白棋应用
 * (js/apps/reversi/index.js),布局与交互保持一致:
 * 顶栏「新对局 / 难度 / 人机 / 换边 / 悔棋」+ 中央棋盘 +
 * 底栏左侧行棋状态、右侧等宽字体引擎搜索信息。
 *
 * 引擎即本仓库 vendor 的主角:src/worker.js(zig → othello.wasm)。
 * 合法落点、翻转子、数子、终局与胜负全部经 {type:'state'} 消息问
 * Worker —— UI 只把回包的翻子写到自己的 8×8 数组上(纯数据变换)。
 * 消息契约见 docs/WORKER-PROTOCOL.md。
 * ============================================================ */

/* ==================== 微型工具(替代 webos 的 core)==================== */
const $ = (sel) => document.querySelector(sel);

/** 建 DOM:el('button', {class, onClick, dataset}, ...children) */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** 线性图标(路径数据取自 webos 的 core/icons.js) */
const ICON_PATHS = {
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
  reply: '<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>',
};
const icon = (name) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICON_PATHS[name] || '';
  return s;
};

/** webos dialogs.info 的页内替身 */
const dlg = $('#dlg');
function showDialog({ title, message }) {
  $('#dlgTitle').textContent = title;
  $('#dlgMsg').textContent = message;
  if (!dlg.open) dlg.showModal();
}
$('#dlgOk').addEventListener('click', () => dlg.close());
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

/** webos bus.notify 的页内替身:右下角吐司 */
function toast(text) {
  const t = el('div', { class: 'toast' }, text);
  t.addEventListener('click', () => t.remove());
  $('#toasts').append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 220); }, 3200);
}

/** 主题:webos 的浅 / 深双主题,记在 localStorage */
const themeBtn = $('#themeBtn');
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeBtn.replaceChildren(icon(theme === 'dark' ? 'sun' : 'moon'));
  try { localStorage.setItem('aether-pages-theme', theme); } catch {}
}
applyTheme((() => {
  try { return localStorage.getItem('aether-pages-theme') || 'dark'; } catch { return 'dark'; }
})());
themeBtn.addEventListener('click', () =>
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

const setTitle = (t) => { $('#winTitle').textContent = t; };

/* ==================== 对局(逻辑同 webos 黑白棋应用)==================== */

const other = (p) => (p === 'b' ? 'w' : 'b');

/** 标准开局四位(通用常数) */
function initBoard() {
  const b = Array.from({ length: 8 }, () => Array(8).fill(null));
  b[3][3] = 'w'; b[3][4] = 'b'; b[4][3] = 'b'; b[4][4] = 'w';
  return b;
}

const moveName = (p) => 'abcdefgh'[p & 7] + ((p >> 3) + 1);
const fmtN = (n) => (n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n));
const fmtT = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : Math.round(ms) + 'ms');
const fmtNps = (res) => (res.ms > 0 ? ` · ${fmtN(Math.round(res.nodes / res.ms * 1000))}节点/s` : '');
const sideName = (p) => (p === 'b' ? '黑方' : '白方');

/** 棋盘 + 行棋方 → 位板的两半(lo = 第 1–4 行,hi = 第 5–8 行)。
 *  wasm 的 i64 在 JS 侧是 BigInt,边界上容易写错,所以 ABI 统一拆两个 u32;
 *  这里直接按位拼,不经过 BigInt —— `>>> 0` 把符号位掰回来。 */
function halfs(b, color) {
  let lo = 0, hi = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (b[r][c] !== color) continue;
      const i = r * 8 + c;
      if (i < 32) lo |= 1 << i; else hi |= 1 << (i - 32);
    }
  }
  return [lo >>> 0, hi >>> 0];
}

const appEl = $('#app');

let board = initBoard();
let turn = 'b';          // 行棋方(黑先)
let gameOver = false;
let vsAI = true;
let humanColor = 'b';    // 人机模式下玩家执子方,「换边」互换
let moves = [];          // 走子历史 { color, r, c, flips },悔棋按它还原
let lastMove = null;
let searchGen = 0;       // 搜索代数:作废在途请求用的请求号(见 killWorker)
let thinking = false;
/* 每局种子(与 webos 应用同款):开局书容差选着 + 根同分随机化;新对局重掷 */
let gameSeed = 1 + Math.floor(Math.random() * 2 ** 47);
/* 局面缓存(全部来自最近一次 state 回包,按当前行棋方查询) */
let legalNow = new Map();
let countsCache = { black: 2, white: 2 };
let empties = 60;
/* 难度表由**引擎自报**(协议里的 {type:'levels'}),UI 不猜 */
let levels = [];
let levelIdx = 0;
let levelsP = null;
let levelsResolve = null;
const aiColor = () => other(humanColor);
const lvName = () => levels[levelIdx]?.name ?? '—';

const statusL = el('span', {}, '');
const infoL = el('span', {
  class: 'mono', style: { fontSize: '11px', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
}, '');
const boardEl = el('div', { class: 'rv-board' });
const fitWrap = el('div', { class: 'fit-wrap' }, boardEl);
const blackCount = el('span', { class: 'rv-count black' }, '2');
const whiteCount = el('span', { class: 'rv-count white' }, '2');

/** 棋盘按可用空间等比缩放(棋盘内部是固定像素布局) */
function fitBoard() {
  const body = appEl.querySelector('.app-body');
  if (!body) return;
  const w = body.clientWidth - 24, h = body.clientHeight - 24;
  const bw = boardEl.offsetWidth, bh = boardEl.offsetHeight;
  if (!bw || !bh) return;
  fitWrap.style.transform = `scale(${Math.min(1, w / bw, h / bh)})`;
}

/** 把搜索结果写入状态栏右侧 */
function showSearch(res) {
  const me = sideName(aiColor()), opp = sideName(other(aiColor()));
  const sc = (s) => (s >= 0 ? `${me} +${s.toFixed(1)}` : `${opp} +${(-s).toFixed(1)}`);
  if (res.only) { infoL.textContent = `唯一合法步 ${moveName(res.move)},无需搜索`; return; }
  /* 开局书命中:没搜索(depth=0、nodes=0),来源只能信回包的 book 字段。
   * 显示格式与 webos 应用对齐(书值是行棋方视角的精确终局子差) */
  if (res.book) { infoL.textContent = `开局书 · 最佳 ${moveName(res.move)} · 书值 ${sc(res.score)}`; return; }
  const tail = ` · 节点 ${fmtN(res.nodes)} · ${fmtT(res.ms)}${fmtNps(res)}`;
  if (res.greedy) {
    infoL.textContent = `初级 贪心选点 ${moveName(res.move)} · 评估 ${sc(res.score)}${tail}`;
    return;
  }
  if (res.exact) {
    const d = Math.round(res.score);
    const verdict = d > 0 ? `${me}胜 ${d} 子` : d < 0 ? `${opp}胜 ${-d} 子` : '和棋';
    infoL.textContent = `残局完全求解(${res.empties} 空):${verdict} · 最佳 ${moveName(res.move)}${tail}`;
    return;
  }
  /* 进了完全求解的空格区间却没跑完(节点预算截断):明说,别报凭空的胜负 */
  const head = res.partial ? `残局求解未跑完(${res.empties} 空)` : `深度 ${res.depth}/${res.depthMax}`;
  infoL.textContent = `${head} · 最佳 ${moveName(res.move)} · 评估 ${sc(res.score)}${tail}`;
}

function renderBoard() {
  boardEl.innerHTML = '';
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];
      /* 提示只属于行棋方:人机模式轮到 AI 时,高亮类和点都不给 */
      const isHint = !gameOver && piece === null && (!vsAI || turn === humanColor) && legalNow.has(r * 8 + c);
      const cell = el('button', {
        class: 'rv-cell' + (isHint ? ' hint' : '') + (lastMove && lastMove[0] === r && lastMove[1] === c ? ' last' : ''),
        dataset: { r: String(r), c: String(c) },
        onClick: () => humanMove(r, c),
      });
      if (piece) cell.append(el('div', { class: `rv-piece ${piece}${lastMove && lastMove[0] === r && lastMove[1] === c ? ' just' : ''}` }));
      else if (isHint) cell.append(el('div', { class: 'rv-hint-dot' }));
      boardEl.append(cell);
    }
  }
  blackCount.textContent = String(countsCache.black);
  whiteCount.textContent = String(countsCache.white);
}

function updateStatus() {
  statusL.textContent = gameOver ? '终局' : `${sideName(turn)}行棋`;
  setTitle('黑白棋');
}

/** 终局:胜负与原因都是 state 回包的引擎事实 */
function finish(st) {
  gameOver = true;
  const winnerAbs = st.winner === null ? null : st.winner === 'own' ? st.side : other(st.side);
  const reason = st.reason === 'full' ? '棋盘已满' : '双方无棋';
  const { black, white } = countsCache;
  let title, msg = `黑 ${black} : 白 ${white}`, line;
  if (winnerAbs === null) {
    title = '平局';
    line = `${reason} — 和棋`;
  } else {
    const winner = sideName(winnerAbs);
    line = `${reason} — ${winner}胜`;
    title = vsAI
      ? (winnerAbs === humanColor ? '🎉 你赢了!' : 'AI 获胜')
      : `🎉 ${winner}获胜`;
  }
  showDialog({ title, message: msg });
  statusL.textContent = line;
}

/** 用引擎给的翻子落子(纯数据变换,不含任何规则判断) */
function applyWithFlips(r, c, color, flips) {
  board[r][c] = color;
  for (const bit of flips) board[bit >> 3][bit & 7] = color;
  moves.push({ color, r, c, flips: flips.map((bit) => [bit >> 3, bit & 7]) });
  lastMove = [r, c];
}

/** state 回包落地:缓存合法表 / 子数 / 空格,终局直接以回包为准 */
function applyState(st) {
  legalNow = new Map(st.moves.map((cell, i) => [cell, st.flips[i]]));
  countsCache = st.side === 'b' ? { black: st.ownCount, white: st.oppCount } : { black: st.oppCount, white: st.ownCount };
  empties = st.empties;
  if (st.over) { finish(st); renderBoard(); return; }
  renderBoard();
  updateStatus();
  if (vsAI && turn === aiColor() && !gameOver) setTimeout(aiMove, 260);
}

/* ---------- 回合推进:向 Worker 要当前方的局面事实 ---------- */
async function refresh() {
  const gen = searchGen;
  renderBoard();
  updateStatus();
  if (gameOver) return;
  const st = await fetchState(turn);
  if (gen !== searchGen || !st) return;
  if (st.moves.length === 0 && !st.over) {
    /* 跳过必须把 turn 真翻给对方(与 webos 应用同步修):状态栏、提示点归属、
     * applyState 里的 AI 调度全都读它 —— 不翻就是行棋方停在无棋方,
     * 轮到谁谁点不动,该 AI 接手时又没人调度,棋局卡死。 */
    const skipped = turn;
    turn = other(turn);
    const otherSt = await fetchState(turn);
    if (gen !== searchGen || !otherSt) return;
    applyState({ ...otherSt, side: turn });
    toast('黑白棋:' + `${sideName(skipped)}无合法棋,跳过回合`);
    return;
  }
  applyState({ ...st, side: turn });
}

/** 落子裁决:现场向 Worker 要一次新鲜局面,缓存只管提示渲染 */
async function humanMove(r, c) {
  if (gameOver || (vsAI && turn !== humanColor)) return;
  /* 按下的瞬间就撤提示点:裁决要等 state 回包(首手还含引擎冷启动),旧提示
   * 点会一直亮到回包落地。只对提示格生效 —— 误点非法格时提示点随后照常回来。 */
  if (legalNow.has(r * 8 + c)) {
    for (const cell of boardEl.querySelectorAll('.rv-cell.hint')) cell.classList.remove('hint');
    for (const dot of boardEl.querySelectorAll('.rv-hint-dot')) dot.remove();
  }
  const color = turn;
  const gen = searchGen;
  const st = await fetchState(color);
  /* turn 复查:await 期间若另一手已落地(连点两格,两次裁决都带着旧盘面),
   * 这一次必须作废 —— 否则同一方能连落两手脏子。gen 只盯新对局/悔棋/换边。 */
  if (gen !== searchGen || turn !== color) return;
  applyState({ ...st, side: color });          // 顺手把提示/子数缓存校准
  const flip = st.flips[st.moves.indexOf(r * 8 + c)];
  if (!flip) return;                           // 非法落点
  applyWithFlips(r, c, color, flip);
  turn = other(turn);
  refresh();
}

/* ---------- AI:搜索跑在 Worker 里(zig → wasm 通道)---------- */
let worker = null;
let pending = null;            // 在途搜索请求 { id, resolve, only }
let statePending = new Map();  // 在途 state 请求 id → resolve
let reqId = 0;                 // 请求号 —— 必须与 searchGen(作废代数)分开

function killWorker() {
  if (worker) { worker.terminate(); worker = null; }
  thinking = false;
  searchGen++;                 // 让已经进了主线程队列的旧结果作废
  if (pending) { const p = pending; pending = null; p.resolve(null); }
  for (const res of statePending.values()) res(null);
  statePending.clear();
}

function ensureWorker() {
  if (worker) return worker;
  try {
    /* pages/app.js 的上一级就是仓库根:src/worker.js 与 wasm/ 恰好都在
     * 站点根下(本地仓库起服与 GitHub Pages 的 _site 同一布局) */
    worker = new Worker(new URL('../src/worker.js', import.meta.url), { type: 'module' });
  } catch (err) {
    console.error('[reversi-pages] 无法创建 AI Worker:', err);
    worker = null;
    statusL.textContent = 'AI 不可用(Worker 创建失败)';
    return null;
  }
  worker.onmessage = onEngineMsg;
  worker.onerror = (ev) => {
    console.warn('[reversi-pages] AI Worker 异常:', ev.message || ev);
    killWorker();
    statusL.textContent = 'AI 出错,已跳过本步';
  };
  return worker;
}

function onEngineMsg(e) {
  const d = e.data;
  if (!d) return;
  if (d.type === 'levels') { applyLevels(d); return; }
  if (d.type === 'state') {
    const res = statePending.get(d.id);
    if (!res) return;                       // 过期(已被 killWorker 兜底)
    statePending.delete(d.id);
    res(d.error ? null : d);
    return;
  }
  if (!pending || d.id !== pending.id) return;      // 过期结果直接丢
  const p = pending;
  pending = null;
  if (d.error) {
    console.warn('[reversi-pages] 引擎异常:', d.error);
    statusL.textContent = '引擎异常:' + d.error;
    p.resolve(null);
    return;
  }
  const lv = levels[levelIdx];       // 引擎自报的表;没到就退回「不算截断」
  p.resolve({
    ...d,
    only: p.only,
    greedy: d.depth === 0 && !d.exact && !d.book,
    partial: lv ? d.empties <= lv.end && !d.exact : false,
    depthMax: d.depthMax ?? lv?.depth ?? 0,
  });
}

/** 开局问一次引擎的难度表,拿到才填下拉、解开 levelsP 闸门 */
function applyLevels(d) {
  const table = Array.isArray(d.levels)
    ? d.levels.filter((lv) => lv && typeof lv.name === 'string' && lv.name) : [];
  if (!table.length) {
    levelSel.title = 'AI 难度不可用(引擎未上报)';
    levelsResolve?.();
    return;
  }
  levels = table;
  const def = Number.isInteger(d.default) && d.default >= 0 && d.default < table.length ? d.default : 0;
  levelIdx = def;
  levelSel.append(...table.map((lv, i) => el('option', { value: String(i) }, lv.name)));
  levelSel.value = String(def);
  levelSel.disabled = false;
  levelSel.title = 'AI 难度:' + table.map((lv) => lv.name).join(' / ');
  levelsResolve?.();
}

function fetchLevels(timeoutMs = 5000) {
  if (!ensureWorker()) { levelsResolve?.(); return; }
  worker.postMessage({ type: 'levels' });
  setTimeout(() => levelsResolve?.(), timeoutMs);
}

/** 问引擎要某方的局面事实({type:'state'}) */
function fetchState(side) {
  return new Promise((resolve) => {
    if (!ensureWorker()) { resolve(null); return; }
    const id = ++reqId;
    statePending.set(id, resolve);
    worker.postMessage({ type: 'state', id, own: halfs(board, side), opp: halfs(board, other(side)) });
  }).then((d) => (d ? { ...d, side } : null));
}

/** 向 Worker 要一手;请求被作废时返回 null */
async function requestThink() {
  if (levelsP) await levelsP;    // 先等表:免得「界面一个档、引擎另一个档」
  return new Promise((resolve) => {
    if (typeof Worker === 'undefined') {
      statusL.textContent = '当前环境不支持 Web Worker,AI 不可用';
      resolve(null); return;
    }
    if (!ensureWorker()) { resolve(null); return; }
    pending = { id: ++reqId, resolve, only: legalNow.size === 1 };
    worker.postMessage({
      type: 'think', id: pending.id,
      own: halfs(board, turn), opp: halfs(board, other(turn)),
      level: levelIdx, empties, seed: gameSeed,
    });
    infoL.textContent = `搜索中…(${lvName()})`;
  });
}

async function aiMove() {
  const color = aiColor();
  if (gameOver || !vsAI || turn !== color) return;
  if (!document.contains(appEl)) { killWorker(); return; }
  if (thinking) { setTimeout(aiMove, 260); return; }
  thinking = true;
  const gen = searchGen;
  try {
    const res = await requestThink();
    if (!res || gen !== searchGen || gameOver || !document.contains(appEl)) return;
    // 书着秒回,不再垫延迟(曾经的 350~800ms「像想了一下」被判定为 bug)
    /* AI 的手也按新鲜局面裁决 */
    const st = await fetchState(color);
    if (!st || gen !== searchGen || gameOver || !document.contains(appEl)) return;
    applyState({ ...st, side: color });
    if (res.move < 0) {                 // 引擎说无棋可走:交给 refresh 走「跳过回合」
      turn = other(color);
      refresh();
      return;
    }
    const r = res.move >> 3, c = res.move & 7;
    const flips = st.flips[st.moves.indexOf(res.move)];
    if (!flips) {                       // 兜底:宁可跳过也不能往盘上落一手脏子
      console.warn('[reversi-pages] 引擎返回非法着法', res.move);
      statusL.textContent = '引擎返回非法着法,已跳过本步';
      turn = other(color);
      refresh();
      return;
    }
    applyWithFlips(r, c, color, flips);
    turn = other(color);
    showSearch(res);
    refresh();
  } finally {
    if (gen === searchGen) thinking = false;
  }
}

/** 悔棋:撤到「轮到玩家重新决策」为止。人机撤两手,人人撤一手 */
function doUndo() {
  if (!moves.length) return;
  killWorker();
  let n = 1;
  if (vsAI && turn === humanColor && moves.length >= 2) n = 2;
  while (n-- > 0 && moves.length) {
    const m = moves.pop();
    board[m.r][m.c] = null;
    for (const [fr, fc] of m.flips) board[fr][fc] = other(m.color);
    turn = m.color;
  }
  const last = moves[moves.length - 1];
  lastMove = last ? [last.r, last.c] : null;
  gameOver = false;
  legalNow = new Map();   // 旧局面的提示缓存作废,renderBoard 读它画点,不清就残留到新状态回包
  infoL.textContent = '';
  renderBoard();
  if (vsAI && turn === aiColor()) setTimeout(aiMove, 260);
  else refresh();
}

/** 换边:与 AI 互换执子方。棋盘上下对称,无需转向 */
function switchSide() {
  killWorker();
  humanColor = other(humanColor);
  renderBoard();
  if (!gameOver && turn === aiColor()) setTimeout(aiMove, 260);
  else if (!gameOver) refresh();
}

/* ---------- 工具栏(结构与 webos 应用一致)---------- */
const newBtn = el('button', { class: 'btn primary', title: '重新开始一局', onClick: () => {
  killWorker();
  gameSeed = 1 + Math.floor(Math.random() * 2 ** 47);
  board = initBoard(); turn = 'b'; gameOver = false; lastMove = null; moves = [];
  legalNow = new Map();   // 清旧提示缓存:refresh 首帧就渲染,别拿上一局的点画新局
  infoL.textContent = '';
  refresh();
  if (vsAI && turn === aiColor()) setTimeout(aiMove, 260);
} }, icon('refresh'), '新对局');

const levelSel = el('select', {
  class: 'select rv-level',
  title: 'AI 难度(等引擎上报)',
  'aria-label': 'AI 难度',
  disabled: true,
  onChange: (e) => {
    killWorker();
    levelIdx = Number(e.currentTarget.value) || 0;
    infoL.textContent = '';
    if (vsAI && turn === aiColor() && !gameOver) setTimeout(aiMove, 260);
  },
});
const aiBtn = el('button', {
  class: 'btn', title: '切换人机 / 双人对战',
  onClick: (e) => {
    killWorker();
    vsAI = !vsAI;
    e.currentTarget.replaceChildren(vsAI ? '人机' : '双人');
    sideBtn.disabled = !vsAI;
    if (!vsAI) { infoL.textContent = ''; refresh(); }
    else if (!gameOver) refresh();
    else updateStatus();
  },
}, '人机');
const sideBtn = el('button', {
  class: 'btn', title: '换边:与 AI 互换执子方',
  onClick: switchSide,
}, '换边');
const undoBtn = el('button', {
  class: 'btn', title: '悔棋:人机模式连 AI 的应手一起撤,人人模式撤一手',
  onClick: doUndo,
}, icon('reply'), '悔棋');

appEl.append(el('div', { class: 'app' },
  el('div', { class: 'app-toolbar' },
    newBtn,
    el('label', { class: 'rv-level-wrap', title: 'AI 难度' },
      el('span', { class: 'dim', style: { fontSize: '12px' } }, '难度'), levelSel),
    aiBtn, sideBtn, undoBtn,
    el('span', { class: 'grow' }),
    el('span', { class: 'row', style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
      blackCount, el('span', { class: 'dim' }, ':'), whiteCount)),
  el('div', { class: 'app-body' }, fitWrap),
  el('div', { class: 'app-status' }, statusL,
    el('span', { class: 'grow' }),
    infoL)));

/* 问引擎要难度表与初始局面;棋盘缩放跟随窗口 */
levelsP = new Promise((res) => { levelsResolve = res; });
fetchLevels();
refresh();
new ResizeObserver(fitBoard).observe(appEl.querySelector('.app-body'));
fitBoard();

/* 页面冒烟探针钩子(验证脚本用,与 webos 应用的 window.__reversi 同思路) */
window.__pagesStats = () => ({
  plies: moves.length, turn, human: humanColor, gameOver, vsAI,
  counts: countsCache, level: lvName(),
});
window.__pagesHumanMove = async () => {
  if (gameOver || (vsAI && turn !== humanColor) || !legalNow.size) return false;
  const cell = legalNow.keys().next().value;
  await humanMove(cell >> 3, cell & 7);
  return true;
};
