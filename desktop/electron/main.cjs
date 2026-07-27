/* DropletFX Charts — desktop shell.
 *
 * The UI is served by the project's Python server, so this process owns that
 * server's whole lifecycle: pick a free port, spawn it, wait until the port
 * actually accepts a connection, point the window at it, and make sure the
 * child dies with the app (including on hard kills).
 */
const { app, BrowserWindow, Menu, shell, screen, ipcMain } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const net = require('net');
const fs = require('fs');

const auth = require('./auth.cjs');
const { googleConfigured, config, CONFIG_FILE } = require('./config.cjs');

const isDev = !!process.env.DFX_DEV;
const ICON = path.join(__dirname, '..', 'build', 'icon.ico');
const SPLASH_MIN_MS = 1200;     // don't flash the splash for a few frames
const SERVER_TIMEOUT_MS = 30000;

// Where server.py lives: the repo root in dev, the unpacked resources when built.
const APP_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.join(__dirname, '..', '..');

let serverProc = null;
let serverPort = 0;

// A GUI app has no console, so keep a log next to the app's user data.
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'dropletfx.log'), line); }
  catch { /* ignore */ }
}
process.on('uncaughtException', (e) => log('uncaughtException:', (e && e.stack) || e));

const OVERLAY = {
  dark: { color: '#0b0b0f', symbolColor: '#e6e8ef', height: 44 },
  light: { color: '#f2f3f4', symbolColor: '#15212d', height: 44 },
};

ipcMain.on('set-titlebar', (e, theme) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && win.setTitleBarOverlay) {
    try { win.setTitleBarOverlay(OVERLAY[theme] || OVERLAY.dark); } catch { /* unsupported */ }
  }
});

// ── python ──────────────────────────────────────────────────────────────────

/** First interpreter that actually runs and can import the server's deps. */
function findPython() {
  const candidates = process.platform === 'win32'
    ? [process.env.DFX_PYTHON, 'python', 'python3', 'py']
    : [process.env.DFX_PYTHON, 'python3', 'python'];
  for (const exe of candidates.filter(Boolean)) {
    const args = exe === 'py' ? ['-3', '-c', 'import sys; print(sys.version)']
                              : ['-c', 'import sys; print(sys.version)'];
    try {
      const r = spawnSync(exe, args, { encoding: 'utf8' });
      if (r.status === 0) {
        log('python:', exe, (r.stdout || '').trim().split('\n')[0]);
        return { exe, prefix: exe === 'py' ? ['-3'] : [] };
      }
    } catch { /* try the next one */ }
  }
  return null;
}

/** Try to bind a specific port; resolve true if it was free. */
function tryPort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

// Preferred fixed ports. The renderer's origin is http://127.0.0.1:<port>, and
// localStorage (saved drawings, symbol, settings) is scoped to that origin — so
// the port MUST stay the same across restarts or every launch looks blank.
// We keep a stable port; only if all are taken do we fall back to a random one,
// which is rare and the one case where old drawings won't reappear.
const PREFERRED_PORTS = [47653, 47654, 47655, 47656];

async function freePort() {
  for (const p of PREFERRED_PORTS) {
    if (await tryPort(p)) return p;
  }
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Resolve once the port accepts a TCP connection, or reject on timeout. */
function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect({ port, host: '127.0.0.1' });
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error(`server did not start in ${timeoutMs}ms`));
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

async function startServer() {
  serverPort = await freePort();

  // A shipped build carries a self-contained server.exe (Python + deps frozen
  // in), so an installed app needs nothing on the machine. In development we run
  // the .py directly so edits take effect without re-freezing.
  const frozen = path.join(APP_DIR, 'dfx-server.exe');
  let cmd, args;
  if (app.isPackaged && fs.existsSync(frozen)) {
    cmd = frozen;
    args = [];
  } else {
    const py = findPython();
    if (!py) throw new Error('No Python interpreter found. Install Python 3, or set DFX_PYTHON.');
    cmd = py.exe;
    args = [...py.prefix, 'server.py'];
  }
  log('spawn', cmd, args.join(' '), 'in', APP_DIR, 'port', serverPort);

  serverProc = spawn(cmd, args, {
    cwd: APP_DIR,
    // DFX_MANAGED arms the server's stdin watchdog, so it exits with us even
    // if this process is force-killed and never runs its quit handlers.
    env: {
      ...process.env,
      DFX_PORT: String(serverPort),
      DFX_MANAGED: '1',
      PYTHONUNBUFFERED: '1',
      // Writable per-user folder for persisted drawings, so they survive
      // reinstalls and don't depend on the app dir being writable.
      DFX_DATA: app.getPath('userData'),
    },
    windowsHide: true,
  });
  serverProc.stdout.on('data', (d) => log('server:', String(d).trim()));
  serverProc.stderr.on('data', (d) => log('server!', String(d).trim()));
  serverProc.on('exit', (code, sig) => log('server exited', code, sig));

  await waitForPort(serverPort, SERVER_TIMEOUT_MS);
  log('server ready on', serverPort);
}

function stopServer() {
  if (!serverProc || serverProc.killed) return;
  log('stopping server');
  try {
    if (process.platform === 'win32') {
      // The child spawns uvicorn workers; /T takes the whole tree.
      spawnSync('taskkill', ['/pid', String(serverProc.pid), '/f', '/t']);
    } else {
      serverProc.kill('SIGTERM');
    }
  } catch (e) { log('stopServer failed:', e && e.message); }
  serverProc = null;
}

// ── workspaces ───────────────────────────────────────────────────────────────
// Each window is a named "workspace" with its own drawings and settings, kept
// apart on disk so two windows never overwrite each other.  The registry below
// remembers which windows were open (and their names/bounds) so a relaunch
// brings them all back exactly as they were — data is never dropped.

const REGISTRY_FILE = () => path.join(app.getPath('userData'), 'workspaces.json');
const winByWs = new Map();          // workspace id -> BrowserWindow

function loadRegistry() {
  try {
    const r = JSON.parse(fs.readFileSync(REGISTRY_FILE(), 'utf8'));
    if (r && typeof r === 'object') {
      r.counter = r.counter || 0;
      r.open = Array.isArray(r.open) ? r.open : [];
      r.windows = r.windows && typeof r.windows === 'object' ? r.windows : {};
      return r;
    }
  } catch { /* first run or unreadable */ }
  return { counter: 0, open: [], windows: {} };
}

function saveRegistry(reg) {
  try {
    fs.writeFileSync(REGISTRY_FILE(), JSON.stringify(reg, null, 2));
  } catch (e) { log('saveRegistry failed:', e && e.message); }
}

/** Record a workspace's current bounds, so it reopens where it was left. */
function rememberBounds(wsId) {
  const win = winByWs.get(wsId);
  if (!win || win.isDestroyed()) return;
  const reg = loadRegistry();
  if (reg.windows[wsId]) {
    reg.windows[wsId].bounds = win.getNormalBounds();
    saveRegistry(reg);
  }
}

// ── windows ─────────────────────────────────────────────────────────────────

function createSplash() {
  const { width, height } = screen.getPrimaryDisplay().bounds;
  const splash = new BrowserWindow({
    x: 0, y: 0, width, height,
    frame: false, resizable: false, movable: false,
    skipTaskbar: true, alwaysOnTop: true,
    backgroundColor: '#000000', icon: ICON, show: false,
    webPreferences: { contextIsolation: true },
  });
  splash.loadFile(path.join(__dirname, 'splash.html'));
  splash.once('ready-to-show', () => splash.show());
  return splash;
}

/** Show the failure on the splash instead of dying to a blank screen. */
function showFailure(splash, message) {
  if (!splash || splash.isDestroyed()) return;
  const js = `document.body.setAttribute('data-error', ${JSON.stringify(String(message))})`;
  splash.webContents.executeJavaScript(js).catch(() => {});
}

/** Open a chart window bound to a workspace {id, name, bounds?}.
 *  `splash` is only passed for the very first window during startup. */
function openChartWindow(ws, splash) {
  const started = Date.now();
  const work = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1440, work.width);
  const height = Math.min(900, work.height);

  const opts = {
    width, height,
    x: Math.max(0, Math.round((work.width - width) / 2)),
    y: Math.max(0, Math.round((work.height - height) / 2)),
    minWidth: Math.min(1040, work.width),
    minHeight: Math.min(640, work.height),
    backgroundColor: '#000000',
    title: ws.name ? `DropletFX — ${ws.name}` : 'DropletFX Charts',
    icon: ICON,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: OVERLAY.dark,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  };
  // Restore this workspace's last position/size if we have it.
  if (ws.bounds && Number.isFinite(ws.bounds.width)) Object.assign(opts, ws.bounds);

  let win;
  try {
    win = new BrowserWindow(opts);
  } catch (err) {
    log('overlay window failed, falling back to framed:', err && err.message);
    delete opts.titleBarStyle;
    delete opts.titleBarOverlay;
    win = new BrowserWindow(opts);
  }
  winByWs.set(ws.id, win);
  if (!ws.bounds) win.maximize();      // first-ever open fills the screen
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  let revealed = false;
  const reveal = (why) => {
    if (revealed || win.isDestroyed()) return;
    revealed = true;
    log('reveal:', ws.id, why);
    setTimeout(() => {
      try { if (splash && !splash.isDestroyed()) splash.close(); } catch { /* ignore */ }
      if (!win.isDestroyed()) {
        win.show();
        win.focus();
        if (isDev) win.webContents.openDevTools({ mode: 'detach' });
      }
    }, splash ? Math.max(0, SPLASH_MIN_MS - (Date.now() - started)) : 0);
  };
  win.once('ready-to-show', () => reveal('ready-to-show'));
  win.webContents.once('did-finish-load', () => reveal('did-finish-load'));
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    log('did-fail-load', code, desc); reveal('did-fail-load');
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    log('render-process-gone', JSON.stringify(d)); reveal('render-gone');
  });
  setTimeout(() => reveal('hard-timeout'), 12000);

  // Keep the registry's bounds current as the user moves/resizes.
  const saveBounds = () => rememberBounds(ws.id);
  win.on('moved', saveBounds);
  win.on('resize', saveBounds);
  win.on('close', () => {
    rememberBounds(ws.id);
    const reg = loadRegistry();
    reg.open = reg.open.filter((id) => id !== ws.id);   // don't reopen next time
    saveRegistry(reg);                                   // but keep its data + name
    winByWs.delete(ws.id);
  });

  const q = `?ws=${encodeURIComponent(ws.id)}&name=${encodeURIComponent(ws.name || '')}`
          + (ws.extraQuery || '');
  win.loadURL(`http://127.0.0.1:${serverPort}/${q}`)
     .catch((e) => log('loadURL error:', e && e.message));
  return win;
}

/** Create a brand-new named workspace and open it. */
function newWorkspace(name) {
  const reg = loadRegistry();
  reg.counter = (reg.counter || 0) + 1;
  const id = `ws-${Date.now().toString(36)}-${reg.counter}`;
  const label = String(name || '').trim() || `Window ${reg.counter + 1}`;
  reg.windows[id] = { name: label };
  if (!reg.open.includes(id)) reg.open.push(id);
  saveRegistry(reg);
  openChartWindow({ id, name: label });
}

/** Open a set of existing workspaces by id (used by the launcher). */
function launchWorkspaces(ids) {
  const reg = loadRegistry();
  let first = true;
  for (const id of ids) {
    const meta = reg.windows[id];
    if (!meta) continue;
    if (winByWs.has(id)) {                     // already open — just focus it
      const w = winByWs.get(id);
      if (w && !w.isDestroyed()) w.focus();
      continue;
    }
    if (!reg.open.includes(id)) reg.open.push(id);
    openChartWindow({ id, name: meta.name, bounds: meta.bounds }, null);
    first = false;
  }
  saveRegistry(reg);
  return !first;
}

// ── login ───────────────────────────────────────────────────────────────────
// The app is a client of the DropletFX backend, so it needs an identity before
// it can show anything account-bound (live sessions, subscriptions). Charting
// itself is local, but we gate at the door to keep one clear entry path.

let loginWin = null;

function createLogin() {
  loginWin = new BrowserWindow({
    width: 560, height: 680, minWidth: 460, minHeight: 600,
    resizable: false, maximizable: false, fullscreenable: false,
    backgroundColor: '#000000', title: 'DropletFX', icon: ICON,
    autoHideMenuBar: true, frame: false, show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'login-preload.cjs'),
    },
  });
  loginWin.setMenuBarVisibility(false);
  loginWin.loadFile(path.join(__dirname, 'login.html'));
  loginWin.once('ready-to-show', () => loginWin.show());
  loginWin.on('closed', () => {
    const wasCurrent = loginWin;
    loginWin = null;
    // Closing the login window without signing in ends the app rather than
    // leaving a headless server running behind no window.
    if (wasCurrent && !launcherWin && !winByWs.size) app.quit();
  });
  return loginWin;
}

function closeLogin() {
  if (loginWin && !loginWin.isDestroyed()) {
    const w = loginWin;
    loginWin = null;                 // cleared first so 'closed' won't quit us
    w.close();
  }
}

ipcMain.handle('auth-session', () => auth.publicSession());
ipcMain.handle('auth-configured', () => googleConfigured());
ipcMain.on('auth-quit', () => app.quit());

/** Hand over from the login window to the launcher once a session exists. */
function enterApp() {
  // Give the success state a beat to paint before swapping windows.
  setTimeout(() => { closeLogin(); createLauncher(); }, 600);
}

ipcMain.handle('auth-sign-in', async () => {
  const user = await auth.signIn();       // rejection propagates to the renderer
  enterApp();
  return user;
});

ipcMain.handle('auth-password-sign-in', async (_e, email, password) => {
  const user = await auth.signInWithPassword(email, password);
  enterApp();
  return user;
});

// Account creation and password resets stay on the website, which already owns
// those flows (and their emails) — open them in the real browser.
ipcMain.on('auth-open-web', (_e, pathname) => {
  const safe = typeof pathname === 'string' && pathname.startsWith('/') ? pathname : '/';
  shell.openExternal(`${config().apiBase}${safe}`);
});

/** Show config.json in the file manager, creating a commented stub if absent,
 *  so "edit config.json" isn't a hunt through AppData. */
ipcMain.on('auth-reveal-config', () => {
  const file = CONFIG_FILE();
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify({
        apiBase: config().apiBase,
        googleClientSecret: '',
      }, null, 2) + '\n');
    }
    shell.showItemInFolder(file);
  } catch (e) { log('reveal config failed:', e && e.message); }
});

ipcMain.handle('auth-sign-out', () => {
  auth.signOut();
  for (const [id, win] of winByWs) {       // no window may outlive the session
    if (win && !win.isDestroyed()) win.destroy();
    winByWs.delete(id);
  }
  closeLauncher();
  createLogin();
  return true;
});

/** First launch: start the server, then reopen every window that was open. */
// ── launcher ────────────────────────────────────────────────────────────────

let launcherWin = null;

function createLauncher() {
  launcherWin = new BrowserWindow({
    width: 900, height: 700, minWidth: 720, minHeight: 560,
    resizable: true, maximizable: false, fullscreenable: false,
    backgroundColor: '#000000', title: 'DropletFX', icon: ICON,
    autoHideMenuBar: true, show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'launcher-preload.cjs'),
    },
  });
  launcherWin.setMenuBarVisibility(false);
  launcherWin.loadFile(path.join(__dirname, 'launcher.html'));
  launcherWin.once('ready-to-show', () => launcherWin.show());
  launcherWin.on('closed', () => {
    const wasCurrent = launcherWin;
    launcherWin = null;
    // Dismissing the launcher without opening anything ends the app, rather
    // than leaving a headless server running with no window attached.
    if (wasCurrent && !winByWs.size) app.quit();
  });
  return launcherWin;
}

/** Close the launcher deliberately (we opened windows), without quitting. */
function closeLauncher() {
  if (launcherWin && !launcherWin.isDestroyed()) {
    const w = launcherWin;
    launcherWin = null;            // cleared first so 'closed' won't quit us
    w.close();
  }
}

function workspaceList() {
  const reg = loadRegistry();
  return Object.entries(reg.windows).map(([id, meta]) => ({
    id,
    name: (meta && meta.name) || id,
    lastSymbol: (meta && meta.lastSymbol) || '',
    checked: reg.open.includes(id),
  }));
}

ipcMain.handle('ws-list', () => workspaceList());
ipcMain.handle('ws-session', () => auth.publicSession());

/** Drop a workspace's drawings from the server's data file. */
function purgeDrawings(wsId) {
  const file = path.join(app.getPath('userData'), 'drawings.json');
  try {
    const store = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (store && typeof store === 'object' && wsId in store) {
      delete store[wsId];
      fs.writeFileSync(file, JSON.stringify(store));
    }
  } catch { /* no file yet, or unreadable — nothing to purge */ }
}

ipcMain.handle('ws-delete', (_e, id) => {
  if (id) {
    const win = winByWs.get(id);          // close it first if somehow open
    if (win && !win.isDestroyed()) win.destroy();
    winByWs.delete(id);
    const reg = loadRegistry();
    delete reg.windows[id];
    reg.open = reg.open.filter((x) => x !== id);
    saveRegistry(reg);
    purgeDrawings(id);
    log('deleted workspace', id);
  }
  return workspaceList();
});

ipcMain.on('ws-launch', (_e, ids) => {
  if (Array.isArray(ids) && ids.length) {
    launchWorkspaces(ids);
    closeLauncher();
  }
});

ipcMain.on('ws-create', (_e, name) => {
  newWorkspace(name);
  closeLauncher();
});

// ── live analysis ───────────────────────────────────────────────────────────
// A live session is just a chart window with ?live=<room>&role=… on the URL,
// so it inherits the whole workspace machinery — its own drawings file, its own
// saved settings, its own entry in the launcher. That is what lets a viewer
// keep the window, and everything drawn in it, after the session ends.

/** Open (or focus) the window for a live session. */
function openLiveWindow(room, role, title) {
  const id = `live-${room}`;
  const reg = loadRegistry();
  const name = title || (role === 'host' ? 'Live — hosting' : 'Live');

  if (winByWs.has(id)) {
    const w = winByWs.get(id);
    if (w && !w.isDestroyed()) { w.focus(); return w; }
    winByWs.delete(id);
  }

  reg.windows[id] = { ...(reg.windows[id] || {}), name };
  if (!reg.open.includes(id)) reg.open.push(id);
  saveRegistry(reg);

  const extra = `&live=${encodeURIComponent(room)}&role=${role === 'host' ? 'host' : 'viewer'}`;
  return openChartWindow({ id, name, bounds: reg.windows[id].bounds, extraQuery: extra });
}

ipcMain.on('live-open', (_e, room, role, title) => {
  if (room) openLiveWindow(String(room), role, title);
});

ipcMain.handle('live-token', () => auth.accessTokenForSocket());

/** Thin pass-throughs so the renderer never needs a token for REST. */
async function liveApi(pathname, opts) {
  try {
    const res = await auth.authFetch(pathname, opts);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  } catch (e) {
    throw new Error((e && e.message) || 'Live request failed');
  }
}

ipcMain.handle('live-start', (_e, opts) =>
  liveApi('/api/live/start/', { method: 'POST', body: JSON.stringify(opts || {}) }));

ipcMain.handle('live-list', () => liveApi('/api/live/'));

ipcMain.handle('live-end', (_e, room) =>
  liveApi(`/api/live/${encodeURIComponent(room)}/`, { method: 'DELETE' }));

// ── price alerts (same authenticated pass-through as live) ──────────────────
ipcMain.handle('alerts-list', () => liveApi('/api/alerts/'));

ipcMain.handle('alerts-create', (_e, payload) =>
  liveApi('/api/alerts/', { method: 'POST', body: JSON.stringify(payload || {}) }));

ipcMain.handle('alerts-delete', (_e, id) =>
  liveApi(`/api/alerts/${encodeURIComponent(id)}/`, { method: 'DELETE' }));

/** Startup: splash while the server boots, then login or the launcher. */
async function boot() {
  const splash = createSplash();
  try {
    await startServer();
  } catch (err) {
    log('startup failed:', (err && err.message) || err);
    showFailure(splash, (err && err.message) || String(err));
    return;
  }

  const reg = loadRegistry();
  if (!Object.keys(reg.windows).length) {     // very first run — seed "Main"
    reg.windows.main = { name: 'Main' };
    reg.open = ['main'];
    saveRegistry(reg);
  }

  // Revalidate any stored session while the splash is still up, so a returning
  // user goes straight to their windows. This is offline-tolerant: only an
  // outright rejection from the server clears the session.
  let user = null;
  try { user = await auth.restore(); }
  catch (e) { log('session restore failed:', e && e.message); }
  log('startup session:', user ? user.email : 'signed out');

  setTimeout(() => {
    try { if (!splash.isDestroyed()) splash.close(); } catch { /* ignore */ }
    if (auth.isSignedIn()) createLauncher();
    else createLogin();
  }, Math.max(0, SPLASH_MIN_MS - 200));
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => promptNewWindow() },
        { type: 'separator' },
        { role: 'close' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Let the renderer request a new window (e.g. the "+" button in the UI).
ipcMain.on('new-window', (_e, name) => newWorkspace(name));

// Remember what each window was showing, so the launcher can label it.
ipcMain.on('ws-symbol', (_e, wsId, symbol) => {
  if (!wsId || !symbol) return;
  const reg = loadRegistry();
  if (reg.windows[wsId] && reg.windows[wsId].lastSymbol !== symbol) {
    reg.windows[wsId].lastSymbol = String(symbol).slice(0, 40);
    saveRegistry(reg);
  }
});

/** Ask the focused chart window to show its "name this window" dialog. */
function promptNewWindow() {
  const win = BrowserWindow.getFocusedWindow();
  if (win && !win.isDestroyed() && win !== launcherWin) {
    win.webContents.send('open-new-window-dialog');
  } else {
    newWorkspace();                 // no chart window to ask — just make one
  }
}

/** Camera/mic for the live avatar. Electron denies media by default, and a
 *  blanket allow would also cover any page the window ever loads — so this
 *  grants only media, and only to our own local origin. */
function allowCameraForOurPages() {
  const ses = require('electron').session.defaultSession;
  const ours = (url) => {
    try { return new URL(url).hostname === '127.0.0.1'; } catch { return false; }
  };
  ses.setPermissionRequestHandler((contents, permission, done, details) => {
    const url = (details && details.requestingUrl) || (contents && contents.getURL()) || '';
    done(['media', 'audioCapture', 'videoCapture'].includes(permission) && ours(url));
  });
  ses.setPermissionCheckHandler((_c, permission, origin) =>
    ['media', 'audioCapture', 'videoCapture'].includes(permission) && ours(origin));
}

app.whenReady().then(() => {
  buildMenu();
  allowCameraForOurPages();
  boot();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) boot();
  });
});

// The Python child must not outlive the app under any exit path.
app.on('before-quit', stopServer);
app.on('will-quit', stopServer);
process.on('exit', stopServer);

app.on('window-all-closed', () => {
  stopServer();
  if (process.platform !== 'darwin') app.quit();
});
