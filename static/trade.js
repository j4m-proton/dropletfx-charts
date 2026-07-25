/* MetaTrader 5 order panel.
 *
 * Order entry is deliberately two-step: the first click validates the order
 * with MT5's `order_check` (which does not execute) and arms the button; only
 * a second click on the armed button sends it.  Arming lapses after 6s so a
 * stale confirm can't fire later against a moved market.
 */
'use strict';

const T = (id) => document.getElementById(id);

const P = {
  account: null,
  symbol: null,          // MT5 symbol info for the charted instrument
  positions: [],
  orders: [],
  armed: null,           // {side, volume, sl, tp, at}
  armTimer: null,
  pendingSide: 'buy',    // which button asked for the check
};

const ARM_MS = 6000;

// ── formatting ────────────────────────────────────────────────────────────
const money = (v, ccy) => `${v < 0 ? '-' : ''}${ccy || ''}${Math.abs(v).toFixed(2)}`;
const px = (v) => (P.symbol && v != null ? v.toFixed(P.symbol.digits) : '—');

/** P&L colouring: profit green, loss red — reserved status colours, distinct
 *  from the blue used for down candles. */
function signClass(v) {
  if (v > 0) return 'text-profit dark:text-profit-dark';
  if (v < 0) return 'text-loss dark:text-loss-dark';
  return 'text-muted dark:text-muted-dark';
}

// ── account ───────────────────────────────────────────────────────────────
function renderAccount(a) {
  P.account = a;
  const badge = T('acct-mode');
  badge.textContent = a.mode;
  // A real-money account is called out in brand red; demo stays quiet green.
  badge.className = 'rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide ' +
    (a.mode === 'REAL' ? 'bg-accent text-white' : 'bg-up/20 text-up');

  T('acct-id').textContent = `${a.login} · ${a.server}`;
  T('acct-balance').textContent = money(a.balance, '');
  T('acct-equity').textContent = money(a.equity, '');
  T('acct-free').textContent = money(a.margin_free, '');
  const pnl = T('acct-pnl');
  pnl.textContent = `${a.profit >= 0 ? '+' : ''}${a.profit.toFixed(2)}`;
  pnl.className = 'text-right ' + signClass(a.profit);

  // Surface each blocker separately — they have different fixes.
  const blockers = [];
  if (!a.terminal_trade_allowed) {
    blockers.push('<b>AutoTrading is off in MetaTrader 5.</b> Click the ' +
                  '“Algo Trading” button in its toolbar to allow order entry.');
  }
  if (!a.account_trade_allowed) blockers.push('Trading is disabled on this account.');
  if (!a.app_trade_enabled) blockers.push('Order placement is switched off in mt5_bridge.py.');

  const warn = T('trade-warn');
  warn.innerHTML = blockers.join('<br>');
  warn.classList.toggle('hidden', !blockers.length);
  updateButtons();
}

const canTrade = () => !!(P.account && P.account.terminal_trade_allowed &&
                          P.account.account_trade_allowed &&
                          P.account.app_trade_enabled && P.symbol &&
                          P.symbol.trade_allowed);

// ── symbol / quote ────────────────────────────────────────────────────────
function renderSymbol(s) {
  P.symbol = s;
  if (!s) {
    T('mt5-symbol').textContent = `${window.DFX.symbolName} — not tradable on MT5`;
    T('mt5-bid').textContent = T('mt5-ask').textContent = '—';
    T('mt5-spread').textContent = '';
    T('vol-hint').textContent = '';
    updateButtons();
    return;
  }
  T('mt5-symbol').textContent = s.symbol;
  T('mt5-bid').textContent = px(s.bid);
  T('mt5-ask').textContent = px(s.ask);
  T('mt5-spread').textContent = `spread ${s.spread} pts`;
  T('sell-px').textContent = px(s.bid);
  T('buy-px').textContent = px(s.ask);
  T('vol-hint').textContent = `min ${s.volume_min} · step ${s.volume_step} · max ${s.volume_max}`;

  const vol = T('volume');
  vol.min = s.volume_min;
  vol.max = s.volume_max;
  vol.step = s.volume_step;
  if (+vol.value < s.volume_min) vol.value = s.volume_min;
  updateButtons();
}

function updateButtons() {
  const ok = canTrade();
  for (const b of document.querySelectorAll('.order-btn')) b.disabled = !ok;
}

// ── floating P&L orb ──────────────────────────────────────────────────────
// Visible only while trades are running; total P&L across all open positions.
const ORB_PROFIT = { light: '#00a854', dark: '#00e676' };
const ORB_LOSS = { light: '#cf1322', dark: '#ff453a' };

/** Tell the chart where the orb sits so level badges dodge it. */
function publishOrbRect() {
  const orb = T('pnl-orb');
  if (orb.classList.contains('hidden')) {
    window.DFX.setAvoidRect(null);
    return;
  }
  const o = orb.getBoundingClientRect();
  const host = orb.parentElement.getBoundingClientRect();
  window.DFX.setAvoidRect({
    left: o.left - host.left, right: o.right - host.left,
    top: o.top - host.top, bottom: o.bottom - host.top,
  });
}

function renderOrb() {
  const orb = T('pnl-orb');
  const open = P.positions.length;

  if (!open) {                       // no running trade -> no orb at all
    orb.classList.add('hidden');
    window.DFX.setAvoidRect(null);
    return;
  }
  const total = P.positions.reduce((sum, p) => sum + p.profit, 0);
  const dark = document.documentElement.classList.contains('dark');
  const colour = (total < 0 ? ORB_LOSS : ORB_PROFIT)[dark ? 'dark' : 'light'];

  T('orb-ring').style.borderColor = colour;
  const value = T('orb-value');
  value.textContent = `${total >= 0 ? '+' : '−'}${Math.abs(total).toFixed(2)}`;
  value.style.color = colour;
  T('orb-sub').textContent = `${open} trade${open > 1 ? 's' : ''}`;
  orb.classList.remove('hidden');
  publishOrbRect();
}

/** Let the orb be dragged anywhere over the chart. */
(function makeOrbDraggable() {
  const orb = T('pnl-orb');
  let drag = null;
  orb.addEventListener('pointerdown', (ev) => {
    const r = orb.getBoundingClientRect();
    const host = orb.parentElement.getBoundingClientRect();
    drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top, host };
    orb.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  orb.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const x = ev.clientX - drag.host.left - drag.dx;
    const y = ev.clientY - drag.host.top - drag.dy;
    const maxX = drag.host.width - orb.offsetWidth;
    const maxY = drag.host.height - orb.offsetHeight;
    orb.style.left = `${Math.min(Math.max(0, x), maxX)}px`;
    orb.style.top = `${Math.min(Math.max(0, y), maxY)}px`;
    orb.style.right = 'auto';
    orb.style.bottom = 'auto';
    publishOrbRect();
  });
  const stop = () => { drag = null; };
  orb.addEventListener('pointerup', stop);
  orb.addEventListener('pointercancel', stop);
})();

// ── positions ─────────────────────────────────────────────────────────────
function renderPositions(list) {
  P.positions = list || [];
  const mine = P.symbol
    ? P.positions.filter((p) => p.symbol === P.symbol.symbol)
    : [];
  window.DFX.setPositions(mine);

  T('pos-count').textContent = String(P.positions.length);
  renderOrb();
  const host = T('positions');
  if (!P.positions.length) {
    host.innerHTML = '<div class="text-[11px] text-muted dark:text-muted-dark">none open</div>';
    return;
  }
  host.innerHTML = '';
  for (const p of P.positions) {
    const row = document.createElement('div');
    row.className = 'rounded border border-edge dark:border-edge-dark px-2 py-1.5 font-mono text-[11px]';
    row.innerHTML =
      `<div class="flex items-center justify-between">
         <span class="font-bold" style="color:${p.side === 'buy' ? '#00e676' : '#2979ff'}">
           ${p.side.toUpperCase()} ${p.volume}</span>
         <span class="${signClass(p.profit)}">${p.profit >= 0 ? '+' : ''}${p.profit.toFixed(2)}</span>
       </div>
       <div class="mt-0.5 truncate text-muted dark:text-muted-dark">${p.symbol}</div>
       <div class="text-muted dark:text-muted-dark">@ ${p.price_open}</div>`;

    // SL/TP fields — also the way to create a level that can then be dragged.
    row.appendChild(levelEditor(p));

    const close = document.createElement('button');
    close.textContent = 'Close';
    close.className = 'mt-1 w-full rounded bg-edge dark:bg-edge-dark py-1 text-[11px] ' +
                      'font-sans font-semibold text-ink dark:text-ink-dark hover:opacity-80';
    close.onclick = () => {
      close.disabled = true;
      close.textContent = 'closing…';
      window.DFX.send({ action: 'mt5_close', ticket: p.ticket });
    };
    row.appendChild(close);
    host.appendChild(row);
  }
}

/** Compact SL / TP inputs for one position. */
function levelEditor(p) {
  const wrap = document.createElement('div');
  wrap.className = 'mt-1 grid grid-cols-2 gap-1';
  const cls = 'w-full rounded border border-edge dark:border-edge-dark bg-white dark:bg-shell-dark ' +
              'px-1 py-0.5 font-mono text-[10px] text-ink dark:text-ink-dark outline-none focus:border-accent';

  const mk = (kind, value) => {
    const i = document.createElement('input');
    i.type = 'number';
    i.step = 'any';
    i.placeholder = kind.toUpperCase();
    i.value = value ?? '';
    i.className = cls;
    i.onchange = () => {
      const v = parseFloat(i.value);
      window.DFX.send({
        action: 'mt5_modify',
        ticket: p.ticket,
        sl: kind === 'sl' ? (Number.isFinite(v) ? v : null) : p.sl,
        tp: kind === 'tp' ? (Number.isFinite(v) ? v : null) : p.tp,
      });
    };
    return i;
  };
  wrap.append(mk('sl', p.sl), mk('tp', p.tp));
  return wrap;
}

// ── pending orders ────────────────────────────────────────────────────────
function renderOrders(list) {
  P.orders = list || [];
  const mine = P.symbol
    ? P.orders.filter((o) => o.symbol === P.symbol.symbol)
    : [];
  window.DFX.setOrders(mine);

  T('orders-block').classList.toggle('hidden', !P.orders.length);
  T('ord-count').textContent = String(P.orders.length);

  const host = T('orders');
  host.innerHTML = '';
  for (const o of P.orders) {
    const row = document.createElement('div');
    row.className = 'rounded border border-edge dark:border-edge-dark px-2 py-1.5 font-mono text-[11px]';
    row.innerHTML =
      `<div class="flex items-center justify-between">
         <span class="font-bold" style="color:#ffb020">${o.kind.toUpperCase()} ${o.volume}</span>
         <span class="text-muted dark:text-muted-dark">@ ${o.price_open}</span>
       </div>
       <div class="mt-0.5 truncate text-muted dark:text-muted-dark">${o.symbol}</div>
       <div class="text-muted dark:text-muted-dark">
         SL ${o.sl ?? '—'} · TP ${o.tp ?? '—'}</div>`;

    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.className = 'mt-1 w-full rounded bg-edge dark:bg-edge-dark py-1 text-[11px] ' +
                       'font-sans font-semibold text-ink dark:text-ink-dark hover:opacity-80';
    cancel.onclick = () => {
      cancel.disabled = true;
      cancel.textContent = 'cancelling…';
      window.DFX.send({ action: 'mt5_cancel', ticket: o.ticket });
    };
    row.appendChild(cancel);
    host.appendChild(row);
  }
}

// ── order entry ───────────────────────────────────────────────────────────
function readOrder(side) {
  const sl = parseFloat(T('sl').value);
  const tp = parseFloat(T('tp').value);
  return {
    side,
    volume: parseFloat(T('volume').value),
    sl: Number.isFinite(sl) ? sl : null,
    tp: Number.isFinite(tp) ? tp : null,
  };
}

function message(text, tone) {
  const el = T('order-msg');
  el.textContent = text;
  el.className = 'min-h-[2.5em] font-mono text-[10px] leading-snug ' +
    (tone === 'bad' ? 'text-down' : tone === 'good' ? 'text-up'
      : 'text-muted dark:text-muted-dark');
}

function disarm() {
  clearTimeout(P.armTimer);
  P.armed = null;
  for (const b of document.querySelectorAll('.order-btn')) {
    const side = b.dataset.side;
    b.style.background = side === 'buy' ? '#00a854' : '#2979ff';
    b.firstChild.textContent = side.toUpperCase();
  }
}

function arm(side, order, check) {
  P.armed = { ...order, at: Date.now() };
  const b = T(side === 'buy' ? 'btn-buy' : 'btn-sell');
  b.style.background = '#f50512';
  b.firstChild.textContent = 'CONFIRM';
  message(`${side.toUpperCase()} ${check.volume} ${check.symbol} @ ${check.price}\n` +
          `margin ${check.margin} · free after ${check.margin_free}\n` +
          'click again within 6s to send', null);
  clearTimeout(P.armTimer);
  P.armTimer = setTimeout(() => { disarm(); message('confirmation expired', null); }, ARM_MS);
}

for (const btn of document.querySelectorAll('.order-btn')) {
  btn.onclick = () => {
    const side = btn.dataset.side;
    const order = readOrder(side);

    if (!Number.isFinite(order.volume) || order.volume <= 0) {
      message('enter a volume', 'bad');
      return;
    }
    // Second click on the armed button -> actually send.
    if (P.armed && P.armed.side === side) {
      const payload = { action: 'mt5_order', symbol: window.DFX.symbol, ...P.armed };
      delete payload.at;
      disarm();
      message('sending…', null);
      window.DFX.send(payload);
      return;
    }
    // First click -> validate only.  order_check never executes.
    disarm();
    message('checking…', null);
    window.DFX.send({ action: 'mt5_check', symbol: window.DFX.symbol, ...order });
  };
}

T('vol-minus').onclick = () => stepVolume(-1);
T('vol-plus').onclick = () => stepVolume(1);
function stepVolume(dir) {
  const s = P.symbol;
  const el = T('volume');
  const step = s ? s.volume_step : 0.01;
  const min = s ? s.volume_min : 0.01;
  const max = s ? s.volume_max : 100;
  const decimals = (String(step).split('.')[1] || '').length;
  let v = (parseFloat(el.value) || min) + dir * step;
  v = Math.min(max, Math.max(min, v));
  el.value = v.toFixed(decimals);
  disarm();
}

// Any parameter change invalidates an armed confirmation.
for (const id of ['volume', 'sl', 'tp']) T(id).addEventListener('input', disarm);

// ── wiring ────────────────────────────────────────────────────────────────
window.DFX.onThemeChange = renderOrb;

window.DFX.onSymbolChange = () => {
  disarm();
  P.symbol = null;
  renderPositions(P.positions);
  message('', null);
};

window.DFX.onMessage = (m) => {
  switch (m.type) {
    case 'mt5':
      renderAccount(m.account);
      renderSymbol(m.symbol);
      renderPositions(m.positions);
      renderOrders(m.orders);
      break;

    case 'mt5_check': {
      const r = m.result;
      if (r.ok) arm(P.pendingSide, readOrder(P.pendingSide), r);
      else message(`rejected: ${r.comment} (${r.retcode})`, 'bad');
      break;
    }

    case 'mt5_order': {
      const r = m.result;
      message(r.ok ? `done — ${r.comment}${r.order ? ` · order ${r.order}` : ''}`
                   : `failed: ${r.comment} (${r.retcode})`,
              r.ok ? 'good' : 'bad');
      // A rejected drag must snap back to what the terminal actually holds.
      if (!r.ok) window.DFX.clearOptimistic();
      break;
    }

    case 'mt5_result_error':
      disarm();
      message(m.text, 'bad');
      break;

    case 'mt5_error':
      T('acct-id').textContent = m.text;
      T('acct-mode').textContent = 'OFFLINE';
      T('acct-mode').className = 'rounded bg-edge dark:bg-edge-dark px-1.5 py-0.5 ' +
                                 'text-[10px] font-bold tracking-wide text-muted dark:text-muted-dark';
      P.account = null;
      updateButtons();
      break;
  }
};

// The check response doesn't echo which button was pressed, so remember it.
for (const btn of document.querySelectorAll('.order-btn')) {
  btn.addEventListener('click', () => { P.pendingSide = btn.dataset.side; }, true);
}

renderPositions([]);
updateButtons();
