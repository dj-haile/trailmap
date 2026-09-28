// File → Where Is My Data…: the dialog names the live file and its state, and
// its buttons drive the existing flows. Spec: thoughts/shared/specs/2026-09-26-data-file-visibility.md
// The native dialog is stubbed from the main process so tests can read its
// options and choose a button.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');
const LIVE = 'trailmap.json';
// Required lazily so a missing module fails the test that needs it, not the whole file.
const di = () => require('../../electron/data-info.js');

function seedSample(dataDir) {
  const sample = fs.readFileSync(path.join(ROOT, 'fixtures', 'sample-quarter.json'), 'utf8');
  fs.writeFileSync(path.join(dataDir, LIVE), sample);
}

function launchWith(dataDir, extraEnv = {}) {
  return electron.launch({
    args: [ROOT],
    env: {
      ...process.env,
      TRAILMAP_DATA_DIR: dataDir,
      TRAILMAP_SILENT_DIALOGS: '1',
      TRAILMAP_NOTIFY_FAKE: '1',
      ...extraEnv,
    },
  });
}

const clickMenu = (app, id) => app.evaluate(({ Menu }, itemId) => {
  Menu.getApplicationMenu().getMenuItemById(itemId).click();
}, id);

// The sample fixture fires launch-time notifications, which schedule a save
// ~500 ms after render. Wait past it before reading the file or snapshots.
async function settle(page) {
  await page.waitForSelector('.goal');
  await page.waitForTimeout(1200);
}

const stubDialog = (app, response) => app.evaluate(({ dialog }, r) => {
  globalThis.__dataInfo = null;
  dialog.showMessageBox = async (_w, opts) => { globalThis.__dataInfo = opts; return { response: r }; };
}, response);

// Menu clicks are fire-and-forget: poll for the captured options.
async function openDataInfo(app, response = 0) {
  await stubDialog(app, response);
  await clickMenu(app, 'data-info');
  await expect.poll(() => app.evaluate(() => globalThis.__dataInfo)).not.toBeNull();
  return app.evaluate(() => globalThis.__dataInfo);
}

const shownPath = opts => opts.message.split('\n').slice(1).join('\n').trim();
const lastSavedLine = detail => detail.split('\n').find(l => l.startsWith('Last saved:'));
const snapFiles = dataDir => fs.readdirSync(path.join(dataDir, 'snapshots')).filter(f => /^trailmap-.*\.json$/.test(f));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trailmap-datainfo-'));

async function tickMove(page) {
  await page.locator('.move-row:not(.done) .chk').first().click();
  await page.waitForTimeout(1200); // debounce (500 ms) + write
}

test('Where Is My Data shows the path of the file the app reads and writes', async () => {
  const dataDir = tmp();
  seedSample(dataDir);
  const app = await launchWith(dataDir);
  const page = await app.firstWindow();
  await settle(page);

  const opts = await openDataInfo(app);
  const shown = shownPath(opts);
  expect(fs.existsSync(shown)).toBe(true);
  const reveal = process.platform === 'darwin' ? 'Reveal in Finder' : 'Show in Folder';
  expect(opts.buttons).toEqual(['OK', 'Copy Path', reveal, 'Back Up…', 'Snapshot History…']);

  // the file at the shown path is the one the app writes to
  const doneBefore = JSON.parse(fs.readFileSync(shown, 'utf8')).goals
    .flatMap(g => g.inits).flatMap(i => i.moves).filter(m => m.done).length;
  await tickMove(page);
  const doneAfter = JSON.parse(fs.readFileSync(shown, 'utf8')).goals
    .flatMap(g => g.inits).flatMap(i => i.moves).filter(m => m.done).length;
  expect(doneAfter).toBe(doneBefore + 1);
  await app.close();
});

test('the shown path honours the data-directory override', async () => {
  const dataDir = tmp();
  seedSample(dataDir);
  const app = await launchWith(dataDir);
  const page = await app.firstWindow();
  await settle(page);

  const opts = await openDataInfo(app);
  expect(shownPath(opts).startsWith(dataDir)).toBe(true);
  expect(opts.detail).toContain('TRAILMAP_DATA_DIR');
  expect(opts.detail).not.toContain('Application Support');
  await app.close();
});

test('Copy Path puts the exact path on the clipboard', async () => {
  const { BUTTONS } = di();
  const dataDir = tmp();
  seedSample(dataDir);
  const app = await launchWith(dataDir);
  const page = await app.firstWindow();
  await settle(page);

  const before = await app.evaluate(({ clipboard }) => clipboard.readText());
  try {
    await openDataInfo(app, BUTTONS.COPY);
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(path.join(dataDir, LIVE));
  } finally {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), before);
    await app.close();
  }
});

test('last-saved time matches the file and changes after an edit', async () => {
  const { formatWhen } = di();
  const dataDir = tmp();
  seedSample(dataDir);
  const live = path.join(dataDir, LIVE);
  const app = await launchWith(dataDir);
  const page = await app.firstWindow();
  await settle(page);

  const A = lastSavedLine((await openDataInfo(app)).detail);
  expect(A).toContain(formatWhen(fs.statSync(live).mtime.toISOString()));

  await page.waitForTimeout(1100); // the next write must land in a later second
  await tickMove(page);
  const B = lastSavedLine((await openDataInfo(app)).detail);
  expect(B).not.toEqual(A);
  expect(B).toContain(formatWhen(fs.statSync(live).mtime.toISOString()));
  await app.close();
});

test('snapshot count and newest time match the snapshots folder', async () => {
  const { formatWhen } = di();
  const dataDir = tmp();
  seedSample(dataDir);
  const app = await launchWith(dataDir);
  const page = await app.firstWindow();
  await settle(page);
  await tickMove(page);
  await tickMove(page);

  const { detail } = await openDataInfo(app);
  const files = snapFiles(dataDir);
  const m = detail.match(/(\d+) snapshots?\b/);
  expect(m).not.toBeNull();
  expect(Number(m[1])).toBe(files.length);
  const newest = files
    .map(f => fs.statSync(path.join(dataDir, 'snapshots', f)).mtime)
    .sort((a, b) => b - a)[0];
  expect(detail).toContain('newest ' + formatWhen(newest.toISOString()));
  await app.close();
});

test('Back Up writes a copy equal to the live document', async () => {
  const { BUTTONS } = di();
  const dataDir = tmp();
  seedSample(dataDir);
  const exportPath = path.join(dataDir, 'backup.json');
  const app = await launchWith(dataDir, { TRAILMAP_TEST_EXPORT_PATH: exportPath });
  const page = await app.firstWindow();
  await settle(page); // the live file already carries the launch-time tier bookkeeping

  await openDataInfo(app, BUTTONS.BACKUP);
  await expect.poll(() => fs.existsSync(exportPath)).toBe(true);
  const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  const live = JSON.parse(fs.readFileSync(path.join(dataDir, LIVE), 'utf8'));
  expect(exported).toEqual(live);
  await app.close();
});

test('Snapshot History runs the restore flow', async () => {
  const { BUTTONS } = di();
  const dataDir = tmp();
  seedSample(dataDir);
  let app = await launchWith(dataDir);
  let page = await app.firstWindow();
  await settle(page);

  // capture the pristine state in a snapshot, then mutate the doc
  await clickMenu(app, 'snapshot-now');
  await page.waitForTimeout(300);
  const snaps = snapFiles(dataDir).sort();
  const target = snaps[snaps.length - 1];
  const doneBefore = await page.locator('.move-row.done').count();
  await tickMove(page);
  expect(await page.locator('.move-row.done').count()).toBe(doneBefore + 1);
  await app.close();

  // relaunch with the restore hook pointed at the pristine snapshot; the
  // dialog's Snapshot History button must run that flow
  app = await launchWith(dataDir, { TRAILMAP_TEST_RESTORE_ID: target });
  page = await app.firstWindow();
  await settle(page);
  await openDataInfo(app, BUTTONS.HISTORY);
  await expect.poll(() => page.locator('.move-row.done').count()).toBe(doneBefore);
  await app.close();
});
