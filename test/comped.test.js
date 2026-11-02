// Comp redesign (Muse v5.65 port): a comped line keeps its real price (a.cost); the CUSTOMER pays $0
// for it (lineCharge excludes it) but the TECH still earns on the full price (raw a.cost, unchanged),
// and the business tracks the giveaway (compedAmount). ticketTotal = the customer charge → excludes comps.
import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { lineCharge, compedAmount, ticketTotal } from '../js/app/utils.js';
import { getState } from '../js/app/store.js';
import { buildCombinedRecords, computeMetrics } from '../js/app/features/reports.js';

// ── lineCharge: what the CUSTOMER pays for a line (comped → 0) ──
test('lineCharge: a normal line charges its cost', () => {
  assert.equal(lineCharge({ cost: 40 }), 40);
});
test('lineCharge: a comped line charges $0 even with a price', () => {
  assert.equal(lineCharge({ cost: 40, comped: true }), 0);
});
test('lineCharge: missing cost / null → 0', () => {
  assert.equal(lineCharge({}), 0);
  assert.equal(lineCharge(null), 0);
});

// ── compedAmount: the business giveaway (the Comped total) ──
test('compedAmount: a comped line contributes its price', () => {
  assert.equal(compedAmount({ cost: 40, comped: true }), 40);
});
test('compedAmount: a non-comped line contributes 0', () => {
  assert.equal(compedAmount({ cost: 40 }), 0);
  assert.equal(compedAmount(null), 0);
});

// ── ticketTotal: the customer charge excludes comped lines (the overcharge fix) ──
test('ticketTotal excludes a comped line but keeps the rest', () => {
  const r = { assignments: [{ cost: 40 }, { cost: 25, comped: true }], items: [], fees: [], discount: 0 };
  assert.equal(ticketTotal(r), 40);   // customer pays 40, not 65
});
test('ticketTotal: a fully-comped ticket is $0 to the customer', () => {
  const r = { assignments: [{ cost: 30, comped: true }], items: [], fees: [], discount: 0 };
  assert.equal(ticketTotal(r), 0);
});
test('ticketTotal still adds items + fees and subtracts discount, with comps excluded from services', () => {
  const r = { assignments: [{ cost: 40 }, { cost: 20, comped: true }], items: [{ price: 10, qty: 2 }], fees: [{ amount: 5 }], discount: 8 };
  assert.equal(ticketTotal(r), 40 + 20 + 5 - 8);   // 57 (the comped $20 service is out; the $20 retail item stays)
});

// ── Integration: the SPLIT — a comped line is $0 to the customer/business but full price to the tech ──
test('a comped line: customer/business EXCLUDE it, tech commission INCLUDES it, Comped total counts it', () => {
  const s = getState();
  s.config.staff = [{ id: 't1', name: 'Alice', commission: 50, checkType: 'variable' }];
  s.config.inactive_staff = [];
  s.records = [{
    id: 'r1', status: 'paid', name: 'Guest', phone: '', checkinTime: '2024-06-15T15:00:00.000Z',
    assignments: [
      { serviceId: 's1', techId: 't1', cost: 40 },                 // normal: customer pays, tech earns
      { serviceId: 's2', techId: 't1', cost: 20, comped: true },   // comp: customer $0, tech still earns $20
    ],
    items: [], fees: [], discount: 0, totalCost: 999,   // stale totalCost — must be re-derived to 40
  }];
  s.queue = []; s.deletions = [];

  const rec = buildCombinedRecords().find(r => r.id === 'r1');
  assert.equal(rec.totalCost, 40, 'customer total excludes the comped $20');

  const m = computeMetrics(new Date('2024-06-01'), new Date('2024-06-30'));
  assert.equal(m.svcTotal, 40, 'business services revenue excludes the comp');
  assert.equal(m.totalIncome, 40, 'business income excludes the comp');
  assert.equal(m.compedTotal, 20, 'the Comped total is the giveaway');
  assert.equal(m.commission, 30, 'tech commission is 50% of the FULL $60 (comp included) — the tech is paid');
});
