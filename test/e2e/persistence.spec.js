// M2 acceptance e2e (plan §9 M2): persistence round-trip + external-modification safety.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');

function seedSample(dataDir) {
  const sample = fs.readFileSync(path.join(ROOT, 'fixtures', 'sample-quarter.json'), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'trailmap.json'), sample);
}

function launchWith(dataDir) {
  // Deliberately NOT TRAILMAP_SILENT_DIALOGS: the app must reload an external
  // edit without asking anything when the user has no unsaved edits. If it
  // wrongly raises the "which side wins" prompt (e.g. for its own notification
  // bookkeeping), the modal blocks main and the external-edit test fails —
  // silencing dialogs here would hide that regression.
  return electron.launch({
    args: [ROOT],
    env: { ...process.env, TRAILMAP_DATA_DIR: dataDir, TRAILMAP_NOTIFY_FAKE: '1' },
  });
}

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
const logLines = p => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).length : 0);

test('edits survive quit and relaunch', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmap-e2e-'));
  seedSample(dataDir);

  // session 1: complete the first open move
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
  seedSample(dataDir);
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

test('an external edit never makes a notification fire twice', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmap-e2e-'));
  const livePath = path.join(dataDir, 'trailmap.json');
  const logPath = path.join(dataDir, 'notifications.log');

  // a chip old enough to notify (tier 2) the moment the app launches
  const sample = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'sample-quarter.json'), 'utf8'));
  sample.goals[0].inits[0].waiting.push({ id: 'w_ext', who: 'Ada', what: 'the review', since: daysAgo(12) });
  fs.writeFileSync(livePath, JSON.stringify(sample, null, 1));

  let app = await launchWith(dataDir);
  let page = await app.firstWindow();
  await page.waitForSelector('.goal');
  await expect.poll(() => logLines(logPath)).toBeGreaterThan(0); // launch check fired
  const firedAtLaunch = logLines(logPath);

  // External edit saved from a copy that predates the app's tier bookkeeping —
  // an editor buffer opened before launch. It must win, and the tiers the app
  // already fired must be re-recorded on it rather than fire again.
  const stale = JSON.parse(JSON.stringify(sample));
  stale.title = 'Stale Buffer Save';
  fs.writeFileSync(livePath, JSON.stringify(stale, null, 1));
  await expect(page.locator('#title-text')).toHaveText('Stale Buffer Save', { timeout: 5000 });
  await page.waitForTimeout(1200); // debounced bookkeeping re-save
  await app.close();

  const live = JSON.parse(fs.readFileSync(livePath, 'utf8'));
  expect(live.title).toBe('Stale Buffer Save');
  expect(live.goals[0].inits[0].waiting.find(w => w.id === 'w_ext').lastNotifiedTier).toBe(2);

  // relaunch: nothing new fires
  app = await launchWith(dataDir);
  page = await app.firstWindow();
  await page.waitForSelector('.goal');
  await page.waitForTimeout(1500);
  await app.close();
  expect(logLines(logPath)).toBe(firedAtLaunch);
});

test('a corrupted live file recovers from the latest snapshot on launch', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmap-e2e-'));
  seedSample(dataDir);

  // session 1: one real edit so a good snapshot exists
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
