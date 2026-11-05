// Item 2b: the floor-plan tech card shows the tech's current in-service service timer.
// pickTechTimingAssignment picks which assignment to time (the longest-running in-service one).
// Run: node --test-force-exit --test test/floor-tech-timer.test.js
import './setup-globals.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickTechTimingAssignment } from '../js/app/features/floorplan.js';

const liveMsOf = a => a._ms || 0;   // test stub for liveAssignmentMs

test('picks the in-service assignment for the tech', () => {
  const entries = [{ assignments: [{ techId: 't1', status: 'inservice', _ms: 500 }] }];
  assert.equal(pickTechTimingAssignment(entries, 't1', liveMsOf)?._ms, 500);
});

test('ignores waiting/complete assignments and other techs', () => {
  const entries = [{ assignments: [
    { techId: 't1', status: 'waiting', _ms: 999 },
    { techId: 't2', status: 'inservice', _ms: 999 },
    { techId: 't1', status: 'complete', _ms: 999 },
  ] }];
  assert.equal(pickTechTimingAssignment(entries, 't1', liveMsOf), null);
});

test('returns null when the tech has nothing in service', () => {
  assert.equal(pickTechTimingAssignment([], 't1', liveMsOf), null);
  assert.equal(pickTechTimingAssignment(null, 't1', liveMsOf), null);
});

test('picks the longest-running when two services are in progress', () => {
  const entries = [
    { assignments: [{ techId: 't1', status: 'inservice', _ms: 120 }] },
    { assignments: [{ techId: 't1', status: 'inservice', _ms: 800 }] },
  ];
  assert.equal(pickTechTimingAssignment(entries, 't1', liveMsOf)?._ms, 800);
});
