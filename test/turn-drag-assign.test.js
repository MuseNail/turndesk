// N3 drag→tech assignment pure cores: which services a dragged customer can be assigned/moved to a tech.
// Run: node --test-force-exit --test test/turn-drag-assign.test.js
import './setup-globals.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eligibleWaitingServices, movableServices } from '../js/app/features/turns.js';

const labelOf = sid => sid.toUpperCase();
// statusOf stub: read a per-assignment `_st` (test-only), default 'waiting' when no assignment.
const statusOf = (entry, a) => (a ? (a._st || 'waiting') : 'waiting');
const isPaidStatus = s => s === 'paid' || s === 'done';

// ── eligibleWaitingServices (case a: assign a WAITING service to a tech) ──
test('eligibleWaitingServices: only waiting services, excludes ones already on THIS tech; canDo is a flag not a filter', () => {
  const entry = {
    services: ['s1', 's2', 's3', 's4'],
    assignments: [
      { serviceId: 's2', techId: 'other', _st: 'waiting' },   // waiting, on another tech → eligible
      { serviceId: 's3', techId: 'T', _st: 'waiting' },       // already on THIS tech → excluded
      { serviceId: 's4', techId: 'other', _st: 'inservice' }, // not waiting → excluded
    ],
    // s1 has no assignment → waiting
  };
  const doesService = sid => sid !== 's2';   // tech can't do s2
  const out = eligibleWaitingServices(entry, 'T', { statusOf, doesService, labelOf });
  assert.deepEqual(out.map(o => o.serviceId), ['s1', 's2']);   // s1 (unassigned waiting) + s2 (waiting, other tech)
  assert.equal(out.find(o => o.serviceId === 's2').canDo, false);  // skills is a FLAG (still listed), not filtered out
  assert.equal(out.find(o => o.serviceId === 's1').canDo, true);
});
test('eligibleWaitingServices: nothing waiting → empty', () => {
  const entry = { services: ['s1'], assignments: [{ serviceId: 's1', techId: 'x', _st: 'complete' }] };
  assert.deepEqual(eligibleWaitingServices(entry, 'T', { statusOf, doesService: () => true, labelOf }), []);
});

// ── movableServices (case b: move an ASSIGNED service from one tech to another) ──
const mEntry = () => ({
  assignments: [
    { serviceId: 'a', techId: 'T1', _st: 'waiting' },
    { serviceId: 'b', techId: 'T1', _st: 'inservice' },
    { serviceId: 'c', techId: 'T1', _st: 'complete' },   // done
    { serviceId: 'd', techId: 'T1', _st: 'paid' },       // paid
    { serviceId: 'e', techId: 'T2', _st: 'waiting' },    // other tech → never included
  ],
});
test('movableServices: non-manager moves only waiting/in-service; only from the source tech', () => {
  const out = movableServices(mEntry(), 'T1', { isManager: false, doesService: () => true, labelOf, statusOf, isPaidStatus });
  assert.deepEqual(out.map(o => o.serviceId), ['a', 'b']);   // done/paid excluded; T2's 'e' excluded
  assert.equal(out.every(o => !o.needsOverride), true);
});
test('movableServices: a manager also sees done (unpaid) flagged needsOverride; PAID never moves', () => {
  const out = movableServices(mEntry(), 'T1', { isManager: true, doesService: () => true, labelOf, statusOf, isPaidStatus });
  assert.deepEqual(out.map(o => o.serviceId), ['a', 'b', 'c']);   // 'd' (paid) excluded even for a manager — it has a saved record
  assert.equal(out.find(o => o.serviceId === 'a').needsOverride, false);
  assert.equal(out.find(o => o.serviceId === 'c').needsOverride, true);   // done (unpaid)
});
test('movableServices: canDo is a flag (skills warn, not filter)', () => {
  const out = movableServices(mEntry(), 'T1', { isManager: false, doesService: sid => sid !== 'b', labelOf, statusOf, isPaidStatus });
  assert.deepEqual(out.map(o => o.serviceId), ['a', 'b']);   // b still listed
  assert.equal(out.find(o => o.serviceId === 'b').canDo, false);
});
