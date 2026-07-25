/* Deriv candlestick chart — canvas renderer + trend-line tool.
 *
 * Everything the user sees on the plot is drawn here; Tailwind styles the
 * chrome around it.  Drawings are stored in *data* coordinates (epoch, price)
 * so they survive pan, zoom and timeframe changes, and are persisted per
 * symbol in localStorage.
 */
'use strict';

// ── workspace ───────────────────────────────────────────────────────────────
// Each desktop window passes ?ws=<id> so its drawings and settings are stored
// under their own key and never collide with another window's.  A plain browser
// tab (no id) falls back to "main".
const _params = new URLSearchParams(location.search);
const WS = _params.get('ws') || 'main';
const WS_NAME = _params.get('name') || '';

// ── palette ───────────────────────────────────────────────────────────────
// DropletFX brand red #F50512 (the logo badge gradient's top stop) carries the
// accent and drawings; chrome tokens came from the owner's Deriv config (scale
// text #B8B8B8, crosshair #9C9C9C, label chip #2E2E2E, ink #15212d).
// The surface is pure black and candles are green/blue by request.
//
// Up/down is a polarity (diverging) encoding: two hues, no rainbow.  The pair
// was picked with the palette validator rather than by eye — on black,
// #00e676/#2979ff separate by ΔE 37.5 (deutan) and 20.4 (tritan), where the
// obvious teal/blue choices fall to ~7 and become indistinguishable.  Light
// mode gets its own darker steps because the vivid green reads at only 1.67:1
// on white; it is a re-pick, not a flip.  The "hollow" toggle adds a shape
// encoding so direction is never carried by colour alone.
// Drawings use coral — the one hue no candle occupies.
const THEMES = {
  dark: {
    bg: '#000000', axis: '#1e1e1e',
    text: '#b8b8b8', strong: '#f2f2f2', tag: '#2e2e2e',
    up: '#00e676', down: '#2979ff', cross: '#9c9c9c',
    line: '#f50512', sel: '#ffb020',
    profit: '#00e676', loss: '#ff453a',
  },
  light: {
    bg: '#ffffff', axis: '#d6d9e0',
    text: '#6e6e6e', strong: '#15212d', tag: '#e6e9f0',
    up: '#00a854', down: '#1e63d0', cross: '#8a8a8a',
    line: '#f50512', sel: '#d98200',
    profit: '#00a854', loss: '#cf1322',
  },
};

const PAD = { top: 12, right: 64, bottom: 24, left: 0 };
const MIN_BARS = 15, MAX_BARS = 1200, DEFAULT_BARS = 120;
const FIT_ALL_BELOW = 400;  // series shorter than this open fully zoomed out
const HIT = 6;              // px tolerance for grabbing a drawing
const HANDLE = 4;           // half-size of an endpoint handle

// East Africa Time has no DST, so a fixed offset is exact — shift the epoch and
// read it back with the UTC getters.  All displayed times are Nairobi time.
const TZ = { label: 'EAT', offset: 3 * 3600 };

const TF_LABELS = {
  60: '1m', 120: '2m', 180: '3m', 300: '5m', 600: '10m', 900: '15m',
  1800: '30m', 3600: '1h', 7200: '2h', 14400: '4h', 28800: '8h', 86400: '1D',
};
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── state ─────────────────────────────────────────────────────────────────
const S = {
  candles: [], epochs: [], pip: 2,
  symbol: 'stpRNG', symbolName: 'Step Index', granularity: 60,
  viewRight: 0, bars: DEFAULT_BARS, priceZoom: 1, priceShift: 0,
  tool: 'cursor', magnet: false, hollow: false, theme: 'dark', panelHidden: false,
  drawings: [], store: null, selected: null, draft: null, drawColor: null,
  // Set while watching someone else's live session: the chart still pans,
  // zooms and shows the crosshair, but nothing may be drawn or edited. Cleared
  // when the session ends, and the drawings become the viewer's own.
  readOnly: false,
  backfilling: false, exhausted: false, positions: [], orders: [],
  avoid: null,               // screen rect that level badges must not sit under
  measure: null,             // transient ruler {a, b}; not persisted
  measureDraft: false,       // true between the two clicks of a click-click ruler
  // Optimistic level edits, so a dragged SL/TP doesn't snap back while the
  // terminal confirms.  key -> {price, until}
  optimistic: new Map(),
  pointer: null,             // {x, y} in css px, null when off-chart
  gesture: null,             // {kind, ...}
  W: 0, H: 0,
};

const $ = (id) => document.getElementById(id);
const canvas = $('chart'), ctx = canvas.getContext('2d');
let theme = THEMES[S.theme];

// ── geometry ──────────────────────────────────────────────────────────────
const plotX0 = () => PAD.left;
const plotX1 = () => S.W - PAD.right;
const plotY0 = () => PAD.top;
const plotY1 = () => S.H - PAD.bottom;
const plotW = () => plotX1() - plotX0();
const plotH = () => plotY1() - plotY0();
const barW = () => plotW() / S.bars;

const xOf = (i) => plotX1() - (S.viewRight - i) * barW() - barW() / 2;
const iOf = (x) => S.viewRight - (plotX1() - x - barW() / 2) / barW();

/** Fractional bar index for an epoch — interpolated inside the series and
 *  extrapolated by the granularity outside it, so drawings stay put across
 *  timeframe switches and market gaps. */
function indexFromEpoch(ep) {
  const e = S.epochs, g = S.granularity;
  if (!e.length) return 0;
  if (ep <= e[0]) return (ep - e[0]) / g;
  if (ep >= e[e.length - 1]) return e.length - 1 + (ep - e[e.length - 1]) / g;
  let lo = 0, hi = e.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (e[m] <= ep) lo = m; else hi = m;
  }
  const span = e[hi] - e[lo];
  return span ? lo + (ep - e[lo]) / span : lo;
}

function epochFromIndex(i) {
  const e = S.epochs, g = S.granularity;
  if (!e.length) return 0;
  if (i <= 0) return Math.round(e[0] + i * g);
  if (i >= e.length - 1) return Math.round(e[e.length - 1] + (i - (e.length - 1)) * g);
  const j = Math.floor(i);
  return Math.round(e[j] + (i - j) * (e[j + 1] - e[j]));
}

/** Visible price window, after autoscale + user zoom/shift. */
function priceRange() {
  const from = Math.max(0, Math.floor(S.viewRight - S.bars + 1));
  const to = Math.min(S.candles.length - 1, Math.ceil(S.viewRight));
  let lo = Infinity, hi = -Infinity;
  for (let i = from; i <= to; i++) {
    const c = S.candles[i];
    if (c.low < lo) lo = c.low;
    if (c.high > hi) hi = c.high;
  }
  if (!isFinite(lo) || !isFinite(hi)) return { lo: 0, hi: 1 };
  if (hi === lo) { hi += 1; lo -= 1; }
  const mid = (hi + lo) / 2;
  const half = ((hi - lo) / 2) * 1.12 / S.priceZoom;
  const shift = half * 2 * S.priceShift;
  return { lo: mid - half + shift, hi: mid + half + shift };
}

let RANGE = { lo: 0, hi: 1 };   // visible price window, refreshed each frame
let CROSS = null;               // crosshair geometry, refreshed each frame
const yOf = (p) => plotY1() - (p - RANGE.lo) / (RANGE.hi - RANGE.lo) * plotH();
const pOf = (y) => RANGE.lo + (plotY1() - y) / plotH() * (RANGE.hi - RANGE.lo);

const xFromEpoch = (ep) => xOf(indexFromEpoch(ep));

// ── formatting ────────────────────────────────────────────────────────────
const fmtPrice = (p) => p.toFixed(S.pip);

/** Nairobi-local calendar parts for an epoch. */
const zoned = (ep) => new Date((ep + TZ.offset) * 1000);

function fmtTime(ep, withDate) {
  const d = zoned(ep);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  if (S.granularity >= 86400) return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return withDate ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` : `${hh}:${mm}`;
}

const fmtClock = (ep) => {
  const d = zoned(ep);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

/** One pip is a unit of the last quoted decimal, which Deriv reports per
 *  symbol as ``pip_size``. */
const toPips = (delta) => delta * Math.pow(10, S.pip);
const fmtPips = (delta) => {
  const p = toPips(delta);
  return `${p >= 0 ? '+' : ''}${Math.abs(p) >= 100 ? p.toFixed(0) : p.toFixed(1)}`;
};

function niceStep(range, count) {
  const raw = range / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

// ── rendering ─────────────────────────────────────────────────────────────
let queued = false;
function draw() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; render(); });
}

function render() {
  theme = THEMES[S.theme];
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, S.W, S.H);
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, S.W, S.H);
  if (!S.candles.length) return;

  RANGE = priceRange();
  CROSS = crosshairGeometry();
  drawPriceAxis();
  drawTimeAxis();
  drawCandles();
  drawLastPrice();
  drawOrders();
  drawPositions();
  drawDrawings();
  drawMeasure();
  drawCrosshair();
  updateLegend();
}

/** Crosshair position and its axis labels, or null when the pointer is away.
 *  Computed before the axes so they can yield the space it occupies. */
function crosshairGeometry() {
  const p = S.pointer;
  if (!p || S.gesture?.kind === 'pan') return null;
  if (p.x > plotX1() || p.y > plotY1()) return null;
  const i = Math.round(iOf(p.x));
  const ep = epochFromIndex(i);
  const label = fmtTime(ep, true) + (S.granularity < 86400 ? ' ' + fmtClock(ep) : '');
  ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
  return { x: Math.round(xOf(i)) + 0.5, y: p.y, price: pOf(p.y), label,
           w: ctx.measureText(label).width + 12 };
}

/** Horizontal grid + right-hand price scale.  Gridline labels step aside for
 *  the crosshair and last-price tags rather than showing through them. */
function drawPriceAxis() {
  const step = niceStep(RANGE.hi - RANGE.lo, Math.max(2, Math.floor(plotH() / 52)));
  const first = Math.ceil(RANGE.lo / step) * step;

  const taken = [];
  const last = S.candles[S.candles.length - 1];
  if (last) taken.push(yOf(last.close));
  if (CROSS) taken.push(CROSS.y);

  ctx.lineWidth = 1;
  ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  for (let p = first; p <= RANGE.hi; p += step) {
    const y = Math.round(yOf(p)) + 0.5;
    if (taken.some((ty) => Math.abs(ty - y) < 10)) continue;
    ctx.fillStyle = theme.text;
    ctx.fillText(fmtPrice(p), plotX1() + 7, y);
  }
  ctx.strokeStyle = theme.axis;
  ctx.beginPath();
  ctx.moveTo(plotX1() + 0.5, plotY0()); ctx.lineTo(plotX1() + 0.5, plotY1());
  ctx.stroke();
}

/** Vertical grid + bottom time scale.  Gridlines are anchored to wall-clock
 *  time, not to bar position, so they don't crawl while panning. */
function drawTimeAxis() {
  const minGap = 74;
  const secPerPx = S.granularity / barW();
  const candidates = [60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600,
                      43200, 86400, 172800, 604800, 2592000];
  let stepSec = candidates.find((s) => s / secPerPx >= minGap)
             || Math.ceil((minGap * secPerPx) / 86400) * 86400;

  const leftIdx = S.viewRight - S.bars;
  const from = epochFromIndex(Math.max(leftIdx, -1e6));
  const to = epochFromIndex(S.viewRight);

  ctx.lineWidth = 1;
  ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  // Anchor gridlines to Nairobi wall-clock boundaries.
  let t = Math.ceil((from + TZ.offset) / stepSec) * stepSec - TZ.offset;
  let prevDay = null;
  for (; t <= to; t += stepSec) {
    const x = Math.round(xFromEpoch(t)) + 0.5;
    if (x < plotX0() || x > plotX1()) continue;
    const day = zoned(t).getUTCDate();
    const isDayBreak = prevDay !== null && day !== prevDay;
    prevDay = day;

    if (CROSS && Math.abs(CROSS.x - x) < CROSS.w / 2 + 14) continue;
    ctx.fillStyle = isDayBreak ? theme.strong : theme.text;
    ctx.fillText(fmtTime(t, isDayBreak || stepSec >= 86400), x, plotY1() + 7);
  }
  ctx.strokeStyle = theme.axis;
  ctx.beginPath();
  ctx.moveTo(plotX0(), plotY1() + 0.5); ctx.lineTo(plotX1(), plotY1() + 0.5);
  ctx.stroke();
}

function drawCandles() {
  const w = barW();
  const body = Math.max(1, Math.floor(w * 0.68));
  const half = body / 2;
  const from = Math.max(0, Math.floor(S.viewRight - S.bars));
  const to = Math.min(S.candles.length - 1, Math.ceil(S.viewRight));
  const thin = w < 3.2;

  ctx.lineWidth = 1;
  for (let i = from; i <= to; i++) {
    const c = S.candles[i];
    const up = c.close >= c.open;
    const col = up ? theme.up : theme.down;
    const x = Math.round(xOf(i)) + 0.5;
    if (x < plotX0() - w || x > plotX1() + w) continue;

    const yH = yOf(c.high), yL = yOf(c.low);
    ctx.strokeStyle = col;

    if (thin) {                                   // too dense for bodies
      ctx.beginPath(); ctx.moveTo(x, yH); ctx.lineTo(x, yL); ctx.stroke();
      continue;
    }
    ctx.beginPath(); ctx.moveTo(x, yH); ctx.lineTo(x, yL); ctx.stroke();

    const yO = yOf(c.open), yC = yOf(c.close);
    const top = Math.min(yO, yC);
    const h = Math.max(1, Math.abs(yC - yO));
    const bx = Math.round(x - half) + 0.5;
    const bw = Math.max(1, Math.round(body));
    if (up && S.hollow) {
      ctx.strokeRect(bx, Math.round(top) + 0.5, bw, Math.round(h));
    } else {
      ctx.fillStyle = col;
      ctx.fillRect(bx, Math.round(top), bw, Math.round(h));
    }
  }
}

function drawLastPrice() {
  const last = S.candles[S.candles.length - 1];
  if (!last) return;
  const y = yOf(last.close);
  if (y < plotY0() || y > plotY1()) return;
  const col = last.close >= last.open ? theme.up : theme.down;

  ctx.save();
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = col;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plotX0(), Math.round(y) + 0.5);
  ctx.lineTo(plotX1(), Math.round(y) + 0.5);
  ctx.stroke();
  ctx.restore();
  tag(plotX1() + 1, y, fmtPrice(last.close), col, '#fff');
}

/** Filled label on the price axis (crosshair + last price). */
function tag(x, y, text, bg, fg) {
  ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
  const h = 16, w = PAD.right - 2;
  ctx.fillStyle = bg;
  ctx.fillRect(x, Math.round(y - h / 2), w, h);
  ctx.fillStyle = fg;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 6, Math.round(y));
}

function drawCrosshair() {
  if (!CROSS) return;
  const y = Math.round(CROSS.y) + 0.5;

  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = theme.cross;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(plotX0(), y); ctx.lineTo(plotX1(), y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(CROSS.x, plotY0()); ctx.lineTo(CROSS.x, plotY1()); ctx.stroke();
  ctx.restore();

  tag(plotX1() + 1, CROSS.y, fmtPrice(CROSS.price), theme.tag, theme.strong);

  ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
  ctx.fillStyle = theme.tag;
  ctx.fillRect(CROSS.x - CROSS.w / 2, plotY1() + 1, CROSS.w, PAD.bottom - 2);
  ctx.fillStyle = theme.strong;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(CROSS.label, CROSS.x, plotY1() + PAD.bottom / 2 + 1);
}

// ── positions & pending orders ────────────────────────────────────────────
const levelKey = (entity, ticket, kind) => `${entity}:${ticket}:${kind}`;

/** Apply any in-flight optimistic edit for a level. */
function levelPrice(entity, ticket, kind, actual) {
  const o = S.optimistic.get(levelKey(entity, ticket, kind));
  if (!o) return actual;
  if (Date.now() > o.until) {
    S.optimistic.delete(levelKey(entity, ticket, kind));
    return actual;
  }
  return o.price;
}

/** Every horizontal level the cursor can grab and drag. */
function levelHandles() {
  const out = [];
  const add = (entity, ref, kind, price, label, color) => {
    if (!price) return;
    out.push({ entity, ticket: ref.ticket, ref, kind, label, color,
               price: levelPrice(entity, ref.ticket, kind, price) });
  };
  for (const p of S.positions) {
    add('position', p, 'sl', p.sl, 'SL', theme.loss);
    add('position', p, 'tp', p.tp, 'TP', theme.profit);
  }
  for (const o of S.orders) {
    add('order', o, 'price', o.price_open, o.kind.toUpperCase() + ' ' + o.volume, theme.sel);
    add('order', o, 'sl', o.sl, 'SL', theme.loss);
    add('order', o, 'tp', o.tp, 'TP', theme.profit);
  }
  return out;
}

/** Refresh the price window without waiting for a paint.  Hit-testing must not
 *  depend on render() having run — requestAnimationFrame is throttled in a
 *  background tab, which would otherwise leave RANGE stale and every
 *  price<->pixel conversion wrong. */
function ensureGeometry() {
  if (S.candles.length) RANGE = priceRange();
}

function levelAt(x, y) {
  if (x > plotX1() || y > plotY1()) return null;
  // Chips first — they sit on top of the entry line they belong to.
  for (const c of chipRects()) {
    if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) {
      return { entity: c.entity, ticket: c.ticket, ref: c.ref, kind: c.kind,
               color: c.color, price: c.ref.price_open, create: true };
    }
  }
  let best = null, bestD = 6;
  for (const h of levelHandles()) {
    const d = Math.abs(yOf(h.price) - y);
    if (d < bestD) { bestD = d; best = h; }
  }
  return best;
}

/** Keep SL on the losing side of entry and TP on the winning side, so a drag
 *  can't produce stops the server is guaranteed to reject. */
function clampLevel(h, price) {
  if (h.kind === 'price') return price;
  const entry = h.ref.price_open;
  const buy = h.ref.side === 'buy';
  const eps = Math.pow(10, -S.pip);
  if (h.kind === 'sl') {
    return buy ? Math.min(price, entry - eps) : Math.max(price, entry + eps);
  }
  return buy ? Math.max(price, entry + eps) : Math.min(price, entry - eps);
}

/** One horizontal level line with a left-hand badge.  Badges step around
 *  `S.avoid` (the floating P&L orb) rather than being drawn underneath it. */
function levelLine(price, color, text, dash, weight) {
  const y = Math.round(yOf(price)) + 0.5;
  if (y < plotY0() || y > plotY1()) return;

  ctx.setLineDash(dash);
  ctx.strokeStyle = color;
  ctx.lineWidth = weight;
  ctx.beginPath(); ctx.moveTo(plotX0(), y); ctx.lineTo(plotX1(), y); ctx.stroke();

  ctx.setLineDash([]);
  const w = ctx.measureText(text).width + 10;
  let bx = plotX0() + 4;
  const a = S.avoid;
  if (a && y + 8 > a.top && y - 8 < a.bottom && bx < a.right && bx + w > a.left) {
    bx = a.right + 6;
  }
  ctx.fillStyle = color;
  ctx.fillRect(bx, y - 8, w, 16);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + 5, y);
}

/** Entry / SL / TP for open positions.  The entry badge is tinted by P&L
 *  (green/red), not by side — a losing buy must read as a loss. */
function drawPositions() {
  if (!S.positions.length) return;
  ctx.save();
  ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
  for (const p of S.positions) {
    levelLine(p.price_open, p.profit >= 0 ? theme.profit : theme.loss,
              `${p.side.toUpperCase()} ${p.volume}  ${p.profit >= 0 ? '+' : ''}${p.profit}`,
              [6, 3], 1.5);
    const sl = levelPrice('position', p.ticket, 'sl', p.sl);
    const tp = levelPrice('position', p.ticket, 'tp', p.tp);
    if (sl) levelLine(sl, theme.loss, `SL ${fmtPrice(sl)}`, [2, 3], 1);
    if (tp) levelLine(tp, theme.profit, `TP ${fmtPrice(tp)}`, [2, 3], 1);

  }
  // Chips are painted from the same geometry the hit-test uses.
  ctx.font = '9px ui-monospace, Menlo, Consolas, monospace';
  for (const c of chipRects()) {
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = c.color;
    ctx.fillRect(c.x, c.y, c.w, c.h);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(c.text, c.x + 6, c.y + c.h / 2);
  }
  ctx.restore();
}

/** "+ SL" / "+ TP" grab targets for positions missing that level.
 *
 *  Pure geometry, derived on demand — never a side effect of painting, so a
 *  click is hit-tested against the same rects whether or not a frame has been
 *  drawn recently. */
function chipRects() {
  const out = [];
  if (!S.candles.length) return out;
  ctx.save();
  ctx.font = '9px ui-monospace, Menlo, Consolas, monospace';
  for (const p of S.positions) {
    const y = yOf(p.price_open);
    if (y < plotY0() || y > plotY1()) continue;
    let right = plotX1() - 8;
    const add = (text, color, kind) => {
      const w = ctx.measureText(text).width + 12;
      const x = right - w;
      out.push({ x, y: y - 7, w, h: 14, text, color, kind,
                 entity: 'position', ticket: p.ticket, ref: p });
      right = x - 4;
    };
    if (!levelPrice('position', p.ticket, 'tp', p.tp)) add('+ TP', theme.profit, 'tp');
    if (!levelPrice('position', p.ticket, 'sl', p.sl)) add('+ SL', theme.loss, 'sl');
  }
  ctx.restore();
  return out;
}

/** Pending orders: entry in amber, with their own SL/TP. */
function drawOrders() {
  if (!S.orders.length) return;
  ctx.save();
  ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
  for (const o of S.orders) {
    const price = levelPrice('order', o.ticket, 'price', o.price_open);
    levelLine(price, theme.sel, `${o.kind.toUpperCase()} ${o.volume}`, [8, 4], 1.5);
    const sl = levelPrice('order', o.ticket, 'sl', o.sl);
    const tp = levelPrice('order', o.ticket, 'tp', o.tp);
    if (sl) levelLine(sl, theme.loss, `SL ${fmtPrice(sl)}`, [2, 3], 1);
    if (tp) levelLine(tp, theme.profit, `TP ${fmtPrice(tp)}`, [2, 3], 1);
  }
  ctx.restore();
}

// ── measure tool (the ruler) ───────────────────────────────────────────────
/** TradingView-style ruler: a shaded box from A to B with pips, price move,
 *  percent and bar count.  Transient — lives in S.measure, never persisted. */
function drawMeasure() {
  const m = S.measure;
  if (!m) return;
  const ax = xFromEpoch(m.a.epoch), bx = xFromEpoch(m.b.epoch);
  const ay = yOf(m.a.price), by = yOf(m.b.price);
  const up = m.b.price >= m.a.price;
  const col = up ? theme.profit : theme.loss;

  ctx.save();
  ctx.beginPath();
  ctx.rect(plotX0(), plotY0(), plotW(), plotH());
  ctx.clip();

  // shaded body
  const x = Math.min(ax, bx), y = Math.min(ay, by);
  const w = Math.abs(bx - ax), h = Math.abs(by - ay);
  ctx.fillStyle = col + '20';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = col;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeRect(x, y, w, h);

  // centre vertical arrow from start price to end price
  ctx.beginPath();
  ctx.moveTo(bx, ay); ctx.lineTo(bx, by); ctx.stroke();
  const dir = up ? -1 : 1;                    // arrowhead points toward B
  ctx.beginPath();
  ctx.moveTo(bx - 4, by - dir * 6); ctx.lineTo(bx, by);
  ctx.lineTo(bx + 4, by - dir * 6); ctx.stroke();

  // stats pill centred on the box
  const dp = m.b.price - m.a.price;
  const pct = m.a.price ? (dp / m.a.price) * 100 : 0;
  const bars = Math.abs(Math.round(indexFromEpoch(m.b.epoch) - indexFromEpoch(m.a.epoch)));
  const l1 = `${fmtPips(dp)} pips`;   // fmtPips already carries the sign
  const l2 = `${dp >= 0 ? '+' : ''}${fmtPrice(dp)}  (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
  const l3 = `${bars} bar${bars === 1 ? '' : 's'}`;

  ctx.font = 'bold 12px ui-monospace, Menlo, Consolas, monospace';
  const pw = Math.max(ctx.measureText(l1).width, ctx.measureText(l2).width,
                      ctx.measureText(l3).width) + 20;
  const ph = 50;
  let px = (ax + bx) / 2 - pw / 2;
  let py = by + (up ? 8 : -ph - 8);           // sit past the end point
  px = Math.min(Math.max(px, plotX0() + 2), plotX1() - pw - 2);
  py = Math.min(Math.max(py, plotY0() + 2), plotY1() - ph - 2);

  ctx.fillStyle = col;
  roundRect(px, py, pw, ph, 5); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(l1, px + pw / 2, py + 13);
  ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
  ctx.fillText(l2, px + pw / 2, py + 27);
  ctx.globalAlpha = 0.85;
  ctx.fillText(l3, px + pw / 2, py + 40);
  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ── drawings ──────────────────────────────────────────────────────────────
// Every drawing is stored as two anchor points in data space (epoch, price):
//   trend  segment a→b        ray    a→b extended right
//   hline  horizontal, full width   hray   horizontal from a rightward
//   rect   zone between a and b
// One-click tools (hline/hray) place both anchors from a single point.
const TOOLS = {
  cursor: { points: 0 },
  measure: { points: 2 },   // ruler — transient, not saved
  trend: { points: 2 },
  ray: { points: 2 },
  hline: { points: 1 },
  hray: { points: 1 },
  rect: { points: 2 },
  range: { points: 2 },     // price range — vertical bracket, price/pips/%
};
const LINE_STYLES = { solid: [], dashed: [6, 4], dotted: [2, 3] };

/** Screen endpoints for a drawing, plus the drawn segment span. */
function endpoints(d) {
  const a = { x: xFromEpoch(d.a.epoch), y: yOf(d.a.price) };
  const b = { x: xFromEpoch(d.b.epoch), y: yOf(d.b.price) };
  if (d.type === 'hline') { a.x = plotX0(); b.x = plotX1(); b.y = a.y; }
  else if (d.type === 'hray') { b.x = plotX1(); b.y = a.y; }
  else if (d.type === 'ray') {
    // extend a→b to the right edge
    if (b.x !== a.x) {
      const slope = (b.y - a.y) / (b.x - a.x);
      b.y = a.y + slope * (plotX1() - a.x);
      b.x = plotX1();
    }
  }
  return { a, b };
}

function drawDrawings() {
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotX0(), plotY0(), plotW(), plotH());
  ctx.clip();

  // Price-axis tags live to the RIGHT of the plot, outside this clip, so we
  // collect them here and paint them after the clip is released below.
  const axisTags = [];
  const all = S.draft ? S.drawings.concat([S.draft]) : S.drawings;
  for (const d of all) {
    const selected = d === S.selected || d === S.draft;
    // Per-drawing colour if set, else the theme accent so old drawings repaint.
    const col = selected ? theme.sel : (d.color || theme.line);
    ctx.lineWidth = d.width || 1.6;
    ctx.lineCap = 'round';
    ctx.setLineDash(LINE_STYLES[d.style] || []);

    if (d.type === 'rect') {
      const ax = xFromEpoch(d.a.epoch), bx = xFromEpoch(d.b.epoch);
      const ay = yOf(d.a.price), by = yOf(d.b.price);
      const x = Math.min(ax, bx), y = Math.min(ay, by);
      const w = Math.abs(bx - ax), h = Math.abs(by - ay);
      ctx.fillStyle = (d.color || theme.line) + '22';   // translucent fill
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = col;
      ctx.strokeRect(x, y, w, h);
      if (selected) drawHandles([{ x: ax, y: ay }, { x: bx, y: by }]);
      ctx.setLineDash([]);
      continue;
    }

    if (d.type === 'range') {
      const ax = xFromEpoch(d.a.epoch), bx = xFromEpoch(d.b.epoch);
      const ay = yOf(d.a.price), by = yOf(d.b.price);
      const x = Math.min(ax, bx), w = Math.max(Math.abs(bx - ax), 50);
      const yTop = Math.min(ay, by), yBot = Math.max(ay, by);
      const up = d.b.price >= d.a.price;           // direction a → b
      const fill = up ? theme.up : theme.down;

      ctx.fillStyle = fill + '22';                 // translucent band
      ctx.fillRect(x, yTop, w, yBot - yTop);
      ctx.strokeStyle = selected ? theme.sel : fill;
      ctx.setLineDash(LINE_STYLES[d.style] || []);
      ctx.beginPath();                             // top & bottom edges
      ctx.moveTo(x, yTop); ctx.lineTo(x + w, yTop);
      ctx.moveTo(x, yBot); ctx.lineTo(x + w, yBot);
      ctx.stroke();
      ctx.setLineDash([]);

      const mx = x + w / 2;                         // centre vertical arrow
      ctx.beginPath(); ctx.moveTo(mx, yTop); ctx.lineTo(mx, yBot); ctx.stroke();
      const head = (yTip, dir) => {                 // dir -1 up, +1 down
        ctx.beginPath();
        ctx.moveTo(mx, yTip);
        ctx.lineTo(mx - 4, yTip + dir * 7);
        ctx.lineTo(mx + 4, yTip + dir * 7);
        ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
      };
      head(yTop, -1); head(yBot, +1);

      // stats pill in the middle
      const dp = d.b.price - d.a.price;
      const pct = d.a.price ? (dp / d.a.price) * 100 : 0;
      const l1 = `${fmtPips(dp)} pips`;
      const l2 = `${dp >= 0 ? '+' : ''}${fmtPrice(dp)}  (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
      ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
      const pw = Math.max(ctx.measureText(l1).width, ctx.measureText(l2).width) + 16;
      const ph = 34, px = mx - pw / 2, py = (yTop + yBot) / 2 - ph / 2;
      ctx.fillStyle = fill;
      roundRect(px, py, pw, ph, 5); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(l1, mx, py + 11);
      ctx.fillText(l2, mx, py + 24);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';

      // Queue top/bottom price tags for the right axis (drawn after unclip).
      axisTags.push({ y: yTop, price: up ? d.b.price : d.a.price, color: fill });
      axisTags.push({ y: yBot, price: up ? d.a.price : d.b.price, color: fill });

      if (selected) drawHandles([{ x: ax, y: ay }, { x: bx, y: by }]);
      continue;
    }

    const { a, b } = endpoints(d);
    ctx.strokeStyle = col;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.setLineDash([]);

    // Horizontal lines get a price tag on the axis, like a broker chart.
    if (d.type === 'hline' || d.type === 'hray') {
      axisTags.push({ y: a.y, price: d.a.price, color: d.color || theme.line });
    }

    if (selected) {
      const pts = (d.type === 'hline') ? [{ x: (a.x + b.x) / 2, y: a.y }]
        : (d.type === 'hray') ? [{ x: a.x, y: a.y }]
        : [a, b];
      drawHandles(pts);
    }
  }
  ctx.restore();

  // Now that the plot clip is gone, paint the price-axis tags on the right.
  ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (const t of axisTags) {
    const label = fmtPrice(t.price);
    const tw = Math.min(ctx.measureText(label).width + 8, PAD.right - 2);
    ctx.fillStyle = t.color;
    ctx.fillRect(plotX1() + 1, t.y - 8, tw, 16);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, plotX1() + 5, t.y);
  }
  ctx.textBaseline = 'alphabetic';
}

function drawHandles(pts) {
  ctx.setLineDash([]);
  ctx.fillStyle = theme.bg;
  ctx.strokeStyle = theme.sel;
  ctx.lineWidth = 1.5;
  for (const pt of pts) {
    ctx.beginPath();
    ctx.rect(pt.x - HANDLE, pt.y - HANDLE, HANDLE * 2, HANDLE * 2);
    ctx.fill(); ctx.stroke();
  }
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** What is under the cursor: an endpoint handle, a drawing body, or nothing. */
function pick(x, y) {
  for (let i = S.drawings.length - 1; i >= 0; i--) {
    const d = S.drawings[i];
    if (d.type === 'rect' || d.type === 'range') {
      const ax = xFromEpoch(d.a.epoch), bx = xFromEpoch(d.b.epoch);
      const ay = yOf(d.a.price), by = yOf(d.b.price);
      if (Math.hypot(x - ax, y - ay) <= HANDLE + 3) return { d, part: 'a' };
      if (Math.hypot(x - bx, y - by) <= HANDLE + 3) return { d, part: 'b' };
      const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx);
      const y0 = Math.min(ay, by), y1 = Math.max(ay, by);
      const nearEdge = (x >= x0 - HIT && x <= x1 + HIT &&
        (Math.abs(y - y0) <= HIT || Math.abs(y - y1) <= HIT)) ||
        (y >= y0 - HIT && y <= y1 + HIT &&
        (Math.abs(x - x0) <= HIT || Math.abs(x - x1) <= HIT));
      if (nearEdge || (x > x0 && x < x1 && y > y0 && y < y1)) return { d, part: 'body' };
      continue;
    }
    const { a, b } = endpoints(d);
    if (d.type === 'hline' || d.type === 'hray') {
      const grabX = d.type === 'hray' ? a.x : (a.x + b.x) / 2;
      if (Math.hypot(x - grabX, y - a.y) <= HANDLE + 3) return { d, part: 'a' };
      if (Math.abs(y - a.y) <= HIT && x >= a.x - HIT && x <= b.x) return { d, part: 'body' };
      continue;
    }
    if (Math.hypot(x - a.x, y - a.y) <= HANDLE + 3) return { d, part: 'a' };
    if (Math.hypot(x - b.x, y - b.y) <= HANDLE + 3) return { d, part: 'b' };
    if (distToSegment(x, y, a.x, a.y, b.x, b.y) <= HIT) return { d, part: 'body' };
  }
  return null;
}

// ── style bar (shown while a drawing is selected) ──────────────────────────
const DRAW_COLORS = ['#f50512', '#ffb020', '#00e676', '#2979ff', '#ffffff', '#9c9c9c'];

function showStyleBar() {
  const bar = $('style-bar');
  if (!bar || !S.selected) return;
  bar.classList.remove('hidden');
  bar.querySelectorAll('[data-color]').forEach((b) => {
    const on = (S.selected.color || theme.line) === b.dataset.color;
    b.style.outline = on ? '2px solid #fff' : 'none';
  });
  bar.querySelectorAll('[data-style]').forEach((b) => {
    b.classList.toggle('bg-accent', (S.selected.style || 'solid') === b.dataset.style);
    b.classList.toggle('text-white', (S.selected.style || 'solid') === b.dataset.style);
  });
}

function hideStyleBar() {
  const bar = $('style-bar');
  if (bar) bar.classList.add('hidden');
}

/** Finalise a drawing: store it, select it, drop the tool. */
function commitDrawing(d) {
  S.drawings.push(d);
  S.selected = d;
  S.draft = null;
  saveDrawings();
  setTool('cursor');
  showBubble(d);          // keep the pips/price measurement visible on it
  showStyleBar();
  draw();
}

/** Screen point -> data point, optionally snapped to the nearest OHLC level. */
function dataPoint(x, y) {
  const i = Math.round(iOf(x));
  const epoch = epochFromIndex(i);
  if (!S.magnet) return { epoch, price: pOf(y) };
  const c = S.candles[i];
  if (!c) return { epoch, price: pOf(y) };
  let best = null, bestD = 14;
  for (const p of [c.open, c.high, c.low, c.close]) {
    const d = Math.abs(yOf(p) - y);
    if (d < bestD) { bestD = d; best = p; }
  }
  return { epoch, price: best === null ? pOf(y) : best };
}

// ── saving ────────────────────────────────────────────────────────────────
const SETTINGS_KEY = `deriv-chart:settings:${WS}`;

// Settings live in the same durable, per-workspace file as the drawings.
// localStorage is kept only as an offline fallback — on its own it did not
// reliably survive a restart, which is why the timeframe used to reset.
let _settingsTimer = null;

function currentSettings() {
  return {
    symbol: S.symbol, symbolName: S.symbolName, granularity: S.granularity,
    theme: S.theme, hollow: S.hollow, magnet: S.magnet, bars: S.bars,
    panelHidden: S.panelHidden,
  };
}

function postSettings(payload) {
  try {
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: WS, settings: payload }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* offline — localStorage still has it */ }
}

function saveSettings() {
  const payload = currentSettings();
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(payload)); }
  catch { /* storage disabled */ }
  clearTimeout(_settingsTimer);
  _settingsTimer = setTimeout(() => postSettings(payload), 250);
}

function flushSettings() {
  clearTimeout(_settingsTimer);
  postSettings(currentSettings());
}
window.addEventListener('pagehide', flushSettings);
window.addEventListener('beforeunload', flushSettings);

/** Server copy first; fall back to the localStorage backup. */
async function loadSettings() {
  try {
    const r = await fetch(`/api/settings?workspace=${encodeURIComponent(WS)}`);
    if (r.ok) {
      const s = await r.json();
      if (s && Object.keys(s).length) return s;
    }
  } catch { /* fall through */ }
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); }
  catch { return {}; }
}

/** Export exactly what is on screen as a PNG. */
function saveImage() {
  const stamp = zoned(Math.floor(Date.now() / 1000))
    .toISOString().slice(0, 16).replace('T', '_').replace(':', '');
  const name = `DropletFX_${S.symbol}_${TF_LABELS[S.granularity] || S.granularity}_${stamp}EAT.png`;
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
  return name;
}

const drawingsKey = () => `deriv-chart:drawings:${WS}:${S.symbol}`;

// Drawings persist to a file on the server (survives port/cache/reinstall),
// with localStorage as an offline backup.  S.store holds every symbol's
// drawings, fetched once at boot so switching symbols is instant.
let _saveTimer = null;

function saveDrawings() {
  // localStorage backup — synchronous, so it's safe even on a hard close.
  try { localStorage.setItem(drawingsKey(), JSON.stringify(S.drawings)); }
  catch { /* storage disabled */ }
  if (S.store) S.store[S.symbol] = S.drawings;
  // Every drawing mutation lands here, which makes it the one place a live
  // host has to mirror to viewers.
  if (window.LIVE) window.LIVE.onDrawings();
  // Debounce the network write so a drag doesn't spam the server.
  clearTimeout(_saveTimer);
  const symbol = S.symbol, payload = JSON.stringify(S.drawings);
  _saveTimer = setTimeout(() => postDrawings(symbol, payload), 250);
}

function postDrawings(symbol, drawingsJson) {
  try {
    fetch('/api/drawings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: `{"workspace":${JSON.stringify(WS)},"symbol":${JSON.stringify(symbol)},"drawings":${drawingsJson}}`,
      keepalive: true,          // still sent if the page is closing
    }).catch(() => {});
  } catch { /* offline — localStorage still has it */ }
}

// Flush immediately on close, bypassing the debounce.
function flushDrawings() {
  clearTimeout(_saveTimer);
  postDrawings(S.symbol, JSON.stringify(S.drawings));
}
window.addEventListener('pagehide', flushDrawings);
window.addEventListener('beforeunload', flushDrawings);

async function fetchStore() {
  try {
    const r = await fetch(`/api/drawings?workspace=${encodeURIComponent(WS)}`);
    if (r.ok) { S.store = await r.json(); return; }
  } catch { /* fall through to localStorage */ }
  S.store = null;
}

function loadDrawings() {
  S.selected = null;
  // Prefer the server copy; fall back to the localStorage backup.
  if (S.store && Array.isArray(S.store[S.symbol])) {
    S.drawings = S.store[S.symbol];
    return;
  }
  try { S.drawings = JSON.parse(localStorage.getItem(drawingsKey()) || '[]'); }
  catch { S.drawings = []; }
}

// ── legend & bubble ───────────────────────────────────────────────────────
function updateLegend() {
  const i = S.pointer && S.pointer.x <= plotX1()
    ? Math.max(0, Math.min(S.candles.length - 1, Math.round(iOf(S.pointer.x))))
    : S.candles.length - 1;
  const c = S.candles[i];
  if (!c) return;
  const up = c.close >= c.open;
  const col = up ? THEMES[S.theme].up : THEMES[S.theme].down;
  const chg = c.close - c.open;
  const pct = c.open ? (chg / c.open) * 100 : 0;

  $('lg-title').textContent = `${S.symbolName} · ${TF_LABELS[S.granularity] || S.granularity + 's'}`;
  $('lg-ohlc').innerHTML =
    ['O', 'H', 'L', 'C'].map((k, n) =>
      `<span>${k}<span style="color:${col}"> ${fmtPrice([c.open, c.high, c.low, c.close][n])}</span></span>`
    ).join('') +
    `<span style="color:${col}">${chg >= 0 ? '+' : ''}${fmtPrice(chg)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span>` +
    `<span class="opacity-70">range ${fmtPips(c.high - c.low).replace('+', '')} pips</span>`;

  updatePipCounter(c);
}

/** Live pip distance from the crosshair to the latest close. */
function updatePipCounter(hovered) {
  const el = $('pips');
  const last = S.candles[S.candles.length - 1];
  if (!last) { el.textContent = ''; return; }
  if (!CROSS) {
    el.textContent = `${fmtPips(last.close - last.open)} pips on candle`;
    el.style.color = '';
    return;
  }
  const delta = CROSS.price - last.close;
  el.textContent = `${fmtPips(delta)} pips from last`;
  el.style.color = delta >= 0 ? THEMES[S.theme].up : THEMES[S.theme].down;
}

/** Measurement readout while drawing or dragging — always shows pips.
 *
 *  Horizontal lines measure from the last price; everything else measures the
 *  span between the two anchors (rectangle uses its own two corners). */
function showBubble(d) {
  const el = $('bubble');
  if (!d) { el.classList.add('hidden'); return; }

  let dp, bars, anchorX, anchorY;
  if (d.type === 'hline' || d.type === 'hray') {
    const last = S.candles[S.candles.length - 1];
    dp = d.a.price - (last ? last.close : d.a.price);
    bars = 0;
    anchorX = d.type === 'hray' ? xFromEpoch(d.a.epoch) : plotX1() - 120;
    anchorY = yOf(d.a.price);
  } else {
    dp = d.b.price - d.a.price;
    bars = Math.round(indexFromEpoch(d.b.epoch) - indexFromEpoch(d.a.epoch));
    anchorX = xFromEpoch(d.b.epoch);
    anchorY = yOf(d.b.price);
  }
  const pct = d.a.price ? (dp / (d.type.startsWith('h') ?
    (S.candles.at(-1)?.close || d.a.price) : d.a.price)) * 100 : 0;
  const suffix = (d.type === 'hline' || d.type === 'hray') ? ' from last'
    : (d.type === 'rect' ? ' height' : (d.type === 'range' ? ' range' : ''));

  el.innerHTML =
    `<span class="font-bold" style="color:${dp >= 0 ? theme.up : theme.down}">` +
    `${fmtPips(dp)} pips${suffix}</span>` +
    `<span class="ml-2">${dp >= 0 ? '+' : ''}${fmtPrice(dp)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span>` +
    (bars ? `<span class="ml-2 opacity-70">${Math.abs(bars)} bars</span>` : '');
  el.style.left = `${Math.min(Math.max(anchorX + 12, 4), S.W - 190)}px`;
  el.style.top = `${Math.min(Math.max(anchorY - 30, 4), S.H - 40)}px`;
  el.classList.remove('hidden');
}

// ── interaction ───────────────────────────────────────────────────────────
function localPos(ev) {
  const r = canvas.getBoundingClientRect();
  return { x: ev.clientX - r.left, y: ev.clientY - r.top };
}

canvas.addEventListener('pointerdown', (ev) => {
  const { x, y } = localPos(ev);
  ensureGeometry();
  canvas.setPointerCapture(ev.pointerId);

  if (x > plotX1()) {                       // price scale: drag to zoom it
    S.gesture = { kind: 'pscale', y0: y, zoom0: S.priceZoom };
    return;
  }
  if (y > plotY1()) {                       // time scale: drag to zoom time
    S.gesture = { kind: 'tscale', x0: x, bars0: S.bars };
    return;
  }

  // Watching a live session: panning and zooming stay, but every gesture that
  // would create, move or select a drawing is dropped here. The server refuses
  // these too — this just stops the local chart from lying about it.
  if (S.readOnly) {
    S.gesture = { kind: 'pan', x0: x, y0: y, right0: S.viewRight, shift0: S.priceShift };
    return;
  }

  // Grabbing an SL/TP (or a pending order's entry) beats every other gesture,
  // the same way MetaTrader lets you drag those levels straight on the chart.
  const level = S.tool === 'cursor' ? levelAt(x, y) : null;
  if (level) {
    S.gesture = { kind: 'level', handle: level, moved: false };
    draw();
    return;
  }

  // Ruler works either way: press-drag-release, OR click once then click again.
  if (S.tool === 'measure') {
    const p = dataPoint(x, y);
    if (S.measureDraft) {                 // second click of a click-click
      S.measure.b = p;
      S.measureDraft = false;
      setTool('cursor');
    } else {
      S.measure = { a: p, b: { ...p } };
      S.gesture = { kind: 'measure', x0: x, y0: y, moved: false };
    }
    draw();
    return;
  }
  // A plain click with the cursor clears a lingering ruler.
  if (S.tool === 'cursor' && S.measure) { S.measure = null; }

  const spec = TOOLS[S.tool];
  if (spec && spec.points) {
    const p = dataPoint(x, y);
    if (spec.points === 1) {
      // one click places the whole drawing (horizontal line / ray)
      commitDrawing({ type: S.tool, a: p, b: { ...p }, width: 1.6,
                      style: 'solid', color: S.drawColor });
      return;
    }
    if (!S.draft) {
      S.draft = { type: S.tool, a: p, b: { ...p }, width: 1.6,
                  style: 'solid', color: S.drawColor };
    } else {
      S.draft.b = dataPoint(x, y);
      commitDrawing(S.draft);
    }
    draw();
    return;
  }

  const hit = pick(x, y);
  if (hit) {
    S.selected = hit.d;
    const origin = dataPoint(x, y);
    S.gesture = hit.part === 'body'
      ? { kind: 'move', d: hit.d, from: origin,
          a0: { ...hit.d.a }, b0: { ...hit.d.b } }
      : { kind: 'handle', d: hit.d, part: hit.part };
    showBubble(hit.d);
    showStyleBar();
    draw();
    return;
  }

  S.selected = null;
  hideStyleBar();
  showBubble(null);
  S.gesture = { kind: 'pan', x0: x, y0: y, right0: S.viewRight, shift0: S.priceShift };
  draw();
});

canvas.addEventListener('pointermove', (ev) => {
  const { x, y } = localPos(ev);
  ensureGeometry();
  S.pointer = { x, y };
  const g = S.gesture;

  if (g?.kind === 'pan') {
    S.viewRight = g.right0 - (x - g.x0) / barW();
    S.priceShift = g.shift0 + (y - g.y0) / plotH();
    clampView();
  } else if (g?.kind === 'pscale') {
    S.priceZoom = Math.min(20, Math.max(0.2, g.zoom0 * Math.exp((y - g.y0) / 160)));
  } else if (g?.kind === 'tscale') {
    S.bars = Math.min(MAX_BARS, Math.max(MIN_BARS, g.bars0 * Math.exp((g.x0 - x) / 180)));
    clampView();
  } else if (g?.kind === 'measure') {
    g.moved = g.moved || Math.hypot(x - g.x0, y - g.y0) > 4;
    S.measure.b = dataPoint(x, y);
  } else if (S.tool === 'measure' && S.measureDraft) {
    // click-click mode: track the cursor live between the two clicks
    S.measure.b = dataPoint(x, y);
  } else if (g?.kind === 'level') {
    const h = g.handle;
    g.moved = true;
    h.price = clampLevel(h, magnetPrice(x, y));
    // Handles are rebuilt every frame, so the dragged value lives here.
    S.optimistic.set(levelKey(h.entity, h.ticket, h.kind),
                     { price: h.price, until: Date.now() + 8000 });
    showLevelBubble(h);
  } else if (g?.kind === 'handle') {
    g.d[g.part] = dataPoint(x, y);
    showBubble(g.d);
  } else if (g?.kind === 'move') {
    const now = dataPoint(x, y);
    const dEp = now.epoch - g.from.epoch, dPr = now.price - g.from.price;
    g.d.a = { epoch: g.a0.epoch + dEp, price: g.a0.price + dPr };
    g.d.b = { epoch: g.b0.epoch + dEp, price: g.b0.price + dPr };
    showBubble(g.d);
  } else if (S.draft) {
    S.draft.b = dataPoint(x, y);
    showBubble(S.draft);
  } else {
    const drawing = S.tool !== 'cursor';
    const onLevel = !drawing ? levelAt(x, y) : null;
    const over = (!drawing && x <= plotX1() && y <= plotY1()) ? pick(x, y) : null;
    canvas.style.cursor = onLevel ? 'ns-resize'
      : over ? (over.part === 'body' ? 'move' : 'grab')
      : drawing ? 'crosshair'
      : x > plotX1() ? 'ns-resize' : y > plotY1() ? 'ew-resize' : 'default';
  }
  draw();
});

/** Price under the cursor, snapped to a nearby OHLC level when magnet is on. */
function magnetPrice(x, y) {
  return S.magnet ? dataPoint(x, y).price : pOf(y);
}

/** Live readout while dragging a level: new price and distance from entry. */
function showLevelBubble(h) {
  const el = $('bubble');
  const entry = h.entity === 'position' ? h.ref.price_open : h.ref.price_open;
  const delta = h.price - entry;
  el.innerHTML =
    `<span class="font-bold" style="color:${h.color}">${h.kind.toUpperCase()} ${fmtPrice(h.price)}</span>` +
    `<span class="ml-2 opacity-70">${fmtPips(delta)} pips from entry</span>`;
  el.style.left = `${Math.min(plotX1() - 190, plotX0() + 12)}px`;
  el.style.top = `${Math.min(Math.max(yOf(h.price) - 34, 4), S.H - 40)}px`;
  el.classList.remove('hidden');
}

function endGesture() {
  const g = S.gesture;
  if (g && g.kind === 'measure') {
    S.gesture = null;
    if (g.moved) {
      // A real drag: finish here, leave the box up until the next click.
      setTool('cursor');
    } else {
      // Just a click: wait for a second click to set the end point.
      S.measureDraft = true;
    }
    draw();
    return;
  }
  if (g && (g.kind === 'handle' || g.kind === 'move')) {
    saveDrawings();
    // Keep the measurement visible on the drawing that was just edited.
    if (S.selected) { showBubble(S.selected); showStyleBar(); }
  }
  if (g && g.kind === 'level') {
    // A bare click (no drag) must not commit a level sitting on the entry.
    if (g.moved) commitLevel(g.handle);
    else S.optimistic.delete(levelKey(g.handle.entity, g.handle.ticket, g.handle.kind));
    showBubble(null);
  }
  S.gesture = null;
}

/** Push a dragged SL/TP (or pending entry) to the terminal.
 *
 *  MT5 takes SL and TP together, so the untouched field has to be sent as well.
 *  It must come from the optimistic view, not the position's last server value:
 *  dragging SL and then TP inside one 2s poll window would otherwise send a
 *  stale null for SL and silently wipe the stop that was just set. */
function commitLevel(h) {
  const r = h.ref;
  const round = (v) => (v == null ? null : +v.toFixed(S.pip));
  const other = (kind, actual) =>
    round(h.kind === kind ? h.price : levelPrice(h.entity, h.ticket, kind, actual));

  if (h.entity === 'position') {
    window.DFX.send({
      action: 'mt5_modify',
      ticket: h.ticket,
      sl: other('sl', r.sl),
      tp: other('tp', r.tp),
    });
  } else {
    window.DFX.send({
      action: 'mt5_modify_order',
      ticket: h.ticket,
      price: other('price', r.price_open),
      sl: other('sl', r.sl),
      tp: other('tp', r.tp),
    });
  }
}
canvas.addEventListener('pointerup', endGesture);
canvas.addEventListener('pointercancel', endGesture);

canvas.addEventListener('pointerleave', () => {
  S.pointer = null;
  draw();
});

canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const { x } = localPos(ev);
  const factor = Math.exp(ev.deltaY / 500);
  const anchor = iOf(Math.min(x, plotX1()));
  S.bars = Math.min(MAX_BARS, Math.max(MIN_BARS, S.bars * factor));
  // keep the bar under the cursor pinned
  S.viewRight = anchor + (plotX1() - Math.min(x, plotX1())) / (plotW() / S.bars);
  clampView();
  draw();
}, { passive: false });

canvas.addEventListener('dblclick', () => { resetView(); draw(); });

function clampView() {
  const n = S.candles.length;
  S.bars = Math.min(MAX_BARS, Math.max(MIN_BARS, S.bars));
  S.viewRight = Math.min(n - 1 + S.bars * 0.6, Math.max(S.bars * 0.4, S.viewRight));
  maybeBackfill();
}

/** Pull the next page of older candles once the view nears the oldest bar,
 *  so history deepens as you pan left until the server runs out. */
function maybeBackfill() {
  if (S.backfilling || S.exhausted || S.candles.length < 2) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (S.viewRight - S.bars > 80) return;          // still far from the edge
  S.backfilling = true;
  $('hint').textContent = 'loading older candles…';
  ws.send(JSON.stringify({ action: 'more', before: S.candles[0].epoch }));
}

function applyBackfill(list) {
  S.backfilling = false;
  const oldest = S.candles.length ? S.candles[0].epoch : Infinity;
  const older = list.filter((c) => c.epoch < oldest);
  if (!older.length) {
    S.exhausted = true;
    $('hint').textContent = 'reached the earliest candles Deriv serves (1 year)';
    return;
  }
  S.candles = older.concat(S.candles);
  S.epochs = S.candles.map((c) => c.epoch);
  S.viewRight += older.length;                   // keep the same bars on screen
  $('hint').textContent = `${S.candles.length.toLocaleString()} candles loaded`;
  draw();
}

/** Zoom the time axis about the right edge, so the newest bar stays put. */
function zoomBy(factor) {
  const anchor = S.viewRight;
  S.bars = Math.min(MAX_BARS, Math.max(MIN_BARS, S.bars * factor));
  S.viewRight = anchor;
  clampView();
  draw();
}

function resetView() {
  // On timeframes where the whole series is short — 1D tops out around a year,
  // so ~366 bars — fit all of it rather than showing a 120-bar sliver of it.
  const n = S.candles.length;
  S.bars = Math.max(MIN_BARS, n <= FIT_ALL_BELOW ? n : DEFAULT_BARS);
  S.viewRight = n - 1 + 2;
  S.priceZoom = 1;
  S.priceShift = 0;
}

document.addEventListener('keydown', (ev) => {
  if (ev.target.tagName === 'SELECT' || ev.target.tagName === 'INPUT') return;
  const k = ev.key.toLowerCase();
  if (k === 't') setTool('trend');
  else if (k === 'r') setTool('ray');
  else if (k === 'h') setTool('hline');
  else if (k === 'z') setTool('rect');
  else if (k === 'p') setTool('range');
  else if (k === 'e') setTool('measure');
  else if (k === 'escape') {
    S.draft = null; S.measure = null; showBubble(null);
    hideStyleBar(); S.selected = null; setTool('cursor');
  }
  else if (k === 'm') setMagnet(!S.magnet);
  else if (ev.key === '+' || ev.key === '=') zoomBy(1 / 1.3);
  else if (ev.key === '-' || ev.key === '_') zoomBy(1.3);
  else if (ev.key === 'Delete' || ev.key === 'Backspace') {
    if (S.readOnly) return;
    if (S.selected) {
      S.drawings = S.drawings.filter((d) => d !== S.selected);
      S.selected = null;
      hideStyleBar();
      showBubble(null);
      saveDrawings();
    }
  } else return;
  draw();
});

// ── chrome ────────────────────────────────────────────────────────────────
const ACTIVE = ['bg-accent', 'text-white'];
const IDLE = ['text-muted', 'dark:text-muted-dark'];

function setTool(tool) {
  if (S.readOnly && tool !== 'cursor') return;   // read-only during a live
  S.tool = tool;
  S.draft = null;
  if (tool !== 'measure' && tool !== 'cursor') S.measure = null;
  document.querySelectorAll('.tool').forEach((b) => {
    const on = b.dataset.tool === tool;
    b.classList.toggle('bg-accent', on);
    b.classList.toggle('text-white', on);
    b.classList.toggle('text-muted', !on);
    b.classList.toggle('dark:text-muted-dark', !on);
  });
  canvas.style.cursor = tool === 'cursor' ? 'default' : 'crosshair';
}

function setMagnet(on) {
  const changed = on !== S.magnet;
  S.magnet = on;
  if (changed) saveSettings();
  const b = $('magnet');
  b.classList.toggle('bg-accent', on);
  b.classList.toggle('text-white', on);
  b.classList.toggle('text-muted', !on);
  b.classList.toggle('dark:text-muted-dark', !on);
}

function buildTimeframes(granularities) {
  const sel = $('timeframes');
  sel.innerHTML = '';
  for (const g of granularities) {
    const o = document.createElement('option');
    o.value = g;
    o.textContent = TF_LABELS[g] || `${g}s`;
    sel.appendChild(o);
  }
  sel.onchange = (ev) => setGranularity(Number(ev.target.value));
  markTimeframe();
}

function markTimeframe() {
  const sel = $('timeframes');
  if (sel) sel.value = String(S.granularity);
}

function buildSymbols(symbols) {
  const sel = $('symbol');
  sel.innerHTML = '';
  const byMarket = new Map();
  for (const s of symbols) {
    if (!byMarket.has(s.market)) byMarket.set(s.market, []);
    byMarket.get(s.market).push(s);
  }
  for (const [market, rows] of byMarket) {
    const group = document.createElement('optgroup');
    group.label = market || 'Markets';
    for (const s of rows) {
      const o = document.createElement('option');
      o.value = s.symbol;
      o.textContent = s.name;
      group.appendChild(o);
    }
    sel.appendChild(group);
  }
  sel.value = S.symbol;
  if (sel.selectedIndex < 0) {
    sel.selectedIndex = 0;
    S.symbol = sel.value;
  }
  S.symbolName = sel.options[sel.selectedIndex]?.textContent || S.symbol;
}

$('symbol').onchange = (ev) => {
  S.symbol = ev.target.value;
  S.symbolName = ev.target.options[ev.target.selectedIndex].textContent;
  S.positions = [];
  loadDrawings();
  saveSettings();
  requestData();
  reportSymbol();
  if (window.LIVE) window.LIVE.onSymbol(S.symbol);
  if (window.DFX.onSymbolChange) window.DFX.onSymbolChange(S.symbol);
};

/** Tell the desktop shell what this window is showing (labels the launcher). */
function reportSymbol() {
  if (window.dfxDesktop && window.dfxDesktop.reportSymbol) {
    window.dfxDesktop.reportSymbol(WS, S.symbolName || S.symbol);
  }
}

function setGranularity(g) {
  if (g === S.granularity) return;
  S.granularity = g;
  markTimeframe();
  saveSettings();
  requestData();
  if (window.LIVE) window.LIVE.onTimeframe(g);
}

$('clear').onclick = () => {
  if (S.readOnly) return;
  // Context-aware: with a drawing selected, delete only that one; with none
  // selected, clear everything (but confirm, so it can't wipe all by accident).
  if (S.selected) {
    S.drawings = S.drawings.filter((d) => d !== S.selected);
    S.selected = null;
    saveDrawings(); showBubble(null); hideStyleBar(); draw();
    return;
  }
  if (!S.drawings.length) return;
  if (!confirm(`Delete all ${S.drawings.length} drawings?`)) return;
  S.drawings = []; S.draft = null;
  saveDrawings(); showBubble(null); hideStyleBar(); draw();
};

// Style bar: colour swatches, line style, delete — act on the selected drawing.
(function buildStyleBar() {
  const host = $('style-colors');
  if (!host) return;
  for (const c of DRAW_COLORS) {
    const b = document.createElement('button');
    b.dataset.color = c;
    b.className = 'h-5 w-5 rounded-full border border-black/20';
    b.style.background = c;
    b.onclick = () => {
      if (!S.selected) return;
      S.selected.color = c;
      S.drawColor = c;            // remember for the next drawing
      saveDrawings(); showStyleBar(); draw();
    };
    host.appendChild(b);
  }
  document.querySelectorAll('.stylebtn').forEach((b) => {
    b.onclick = () => {
      if (!S.selected) return;
      S.selected.style = b.dataset.style;
      saveDrawings(); showStyleBar(); draw();
    };
  });
  $('style-delete').onclick = () => {
    if (!S.selected) return;
    S.drawings = S.drawings.filter((d) => d !== S.selected);
    S.selected = null;
    saveDrawings(); hideStyleBar(); showBubble(null); draw();
  };
})();
$('reset').onclick = () => { resetView(); draw(); };
$('zoom-in').onclick = () => zoomBy(1 / 1.3);
$('zoom-out').onclick = () => zoomBy(1.3);
$('hollow').onclick = (ev) => {
  S.hollow = !S.hollow;
  ev.currentTarget.classList.toggle('bg-accent', S.hollow);
  ev.currentTarget.classList.toggle('text-white', S.hollow);
  saveSettings();
  draw();
};
$('theme').onclick = () => {
  S.theme = S.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.classList.toggle('dark', S.theme === 'dark');
  saveSettings();
  draw();
  if (window.DFX.onThemeChange) window.DFX.onThemeChange();
};
$('save').onclick = () => {
  const name = saveImage();
  const el = $('save');
  const was = el.textContent;
  el.textContent = 'Saved';
  setTimeout(() => { el.textContent = was; }, 1400);
  $('hint').textContent = `saved ${name}`;
};
document.querySelectorAll('.tool').forEach((b) => {
  b.onclick = () => setTool(b.dataset.tool);
});
$('magnet').onclick = () => setMagnet(!S.magnet);

// Show / hide the right-hand trade panel; the chart reflows to fill the space.
function applyPanel() {
  const aside = document.getElementById('trade');
  if (aside) aside.classList.toggle('hidden', S.panelHidden);
  const btn = $('panel-toggle');
  if (btn) {
    btn.classList.toggle('bg-accent', S.panelHidden);
    btn.classList.toggle('text-white', S.panelHidden);
    btn.title = S.panelHidden ? 'Show the trade panel' : 'Hide the trade panel';
  }
  resize();
}
$('panel-toggle').onclick = () => {
  S.panelHidden = !S.panelHidden;
  saveSettings();
  applyPanel();
};
// New window: name it first, then ask the desktop shell to open it.
function openWsModal() {
  const m = $('ws-modal');
  if (!m) return;
  m.classList.remove('hidden');
  m.classList.add('flex');
  const input = $('ws-name');
  input.value = '';
  setTimeout(() => input.focus(), 30);
}

function closeWsModal() {
  const m = $('ws-modal');
  if (!m) return;
  m.classList.add('hidden');
  m.classList.remove('flex');
}

function createWs() {
  const name = ($('ws-name').value || '').trim();
  closeWsModal();
  if (window.dfxDesktop && window.dfxDesktop.newWindow) window.dfxDesktop.newWindow(name);
  else window.open(`${location.pathname}?ws=ws-${Date.now().toString(36)}` +
                   `&name=${encodeURIComponent(name)}`, '_blank');
}

$('new-window').onclick = openWsModal;
// Ctrl+N from the app menu opens the same dialog.
if (window.dfxDesktop && window.dfxDesktop.onNewWindowDialog) {
  window.dfxDesktop.onNewWindowDialog(openWsModal);
}
if ($('ws-cancel')) $('ws-cancel').onclick = closeWsModal;
if ($('ws-create')) $('ws-create').onclick = createWs;
if ($('ws-name')) {
  $('ws-name').onkeydown = (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); createWs(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); closeWsModal(); }
    ev.stopPropagation();          // don't let the chart's hotkeys fire
  };
}

function setStatus(text, mode) {
  $('status').textContent = text;
  const dot = $('dot');
  const ok = /connected|polling|live/i.test(text);
  dot.className = `h-1.5 w-1.5 rounded-full ${ok ? 'bg-up' : 'bg-down'}`;
  if (mode) $('mode').textContent = mode === 'stream' ? 'live stream' : 'polling';
}

// ── data ──────────────────────────────────────────────────────────────────
function applyCandles(list, initial) {
  if (!list.length) return;
  if (initial || !S.candles.length) {
    S.candles = list;
    S.epochs = list.map((c) => c.epoch);
    resetView();
  } else {
    const last = S.candles[S.candles.length - 1].epoch;
    for (const c of list) {
      if (c.epoch > last) { S.candles.push(c); S.epochs.push(c.epoch); }
      else {
        const i = S.epochs.lastIndexOf(c.epoch);
        if (i >= 0) S.candles[i] = c;
      }
    }
    clampView();
  }
  setLoading(false);
  draw();
}

/** Toggle the loading mark.  The plot and legend are blanked while it shows,
 *  so candles from the previous symbol or timeframe never sit behind it. */
function setLoading(on, text) {
  if (text) $('empty-text').textContent = text;
  $('empty').classList.toggle('hidden', !on);
  canvas.classList.toggle('invisible', on);
  $('legend').classList.toggle('invisible', on);
}

function applyPatch(c) {
  if (!S.candles.length) return;
  const last = S.candles[S.candles.length - 1];
  if (c.epoch === last.epoch) S.candles[S.candles.length - 1] = c;
  else if (c.epoch > last.epoch) {
    const atRight = S.viewRight >= S.candles.length - 2;
    S.candles.push(c); S.epochs.push(c.epoch);
    if (atRight) S.viewRight += 1;
  } else return;
  draw();
}

// ── transport ─────────────────────────────────────────────────────────────
let ws = null;

function requestData() {
  setLoading(true, 'loading candles…');
  S.backfilling = false;
  S.exhausted = false;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'watch', symbol: S.symbol, granularity: S.granularity }));
  }
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => { setStatus('connected'); requestData(); };
  ws.onclose = () => { setStatus('disconnected — retrying'); setTimeout(connect, 1500); };
  ws.onerror = () => setStatus('connection error');

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    switch (m.type) {
      case 'status': setStatus(m.text, m.mode); break;
      case 'error': setStatus(m.text); setLoading(true, m.text); break;
      case 'symbols': buildSymbols(m.symbols); break;
      case 'candles':
        if (m.symbol !== S.symbol || m.granularity !== S.granularity) return;
        S.pip = m.pip_size ?? 2;
        setStatus(m.mode === 'stream' ? 'live' : 'polling', m.mode);
        applyCandles(m.candles, m.initial);
        break;
      case 'backfill':
        if (m.symbol !== S.symbol || m.granularity !== S.granularity) return;
        applyBackfill(m.candles);
        break;
      case 'patch':
        if (m.symbol !== S.symbol || m.granularity !== S.granularity) return;
        applyPatch(m.candle);
        break;
    }
    // Anything MetaTrader-related belongs to the trade panel.
    if (m.type && m.type.startsWith('mt5') && window.DFX.onMessage) {
      window.DFX.onMessage(m);
    }
  };
}

// ── public API for the trade panel ────────────────────────────────────────
window.DFX = {
  /** Positions for the charted symbol, drawn as entry / SL / TP lines.
   *  Ignored mid-drag so the level under the cursor doesn't fight the poll. */
  setPositions(list) {
    if (S.gesture?.kind === 'level') return;
    S.positions = list || [];
    draw();
  },
  /** Pending orders for the charted symbol. */
  setOrders(list) {
    if (S.gesture?.kind === 'level') return;
    S.orders = list || [];
    draw();
  },
  /** Rectangle (canvas px) that level badges should route around, or null. */
  setAvoidRect(rect) {
    S.avoid = rect;
    draw();
  },
  /** Drop optimistic overrides once the terminal confirms a change. */
  clearOptimistic() {
    S.optimistic.clear();
    draw();
  },
  /** Send an action up the same socket the chart uses. */
  send(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  },
  /** Price <-> pixel, for overlays positioned against the price scale. */
  priceToY: (price) => { ensureGeometry(); return yOf(price); },
  yToPrice: (y) => { ensureGeometry(); return pOf(y); },
  get symbol() { return S.symbol; },
  get symbolName() { return S.symbolName; },
  get lastPrice() {
    const c = S.candles[S.candles.length - 1];
    return c ? c.close : null;
  },
  /** Chart -> panel notifications; the panel assigns these. */
  onSymbolChange: null,
  onMessage: null,
};

// ── boot ──────────────────────────────────────────────────────────────────
function resize() {
  const r = $('wrap').getBoundingClientRect();
  S.W = r.width; S.H = r.height;
  canvas.width = Math.round(r.width * devicePixelRatio);
  canvas.height = Math.round(r.height * devicePixelRatio);
  draw();
}
new ResizeObserver(resize).observe($('wrap'));

(async function boot() {
  const saved = await loadSettings();
  S.theme = saved.theme || 'dark';
  S.symbol = saved.symbol || S.symbol;
  S.symbolName = saved.symbolName || S.symbolName;
  S.granularity = saved.granularity || S.granularity;
  S.hollow = !!saved.hollow;
  S.panelHidden = !!saved.panelHidden;
  document.documentElement.classList.toggle('dark', S.theme === 'dark');
  $('hollow').classList.toggle('bg-accent', S.hollow);
  $('hollow').classList.toggle('text-white', S.hollow);
  applyPanel();
  // Only the packaged shell overlays native window controls on the page.
  if (window.dfxDesktop) document.body.classList.add('desktop-shell');
  if (WS_NAME) document.title = `DropletFX — ${WS_NAME}`;
  $('tz').textContent = TZ.label;

  const cfg = await (await fetch('/api/config')).json();
  buildTimeframes(cfg.granularities);
  buildSymbols(cfg.symbols);
  setTool('cursor');
  setMagnet(!!saved.magnet);
  await fetchStore();
  loadDrawings();
  reportSymbol();
  resize();
  connect();
})();
