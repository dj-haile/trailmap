import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JsonProvider } = require('../../electron/storage/json-provider.js');

const SEED = path.join(path.dirname(new URL(import.meta.url).pathname), '../../fixtures/sample-quarter.json');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'trailmap-test-')); }
function makeProvider(opts = {}) {
  const dir = tmpdir();
  return { dir, p: new JsonProvider(dir, { seedPath: SEED, ...opts }) };
}
const minimalDoc = () => ({
  schemaVersion: 1, title: 'T',
  goals: [{ id: 'g', name: 'g', sub: '', inits: [{ id: 'i', name: 'i', moves: [{ id: 'm', label: 'm', done: false }], waiting: [] }] }],
});

test('first load seeds the sample and writes the live file', async () => {
  const { dir, p } = makeProvider();
  const doc = await p.load();
  assert.equal(doc.goals.length, 3);
  assert.ok(fs.existsSync(path.join(dir, 'trailmap.json')));
  assert.ok(fs.readdirSync(path.join(dir, 'snapshots')).length >= 1, 'seeding save also snapshots');
});

test('save is atomic: no .tmp left behind, live file always parses', async () => {
  const { dir, p } = makeProvider();
  await p.load();
  await p.save(minimalDoc());
  assert.ok(!fs.existsSync(path.join(dir, 'trailmap.json.tmp')));
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'trailmap.json'), 'utf8'));
  assert.equal(onDisk.title, 'T');
});

test('save refuses an invalid document', async () => {
  const { p } = makeProvider();
  await p.load();
  await assert.rejects(() => p.save({ title: 'bad', goals: 'nope' }), /refusing to save/);
});

test('corrupt live file throws CORRUPT; markCorrupt sets it aside', async () => {
  const { dir, p } = makeProvider();
  await p.load();
  fs.writeFileSync(path.join(dir, 'trailmap.json'), '{ definitely not json');
  const p2 = new JsonProvider(dir, { seedPath: SEED });
  await assert.rejects(() => p2.load(), e => e.code === 'CORRUPT');
  const aside = p2.markCorrupt();
  assert.ok(fs.existsSync(aside));
  assert.ok(path.basename(aside).startsWith('trailmap.json.corrupt-'));
});

test('structurally invalid (but parseable) file is CORRUPT too', async () => {
  const { dir, p } = makeProvider();
  await p.load();
  fs.writeFileSync(path.join(dir, 'trailmap.json'), JSON.stringify({ title: 't', goals: [{ nope: true }] }));
  const p2 = new JsonProvider(dir, { seedPath: SEED });
  await assert.rejects(() => p2.load(), e => e.code === 'CORRUPT');
});

test('every save produces a snapshot; snapshots list newest-first and round-trip', async () => {
  const { p } = makeProvider();
  await p.load();
  const d = minimalDoc();
  await p.save(d);
  d.title = 'T2';
  await p.save(d);
  const snaps = await p.listSnapshots();
  assert.ok(snaps.length >= 3);
  const restored = await p.loadSnapshot(snaps[0].id);
  assert.equal(restored.title, 'T2');
});

test('loadSnapshot rejects path traversal', async () => {
  const { p } = makeProvider();
  await p.load();
  await assert.rejects(() => p.loadSnapshot('../trailmap.json'), /bad snapshot id/);
});

test('tiered pruning: 24h keep-all, daily thereafter, 90d horizon (clock-mocked)', async () => {
  const NOW = new Date('2026-07-18T12:00:00Z');
  const { dir, p } = makeProvider({ now: () => NOW });
  await p.load();
  const snapDir = path.join(dir, 'snapshots');
  const mk = (name, when) => {
    const f = path.join(snapDir, name);
    fs.writeFileSync(f, '{}');
    fs.utimesSync(f, when, when);
    return name;
  };
  const H = 3600 * 1000, D = 24 * H;
  const t = ms => new Date(NOW.getTime() - ms);
  const recentA = mk('trailmap-recent-a.json', t(2 * H));
  const recentB = mk('trailmap-recent-b.json', t(20 * H));
  const old1a  = mk('trailmap-old1-a.json', t(3 * D + 2 * H)); // same old day, older
  const old1b  = mk('trailmap-old1-b.json', t(3 * D + 1 * H)); // same old day, newest → kept
  const ancient = mk('trailmap-ancient.json', t(120 * D));      // beyond 90d → dropped
  p._prune();
  const left = new Set(fs.readdirSync(snapDir));
  assert.ok(left.has(recentA) && left.has(recentB), 'all <24h kept');
  assert.ok(left.has(old1b), 'newest of an older day kept');
  assert.ok(!left.has(old1a), 'older same-day snapshot pruned');
  assert.ok(!left.has(ancient), '>90d pruned');
});

test('disk failure on rename leaves the previous live file intact', async () => {
  const { dir, p } = makeProvider();
  await p.load();
  await p.save(minimalDoc());
  const before = fs.readFileSync(path.join(dir, 'trailmap.json'), 'utf8');
  const failingFs = new Proxy(fs, {
    get(target, prop) {
      if (prop === 'renameSync') {
        return (a, b) => {
          if (String(a).endsWith('trailmap.json.tmp')) {
            const e = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; throw e;
          }
          return target.renameSync(a, b);
        };
      }
      return target[prop];
    },
  });
  const p2 = new JsonProvider(dir, { seedPath: SEED, fs: failingFs });
  await p2.load();
  const d = minimalDoc(); d.title = 'WILL FAIL';
  await assert.rejects(() => p2.save(d), /ENOSPC/);
  assert.equal(fs.readFileSync(path.join(dir, 'trailmap.json'), 'utf8'), before, 'old file untouched');
});

test('unknown fields survive a save/load round-trip (forward compat)', async () => {
  const { p } = makeProvider();
  await p.load();
  const d = minimalDoc();
  d.futureTop = { a: 1 };
  d.goals[0].futureGoal = 'x';
  await p.save(d);
  const p2 = new JsonProvider(p.dir, { seedPath: SEED });
  const back = await p2.load();
  assert.deepEqual(back.futureTop, { a: 1 });
  assert.equal(back.goals[0].futureGoal, 'x');
});

test('parseExternal accepts prototype-format content and rejects garbage', async () => {
  const { p } = makeProvider();
  await p.load();
  const proto = { title: 'Q3', goals: [{ id: 'g', name: 'g', inits: [] }] };
  const ok = await p.parseExternal(JSON.stringify(proto));
  assert.ok(ok.doc);
  assert.equal(ok.doc.schemaVersion, 1);
  const bad = await p.parseExternal('{ nope');
  assert.equal(bad.doc, null);
});
