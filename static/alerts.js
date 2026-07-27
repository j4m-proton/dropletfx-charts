/* Price alerts — desktop client.
 *
 * Ownership split:
 *   • The backend stores each alert and checks it against the live Deriv price.
 *   • This module syncs an alert to a chart line (create / delete via the shell's
 *     authenticated REST bridge) and listens on the per-user dashboard WebSocket
 *     for the trigger, which rings an alarm and shows a popover.
 *
 * No-op outside the signed-in desktop shell. chart.js calls window.ALERTS to
 * attach/detach an alert to the selected horizontal line; everything else is
 * self-contained here.
 */
'use strict';

(function () {
  const D = window.dfxDesktop;
  if (!D || !D.alertsCreate) return;          // not the desktop shell

  const A = {
    ws: null, ended: false, attempt: 0, ping: null,
    audio: null, alarmTimer: null, alarmStop: null,
  };

  // ── backend socket (carries triggers) ──────────────────────────────────────
  async function connect() {
    if (A.ended) return;
    let base = '', token = '';
    try {
      const s = await D.session();
      base = (s && s.apiBase) || '';
      token = (await D.liveToken()) || '';
    } catch { /* not ready */ }
    if (!base || !token) { setTimeout(connect, 4000); return; }   // not signed in yet

    const url = base.replace(/^http/, 'ws') +
      `/ws/dashboard/?token=${encodeURIComponent(token)}`;
    let ws;
    try { ws = new WebSocket(url); } catch { setTimeout(connect, 4000); return; }
    A.ws = ws;

    ws.onopen = () => {
      A.attempt = 0;
      clearInterval(A.ping);
      A.ping = setInterval(() => {
        try { ws.readyState === 1 && ws.send('{"action":"ping"}'); } catch {}
      }, 25000);
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m && m.type === 'alert' && m.event === 'triggered') onTrigger(m);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
    ws.onclose = () => {
      clearInterval(A.ping);
      if (A.ended) return;
      A.attempt = Math.min(A.attempt + 1, 15);
      setTimeout(connect, Math.min(1000 * A.attempt, 15000));
    };
  }

  // ── the alarm (Web Audio, no asset needed) ─────────────────────────────────
  function beep(ac) {
    const tone = (freq, at, dur) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'square';
      o.frequency.value = freq;
      o.connect(g); g.connect(ac.destination);
      const t = ac.currentTime + at;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.28, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.start(t); o.stop(t + dur + 0.02);
    };
    tone(880, 0, 0.16);
    tone(1320, 0.2, 0.18);
  }

  function playAlarm() {
    stopAlarm();
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ac = new Ctx();
      if (ac.state === 'suspended') ac.resume().catch(() => {});
      A.audio = ac;
      beep(ac);
      A.alarmTimer = setInterval(() => beep(ac), 850);
      A.alarmStop = setTimeout(stopAlarm, 25000);     // never ring forever
    } catch { /* audio unavailable */ }
  }

  function stopAlarm() {
    clearInterval(A.alarmTimer);
    clearTimeout(A.alarmStop);
    A.alarmTimer = A.alarmStop = null;
    if (A.audio) { try { A.audio.close(); } catch {} A.audio = null; }
  }

  // ── trigger popover ────────────────────────────────────────────────────────
  function stackHost() {
    let host = document.getElementById('alert-stack');
    if (!host) {
      host = document.createElement('div');
      host.id = 'alert-stack';
      host.style.cssText =
        'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:9999;' +
        'display:flex;flex-direction:column;gap:10px;align-items:center;' +
        'pointer-events:none;max-width:92vw;';
      document.body.appendChild(host);
    }
    return host;
  }

  function onTrigger(m) {
    playAlarm();
    // Let the chart clear the bell on the line that fired (if it's loaded here).
    try { window.DFX && window.DFX.markAlertTriggered && window.DFX.markAlertTriggered(m.id); }
    catch {}

    const card = document.createElement('div');
    card.style.cssText =
      'pointer-events:auto;min-width:280px;max-width:min(460px,92vw);' +
      'background:#160406;border:1px solid #f50512;border-radius:14px;' +
      'box-shadow:0 18px 50px rgba(0,0,0,.55),0 0 22px rgba(245,5,18,.45);' +
      'padding:14px 16px;color:#fff;font:13px/1.4 system-ui,Segoe UI,sans-serif;' +
      'animation:alertPop .28s cubic-bezier(.2,.8,.3,1);';

    const label = m.symbol_name || m.symbol || 'Price';
    const level = (m.price != null) ? m.price : '';
    const hit = (m.triggered_price != null) ? ` (now ${m.triggered_price})` : '';
    card.innerHTML =
      `<div style="display:flex;align-items:center;gap:10px;">
         <span style="font-size:22px;animation:alertShake .9s ease-in-out infinite;">🔔</span>
         <div style="flex:1;min-width:0;">
           <div style="font-weight:800;letter-spacing:.2px;">${esc(label)} hit ${esc(level)}${esc(hit)}</div>
           ${m.description ? `<div style="opacity:.85;margin-top:2px;">${esc(m.description)}</div>` : ''}
         </div>
       </div>`;

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;';
    const dismiss = document.createElement('button');
    dismiss.textContent = 'Dismiss';
    dismiss.style.cssText =
      'background:#f50512;color:#fff;border:0;border-radius:8px;padding:7px 14px;' +
      'font-weight:700;cursor:pointer;';
    dismiss.onclick = () => { stopAlarm(); card.remove(); };
    row.appendChild(dismiss);
    card.appendChild(row);

    ensureKeyframes();
    stackHost().appendChild(card);
    // Auto-fade the card after a while, but leave the alarm to the 25s cap.
    setTimeout(() => card.remove(), 60000);
  }

  const esc = (s) => String(s).replace(/[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function ensureKeyframes() {
    if (document.getElementById('alert-anim')) return;
    const st = document.createElement('style');
    st.id = 'alert-anim';
    st.textContent =
      '@keyframes alertPop{from{opacity:0;transform:translateY(-10px) scale(.96)}to{opacity:1}}' +
      '@keyframes alertShake{0%,100%{transform:rotate(0)}20%{transform:rotate(-16deg)}' +
      '40%{transform:rotate(12deg)}60%{transform:rotate(-8deg)}80%{transform:rotate(6deg)}}';
    document.head.appendChild(st);
  }

  // ── editor popover, opened from the chart's style bar ──────────────────────
  let editor = null;
  function closeEditor() { if (editor) { editor.remove(); editor = null; } }

  /** Open the set/remove-alert popover for a horizontal-line drawing.
   *  info: {price, symbol, symbolName, basePrice}; onSaved() re-renders + saves. */
  function openEditor(d, info, onSaved) {
    closeEditor();
    const has = !!d.alertId;
    const box = document.createElement('div');
    editor = box;
    box.style.cssText =
      'position:fixed;z-index:9998;left:50%;top:64px;transform:translateX(-50%);' +
      'width:300px;background:var(--panel,#0c0c0c);border:1px solid #2a2a2a;' +
      'border-radius:12px;box-shadow:0 20px 50px rgba(0,0,0,.6);padding:14px;' +
      'color:#eee;font:13px/1.45 system-ui,Segoe UI,sans-serif;';
    box.innerHTML =
      `<div style="display:flex;align-items:center;gap:8px;font-weight:700;margin-bottom:8px;">
         🔔 <span>${has ? 'Alert on this line' : 'Add alert on this line'}</span>
       </div>
       <div style="opacity:.7;font-size:12px;margin-bottom:10px;">
         ${esc(info.symbolName || info.symbol)} @ <b>${esc(info.price)}</b>
       </div>`;

    const ta = document.createElement('textarea');
    ta.placeholder = 'Description (optional) — e.g. “H4 supply, watch for rejection”';
    ta.value = d.alertNote || '';
    ta.rows = 2;
    ta.maxLength = 280;
    ta.style.cssText =
      'width:100%;resize:vertical;background:#111;border:1px solid #2a2a2a;border-radius:8px;' +
      'color:#eee;padding:8px;font:12px system-ui;outline:none;box-sizing:border-box;';
    box.appendChild(ta);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;margin-top:12px;';
    const primary = document.createElement('button');
    primary.textContent = has ? 'Update' : 'Set alert';
    primary.style.cssText =
      'flex:1;background:#f50512;color:#fff;border:0;border-radius:8px;padding:8px;' +
      'font-weight:700;cursor:pointer;';
    primary.onclick = async () => {
      primary.disabled = true; primary.textContent = 'Saving…';
      try {
        if (has) await deleteAlert(d.alertId);         // replace: simplest correct update
        const res = await createAlert({
          symbol: info.symbol, symbol_name: info.symbolName,
          price: info.price, base_price: info.basePrice,
          description: ta.value.trim(), client_id: d.alertId ? String(d.alertId) : '',
        });
        d.alertId = res && res.id;
        d.alertNote = ta.value.trim();
        onSaved && onSaved();
        closeEditor();
      } catch (e) {
        primary.disabled = false; primary.textContent = 'Retry';
        note.textContent = (e && e.message) || 'Could not save alert';
      }
    };
    row.appendChild(primary);

    if (has) {
      const rm = document.createElement('button');
      rm.textContent = 'Remove';
      rm.style.cssText =
        'background:#1a1a1a;color:#eee;border:1px solid #2a2a2a;border-radius:8px;' +
        'padding:8px 12px;font-weight:600;cursor:pointer;';
      rm.onclick = async () => {
        rm.disabled = true; rm.textContent = '…';
        try { await deleteAlert(d.alertId); } catch {}
        d.alertId = null; d.alertNote = '';
        onSaved && onSaved();
        closeEditor();
      };
      row.appendChild(rm);
    }
    box.appendChild(row);

    const note = document.createElement('div');
    note.style.cssText = 'color:#ff6b6b;font-size:11px;min-height:1em;margin-top:8px;';
    box.appendChild(note);

    document.body.appendChild(box);
    setTimeout(() => ta.focus(), 30);
    // Close on outside click / Escape.
    setTimeout(() => {
      const off = (ev) => {
        if (!box.contains(ev.target)) { closeEditor(); document.removeEventListener('pointerdown', off, true); }
      };
      document.addEventListener('pointerdown', off, true);
    }, 0);
  }

  function createAlert(payload) { return D.alertsCreate(payload); }
  function deleteAlert(id) { return D.alertsDelete(id); }

  // ── public surface for chart.js ────────────────────────────────────────────
  window.ALERTS = {
    supported: true,
    openEditor,
    closeEditor,
    hasAlert: (d) => !!(d && d.alertId),
    /** Fire-and-forget delete when a line carrying an alert is deleted. */
    dropForDrawing(d) {
      if (d && d.alertId) { deleteAlert(d.alertId).catch(() => {}); d.alertId = null; }
    },
  };

  window.addEventListener('beforeunload', () => { A.ended = true; try { A.ws && A.ws.close(); } catch {} });
  connect();
})();
