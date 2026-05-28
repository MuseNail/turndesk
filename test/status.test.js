import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { isPaidStatus, getAssignmentStatus, deriveEntryStatus } from '../js/app/features/status.js';

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
