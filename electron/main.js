// Trailmap — Electron main process.
// M2: real persistence. Single-writer rule (plan §5): ONLY this process touches
// the disk, via the StorageProvider. The renderer sends state over IPC.
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { createProvider } = require('./storage/provider');

app.setName('Trailmap');

const SAVE_DEBOUNCE_MS = 500;
const WATCH_INTERVAL_MS = 800;

let win = null;
let provider = null;
let currentDoc = null;
let dirty = false;
let saveTimer = null;
let watching = false;

function dataDir() {
  return process.env.TRAILMAP_DATA_DIR || app.getPath('userData');
}

// E2E runs set this to keep informational dialogs from blocking headless tests.
const SILENT = process.env.TRAILMAP_SILENT_DIALOGS === '1';
function notify(opts) {
  if (SILENT || !win) return;
  dialog.showMessageBox(win, { buttons: ['OK'], ...opts });
}

function seedPath() {
  return path.join(__dirname, '..', 'fixtures', 'sample-quarter.json');
}

// ---------- saving ----------
function scheduleSave() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, SAVE_DEBOUNCE_MS);
}

async function doSave() {
  if (!dirty || !currentDoc) return;
  dirty = false;
  try {
    await provider.save(currentDoc);
  } catch (err) {
    // Disk misbehavior (plan §10): old file is intact (atomic write), app keeps
    // running, user sees a non-fatal notice. Don't re-arm a retry loop.
    notify({
      type: 'warning',
      message: 'Trailmap could not save your latest change',
      detail: `${err.message}\n\nYour previous data on disk is intact. ` +
              `Fix the underlying problem (disk space, permissions) and edit again to retry.`,
    });
  }
}

function flushSync() {
  clearTimeout(saveTimer);
  if (dirty && currentDoc && provider) {
    try { provider.saveSync(currentDoc); dirty = false; } catch { /* keep old file */ }
  }
}

// ---------- external-change watching (plan §10) ----------
function startWatching() {
  if (watching) return;
  watching = true;
  fs.watchFile(provider.file, { interval: WATCH_INTERVAL_MS }, () => { onFileChanged(); });
}

async function onFileChanged() {
  let raw;
  try { raw = fs.readFileSync(provider.file, 'utf8'); }
  catch { return; } // mid-replace; the next poll will see it
  if (raw === provider.lastSavedContent()) return; // our own write

  const { doc } = await provider.parseExternal(raw);
  if (!doc) return; // partial/invalid external write — ignore; poll again next tick

  if (dirty) {
    // Conflict: unsaved in-app changes AND an external edit. Snapshot both,
    // ask which side wins (plan §10 — never silently clobber).
    provider.snapshotContent(raw, 'external');
    provider.snapshotContent(JSON.stringify(currentDoc, null, 1), 'app');
    const choice = SILENT ? 0 : dialog.showMessageBoxSync(win, {
      type: 'question',
      message: 'The Trailmap data file was changed outside the app',
      detail: 'You also have unsaved changes here. Both versions have been snapshotted. Which one should win?',
      buttons: ['Load file from disk', 'Keep this app’s version'],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice === 1) { await doSave(); return; }
    clearTimeout(saveTimer); dirty = false;
  }
  currentDoc = doc;
  provider._lastSaved = raw; // adopt: don't re-trigger on our own knowledge of it
  if (win) win.webContents.send('trailmap:external-change', doc);
}

// ---------- load & corruption recovery (plan §4.2) ----------
async function loadOrRecover() {
  try {
    return await provider.load();
  } catch (err) {
    if (err.code !== 'CORRUPT') throw err;
    const badPath = provider.markCorrupt();
    const snaps = await provider.listSnapshots();
    for (const s of snaps) {
      try {
        const doc = await provider.loadSnapshot(s.id);
        await provider.save(doc);
        notify({
          type: 'warning',
          message: 'Trailmap recovered from a corrupted data file',
          detail: `The data file could not be read and was set aside as:\n${badPath}\n\n` +
                  `Restored the most recent good snapshot from ${s.timeISO}.`,
        });
        return doc;
      } catch { /* try the next snapshot */ }
    }
    // No usable snapshot — seed the sample rather than crash.
    const seeded = JSON.parse(fs.readFileSync(seedPath(), 'utf8'));
    await provider.save(seeded);
    notify({
      type: 'warning',
      message: 'Trailmap could not recover your data',
      detail: `The data file was unreadable and no valid snapshot existed. ` +
              `The bad file was kept at:\n${badPath}\n\nStarting from sample data.`,
    });
    return seeded;
  }
}

// ---------- window ----------
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

// ---------- IPC ----------
ipcMain.handle('trailmap:load', async () => {
  const doc = await loadOrRecover();
  currentDoc = doc;
  startWatching();
  return doc;
});

ipcMain.handle('trailmap:persist', async (_e, doc) => {
  currentDoc = doc;
  scheduleSave();
  return { ok: true };
});

ipcMain.handle('trailmap:list-snapshots', async () => provider.listSnapshots());

ipcMain.handle('trailmap:restore-snapshot', async (_e, id) => {
  const doc = await provider.loadSnapshot(id);
  clearTimeout(saveTimer); dirty = false;
  currentDoc = doc;
  await provider.save(doc);
  if (win) win.webContents.send('trailmap:external-change', doc);
  return { ok: true };
});

// M4 fills these in (menu-driven file dialogs).
ipcMain.handle('trailmap:export', async () => ({ ok: false, reason: 'M4' }));
ipcMain.handle('trailmap:import', async () => ({ ok: false, reason: 'M4' }));
ipcMain.handle('trailmap:open-data-folder', async () => ({ ok: false, reason: 'M4' }));

// ---------- lifecycle ----------
app.whenReady().then(() => {
  provider = createProvider(dataDir(), { seedPath: seedPath() });
  createWindow();
});
app.on('before-quit', flushSync);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
