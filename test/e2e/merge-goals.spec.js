// Merge priorities: in edit mode a goal can be folded into another; its
// initiatives move to the end of the target (plan: thoughts/shared/plans/2026-09-20-merge-priorities.md).
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');

function seedDir() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmap-merge-'));
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

async function mergeInto(page, sourceGoal, targetName) {
  await sourceGoal.locator('.goal-edit button', { hasText: 'merge into' }).click();
  await page.locator('#ctx-menu button', { hasText: `merge into: ${targetName}` }).click();
}

test('edit mode: merge a priority into another via the picker; pins survive; persists', async () => {
  const dataDir = seedDir();
  let app = await launchWith(dataDir);
  let page = await app.firstWindow();
  await page.waitForSelector('.goal');
  await expect(page.locator('.goal')).toHaveCount(3);

  // pin a move that lives under the second priority
  const secondGoal = page.locator('.goal').nth(1);
  const pinRow = secondGoal.locator('.move-row:not(.done)').first();
  const pinLabel = await pinRow.locator('.mlabel').textContent();
  await pinRow.click({ button: 'right' });
  await page.locator('#ctx-menu button', { hasText: 'Add to Today' }).click();
  await expect(page.locator('.today-item .ti-label')).toHaveText(pinLabel);

  await page.locator('#editToggle').click();
  await mergeInto(page, secondGoal, 'Ship the platform re-architecture');

  await expect(page.locator('.goal')).toHaveCount(2);
  const first = page.locator('.goal').first();
  await expect(first.locator('.init .iname')).toHaveCount(4);
  await expect(first.locator('.init .iname').nth(2)).toHaveText('Hire two senior EMs');
  await expect(first.locator('.init .iname').nth(3)).toHaveText('Roll out career ladder v2');
  await expect(page.locator('.today-item .ti-label')).toHaveText(pinLabel);
  await page.locator('#editToggle').click();

  await page.waitForTimeout(1200);
  await app.close();
  app = await launchWith(dataDir);
  page = await app.firstWindow();
  await page.waitForSelector('.goal');
  await expect(page.locator('.goal')).toHaveCount(2);
  await expect(page.locator('.goal').first().locator('.init .iname')).toHaveCount(4);
  await expect(page.locator('.today-item .ti-label')).toHaveText(pinLabel);
  await app.close();
});

test('merge control is hidden when only one priority remains', async () => {
  const dataDir = seedDir();
  const app = await launchWith(dataDir);
  const page = await app.firstWindow();
  await page.waitForSelector('.goal');
  await page.locator('#editToggle').click();

  await expect(page.locator('.goal-edit button', { hasText: 'merge into' })).toHaveCount(3);
  await mergeInto(page, page.locator('.goal').nth(2), 'Ship the platform re-architecture');
  await mergeInto(page, page.locator('.goal').nth(1), 'Ship the platform re-architecture');
  await expect(page.locator('.goal')).toHaveCount(1);
  await expect(page.locator('.goal').first().locator('.init .iname')).toHaveCount(6);
  await expect(page.locator('.goal-edit button', { hasText: 'merge into' })).toHaveCount(0);
  await expect(page.locator('.goal-edit button', { hasText: 'rename' })).toHaveCount(1); // other controls intact
  await app.close();
});
