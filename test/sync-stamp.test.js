// Regression guard for the CLIENT half of the device-scoped assignmentPatch guard. dispatch()
// MUST stamp payload.assignment.updatedBy = DEVICE_ID (and keep a pre-set updatedAt), because the
// DO's device-scoped guard only fires when updatedBy is present AND matches the stored device.
// The worker-patch-guards tests all hand-craft updatedBy in the payload, so WITHOUT this test a
// regression that drops the sync.js stamp would leave every worker test green while silently
// disarming the guard in production. See sync.js dispatch + worker.js applyMutation
// queue.assignmentPatch.
import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, DEVICE_ID } from '../js/app/sync.js';

// Node 18+ ships a native fetch; dispatch()'s HTTP fallback (httpMutate) would otherwise make a
// REAL network call to the worker. Override it with an inert stub (httpMutate already swallows
// errors, but this avoids a real request and keeps the test hermetic). ES imports are hoisted, so
// this runs AFTER sync.js is imported — which is fine: sync.js touches fetch only at dispatch()
// call time (inside the test bodies below), by which point the stub is installed.
globalThis.fetch = async () => ({ ok: true, status: 200, async json() { return { applied: true }; } });

test('dispatch stamps assignment.updatedBy = DEVICE_ID on queue.assignmentPatch', () => {
  const assignment = { serviceId: 's1', techId: 't1', status: 'complete', cost: 40, updatedAt: 12345 };
  dispatch('queue.assignmentPatch', { entryId: 'e1', serviceId: 's1', techId: 't1', assignment });
  assert.equal(assignment.updatedBy, DEVICE_ID, 'the device stamp is what arms the DO device-scoped guard');
  assert.equal(assignment.updatedAt, 12345, 'a pre-set updatedAt (from status.js applyAssignmentStatus) is preserved, not overwritten');
});

test('dispatch fills assignment.updatedAt when the caller left it unset', () => {
  const assignment = { serviceId: 's1', techId: 't1', status: 'inservice', cost: 0 };
  dispatch('queue.assignmentPatch', { entryId: 'e1', serviceId: 's1', techId: 't1', assignment });
  assert.equal(assignment.updatedBy, DEVICE_ID);
  assert.equal(typeof assignment.updatedAt, 'number', 'updatedAt is stamped so the DO guard has a version to compare');
});
