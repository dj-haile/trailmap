// M3 acceptance e2e (plan §9 M3): a fixture with 4d/6d/11d chips fires exactly
// two notifications on launch, and a relaunch fires none again.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };

function fixtureDoc() {
  return {
    schemaVersion: 1,
    title: 'Notify Test',
    goals: [{
      id: 'g', name: 'Goal', sub: '',
      inits: [{
        id: 'i', name: 'Init',
        moves: [
          { id: 'm', label: 'open move', done: false },
          { id: 'm_due_today', label: 'due today move', done: false, due: daysAgo(0), lastDueTier: 0 },
          { id: 'm_overdue', label: 'overdue move', done: false, due: daysAgo(2), lastDueTier: 0 },
          { id: 'm_future', label: 'future move', done: false, due: '2099-01-01', lastDueTier: 0 },
        ],
        waiting: [
          { id: 'w4',  who: 'Fresh',  what: 'recent thing', since: daysAgo(4),  lastNotifiedTier: 0 },
          { id: 'w6',  who: 'Priya',  what: 'headcount',    since: daysAgo(6),  lastNotifiedTier: 0 },
          { id: 'w11', who: 'Sam',    what: 'dashboard',    since: daysAgo(11), lastNotifiedTier: 0 },
        ],
      }],
    }],
  };
}

function launchWith(dataDir) {
  return electron.launch({
    args: [ROOT],
    env: { ...process.env, TRAILMAP_DATA_DIR: dataDir, TRAILMAP_NOTIFY_FAKE: '1', TRAILMAP_SILENT_DIALOGS: '1' },
  });
}

test('waiting chips (2) + due moves (2) fire exactly four notifications, then never repeat', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmap-notify-'));
  fs.writeFileSync(path.join(dataDir, 'trailmap.json'), JSON.stringify(fixtureDoc(), null, 1));
  const logPath = path.join(dataDir, 'notifications.log');

  // launch 1: exactly two fire (tier1 for 6d, tier2 for 11d)
  let app = await launchWith(dataDir);
  let page = await app.firstWindow();
  await page.waitForSelector('.goal');
  await page.waitForTimeout(1500); // check + debounced tier persist
  await app.close();

  const lines1 = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse);
  expect(lines1.length).toBe(4);
  const chips = lines1.filter(l => l.kind !== 'due');
  const dues = lines1.filter(l => l.kind === 'due');
  expect(chips.map(l => [l.who, l.tier]).sort()).toEqual([['Priya', 1], ['Sam', 2]]);
  expect(dues.map(l => [l.what, l.tier]).sort()).toEqual([['due today move', 1], ['overdue move', 2]]);

  // tiers persisted to the live file
  const live = JSON.parse(fs.readFileSync(path.join(dataDir, 'trailmap.json'), 'utf8'));
  const tiers = Object.fromEntries(live.goals[0].inits[0].waiting.map(w => [w.id, w.lastNotifiedTier]));
  expect(tiers).toEqual({ w4: 0, w6: 1, w11: 2 });
  const dueTiers = Object.fromEntries(live.goals[0].inits[0].moves.filter(m => m.due).map(m => [m.id, m.lastDueTier]));
  expect(dueTiers).toEqual({ m_due_today: 1, m_overdue: 2, m_future: 0 });

  // launch 2: nothing new fires
  app = await launchWith(dataDir);
  page = await app.firstWindow();
  await page.waitForSelector('.goal');
  await page.waitForTimeout(1500);
  await app.close();

  const lines2 = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  expect(lines2.length).toBe(4);
});
