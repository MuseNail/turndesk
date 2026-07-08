import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getState, applyChange, hydrate, isStaleWrite } from '../js/app/store.js';

// Stale-write guard: a queue entry / record write is rejected only when the copy we already
// hold is strictly NEWER (by updatedAt). This stops a lingering stale device copy (e.g. an old
// outbox op from before a $2 fee was added) from clobbering a good record — the fee-drop bug.

test('isStaleWrite: only rejects when the stored copy is strictly newer', () => {
  assert.equal(isStaleWrite({ updatedAt: 2 }, { updatedAt: 1 }), true);   // stored newer → stale, reject
  assert.equal(isStaleWrite({ updatedAt: 1 }, { updatedAt: 2 }), false);  // incoming newer → apply
  assert.equal(isStaleWrite({ updatedAt: 1 }, { updatedAt: 1 }), false);  // equal → apply (idempotent re-save)
  assert.equal(isStaleWrite({}, { updatedAt: 1 }), false);                // no stored timestamp → apply
  assert.equal(isStaleWrite({ updatedAt: 1 }, {}), false);                // no incoming timestamp → apply
  assert.equal(isStaleWrite(null, { updatedAt: 1 }), false);             // brand-new (no prev) → apply
});

test('record.save guard: an older record cannot overwrite a newer one', () => {
  hydrate({ state: { records: [{ id: 'r1', totalCost: 95, fees: [{ amount: 2 }], updatedAt: 200 }] }, seq: 1 });
  // stale write (older) — must be IGNORED, the $2 fee survives
  applyChange('record.save', { record: { id: 'r1', totalCost: 93, fees: [], updatedAt: 100 } });
  let r = getState().records.find(x => x.id === 'r1');
  assert.equal(r.totalCost, 95);
  assert.equal(r.fees.length, 1);
  // newer write — applies
  applyChange('record.save', { record: { id: 'r1', totalCost: 97, fees: [{ amount: 2 }], updatedAt: 300 } });
  assert.equal(getState().records.find(x => x.id === 'r1').totalCost, 97);
  // brand-new record (no prev) — applies
  applyChange('record.save', { record: { id: 'r2', totalCost: 50, updatedAt: 50 } });
  assert.ok(getState().records.find(x => x.id === 'r2'));
});

test('record.save guard: a deleted record cannot be revived by a later save', () => {
  hydrate({ state: { records: [{ id: 'd1', totalCost: 40, updatedAt: 100 }], deletions: [] }, seq: 1 });
  applyChange('record.delete', { id: 'd1' });
  assert.equal(getState().records.find(x => x.id === 'd1').status, 'deleted');
  assert.ok(getState().deletions.includes('d1'));
  // a stale paid queue copy re-fires saveRecord with a FRESH updatedAt — must NOT un-delete it
  applyChange('record.save', { record: { id: 'd1', totalCost: 40, status: 'paid', updatedAt: 999 } });
  assert.equal(getState().records.find(x => x.id === 'd1').status, 'deleted');
});

test('queue.upsert guard: an older entry cannot overwrite a newer one', () => {
  hydrate({ state: { queue: [{ id: 'q1', totalCost: 80, updatedAt: 200 }] }, seq: 1 });
  applyChange('queue.upsert', { entry: { id: 'q1', totalCost: 78, updatedAt: 100 } });   // stale
  assert.equal(getState().queue.find(x => x.id === 'q1').totalCost, 80);
  applyChange('queue.upsert', { entry: { id: 'q1', totalCost: 82, updatedAt: 300 } });   // newer
  assert.equal(getState().queue.find(x => x.id === 'q1').totalCost, 82);
});

// §14 per-assignment field-merge: a forgotten front-desk modal re-saves the WHOLE entry with a
// service's cost reverted to its stale form value. The per-assignment merge must keep a stored
// assignment whose own updatedAt is numeric when the incoming one is older OR unstamped — so a
// tech's concurrent price change (queue.assignmentPatch, which stamps assignment.updatedAt) is not
// silently clobbered. A genuine FD re-price carries a strictly-newer stamp and still wins.
test('queue.upsert per-assignment merge: a stale/unstamped whole-entry save cannot revert a tech price', () => {
  const tech = { serviceId: 's1', techId: 't1', status: 'inservice', cost: 55, updatedAt: 200 };
  hydrate({ state: { queue: [{ id: 'q1', updatedAt: 100, assignments: [tech] }] }, seq: 1 });
  // FD whole-entry save: fresh ENTRY updatedAt (passes the entry guard) but the assignment carries
  // the OLD cost and NO per-assignment stamp → tech's $55 must survive.
  applyChange('queue.upsert', { entry: { id: 'q1', updatedAt: 300, assignments: [{ serviceId: 's1', techId: 't1', status: 'inservice', cost: 40 }] } });
  assert.equal(getState().queue.find(x => x.id === 'q1').assignments[0].cost, 55);
  // FD save carrying an OLDER per-assignment stamp → still keep the tech's $55.
  applyChange('queue.upsert', { entry: { id: 'q1', updatedAt: 400, assignments: [{ serviceId: 's1', techId: 't1', status: 'inservice', cost: 41, updatedAt: 150 }] } });
  assert.equal(getState().queue.find(x => x.id === 'q1').assignments[0].cost, 55);
  // Genuine FD re-price → strictly-newer per-assignment stamp → FD wins (last real edit wins).
  applyChange('queue.upsert', { entry: { id: 'q1', updatedAt: 500, assignments: [{ serviceId: 's1', techId: 't1', status: 'inservice', cost: 60, updatedAt: 250 }] } });
  assert.equal(getState().queue.find(x => x.id === 'q1').assignments[0].cost, 60);
});

test('queue.upsert per-assignment merge: both-unstamped applies (legacy); numeric tie applies incoming', () => {
  hydrate({ state: { queue: [{ id: 'q2', updatedAt: 100, assignments: [{ serviceId: 's1', techId: 't1', status: 'inservice', cost: 30 }] }] }, seq: 1 });
  applyChange('queue.upsert', { entry: { id: 'q2', updatedAt: 200, assignments: [{ serviceId: 's1', techId: 't1', status: 'inservice', cost: 35 }] } });
  assert.equal(getState().queue.find(x => x.id === 'q2').assignments[0].cost, 35);   // both unstamped → incoming
  hydrate({ state: { queue: [{ id: 'q3', updatedAt: 100, assignments: [{ serviceId: 's1', techId: 't1', status: 'inservice', cost: 30, updatedAt: 200 }] }] }, seq: 1 });
  applyChange('queue.upsert', { entry: { id: 'q3', updatedAt: 300, assignments: [{ serviceId: 's1', techId: 't1', status: 'inservice', cost: 36, updatedAt: 200 }] } });
  assert.equal(getState().queue.find(x => x.id === 'q3').assignments[0].cost, 36);   // numeric tie → incoming
});

test('legacy data without timestamps still applies (guard never blocks untimestamped writes)', () => {
  hydrate({ state: { records: [{ id: 'old', totalCost: 10 }] }, seq: 1 });
  applyChange('record.save', { record: { id: 'old', totalCost: 12 } });   // no updatedAt either side
  assert.equal(getState().records.find(x => x.id === 'old').totalCost, 12);
});

// ── App-native appointments (appt.upsert / appt.delete) ──────────────────────
// Mirrors the record.save/customer.delete guards: an older appt can't clobber a newer
// one; a deleted appt can't be revived by a late offline replay (tombstone).

test('appt.upsert: brand-new appt applies; older update is rejected; newer applies', () => {
  hydrate({ state: { appointments: [], apptDeletions: [] }, seq: 1 });
  applyChange('appt.upsert', { appt: { id: 'a1', start: '2026-07-07T14:00:00.000Z', confirmed: false, updatedAt: 100 } });
  assert.equal(getState().appointments.find(x => x.id === 'a1').start, '2026-07-07T14:00:00.000Z');
  // stale (older) update — rejected, confirmed stays false
  applyChange('appt.upsert', { appt: { id: 'a1', start: '2026-07-07T14:00:00.000Z', confirmed: true, updatedAt: 50 } });
  assert.equal(getState().appointments.find(x => x.id === 'a1').confirmed, false);
  // newer update — applies
  applyChange('appt.upsert', { appt: { id: 'a1', start: '2026-07-07T15:00:00.000Z', confirmed: true, updatedAt: 200 } });
  const a = getState().appointments.find(x => x.id === 'a1');
  assert.equal(a.confirmed, true);
  assert.equal(a.start, '2026-07-07T15:00:00.000Z');
});

test('appt.delete: removes the appt and writes a tombstone that blocks revival', () => {
  hydrate({ state: { appointments: [{ id: 'a2', start: '2026-07-07T14:00:00.000Z', updatedAt: 100 }], apptDeletions: [] }, seq: 1 });
  applyChange('appt.delete', { id: 'a2' });
  assert.equal(getState().appointments.find(x => x.id === 'a2'), undefined);
  assert.ok(getState().apptDeletions.includes('a2'));
  // a stale offline replay tries to re-create it with a fresh stamp — the tombstone blocks it
  applyChange('appt.upsert', { appt: { id: 'a2', start: '2026-07-07T14:00:00.000Z', updatedAt: 999 } });
  assert.equal(getState().appointments.find(x => x.id === 'a2'), undefined);
});

test('appt.upsert: unstamped legacy write still applies (guard never blocks untimestamped)', () => {
  hydrate({ state: { appointments: [{ id: 'a3', notes: 'x' }], apptDeletions: [] }, seq: 1 });
  applyChange('appt.upsert', { appt: { id: 'a3', notes: 'y' } });   // no updatedAt either side
  assert.equal(getState().appointments.find(x => x.id === 'a3').notes, 'y');
});
