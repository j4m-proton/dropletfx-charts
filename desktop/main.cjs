/* DropletFX Charts — desktop shell.
 *
 * The UI is served by the project's Python server, so this process owns that
 * server's whole lifecycle: pick a free port, spawn it, wait until the port
 * actually accepts a connection, point the window at it, and make sure the
 * child dies with the app (including on hard kills).
 */
const { app, BrowserWindow, shell, screen, ipcMain } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const net = require('net');
const fs = require('fs');

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
  const py = findPython();
  if (!py) throw new Error('No Python interpreter found. Install Python 3, or set DFX_PYTHON.');

  serverPort = await freePort();
  const args = [...py.prefix, 'server.py'];
  log('spawn', py.exe, args.join(' '), 'in', APP_DIR, 'port', serverPort);

  serverProc = spawn(py.exe, args, {
    cwd: APP_DIR,
    // DFX_MANAGED arms the server's stdin watchdog, so it exits with us even
    // if this process is force-killed and never runs its quit handlers.
    env: {
      ...process.env,
      DFX_PORT: String(serverPort),
      DFX_MANAGED: '1',
      PYTHONUNBUFFERED: '1',
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

async function createWindow() {
  const splash = createSplash();
  const started = Date.now();

  try {
    await startServer();
  } catch (err) {
    log('startup failed:', (err && err.message) || err);
    showFailure(splash, (err && err.message) || String(err));
    return;                         // splash stays up with the reason on it
  }

  // Clamp to the work area and centre, so the 264px trade panel is never
  // pushed off the edge of a smaller display.
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
    title: 'DropletFX Charts',
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

  let win;
  try {
    win = new BrowserWindow(opts);
  } catch (err) {
    log('overlay window failed, falling back to framed:', err && err.message);
    delete opts.titleBarStyle;
    delete opts.titleBarOverlay;
    win = new BrowserWindow(opts);
  }

  // Charts want room; open filling the work area rather than a fixed box.
  win.maximize();
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Several reveal triggers plus a hard timeout, so a failure in any one of
  // them can never strand the user on the splash.
  let revealed = false;
  const reveal = (why) => {
    if (revealed || win.isDestroyed()) return;
    revealed = true;
    log('reveal:', why);
    setTimeout(() => {
      try { if (!splash.isDestroyed()) splash.close(); } catch { /* ignore */ }
      if (!win.isDestroyed()) {
        win.show();
        win.focus();
        if (isDev) win.webContents.openDevTools({ mode: 'detach' });
      }
    }, Math.max(0, SPLASH_MIN_MS - (Date.now() - started)));
  };

  win.once('ready-to-show', () => reveal('ready-to-show'));
  win.webContents.once('did-finish-load', () => reveal('did-finish-load'));
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    log('did-fail-load', code, desc);
    reveal('did-fail-load');
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    log('render-process-gone', JSON.stringify(d));
    reveal('render-gone');
  });
  setTimeout(() => reveal('hard-timeout'), 12000);

  win.loadURL(`http://127.0.0.1:${serverPort}`)
     .catch((e) => log('loadURL error:', e && e.message));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
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
