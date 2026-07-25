/* Desktop configuration: where the DropletFX backend lives and which Google
 * OAuth client this app signs in with.
 *
 * Resolution order (later wins):
 *   1. the defaults below
 *   2. config.json in the app's userData folder — lets a user or installer
 *      repoint a shipped build without a rebuild
 *   3. DFX_* environment variables — handiest during development
 *
 * The Google *client secret* for an installed app is not a secret in the usual
 * sense: RFC 8252 and Google's own installed-app guidance both accept that it
 * ships inside the binary, which is exactly why the flow is protected by PKCE
 * and a loopback redirect instead.
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const DEFAULTS = {
  // The live dropletfx backend. Point at a local Django with
  // DFX_API_BASE=http://127.0.0.1:8000 during development.
  apiBase: 'https://sakinsafari.com',
  // The same client the website signs in with, so it is already trusted by the
  // backend's GOOGLE_OAUTH_CLIENT_IDS and /api/auth/google/ accepts its `aud`.
  // Its secret is not shipped here — set googleClientSecret in config.json, and
  // register http://127.0.0.1:47700/callback as an authorized redirect URI.
  googleClientId: '15638134322-t0ibhbpru2vmg7k9e10mf47qpli7c5cb.apps.googleusercontent.com',
  googleClientSecret: '',
  // Loopback port Google redirects back to after sign-in. A "Desktop app"
  // client accepts any port on 127.0.0.1, but a "Web application" client only
  // accepts redirect URIs registered exactly — so we keep this fixed and
  // predictable, and it is the one value you register in the console:
  //   http://127.0.0.1:47700/callback
  loopbackPort: 47700,
};

const CONFIG_FILE = () => path.join(app.getPath('userData'), 'config.json');

function fromFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};                      // absent or unreadable — defaults stand
  }
}

function fromEnv() {
  const e = {};
  if (process.env.DFX_API_BASE) e.apiBase = process.env.DFX_API_BASE;
  if (process.env.DFX_GOOGLE_CLIENT_ID) e.googleClientId = process.env.DFX_GOOGLE_CLIENT_ID;
  if (process.env.DFX_GOOGLE_CLIENT_SECRET) e.googleClientSecret = process.env.DFX_GOOGLE_CLIENT_SECRET;
  if (process.env.DFX_LOOPBACK_PORT) e.loopbackPort = Number(process.env.DFX_LOOPBACK_PORT);
  return e;
}

let cached = null;

function config() {
  if (!cached) {
    cached = { ...DEFAULTS, ...fromFile(), ...fromEnv() };
    // A trailing slash would double up against the '/api/...' paths below.
    cached.apiBase = String(cached.apiBase || '').replace(/\/+$/, '');
  }
  return cached;
}

/** Absolute URL for a backend path, e.g. api('/api/auth/google/'). */
function api(pathname) {
  return `${config().apiBase}${pathname}`;
}

/** Both halves are needed: the code exchange posts the secret too, so an id on
 *  its own would light up the button and then fail at Google. */
function googleConfigured() {
  const c = config();
  return !!(c.googleClientId && c.googleClientSecret);
}

module.exports = { config, api, googleConfigured, CONFIG_FILE };
