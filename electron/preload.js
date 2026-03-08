const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  getSources:       () => ipcRenderer.invoke('get-sources'),
  enterOverlayMode: (windowTitle) => ipcRenderer.send('enter-overlay-mode', windowTitle),
  exitOverlayMode:  () => ipcRenderer.send('exit-overlay-mode'),
  sendCursor:       (data) => ipcRenderer.send('ghost-cursor', data),
  setIgnoreMouse:   (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  sendStuck:        (stuck) => ipcRenderer.send('stuck-signal', stuck),
  onCursor:         (cb) => ipcRenderer.on('ghost-cursor', (_, data) => cb(data)),
  onBounds:         (cb) => ipcRenderer.on('window-bounds', (_, data) => cb(data)),
  onStuck:          (cb) => ipcRenderer.on('stuck-signal', (_, data) => cb(data)),
  onMouseMoved: (cb) => ipcRenderer.on('os-mouse-moved', () => cb()),
  onIdle:       (cb) => ipcRenderer.on('os-idle', (_, ms) => cb(ms)),
  onUndo:       (cb) => ipcRenderer.on('os-undo', (_, count) => cb(count)),
});