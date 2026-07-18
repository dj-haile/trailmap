import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  waitingTier, pendingWaitingNotifications, applyNotifiedTier, CONSTANTS,
} from '../../renderer/logic.js';

const TODAY = new Date('2026-07-18T12:00:00');
const daysAgo = n => {
  const d = new Date(TODAY); d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function docWith(waiting) {
  return {
    schemaVersion: 1, title: 't',
    goals: [{ id: 'g', name: 'Goal', sub: '', inits: [{ id: 'i', name: 'Init', moves: [], waiting }] }],
  };
}
const chip = (id, agedDays, lastNotifiedTier = 0) =>
  ({ id, who: 'P' + id, what: 'thing', since: daysAgo(agedDays), lastNotifiedTier });

test('waitingTier thresholds match CONSTANTS', () => {
  assert.equal(waitingTier(0), 0);
  assert.equal(waitingTier(CONSTANTS.AGE_WARN_DAYS - 1), 0);
  assert.equal(waitingTier(CONSTANTS.AGE_WARN_DAYS), 1);
  assert.equal(waitingTier(CONSTANTS.AGE_CRIT_DAYS - 1), 1);
  assert.equal(waitingTier(CONSTANTS.AGE_CRIT_DAYS), 2);
});

test('fresh chips below warn threshold never notify', () => {
  assert.deepEqual(pendingWaitingNotifications(docWith([chip('a', 4)]), TODAY), []);
});

test('crossing 5d fires tier 1 exactly once', () => {
  const d = docWith([chip('a', 6)]);
  const first = pendingWaitingNotifications(d, TODAY);
  assert.equal(first.length, 1);
  assert.equal(first[0].tier, 1);
  applyNotifiedTier(d, 'a', 1);
  assert.deepEqual(pendingWaitingNotifications(d, TODAY), [], 'no repeat at the same tier');
});

test('crossing 10d fires tier 2 once, even if tier 1 was already sent', () => {
  const d = docWith([chip('a', 11, 1)]);
  const p = pendingWaitingNotifications(d, TODAY);
  assert.equal(p.length, 1);
  assert.equal(p[0].tier, 2);
  applyNotifiedTier(d, 'a', 2);
  assert.deepEqual(pendingWaitingNotifications(d, TODAY), []);
});

test('a chip that jumps straight past 10d fires tier 2 only (not two notifications)', () => {
  const p = pendingWaitingNotifications(docWith([chip('a', 12)]), TODAY);
  assert.equal(p.length, 1);
  assert.equal(p[0].tier, 2);
});

test('already-tier-2 chips stay silent forever', () => {
  assert.deepEqual(pendingWaitingNotifications(docWith([chip('a', 40, 2)]), TODAY), []);
});

test('missing lastNotifiedTier (prototype import) is treated as 0', () => {
  const c = chip('a', 6);
  delete c.lastNotifiedTier;
  const p = pendingWaitingNotifications(docWith([c]), TODAY);
  assert.equal(p.length, 1);
});

test('mixed shelf: 4d / 6d / 11d fires exactly two, with names attached', () => {
  const d = docWith([chip('a', 4), chip('b', 6), chip('c', 11)]);
  const p = pendingWaitingNotifications(d, TODAY);
  assert.equal(p.length, 2);
  assert.deepEqual(p.map(x => [x.who, x.tier]), [['Pb', 1], ['Pc', 2]]);
  assert.equal(p[0].goalName, 'Goal');
  assert.equal(p[0].initName, 'Init');
});

test('applyNotifiedTier never lowers a recorded tier', () => {
  const d = docWith([chip('a', 11, 2)]);
  applyNotifiedTier(d, 'a', 1);
  assert.equal(d.goals[0].inits[0].waiting[0].lastNotifiedTier, 2);
});
