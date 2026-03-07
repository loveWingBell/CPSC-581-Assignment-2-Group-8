const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  getSources:       () => ipcRenderer.invoke('get-sources'),
  enterOverlayMode: (windowTitle) => ipcRenderer.send('enter-overlay-mode', windowTitle),
  exitOverlayMode:  () => ipcRenderer.send('exit-overlay-mode'),
  sendCursor:       (data) => ipcRenderer.send('ghost-cursor', data),
  setIgnoreMouse:   (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  onCursor:         (cb) => ipcRenderer.on('ghost-cursor', (_, data) => cb(data)),
  onBounds:         (cb) => ipcRenderer.on('window-bounds', (_, data) => cb(data)),
});
