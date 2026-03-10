const { contextBridge, ipcRenderer } = require('electron');

function on(channel, cb) {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, cb);
}

contextBridge.exposeInMainWorld('electron', {
  // ── outbound (renderer → main) ─────────────────────────────────────────────
  getSources:       () => ipcRenderer.invoke('get-sources'),
  enterOverlayMode: (windowTitle) => ipcRenderer.send('enter-overlay-mode', windowTitle),
  exitOverlayMode:  () => ipcRenderer.send('exit-overlay-mode'),
  sendCursor:       (data) => ipcRenderer.send('ghost-cursor', data),
  setIgnoreMouse:   (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  setPanelOpen:     (open) => ipcRenderer.send('panel-open', open),
  setFocusable:     (val) => ipcRenderer.send('set-focusable', val),
  focusOverlay:     () => ipcRenderer.send('focus-overlay'),
  sendStuck:        (stuck) => ipcRenderer.send('stuck-signal', stuck),
  sendHelpRequest:  (text) => ipcRenderer.send('help-request', text),
  sendArrival:      () => ipcRenderer.send('arrival'),
  sendMarco:        () => ipcRenderer.send('marco-detected'),
  sendStamp:        (verdict) => ipcRenderer.send('send-stamp', verdict),
  setNotePositions: (positions) => ipcRenderer.send('note-positions', positions),
  dismissNote:      (idx) => ipcRenderer.send('dismiss-note', idx),
  startRecording:   () => ipcRenderer.send('start-recording'),
  sendTranscript:   (text) => ipcRenderer.send('transcript', text),

  // ── inbound (main → renderer) ──────────────────────────────────────────────
  onCursor:         (cb) => on('ghost-cursor',    (_, data) => cb(data)),
  onBounds:         (cb) => on('window-bounds',   (_, data) => cb(data)),
  onZoneChange:     (cb) => on('zone-change',     (_, data) => cb(data)),
  onStuck:          (cb) => on('stuck-signal',    (_, data) => cb(data)),
  onHelpRequest:    (cb) => on('help-request',    (_, text) => cb(text)),
  onArrival:        (cb) => on('arrival',         () => cb()),
  onMarcoDetected:  (cb) => on('marco-detected',  () => cb()),
  onStamp:          (cb) => on('stamp',           (_, v) => cb(v)),
  onStartRecording: (cb) => on('start-recording', () => cb()),
  onTranscript:     (cb) => on('transcript',      (_, text) => cb(text)),
  onDismissNote:    (cb) => on('dismiss-note',    (_, idx)  => cb(idx)),
  onMouseMoved:     (cb) => on('os-mouse-moved',  () => cb()),
  onIdle:           (cb) => on('os-idle',         (_, ms) => cb(ms)),
  onUndo:           (cb) => on('os-undo',         (_, n)  => cb(n)),
});