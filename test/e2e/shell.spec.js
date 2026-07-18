// M4 acceptance e2e (plan §9 M4): menu actions (via test-hook env paths),
// import snapshots-first, restore round-trip, window-state persistence.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');

function seedSample(dataDir) {
  const sample = fs.readFileSync(path.join(ROOT, 'fixtures', 'sample-quarter.json'), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'trailmap.json'), sample);
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

test('export writes a file matching the live document', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmap-shell-'));
  seedSample(dataDir);
  const exportPath = path.join(dataDir, 'exported.json');
  const app = await launchWith(dataDir, { TRAILMAP_TEST_EXPORT_PATH: exportPath });
  const page = await app.firstWindow();
  await page.waitForSelector('.goal');
  await clickMenu(app, 'export');
  await page.waitForTimeout(400);
  const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  const live = JSON.parse(fs.readFileSync(path.join(dataDir, 'trailmap.json'), 'utf8'));
  expect(exported.title).toEqual(live.title);
  expect(exported.goals.length).toEqual(live.goals.length);
  await app.close();
});

test('import accepts prototype-format data and snapshots the current state first', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmap-shell-'));
  seedSample(dataDir);
  const importPath = path.join(dataDir, 'incoming.json');
  // prototype export format: no schemaVersion, no lastNotifiedTier
  fs.writeFileSync(importPath, JSON.stringify({
    title: 'Imported From Prototype',
    goals: [{ id: 'pg', name: 'Proto goal', inits: [{ id: 'pi', name: 'Proto init', moves: [{ id: 'pm', label: 'proto move', done: false }], waiting: [] }] }],
  }));
  const app = await launchWith(dataDir, { TRAILMAP_TEST_IMPORT_PATH: importPath });
  const page = await app.firstWindow();
  await page.waitForSelector('.goal');
  await clickMenu(app, 'import');
  await expect(page.locator('#title-text')).toHaveText('Imported From Prototype');
  await expect(page.locator('.goal')).toHaveCount(1);
  const snaps = fs.readdirSync(path.join(dataDir, 'snapshots'));
  expect(snaps.some(s => s.includes('pre-import'))).toBe(true);
  const live = JSON.parse(fs.readFileSync(path.join(dataDir, 'trailmap.json'), 'utf8'));
  expect(live.schemaVersion).toBe(1); // normalized on the way in
  await app.close();
});

test('snapshot-now and restore round-trip through the menu', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmap-shell-'));
  seedSample(dataDir);
  let app = await launchWith(dataDir);
  let page = await app.firstWindow();
  await page.waitForSelector('.goal');

  // capture the pristine state in a snapshot, then mutate the doc
  await clickMenu(app, 'snapshot-now');
  await page.waitForTimeout(300);
  const snapsBefore = fs.readdirSync(path.join(dataDir, 'snapshots')).sort();
  const target = snapsBefore[snapsBefore.length - 1];
  const doneBefore = await page.locator('.move-row.done').count();
  await page.locator('.move-row:not(.done) .chk').first().click();
  await page.waitForTimeout(1200);
  expect(await page.locator('.move-row.done').count()).toBe(doneBefore + 1);
  await app.close();

  // relaunch with the restore hook pointed at the pristine snapshot
  app = await launchWith(dataDir, { TRAILMAP_TEST_RESTORE_ID: target });
  page = await app.firstWindow();
  await page.waitForSelector('.goal');
  await clickMenu(app, 'restore-snapshot');
  await page.waitForTimeout(600);
  expect(await page.locator('.move-row.done').count()).toBe(doneBefore);
  await app.close();
});

test('window size and position survive relaunch', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmap-shell-'));
  seedSample(dataDir);
  let app = await launchWith(dataDir);
  let page = await app.firstWindow();
  await page.waitForSelector('.goal');
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setBounds({ x: 40, y: 60, width: 900, height: 700 });
  });
  await page.waitForTimeout(800); // bounds debounce
  await app.close();

  app = await launchWith(dataDir);
  page = await app.firstWindow();
  await page.waitForSelector('.goal');
  const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  expect(bounds.width).toBe(900);
  expect(bounds.height).toBe(700);
  await app.close();
});
