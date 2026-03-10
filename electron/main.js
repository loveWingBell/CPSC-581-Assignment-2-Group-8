const { app, BrowserWindow, ipcMain, screen, desktopCapturer, globalShortcut } = require('electron');
const { execSync } = require('child_process');
const path = require('path');

const isDev = process.env.NODE_ENV === 'development';
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
let mainWindow, overlayWindow;
let trackingInterval = null, trackedWindowTitle = null;
let cursorPollInterval = null;
let panelOpen = false;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100, height: 750,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  mainWindow.webContents.setBackgroundThrottling(false);
  const allowed = ['media', 'camera', 'microphone', 'video', 'speech'];
  mainWindow.webContents.session.setPermissionRequestHandler((_, p, cb) => cb(allowed.includes(p)));
  mainWindow.webContents.session.setPermissionCheckHandler((_, p) => allowed.includes(p));
  isDev ? mainWindow.loadURL('http://localhost:5173')
        : mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
}

function getWindowBounds(title) {
  try {
    const script = `
      Add-Type @"
      using System;
      using System.Runtime.InteropServices;
      public class WinAPI {
        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]
        public static extern IntPtr FindWindow(string className, string windowName);
        public struct RECT { public int Left, Top, Right, Bottom; }
      }
"@
      $hwnd = [WinAPI]::FindWindow($null, "${title}")
      $rect = New-Object WinAPI+RECT
      [WinAPI]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
      "$($rect.Left),$($rect.Top),$($rect.Right),$($rect.Bottom)"
    `;
    const result = execSync(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { timeout: 1000 }).toString().trim();
    const [l, t, r, b] = result.split(',').map(Number);
    if (isNaN(l)) return null;
    return { x: l, y: t, width: r - l, height: b - t };
  } catch { return null; }
}

function startWindowTracking() {
  if (trackingInterval) clearInterval(trackingInterval);
  trackingInterval = setInterval(() => {
    if (!overlayWindow || !trackedWindowTitle) return;
    const bounds = getWindowBounds(trackedWindowTitle);
    if (bounds?.width > 0 && bounds?.height > 0) {
      overlayWindow.setBounds(bounds);
      overlayWindow.webContents.send('window-bounds', bounds);
    }
  }, 500);
}

function stopWindowTracking() {
  if (trackingInterval) { clearInterval(trackingInterval); trackingInterval = null; }
  trackedWindowTitle = null;
}

// Poll cursor position every 50ms — zero-latency passthrough, no { forward: true }
function startCursorPoll() {
  if (cursorPollInterval) clearInterval(cursorPollInterval);
  cursorPollInterval = setInterval(() => {
    if (!overlayWindow) return;
    const cursor = screen.getCursorScreenPoint();
    const b = overlayWindow.getBounds();
    const rx = cursor.x - b.x;
    const ry = cursor.y - b.y;
    const w  = b.width;
    const h  = b.height;

    const inEndZone  = rx > w - 220 && ry > h - 110 && rx <= w && ry <= h;
    const inHelpZone = rx >= 0 && rx <= 380 && ry >= h - 420 && ry <= h;
    const normX = w > 0 ? rx / w : 0.5;
    const normY = h > 0 ? ry / h : 0.5;
    const shouldInteract = inEndZone || inHelpZone || panelOpen;

    // Only toggle ignore-mouse based on zones when no panel is open.
    // When panelOpen=true the panel-open IPC handler already called
    // setIgnoreMouseEvents(false); letting the poll override it causes a
    // race that makes overlay buttons unclickable.
    if (!panelOpen) {
      overlayWindow.setIgnoreMouseEvents(!shouldInteract);
    }
    overlayWindow.webContents.send('zone-change', { inEndZone, inHelpZone, normX, normY });
  }, 50);
}

function stopCursorPoll() {
  if (cursorPollInterval) { clearInterval(cursorPollInterval); cursorPollInterval = null; }
}

function createOverlayWindow(bounds) {
  overlayWindow = new BrowserWindow({
    ...bounds, transparent: true, frame: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWindow.setIgnoreMouseEvents(true);
  overlayWindow.on('closed', () => { overlayWindow = null; stopCursorPoll(); });
  startCursorPoll();
}

app.whenReady().then(createMainWindow);

ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 150, height: 150 } });
  return sources.filter(s => s.name?.trim() && !s.name.includes('Marco Polo') && !s.name.includes('DevTools'));
});

ipcMain.on('enter-overlay-mode', (_, windowTitle) => {
  trackedWindowTitle = windowTitle;
  const bounds = getWindowBounds(windowTitle) || screen.getPrimaryDisplay().workAreaSize;
  mainWindow.setOpacity(0);
  mainWindow.setIgnoreMouseEvents(true);
  mainWindow.setSkipTaskbar(true);
  createOverlayWindow(bounds);
  startWindowTracking();
});

ipcMain.on('ghost-cursor', (_, data) => {
  if (overlayWindow) overlayWindow.webContents.send('ghost-cursor', data);
});

ipcMain.on('set-ignore-mouse', (_, ignore) => {
  if (overlayWindow) overlayWindow.setIgnoreMouseEvents(ignore);
});

ipcMain.on('panel-open', (_, isOpen) => {
  panelOpen = isOpen;
  if (overlayWindow) {
    overlayWindow.setIgnoreMouseEvents(!isOpen);
    overlayWindow.setAlwaysOnTop(true, isOpen ? 'screen-saver' : 'normal');
  }
});

ipcMain.on('set-focusable', (_, val) => {
  if (overlayWindow) overlayWindow.setFocusable(val);
});

ipcMain.on('focus-overlay', () => {
  if (overlayWindow) overlayWindow.focus();
});

ipcMain.on('exit-overlay-mode', () => {
  stopWindowTracking();
  stopCursorPoll();
  panelOpen = false;
  if (overlayWindow) { overlayWindow.close(); overlayWindow = null; }
  mainWindow.setOpacity(1);
  mainWindow.setIgnoreMouseEvents(false);
  mainWindow.setSkipTaskbar(false);
  mainWindow.show();
  mainWindow.focus();
});

ipcMain.on('stuck-signal', (_, stuck) => {
  if (overlayWindow) {
    overlayWindow.webContents.send('stuck-signal', stuck);
  } else if (stuck) {
    setTimeout(() => { if (overlayWindow) overlayWindow.webContents.send('stuck-signal', stuck); }, 1000);
  }
});

// Help request: overlay → main window → data channel in React
ipcMain.on('help-request', (_, text) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('help-request', text);
});

// "Marco" detected in VideoCall.jsx (localhost, has mic access) → forward to overlay
ipcMain.on('marco-detected', () => {
  if (overlayWindow) overlayWindow.webContents.send('marco-detected');
});

// Stamp from overlay → main window → data channel
ipcMain.on('send-stamp', (_, verdict) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('stamp', verdict);
});

// Note dismissed by novice → forward to main window so expert canvas updates
ipcMain.on('dismiss-note', (_, idx) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('dismiss-note', idx);
});

// Voice recording: overlay asks main window to handle mic (localhost context)
ipcMain.on('start-recording', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('start-recording');
  }
});

ipcMain.on('transcript', (_, text) => {
  if (overlayWindow) overlayWindow.webContents.send('transcript', text);
});

app.on('will-quit', () => globalShortcut.unregisterAll());