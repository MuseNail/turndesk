// Pure cores behind the page-level Save + reorder editor (Wave 1b) for Services & Retail Items:
//   coerceServiceRow/coerceItemRow — canonicalize an edited row (string inputs → numbers/null, trim)
//   catalogDirty                   — normalized dirty check (number vs input-string won't read dirty)
//   validateCatalogDraft           — whole-draft validation (required fields + dup-name across the draft)
//   reconcileRows                  — best-effort merge at Save (keep user order, untouched rows from LIVE,
//                                    drop remote-deleted (never resurrect), append concurrent adds, honor deletes)
import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { coerceServiceRow, coerceItemRow, catalogDirty, validateCatalogDraft, reconcileRows } from '../js/app/features/catalog.js';

// ── coercion ──
test('coerceServiceRow: baseCost "" → null, "30" → 30, trims, keeps id + desc', () => {
  assert.deepEqual(coerceServiceRow({ id: 'a', label: ' Gel ', abbr: ' GL ', baseCost: '30', desc: ' nice ' }),
    { id: 'a', label: 'Gel', abbr: 'GL', baseCost: 30, desc: 'nice' });
  assert.equal(coerceServiceRow({ id: 'a', baseCost: '' }).baseCost, null);
  assert.equal(coerceServiceRow({ id: 'a', baseCost: 'abc' }).baseCost, null);   // non-numeric → null, never NaN
});
test('coerceItemRow: price finite-or-0, trims', () => {
  assert.deepEqual(coerceItemRow({ id: 'i', label: ' Polish ', abbr: 'PO', price: '12' }),
    { id: 'i', label: 'Polish', abbr: 'PO', price: 12 });
  assert.equal(coerceItemRow({ id: 'i', price: '' }).price, 0);
  assert.equal(coerceItemRow({ id: 'i', price: 'x' }).price, 0);
});
test('coerce preserves unknown fields (e.g. a legacy Square link) rather than stripping them on edit', () => {
  const svc = coerceServiceRow({ id: 'a', label: 'Gel', abbr: 'GL', baseCost: '30', squareId: 'SQ1', variationId: 'V1' });
  assert.equal(svc.squareId, 'SQ1'); assert.equal(svc.variationId, 'V1'); assert.equal(svc.baseCost, 30);
  const it = coerceItemRow({ id: 'i', label: 'Polish', abbr: 'PO', price: '12', catalogId: 'C1' });
  assert.equal(it.catalogId, 'C1'); assert.equal(it.price, 12);
});

// ── dirty (normalized) ──
test('catalogDirty: number-vs-input-string does NOT read dirty', () => {
  const live = [{ id: 'a', label: 'Gel', abbr: 'GL', baseCost: 30 }];
  const base = JSON.stringify(live.map(coerceServiceRow));
  assert.equal(catalogDirty(base, [{ id: 'a', label: 'Gel', abbr: 'GL', baseCost: '30', desc: '' }], coerceServiceRow), false);
  assert.equal(catalogDirty(base, [{ id: 'a', label: 'Gel 2', abbr: 'GL', baseCost: '30' }], coerceServiceRow), true);   // edited
  assert.equal(catalogDirty(base, [{ id: 'a', label: 'Gel', abbr: 'GL', baseCost: '30' }, { id: 'b', label: 'New' }], coerceServiceRow), true);   // added
});
test('catalogDirty: a pure REORDER (no field change) reads dirty — the Save button must enable', () => {
  const live = [{ id: 'a', label: 'A', abbr: 'A', baseCost: 1 }, { id: 'b', label: 'B', abbr: 'B', baseCost: 2 }];
  const base = JSON.stringify(live.map(coerceServiceRow));
  assert.equal(catalogDirty(base, [live[1], live[0]], coerceServiceRow), true);   // swapped order only
});

// ── validation ──
test('validateCatalogDraft: service requires name + abbr; dup name across draft flagged with its id', () => {
  assert.equal(validateCatalogDraft('service', [{ id: 'a', label: 'Gel', abbr: 'GL' }]), null);
  assert.equal(validateCatalogDraft('service', [{ id: 'a', label: '', abbr: 'GL' }]).id, 'a');
  assert.equal(validateCatalogDraft('service', [{ id: 'a', label: 'Gel', abbr: '' }]).id, 'a');
  assert.equal(validateCatalogDraft('service', [{ id: 'a', label: 'Gel', abbr: 'G1' }, { id: 'b', label: 'gel', abbr: 'G2' }]).id, 'b');   // dup (case-insensitive) → the 2nd
});
test('validateCatalogDraft: item requires a name (abbr optional); dup item names are ALLOWED', () => {
  assert.equal(validateCatalogDraft('item', [{ id: 'i', label: 'Polish', abbr: '' }]), null);
  assert.equal(validateCatalogDraft('item', [{ id: 'i', label: '' }]).id, 'i');
  // two retail items may share a label (e.g. two gift-card SKUs) — only services enforce unique names
  assert.equal(validateCatalogDraft('item', [{ id: 'a', label: 'Gift Card' }, { id: 'b', label: 'Gift Card' }]), null);
});

// ── reconcile ──
const C = coerceServiceRow;
test('reconcile: no user change → committed == live (order preserved)', () => {
  const live = [{ id: 'a', label: 'A', abbr: 'A', baseCost: 1 }, { id: 'b', label: 'B', abbr: 'B', baseCost: 2 }];
  const base = live.map(C), draft = live.map(r => ({ ...r }));
  assert.deepEqual(reconcileRows(live, base, draft, new Set(), C), live);
});
test('reconcile: a user-edited row commits coerced user values; untouched rows take LIVE (preserve concurrent edit)', () => {
  const base = [{ id: 'a', label: 'A', abbr: 'A', baseCost: 1 }, { id: 'b', label: 'B', abbr: 'B', baseCost: 2 }];
  const live = [{ id: 'a', label: 'A', abbr: 'A', baseCost: 1 }, { id: 'b', label: 'B-remote', abbr: 'B', baseCost: 2 }]; // b edited elsewhere
  const draft = [{ id: 'a', label: 'A2', abbr: 'A', baseCost: '1' }, { id: 'b', label: 'B', abbr: 'B', baseCost: '2' }]; // user edited a only
  const out = reconcileRows(live, base, draft, new Set(), C);
  assert.equal(out[0].label, 'A2');            // user's edit to a
  assert.equal(out[1].label, 'B-remote');      // concurrent edit to the untouched b is preserved
});
test('reconcile: user reorder preserved; untouched rows still from live', () => {
  const base = [{ id: 'a', label: 'A', abbr: 'A' }, { id: 'b', label: 'B', abbr: 'B' }];
  const live = base.map(r => ({ ...r }));
  const draft = [{ id: 'b', label: 'B', abbr: 'B' }, { id: 'a', label: 'A', abbr: 'A' }];   // swapped
  assert.deepEqual(reconcileRows(live, base, draft, new Set(), C).map(r => r.id), ['b', 'a']);
});
test('reconcile: new row kept; remote-deleted untouched row DROPPED (never resurrected)', () => {
  const base = [{ id: 'a', label: 'A', abbr: 'A' }, { id: 'b', label: 'B', abbr: 'B' }];
  const live = [{ id: 'a', label: 'A', abbr: 'A' }];   // b was deleted on another device
  const draft = [{ id: 'a', label: 'A', abbr: 'A' }, { id: 'b', label: 'B', abbr: 'B' }, { id: 'new1', label: 'New', abbr: 'NW' }];
  const ids = reconcileRows(live, base, draft, new Set(), C).map(r => r.id);
  assert.deepEqual(ids, ['a', 'new1']);   // b (remote-deleted, untouched) dropped; new1 kept
});
test('reconcile: user-deleted id dropped; concurrent remote ADD appended', () => {
  const base = [{ id: 'a', label: 'A', abbr: 'A' }, { id: 'b', label: 'B', abbr: 'B' }];
  const live = [{ id: 'a', label: 'A', abbr: 'A' }, { id: 'b', label: 'B', abbr: 'B' }, { id: 'c', label: 'C-remote', abbr: 'C' }];
  const draft = [{ id: 'a', label: 'A', abbr: 'A' }];   // user deleted b
  const ids = reconcileRows(live, base, draft, new Set(['b']), C).map(r => r.id);
  assert.deepEqual(ids, ['a', 'c']);   // b gone, c (concurrent add) appended
});
