import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dueTier, pendingDueNotifications, applyDueTier, pickTodaysMove,
  pruneToday, todayItems, momentumCounts, validateDoc, normalizeDoc, findMoveById,
} from '../../renderer/logic.js';

const TODAY = new Date('2026-07-20T12:00:00');
const mv = (id, extra = {}) => ({ id, label: id, done: false, ...extra });

function doc({ goals = [], loose = [], today = [] } = {}) {
  return { schemaVersion: 1, title: 't', goals, loose, today };
}
const goal = (id, moves, extra = {}) =>
  ({ id, name: id, sub: '', inits: [{ id: id + '_i', name: id + '_i', moves, waiting: [] }], ...extra });

// ---------- due tiers ----------
test('dueTier: none / today / overdue; done moves never due', () => {
  assert.equal(dueTier(mv('a'), TODAY), 0);
  assert.equal(dueTier(mv('a', { due: '2026-07-25' }), TODAY), 0);
  assert.equal(dueTier(mv('a', { due: '2026-07-20' }), TODAY), 1);
  assert.equal(dueTier(mv('a', { due: '2026-07-15' }), TODAY), 2);
  assert.equal(dueTier(mv('a', { due: '2026-07-15', done: true }), TODAY), 0);
});

test('pendingDueNotifications fires once per tier, covers loose moves', () => {
  const d = doc({
    goals: [goal('g', [mv('m1', { due: '2026-07-20' })])],
    loose: [mv('m2', { due: '2026-07-10' })],
  });
  let p = pendingDueNotifications(d, TODAY);
  assert.deepEqual(p.map(x => [x.moveId, x.tier, x.initName]), [['m1', 1, 'g_i'], ['m2', 2, 'loose ends']]);
  p.forEach(x => applyDueTier(d, x.moveId, x.tier));
  assert.deepEqual(pendingDueNotifications(d, TODAY), [], 'never repeats');
  // next day: m1 becomes overdue → exactly one new notification
  const TOMORROW = new Date('2026-07-21T12:00:00');
  p = pendingDueNotifications(d, TOMORROW);
  assert.deepEqual(p.map(x => [x.moveId, x.tier]), [['m1', 2]]);
});

test('completing a due move silences it', () => {
  const d = doc({ goals: [goal('g', [mv('m1', { due: '2026-07-10' })])] });
  d.goals[0].inits[0].moves[0].done = true;
  assert.deepEqual(pendingDueNotifications(d, TODAY), []);
});

// ---------- suggestion priority ----------
test('suggestion: overdue beats due-today beats least momentum', () => {
  const behind = goal('behind', [mv('b1')]);                          // 0% ring
  const ahead = goal('ahead', [mv('a0', { done: true, doneAt: '2026-07-01' }), mv('a1', { due: '2026-07-20' }), mv('a2', { due: '2026-07-01' })]);
  const d = doc({ goals: [behind, ahead] });
  assert.equal(pickTodaysMove(d, 0, TODAY).move.id, 'a2', 'overdue first even from the ahead goal');
  assert.equal(pickTodaysMove(d, 1, TODAY).move.id, 'a1', 'then due-today');
  assert.equal(pickTodaysMove(d, 2, TODAY).move.id, 'b1', 'then least momentum');
});

// ---------- today list ----------
test('todayItems resolves refs across goals and loose; dead refs are skipped', () => {
  const d = doc({
    goals: [goal('g', [mv('m1')])],
    loose: [mv('m2')],
    today: [
      { id: 't1', moveId: 'm1', addedOn: '2026-07-20' },
      { id: 't2', moveId: 'm2', addedOn: '2026-07-20' },
      { id: 't3', moveId: 'ghost', addedOn: '2026-07-20' },
    ],
  });
  const items = todayItems(d);
  assert.deepEqual(items.map(x => x.move.id), ['m1', 'm2']);
  assert.equal(items[1].init, null, 'loose item has no initiative');
});

test('pruneToday drops done-before-today and dead refs, keeps today’s work', () => {
  const d = doc({
    goals: [goal('g', [
      mv('done-yesterday', { done: true, doneAt: '2026-07-19' }),
      mv('done-today', { done: true, doneAt: '2026-07-20' }),
      mv('open'),
    ])],
    today: [
      { id: 't1', moveId: 'done-yesterday', addedOn: '2026-07-19' },
      { id: 't2', moveId: 'done-today', addedOn: '2026-07-20' },
      { id: 't3', moveId: 'open', addedOn: '2026-07-19' },
      { id: 't4', moveId: 'deleted-move', addedOn: '2026-07-19' },
    ],
  });
  assert.equal(pruneToday(d, TODAY), true);
  assert.deepEqual(d.today.map(t => t.moveId), ['done-today', 'open']);
  assert.equal(pruneToday(d, TODAY), false, 'idempotent');
});

// ---------- loose ends ----------
test('loose moves count toward momentum', () => {
  const d = doc({ loose: [mv('l1', { done: true, doneAt: '2026-07-19' })] });
  const mc = momentumCounts(d, TODAY);
  assert.equal(mc.quarter, 1);
  assert.equal(mc.week, 1);
});

test('findMoveById reaches loose moves', () => {
  const d = doc({ loose: [mv('l1')] });
  assert.equal(findMoveById(d, 'l1').move.id, 'l1');
});

// ---------- validation ----------
test('validateDoc accepts today/loose/due and rejects malformed versions', () => {
  const good = doc({
    goals: [goal('g', [mv('m1', { due: '2026-08-01' })])],
    loose: [mv('l1')],
    today: [{ id: 't1', moveId: 'm1' }],
  });
  assert.deepEqual(validateDoc(good), []);
  assert.notEqual(validateDoc(doc({ goals: [goal('g', [mv('m', { due: 'whenever' })])] })).length, 0);
  assert.notEqual(validateDoc({ ...doc(), loose: 'nope' }).length, 0);
  assert.notEqual(validateDoc({ ...doc(), today: [{ id: 't' }] }).length, 0);
});

test('normalizeDoc defaults today and loose for older files', () => {
  const old = { title: 'Q3', goals: [] };
  const n = normalizeDoc(old);
  assert.deepEqual(n.loose, []);
  assert.deepEqual(n.today, []);
});
