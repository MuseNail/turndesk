// Floor-plan check-in (Wave 2 #3): tapping an open chair arms that station; the walk-in is auto-seated
// there once the check-in commits. The seat decision is a pure guard (_planSeat) consumed at the two
// commit chokepoints (afterManualFinalize, kiosk-confirm). This covers the guard's branches; the
// pointer/DOM wiring and the one-line consume-once are covered by the diff review (no DOM in Node).
import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { _planSeat } from '../js/app/features/floorplan.js';

const ok = { stationExists: true, occupiedByOther: false, primaryExists: true, primaryPaid: false };

test('_planSeat seats the primary at the armed station when everything checks out', () => {
  assert.deepEqual(_planSeat('P3', ok), { seat: true, station: 'P3' });
});
test('_planSeat does nothing when no station was armed', () => {
  assert.deepEqual(_planSeat(null, ok), { seat: false, station: null });
  assert.deepEqual(_planSeat('', ok), { seat: false, station: null });
});
test('_planSeat does nothing when there is no primary guest', () => {
  assert.deepEqual(_planSeat('P3', { ...ok, primaryExists: false }), { seat: false, station: null });
});
test('_planSeat does nothing when the armed station no longer exists', () => {
  // Station deleted/renamed between the tap and the commit — never seat to a bogus id (avoids a lying toast).
  assert.deepEqual(_planSeat('P3', { ...ok, stationExists: false }), { seat: false, station: null });
});
test('_planSeat does nothing when the station is already taken by someone else', () => {
  // Cross-device race: the seat filled between the tap and the commit.
  assert.deepEqual(_planSeat('P3', { ...ok, occupiedByOther: true }), { seat: false, station: null });
});
test('_planSeat does nothing when the primary is already paid/checked out', () => {
  assert.deepEqual(_planSeat('P3', { ...ok, primaryPaid: true }), { seat: false, station: null });
});
