// SaaS billing Phase 1 — reconcileAccount: the pure merge of Helcim subscription truth
// into a billing account. There are NO billing webhooks (spec §10 addendum) — this runs
// on operator view / salon Billing view / manual sync, so it must be IDEMPOTENT by
// construction: history merges keyed by Helcim payment id, statuses derive from the
// payments array, and canceled/comped are sticky (operator decisions outrank Helcim).
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileAccount } from '../cloudflare/worker.js';

const acct = o => ({
  accountId: 'lux-nails', salonSlugs: ['lux-nails'], planId: 'starter', planVersion: 1,
  status: 'active', trialEndsAt: null, compUntil: null, currentPeriodEnd: null,
  paymentMethodType: 'card', helcimCustomerId: 77, helcimSubscriptionId: 501,
  pastDueSince: null, lastFailureReason: null, history: [], ...o,
});
const sub = (payments, extra) => ({ id: 501, status: 'active', dateBilling: '2026-08-01', recurringAmount: 34, payments, ...extra });
const pay = o => ({ id: 9001, status: 'approved', amount: 34, invoiceNumber: 'INV100', date: '2026-07-01', ...o });

test('an approved payment lands in history (cents) and keeps status active', () => {
  const a = reconcileAccount(acct(), sub([pay()]));
  assert.equal(a.history.length, 1);
  assert.equal(a.history[0].amountCents, 3400, 'dollars from Helcim → integer cents internally');
  assert.equal(a.history[0].helcimPaymentId, 9001);
  assert.equal(a.status, 'active');
  assert.equal(a.currentPeriodEnd, '2026-08-01', 'next billing date mirrored');
});

test('reconcile is idempotent — running twice never duplicates history', () => {
  const once = reconcileAccount(acct(), sub([pay()]));
  const twice = reconcileAccount(once, sub([pay()]));
  assert.equal(twice.history.length, 1);
});

test('a declined payment → past_due, pastDueSince set once, failure reason surfaced', () => {
  const s = sub([pay({ id: 9002, status: 'declined', errorMessage: 'Insufficient funds' })]);
  const a1 = reconcileAccount(acct({ status: 'active' }), s);
  assert.equal(a1.status, 'past_due');
  assert.ok(a1.pastDueSince > 0);
  assert.equal(a1.lastFailureReason, 'Insufficient funds');
  const firstSeen = a1.pastDueSince;
  const a2 = reconcileAccount(a1, s);
  assert.equal(a2.pastDueSince, firstSeen, 'not re-stamped on a later sync');
});

test('an approved payment AFTER a declined one recovers to active and clears the past-due marks', () => {
  const s = sub([
    pay({ id: 9002, status: 'declined', date: '2026-07-01', errorMessage: 'Insufficient funds' }),
    pay({ id: 9003, status: 'approved', date: '2026-07-03' }),
  ]);
  const a = reconcileAccount(acct({ status: 'past_due', pastDueSince: 5, lastFailureReason: 'Insufficient funds' }), s);
  assert.equal(a.status, 'active');
  assert.equal(a.pastDueSince, null);
  assert.equal(a.lastFailureReason, null);
  assert.equal(a.history.length, 2, 'both payments recorded');
});

test('waiting payments are recorded but drive no status change', () => {
  const a = reconcileAccount(acct({ status: 'active' }), sub([pay({ id: 9004, status: 'waiting', date: '2026-08-01' })]));
  assert.equal(a.status, 'active');
  assert.equal(a.history.length, 1);
});

test('canceled is sticky — an approved payment cannot resurrect a canceled account', () => {
  const a = reconcileAccount(acct({ status: 'canceled' }), sub([pay()]));
  assert.equal(a.status, 'canceled');
  assert.equal(a.history.length, 1, 'the money movement is still recorded');
});

test('comped is sticky — reconcile never flips an operator comp', () => {
  const a = reconcileAccount(acct({ status: 'comped', compUntil: 99 }), sub([pay({ id: 9005, status: 'declined' })]));
  assert.equal(a.status, 'comped');
});

test('a failed (hard) payment surfaces its reason too', () => {
  const a = reconcileAccount(acct(), sub([pay({ id: 9006, status: 'failed', errorMessage: 'Card expired' })]));
  assert.equal(a.status, 'past_due');
  assert.equal(a.lastFailureReason, 'Card expired');
});

test('no subscription payload → account returned unchanged', () => {
  const before = acct();
  const a = reconcileAccount(before, null);
  assert.deepEqual(a, before);
});

test('an id-less payment does NOT duplicate across repeated syncs (synthetic key)', () => {
  const s = sub([pay({ id: undefined, invoiceNumber: 'INV-A', amount: 34, status: 'waiting' })]);
  const a1 = reconcileAccount(acct(), s);
  const a2 = reconcileAccount(a1, s);
  const a3 = reconcileAccount(a2, s);
  assert.equal(a3.history.filter(h => h.event === 'payment').length, 1, 'one row, not one per sync');
});

test('a waiting→approved transition on the same id UPSERTS the row (no frozen duplicate)', () => {
  const waiting = sub([pay({ id: 7001, status: 'waiting', amount: 34, date: '2026-07-01' })]);
  const approved = sub([pay({ id: 7001, status: 'approved', amount: 34, date: '2026-07-01' })]);
  const a1 = reconcileAccount(acct({ status: 'trialing' }), waiting);
  assert.equal(a1.history.length, 1);
  assert.equal(a1.history[0].note, 'helcim:waiting');
  const a2 = reconcileAccount(a1, approved);
  assert.equal(a2.history.length, 1, 'still one row — updated in place, not appended');
  assert.equal(a2.history[0].note, 'helcim:approved', 'the settle is recorded');
  assert.equal(a2.status, 'active');
});

test('status is decided by the newest payment BY DATE even when the array is newest-first', () => {
  // array order = newest-first (declined older, approved is the latest by date but earlier in array)
  const s = sub([
    pay({ id: 8002, status: 'approved', amount: 34, date: '2026-07-10' }),
    pay({ id: 8001, status: 'declined', amount: 34, date: '2026-07-03', errorMessage: 'Insufficient funds' }),
  ]);
  const a = reconcileAccount(acct({ status: 'past_due', pastDueSince: 5 }), s);
  assert.equal(a.status, 'active', 'the 07-10 approval is newest by date, so the account is active');
  assert.equal(a.pastDueSince, null);
});
