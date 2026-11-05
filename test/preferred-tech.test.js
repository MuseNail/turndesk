// W2-4 preferred-tech pure cores: the nudge decision + the phone→preferred resolve.
// Run: node --test-force-exit --test test/preferred-tech.test.js
import './setup-globals.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nudgeDecision } from '../js/app/features/turns.js';
import { resolvePreferredTechId } from '../js/app/features/square-customers.js';

const keyFn = p => (p || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');

// ── resolvePreferredTechId(customers, phone, keyFn) ──────────────────────────
test('resolve: null when no phone / no match / no preference', () => {
  assert.equal(resolvePreferredTechId([], '', keyFn), null);
  assert.equal(resolvePreferredTechId([{ phone: '5551234567', preferredTechId: 't1' }], '', keyFn), null);
  assert.equal(resolvePreferredTechId([{ phone: '5559998888' }], '5551234567', keyFn), null);
  assert.equal(resolvePreferredTechId([{ phone: '5551234567' }], '5551234567', keyFn), null); // match, no pref
});

test('resolve: returns the preferred tech for a matching phone (format-insensitive)', () => {
  const custs = [{ phone: '(555) 123-4567', preferredTechId: 't7' }];
  assert.equal(resolvePreferredTechId(custs, '555-123-4567', keyFn), 't7');
  assert.equal(resolvePreferredTechId(custs, '15551234567', keyFn), 't7');
});

test('resolve: among same-phone duplicates, prefers the record that HAS a preference', () => {
  const custs = [
    { id: 'a', phone: '5551234567' },                       // dup, no pref — first in array
    { id: 'b', phone: '5551234567', preferredTechId: 't9' }, // the one with a pref
  ];
  assert.equal(resolvePreferredTechId(custs, '5551234567', keyFn), 't9');
});

// ── nudgeDecision(prefId, need, {canDo, isBonusSvc, isLimitedBonus, prefRank}) ─
const PREF = ['fullset', 'fill', 'manicure', 'pedicure'];
const prefRank = id => { const i = PREF.indexOf(id); return i === -1 ? PREF.length : i; };
const isBonusSvc = id => id === 'wax' || id === 'brow';

test('nudge: null when no prefId, no needed services, or none the tech can do', () => {
  assert.equal(nudgeDecision(null, ['manicure'], { canDo: () => true, isBonusSvc, isLimitedBonus: false, prefRank }), null);
  assert.equal(nudgeDecision('t1', [], { canDo: () => true, isBonusSvc, isLimitedBonus: false, prefRank }), null);
  assert.equal(nudgeDecision('t1', ['manicure'], { canDo: () => false, isBonusSvc, isLimitedBonus: false, prefRank }), null);
});

test('nudge: generalist preferred tech gets their highest-preference doable service', () => {
  const r = nudgeDecision('t1', ['pedicure', 'fullset', 'manicure'], { canDo: () => true, isBonusSvc, isLimitedBonus: false, prefRank });
  assert.deepEqual(r, { techId: 't1', serviceId: 'fullset' });   // fullset is top of PREF
});

test('nudge: only offers a service the tech can actually do', () => {
  const r = nudgeDecision('t1', ['fullset', 'manicure'], { canDo: sid => sid === 'manicure', isBonusSvc, isLimitedBonus: false, prefRank });
  assert.deepEqual(r, { techId: 't1', serviceId: 'manicure' });
});

test('nudge: a limited-bonus specialist is handed the needed BONUS service (not a regular line)', () => {
  // Preferred tech can do a regular AND a bonus service the customer needs; as a limited-bonus
  // specialist they must take the bonus one so pre-assigning them doesn't strand it.
  const r = nudgeDecision('tw', ['manicure', 'wax'], { canDo: () => true, isBonusSvc, isLimitedBonus: true, prefRank });
  assert.deepEqual(r, { techId: 'tw', serviceId: 'wax' });
});

test('nudge: limited-bonus specialist with no needed bonus service falls back to a regular line', () => {
  const r = nudgeDecision('tw', ['manicure', 'pedicure'], { canDo: () => true, isBonusSvc, isLimitedBonus: true, prefRank });
  assert.deepEqual(r, { techId: 'tw', serviceId: 'manicure' });   // no bonus needed → highest-pref regular
});
