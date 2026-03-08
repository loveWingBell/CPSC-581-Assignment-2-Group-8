const { app, BrowserWindow, ipcMain, screen, desktopCapturer } = require('electron');
const { execSync } = require('child_process');
const path = require('path');

const isDev = process.env.NODE_ENV === 'development';
let mainWindow;
let overlayWindow;
let trackingInterval = null;
let trackedWindowTitle = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'camera', 'microphone', 'video'];
    callback(allowed.includes(permission));
  });

  isDev
    ? mainWindow.loadURL('http://localhost:5173')
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
    const [left, top, right, bottom] = result.split(',').map(Number);
    if (isNaN(left)) return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
  } catch {
    return null;
  }
}

// Poll the tracked window's position and resize overlay to match
function startWindowTracking() {
  if (trackingInterval) clearInterval(trackingInterval);
  trackingInterval = setInterval(() => {
    if (!overlayWindow || !trackedWindowTitle) return;
    const bounds = getWindowBounds(trackedWindowTitle);
    if (bounds && bounds.width > 0 && bounds.height > 0) {
      overlayWindow.setBounds(bounds);
      // Send bounds to overlay so it can rescale its canvas
      overlayWindow.webContents.send('window-bounds', bounds);
    }
  }, 500); // check every 500ms
}

function stopWindowTracking() {
  if (trackingInterval) { clearInterval(trackingInterval); trackingInterval = null; }
  trackedWindowTitle = null;
}

function createOverlayWindow(bounds) {
  overlayWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.on('closed', () => { overlayWindow = null; });
  overlayWindow.webContents.openDevTools({ mode: 'detach' }); // TEMPORARY, REMOVE LATER
}

app.whenReady().then(() => {
  createMainWindow();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// Desktop capture
ipcMain.handle('get-sources', async () => {
  return await desktopCapturer.getSources({ types: ['window', 'screen'] });
});

// Novice call connected: hide main window, spawn overlay on the tracked window
ipcMain.on('enter-overlay-mode', (_, windowTitle) => {
  trackedWindowTitle = windowTitle;
  const bounds = getWindowBounds(windowTitle) || screen.getPrimaryDisplay().workAreaSize;
  mainWindow.hide();
  createOverlayWindow(bounds);
  startWindowTracking();
  startInputTracking();
});

// Forward ghost cursor coords to overlay
ipcMain.on('ghost-cursor', (_, data) => {
  if (overlayWindow) overlayWindow.webContents.send('ghost-cursor', data);
});

// Toggle click-through for End Call hover zone
ipcMain.on('set-ignore-mouse', (_, ignore) => {
  if (overlayWindow) overlayWindow.setIgnoreMouseEvents(ignore, { forward: true });
});

// End call: close overlay, stop tracking, show main window
ipcMain.on('exit-overlay-mode', () => {
  stopWindowTracking();
  if (overlayWindow) { overlayWindow.close(); overlayWindow = null; }
  mainWindow.show();
});

ipcMain.on('stuck-signal', (_, stuck) => {
  console.log('main.js received stuck-signal:', stuck, '| overlayWindow exists:', !!overlayWindow);
  if (overlayWindow) overlayWindow.webContents.send('stuck-signal', stuck);
});

const { globalShortcut } = require('electron');

// OS-level idle + undo tracking, forwarded to the React app
let lastMousePos    = { x: 0, y: 0 };
let lastMoveTime    = Date.now();
let undoTimes       = [];
const UNDO_WINDOW_MS = 10000;

function startInputTracking() {
  // Poll mouse position every second
  trackingInterval = setInterval(() => {
    const pos = screen.getCursorScreenPoint();

    // Check if mouse moved
    if (pos.x !== lastMousePos.x || pos.y !== lastMousePos.y) {
      lastMousePos = pos;
      lastMoveTime = Date.now();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('os-mouse-moved');
      }
    }

    // Send idle status
    const idleMs = Date.now() - lastMoveTime;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('os-idle', idleMs);
    }
  }, 1000);

  // Global Ctrl+Z listener
  globalShortcut.register('CommandOrControl+Z', () => {
    undoTimes = undoTimes.filter(t => Date.now() - t < UNDO_WINDOW_MS);
    undoTimes.push(Date.now());
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('os-undo', undoTimes.length);
    }
  });
}

function stopInputTracking() {
  globalShortcut.unregister('CommandOrControl+Z');
  undoTimes = [];
}