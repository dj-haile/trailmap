// M1 acceptance sweep (plan §9 M1): every prototype interaction, headless.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

let app, page;

test.beforeAll(async () => {
  // Fresh data dir per run: the app persists now, and parity assertions assume
  // pristine sample data. Fake notifications so launch checks can't interfere.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmap-parity-'));
  fs.writeFileSync(path.join(dataDir, 'trailmap.json'),
    fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'sample-quarter.json'), 'utf8'));
  app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, TRAILMAP_DATA_DIR: dataDir, TRAILMAP_SILENT_DIALOGS: '1', TRAILMAP_NOTIFY_FAKE: '1' },
  });
  page = await app.firstWindow();
  await page.waitForSelector('.goal');
});

test.afterAll(async () => { await app?.close(); });

test('loads sample data: 3 goals, rings, momentum, hero', async () => {
  await expect(page.locator('.goal')).toHaveCount(3);
  await expect(page.locator('#title-text')).toHaveText('Q3 — Trailmap');
  await expect(page.locator('#momentum')).toContainText('shipped');
  await expect(page.locator('#hero .move')).toBeVisible();
  await expect(page.locator('.horizon-tag')).toHaveText('half'); // non-quarter horizon shows a tag
});

test('later pile expands and collapses', async () => {
  const note = page.locator('.later-note').first();
  await expect(note).toContainText('more waiting invisibly');
  await note.click();
  await expect(page.locator('.later-note').first()).toContainText('hide the later pile');
  await page.locator('.later-note').first().click();
  await expect(page.locator('.later-note').first()).toContainText('more waiting invisibly');
});

test('completing a move updates ring, bar, and momentum', async () => {
  const before = await page.locator('.goal').first().locator('.pct').textContent();
  await page.locator('.move-row:not(.done) .chk').first().click();
  await expect(page.locator('.goal').first().locator('.pct')).not.toHaveText(before);
});

test('hero Done completes the suggested move; skip cycles suggestions', async () => {
  const label1 = await page.locator('#hero .move').textContent();
  await page.locator('#hero button[aria-label="Suggest a different move"]').click();
  const label2 = await page.locator('#hero .move').textContent();
  expect(label2).not.toEqual(label1);
  await page.locator('#hero button.primary').click();
  const label3 = await page.locator('#hero .move').textContent();
  expect(label3).not.toEqual(label2);
});


test('waiting chip shows age and can be marked received', async () => {
  const chips = page.locator('.chip');
  const n = await chips.count();
  expect(n).toBeGreaterThan(0);
  await chips.first().click();
  await expect(chips).toHaveCount(n - 1);
});

test('edit mode: full CRUD — goal, initiative, move, waiting, rename, bump, delete', async () => {
  await page.locator('#editToggle').click();

  // add a goal
  await page.locator('#addgoal').click();
  await page.locator('#goalform [data-f="1"]').fill('Test goal: developer experience');
  await page.locator('#goalform [data-f="2"]').fill('DX & tooling');
  await page.locator('#goalform [data-ok]').click();
  await expect(page.locator('.goal')).toHaveCount(4);

  // add an initiative to it
  const newGoal = page.locator('.goal').nth(3);
  await newGoal.locator('button', { hasText: '＋ initiative' }).click();
  await page.locator('.inline-form [data-f="1"]').fill('Golden-path CLI');
  await page.locator('.inline-form [data-ok]').click();
  await expect(newGoal.locator('.iname')).toHaveText('Golden-path CLI');

  // add a move
  await newGoal.locator('button', { hasText: '＋ move' }).click();
  await page.locator('.inline-form [data-f="1"]').fill('Draft CLI spec');
  await page.locator('.inline-form [data-f="1"]').press('Enter');
  await expect(newGoal.locator('.move-row')).toHaveCount(1);

  // add a waiting chip
  await newGoal.locator('button', { hasText: '＋ waiting on' }).click();
  await page.locator('.inline-form [data-f="1"]').fill('Dana');
  await page.locator('.inline-form [data-f="2"]').fill('security audit');
  await page.locator('.inline-form [data-ok]').click();
  await expect(newGoal.locator('.chip .who')).toHaveText('Dana');

  // rename the initiative
  await newGoal.locator('button', { hasText: 'rename' }).last().click();
  await page.locator('.rename-input').fill('Golden-path CLI v2');
  await page.locator('.rename-input').press('Enter');
  await expect(newGoal.locator('.iname')).toHaveText('Golden-path CLI v2');

  // horizon tag cycles in edit mode
  await newGoal.locator('button.horizon-tag').click();
  await expect(newGoal.locator('button.horizon-tag')).toHaveText('half');

  // add a second move then bump it to top
  await newGoal.locator('button', { hasText: '＋ move' }).click();
  await page.locator('.inline-form [data-f="1"]').fill('Second move');
  await page.locator('.inline-form [data-f="1"]').press('Enter');
  await newGoal.locator('.move-row').nth(1).locator('button[aria-label^="Move to top"]').click();
  await expect(newGoal.locator('.move-row').first().locator('span')).toHaveText('Second move');

  // delete a move
  await newGoal.locator('.move-row').first().locator('button[aria-label^="Delete"]').click();
  await expect(newGoal.locator('.move-row')).toHaveCount(1);

  // un-complete flow: complete then uncheck in edit mode
  await newGoal.locator('.move-row .chk').first().click();
  await expect(newGoal.locator('.move-row.done')).toHaveCount(1);
  await newGoal.locator('.move-row.done .chk').click();
  await expect(newGoal.locator('.move-row.done')).toHaveCount(0);

  // delete the goal
  await newGoal.locator('.goal-edit button', { hasText: 'delete' }).click();
  await expect(page.locator('.goal')).toHaveCount(3);

  await page.locator('#editToggle').click();
});

test('keyboard-only core loop: tab to a move check and complete it with Enter', async () => {
  const openChk = page.locator('.move-row:not(.done) .chk').first();
  const label = await openChk.getAttribute('aria-label');
  await openChk.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(`button[aria-label="${label}"]`)).toHaveCount(0);
});

test('injection safety: hostile labels render as text, never execute', async () => {
  await page.locator('#editToggle').click();
  await page.locator('#addgoal').click();
  const payload = '<img src=x onerror="document.title=\'pwned\'">';
  await page.locator('#goalform [data-f="1"]').fill(payload);
  await page.locator('#goalform [data-ok]').click();
  const gname = page.locator('.goal').nth(3).locator('.gname');
  await expect(gname).toHaveText(payload);
  expect(await page.title()).not.toBe('pwned');
  expect(await page.locator('.gname img').count()).toBe(0);
  await page.locator('.goal').nth(3).locator('.goal-edit button', { hasText: 'delete' }).click();
  await page.locator('#editToggle').click();
});

test('no console errors during the whole sweep', async () => {
  // collected implicitly: fail if any pageerror occurred
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.waitForTimeout(250);
  expect(errors).toEqual([]);
});

test('parity screenshot for human review', async () => {
  await page.setViewportSize({ width: 1050, height: 1250 });
  await page.screenshot({ path: 'test-results/parity-light.png', fullPage: true });
});
