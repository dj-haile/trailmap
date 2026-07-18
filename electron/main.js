// Trailmap — Electron main process (M1: window + bridge; storage lands in M2).
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.setName('Trailmap');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 860,
    minWidth: 720,
    minHeight: 600,
    title: 'Trailmap',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

// ---- IPC (M1: fixture-backed; replaced by StorageProvider in M2) ----
ipcMain.handle('trailmap:load', async () => {
  const fixture = path.join(__dirname, '..', 'fixtures', 'sample-quarter.json');
  return JSON.parse(fs.readFileSync(fixture, 'utf8'));
});
ipcMain.handle('trailmap:persist', async (_e, _doc) => {
  // M2 wires this to the storage provider (debounced atomic save + snapshot).
  return { ok: true };
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
