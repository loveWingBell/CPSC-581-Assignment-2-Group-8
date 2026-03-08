const { contextBridge, ipcRenderer } = require('electron');

// Helper: remove any existing listeners before adding a new one, so React
// re-renders and hot-reloads never stack up duplicate handlers
function on(channel, cb) {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, cb);
}

contextBridge.exposeInMainWorld('electron', {
  getSources:       () => ipcRenderer.invoke('get-sources'),
  enterOverlayMode: (windowTitle) => ipcRenderer.send('enter-overlay-mode', windowTitle),
  exitOverlayMode:  () => ipcRenderer.send('exit-overlay-mode'),
  sendCursor:       (data) => ipcRenderer.send('ghost-cursor', data),
  setIgnoreMouse:   (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  sendStuck:        (stuck) => ipcRenderer.send('stuck-signal', stuck),
  sendHelpRequest:  (text) => ipcRenderer.send('help-request', text),
  sendArrival:      () => ipcRenderer.send('arrival'),
  setFocusable:     (val) => ipcRenderer.send('set-focusable', val),
  focusOverlay:     () => ipcRenderer.send('focus-overlay'),
  startRecording:   () => ipcRenderer.send('start-recording'),
  sendTranscript:   (text) => ipcRenderer.send('transcript', text),
  onCursor:         (cb) => on('ghost-cursor',    (_, data) => cb(data)),
  onBounds:         (cb) => on('window-bounds',   (_, data) => cb(data)),
  onStuck:          (cb) => on('stuck-signal',    (_, data) => cb(data)),
  onHelpRequest:    (cb) => on('help-request',    (_, text) => cb(text)),
  onArrival:        (cb) => on('arrival',         () => cb()),
  onStartRecording: (cb) => on('start-recording', () => cb()),
  onTranscript:     (cb) => on('transcript',      (_, text) => cb(text)),
  onMouseMoved:     (cb) => on('os-mouse-moved',  () => cb()),
  onIdle:           (cb) => on('os-idle',         (_, ms) => cb(ms)),
  onUndo:           (cb) => on('os-undo',         (_, n)  => cb(n)),
});