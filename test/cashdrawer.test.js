import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { countTotal, shiftCashSales, drawerExpected, drawerTipPayoutCents } from '../js/app/features/cashdrawer.js';

// The cash drawer reconciles physical cash against expected:
//   expected = opening + cash sales + cash-in − cash-out
//   over/short = counted − expected
// Counts are bills-only ($1–$100), so coins/cents land in over/short by design.

test('countTotal sums bill denominations, ignoring blanks/garbage', () => {
  assert.equal(countTotal({ 100: 2, 50: 1, 20: 3, 10: 0, 5: 4, 1: 7 }), 200 + 50 + 60 + 0 + 20 + 7);
  assert.equal(countTotal({}), 0);
  assert.equal(countTotal({ 20: '5' }), 100);       // string qty
  assert.equal(countTotal({ 50: -3, 1: 2 }), 2);    // negative qty ignored as 0
  assert.equal(countTotal(null), 0);
});

const drawer = {
  openedAt: '2026-05-30T13:00:00.000Z',
  openTotal: 200,
  movements: [
    { type: 'in', amount: 50 },
    { type: 'out', amount: 20 },
    { type: 'out', amount: 5.5 },
  ],
};
// Records: only paid ones with a cash tender, inside the window, count toward cash sales.
const records = [
  { status: 'paid', completedAt: '2026-05-30T14:00:00.000Z', tenders: { cash: 40, card: 10 } },   // ✓ 40
  { status: 'paid', completedAt: '2026-05-30T15:30:00.000Z', tenders: { cash: 12.25 } },           // ✓ 12.25 (cents)
  { status: 'paid', completedAt: '2026-05-30T16:00:00.000Z', tenders: { cash: 0, card: 80 } },     // card-only → 0
  { status: 'paid', completedAt: '2026-05-30T12:00:00.000Z', tenders: { cash: 99 } },              // before open → excluded
  { status: 'paid', completedAt: '2026-05-31T09:00:00.000Z', tenders: { cash: 30 } },              // after end → excluded
  { status: 'complete', completedAt: '2026-05-30T14:30:00.000Z', tenders: { cash: 25 } },          // not paid → excluded
  { status: 'paid', completedAt: '2026-05-30T14:45:00.000Z' },                                     // no tenders → excluded
];
const END = new Date('2026-05-30T17:00:00.000Z').getTime();

test('shiftCashSales counts only paid cash tenders within the shift window', () => {
  assert.equal(shiftCashSales(records, drawer, END), 40 + 12.25);
  assert.equal(shiftCashSales([], drawer, END), 0);
  assert.equal(shiftCashSales(records, null, END), 0);
});

test('drawerExpected = opening + cash sales + cash-in − cash-out', () => {
  // 200 (open) + 52.25 (sales) + 50 (in) − 25.5 (out)
  assert.equal(drawerExpected(records, drawer, END), 200 + 52.25 + 50 - 25.5);
});

test('over/short is counted minus expected; cents fall into it (bills-only counts)', () => {
  const expected = drawerExpected(records, drawer, END);   // 276.75
  const counted = countTotal({ 100: 2, 50: 1, 20: 1, 5: 1, 1: 1 });   // 276 (bills only)
  const overShort = counted - expected;
  assert.ok(Math.abs(overShort - -0.75) < 1e-9);   // 75¢ short — the unbankable cents
});

// drawerTipPayoutCents(tip, cashApplied, cashBill, fromDrawer) — the auto cash-out for a tip
// handed to the tech from the drawer. Full tip minus the part the customer paid in physical cash.
// Bill $100 / tip $10 across tender mixes (all cents):
test('drawerTipPayoutCents: card-collected tip pays out of the drawer (unchanged behavior)', () => {
  assert.equal(drawerTipPayoutCents(1000, 0, 0, true), 1000);          // card pays bill+tip
  assert.equal(drawerTipPayoutCents(1000, 0, 0, false), 0);            // box unchecked → no payout
  assert.equal(drawerTipPayoutCents(0, 0, 0, true), 0);                // no tip
});
test('drawerTipPayoutCents: customer cash covering the tip is NOT paid out again', () => {
  assert.equal(drawerTipPayoutCents(1000, 11000, 10000, true), 0);     // cash $110 covers bill $100 + tip $10
  assert.equal(drawerTipPayoutCents(1000, 10500, 10000, true), 500);   // cash covers half the tip → pay out the rest
});
test('drawerTipPayoutCents: Zelle/gift-covered tips DO pay out of the drawer (the v4.83 bug)', () => {
  assert.equal(drawerTipPayoutCents(1000, 0, 0, true), 1000);          // Zelle $110: no customer cash → full payout
  assert.equal(drawerTipPayoutCents(1000, 5000, 5000, true), 1000);    // cash $50 all went to the bill; Zelle covered the tip
});
