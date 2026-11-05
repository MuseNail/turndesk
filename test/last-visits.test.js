// Pure helper behind the check-in notes box "Last 3 visits" (front-desk dashboard):
// lastVisitsCompact(records, phone, name, n, svcLabel, techName) → the N most recent PAST visits
// for a customer (matched by phone last-10, name fallback), each a compact
// {dateMs, services, tech, amount, isRefund, note}. Pure (label fns injected) → unit-testable.
import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { lastVisitsCompact } from '../js/app/features/reports.js';

const svcLabel = id => ({ gel: 'Gel Manicure', pedi: 'Pedicure', fill: 'Fill' }[id] || id);
const techName = id => ({ t1: 'Lily', t2: 'Mai' }[id] || '');

const RECS = [
  { id: 'r1', phone: '(909) 555-1234', status: 'paid', checkinTime: '2026-10-02T17:00:00Z', totalCost: 38, txnNote: 'short square', assignments: [{ serviceId: 'gel', techId: 't1' }], services: ['gel'] },
  { id: 'r2', phone: '19095551234', status: 'done', checkinTime: '2026-09-10T17:00:00Z', totalCost: 73, assignments: [{ serviceId: 'gel', techId: 't1' }, { serviceId: 'pedi', techId: 't2' }], services: ['gel', 'pedi'] },
  { id: 'r3', phone: '9095551234', status: 'deleted', checkinTime: '2026-09-05T17:00:00Z', totalCost: 40, assignments: [], services: ['fill'] },
  { id: 'r4', phone: '9095551234', status: 'inservice', checkinTime: '2026-09-04T17:00:00Z', totalCost: 0, assignments: [], services: ['fill'] },
  { id: 'r5', phone: '9095551234', status: 'refund', checkinTime: '2026-08-21T17:00:00Z', totalCost: 38, assignments: [{ serviceId: 'gel', techId: 't1' }], services: ['gel'] },
  { id: 'r6', phone: '7145550000', status: 'paid', checkinTime: '2026-10-01T17:00:00Z', totalCost: 55, assignments: [], services: ['gel'] },
];

test('returns the N most recent matching visits, newest first', () => {
  const v = lastVisitsCompact(RECS, '9095551234', '', 3, svcLabel, techName);
  assert.deepEqual(v.map(x => x.id || x.services), ['Gel Manicure', 'Gel Manicure, Pedicure', 'Gel Manicure']);  // r1, r2, r5 (by date desc)
});
test('excludes deleted + non-paid (waiting/inservice) + other phones', () => {
  const v = lastVisitsCompact(RECS, '9095551234', '', 10, svcLabel, techName);
  assert.equal(v.length, 3);   // r1 (paid), r2 (done), r5 (refund) — NOT r3 (deleted), r4 (inservice), r6 (other phone)
});
test('matches across formatted / 11-digit phones (last 10)', () => {
  const v = lastVisitsCompact(RECS, '909-555-1234', '', 1, svcLabel, techName);
  assert.equal(v.length, 1);
  assert.equal(v[0].amount, 38);
});
test('maps services + unique techs + note + refund flag', () => {
  const v = lastVisitsCompact(RECS, '9095551234', '', 3, svcLabel, techName);
  assert.equal(v[0].services, 'Gel Manicure');
  assert.equal(v[0].tech, 'Lily');
  assert.equal(v[0].note, 'short square');
  assert.equal(v[0].isRefund, false);
  assert.equal(v[1].services, 'Gel Manicure, Pedicure');
  assert.equal(v[1].tech, 'Lily, Mai');
  assert.equal(v[2].isRefund, true);
});
test('name fallback when no phone on the record/query', () => {
  const recs = [{ id: 'n1', phone: '', name: 'Jane Doe', status: 'paid', checkinTime: '2026-10-01', totalCost: 20, assignments: [], services: ['gel'] }];
  assert.equal(lastVisitsCompact(recs, '', 'Jane Doe', 3, svcLabel, techName).length, 1);
  assert.equal(lastVisitsCompact(recs, '', 'Someone Else', 3, svcLabel, techName).length, 0);
});
test('empty when no phone and no name', () => {
  assert.deepEqual(lastVisitsCompact(RECS, '', '', 3, svcLabel, techName), []);
});
