// Bridge for the launcher window: list saved workspaces, then open them.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dfxAuth', {
  session: () => ipcRenderer.invoke('ws-session'),
  signOut: () => ipcRenderer.invoke('auth-sign-out'),
});

contextBridge.exposeInMainWorld('dfxLive', {
  list: () => ipcRenderer.invoke('live-list'),
  start: (opts) => ipcRenderer.invoke('live-start', opts),
  open: (room, role, title) => ipcRenderer.send('live-open', room, role, title),
});

contextBridge.exposeInMainWorld('dfxLauncher', {
  list: () => ipcRenderer.invoke('ws-list'),
  launch: (ids) => ipcRenderer.send('ws-launch', ids),
  create: (name) => ipcRenderer.send('ws-create', name),
  remove: (id) => ipcRenderer.invoke('ws-delete', id),
});
