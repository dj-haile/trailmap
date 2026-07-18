// First-run experience: an EMPTY map with a welcome state (owner decision),
// sample data one menu click away.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');

function launchWith(dataDir) {
  return electron.launch({
    args: [ROOT],
    env: { ...process.env, TRAILMAP_DATA_DIR: dataDir, TRAILMAP_SILENT_DIALOGS: '1', TRAILMAP_NOTIFY_FAKE: '1' },
  });
}

test('first run is empty: welcome state, CTA opens the goal form, quick-add works', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmap-first-'));
  const app = await launchWith(dataDir);
  const page = await app.firstWindow();
  await page.waitForSelector('.welcome');

  // seeded live file is the empty doc
  await page.waitForTimeout(400);
  const live = JSON.parse(fs.readFileSync(path.join(dataDir, 'trailmap.json'), 'utf8'));
  expect(live.goals).toEqual([]);
  expect(live.schemaVersion).toBe(1);

  await expect(page.locator('.welcome-title')).toContainText('Your map is empty');
  await expect(page.locator('.goal')).toHaveCount(0);

  // CTA jumps straight into adding a priority
  await page.locator('.welcome-cta').click();
  await expect(page.locator('#goalform')).toBeVisible();
  await page.locator('#goalform [data-f="1"]').fill('My first real priority');
  await page.locator('#goalform [data-ok]').click();
  await expect(page.locator('.goal')).toHaveCount(1);
  await expect(page.locator('.welcome')).toHaveCount(0);
  await app.close();
});

test('quick-add works from the welcome state (capture before structure)', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmap-first-'));
  const app = await launchWith(dataDir);
  const page = await app.firstWindow();
  await page.waitForSelector('.welcome');
  await page.locator('#quickadd').fill('Reply to the board email');
  await page.locator('#quickadd').press('Enter');
  await expect(page.locator('.today-item .ti-label')).toHaveText('Reply to the board email');
  await expect(page.locator('.welcome')).toHaveCount(0);
  await app.close();
});

test('File → Load Sample Data fills the map and snapshots the previous state', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmap-first-'));
  const app = await launchWith(dataDir);
  const page = await app.firstWindow();
  await page.waitForSelector('.welcome');
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('load-sample').click());
  await expect(page.locator('.goal')).toHaveCount(3);
  await expect(page.locator('#title-text')).toHaveText('Q3 — Trailmap');
  const snaps = fs.readdirSync(path.join(dataDir, 'snapshots'));
  expect(snaps.some(s => s.includes('pre-sample'))).toBe(true);
  await app.close();
});
