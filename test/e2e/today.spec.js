// v0.2 acceptance: the Today workbench — quick-add, pin via context menu,
// multiple items, unpin, persistence; due chips.
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

test('today workbench: quick-add, pin via context menu, complete, unpin, persist', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmap-today-'));
  let app = await launchWith(dataDir);
  let page = await app.firstWindow();
  await page.waitForSelector('.goal');

  // empty Today → suggestion visible with a reason
  await expect(page.locator('.suggestion .move')).toBeVisible();
  await expect(page.locator('.suggestion .why')).toContainText('because');

  // quick-add a loose to-do
  await page.locator('#quickadd').fill('Call the landlord');
  await page.locator('#quickadd').press('Enter');
  await expect(page.locator('.today-item')).toHaveCount(1);
  await expect(page.locator('.today-item .ti-label')).toHaveText('Call the landlord');
  await expect(page.locator('.today-item .ti-src')).toHaveText('loose end');
  await expect(page.locator('.suggestion')).toHaveCount(0); // suggestion yields once something is pinned

  // pin a real move via right-click context menu
  const targetRow = page.locator('.move-row:not(.done)').first();
  const targetLabel = await targetRow.locator('span').first().textContent();
  await targetRow.click({ button: 'right' });
  await page.locator('#ctx-menu button', { hasText: 'Add to Today' }).click();
  await expect(page.locator('.today-item')).toHaveCount(2);
  await expect(page.locator('.today-item .ti-label').nth(1)).toHaveText(targetLabel);
  await expect(targetRow.locator('.pin-mark')).toBeVisible(); // ☀ shows on the source row

  // complete the pinned move from Today; it stays visible, struck through
  await page.locator('.today-item').nth(1).locator('.chk').click();
  await expect(page.locator('.today-item.done')).toHaveCount(1);

  // unpin the loose one
  await page.locator('.today-item').first().locator('.ti-unpin').click();
  await expect(page.locator('.today-item')).toHaveCount(1);
  await expect(page.locator('#loose-card .move-row')).toHaveCount(1); // still lives in Loose ends

  // persistence round-trip
  await page.waitForTimeout(1200);
  await app.close();
  app = await launchWith(dataDir);
  page = await app.firstWindow();
  await page.waitForSelector('.goal');
  await expect(page.locator('.today-item')).toHaveCount(1);
  await expect(page.locator('#loose-card .move-row')).toHaveCount(1);
  await app.close();
});

test('due dates: set via context menu, chip renders, suggestion prioritizes overdue', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmap-today-'));

  // seed with an overdue move injected into the sample
  const sample = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'sample-quarter.json'), 'utf8'));
  const past = new Date(); past.setDate(past.getDate() - 3);
  const pastISO = past.toISOString().slice(0, 10);
  sample.goals[2].inits[0].moves.push({ id: 'm_due', label: 'Overdue thing', done: false, due: pastISO });
  fs.writeFileSync(path.join(dataDir, 'trailmap.json'), JSON.stringify(sample, null, 1));

  const app = await launchWith(dataDir);
  const page = await app.firstWindow();
  await page.waitForSelector('.goal');

  // overdue chip renders and the suggestion picks it over least-momentum
  await expect(page.locator('.due-chip.overdue').first()).toContainText('overdue 3d');
  await expect(page.locator('.suggestion .move')).toContainText('Overdue thing');
  await expect(page.locator('.suggestion .why')).toContainText('overdue');

  // set a due date on another move via context menu
  const row = page.locator('.move-row:not(.done)').first();
  await row.click({ button: 'right' });
  await page.locator('#ctx-menu button', { hasText: 'Set due date' }).click();
  const today = new Date().toISOString().slice(0, 10);
  await page.locator('#ctx-menu input[type="date"]').fill(today);
  await page.locator('#ctx-menu button', { hasText: 'Set due date' }).click();
  await expect(page.locator('.due-chip.duetoday').first()).toContainText('due today');
  await app.close();
});
