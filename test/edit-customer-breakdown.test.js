// Item 3: edit-customer visit history reconciling breakdown.
// _visitBreakdown assembles service lines + items + fees - discount, with the total = the record's
// already-reconciled totalCost. Run: node --test-force-exit --test test/edit-customer-breakdown.test.js
import './setup-globals.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _visitBreakdown } from '../js/app/features/reports.js';

const lk = {
  svcLabel: id => ({ s1: 'Gel Mani', s2: 'Pedi' }[id] || id),
  techName: id => ({ t1: 'Jane' }[id] || ''),
  itemLabel: it => ({ i1: 'Nail File' }[it.itemId] || it.label || 'Item'),
  feeLabel: f => ({ f1: 'Card fee' }[f.feeId] || f.label || 'Fee'),
  chargeOf: a => (a.comped ? 0 : a.cost || 0),
};

test('_visitBreakdown assembles services + items + fees + discount with total = r.totalCost', () => {
  const r = {
    assignments: [{ serviceId: 's1', techId: 't1', cost: 30 }, { serviceId: 's2', techId: 't1', cost: 15 }],
    services: ['s1', 's2'],
    items: [{ itemId: 'i1', price: 5, qty: 2 }],
    fees: [{ feeId: 'f1', amount: 3 }],
    discount: 5,
    totalCost: 53,   // 30 + 15 + 10 + 3 - 5
  };
  const b = _visitBreakdown(r, lk);
  assert.deepEqual(b.serviceLines, [
    { service: 'Gel Mani', tech: 'Jane', charge: 30, comped: false },
    { service: 'Pedi', tech: 'Jane', charge: 15, comped: false },
  ]);
  assert.deepEqual(b.items, [{ label: 'Nail File', qty: 2, amount: 10 }]);   // price * qty
  assert.deepEqual(b.fees, [{ label: 'Card fee', amount: 3 }]);
  assert.equal(b.discount, 5);
  assert.equal(b.total, 53);
  // the pieces reconcile to the total:
  const sum = b.serviceLines.reduce((s, l) => s + (l.charge || 0), 0)
    + b.items.reduce((s, i) => s + i.amount, 0) + b.fees.reduce((s, f) => s + f.amount, 0) - b.discount;
  assert.equal(sum, b.total);
});

test('_visitBreakdown shows a comped service at $0 and flags it', () => {
  const r = { assignments: [{ serviceId: 's1', techId: 't1', cost: 40, comped: true }], services: ['s1'], totalCost: 0 };
  const b = _visitBreakdown(r, lk);
  assert.deepEqual(b.serviceLines, [{ service: 'Gel Mani', tech: 'Jane', charge: 0, comped: true }]);
  assert.equal(b.total, 0);
});

test('_visitBreakdown uses the item/fee label fallbacks when not in the catalog', () => {
  const r = { assignments: [], services: [], items: [{ itemId: 'gone', price: 4, qty: 1, label: 'Mystery' }], fees: [{ feeId: 'gone', amount: 2 }], totalCost: 6 };
  const b = _visitBreakdown(r, lk);
  assert.equal(b.items[0].label, 'Mystery');   // it.label fallback
  assert.equal(b.fees[0].label, 'Fee');         // final 'Fee' fallback
});

test('_visitBreakdown handles a record with no items/fees/discount', () => {
  const r = { assignments: [{ serviceId: 's1', techId: 't1', cost: 20 }], services: ['s1'], totalCost: 20 };
  const b = _visitBreakdown(r, lk);
  assert.deepEqual(b.items, []);
  assert.deepEqual(b.fees, []);
  assert.equal(b.discount, 0);
  assert.equal(b.total, 20);
});
