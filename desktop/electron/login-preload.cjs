// Bridge for the login window. The renderer can start a sign-in and read who
// is signed in — it never sees the tokens themselves, which stay in main.
const { contextBridge, ipcRenderer } = require('electron');

// ipcRenderer.invoke decorates a rejection with "Error invoking remote method
// 'x': Error: ...", which is noise in a login form. Unwrap it so the window
// shows the message main actually threw.
function clean(promise) {
  return promise.catch((err) => {
    const raw = (err && err.message) || String(err);
    const msg = raw.replace(/^Error invoking remote method '[^']*':\s*/i, '')
                   .replace(/^(Error|TypeError):\s*/i, '')
                   .trim();
    throw new Error(msg || 'Sign-in failed. Please try again.');
  });
}

contextBridge.exposeInMainWorld('dfxAuth', {
  /** Each resolves with the user, or rejects with a message safe to display. */
  signIn: () => clean(ipcRenderer.invoke('auth-sign-in')),
  signInWithPassword: (email, password) =>
    clean(ipcRenderer.invoke('auth-password-sign-in', email, password)),
  session: () => ipcRenderer.invoke('auth-session'),
  configured: () => ipcRenderer.invoke('auth-configured'),
  openWeb: (path) => ipcRenderer.send('auth-open-web', path),
  revealConfig: () => ipcRenderer.send('auth-reveal-config'),
  quit: () => ipcRenderer.send('auth-quit'),
});
