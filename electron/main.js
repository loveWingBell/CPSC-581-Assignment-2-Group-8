const { app, BrowserWindow, ipcMain, screen, desktopCapturer, globalShortcut } = require('electron');
const { execSync } = require('child_process');
const path = require('path');

const isDev = process.env.NODE_ENV === 'development';
let mainWindow, overlayWindow;
let trackingInterval = null, trackedWindowTitle = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1000, height: 700,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });

  // Grant camera, microphone, and speech permissions without prompting
  const allowed = ['media', 'camera', 'microphone', 'video', 'speech'];
  mainWindow.webContents.session.setPermissionRequestHandler((_, p, cb) => cb(allowed.includes(p)));
  // Required for Web Speech API — silently checked before mic is opened
  mainWindow.webContents.session.setPermissionCheckHandler((_, p) => allowed.includes(p));

  isDev ? mainWindow.loadURL('http://localhost:5173')
        : mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
}

// Use PowerShell to get the bounds of a window by its title
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

// Poll the tracked window's position and resize overlay to match
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

function createOverlayWindow(bounds) {
  overlayWindow = new BrowserWindow({
    ...bounds, transparent: true, frame: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.on('closed', () => { overlayWindow = null; });
}

app.whenReady().then(createMainWindow);

// Desktop capture — filter to only real visible windows
ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 150, height: 150 } });
  return sources.filter(s => s.name?.trim() && !s.name.includes('Marco Polo') && !s.name.includes('DevTools'));
});

ipcMain.on('enter-overlay-mode', (_, windowTitle) => {
  trackedWindowTitle = windowTitle;
  const bounds = getWindowBounds(windowTitle) || screen.getPrimaryDisplay().workAreaSize;
  mainWindow.hide();
  createOverlayWindow(bounds);
  startWindowTracking();
});

ipcMain.on('ghost-cursor',    (_, data)   => { if (overlayWindow) overlayWindow.webContents.send('ghost-cursor', data); });
ipcMain.on('set-ignore-mouse',(_, ignore) => { if (overlayWindow) overlayWindow.setIgnoreMouseEvents(ignore, { forward: true }); });

ipcMain.on('exit-overlay-mode', () => {
  stopWindowTracking();
  if (overlayWindow) { overlayWindow.close(); overlayWindow = null; }
  mainWindow.show();
});

ipcMain.on('stuck-signal', (_, stuck) => {
  if (overlayWindow) {
    overlayWindow.webContents.send('stuck-signal', stuck);
  } else if (stuck) {
    // Overlay not ready yet — retry in 1 second
    setTimeout(() => { if (overlayWindow) overlayWindow.webContents.send('stuck-signal', stuck); }, 1000);
  }
});

// Forward help request from overlay → main window → data channel in React
ipcMain.on('help-request', (_, text) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('help-request', text);
});

// Novice cursor arrived at target — forward to main window to show stamp panel
ipcMain.on('arrival', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('arrival');
});

// Allow overlay to become keyboard-focusable when voice panel is open
ipcMain.on('set-focusable', (_, val) => {
  if (overlayWindow) overlayWindow.setFocusable(val);
});

// Focus the overlay window so the textarea can receive keyboard input
ipcMain.on('focus-overlay', () => {
  if (overlayWindow) overlayWindow.focus();
});

// Overlay asks main window to start recording (speech API needs localhost)
ipcMain.on('start-recording', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.showInactive();
    mainWindow.webContents.send('start-recording');
  }
});

// Main window sends transcript back to overlay, then re-hides
ipcMain.on('transcript', (_, text) => {
  mainWindow.hide();
  if (overlayWindow) overlayWindow.webContents.send('transcript', text);
});

app.on('will-quit', () => globalShortcut.unregisterAll());