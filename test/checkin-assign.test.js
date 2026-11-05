// W2-7 assign-at-check-in: the pure assignment-build core.
// Run: node --test-force-exit --test test/checkin-assign.test.js
import './setup-globals.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCheckinAssignments } from '../js/app/features/queue.js';

test('no services → empty (caller leaves entry.assignments undefined)', () => {
  assert.deepEqual(buildCheckinAssignments([], {}, 1000), []);
});

test('selected services with NO tech → empty (unassigned walk-in keeps today\'s no-array shape)', () => {
  assert.deepEqual(buildCheckinAssignments(['gel', 'pedi'], {}, 1000), []);
  assert.deepEqual(buildCheckinAssignments(['gel'], { gel: { station: 'A3' } }, 1000), []); // station-only, no tech → excluded
});

test('a teched service → one assignment, station defaults to empty', () => {
  assert.deepEqual(buildCheckinAssignments(['gel'], { gel: { techId: 't1' } }, 1000),
    [{ serviceId: 'gel', techId: 't1', station: '', status: 'waiting', cost: 0, assignedAt: 1000 }]);
});

test('tech + station → station carried', () => {
  assert.deepEqual(buildCheckinAssignments(['gel'], { gel: { techId: 't1', station: 'A3' } }, 1000),
    [{ serviceId: 'gel', techId: 't1', station: 'A3', status: 'waiting', cost: 0, assignedAt: 1000 }]);
});

test('mix: only teched services become assignments, assignedAt offsets in order for a stable sort', () => {
  const r = buildCheckinAssignments(['gel', 'pedi', 'wax'], { gel: { techId: 't1' }, wax: { techId: 't2', station: 'B1' } }, 5000);
  assert.deepEqual(r, [
    { serviceId: 'gel', techId: 't1', station: '', status: 'waiting', cost: 0, assignedAt: 5000 },
    { serviceId: 'wax', techId: 't2', station: 'B1', status: 'waiting', cost: 0, assignedAt: 5001 },
  ]);
});

test('a pick object with a station but no techId is ignored (never a station-only assignment)', () => {
  assert.deepEqual(buildCheckinAssignments(['gel', 'pedi'], { gel: { techId: '', station: 'A3' }, pedi: { techId: 't2' } }, 1000),
    [{ serviceId: 'pedi', techId: 't2', station: '', status: 'waiting', cost: 0, assignedAt: 1000 }]);
});
