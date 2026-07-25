/* Google sign-in for the desktop app, and the session it produces.
 *
 * We use the installed-app flow from RFC 8252: the system browser does the
 * OAuth, not an embedded window. That matters for two reasons — Google blocks
 * sign-in from embedded webviews outright, and the user gets to see the real
 * accounts.google.com address bar before typing a password.
 *
 *   1. spin up a throwaway HTTP listener on 127.0.0.1:<random>
 *   2. open the real browser at Google, with a PKCE challenge
 *   3. Google redirects back to the listener with an authorization code
 *   4. exchange the code (+ PKCE verifier) for an id_token
 *   5. hand the id_token to dropletfx, which verifies it server-side and
 *      returns our own JWT pair — the same GoogleAuthView the website uses
 *
 * The JWT pair is written to disk encrypted with the OS keystore (DPAPI on
 * Windows) so a stolen file is useless on another machine.
 */
const { app, shell, safeStorage } = require('electron');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const { config, api, googleConfigured } = require('./config.cjs');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SESSION_FILE = () => path.join(app.getPath('userData'), 'session.dat');
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;      // give up if the browser never returns

let session = null;          // { user, access, refresh } once signed in
let pendingFlow = null;      // the in-flight sign-in, so we never run two

function log(...args) {
  const line = `[${new Date().toISOString()}] auth: ${args.join(' ')}\n`;
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'dropletfx.log'), line); }
  catch { /* logging must never break sign-in */ }
}

// ── session storage ─────────────────────────────────────────────────────────

function saveSession(next) {
  session = next;
  try {
    if (!next) { fs.rmSync(SESSION_FILE(), { force: true }); return; }
    const json = JSON.stringify(next);
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(SESSION_FILE(), safeStorage.encryptString(json));
    } else {
      // No OS keystore (some Linux desktops). Still persist, but say so —
      // silently downgrading the user's security without a trace is worse.
      log('WARNING: OS encryption unavailable, session stored unencrypted');
      fs.writeFileSync(SESSION_FILE(), JSON.stringify({ plain: json }), 'utf8');
    }
  } catch (e) {
    log('saveSession failed:', e && e.message);
  }
}

function loadSession() {
  try {
    const buf = fs.readFileSync(SESSION_FILE());
    // The unencrypted fallback is valid UTF-8 JSON with a `plain` key;
    // anything else is a DPAPI blob.
    try {
      const maybe = JSON.parse(buf.toString('utf8'));
      if (maybe && typeof maybe.plain === 'string') return JSON.parse(maybe.plain);
    } catch { /* not the fallback shape — decrypt below */ }
    return JSON.parse(safeStorage.decryptString(buf));
  } catch {
    return null;               // no session yet, or written by another machine
  }
}

// ── PKCE helpers ────────────────────────────────────────────────────────────

const b64url = (buf) => buf.toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// ── the page the browser lands on when Google redirects back ────────────────

function resultPage(title, message, ok) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
       background:#000;color:#e6e8ef;
       font:15px/1.5 ui-sans-serif,"Segoe UI",system-ui,sans-serif;text-align:center}
  .card{max-width:420px;padding:44px 40px;border:1px solid #1e1e24;border-radius:14px;
        background:#0b0b0f}
  .mark{width:46px;height:46px;border-radius:50%;margin:0 auto 20px;
        display:flex;align-items:center;justify-content:center;font-size:24px;
        background:${ok ? 'rgba(0,230,118,.12)' : 'rgba(245,5,18,.12)'};
        color:${ok ? '#00e676' : '#f50512'}}
  h1{font-size:17px;margin:0 0 10px;font-weight:600}
  p{margin:0;color:#8b8f9a;font-size:13.5px}
</style></head><body><div class="card">
  <div class="mark">${ok ? '&#10003;' : '!'}</div>
  <h1>${title}</h1><p>${message}</p>
</div></body></html>`;
}

// ── the flow ────────────────────────────────────────────────────────────────

/** Run the browser half: returns the authorization code and redirect_uri. */
function awaitAuthorizationCode(challenge, state) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Let the response flush before tearing the listener down.
      setTimeout(() => { try { server.close(); } catch { /* already closed */ } }, 250);
      fn(arg);
    };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }

      const err = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const gotState = url.searchParams.get('state');

      const reply = (title, msg, ok) => {
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(resultPage(title, msg, ok));
      };

      if (err) {
        reply('Sign-in cancelled', 'You can close this tab and try again.', false);
        finish(reject, new Error(err === 'access_denied' ? 'Sign-in was cancelled' : err));
        return;
      }
      // A mismatched state means this callback wasn't started by us.
      if (!code || gotState !== state) {
        reply('Sign-in failed', 'That response did not match this request.', false);
        finish(reject, new Error('Invalid OAuth callback'));
        return;
      }
      reply('You\'re signed in', 'Return to DropletFX Charts — this tab can be closed.', true);
      finish(resolve, { code, port: server.address().port });
    });

    const timer = setTimeout(
      () => finish(reject, new Error('Sign-in timed out')), FLOW_TIMEOUT_MS);

    server.on('error', (e) => finish(reject, new Error(
      e && e.code === 'EADDRINUSE'
        ? `Port ${config().loopbackPort} is busy — close whatever is using it and retry`
        : (e && e.message) || 'Could not open the sign-in listener')));
    // A fixed port, so the redirect URI is stable enough to register against a
    // "Web application" OAuth client. Desktop-type clients accept any loopback
    // port, so this suits both.
    server.listen(config().loopbackPort, '127.0.0.1', () => {
      const { port } = server.address();
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const params = new URLSearchParams({
        client_id: config().googleClientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        // Always let the user choose, so switching accounts doesn't require
        // clearing browser state.
        prompt: 'select_account',
      });
      log('opening browser for sign-in on port', port);
      shell.openExternal(`${AUTH_ENDPOINT}?${params}`).catch((e) => finish(reject, e));
    });
  });
}

/** Trade the authorization code for Google's id_token. */
async function exchangeCode(code, port, verifier) {
  const body = new URLSearchParams({
    code,
    client_id: config().googleClientId,
    client_secret: config().googleClientSecret,
    redirect_uri: `http://127.0.0.1:${port}/callback`,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id_token) {
    throw new Error(data.error_description || data.error || 'Google token exchange failed');
  }
  return data.id_token;
}

/** Swap Google's id_token for a dropletfx session. */
async function exchangeWithBackend(idToken) {
  let res;
  try {
    res = await fetch(api('/api/auth/google/'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id_token: idToken }),
    });
  } catch (e) {
    throw new Error(`Cannot reach DropletFX at ${config().apiBase}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Sign-in rejected (HTTP ${res.status})`);
  if (!data.access) throw new Error('Backend returned no access token');
  return { user: data.user, access: data.access, refresh: data.refresh };
}

/** Full sign-in. Resolves with the user, rejects with a message worth showing. */
function signIn() {
  if (pendingFlow) return pendingFlow;
  if (!googleConfigured()) {
    return Promise.reject(new Error(
      'No Google client configured. Set googleClientId in config.json or DFX_GOOGLE_CLIENT_ID.'));
  }

  const { verifier, challenge } = pkce();
  const state = b64url(crypto.randomBytes(16));

  pendingFlow = (async () => {
    const { code, port } = await awaitAuthorizationCode(challenge, state);
    const idToken = await exchangeCode(code, port, verifier);
    const next = await exchangeWithBackend(idToken);
    saveSession(next);
    log('signed in as', next.user && next.user.email);
    return next.user;
  })();

  pendingFlow.catch((e) => log('sign-in failed:', e && e.message))
             .finally(() => { pendingFlow = null; });
  return pendingFlow;
}

/** Email + password sign-in, the same LoginView the website posts to. */
async function signInWithPassword(email, password) {
  const mail = String(email || '').trim();
  if (!mail || !password) throw new Error('Enter your email and password');

  let res;
  try {
    res = await fetch(api('/api/auth/login/'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: mail, password }),
    });
  } catch {
    throw new Error(`Cannot reach DropletFX at ${config().apiBase}`);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('Wrong email or password');
  if (!res.ok) throw new Error(data.error || `Sign-in failed (HTTP ${res.status})`);
  if (!data.access) throw new Error('Backend returned no access token');

  saveSession({ user: data.user, access: data.access, refresh: data.refresh });
  log('signed in as', data.user && data.user.email);
  return data.user;
}

// ── session lifecycle ───────────────────────────────────────────────────────

/** Swap the refresh token for a fresh access token. True if it worked. */
async function refreshAccess() {
  if (!session || !session.refresh) return false;
  try {
    const res = await fetch(api('/api/auth/token/refresh/'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh: session.refresh }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    if (!data.access) return false;
    // ROTATE_REFRESH_TOKENS is on server-side, so keep the new refresh too.
    saveSession({ ...session, access: data.access, refresh: data.refresh || session.refresh });
    return true;
  } catch {
    return false;                 // offline — caller decides what that means
  }
}

/** Authenticated call to the backend, retried once after a token refresh. */
async function authFetch(pathname, opts = {}) {
  if (!session) throw new Error('Not signed in');
  const send = () => fetch(api(pathname), {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
      Authorization: `Bearer ${session.access}`,
    },
  });
  let res = await send();
  if (res.status === 401 && await refreshAccess()) res = await send();
  return res;
}

/**
 * Load the stored session at boot and check it is still good.
 *
 * Deliberately forgiving about the network: charting and MT5 order entry are
 * local, so a dropped connection must not lock the user out of their own app.
 * We only clear the session when the server actively rejects it.
 */
async function restore() {
  session = loadSession();
  if (!session) return null;

  try {
    const res = await authFetch('/api/auth/profile/');
    if (res.ok) {
      const user = await res.json();
      saveSession({ ...session, user });
      return user;
    }
    if (res.status === 401) {           // refresh already tried and failed
      log('stored session rejected, signing out');
      saveSession(null);
      return null;
    }
    log('profile check returned HTTP', res.status, '- keeping session');
  } catch {
    log('offline at startup - keeping stored session');
  }
  return session.user || null;
}

function currentUser() {
  return session ? session.user || null : null;
}

function isSignedIn() {
  return !!session;
}

function signOut() {
  log('signed out');
  saveSession(null);
}

/** Read-only view for the renderer — no tokens here. */
function publicSession() {
  return { signedIn: isSignedIn(), user: currentUser(), apiBase: config().apiBase };
}

/**
 * A currently-valid access token, for the one job the renderer can't delegate:
 * opening the live WebSocket, which needs the bearer in its URL. Refreshed
 * first if the server has stopped accepting it, so a long session doesn't drop
 * mid-broadcast. The refresh token never leaves this process.
 */
async function accessTokenForSocket() {
  if (!session) return null;
  try {
    const res = await authFetch('/api/auth/profile/');   // refreshes on a 401
    if (!res.ok && res.status === 401) return null;
  } catch {
    /* offline: hand back what we have and let the socket fail honestly */
  }
  return session ? session.access : null;
}

module.exports = {
  signIn, signInWithPassword, signOut, restore, refreshAccess, authFetch,
  currentUser, isSignedIn, publicSession, accessTokenForSocket,
};
