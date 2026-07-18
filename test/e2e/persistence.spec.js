// M2 acceptance e2e (plan §9 M2): persistence round-trip + external-modification safety.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');

function launchWith(dataDir) {
  return electron.launch({
    args: [ROOT],
    env: { ...process.env, TRAILMAP_DATA_DIR: dataDir },
  });
}

test('edits survive quit and relaunch', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmap-e2e-'));

  // session 1: first run seeds sample; complete the first open move
  let app = await launchWith(dataDir);
  let page = await app.firstWindow();
  await page.waitForSelector('.goal');
  const doneBefore = await page.locator('.move-row.done').count();
  const label = await page.locator('.move-row:not(.done) span').first().textContent();
  await page.locator('.move-row:not(.done) .chk').first().click();
  await page.waitForTimeout(1200); // debounce (500ms) + write
  await app.close();

  // the live file exists, is readable JSON, and snapshots accumulated
  const live = JSON.parse(fs.readFileSync(path.join(dataDir, 'trailmap.json'), 'utf8'));
  expect(live.schemaVersion).toBe(1);
  expect(fs.readdirSync(path.join(dataDir, 'snapshots')).length).toBeGreaterThan(0);

  // session 2: the completion is still there
  app = await launchWith(dataDir);
  page = await app.firstWindow();
  await page.waitForSelector('.goal');
  expect(await page.locator('.move-row.done').count()).toBe(doneBefore + 1);
  const doneLabels = await page.locator('.move-row.done span').allTextContents();
  expect(doneLabels).toContain(label);
  await app.close();
});

test('external edits to the data file appear in the running app', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmap-e2e-'));
  const app = await launchWith(dataDir);
  const page = await app.firstWindow();
  await page.waitForSelector('.goal');
  await page.waitForTimeout(300);

  // out-of-band edit (what Dj-or-Claude editing the file looks like)
  const livePath = path.join(dataDir, 'trailmap.json');
  const doc = JSON.parse(fs.readFileSync(livePath, 'utf8'));
  doc.title = 'Edited From Outside';
  doc.goals[0].name = 'Renamed externally';
  fs.writeFileSync(livePath, JSON.stringify(doc, null, 1));

  await expect(page.locator('#title-text')).toHaveText('Edited From Outside', { timeout: 5000 });
  await expect(page.locator('.gname').first()).toHaveText('Renamed externally');
  await app.close();
});

test('a corrupted live file recovers from the latest snapshot on launch', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmap-e2e-'));

  // session 1: seed + one real edit so a good snapshot exists
  let app = await launchWith(dataDir);
  let page = await app.firstWindow();
  await page.waitForSelector('.goal');
  await page.locator('.move-row:not(.done) .chk').first().click();
  await page.waitForTimeout(1200);
  await app.close();

  // corrupt the live file by hand
  const livePath = path.join(dataDir, 'trailmap.json');
  fs.writeFileSync(livePath, '{ this is not json at all');

  // session 2: app must come up with recovered data, corrupt file set aside
  app = await launchWith(dataDir);
  page = await app.firstWindow();
  await page.waitForSelector('.goal', { timeout: 15000 });
  expect(await page.locator('.goal').count()).toBe(3);
  const aside = fs.readdirSync(dataDir).filter(f => f.startsWith('trailmap.json.corrupt-'));
  expect(aside.length).toBe(1);
  const relived = JSON.parse(fs.readFileSync(livePath, 'utf8'));
  expect(relived.schemaVersion).toBe(1);
  await app.close();
});
