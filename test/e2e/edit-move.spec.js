// Editable moves: a move's label can be changed from the right-click menu and
// from the edit-mode row controls (plan: thoughts/shared/plans/2026-09-13-editable-moves.md).
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');

function seedDir() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmap-edit-'));
  fs.writeFileSync(path.join(dataDir, 'trailmap.json'),
    fs.readFileSync(path.join(ROOT, 'fixtures', 'sample-quarter.json'), 'utf8'));
  return dataDir;
}

function launchWith(dataDir) {
  return electron.launch({
    args: [ROOT],
    env: { ...process.env, TRAILMAP_DATA_DIR: dataDir, TRAILMAP_SILENT_DIALOGS: '1', TRAILMAP_NOTIFY_FAKE: '1' },
  });
}

test('context menu: Edit label renames a move and survives relaunch', async () => {
  const dataDir = seedDir();
  let app = await launchWith(dataDir);
  let page = await app.firstWindow();
  await page.waitForSelector('.goal');

  const row = page.locator('.move-row:not(.done)').first();
  await row.click({ button: 'right' });
  await page.locator('#ctx-menu button', { hasText: 'Edit label' }).click();
  await page.locator('.rename-input').fill('Renamed via menu');
  await page.locator('.rename-input').press('Enter');
  await expect(page.locator('.move-row:not(.done)').first().locator('.mlabel')).toHaveText('Renamed via menu');

  // persistence round-trip (main debounces saves by 500 ms)
  await page.waitForTimeout(1200);
  await app.close();
  app = await launchWith(dataDir);
  page = await app.firstWindow();
  await page.waitForSelector('.goal');
  await expect(page.locator('.move-row .mlabel', { hasText: 'Renamed via menu' })).toHaveCount(1);
  await app.close();
});

test('edit mode: edit control renames an initiative move and a loose end; Today reflects it', async () => {
  const dataDir = seedDir();
  const app = await launchWith(dataDir);
  const page = await app.firstWindow();
  await page.waitForSelector('.goal');

  // a pinned loose end, so Today has a row that mirrors it
  await page.locator('#quickadd').fill('Call the landlord');
  await page.locator('#quickadd').press('Enter');
  await expect(page.locator('.today-item .ti-label')).toHaveText('Call the landlord');

  await page.locator('#editToggle').click();

  // initiative move via the ✎ control
  const row = page.locator('.goal .move-row:not(.done)').first();
  await row.locator('button[aria-label^="Edit:"]').click();
  await page.locator('.rename-input').fill('Renamed in edit mode');
  await page.locator('.rename-input').press('Enter');
  await expect(page.locator('.goal .move-row:not(.done)').first().locator('.mlabel')).toHaveText('Renamed in edit mode');

  // loose end via the ✎ control; the Today row mirrors the same move
  await page.locator('#loose-card .move-row button[aria-label^="Edit:"]').click();
  await page.locator('.rename-input').fill('Landlord: renew lease');
  await page.locator('.rename-input').press('Enter');
  await expect(page.locator('#loose-card .move-row .mlabel')).toHaveText('Landlord: renew lease');
  await expect(page.locator('.today-item .ti-label')).toHaveText('Landlord: renew lease');

  await page.locator('#editToggle').click();
  await app.close();
});

test('renamed label with an injection payload renders as literal text', async () => {
  const dataDir = seedDir();
  const app = await launchWith(dataDir);
  const page = await app.firstWindow();
  await page.waitForSelector('.goal');

  await page.locator('#editToggle').click();
  const payload = '<img src=x onerror="document.title=\'pwned\'">';
  const row = page.locator('.goal .move-row:not(.done)').first();
  await row.locator('button[aria-label^="Edit:"]').click();
  await page.locator('.rename-input').fill(payload);
  await page.locator('.rename-input').press('Enter');
  const first = page.locator('.goal .move-row:not(.done)').first();
  await expect(first.locator('.mlabel')).toHaveText(payload);
  expect(await first.locator('img').count()).toBe(0);
  expect(await page.title()).not.toBe('pwned');
  await page.locator('#editToggle').click();
  await app.close();
});
