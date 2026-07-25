/* Live analysis — broadcasting a chart, and watching one.
 *
 * What crosses the wire is chart *state*, not pixels: drawings are already
 * stored in (epoch, price) data coordinates, so every viewer re-renders them
 * against their own candles at their own window size and zoom. That is why a
 * viewer keeps real, editable drawings when the session ends — they were never
 * a picture of someone else's screen.
 *
 * The host broadcasts a whole snapshot rather than per-drawing deltas. Drawings
 * are a small JSON array, `saveDrawings()` is already the single choke point
 * for every mutation, and a full replace can't drift out of order or lose an
 * op — a late joiner and a live viewer take the identical code path.
 *
 * The camera is peer-to-peer WebRTC; the socket only carries the handshake, so
 * video never touches the server.
 */
(() => {
  'use strict';

  const P = new URLSearchParams(location.search);
  const ROOM = P.get('live') || '';
  const ROLE = P.get('role') === 'host' ? 'host' : 'viewer';
  if (!ROOM) return;                       // an ordinary chart window

  const IS_HOST = ROLE === 'host';
  const RETRY_MS = [1000, 2000, 4000, 8000, 15000];

  const L = {
    ws: null,
    open: false,
    ended: false,
    attempt: 0,
    viewers: 0,
    peers: new Map(),        // peer id -> RTCPeerConnection (host side)
    stream: null,            // host's camera
    pc: null,                // viewer's single connection to the host
    myPeer: null,
    session: null,
    suppress: false,         // true while applying a remote snapshot
  };

  // ── UI ────────────────────────────────────────────────────────────────────

  const el = (id) => document.getElementById(id);

  function setBanner(text, tone) {
    const b = el('live-banner');
    if (!b) return;
    b.hidden = false;
    el('live-text').textContent = text;
    b.dataset.tone = tone || 'live';
  }

  function setViewers(n) {
    L.viewers = n;
    const v = el('live-viewers');
    if (v) v.textContent = n === 1 ? '1 watching' : `${n} watching`;
  }

  function flash(msg) {
    const t = el('live-toast');
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(flash._t);
    flash._t = setTimeout(() => { t.hidden = true; }, 2600);
  }

  // ── socket ────────────────────────────────────────────────────────────────

  function retry(why) {
    if (L.ended) return;
    const wait = RETRY_MS[Math.min(L.attempt++, RETRY_MS.length - 1)];
    setBanner(why, 'warn');
    setTimeout(connect, wait);
  }

  async function connect() {
    if (L.ended) return;

    // The shell supplies both the backend URL and the bearer for the socket.
    // If it isn't ready yet, keep retrying rather than stranding the window on
    // an error it can't recover from.
    let token = '', base = '';
    try {
      const d = window.dfxDesktop;
      token = (await d.liveToken()) || '';
      const s = await d.session();
      base = (s && s.apiBase) || '';
    } catch { /* retried below */ }
    if (!base) { retry('Waiting for DropletFX…'); return; }

    const url = base.replace(/^http/, 'ws')
      + `/ws/live/${encodeURIComponent(ROOM)}/?token=${encodeURIComponent(token)}`;

    const ws = new WebSocket(url);
    L.ws = ws;

    ws.onopen = () => {
      L.open = true;
      L.attempt = 0;
      setBanner(IS_HOST ? 'You are live' : 'Live', 'live');
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handle(msg);
    };

    ws.onclose = (e) => {
      L.open = false;
      if (L.ended) return;
      // Codes the consumer uses deliberately; retrying them is pointless.
      const fatal = {
        4001: 'Your session expired — sign in again',
        4003: 'This live session is not open to you',
        4004: 'That live session has ended',
      };
      if (fatal[e.code]) { endLocally(fatal[e.code]); return; }
      retry('Reconnecting…');
    };

    ws.onerror = () => { /* onclose always follows; handled there */ };
  }

  function send(obj) {
    if (L.ws && L.open) {
      try { L.ws.send(JSON.stringify(obj)); } catch { /* closing */ }
    }
  }

  // ── inbound ───────────────────────────────────────────────────────────────

  function handle(msg) {
    switch (msg.op) {
      case 'hello':
        L.session = msg.session;
        L.myPeer = msg.peer;
        if (IS_HOST) {
          // The stored session row can be stale — the host may have changed
          // symbol or timeframe while disconnected, or since it was created.
          // Assert the real chart state so viewers follow the host, never the
          // database.
          send({ op: 'symbol', value: S.symbol });
          send({ op: 'timeframe', value: S.granularity });
          send({ op: 'snapshot', drawings: S.drawings });
          startCameraIfWanted();
        } else {
          applySessionChart(msg.session);
        }
        setBanner(IS_HOST ? 'You are live'
                          : `Live — ${msg.session.trader || 'trader'}`, 'live');
        break;

      case 'snapshot':
        if (!IS_HOST) applySnapshot(msg);
        break;

      case 'symbol':
        if (!IS_HOST) remoteSymbol(msg.value);
        break;

      case 'timeframe':
        if (!IS_HOST) remoteTimeframe(msg.value);
        break;

      case 'viewers':
        setViewers(msg.count || 0);
        break;

      case 'end':
        endLocally(IS_HOST ? 'Live ended' : 'The trader ended the session');
        break;

      case 'denied':
        // Server refused a draw op. The UI should already prevent this, so if
        // it happens the local state has drifted — put it back to read-only.
        if (!IS_HOST) { setReadOnly(true); flash('This chart is read-only during the live'); }
        break;

      case 'peer-joined':
        if (IS_HOST) offerTo(msg.peer);
        break;

      case 'peer-left':
        if (IS_HOST) dropPeer(msg.peer);
        break;

      case 'rtc':
        onSignal(msg.from, msg.data);
        break;
    }
  }

  // ── chart state ───────────────────────────────────────────────────────────

  function applySessionChart(sess) {
    if (!sess) return;
    if (sess.symbol && sess.symbol !== S.symbol) remoteSymbol(sess.symbol);
    if (sess.granularity && sess.granularity !== S.granularity) remoteTimeframe(sess.granularity);
  }

  function applySnapshot(msg) {
    const list = Array.isArray(msg.drawings) ? msg.drawings : [];
    L.suppress = true;
    try {
      S.drawings = list;
      S.selected = null;
      S.draft = null;
      if (typeof saveDrawings === 'function') saveDrawings();   // persist locally
      draw();
    } finally {
      L.suppress = false;
    }
  }

  function remoteSymbol(sym) {
    if (!sym || sym === S.symbol) return;
    const sel = el('symbol');
    if (sel) {
      sel.value = sym;
      sel.dispatchEvent(new Event('change'));
    }
  }

  function remoteTimeframe(g) {
    g = Number(g);
    if (!g || g === S.granularity) return;
    const sel = el('timeframes');
    if (sel) {
      sel.value = String(g);
      sel.dispatchEvent(new Event('change'));
    }
  }

  // ── read-only ─────────────────────────────────────────────────────────────

  function setReadOnly(on) {
    S.readOnly = !!on;
    document.body.classList.toggle('live-readonly', !!on);
    if (on && typeof setTool === 'function') setTool('cursor');
  }

  // ── outbound (host) ───────────────────────────────────────────────────────

  let pushTimer = null;

  function pushSnapshot() {
    if (!IS_HOST) return;
    clearTimeout(pushTimer);
    // Coalesce a drag into one send; the payload is a full replace so only the
    // last one matters.
    pushTimer = setTimeout(() => {
      send({ op: 'snapshot', drawings: S.drawings });
    }, 180);
  }

  // ── WebRTC: the host's camera ─────────────────────────────────────────────
  //
  // A mesh: the host opens one peer connection per viewer. Fine for a normal
  // room; past roughly a dozen viewers the host's uplink is the ceiling and an
  // SFU has to sit in the middle. Signalling is already addressed per-peer, so
  // that swap wouldn't disturb any of the chart-sync code above.

  const RTC_CONFIG = {
    iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
  };

  async function startCameraIfWanted() {
    if (!IS_HOST || L.stream) return;
    const btn = el('live-camera');
    if (btn) btn.hidden = false;
  }

  async function enableCamera() {
    if (L.stream) return true;
    try {
      L.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
        audio: true,
      });
    } catch (e) {
      flash(e && e.name === 'NotAllowedError'
        ? 'Camera permission denied'
        : 'No camera available');
      return false;
    }
    showSelfView(L.stream);
    send({ op: 'camera', value: true });
    // Anyone already watching needs a fresh offer carrying the tracks.
    for (const peer of L.peers.keys()) offerTo(peer, true);
    return true;
  }

  function disableCamera() {
    if (L.stream) {
      L.stream.getTracks().forEach((t) => t.stop());
      L.stream = null;
    }
    hideVideo();
    send({ op: 'camera', value: false });
    for (const [, pc] of L.peers) { try { pc.close(); } catch { /* gone */ } }
    L.peers.clear();
  }

  async function offerTo(peer, renegotiate) {
    if (!L.stream) return;                 // nothing to send yet
    let pc = L.peers.get(peer);
    if (pc && !renegotiate) return;
    if (pc) { try { pc.close(); } catch { /* gone */ } }

    pc = new RTCPeerConnection(RTC_CONFIG);
    L.peers.set(peer, pc);
    L.stream.getTracks().forEach((t) => pc.addTrack(t, L.stream));
    pc.onicecandidate = (e) => {
      if (e.candidate) send({ op: 'rtc', to: peer, data: { candidate: e.candidate } });
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) dropPeer(peer);
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ op: 'rtc', to: peer, data: { sdp: pc.localDescription } });
  }

  function dropPeer(peer) {
    const pc = L.peers.get(peer);
    if (pc) { try { pc.close(); } catch { /* gone */ } }
    L.peers.delete(peer);
  }

  async function onSignal(from, data) {
    if (!data) return;
    if (IS_HOST) {
      const pc = L.peers.get(from);
      if (!pc) return;
      if (data.sdp && data.sdp.type === 'answer') {
        await pc.setRemoteDescription(data.sdp);
      } else if (data.candidate) {
        try { await pc.addIceCandidate(data.candidate); } catch { /* raced */ }
      }
      return;
    }
    // Viewer: one connection, always to the host.
    if (data.sdp && data.sdp.type === 'offer') {
      if (L.pc) { try { L.pc.close(); } catch { /* gone */ } }
      const pc = new RTCPeerConnection(RTC_CONFIG);
      L.pc = pc;
      pc.ontrack = (e) => showVideo(e.streams[0]);
      pc.onicecandidate = (e) => {
        if (e.candidate) send({ op: 'rtc', data: { candidate: e.candidate } });
      };
      await pc.setRemoteDescription(data.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ op: 'rtc', data: { sdp: pc.localDescription } });
    } else if (data.candidate && L.pc) {
      try { await L.pc.addIceCandidate(data.candidate); } catch { /* raced */ }
    }
  }

  // ── video element ─────────────────────────────────────────────────────────

  function videoEl() {
    let v = el('live-video');
    if (!v) return null;
    return v;
  }

  function showVideo(stream) {
    const v = videoEl();
    if (!v) return;
    v.srcObject = stream;
    v.muted = false;
    const box = el('live-cam');
    if (box) box.hidden = false;
    v.play().catch(() => { /* autoplay policy — the user can click it */ });
  }

  function showSelfView(stream) {
    const v = videoEl();
    if (!v) return;
    v.srcObject = stream;
    v.muted = true;                  // never echo your own microphone
    const box = el('live-cam');
    if (box) box.hidden = false;
    v.play().catch(() => {});
  }

  function hideVideo() {
    const v = videoEl();
    if (v) v.srcObject = null;
    const box = el('live-cam');
    if (box) box.hidden = true;
  }

  // ── ending ────────────────────────────────────────────────────────────────

  function endLocally(reason) {
    L.ended = true;
    try { if (L.ws) L.ws.close(); } catch { /* already gone */ }
    for (const [, pc] of L.peers) { try { pc.close(); } catch { /* gone */ } }
    L.peers.clear();
    if (L.pc) { try { L.pc.close(); } catch { /* gone */ } }
    if (L.stream) { L.stream.getTracks().forEach((t) => t.stop()); L.stream = null; }
    hideVideo();

    // The window and its drawings stay. This is the whole point: a viewer keeps
    // what was drawn and can now edit or delete it like any other chart.
    setReadOnly(false);
    setBanner(reason + ' — this window is yours to edit now', 'ended');
    const cam = el('live-camera');
    if (cam) cam.hidden = true;
    const stop = el('live-stop');
    if (stop) stop.hidden = true;
    if (typeof saveDrawings === 'function') saveDrawings();
  }

  // ── wiring ────────────────────────────────────────────────────────────────

  function init() {
    setReadOnly(!IS_HOST);
    setBanner(IS_HOST ? 'Starting…' : 'Connecting…', 'warn');

    const cam = el('live-camera');
    if (cam) {
      cam.hidden = !IS_HOST;
      cam.onclick = async () => {
        if (L.stream) { disableCamera(); cam.dataset.on = ''; }
        else if (await enableCamera()) cam.dataset.on = '1';
      };
    }
    const stop = el('live-stop');
    if (stop) {
      stop.hidden = !IS_HOST;
      stop.onclick = () => {
        if (!confirm('End the live session for everyone?')) return;
        send({ op: 'end' });
        endLocally('Live ended');
      };
    }
    const leave = el('live-leave');
    if (leave) {
      leave.hidden = IS_HOST;
      leave.onclick = () => endLocally('You left the session');
    }

    window.addEventListener('pagehide', () => { try { if (L.ws) L.ws.close(); } catch {} });
    connect();
  }

  // Public surface chart.js calls into.
  window.LIVE = {
    active: true,
    isHost: IS_HOST,
    room: ROOM,
    /** Every drawing mutation funnels through saveDrawings(); mirror it. */
    onDrawings() { if (IS_HOST && !L.suppress) pushSnapshot(); },
    onSymbol(sym) {
      if (!IS_HOST) return;
      send({ op: 'symbol', value: sym });
      // Drawings are stored per symbol, so both sides have just swapped to
      // their *own* set for the new one. Re-broadcast, or the viewer would sit
      // looking at their own drawings until the host next draws.
      pushSnapshot();
    },
    onTimeframe(g) { if (IS_HOST) send({ op: 'timeframe', value: g }); },
    readOnly() { return !IS_HOST && !L.ended; },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
