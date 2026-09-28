// Launch honesty: a missing live file with history is never silently replaced,
// a true first run stays quiet, and recovery notices say what really happened.
// Spec: thoughts/shared/specs/2026-09-26-data-file-visibility.md (AC-9, AC-10, AC-10b)
// Launch-time notices run before a test can stub the dialog, so under
// TRAILMAP_NOTIFY_FAKE=1 main also appends each notify() to dialogs.log.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');
const LIVE = 'trailmap.json';

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

async function settle(page) {
  await page.waitForSelector('.goal');
  await page.waitForTimeout(1200);
}

async function tickMove(page) {
  await page.locator('.move-row:not(.done) .chk').first().click();
  await page.waitForTimeout(1200);
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trailmap-missing-'));
const snapFiles = dataDir => fs.readdirSync(path.join(dataDir, 'snapshots')).filter(f => /^trailmap-.*\.json$/.test(f));
function dialogLines(dataDir) {
  const p = path.join(dataDir, 'dialogs.log');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

test('a missing live file with snapshots present is restored, not silently replaced', async () => {
  const dataDir = tmp();
  seedSample(dataDir);
  const live = path.join(dataDir, LIVE);

  // session 1: one real edit so the newest snapshot is distinguishable
  let app = await launchWith(dataDir);
  let page = await app.firstWindow();
  await settle(page);
  const doneBefore = await page.locator('.move-row.done').count();
  await tickMove(page);
  await app.close();

  const newest = snapFiles(dataDir)
    .map(f => ({ f, p: path.join(dataDir, 'snapshots', f), st: fs.statSync(path.join(dataDir, 'snapshots', f)) }))
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)[0];
  fs.unlinkSync(live);

  // session 2: SILENT takes the default answer, which is "Restore newest snapshot"
  app = await launchWith(dataDir);
  page = await app.firstWindow();
  await page.waitForSelector('.goal', { timeout: 15000 });
  expect(await page.locator('.goal').count()).toBe(3);
  expect(await page.locator('.move-row.done').count()).toBe(doneBefore + 1);
  expect(fs.existsSync(live)).toBe(true);
  const after = fs.statSync(newest.p);
  expect(after.size).toBe(newest.st.size);
  expect(after.mtimeMs).toBe(newest.st.mtimeMs);
  expect(dialogLines(dataDir)).toEqual([]); // a clean restore raises no warning
  await app.close();
});

test('a true first run starts empty with no dialog', async () => {
  test.setTimeout(20000); // a blocking dialog would hang app.close(); fail fast instead
  const dataDir = tmp();
  // Deliberately NOT silent: a synchronous question dialog would block main, so
  // trailmap:load would never return and .welcome would never render.
  const app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, TRAILMAP_DATA_DIR: dataDir, TRAILMAP_NOTIFY_FAKE: '1' },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.welcome', { timeout: 8000 });
  await page.waitForTimeout(400);
  const live = JSON.parse(fs.readFileSync(path.join(dataDir, LIVE), 'utf8'));
  expect(live.goals).toEqual([]);
  expect(snapFiles(dataDir).length).toBe(1); // the seeding save only
  expect(dialogLines(dataDir)).toEqual([]);   // no asynchronous notice either
  await app.close();
});

test('a corrupt file with no snapshots starts empty and says so', async () => {
  const dataDir = tmp();
  fs.writeFileSync(path.join(dataDir, LIVE), '{ not json');
  const app = await launchWith(dataDir);
  const page = await app.firstWindow();
  await page.waitForSelector('.welcome', { timeout: 15000 });
  await page.waitForTimeout(400);
  const aside = fs.readdirSync(dataDir).filter(f => f.startsWith('trailmap.json.corrupt-'));
  expect(aside.length).toBe(1);
  const notices = dialogLines(dataDir);
  expect(notices.length).toBe(1);
  expect(notices[0].detail).toMatch(/empty map/i);
  expect(notices[0].detail).not.toMatch(/sample/i);
  expect(notices[0].detail).toContain(path.join(dataDir, aside[0]));
  await app.close();
});

test('a missing live file whose snapshots are all unreadable says it is starting empty', async () => {
  const dataDir = tmp();
  const snapDir = path.join(dataDir, 'snapshots');
  fs.mkdirSync(snapDir);
  fs.writeFileSync(path.join(snapDir, 'trailmap-2026-01-01T00-00-00-000Z.json'), 'garbage');
  const app = await launchWith(dataDir); // SILENT chooses "Restore newest snapshot"
  const page = await app.firstWindow();
  await page.waitForSelector('.welcome', { timeout: 15000 });
  await page.waitForTimeout(400);
  const notices = dialogLines(dataDir);
  expect(notices.length).toBe(1);
  expect(notices[0].detail).toMatch(/could be read/);
  expect(notices[0].detail).toMatch(/empty map/i);
  expect(notices[0].detail).toContain(snapDir);
  await app.close();
});
