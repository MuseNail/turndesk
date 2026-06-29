import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getState } from '../js/app/store.js';
import { buildCombinedRecords, reconcileSquareData } from '../js/app/features/reports.js';

// buildCombinedRecords: records are the single source of truth for finished sales — a paid
// queue entry surfaces only when no record exists for its id. (Records-authoritative redesign.)
function seed({ records = [], queue = [], deletions = [] }) {
  const s = getState();
  s.records = records; s.queue = queue; s.deletions = deletions;
}
const D = '2026-05-20T15:00:00.000Z';

test('buildCombinedRecords: the record wins over a paid queue copy of the same id', () => {
  seed({
    records: [{ id: 1, status: 'paid', checkinTime: D, assignments: [{ cost: 97 }], totalCost: 97 }],
    queue:   [{ id: 1, status: 'paid', checkinTime: D, assignments: [{ cost: 100 }], totalCost: 100 }],
  });
  const c = buildCombinedRecords();
  assert.equal(c.length, 1);
  assert.equal(c.find(x => String(x.id) === '1').totalCost, 97);   // record (edited) wins, not the queue copy
});

test('buildCombinedRecords: a paid queue entry with no record still surfaces (crash-safety)', () => {
  seed({ records: [], queue: [{ id: 2, status: 'paid', checkinTime: D, assignments: [{ cost: 42 }], totalCost: 42 }] });
  const c = buildCombinedRecords();
  assert.equal(c.length, 1);
  assert.equal(c[0].totalCost, 42);
});

test('buildCombinedRecords: deleted records and deletion ids are excluded', () => {
  seed({
    records: [{ id: 3, status: 'paid', checkinTime: D, assignments: [{ cost: 10 }], totalCost: 10 },
              { id: 4, status: 'deleted', checkinTime: D, totalCost: 99 }],
    queue:   [{ id: 5, status: 'paid', checkinTime: D, assignments: [{ cost: 20 }], totalCost: 20 }],
    deletions: ['5'],
  });
  assert.deepEqual(buildCombinedRecords().map(x => String(x.id)).sort(), ['3']);
});

test('buildCombinedRecords: only finished (paid/done) queue entries are included', () => {
  seed({ records: [], queue: [{ id: 6, status: 'inservice', checkinTime: D, assignments: [{ cost: 30 }], totalCost: 30 }] });
  assert.equal(buildCombinedRecords().length, 0);
});

test('buildCombinedRecords: stale totalCost is recomputed from parts (bulletproofing)', () => {
  seed({ records: [{ id: 7, status: 'paid', checkinTime: D, assignments: [{ cost: 40 }], fees: [{ amount: 2 }], totalCost: 40 }], queue: [] });
  assert.equal(buildCombinedRecords()[0].totalCost, 42);   // 40 svc + 2 fee, ignoring the stale stored 40
});

test('reconcileSquareData: matches Square payments to records by payment id', () => {
  const payments = [
    { id: 'pay_A', total: 6500, status: 'COMPLETED' },   // matched
    { id: 'pay_B', total: 4800, status: 'COMPLETED' },   // in Square, not app
    { id: 'pay_X', total: 9900, status: 'CANCELED' },    // ignored (not completed)
  ];
  const recs = [
    { name: 'Alice', totalCost: 65, status: 'paid', squarePaymentIds: ['pay_A'] },      // matched
    { name: 'Bob',   totalCost: 50, status: 'paid', squarePaymentIds: [] },             // in app, not Square
    { name: 'Cara',  totalCost: 30, status: 'paid', squarePaymentIds: ['pay_GONE'] },   // id not in Square → in app, not Square
  ];
  const R = reconcileSquareData(payments, recs);
  assert.equal(R.squareCount, 2);                       // canceled excluded
  assert.equal(R.matchedCount, 1);                      // only pay_A
  assert.equal(R.inSquareNotApp.length, 1);
  assert.equal(R.inSquareNotApp[0].id, 'pay_B');
  assert.equal(R.inAppNotSquare.length, 2);             // Bob + Cara
  assert.equal(R.squareTotalCents, 6500 + 4800);
  assert.equal(R.appTotalCents, 6500 + 5000 + 3000);
});

test('reconcileSquareData: app total = card+cash+Zelle+tips, excludes gift; tender-less falls back to total', () => {
  const payments = [{ id: 'p1', total: 4500, status: 'COMPLETED' }];
  const recs = [
    { name: 'A', totalCost: 65, status: 'paid', squarePaymentIds: ['p1'], tenders: { card: 40, cash: 0, gift: 25, zelle: 0 }, tip: 5 }, // square-bound 40 + tip 5 = 45 (gift 25 excluded)
    { name: 'B', totalCost: 30, status: 'paid', squarePaymentIds: [] },   // tender-less → fall back to 30
  ];
  const R = reconcileSquareData(payments, recs);
  assert.equal(R.appTotalCents, 4500 + 3000);
});

test('reconcileSquareData: gift-card-sale payments are matched + counted in the app total', () => {
  const payments = [
    { id: 'rec_p', total: 5000, status: 'COMPLETED' },   // a regular sale → matched to a record
    { id: 'gc_p',  total: 5000, status: 'COMPLETED' },   // a gift-card sale → matched to a gift card
  ];
  const recs = [{ name: 'A', totalCost: 50, status: 'paid', squarePaymentIds: ['rec_p'], tenders: { card: 50 } }];
  const giftSales = [{ amount: 50, squarePaymentIds: ['gc_p'] }];
  const R = reconcileSquareData(payments, recs, giftSales);
  assert.equal(R.inSquareNotApp.length, 0);     // gift-card-sale payment is NOT flagged as unmatched
  assert.equal(R.matchedCount, 2);
  assert.equal(R.appTotalCents, 5000 + 5000);   // record (card $50) + gift sale ($50)
});

test('reconcileSquareData: fully-refunded payments are not flagged; refunds net both sides', () => {
  const payments = [
    { id: 'p1', total: 4600, refunded: 4600, status: 'COMPLETED' },   // fully refunded → net 0, NOT flagged
    { id: 'p2', total: 5000, refunded: 0,    status: 'COMPLETED' },   // live, matched to a record
    { id: 'p3', total: 3000, refunded: 0,    status: 'COMPLETED' },   // live, unmatched
  ];
  const recs = [{ name: 'A', totalCost: 50, status: 'paid', squarePaymentIds: ['p2'], tenders: { card: 50 } }];
  const refunds = [{ status: 'refund', totalCost: -46 }];   // the app's $46 refund
  const R = reconcileSquareData(payments, recs, [], refunds);
  assert.equal(R.squareCount, 2);                       // p1 (fully refunded) excluded
  assert.equal(R.inSquareNotApp.length, 1);             // only p3
  assert.equal(R.inSquareNotApp[0].id, 'p3');
  assert.equal(R.squareTotalCents, 0 + 5000 + 3000);    // net: p1=0, p2=5000, p3=3000
  assert.equal(R.appTotalCents, 5000 - 4600);           // record $50 − refund $46
});

test('reconcileSquareData: a fully gift-redeemed sale is NOT flagged as in-app-not-Square', () => {
  const payments = [{ id: 'p1', total: 5000, status: 'COMPLETED' }];
  const recs = [
    { name: 'CardSale', totalCost: 50, status: 'paid', squarePaymentIds: ['p1'], tenders: { card: 50 } },
    { name: 'GiftOnly', totalCost: 35, status: 'paid', squarePaymentIds: [], tenders: { card: 0, cash: 0, gift: 35, zelle: 0 } },
  ];
  const R = reconcileSquareData(payments, recs);
  assert.equal(R.inAppNotSquare.length, 0);   // gift redemption never hits Square → not a discrepancy
  assert.equal(R.appTotalCents, 5000);          // the $35 gift redemption is excluded from the app total
});

test('reconcileSquareData: gift sale matched by payment id regardless of its recorded date; total scoped to the batch', () => {
  const payments = [{ id: 'gc_now', total: 5600, status: 'COMPLETED' }];   // a cash gift-card sale in this period
  const giftSales = [
    { amount: 56, datePurchased: '',           squarePaymentIds: ['gc_now'] },   // linked, blank date — still matched by id
    { amount: 99, datePurchased: '2020-01-01', squarePaymentIds: ['gc_old'] },   // a different period; its id isn't in the batch
  ];
  const R = reconcileSquareData(payments, [], giftSales);
  assert.equal(R.inSquareNotApp.length, 0);    // the gift-card-sale payment is matched, not flagged
  assert.equal(R.matchedCount, 1);
  assert.equal(R.appTotalCents, 5600);          // only the in-batch gift sale counts; the old one is excluded
});
