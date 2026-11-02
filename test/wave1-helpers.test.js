// Pure helpers behind two Wave-1 quick wins (Muse v5.64 port):
//   _clampTechColW (turns.js) — the resizable tech-column width clamp.
//   _visitLines (reports.js) — the per-service→tech mapping for customer visit history.
import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { _clampTechColW } from '../js/app/features/turns.js';
import { _visitLines } from '../js/app/features/reports.js';

const svcLabel = id => ({ s1: 'Gel Mani', s2: 'Pedi' }[id]);
const techName = id => ({ t1: 'Jane', t2: 'Bob' }[id]);

// ── _clampTechColW(px) — min 120, max 280, default 155 ──
test('_clampTechColW clamps below the minimum', () => { assert.equal(_clampTechColW(50), 120); });
test('_clampTechColW clamps above the maximum', () => { assert.equal(_clampTechColW(999), 280); });
test('_clampTechColW passes a value in range (rounded)', () => { assert.equal(_clampTechColW(200.6), 201); });
test('_clampTechColW falls back to the default on a non-number', () => { assert.equal(_clampTechColW('abc'), 155); });

// ── _visitLines(assignments, services, svcLabel, techName) ──
test('_visitLines maps each assignment to its service + tech', () => {
  assert.deepEqual(
    _visitLines([{ serviceId: 's1', techId: 't1' }, { serviceId: 's2', techId: 't2' }], ['s1', 's2'], svcLabel, techName),
    [{ service: 'Gel Mani', tech: 'Jane' }, { service: 'Pedi', tech: 'Bob' }]);
});
test('_visitLines falls back to the service list when there are no assignments', () => {
  assert.deepEqual(_visitLines([], ['s1', 's2'], svcLabel, techName),
    [{ service: 'Gel Mani', tech: '' }, { service: 'Pedi', tech: '' }]);
});
test('_visitLines appends a ticket service with no assignment row (parity, never dropped)', () => {
  assert.deepEqual(_visitLines([{ serviceId: 's1', techId: 't1' }], ['s1', 's2'], svcLabel, techName),
    [{ service: 'Gel Mani', tech: 'Jane' }, { service: 'Pedi', tech: '' }]);
});
test('_visitLines drops blank catch-all assignments (no serviceId and no techId)', () => {
  assert.deepEqual(_visitLines([{ serviceId: '', techId: '' }, { serviceId: 's1', techId: 't1' }], ['s1'], svcLabel, techName),
    [{ service: 'Gel Mani', tech: 'Jane' }]);
});
