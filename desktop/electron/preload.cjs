// Thin, safe bridge. The renderer talks to the local server over fetch and
// WebSocket; the only thing it needs from the shell is recolouring the native
// title-bar controls when the chart theme is toggled.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dfxDesktop', {
  platform: process.platform,
  setTitleBar: (theme) => ipcRenderer.send('set-titlebar', theme),
  newWindow: (name) => ipcRenderer.send('new-window', name),
  onNewWindowDialog: (cb) => ipcRenderer.on('open-new-window-dialog', () => cb()),
  reportSymbol: (ws, symbol) => ipcRenderer.send('ws-symbol', ws, symbol),
  // Who is signed in, and which backend this build talks to.
  session: () => ipcRenderer.invoke('auth-session'),

  // ── live analysis ────────────────────────────────────────────────────────
  // The live socket is opened by the page, so it needs a bearer token in the
  // URL. That is the one thing the renderer sees: main still owns the refresh
  // token and every REST call below. The page is first-party, loaded from
  // 127.0.0.1 with context isolation and no remote content, so the exposure is
  // the access token only, and only for a window already showing that session.
  liveToken: () => ipcRenderer.invoke('live-token'),
  liveStart: (opts) => ipcRenderer.invoke('live-start', opts),
  liveList: () => ipcRenderer.invoke('live-list'),
  liveEnd: (room) => ipcRenderer.invoke('live-end', room),
  liveOpen: (room, role, title) => ipcRenderer.send('live-open', room, role, title),

  // ── price alerts ─────────────────────────────────────────────────────────
  // REST goes through main (token refresh lives there); the trigger push comes
  // over the dashboard WebSocket, which the page opens itself with liveToken().
  alertsList: () => ipcRenderer.invoke('alerts-list'),
  alertsCreate: (payload) => ipcRenderer.invoke('alerts-create', payload),
  alertsDelete: (id) => ipcRenderer.invoke('alerts-delete', id),
  // Fire a native OS notification + flash the window when an alert triggers, so
  // it surfaces over whatever app is in front.
  alertNotify: (payload) => ipcRenderer.send('alert-notify', payload),
});
