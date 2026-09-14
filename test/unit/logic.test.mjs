import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSTANTS, ageDays, ageClass, initPct, goalPct, momentumCounts,
  quarterStartISO, pickTodaysMove, candidateMoves, goalHorizon, nextHorizon,
  validateDoc, normalizeDoc,
} from '../../renderer/logic.js';
import * as L from '../../renderer/logic.js';

const D = iso => new Date(iso + 'T12:00:00');

function doc(goals) { return { schemaVersion: 1, title: 't', goals }; }
function goal(id, moves, extra = {}) {
  return { id, name: id, sub: '', inits: [{ id: id + '_i', name: id + '_i', moves, waiting: [] }], ...extra };
}
const mv = (id, done, doneAt) => ({ id, label: id, done, ...(doneAt ? { doneAt } : {}) });

// ---------- percentages ----------
test('initPct / goalPct basic math and empty cases', () => {
  const g = goal('g1', [mv('a', true, '2026-07-01'), mv('b', false), mv('c', false), mv('d', false)]);
  assert.equal(initPct(g.inits[0]), 0.25);
  assert.equal(goalPct(g), 0.25);
  assert.equal(goalPct({ id: 'e', name: 'e', inits: [] }), 0);
  assert.equal(initPct({ moves: [] }), 0);
});

// ---------- aging ----------
test('ageDays and tier classes, including DST transitions', () => {
  assert.equal(ageDays('2026-07-10', D('2026-07-13')), 3);
  assert.equal(ageDays('2026-07-13', D('2026-07-13')), 0);
  assert.equal(ageDays('2026-07-20', D('2026-07-13')), 0, 'future dates clamp to 0');
  // US DST spring-forward (2026-03-08) and fall-back (2026-11-01) must not skew day counts
  assert.equal(ageDays('2026-03-06', D('2026-03-10')), 4);
  assert.equal(ageDays('2026-10-30', D('2026-11-03')), 4);
  assert.equal(ageClass(0), 'ok');
  assert.equal(ageClass(CONSTANTS.AGE_WARN_DAYS - 1), 'ok');
  assert.equal(ageClass(CONSTANTS.AGE_WARN_DAYS), 'warn');
  assert.equal(ageClass(CONSTANTS.AGE_CRIT_DAYS), 'crit');
});

// ---------- quarter windows ----------
test('quarterStartISO across all quarters and year boundary', () => {
  assert.equal(quarterStartISO(D('2026-01-15')), '2026-01-01');
  assert.equal(quarterStartISO(D('2026-03-31')), '2026-01-01');
  assert.equal(quarterStartISO(D('2026-04-01')), '2026-04-01');
  assert.equal(quarterStartISO(D('2026-07-13')), '2026-07-01');
  assert.equal(quarterStartISO(D('2026-12-31')), '2026-10-01');
});

test('momentumCounts uses the calendar quarter, not all-time (plan §6.4)', () => {
  const d = doc([goal('g1', [
    mv('old', true, '2026-05-20'),   // last quarter — excluded
    mv('q', true, '2026-07-02'),     // this quarter
    mv('w', true, '2026-07-12'),     // this quarter + this week
    mv('nodate', true),              // done, no doneAt — excluded from windows
    mv('open', false),
  ])]);
  const mc = momentumCounts(d, D('2026-07-13'));
  assert.equal(mc.quarter, 2);
  assert.equal(mc.week, 1);
});

test('momentumCounts at Q4→Q1 year boundary', () => {
  const d = doc([goal('g1', [mv('dec', true, '2025-12-31'), mv('jan', true, '2026-01-02')])]);
  const mc = momentumCounts(d, D('2026-01-05'));
  assert.equal(mc.quarter, 1, 'December completion belongs to last year’s Q4');
  assert.equal(mc.week, 2, 'week window ignores quarter boundaries');
});

// ---------- today's move ----------
test('pickTodaysMove prefers the goal with least momentum; skip cycles', () => {
  const behind = goal('behind', [mv('b1', false), mv('b2', false)]);
  const ahead = goal('ahead', [mv('a1', true, '2026-07-01'), mv('a2', false)]);
  const d = doc([ahead, behind]);
  assert.equal(pickTodaysMove(d, 0).move.id, 'b1', 'least-momentum goal first');
  assert.equal(pickTodaysMove(d, 1).move.id, 'b2');
  assert.equal(pickTodaysMove(d, 2).move.id, 'a2');
  assert.equal(pickTodaysMove(d, 3).move.id, 'b1', 'wraps around');
});

test('pickTodaysMove only considers visible (first N) open moves; null when done', () => {
  const many = goal('g', Array.from({ length: 6 }, (_, i) => mv('m' + i, false)));
  const cands = candidateMoves(doc([many]));
  assert.equal(cands.length, CONSTANTS.VISIBLE_OPEN);
  assert.equal(pickTodaysMove(doc([goal('g', [mv('x', true, '2026-07-01')])])), null);
});

// ---------- horizon ----------
test('goalHorizon defaults and nextHorizon cycles', () => {
  assert.equal(goalHorizon({}), 'quarter');
  assert.equal(goalHorizon({ horizon: 'year' }), 'year');
  assert.equal(goalHorizon({ horizon: 'bogus' }), 'quarter');
  assert.equal(nextHorizon('quarter'), 'half');
  assert.equal(nextHorizon('year'), 'quarter');
});

// ---------- validation & normalization ----------
test('validateDoc accepts the sample fixture', async () => {
  const fs = await import('node:fs');
  const fixture = JSON.parse(fs.readFileSync(new URL('../../fixtures/sample-quarter.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateDoc(fixture), []);
});

test('validateDoc flags structural problems', () => {
  assert.notEqual(validateDoc(null).length, 0);
  assert.notEqual(validateDoc({ title: 't', goals: 'nope' }).length, 0);
  assert.notEqual(validateDoc(doc([{ id: 'g', name: 'g', inits: [{ id: 'i', name: 'i', moves: [{ id: 'm' }], waiting: [] }] }])).length, 0);
  assert.notEqual(validateDoc(doc([goal('g', [mv('m', true, 'not-a-date')])])).length, 0);
});

test('normalizeDoc accepts prototype export format and fills defaults', () => {
  const proto = { title: 'Q3', goals: [{ id: 'g', name: 'g', inits: [{ id: 'i', name: 'i', moves: [], waiting: [{ id: 'w', who: 'P', what: 'x', since: '2026-07-01' }] }] }] };
  const n = normalizeDoc(proto);
  assert.equal(n.schemaVersion, 1);
  assert.equal(n.goals[0].sub, '');
  assert.equal(n.goals[0].inits[0].waiting[0].lastNotifiedTier, 0);
});

test('unknown fields survive validate + normalize round-trip (forward compat, plan §4.2)', () => {
  const d = doc([goal('g', [mv('m', false)])]);
  d.futureField = { nested: true };
  d.goals[0].futureGoalField = 42;
  d.goals[0].inits[0].moves[0].futureMoveField = 'x';
  assert.deepEqual(validateDoc(d), []);
  const round = normalizeDoc(JSON.parse(JSON.stringify(d)));
  assert.deepEqual(round.futureField, { nested: true });
  assert.equal(round.goals[0].futureGoalField, 42);
  assert.equal(round.goals[0].inits[0].moves[0].futureMoveField, 'x');
});

// ---------- move label editing ----------
test('setMoveLabel renames initiative and loose moves; trims; rejects empty and unknown ids', () => {
  const d = doc([goal('g', [mv('m1', false)])]);
  d.loose = [mv('l1', false)];
  assert.equal(L.setMoveLabel(d, 'm1', 'Renamed move'), true);
  assert.equal(d.goals[0].inits[0].moves[0].label, 'Renamed move');
  assert.equal(L.setMoveLabel(d, 'l1', '  Loose renamed  '), true, 'loose ends are reachable');
  assert.equal(d.loose[0].label, 'Loose renamed', 'label is trimmed');
  assert.equal(L.setMoveLabel(d, 'm1', ''), false);
  assert.equal(L.setMoveLabel(d, 'm1', '   '), false);
  assert.equal(d.goals[0].inits[0].moves[0].label, 'Renamed move', 'empty input leaves the label alone');
  assert.equal(L.setMoveLabel(d, 'nope', 'x'), false, 'unknown id changes nothing');
});
