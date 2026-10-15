// payrollColumnTotals(T, curDays, prevDays) — the pure summation behind the pinned "All techs"
// Total column on the Payroll tab. It sums the ALREADY-RESOLVED per-tech rows (overrides folded
// in, lock snapshot applied — that resolution lives in renderPayrollPage and is covered by the
// preview check), so these tests exercise the arithmetic: correct sums, NaN-coercion of old
// lock-snapshot fields, raw commission (refunds stay a separate row), negative refunds, and the
// per-day guard (a tech with no entry for a day must not crash the whole Payroll render).
import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { payrollColumnTotals } from '../js/app/features/reports.js';

const CUR = ['2026-05-18', '2026-05-19'];
const PREV = ['2026-05-04', '2026-05-05'];

// A resolved tech row, shaped exactly like renderPayrollPage's `x`.
const row = (o = {}) => ({
  c: { billed: 0, commission: 0, refund: 0, refundComm: 0, daily: {}, ...(o.c || {}) },
  p: { billed: 0, commission: 0, refund: 0, refundComm: 0, daily: {}, ...(o.p || {}) },
  cChk: o.cChk, pChk: o.pChk, cDed: o.cDed, pDed: o.pDed,
  cCash: o.cCash, pCash: o.pCash, cTotal: o.cTotal, pTotal: o.pTotal,
});

test('sums billed, commission, check, deduction, cash, total across techs (current + prev)', () => {
  const T = [
    row({ c: { billed: 3200, commission: 1920 }, p: { billed: 3000, commission: 1800 }, cChk: 1000, pChk: 1000, cDed: 0, pDed: 0, cCash: 920, pCash: 800, cTotal: 1920, pTotal: 1800 }),
    row({ c: { billed: 1800, commission: 810 },  p: { billed: 1700, commission: 765 },  cChk: 500,  pChk: 450,  cDed: 0, pDed: 0, cCash: 310, pCash: 315, cTotal: 810,  pTotal: 765 }),
  ];
  const t = payrollColumnTotals(T, CUR, PREV);
  assert.equal(t.billed, 5000);
  assert.equal(t.comm, 2730);
  assert.equal(t.pBilled, 4700);
  assert.equal(t.chk, 1500);
  assert.equal(t.cash, 1230);
  assert.equal(t.total, 2730);
  assert.equal(t.pTotal, 2565);
});

test('an overridden check (resolved value on the row) lands in the total, not the rule value', () => {
  const T = [
    row({ cChk: 1300, cCash: 0, cTotal: 1300 }),   // override pushed check to 1300
    row({ cChk: 500,  cCash: 310, cTotal: 810 }),
  ];
  const t = payrollColumnTotals(T, CUR, PREV);
  assert.equal(t.chk, 1800);     // 1300 (overridden) + 500
  assert.equal(t.total, 2110);
});

test('coerces undefined fields to 0 (old lock snapshot with no deduction/total) — never NaN', () => {
  const T = [
    row({ cChk: 1000, cCash: 900, cDed: undefined, cTotal: undefined }),
    row({ cChk: 500,  cCash: 300, cDed: 0,         cTotal: 800 }),
  ];
  const t = payrollColumnTotals(T, CUR, PREV);
  assert.ok(Number.isFinite(t.ded), 'deduction total is finite');
  assert.ok(Number.isFinite(t.total), 'paid total is finite');
  assert.equal(t.ded, 0);
  assert.equal(t.total, 800);   // undefined treated as 0, + 800
});

test('commission total is RAW (refunds are a separate total, never folded in)', () => {
  const T = [
    row({ c: { billed: 2000, commission: 1000, refund: -200, refundComm: -100 } }),
  ];
  const t = payrollColumnTotals(T, CUR, PREV);
  assert.equal(t.comm, 1000, 'raw commission, refund impact excluded');
  assert.equal(t.refund, -200, 'refunds summed raw (negative)');
  assert.equal(t.refundComm, -100);
});

test('per-day totals align to curDays/prevDays and tolerate techs missing a day', () => {
  const T = [
    row({ c: { daily: { '2026-05-18': { billed: 800, commission: 480 } } },   // worked day 0 only
          p: { daily: { '2026-05-04': { billed: 700, commission: 420 } } } }),
    row({ c: { daily: { '2026-05-19': { billed: 400, commission: 180 } } },   // worked day 1 only
          p: { daily: {} } }),
  ];
  const t = payrollColumnTotals(T, CUR, PREV);
  assert.deepEqual(t.daily[0], { billed: 800, comm: 480 });
  assert.deepEqual(t.daily[1], { billed: 400, comm: 180 });
  assert.deepEqual(t.pDaily[0], { billed: 700, comm: 420 });
  assert.deepEqual(t.pDaily[1], { billed: 0, comm: 0 });
  assert.equal(t.daily.length, CUR.length);
});

test('empty T → all zeros, daily arrays sized to the day lists', () => {
  const t = payrollColumnTotals([], CUR, PREV);
  assert.equal(t.billed, 0);
  assert.equal(t.total, 0);
  assert.equal(t.daily.length, 2);
  assert.deepEqual(t.daily[0], { billed: 0, comm: 0 });
});

test('does not mutate the input rows (the Lock button snapshots T after this runs)', () => {
  const T = [row({ c: { billed: 100, commission: 50 }, cChk: 50, cCash: 0, cTotal: 50 })];
  const snapshot = JSON.stringify(T);
  payrollColumnTotals(T, CUR, PREV);
  assert.equal(JSON.stringify(T), snapshot, 'T is unchanged');
});
