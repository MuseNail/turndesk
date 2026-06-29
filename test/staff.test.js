import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { staffByPin, myActiveAssignments, myHistory } from '../js/app/staff.js';

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
