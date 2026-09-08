/* ============================================================================
 * commupass_fukuoka  ―  ロジック＆UI
 * ========================================================================== */
'use strict';

const LS_KEY = 'commupass_fukuoka_v1';
const YEN = n => (n == null || isNaN(n)) ? '—' : '¥' + Math.round(n).toLocaleString('ja-JP');
const pad = n => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

/* ---------------------------------------------------------------------------
 * 状態
 * ------------------------------------------------------------------------- */
const now = new Date();
let state = {
  from: '', to: '', via: '', structIdx: 0,
  fares: {},                       // "A|B" -> {m1,m3,m6,ic}
  holiday: {
    preset: 'weekday_holiday',
    restDows: [0, 6], useHolidays: true, useYearEnd: true, altSat: 0,
    shiftDays: {},                 // "YYYY-M" -> 出勤日数
    customOff: [],                 // ["YYYY-MM-DD", ...]
  },
  extras: [],                      // [{type, from:"YYYY-MM-DD", to:"YYYY-MM-DD"}]
  period: { startY: now.getFullYear(), startM: now.getMonth() + 1, months: 12 },
  detour: { station: '', fare: 0, trips: 4, roundtrip: true, extendDelta: 0, op: 'subway' },
  refund: { passType: 'm6', buyDate: '', refundDate: '' },
};

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY));
    if (s && typeof s === 'object') state = Object.assign(state, s);
  } catch (e) { /* ignore */ }
}
function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
}

/* ---------------------------------------------------------------------------
 * 駅・路線グラフ
 * ------------------------------------------------------------------------- */
const SEP = '|';
const nodeId = (line, st) => line + SEP + st;
const parseNode = id => { const i = id.indexOf(SEP); return { line: id.slice(0, i), st: id.slice(i + 1) }; };

// 駅名 -> 所属路線
const stationLines = {};
for (const [lid, L] of Object.entries(LINES)) {
  L.st.forEach(s => { (stationLines[s] || (stationLines[s] = [])).push(lid); });
}
const ALL_STATIONS = Object.keys(stationLines);

function transferKind(a, b) {
  for (const t of TRANSFERS) {
    if ((t.a === a && t.b === b) || (t.a === b && t.b === a)) return t;
  }
  if (a === b) return { a, b, kind: 'transfer', note: '同一駅で乗換' };
  return null;
}

// 隣接リスト
const adj = {};                                   // nodeId -> [{to, cost, type, kind, note}]
function addEdge(u, v, cost, type, extra) {
  (adj[u] || (adj[u] = [])).push(Object.assign({ to: v, cost, type }, extra || {}));
}
for (const [lid, L] of Object.entries(LINES)) {
  for (let i = 0; i < L.st.length - 1; i++) {
    const u = nodeId(lid, L.st[i]), v = nodeId(lid, L.st[i + 1]);
    addEdge(u, v, 1, 'ride'); addEdge(v, u, 1, 'ride');
  }
}
// 乗換エッジ（同名駅 or TRANSFERS）
const XFER_COST = { through: 0.5, transfer: 10, walk: 14 };
const seenPairs = new Set();
function connectStations(sa, sb) {
  const key = [sa, sb].sort().join('||');
  if (seenPairs.has(key)) return; seenPairs.add(key);
  const tk = transferKind(sa, sb); if (!tk) return;
  const kind = tk.kind, cost = XFER_COST[kind] ?? 10;
  for (const la of (stationLines[sa] || [])) {
    for (const lb of (stationLines[sb] || [])) {
      if (la === lb && sa === sb) continue;
      const u = nodeId(la, sa), v = nodeId(lb, sb);
      addEdge(u, v, cost, 'xfer', { kind, note: tk.note });
      addEdge(v, u, cost, 'xfer', { kind, note: tk.note });
    }
  }
}
for (const s of ALL_STATIONS) if ((stationLines[s] || []).length > 1) connectStations(s, s);
for (const t of TRANSFERS) connectStations(t.a, t.b);

/* Dijkstra：乗換を強く嫌い、次に駅数を最小化 */
function findRoute(from, to) {
  if (!stationLines[from] || !stationLines[to]) return null;
  const starts = stationLines[from].map(l => nodeId(l, from));
  const goalSet = new Set(stationLines[to].map(l => nodeId(l, to)));
  const dist = {}, prev = {};
  const pq = [];
  const push = (id, d) => { pq.push({ id, d }); };
  starts.forEach(s => { dist[s] = 0; push(s, 0); });
  while (pq.length) {
    pq.sort((a, b) => a.d - b.d);
    const { id, d } = pq.shift();
    if (d !== dist[id]) continue;
    if (goalSet.has(id)) break;
    for (const e of (adj[id] || [])) {
      const nd = d + e.cost;
      if (dist[e.to] == null || nd < dist[e.to]) {
        dist[e.to] = nd; prev[e.to] = { from: id, edge: e }; push(e.to, nd);
      }
    }
  }
  let goal = null, best = Infinity;
  for (const g of goalSet) if (dist[g] != null && dist[g] < best) { best = dist[g]; goal = g; }
  if (!goal) return null;
  // 復元
  const path = []; let cur = goal;
  while (cur != null) { path.unshift(cur); cur = prev[cur] ? prev[cur].from : null; }
  // セグメント化（路線ごと）
  const segs = []; const xfers = [];
  for (let i = 0; i < path.length; i++) {
    const p = parseNode(path[i]);
    const pr = prev[path[i]];
    if (i === 0) { segs.push({ line: p.line, op: LINES[p.line].op, from: p.st, to: p.st, stops: 0 }); continue; }
    const edge = pr.edge;
    const last = segs[segs.length - 1];
    if (edge.type === 'ride' && p.line === last.line) {
      last.to = p.st; last.stops++;
    } else {
      // 乗換 or 路線変更
      const prevP = parseNode(pr.from);
      xfers.push({ at: prevP.st, to: p.st, fromLine: prevP.line, toLine: p.line, kind: edge.kind || 'transfer', note: edge.note || '' });
      segs.push({ line: p.line, op: LINES[p.line].op, from: p.st, to: p.st, stops: 0 });
    }
  }
  // 空セグメント（乗換直後の単独ノード）を隣に統合
  const clean = [];
  for (const s of segs) {
    if (clean.length && s.line === clean[clean.length - 1].line) {
      clean[clean.length - 1].to = s.to; clean[clean.length - 1].stops += s.stops;
    } else clean.push(s);
  }
  return { path, segs: clean, xfers, opSegs: buildOpSegs(clean), cost: best };
}

// clean セグメント列 → 事業者セグメント（定期の単位）
function buildOpSegs(clean) {
  let opSegs = [];
  for (const s of clean) {
    const prev = opSegs[opSegs.length - 1];
    if (prev && prev.op === s.op) { prev.to = s.to; prev.lines.push(s.line); }
    else opSegs.push({ op: s.op, from: s.from, to: s.to, lines: [s.line] });
  }
  // 端の「0駅」セグメント（徒歩連絡で降りるだけの駅）は定期の単位から外す
  if (opSegs.length > 1) {
    while (opSegs.length > 1 && opSegs[0].from === opSegs[0].to) { opSegs[1]._entry = opSegs[0].from; opSegs.shift(); }
    while (opSegs.length > 1 && opSegs[opSegs.length - 1].from === opSegs[opSegs.length - 1].to) {
      opSegs[opSegs.length - 2]._exit = opSegs[opSegs.length - 1].to; opSegs.pop();
    }
  }
  return opSegs;
}

// 経由駅（乗換駅）を指定できるルート探索。via 未指定なら通常の findRoute。
function routeWithVia(from, to, via) {
  if (!via || via === from || via === to) return findRoute(from, to);
  const r1 = findRoute(from, via), r2 = findRoute(via, to);
  if (!r1 || !r2) return findRoute(from, to);
  const segs = r1.segs.concat(r2.segs.map(s => Object.assign({}, s)));
  const xfers = r1.xfers.slice();
  const lastL = r1.segs[r1.segs.length - 1], firstL = r2.segs[0];
  if (lastL && firstL && lastL.line !== firstL.line) {
    const tk = transferKind(lastL.to, firstL.from) || { kind: 'transfer', note: '指定経由' };
    xfers.push({ at: lastL.to, to: firstL.from, fromLine: lastL.line, toLine: firstL.line,
      kind: tk.kind, note: tk.note || '指定経由' });
  }
  xfers.push(...r2.xfers);
  // segs をライン単位で再結合
  const clean = [];
  for (const s of segs) {
    if (clean.length && s.line === clean[clean.length - 1].line) {
      clean[clean.length - 1].to = s.to; clean[clean.length - 1].stops += s.stops;
    } else clean.push(Object.assign({}, s));
  }
  const opSegs = buildOpSegs(clean);
  // via が実際に区間の境界（乗換／端）になっていなければ指定は無効 → 通常経路にフォールバック
  const boundaries = new Set();
  opSegs.forEach(s => { boundaries.add(s.from); boundaries.add(s.to); });
  xfers.forEach(x => { boundaries.add(x.at); boundaries.add(x.to); });
  if (!boundaries.has(via)) return findRoute(from, to);
  return { path: r1.path.concat(r2.path), segs: clean, xfers, opSegs, cost: r1.cost + r2.cost, via };
}

// 現在の状態からルートを得る
function currentRoute() {
  if (!state.from || !state.to || state.from === state.to) return null;
  return routeWithVia(state.from, state.to, state.via);
}

/* ---------------------------------------------------------------------------
 * 定期券の構成候補
 * ------------------------------------------------------------------------- */
function pairKey(a, b) { return [a, b].sort().join('|'); }

function passStructures(route) {
  const os = route.opSegs;
  const out = [];
  if (os.length === 1) {
    out.push({ type: 'single', label: `${OPERATORS[os[0].op].name}のみ・定期1枚`,
      legs: [{ op: os[0].op, from: os[0].from, to: os[0].to }] });
    return out;
  }
  // 分割（各事業者ぶん）
  out.push({
    type: 'split', label: `分割定期（${os.length}枚）`,
    legs: os.map(s => ({ op: s.op, from: s.from, to: s.to })),
    note: '各社の窓口・券売機でそれぞれ購入。IC1枚に載る場合あり。',
  });
  // 2社連絡
  if (os.length === 2) {
    const pk = pairKey(os[0].op, os[1].op);
    const rule = CONNECT_RULES[pk];
    if (rule && rule.ok) {
      out.unshift({
        type: 'renraku', label: '連絡定期（1枚）',
        legs: [{ op: 'renraku', from: os[0].from, to: os[1].to, ab: [os[0].op, os[1].op] }],
        note: rule.where,
      });
    }
  }
  // 3社以上：隣り合う2社が連絡可なら「部分連絡＋分割」
  if (os.length >= 3) {
    for (let i = 0; i < os.length - 1; i++) {
      const pk = pairKey(os[i].op, os[i + 1].op);
      if (CONNECT_RULES[pk] && CONNECT_RULES[pk].ok && THREE_OP_CONNECT_OK === false) {
        const legs = [];
        for (let j = 0; j < os.length; j++) {
          if (j === i) { legs.push({ op: 'renraku', from: os[i].from, to: os[i + 1].to, ab: [os[i].op, os[i + 1].op] }); j++; }
          else legs.push({ op: os[j].op, from: os[j].from, to: os[j].to });
        }
        out.push({ type: 'part', label: `部分連絡＋分割（${legs.length}枚）`, legs,
          note: `${OPERATORS[os[i].op].name}〜${OPERATORS[os[i + 1].op].name}を連絡定期に。3社通しの連絡定期は発売なし。` });
      }
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * 運賃の解決
 * ------------------------------------------------------------------------- */
function tableLookup(a, b) {
  for (const r of FARE_TABLE) {
    const [x, y] = r.key.split('|');
    if ((x === a && y === b) || (x === b && y === a)) return r;
  }
  return null;
}
function legKey(leg) { return `${leg.from}|${leg.to}`; }

// -> {m1,m3,m6,icRound, estimated, src, needInput}
function resolveLeg(leg) {
  const k = legKey(leg);
  const user = state.fares[k];
  const t = tableLookup(leg.from, leg.to);
  let m1, m3, m6, ic, src, estimated = false;

  if (user && user.m1) {
    m1 = +user.m1;
    m3 = user.m3 ? +user.m3 : null;
    m6 = user.m6 ? +user.m6 : null;
    ic = user.ic ? +user.ic : (t ? t.ic : null);
    src = '手入力';
  } else if (t) {
    m1 = t.m1; m3 = t.m3; m6 = t.m6; ic = t.ic; src = t.src;
  }

  const dm = DISCOUNT_MODEL[leg.op] || DISCOUNT_MODEL.subway;
  if (m1 && m3 == null) { m3 = Math.round(m1 * dm.m3 / 10) * 10; estimated = true; }
  if (m1 && m6 == null) { m6 = Math.round(m1 * dm.m6 / 10) * 10; estimated = true; }

  const needInput = !m1;
  return { m1, m3, m6, icRound: ic ? ic * 2 : null, estimated, src, needInput, op: leg.op, key: k };
}

function resolveStructure(st) {
  const legs = st.legs.map(resolveLeg);
  const complete = legs.every(l => l.m1 != null);
  const sum = k => legs.reduce((a, l) => a + (l[k] || 0), 0);
  return {
    ...st, legFares: legs, complete,
    m1: complete ? sum('m1') : null,
    m3: legs.every(l => l.m3 != null) ? sum('m3') : null,
    m6: legs.every(l => l.m6 != null) ? sum('m6') : null,
    icRound: legs.every(l => l.icRound != null) ? sum('icRound') : null,
    estimated: legs.some(l => l.estimated),
  };
}

/* ---------------------------------------------------------------------------
 * 出勤日数エンジン
 * ------------------------------------------------------------------------- */
function extrasSet() {
  const s = new Set();
  for (const ex of state.extras) {
    if (!ex.from) continue;
    const to = ex.to || ex.from;
    let d = new Date(ex.from + 'T00:00'), end = new Date(to + 'T00:00');
    let guard = 0;
    while (d <= end && guard++ < 800) {
      s.add(ymd(d.getFullYear(), d.getMonth() + 1, d.getDate()));
      d.setDate(d.getDate() + 1);
    }
  }
  return s;
}

function workingDays(y, m, cfg, exSet) {
  if (cfg.preset === 'shift') {
    const v = cfg.shiftDays[`${y}-${m}`];
    return v == null || v === '' ? null : clamp(+v, 0, 31);
  }
  const customOff = new Set(cfg.customOff || []);
  const dim = new Date(y, m, 0).getDate();
  let count = 0;
  for (let d = 1; d <= dim; d++) {
    const date = new Date(y, m - 1, d);
    const dow = date.getDay();
    let rest = cfg.restDows.includes(dow);
    if (rest && dow === 6 && cfg.altSat) {
      const nthSat = Math.ceil(d / 7);
      if (cfg.altSat === 2 && nthSat % 2 === 1) rest = false;   // 第1・3・5週の土曜は出勤
      else if (cfg.altSat === 1 && nthSat % 2 === 0) rest = false; // 第2・4週の土曜は出勤
      else if (cfg.altSat === 3) rest = false;                  // 毎週土曜出勤
    }
    if (rest) continue;
    const key = ymd(y, m, d);
    if (cfg.useHolidays && HOLIDAYS_JP.has(key)) continue;
    if (cfg.useYearEnd && ((m === 12 && d >= 29) || (m === 1 && d <= 3))) continue;
    if (customOff.has(key)) continue;
    if (exSet && exSet.has(key)) continue;
    count++;
  }
  return count;
}

function periodMonths() {
  const out = [];
  let y = state.period.startY, m = state.period.startM;
  for (let i = 0; i < state.period.months; i++) {
    out.push({ y, m });
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * 戦略比較
 * ------------------------------------------------------------------------- */
function strategyCompare(fare, wd) {
  // wd: [{y,m,days}]  fare: {m1,m3,m6,icRound}
  const n = wd.length;
  const M1 = fare.m1, M3 = fare.m3, M6 = fare.m6, IC = fare.icRound;
  const commuteDays = wd.map(x => x.days || 0);

  const allIC = commuteDays.reduce((a, d) => a + d * IC, 0);
  const all1M = commuteDays.reduce((a, d) => a + (d > 0 ? M1 : 0), 0);

  function blocks(size, unitCost) {
    let total = 0;
    for (let i = 0; i < n; i += size) {
      const chunk = commuteDays.slice(i, i + size);
      const anyCommute = chunk.some(d => d > 0);
      if (!anyCommute) continue;
      if (chunk.length === size) { total += unitCost; }
      else {
        // 端数：3ヶ月ぶん取れるなら M3、余りは M1
        let rem = chunk.length;
        if (size === 6 && rem >= 3 && M3) { total += M3; rem -= 3; }
        total += rem * M1;
      }
    }
    return total;
  }
  const all3M = M3 ? blocks(3, M3) : null;
  const all6M = M6 ? blocks(6, M6) : null;

  const hybrid = commuteDays.reduce((a, d) => a + Math.min(M1, d * IC), 0);
  const hybridPick = commuteDays.map(d => (M1 <= d * IC ? '定期' : 'IC'));

  const rows = [
    { key: 'ic', label: '全部ICで都度払い', total: allIC },
    { key: 'm1', label: '毎月 1ヶ月定期', total: all1M },
    { key: 'm3', label: '3ヶ月定期を継続', total: all3M },
    { key: 'm6', label: '6ヶ月定期を継続', total: all6M },
    { key: 'hybrid', label: '得な月だけ1ヶ月定期／他はIC', total: hybrid, pick: hybridPick },
  ].filter(r => r.total != null);
  rows.sort((a, b) => a.total - b.total);
  const best = rows[0];
  rows.forEach(r => { r.diff = r.total - best.total; r.perMonth = r.total / n; });
  return { rows, best, months: n };
}

/* ---------------------------------------------------------------------------
 * 月別 損益分岐
 * ------------------------------------------------------------------------- */
function monthlyBreakeven(fare, wd) {
  const M1 = fare.m1, IC = fare.icRound;
  const be = Math.ceil(M1 / IC);
  return {
    breakevenDays: be,
    rows: wd.map(x => {
      const icCost = x.days * IC;
      return {
        y: x.y, m: x.m, days: x.days, icCost, m1: M1,
        verdict: x.days >= be ? '定期' : 'IC',
        diff: icCost - M1,
      };
    }),
  };
}

/* ---------------------------------------------------------------------------
 * 途中下車シミュレーション
 * ------------------------------------------------------------------------- */
function detourAnalysis(d, months, fare) {
  const perTrip = (+d.fare || 0) * (d.roundtrip ? 2 : 1);
  const monthlyA = perTrip * (+d.trips || 0);            // 乗り越し精算
  const delta = +d.extendDelta || 0;                     // 定期延長の月差額
  const monthlyB = delta > 0 ? delta : null;
  const dp = DAY_PASSES[d.op];
  const monthlyC = dp && dp.price ? dp.price * (+d.trips || 0) : null;

  const opts = [
    { key: 'settle', label: '毎回そのつど乗り越し精算', monthly: monthlyA,
      detail: `片道¥${d.fare || 0} × ${d.roundtrip ? '往復' : '片道'} × 月${d.trips || 0}回` },
  ];
  if (monthlyB != null) opts.push({ key: 'extend', label: '定期を寄り駅まで延長', monthly: monthlyB,
    detail: `1ヶ月あたりの定期差額 ¥${delta.toLocaleString('ja-JP')}` });
  if (monthlyC != null) opts.push({ key: 'daypass', label: `寄る日は${dp.name}`, monthly: monthlyC,
    detail: `¥${dp.price} × 月${d.trips || 0}回（${dp.note}）` });
  opts.sort((a, b) => a.monthly - b.monthly);

  let threshold = null;
  if (delta > 0 && perTrip > 0) threshold = Math.ceil(delta / perTrip);

  return { opts, best: opts[0], perTrip, threshold, annual: opts[0].monthly * months };
}

/* ---------------------------------------------------------------------------
 * 払戻し概算
 * ------------------------------------------------------------------------- */
function refundEstimate(r, fare) {
  const passMonths = { m1: 1, m3: 3, m6: 6 }[r.passType];
  const paid = { m1: fare.m1, m3: fare.m3, m6: fare.m6 }[r.passType];
  if (!paid) return { error: 'この構成の定期額が未確定です。' };
  if (!r.buyDate || !r.refundDate) return { error: '購入日と払戻日を入力してください。' };
  const b = new Date(r.buyDate + 'T00:00'), f = new Date(r.refundDate + 'T00:00');
  const days = Math.floor((f - b) / 86400000);
  if (days < 0) return { error: '払戻日が購入日より前です。' };

  if (days === 0) return { paid, refund: paid - REFUND_RULE.fee, monthsUsed: 0,
    note: '使用開始前あつかい：全額 − 手数料220円（発売当日など）。' };

  if (r.passType === 'm1')
    return { paid, refund: 0, monthsUsed: 1,
      note: '1ヶ月定期は使用開始後の払戻し不可（区間変更等を除く）。' };

  const monthsUsed = Math.ceil(days / 30);
  if (monthsUsed >= passMonths)
    return { paid, refund: 0, monthsUsed, note: '経過が定期期間以上のため払戻しなし。' };
  const used = fare.m1 * monthsUsed;
  const refund = Math.max(0, paid - used - REFUND_RULE.fee);
  return { paid, refund, monthsUsed,
    note: `払戻額 ＝ ${YEN(paid)} −（1ヶ月定期 ${YEN(fare.m1)} × ${monthsUsed}ヶ月）− 手数料¥220。概算です。` };
}

/* ===========================================================================
 * UI
 * ========================================================================= */
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

/* ---- 色ユーティリティ ---- */
function hexRgb(h) { h = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16)); }
function tint(hex, amt) { const [r, g, b] = hexRgb(hex); const m = v => Math.round(v + (255 - v) * amt); return `rgb(${m(r)},${m(g)},${m(b)})`; }
function shade(hex, amt) { const [r, g, b] = hexRgb(hex); const f = 1 + amt; const m = v => Math.max(0, Math.min(255, Math.round(v * f))); return `rgb(${m(r)},${m(g)},${m(b)})`; }

/* ---- 駅ドロップダウン（路線別に色分け・検索可・スマホはボトムシート）---- */
let stnPop = null, stnTarget = null;

function buildStnPop() {
  stnPop = el('div', 'stnpop'); stnPop.hidden = true;
  const bar = el('div', 'stnpop-search');
  const inp = el('input', 'stnpop-input'); inp.type = 'text'; inp.placeholder = '駅名・路線で絞り込み';
  bar.appendChild(inp);
  const list = el('div', 'stnpop-list');
  const backdrop = el('div', 'stnpop-backdrop'); backdrop.hidden = true;

  const clear = el('div', 'stnpop-opt stnpop-clear', '＊ 選択をはずす（指定なし）');
  clear.dataset.v = ''; clear.dataset.search = ''; clear.onclick = () => chooseStn('');
  list.appendChild(clear);

  for (const [lid, L] of Object.entries(LINES)) {
    const head = el('div', 'stnpop-line', L.name);
    head.style.background = tint(L.color, 0.85);
    head.style.color = shade(L.color, -0.4);
    head.style.borderLeftColor = L.color;
    list.appendChild(head);
    for (const s of L.st) {
      const row = el('div', 'stnpop-opt', s);
      row.dataset.v = s; row.dataset.search = s.toLowerCase(); row.dataset.line = L.name.toLowerCase();
      row.style.borderLeftColor = L.color;
      row.onmouseenter = () => { row.style.background = tint(L.color, 0.9); };
      row.onmouseleave = () => { row.style.background = ''; };
      row.onclick = () => chooseStn(s);
      list.appendChild(row);
    }
  }
  stnPop.append(bar, list);
  document.body.append(backdrop, stnPop);
  inp.oninput = () => filterStnPop(inp.value);
  backdrop.onclick = closeStnPop;
  document.addEventListener('click', e => {
    if (!stnPop || stnPop.hidden) return;
    if (stnPop.contains(e.target)) return;
    if (e.target.classList && e.target.classList.contains('stnsel-btn')) return;
    closeStnPop();
  });
  window.addEventListener('resize', closeStnPop);
  stnPop._input = inp; stnPop._list = list; stnPop._backdrop = backdrop;
}

function openStnPop(target, btn) {
  if (!stnPop) buildStnPop();
  stnTarget = target;
  stnPop._input.value = '';
  filterStnPop('');
  const cur = state[target] || '';
  stnPop._list.querySelectorAll('.stnpop-opt').forEach(o => o.classList.toggle('cur', o.dataset.v === cur && cur !== ''));
  stnPop._list.querySelector('.stnpop-clear').hidden = !cur;
  stnPop.hidden = false;
  const mobile = matchMedia('(max-width:560px)').matches;
  stnPop.classList.toggle('sheet', mobile);
  stnPop._backdrop.hidden = !mobile;
  if (!mobile) {
    const r = btn.getBoundingClientRect();
    stnPop.style.left = (window.scrollX + r.left) + 'px';
    stnPop.style.top = (window.scrollY + r.bottom + 5) + 'px';
    stnPop.style.width = Math.max(r.width, 240) + 'px';
  } else {
    stnPop.style.left = stnPop.style.top = stnPop.style.width = '';
  }
  stnPop._input.focus();
}

function closeStnPop() {
  if (stnPop) { stnPop.hidden = true; stnPop._backdrop.hidden = true; }
  stnTarget = null;
}

function filterStnPop(q) {
  q = (q || '').trim().toLowerCase();
  // 「◯◯線」と入力したときだけ路線名検索（その路線を丸ごと表示）。それ以外は駅名検索。
  const lineHit = /線$/.test(q);
  let head = null, headMatch = false, headHasVisible = false;
  for (const node of Array.from(stnPop._list.children)) {
    if (node.classList.contains('stnpop-line')) {
      if (head) head.hidden = !headHasVisible;
      head = node; headHasVisible = false;
      headMatch = lineHit && node.textContent.toLowerCase().includes(q);
    } else if (node.classList.contains('stnpop-clear')) {
      // クリア行は選択がある時のみ表示（openStnPop 側で制御）
    } else {
      const match = !q || headMatch || node.dataset.search.includes(q);
      node.hidden = !match;
      if (match) headHasVisible = true;
    }
  }
  if (head) head.hidden = !headHasVisible;
}

function chooseStn(v) {
  const t = stnTarget;
  closeStnPop();
  if (!t) return;
  state[t] = v;
  state.structIdx = 0;
  $('#' + t + 'Sel').value = v;
  updateStnBtn(t);
  save();
  renderRouteTab();
  if ($('#panel-fare').classList.contains('active')) renderFareTab();
  if ($('#panel-result').classList.contains('active')) recompute();
}

function updateStnBtn(target) {
  const btn = $('#' + target + 'Btn');
  const v = state[target];
  if (!v) {
    btn.textContent = target === 'via' ? '（指定なし）' : '駅を選択';
    btn.classList.remove('has');
    return;
  }
  btn.classList.add('has');
  const lids = stationLines[v] || [];
  btn.innerHTML = '';
  lids.slice(0, 3).forEach(lid => {
    const d = el('span', 'stndot'); d.style.background = LINES[lid].color; btn.appendChild(d);
  });
  btn.appendChild(document.createTextNode(v));
}

function setTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
  if (name === 'result') recompute();
  if (name === 'fare') renderFareTab();
}

/* ---- 経路タブ ---- */
function renderRouteTab() {
  const box = $('#routeResult');
  box.innerHTML = '';
  if (!state.from || !state.to) { box.appendChild(el('p', 'muted', '出発駅と到着駅を選んでください。')); return; }
  if (state.from === state.to) { box.appendChild(el('p', 'muted', '出発駅と到着駅が同じです。')); return; }
  const route = currentRoute();
  if (!route) { box.appendChild(el('p', 'warn', '経路が見つかりませんでした（対応駅は主要駅のみ）。運賃タブで手入力もできます。')); return; }
  if (state.via && route.via)
    box.appendChild(el('p', 'muted small', `経由指定：${state.via}（乗換駅を固定して計算中）`));
  else if (state.via && !route.via)
    box.appendChild(el('p', 'warn', `経由駅「${state.via}」を通る経路が見つからず、通常の最短経路で計算しています。`));

  // 経路の可視化
  const rl = el('div', 'routeline');
  route.segs.forEach((s, i) => {
    const L = LINES[s.line];
    const chip = el('div', 'segchip');
    chip.style.setProperty('--c', L.color);
    chip.innerHTML = `<b>${L.name}</b><span>${s.from} → ${s.to}（${s.stops}駅）</span>`;
    rl.appendChild(chip);
    if (route.xfers[i]) {
      const x = route.xfers[i];
      const kindTxt = { through: '直通', walk: '徒歩のりかえ', transfer: 'のりかえ' }[x.kind] || 'のりかえ';
      rl.appendChild(el('div', 'xfer', `▽ ${x.at}${x.at !== x.to ? '〜' + x.to : ''}：${kindTxt}${x.note ? '（' + x.note + '）' : ''}`));
    }
  });
  box.appendChild(rl);

  // 定期券の構成候補
  const structs = passStructures(route).map(resolveStructure);
  state._structs = structs; state._route = route;
  if (state.structIdx >= structs.length) state.structIdx = 0;

  const h = el('h3', null, '定期券の買い方 候補'); box.appendChild(h);
  structs.forEach((st, i) => {
    const card = el('label', 'structcard' + (i === state.structIdx ? ' sel' : ''));
    const radio = el('input'); radio.type = 'radio'; radio.name = 'struct'; radio.checked = i === state.structIdx;
    radio.onchange = () => { state.structIdx = i; save(); renderRouteTab(); };
    card.appendChild(radio);
    const body = el('div', 'sc-body');
    body.appendChild(el('div', 'sc-title', st.label));
    st.legs.forEach((lg, j) => {
      const lf = st.legFares[j];
      const line = el('div', 'sc-leg');
      const opName = lg.op === 'renraku'
        ? `連絡定期（${lg.ab.map(o => OPERATORS[o].name).join('＋')}）` : OPERATORS[lg.op].name;
      line.innerHTML = `<span class="op op-${lg.op}">${opName}</span> ${lg.from} → ${lg.to}　` +
        (lf.needInput ? '<b class="warn">運賃タブで入力</b>'
          : `${YEN(lf.m1)}/月${lf.estimated ? ' <span class="est">推定</span>' : ''}`);
      body.appendChild(line);
    });
    if (st.note) body.appendChild(el('div', 'sc-note', st.note));
    if (st.complete) {
      const tot = el('div', 'sc-total');
      tot.innerHTML = `合計 <b>${YEN(st.m1)}</b>/月　${st.m3 ? '3ヶ月 ' + YEN(st.m3) + '　' : ''}${st.m6 ? '6ヶ月 ' + YEN(st.m6) : ''}`;
      body.appendChild(tot);
    }
    card.appendChild(body);
    box.appendChild(card);
  });

  const tip = el('p', 'muted small',
    '※ 連絡定期が「あり」でも、3社（西鉄〜地下鉄〜JR/貝塚線）通しの連絡定期は発売されません。分割定期になります。');
  box.appendChild(tip);
}

/* ---- 運賃タブ ---- */
function renderFareTab() {
  const box = $('#fareForm'); box.innerHTML = '';
  const route = currentRoute();
  if (!route) { box.appendChild(el('p', 'muted', '先に「経路」タブで出発駅・到着駅を選んでください。')); return; }
  const structs = passStructures(route);

  // 必要な区間（重複除去）
  const legs = {};
  structs.forEach(st => st.legs.forEach(lg => { legs[legKey(lg)] = lg; }));

  box.appendChild(el('p', 'muted small',
    '定期額が分かる区間は自動で入っています（初期めやす）。実額は各社の運賃検索で確認し、違えば上書きしてください。1ヶ月だけ入れれば3/6ヶ月は概算します。'));

  for (const [k, lg] of Object.entries(legs)) {
    const t = tableLookup(lg.from, lg.to);
    const u = state.fares[k] || {};
    const card = el('div', 'farecard');
    const opName = lg.op === 'renraku' ? '連絡定期' : OPERATORS[lg.op].name;
    card.appendChild(el('div', 'fc-head', `${opName}　${lg.from} → ${lg.to}`));
    if (t) card.appendChild(el('div', 'fc-src', `初期値: ${t.src}`));

    const grid = el('div', 'fc-grid');
    const mk = (label, field, ph) => {
      const wrap = el('label', 'fc-field');
      wrap.appendChild(el('span', null, label));
      const inp = el('input'); inp.type = 'number'; inp.min = '0'; inp.inputMode = 'numeric';
      inp.placeholder = ph != null ? ph : '';
      inp.value = u[field] != null ? u[field] : '';
      inp.oninput = () => {
        state.fares[k] = state.fares[k] || {};
        state.fares[k][field] = inp.value === '' ? undefined : +inp.value;
        save();
      };
      wrap.appendChild(inp);
      return wrap;
    };
    grid.appendChild(mk('片道IC(円)', 'ic', t ? t.ic : ''));
    grid.appendChild(mk('1ヶ月(円)', 'm1', t ? t.m1 : ''));
    grid.appendChild(mk('3ヶ月(円)', 'm3', t ? t.m3 : ''));
    grid.appendChild(mk('6ヶ月(円)', 'm6', t ? t.m6 : ''));
    card.appendChild(grid);

    const links = el('div', 'fc-links');
    const o = OFFICIAL[lg.op === 'renraku' ? 'subway' : lg.op];
    if (o) { const a = el('a', null, `▶ ${o.name}の運賃`); a.href = o.fare || o.rule; a.target = '_blank'; a.rel = 'noopener'; links.appendChild(a); }
    const ke = el('a', null, '▶ 駅探で定期代'); ke.href = OFFICIAL.ekitan.url; ke.target = '_blank'; ke.rel = 'noopener'; links.appendChild(ke);
    card.appendChild(links);

    const clr = el('button', 'linkbtn', '入力をクリア');
    clr.onclick = () => { delete state.fares[k]; save(); renderFareTab(); };
    card.appendChild(clr);
    box.appendChild(card);
  }
}

/* ---- 休日タブ ---- */
function renderHolidayTab() {
  const box = $('#holidayForm'); box.innerHTML = '';
  const h = state.holiday;

  // プリセット
  const psWrap = el('div', 'field');
  psWrap.appendChild(el('label', 'flabel', '休日パターン'));
  const ps = el('select');
  for (const [k, v] of Object.entries(HOLIDAY_PRESETS)) {
    const o = el('option', null, v.label); o.value = k; ps.appendChild(o);
  }
  ps.value = h.preset;
  ps.onchange = () => {
    h.preset = ps.value;
    const p = HOLIDAY_PRESETS[ps.value];
    if (!p.custom && !p.shift) {
      h.restDows = p.restDows.slice(); h.useHolidays = !!p.useHolidays;
      h.useYearEnd = !!p.useYearEnd; h.altSat = p.altSat || 0;
    }
    if (p.custom) {
      h.restDows = p.restDows.slice(); h.useHolidays = !!p.useHolidays;
      h.useYearEnd = !!p.useYearEnd; h.altSat = 0;
    }
    save(); renderHolidayTab();
  };
  psWrap.appendChild(ps);
  box.appendChild(psWrap);

  const preset = HOLIDAY_PRESETS[h.preset];

  if (preset.shift) {
    box.appendChild(el('p', 'muted small', '各月の想定出勤日数を入力してください（未入力の月は計算から除外）。'));
    const grid = el('div', 'shiftgrid');
    periodMonths().forEach(({ y, m }) => {
      const w = el('label', 'sg-cell');
      w.appendChild(el('span', null, `${y}/${m}`));
      const inp = el('input'); inp.type = 'number'; inp.min = '0'; inp.max = '31';
      inp.value = h.shiftDays[`${y}-${m}`] ?? '';
      inp.oninput = () => { h.shiftDays[`${y}-${m}`] = inp.value; save(); };
      w.appendChild(inp); grid.appendChild(w);
    });
    box.appendChild(grid);
  } else {
    // 休む曜日
    const dowWrap = el('div', 'field');
    dowWrap.appendChild(el('label', 'flabel', '休む曜日'));
    const drow = el('div', 'dowrow');
    ['日', '月', '火', '水', '木', '金', '土'].forEach((d, i) => {
      const b = el('button', 'dowbtn' + (h.restDows.includes(i) ? ' on' : ''), d);
      b.disabled = !preset.custom && h.preset !== 'sun_only' && h.preset !== 'weekend_only';
      b.onclick = () => {
        const idx = h.restDows.indexOf(i);
        if (idx >= 0) h.restDows.splice(idx, 1); else h.restDows.push(i);
        save(); renderHolidayTab();
      };
      drow.appendChild(b);
    });
    dowWrap.appendChild(drow);
    box.appendChild(dowWrap);

    const chk = (label, field, hint) => {
      const w = el('label', 'checkrow');
      const c = el('input'); c.type = 'checkbox'; c.checked = !!h[field];
      c.disabled = !preset.custom;
      c.onchange = () => { h[field] = c.checked; save(); recomputeIfResult(); };
      w.appendChild(c); w.appendChild(el('span', null, label));
      if (hint) w.appendChild(el('span', 'hint', hint));
      return w;
    };
    box.appendChild(chk('祝日は休み', 'useHolidays'));
    box.appendChild(chk('年末年始（12/29〜1/3）は休み', 'useYearEnd'));

    const altW = el('div', 'field');
    altW.appendChild(el('label', 'flabel', '土曜出勤'));
    const as = el('select');
    [[0, 'なし（土曜は休み）'], [1, '第2・4週の土曜は出勤'], [2, '第1・3・5週の土曜は出勤'], [3, '毎週土曜出勤']]
      .forEach(([v, l]) => { const o = el('option', null, l); o.value = v; as.appendChild(o); });
    as.value = h.altSat || 0;
    as.disabled = !preset.custom && h.preset !== 'sat_alt';
    as.onchange = () => { h.altSat = +as.value; save(); recomputeIfResult(); };
    altW.appendChild(as);
    box.appendChild(altW);

    if (preset.custom) {
      const co = el('div', 'field');
      co.appendChild(el('label', 'flabel', '会社の休業日（年間カレンダー・1行1日 YYYY-MM-DD）'));
      const ta = el('textarea'); ta.rows = 4; ta.value = (h.customOff || []).join('\n');
      ta.placeholder = '2026-08-13\n2026-08-14\n2026-12-30';
      ta.oninput = () => {
        h.customOff = ta.value.split(/\s+/).map(s => s.trim()).filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s));
        save();
      };
      co.appendChild(ta); box.appendChild(co);
    }
  }

  // 有給・在宅・長期休暇
  box.appendChild(el('h3', null, '通勤しない日（有給・在宅・出張・長期休暇）'));
  box.appendChild(el('p', 'muted small', '期間を足すと、その分だけ各月の出勤日数から差し引きます。'));
  const exBox = el('div', 'exlist');
  (state.extras || []).forEach((ex, i) => {
    const row = el('div', 'exrow');
    const ty = el('select');
    ['有給', '在宅勤務', '出張(通勤なし)', '夏季休暇', 'GW', '年末年始', 'その他'].forEach(t => {
      const o = el('option', null, t); o.value = t; ty.appendChild(o);
    });
    ty.value = ex.type || '有給';
    ty.onchange = () => { ex.type = ty.value; save(); };
    const f = el('input'); f.type = 'date'; f.value = ex.from || '';
    f.onchange = () => { ex.from = f.value; save(); recomputeIfResult(); };
    const t = el('input'); t.type = 'date'; t.value = ex.to || '';
    t.onchange = () => { ex.to = t.value; save(); recomputeIfResult(); };
    const del = el('button', 'linkbtn', '削除');
    del.onclick = () => { state.extras.splice(i, 1); save(); renderHolidayTab(); };
    row.append(ty, f, el('span', null, '〜'), t, del);
    exBox.appendChild(row);
  });
  box.appendChild(exBox);
  const add = el('button', 'addbtn', '＋ 期間を追加');
  add.onclick = () => { state.extras.push({ type: '有給', from: '', to: '' }); save(); renderHolidayTab(); };
  box.appendChild(add);

  // 対象期間
  box.appendChild(el('h3', null, '判定の対象期間'));
  const pr = el('div', 'periodrow');
  const sy = el('input'); sy.type = 'number'; sy.value = state.period.startY; sy.min = 2024; sy.max = 2028;
  sy.oninput = () => { state.period.startY = +sy.value; save(); };
  const sm = el('select'); for (let i = 1; i <= 12; i++) { const o = el('option', null, i + '月'); o.value = i; sm.appendChild(o); }
  sm.value = state.period.startM; sm.onchange = () => { state.period.startM = +sm.value; save(); };
  const len = el('select'); [6, 12, 18, 24].forEach(v => { const o = el('option', null, v + 'ヶ月'); o.value = v; len.appendChild(o); });
  len.value = state.period.months; len.onchange = () => { state.period.months = +len.value; save(); };
  pr.append(sy, el('span', null, '年'), sm, el('span', null, 'から'), len, el('span', null, '分'));
  box.appendChild(pr);
}

function recomputeIfResult() { if ($('#panel-result').classList.contains('active')) recompute(); }

/* ---- 結果タブ ---- */
function recompute() {
  const box = $('#resultBox'); box.innerHTML = '';
  if (!state.from || !state.to || state.from === state.to) {
    box.appendChild(el('p', 'muted', '「経路」タブで出発駅・到着駅を選んでください。')); return;
  }
  const route = currentRoute();
  if (!route) { box.appendChild(el('p', 'warn', '経路が見つかりません。')); return; }
  const structs = passStructures(route).map(resolveStructure);
  if (state.structIdx >= structs.length) state.structIdx = 0;

  // --- 1. 最適な構成 ---
  const usable = structs.filter(s => s.complete);
  const sec1 = section('① 定期券の買い方（総額の安い順）');
  if (!usable.length) {
    sec1.appendChild(el('p', 'warn', '運賃が未入力です。「運賃」タブで入力してください。'));
  } else {
    const ranked = usable.slice().sort((a, b) => (a.m6 || a.m1 * 6) - (b.m6 || b.m1 * 6));
    ranked.forEach((s, i) => {
      const r = el('div', 'rankrow' + (i === 0 ? ' top' : ''));
      r.innerHTML = `<div class="rk">${i + 1}</div><div class="rkbody">` +
        `<b>${s.label}</b>${s.estimated ? ' <span class="est">一部推定</span>' : ''}<br>` +
        `<span class="muted">1ヶ月 ${YEN(s.m1)}／3ヶ月 ${YEN(s.m3)}／6ヶ月 ${YEN(s.m6)}</span>` +
        (s.note ? `<br><span class="small muted">${s.note}</span>` : '') + `</div>`;
      sec1.appendChild(r);
    });
    if (ranked.length > 1)
      sec1.appendChild(el('p', 'small muted',
        `1番安い構成と2番の差は6ヶ月あたり ${YEN((ranked[1].m6 || ranked[1].m1 * 6) - (ranked[0].m6 || ranked[0].m1 * 6))}。`));
    if (structs.length > usable.length)
      sec1.appendChild(el('p', 'small muted',
        `他に ${structs.length - usable.length} 通りの構成があります（運賃が未入力）。「運賃」タブで入れると比較に加わります。`));
  }
  box.appendChild(sec1);

  const chosen = usable.length
    ? (structs[state.structIdx].complete ? structs[state.structIdx] : usable.slice().sort((a, b) => (a.m6 || a.m1 * 6) - (b.m6 || b.m1 * 6))[0])
    : null;
  if (!chosen) return;

  const fare = { m1: chosen.m1, m3: chosen.m3, m6: chosen.m6, icRound: chosen.icRound };
  box.appendChild(el('p', 'small muted', `以下は「${chosen.label}」で計算（構成は経路タブで変更可）。`));

  // 出勤日数
  const exSet = extrasSet();
  const wd = periodMonths().map(({ y, m }) => ({ y, m, days: workingDays(y, m, state.holiday, exSet) ?? 0 }));

  // --- 2. 戦略比較 ---
  const sec2 = section('② 6ヶ月／3ヶ月／1ヶ月／ハイブリッド／IC の総額比較');
  if (!fare.icRound) {
    sec2.appendChild(el('p', 'warn', '片道IC運賃が未入力のためIC比較ができません。運賃タブで入力してください。'));
  } else {
    const cmp = strategyCompare(fare, wd);
    const maxT = Math.max(...cmp.rows.map(r => r.total));
    cmp.rows.forEach(r => {
      const row = el('div', 'barrow' + (r.key === cmp.best.key ? ' best' : ''));
      row.appendChild(el('div', 'bl', r.label));
      const track = el('div', 'btrack');
      const fill = el('div', 'bfill'); fill.style.width = (r.total / maxT * 100) + '%';
      track.appendChild(fill); row.appendChild(track);
      row.appendChild(el('div', 'bv', YEN(r.total) + (r.diff ? ` (+${YEN(r.diff)})` : ' ◎')));
      sec2.appendChild(row);
    });
    sec2.appendChild(el('p', 'small muted',
      `対象 ${cmp.months}ヶ月。最安は「${cmp.best.label}」＝ ${YEN(cmp.best.total)}（月あたり ${YEN(cmp.best.perMonth)}）。`));
    const hyb = cmp.rows.find(r => r.key === 'hybrid');
    if (hyb && hyb.pick) {
      const picks = wd.map((x, i) => `${x.m}月:${hyb.pick[i]}`).join(' / ');
      sec2.appendChild(el('p', 'small muted', 'ハイブリッドの内訳 → ' + picks));
    }
  }
  box.appendChild(sec2);

  // --- 3. 月別 損益分岐 ---
  const sec3 = section('③ 月ごとに「1ヶ月定期」は得か損か');
  if (fare.icRound) {
    const mb = monthlyBreakeven(fare, wd);
    sec3.appendChild(el('p', 'small muted',
      `1ヶ月定期 ${YEN(fare.m1)} ÷ 往復IC ${YEN(fare.icRound)} → 損益分岐は月 ${mb.breakevenDays} 日出勤。これ以上なら定期が得。`));
    const tbl = el('table', 'mtable');
    tbl.innerHTML = '<thead><tr><th>月</th><th>出勤</th><th>IC総額</th><th>1ヶ月定期</th><th>差額</th><th>おすすめ</th></tr></thead>';
    const tb = el('tbody');
    mb.rows.forEach(r => {
      const tr = el('tr', r.verdict === 'IC' ? 'lose' : '');
      tr.innerHTML = `<td>${r.y}/${r.m}</td><td>${r.days}日</td><td>${YEN(r.icCost)}</td><td>${YEN(r.m1)}</td>` +
        `<td class="${r.diff < 0 ? 'neg' : 'pos'}">${r.diff >= 0 ? '+' : ''}${YEN(r.diff)}</td>` +
        `<td><b>${r.verdict}</b></td>`;
      tb.appendChild(tr);
    });
    tbl.appendChild(tb); sec3.appendChild(tbl);
    const loseMonths = mb.rows.filter(r => r.verdict === 'IC').map(r => r.m + '月');
    sec3.appendChild(el('p', 'small muted', loseMonths.length
      ? `${loseMonths.join('・')} は出勤が少なく、1ヶ月定期だと割高。ただし6ヶ月定期を通しで使う方が安いこともあるので②と併せて判断を。`
      : 'すべての月で1ヶ月定期が得。長期休暇や大型連休を「休日」タブに入れると精度が上がります。'));
  }
  box.appendChild(sec3);

  // --- 4. 途中下車 ---
  const sec4 = section('④ 定期区間外の駅にたまに寄る場合');
  const d = state.detour;
  const drow = el('div', 'inlineform');
  const mkI = (label, key, type, opts) => {
    const w = el('label', 'if-field'); w.appendChild(el('span', null, label));
    let inp;
    if (type === 'select') {
      inp = el('select'); opts.forEach(o => { const op = el('option', null, o.l); op.value = o.v; inp.appendChild(op); });
    } else { inp = el('input'); inp.type = type; }
    inp.value = d[key] != null ? d[key] : '';
    inp.oninput = inp.onchange = () => {
      d[key] = (type === 'number') ? (inp.value === '' ? 0 : +inp.value) : inp.value;
      save(); recompute();
    };
    w.appendChild(inp); return w;
  };
  drow.appendChild(mkI('寄り駅までの片道追加運賃(円)', 'fare', 'number'));
  drow.appendChild(mkI('月の回数', 'trips', 'number'));
  drow.appendChild(mkI('延長した場合の月差額(円)', 'extendDelta', 'number'));
  const opSel = el('label', 'if-field'); opSel.appendChild(el('span', null, '事業者'));
  const os = el('select'); [['subway', '地下鉄'], ['jr', 'JR'], ['nishitetsu', '西鉄']].forEach(([v, l]) => { const o = el('option', null, l); o.value = v; os.appendChild(o); });
  os.value = d.op; os.onchange = () => { d.op = os.value; save(); recompute(); };
  opSel.appendChild(os); drow.appendChild(opSel);
  const rt = el('label', 'checkrow');
  const rtc = el('input'); rtc.type = 'checkbox'; rtc.checked = d.roundtrip !== false;
  rtc.onchange = () => { d.roundtrip = rtc.checked; save(); recompute(); };
  rt.append(rtc, el('span', null, '寄り駅まで往復する'));
  drow.appendChild(rt);
  sec4.appendChild(drow);

  if (d.fare > 0 && d.trips > 0) {
    const da = detourAnalysis(d, wd.length, fare);
    da.opts.forEach((o, i) => {
      const r = el('div', 'rankrow' + (i === 0 ? ' top' : ''));
      r.innerHTML = `<div class="rk">${i + 1}</div><div class="rkbody"><b>${o.label}</b> … ${YEN(o.monthly)}/月<br>` +
        `<span class="small muted">${o.detail}</span></div>`;
      sec4.appendChild(r);
    });
    if (da.threshold != null)
      sec4.appendChild(el('p', 'small muted',
        `目安：月 ${da.threshold} 回以上 寄るなら「定期を延長」が得。それ未満はそのつど精算が有利。`));
    else
      sec4.appendChild(el('p', 'small muted', '「延長した場合の月差額」を入れると、延長 vs 精算の分岐回数も出します。'));
  } else {
    sec4.appendChild(el('p', 'small muted', '寄り駅までの追加運賃と月の回数を入れると3案を比較します。IC定期なら乗り越し分は自動精算されます。'));
  }
  box.appendChild(sec4);

  // --- 5. 払戻し ---
  const sec5 = section('⑤ 転勤・退職したときの払戻し概算');
  const r = state.refund;
  const rf = el('div', 'inlineform');
  const pt = el('label', 'if-field'); pt.appendChild(el('span', null, '定期の種類'));
  const pts = el('select'); [['m1', '1ヶ月'], ['m3', '3ヶ月'], ['m6', '6ヶ月']].forEach(([v, l]) => { const o = el('option', null, l); o.value = v; pts.appendChild(o); });
  pts.value = r.passType; pts.onchange = () => { r.passType = pts.value; save(); recompute(); };
  pt.appendChild(pts); rf.appendChild(pt);
  const bd = el('label', 'if-field'); bd.appendChild(el('span', null, '購入日（使用開始日）'));
  const bdi = el('input'); bdi.type = 'date'; bdi.value = r.buyDate || '';
  bdi.onchange = () => { r.buyDate = bdi.value; save(); recompute(); };
  bd.appendChild(bdi); rf.appendChild(bd);
  const fd = el('label', 'if-field'); fd.appendChild(el('span', null, '払戻日'));
  const fdi = el('input'); fdi.type = 'date'; fdi.value = r.refundDate || '';
  fdi.onchange = () => { r.refundDate = fdi.value; save(); recompute(); };
  fd.appendChild(fdi); rf.appendChild(fd);
  sec5.appendChild(rf);
  const re = refundEstimate(r, fare);
  if (re.error) sec5.appendChild(el('p', 'small muted', re.error));
  else {
    sec5.appendChild(el('p', null, `払戻の目安：<b>${YEN(re.refund)}</b>（支払 ${YEN(re.paid)}／経過 ${re.monthsUsed}ヶ月あつかい）`));
    sec5.appendChild(el('p', 'small muted', re.note));
  }
  box.appendChild(sec5);

  box.appendChild(el('p', 'disclaimer',
    '※ 運賃改定・企業提携定期・特殊な連絡運輸条件などにより実額と差が出ることがあります。' +
    '最終確認は各社の公式運賃検索・窓口で行ってください。'));
}

function section(title) {
  const s = el('section', 'rsec');
  s.appendChild(el('h3', null, title));
  return s;
}

/* ---- PDF ---- */
function exportPDF() {
  const node = $('#resultBox');
  if (!node || !node.children.length) { alert('先に結果を表示してください。'); return; }
  const btn = $('#pdfBtn'); btn.disabled = true; btn.textContent = '作成中…';
  html2canvas(node, { scale: 2, backgroundColor: '#ffffff' }).then(canvas => {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const pw = 210, ph = 297, margin = 8;
    const iw = pw - margin * 2;
    const ih = canvas.height * iw / canvas.width;
    let pos = 0;
    const img = canvas.toDataURL('image/png');
    if (ih <= ph - margin * 2) {
      pdf.addImage(img, 'PNG', margin, margin, iw, ih);
    } else {
      let remain = ih;
      while (remain > 0) {
        pdf.addImage(img, 'PNG', margin, margin - pos, iw, ih);
        remain -= (ph - margin * 2);
        if (remain > 0) { pdf.addPage(); pos += (ph - margin * 2); }
      }
    }
    pdf.save(`定期券プラン_${state.from}-${state.to}.pdf`);
  }).catch(e => { alert('PDF作成に失敗しました: ' + e); })
    .finally(() => { btn.disabled = false; btn.textContent = 'PDFで保存'; });
}

/* ---- 初期化 ---- */
function init() {
  load();
  ['from', 'to', 'via'].forEach(t => {
    $('#' + t + 'Sel').value = state[t] || '';
    updateStnBtn(t);
    $('#' + t + 'Btn').onclick = ev => { ev.stopPropagation(); openStnPop(t, $('#' + t + 'Btn')); };
  });
  $('#swapBtn').onclick = () => {
    [state.from, state.to] = [state.to, state.from];
    $('#fromSel').value = state.from; $('#toSel').value = state.to;
    updateStnBtn('from'); updateStnBtn('to');
    state.structIdx = 0; save(); renderRouteTab();
  };
  $$('.tab').forEach(t => t.onclick = () => setTab(t.dataset.tab));
  $('#pdfBtn').onclick = exportPDF;
  $('#resetBtn').onclick = () => {
    if (confirm('入力内容をすべて消去します。よろしいですか？')) {
      localStorage.removeItem(LS_KEY); location.reload();
    }
  };
  renderRouteTab();
  renderHolidayTab();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
document.addEventListener('DOMContentLoaded', init);
