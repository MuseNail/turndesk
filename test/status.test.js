import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { isPaidStatus, getAssignmentStatus, deriveEntryStatus, effectiveServiceStatus, isAwaitingPrice, applyAssignmentStatus, serviceLineStyle } from '../js/app/features/status.js';

// The 4-state workflow: waiting → inservice → complete → paid (legacy 'done' ≡ paid).
// These encode the exact spec so a regression in the state machine fails CI.

test('isPaidStatus: only paid + legacy done are finalized', () => {
  assert.equal(isPaidStatus('paid'), true);
  assert.equal(isPaidStatus('done'), true);   // legacy
  assert.equal(isPaidStatus('complete'), false);
  assert.equal(isPaidStatus('inservice'), false);
  assert.equal(isPaidStatus('waiting'), false);
});

test('getAssignmentStatus defaults to waiting', () => {
  assert.equal(getAssignmentStatus({}, {}), 'waiting');
  assert.equal(getAssignmentStatus({}, { status: 'complete' }), 'complete');
});

test('deriveEntryStatus: no assignments falls back to entry.status (or waiting)', () => {
  assert.equal(deriveEntryStatus({ assignments: [], status: 'inservice' }), 'inservice');
  assert.equal(deriveEntryStatus({ assignments: [] }), 'waiting');
  assert.equal(deriveEntryStatus({}), 'waiting');
});

test('deriveEntryStatus: any service in service → inservice', () => {
  assert.equal(deriveEntryStatus({ assignments: [{ status: 'waiting' }, { status: 'inservice' }] }), 'inservice');
  assert.equal(deriveEntryStatus({ assignments: [{ status: 'complete' }, { status: 'inservice' }] }), 'inservice');
  assert.equal(deriveEntryStatus({ assignments: [{ status: 'paid' }, { status: 'inservice' }] }), 'inservice');
});

test('deriveEntryStatus: all paid (incl. legacy done) → paid', () => {
  assert.equal(deriveEntryStatus({ assignments: [{ status: 'paid' }, { status: 'paid' }] }), 'paid');
  assert.equal(deriveEntryStatus({ assignments: [{ status: 'paid' }, { status: 'done' }] }), 'paid');
});

test('deriveEntryStatus: all complete-or-paid but not all paid → complete', () => {
  assert.equal(deriveEntryStatus({ assignments: [{ status: 'complete' }, { status: 'paid' }] }), 'complete');
  assert.equal(deriveEntryStatus({ assignments: [{ status: 'complete' }, { status: 'complete' }] }), 'complete');
});

test('deriveEntryStatus: any service still waiting → waiting', () => {
  assert.equal(deriveEntryStatus({ assignments: [{ status: 'waiting' }, { status: 'complete' }] }), 'waiting');
  assert.equal(deriveEntryStatus({ assignments: [{ status: 'waiting' }, { status: 'paid' }] }), 'waiting');
});

// "Awaiting price": a service the front desk marked done but left unpriced (a.awaitingPrice),
// for the tech to price later. It's a DISPLAY sub-state of complete — the real status stays
// 'complete' (so entry derivation is unchanged), only the pill/visual + checkout gate differ.

test('isAwaitingPrice: only a complete + awaitingPrice assignment qualifies', () => {
  assert.equal(isAwaitingPrice({ status: 'complete', awaitingPrice: true }), true);
  assert.equal(isAwaitingPrice({ status: 'complete' }), false);
  assert.equal(isAwaitingPrice({ status: 'inservice', awaitingPrice: true }), false);   // not complete → not awaiting
  assert.equal(isAwaitingPrice({ awaitingPrice: true }), false);
  assert.equal(isAwaitingPrice(null), false);
});

test('effectiveServiceStatus: maps complete+awaitingPrice → awaiting, else the real status', () => {
  assert.equal(effectiveServiceStatus({}, { status: 'complete', awaitingPrice: true }), 'awaiting');
  assert.equal(effectiveServiceStatus({}, { status: 'complete' }), 'complete');
  assert.equal(effectiveServiceStatus({}, { status: 'inservice', awaitingPrice: true }), 'inservice');
  assert.equal(effectiveServiceStatus({}, { status: 'waiting' }), 'waiting');
});

test('serviceLineStyle: awaiting has its own violet pill', () => {
  const ls = serviceLineStyle('awaiting');
  assert.equal(ls.key, 'awaiting');
  assert.equal(ls.pill.label, 'Awaiting price');
});

test('deriveEntryStatus: an awaiting (complete) service still derives complete / inservice', () => {
  assert.equal(deriveEntryStatus({ assignments: [{ status: 'complete', awaitingPrice: true }, { status: 'complete' }] }), 'complete');
  assert.equal(deriveEntryStatus({ assignments: [{ status: 'complete', awaitingPrice: true }, { status: 'inservice' }] }), 'inservice');
});

test('applyAssignmentStatus: leaving complete clears a stale awaitingPrice flag', () => {
  const a = { status: 'complete', awaitingPrice: true, cost: 0 };
  applyAssignmentStatus(a, 'inservice');     // reopen / revert
  assert.equal(a.awaitingPrice, false);
  const b = { status: 'complete', awaitingPrice: true };
  applyAssignmentStatus(b, 'complete');      // staying complete keeps it (e.g. re-derive)
  assert.equal(b.awaitingPrice, true);
});
