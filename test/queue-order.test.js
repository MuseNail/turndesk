// N1 queue display order: Paid group by checkout time (paidAt) most-recent-first; others by check-in.
// Run: node --test-force-exit --test test/queue-order.test.js
import './setup-globals.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queueDisplayCmp } from '../js/app/features/queue.js';

const ORDER = { waiting: 0, inservice: 1, complete: 2, paid: 3, done: 3 };
const isPaidStatus = s => s === 'paid' || s === 'done';
const sortIds = arr => [...arr].sort((a, b) => queueDisplayCmp(a, b, ORDER, isPaidStatus)).map(e => e.id);
const ci = n => new Date(2026, 0, 1, 9, n).toISOString();   // check-in times, ascending by n

test('status groups keep their order: waiting → in-service → complete → paid', () => {
  const list = [
    { id: 'p', status: 'paid', checkinTime: ci(0), paidAt: 100 },
    { id: 'w', status: 'waiting', checkinTime: ci(5) },
    { id: 'c', status: 'complete', checkinTime: ci(1) },
    { id: 'i', status: 'inservice', checkinTime: ci(2) },
  ];
  assert.deepEqual(sortIds(list), ['w', 'i', 'c', 'p']);
});

test('Paid group orders by paidAt MOST-RECENT first (not by check-in)', () => {
  const list = [
    { id: 'first-in', status: 'paid', checkinTime: ci(0), paidAt: 300 },   // checked in first, paid LAST
    { id: 'last-in', status: 'paid', checkinTime: ci(9), paidAt: 100 },    // checked in last, paid FIRST
    { id: 'mid', status: 'paid', checkinTime: ci(5), paidAt: 200 },
  ];
  assert.deepEqual(sortIds(list), ['first-in', 'mid', 'last-in']);   // by paidAt desc: 300, 200, 100
});

test('Paid ticket without paidAt falls back to check-in time (older paidAt still wins the top)', () => {
  const list = [
    { id: 'legacy', status: 'paid', checkinTime: ci(2) },               // no paidAt → uses checkinTime
    { id: 'stamped', status: 'paid', checkinTime: ci(0), paidAt: Date.now() + 1000 },  // real paidAt (newest) → top
  ];
  assert.deepEqual(sortIds(list)[0], 'stamped');
});

test('non-Paid groups stay oldest-check-in first', () => {
  const list = [
    { id: 'w2', status: 'waiting', checkinTime: ci(8) },
    { id: 'w1', status: 'waiting', checkinTime: ci(2) },
  ];
  assert.deepEqual(sortIds(list), ['w1', 'w2']);
});

test("'done' sorts with 'paid' and still by paidAt", () => {
  const list = [
    { id: 'd', status: 'done', checkinTime: ci(0), paidAt: 100 },
    { id: 'p', status: 'paid', checkinTime: ci(0), paidAt: 200 },
  ];
  assert.deepEqual(sortIds(list), ['p', 'd']);   // both group 3; paid paidAt 200 > done 100
});
