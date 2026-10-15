import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { staffByPin, myActiveAssignments, myHistory, staffServiceAction, completeGateOk, saveDisabled } from '../js/app/staff.js';

// ── Single morphing action button (decouple price entry from completion) ──────
// staffServiceAction(a, fieldPrice) is pure: it maps (status + saved cost/comped + the price
// currently shown in the field) to the ONE button to show. Saving a price never completes; only
// Start and Complete move status. fieldPrice = parsePrice(field value) or null.
test('staffServiceAction: waiting → Start', () => {
  assert.equal(staffServiceAction({ status: 'waiting' }, null).mode, 'start');
  assert.equal(staffServiceAction({}, null).mode, 'start');            // unset status defaults to waiting
});
test('staffServiceAction: in-service with no saved price → Save price', () => {
  assert.equal(staffServiceAction({ status: 'inservice' }, null).mode, 'saveprice');
  assert.equal(staffServiceAction({ status: 'inservice', cost: 0 }, 38).mode, 'saveprice');   // typed, not yet saved
});
test('staffServiceAction: in-service, field matches saved price → Complete', () => {
  assert.equal(staffServiceAction({ status: 'inservice', cost: 38 }, 38).mode, 'complete');   // untouched (field shows saved)
});
test('staffServiceAction: in-service, field edited to a NEW amount → back to Save price', () => {
  assert.equal(staffServiceAction({ status: 'inservice', cost: 38 }, 40).mode, 'saveprice');  // re-price
});
test('staffServiceAction: in-service, field cleared keeps the saved price → Complete (no forced re-type)', () => {
  assert.equal(staffServiceAction({ status: 'inservice', cost: 38 }, null).mode, 'complete');  // empty field falls back to saved cost
});
test('saveDisabled: only a primary Save-price with no valid price is greyed', () => {
  assert.equal(saveDisabled({ mode: 'saveprice', style: 'primary' }, null), true);
  assert.equal(saveDisabled({ mode: 'saveprice', style: 'primary' }, 0), true);
  assert.equal(saveDisabled({ mode: 'saveprice', style: 'primary' }, 38), false);
  assert.equal(saveDisabled({ mode: 'complete', style: 'primary' }, null), false);   // Complete never greyed here
  assert.equal(saveDisabled({ mode: 'saveprice', style: 'violet' }, null), false);   // awaiting Save price isn't gated this way
});
test('staffServiceAction: in-service comped → Complete (a valid $0)', () => {
  assert.equal(staffServiceAction({ status: 'inservice', comped: true, cost: 0 }, null).mode, 'complete');
});
test('staffServiceAction: complete → Reopen; awaiting-price → violet Save price', () => {
  assert.equal(staffServiceAction({ status: 'complete' }, 38).mode, 'reopen');
  const aw = staffServiceAction({ status: 'complete', awaitingPrice: true }, null);
  assert.equal(aw.mode, 'saveprice');
  assert.equal(aw.style, 'violet');
});
test('staffServiceAction: a paid/done line shows NO button (never reactivate a finalized sale)', () => {
  assert.equal(staffServiceAction({ status: 'paid' }, 38).mode, 'none');
  assert.equal(staffServiceAction({ status: 'done' }, 38).mode, 'none');
});

// completeGateOk: Complete is allowed with a real price OR when the service is comped (a valid $0).
test('completeGateOk: needs a price unless comped', () => {
  assert.equal(completeGateOk(38, false), true);
  assert.equal(completeGateOk(0, false), false);
  assert.equal(completeGateOk(null, false), false);
  assert.equal(completeGateOk(0, true), true);      // comped $0 completes
  assert.equal(completeGateOk(null, true), true);
});

// staffByPin: which tech a PIN logs in as (used by the staff app login).
test('staffByPin matches an active tech by exact PIN', () => {
  const staff = [{ id: 'a', name: 'Amy', pin: '1111' }, { id: 'b', name: 'Bo', pin: '2222' }];
  assert.equal(staffByPin(staff, [], '2222').id, 'b');
  assert.equal(staffByPin(staff, [], '1111').id, 'a');
});

test('staffByPin tolerates numeric vs string PINs', () => {
  const staff = [{ id: 'a', name: 'Amy', pin: 1234 }];
  assert.equal(staffByPin(staff, [], '1234').id, 'a');
});

test('staffByPin returns null for wrong / blank PIN', () => {
  const staff = [{ id: 'a', name: 'Amy', pin: '1111' }];
  assert.equal(staffByPin(staff, [], '9999'), null);
  assert.equal(staffByPin(staff, [], ''), null);
  assert.equal(staffByPin(staff, [], null), null);
  assert.equal(staffByPin([], [], '1111'), null);
});

test('staffByPin excludes inactive techs and techs with no PIN', () => {
  const staff = [{ id: 'a', name: 'Amy', pin: '1111' }, { id: 'b', name: 'Bo' }];
  assert.equal(staffByPin(staff, ['a'], '1111'), null);   // inactive
  assert.equal(staffByPin(staff, [], ''), null);          // Bo has no pin, blank query
});

// myActiveAssignments: the tech's own service lines from the live queue.
const queue = [
  { id: 1, name: 'Cust1', status: 'inservice', assignments: [
    { serviceId: 's1', techId: 'a', status: 'inservice' },
    { serviceId: 's2', techId: 'b', status: 'waiting' },
  ]},
  { id: 2, name: 'Cust2', status: 'waiting', assignments: [
    { serviceId: 's3', techId: 'a', status: 'waiting' },
  ]},
  { id: 3, name: 'Cust3', status: 'paid', assignments: [   // paid → excluded
    { serviceId: 's4', techId: 'a', status: 'paid' },
  ]},
  { id: 4, name: 'Cust4', status: 'waiting', assignments: [
    { serviceId: 's5', techId: '', status: 'waiting' },    // unassigned → excluded
  ]},
];

test('myActiveAssignments returns only this tech\'s lines on active entries', () => {
  const mine = myActiveAssignments(queue, 'a');
  assert.equal(mine.length, 2);                               // Cust1/s1 + Cust2/s3 (paid + unassigned excluded)
  assert.deepEqual(mine.map(x => x.assignment.serviceId).sort(), ['s1', 's3']);
  assert.deepEqual(mine.map(x => x.entry.id).sort(), [1, 2]);
});

test('myActiveAssignments for another tech only sees their own active line', () => {
  const mine = myActiveAssignments(queue, 'b');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].assignment.serviceId, 's2');
});

test('myActiveAssignments handles empty / missing input', () => {
  assert.deepEqual(myActiveAssignments([], 'a'), []);
  assert.deepEqual(myActiveAssignments(queue, ''), []);
  assert.deepEqual(myActiveAssignments(undefined, 'a'), []);
});

// myHistory: a tech's completed (complete + paid) work, queue merged with records.
const D = '2026-05-23T15:00:00.000Z';
const histQueue = [
  { id: 10, name: 'Liv',  checkinTime: D, status: 'complete', assignments: [{ serviceId: 's1', techId: 'a', status: 'complete', cost: 40 }] },
  { id: 11, name: 'Mara', checkinTime: D, status: 'inservice', assignments: [{ serviceId: 's2', techId: 'a', status: 'inservice', cost: 0 }] }, // not done → excluded
  { id: 12, name: 'Nia',  checkinTime: D, status: 'paid', completedAt: D, assignments: [{ serviceId: 's3', techId: 'a', status: 'paid', cost: 55 }] },
];
const histRecords = [
  { id: 12, name: 'Nia (rec dup)', checkinTime: D, status: 'paid', assignments: [{ serviceId: 's3', techId: 'a', status: 'paid', cost: 999 }] }, // dup id → record wins (source of truth)
  { id: 20, name: 'Omar', checkinTime: D, status: 'paid', completedAt: D, assignments: [{ serviceId: 's1', techId: 'a', status: 'paid', cost: 30 }] },
  { id: 21, name: 'Pia',  checkinTime: D, status: 'paid', assignments: [{ serviceId: 's1', techId: 'b', status: 'paid', cost: 70 }] }, // other tech
  { id: 22, name: 'Gone', checkinTime: D, status: 'deleted', assignments: [{ serviceId: 's1', techId: 'a', status: 'paid', cost: 500 }] }, // deleted
];

test('myHistory sums complete + paid for the tech, RECORD wins on dup, excludes other/deleted/unfinished', () => {
  const lines = myHistory(histQueue, histRecords, [], 'a');
  // Liv 40 (complete, no record → from queue) + Nia 999 (paid, RECORD wins over queue's 55) + Omar 30 (record) = 3 lines / $1069
  assert.equal(lines.length, 3);
  assert.equal(lines.reduce((s, l) => s + l.cost, 0), 1069);
  assert.ok(!lines.some(l => l.name === 'Mara'));            // unfinished excluded
  assert.ok(!lines.some(l => l.cost === 55));                // record won the dup (queue's 55 ignored)
  assert.ok(!lines.some(l => l.name === 'Pia'));             // other tech
  assert.ok(!lines.some(l => l.cost === 500));               // deleted
});

test('myHistory honors the deletions list', () => {
  const lines = myHistory(histQueue, histRecords, ['12'], 'a');
  assert.ok(!lines.some(l => l.name && l.name.startsWith('Nia')));   // id 12 deleted via deletions
  assert.equal(lines.reduce((s, l) => s + l.cost, 0), 70);           // Liv 40 + Omar 30
});

test('myHistory empty / no tech', () => {
  assert.deepEqual(myHistory([], [], [], 'a'), []);
  assert.deepEqual(myHistory(histQueue, histRecords, [], ''), []);
});
