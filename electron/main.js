// Trailmap — Electron main process.
// M2: real persistence. Single-writer rule (plan §5): ONLY this process touches
// the disk, via the StorageProvider. The renderer sends state over IPC.
const { app, BrowserWindow, ipcMain, dialog, Notification, powerMonitor, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { createProvider } = require('./storage/provider');

let logicPromise = null;
function logic() {
  if (!logicPromise) {
    logicPromise = import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'logic.js')).href);
  }
  return logicPromise;
}

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
  // First run starts EMPTY (owner decision) — the sample is a menu item away.
  return path.join(__dirname, '..', 'fixtures', 'empty-quarter.json');
}

function samplePath() {
  return path.join(__dirname, '..', 'fixtures', 'sample-quarter.json');
}

async function loadSampleData() {
  const choice = SILENT ? 0 : dialog.showMessageBoxSync(win, {
    type: 'question',
    message: 'Load the sample quarter?',
    detail: 'Your current map will be snapshotted first, then replaced with the demo data.',
    buttons: ['Load Sample', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice !== 0) return;
  const raw = fs.readFileSync(samplePath(), 'utf8');
  const { doc } = await provider.parseExternal(raw);
  if (!doc) return;
  const prev = provider.lastSavedContent();
  if (prev != null) provider.snapshotContent(prev, 'pre-sample');
  clearTimeout(saveTimer); dirty = false;
  currentDoc = doc;
  await provider.forceSave(doc);
  if (win) win.webContents.send('trailmap:external-change', doc);
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
    if (err.code === 'CONFLICT') { dirty = true; await resolveConflict(err.raw); return; }
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
    try { provider.saveSync(currentDoc); dirty = false; }
    catch (err) {
      if (err.code === 'CONFLICT') {
        // External edit arrived while quitting: leave the disk as-is, preserve
        // our version as a snapshot so nothing is lost either way.
        try { provider.snapshotContent(JSON.stringify(currentDoc, null, 1), 'app-quit'); } catch { /* best effort */ }
      }
      /* otherwise keep old file */
    }
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
  await resolveConflict(raw);
}

/** Shared external-change resolution (watcher poll AND conflict-detected saves). */
async function resolveConflict(raw) {
  const { doc } = await provider.parseExternal(raw);
  if (!doc) return; // partial/invalid external write — the next poll retries

  if (dirty) {
    // Unsaved in-app changes AND an external edit. Snapshot both, ask which
    // side wins (plan §10 — never silently clobber).
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
    if (choice === 1) {
      clearTimeout(saveTimer); dirty = false;
      provider.adoptExternal(raw);
      try { await provider.forceSave(currentDoc); } catch { dirty = true; }
      return;
    }
    clearTimeout(saveTimer); dirty = false;
  }
  currentDoc = doc;
  provider.adoptExternal(raw); // don't re-trigger on our own knowledge of it
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

// ---------- aging-chip notifications (plan §7) ----------
let notifyTimer = null;

function fireNotification(p) {
  let title, body;
  if (p.kind === 'due') {
    title = p.tier === 2 ? `⚑ Overdue: ${p.what}` : `⚑ Due today: ${p.what}`;
    body = p.tier === 2
      ? `Slipped ${p.days} day${p.days === 1 ? '' : 's'} past due (${p.initName}).`
      : `On your map under “${p.initName}.”`;
  } else {
    title = p.tier === 2 ? `⚠ ${p.who} — ${p.what}` : `⏳ ${p.who} — ${p.what}`;
    body = p.tier === 2
      ? `Waiting ${p.days} days (${p.initName}). Time to nudge.`
      : `Has been waiting ${p.days} days (${p.initName}).`;
  }
  if (process.env.TRAILMAP_NOTIFY_FAKE === '1') {
    // Test hook: record instead of showing OS notifications (e2e asserts exactly-once).
    fs.appendFileSync(path.join(dataDir(), 'notifications.log'), JSON.stringify({ ...p, title }) + '\n');
    return;
  }
  if (!Notification.isSupported()) return; // denied/unsupported: fail silent (plan §7)
  const n = new Notification({ title, body });
  n.on('click', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
    else createWindow();
  });
  n.show();
}

async function runNotificationCheck() {
  if (!currentDoc) return;
  const L = await logic();
  const now = new Date();
  const waiting = L.pendingWaitingNotifications(currentDoc, now);
  for (const p of waiting) {
    fireNotification(p);
    L.applyNotifiedTier(currentDoc, p.waitId, p.tier);
  }
  // Due-date notifications (v0.2): due-day and overdue, once each.
  const due = L.pendingDueNotifications(currentDoc, now);
  for (const p of due) {
    fireNotification({
      who: p.tier === 2 ? '⚑ Overdue' : '⚑ Due today',
      what: p.label,
      days: p.tier === 2 ? Math.max(1, Math.round((now - new Date(p.due)) / 86400000)) : 0,
      tier: p.tier,
      initName: p.initName,
      kind: 'due',
    });
    L.applyDueTier(currentDoc, p.moveId, p.tier);
  }
  if (waiting.length || due.length) {
    scheduleSave(); // persist notified tiers so nothing ever fires twice
    if (win) win.webContents.send('trailmap:external-change', currentDoc);
  }
}

async function armDailyCheck() {
  const L = await logic();
  const hour = L.CONSTANTS.NOTIFY_HOUR;
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(async () => {
    await runNotificationCheck();
    armDailyCheck();
  }, next - now);
}

// ---------- window state (plan §8; separate from user data) ----------
function windowStatePath() { return path.join(dataDir(), 'window-state.json'); }

function loadWindowState() {
  try { return JSON.parse(fs.readFileSync(windowStatePath(), 'utf8')); }
  catch { return {}; }
}

let boundsTimer = null;
function rememberBounds() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    if (!win) return;
    try { fs.writeFileSync(windowStatePath(), JSON.stringify(win.getBounds())); } catch { /* cosmetic */ }
  }, 500);
}

// ---------- window ----------
function createWindow() {
  const state = loadWindowState();
  win = new BrowserWindow({
    width: state.width || 1080,
    height: state.height || 860,
    ...(Number.isFinite(state.x) && Number.isFinite(state.y) ? { x: state.x, y: state.y } : {}),
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
  win.on('resize', rememberBounds);
  win.on('move', rememberBounds);
  win.on('close', () => {
    clearTimeout(boundsTimer);
    try { fs.writeFileSync(windowStatePath(), JSON.stringify(win.getBounds())); } catch { /* cosmetic */ }
  });
  win.on('closed', () => { win = null; });
}

// ---------- File menu actions (plan §8) ----------
async function exportData() {
  if (!currentDoc) return;
  let dest = process.env.TRAILMAP_TEST_EXPORT_PATH; // test hook: bypass dialog
  if (!dest) {
    const today = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog(win, {
      title: 'Export Trailmap Data',
      defaultPath: path.join(app.getPath('documents'), `trailmap-export-${today}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return;
    dest = r.filePath;
  }
  // An export is a copy OUTSIDE the live store — plain write is correct here.
  fs.writeFileSync(dest, JSON.stringify(currentDoc, null, 2), 'utf8');
}

async function importData() {
  let src = process.env.TRAILMAP_TEST_IMPORT_PATH; // test hook: bypass dialog
  if (!src) {
    const r = await dialog.showOpenDialog(win, {
      title: 'Import Trailmap Data',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return;
    src = r.filePaths[0];
  }
  let raw;
  try { raw = fs.readFileSync(src, 'utf8'); }
  catch (e) { notify({ type: 'error', message: 'Could not read that file', detail: e.message }); return; }
  const { doc, errs } = await provider.parseExternal(raw); // accepts prototype format (plan §4.1)
  if (!doc) {
    notify({ type: 'error', message: 'That file is not valid Trailmap data', detail: errs.slice(0, 5).join('\n') });
    return;
  }
  // Snapshot the current state BEFORE replacing it (plan §8).
  const prev = provider.lastSavedContent();
  if (prev != null) provider.snapshotContent(prev, 'pre-import');
  clearTimeout(saveTimer); dirty = false;
  currentDoc = doc;
  await provider.forceSave(doc);
  if (win) win.webContents.send('trailmap:external-change', doc);
}

async function restoreSnapshotFlow() {
  let id = process.env.TRAILMAP_TEST_RESTORE_ID; // test hook: bypass dialog
  if (!id) {
    const r = await dialog.showOpenDialog(win, {
      title: 'Restore a Snapshot',
      defaultPath: provider.snapDir,
      filters: [{ name: 'Trailmap snapshots', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return;
    const picked = r.filePaths[0];
    if (path.dirname(picked) !== provider.snapDir) {
      notify({ type: 'error', message: 'Please pick a file from the snapshots folder' });
      return;
    }
    id = path.basename(picked);
  }
  await doRestoreSnapshot(id);
}

async function doRestoreSnapshot(id) {
  const doc = await provider.loadSnapshot(id);
  const prev = provider.lastSavedContent();
  if (prev != null) provider.snapshotContent(prev, 'pre-restore');
  clearTimeout(saveTimer); dirty = false;
  currentDoc = doc;
  await provider.forceSave(doc);
  if (win) win.webContents.send('trailmap:external-change', doc);
  return { ok: true };
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { id: 'export', label: 'Export Data…', accelerator: 'CmdOrCtrl+E', click: () => exportData() },
        { id: 'import', label: 'Import Data…', accelerator: 'CmdOrCtrl+I', click: () => importData() },
        { type: 'separator' },
        { id: 'snapshot-now', label: 'Snapshot Now', click: () => provider.snapshotNow() },
        { id: 'restore-snapshot', label: 'Restore Snapshot…', click: () => restoreSnapshotFlow() },
        { type: 'separator' },
        { id: 'load-sample', label: 'Load Sample Data…', click: () => loadSampleData() },
        { id: 'open-data', label: 'Open Data Folder', click: () => shell.openPath(dataDir()) },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
    { role: 'editMenu' }, // needed for copy/paste in text fields on macOS (plan §8)
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- IPC ----------
ipcMain.handle('trailmap:load', async () => {
  const doc = await loadOrRecover();
  currentDoc = doc;
  startWatching();
  // Launch-time notification check + daily re-check at NOTIFY_HOUR (plan §7).
  // Fire-and-forget: never blocks the UI on notification plumbing.
  runNotificationCheck().then(armDailyCheck).catch(() => {});
  return doc;
});

ipcMain.handle('trailmap:persist', async (_e, doc) => {
  currentDoc = doc;
  scheduleSave();
  return { ok: true };
});

ipcMain.handle('trailmap:list-snapshots', async () => provider.listSnapshots());

ipcMain.handle('trailmap:restore-snapshot', async (_e, id) => doRestoreSnapshot(id));
ipcMain.handle('trailmap:export', async () => { await exportData(); return { ok: true }; });
ipcMain.handle('trailmap:import', async () => { await importData(); return { ok: true }; });
ipcMain.handle('trailmap:open-data-folder', async () => { shell.openPath(dataDir()); return { ok: true }; });

// ---------- lifecycle ----------
app.whenReady().then(() => {
  provider = createProvider(dataDir(), { seedPath: seedPath() });
  buildMenu();
  createWindow();
  // Sleep/wake: the 9am timer may have slept through its moment (plan §10).
  powerMonitor.on('resume', () => {
    runNotificationCheck().then(armDailyCheck).catch(() => {});
  });
});
app.on('before-quit', flushSync);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
