// Dedicated per-service bonus counters (v5.91): getDedicatedBonusServices + getTechTurns().dedicated.
// Run: node --test-force-exit --test test/turn-dedicated-bonus.test.js
import './setup-globals.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getState } from '../js/app/store.js';
import { getDedicatedBonusServices, getTechTurns, generalBonusCount, _techDoesService } from '../js/app/features/turns.js';

function reset() {
  getState().config.turn_config = {};
  getState().config.turns_skips = [];
  getState().config.half_services = [];
  getState().config.bonus_services = [];
  getState().config.services = [];
  getState().queue = [];
}
const E = (id, techId, a) => ({ id, name: id, checkinTime: new Date().toISOString(), status: a.status, assignments: [{ techId, assignedAt: Date.now(), ...a }] });

// ── getDedicatedBonusServices ──
test('getDedicatedBonusServices: first ≤3 LIVE services, in bonus_services order, DEDUPED', () => {
  reset();
  getState().config.services = [
    { id: 'a', label: 'Wax', abbr: 'WAX' }, { id: 'b', label: 'Lash', abbr: 'LSH' },
    { id: 'c', label: 'Brow', abbr: 'BRW' }, { id: 'd', label: 'Tint', abbr: 'TNT' },
  ];
  getState().config.bonus_services = ['a', 'a', 'b', 'c', 'd'];   // duplicate 'a' + a 4th service
  const ded = getDedicatedBonusServices();
  assert.deepEqual(ded.map(s => s.id), ['a', 'b', 'c']);          // deduped, capped at 3, order preserved
  assert.equal(ded[0].abbr, 'WAX');
  reset();
});
test('getDedicatedBonusServices: drops ids with no live service; abbr falls back to label', () => {
  reset();
  getState().config.services = [{ id: 'a', label: 'Wax' }];      // no abbr
  getState().config.bonus_services = ['gone', 'a'];              // 'gone' resolves to nothing
  const ded = getDedicatedBonusServices();
  assert.deepEqual(ded.map(s => s.id), ['a']);
  assert.equal(ded[0].abbr, 'Wax');                              // falls back to label
  reset();
});

// ── getTechTurns().dedicated ──
test('getTechTurns().dedicated: per-serviceId bonus tally; bonus stays ALL bonus (back-compat); dedSum ≤ bonus', () => {
  reset();
  getState().config.bonus_services = ['wax', 'lash'];
  getState().config.services = [{ id: 'wax', label: 'Wax' }, { id: 'lash', label: 'Lash' }, { id: 'gel', baseCost: 30 }];
  getState().queue = [
    E('e1', 't1', { serviceId: 'wax', cost: 0, status: 'inservice' }),   // always-bonus
    E('e2', 't1', { serviceId: 'wax', cost: 0, status: 'complete' }),    // always-bonus
    E('e3', 't1', { serviceId: 'lash', cost: 0, status: 'waiting' }),    // always-bonus
    E('e4', 't1', { serviceId: 'gel', cost: 40, status: 'paid' }),       // full (not bonus)
  ];
  const t = getTechTurns('t1');
  assert.equal(t.bonus, 3);                                      // unchanged: ALL bonus turns
  assert.deepEqual(t.dedicated, { wax: 2, lash: 1 });
  const ded = getDedicatedBonusServices();
  const dedSum = ded.reduce((s, x) => s + (t.dedicated[x.id] || 0), 0);
  assert.ok(dedSum <= t.bonus);                                  // invariant: the split can never go negative
  assert.equal(t.bonus - dedSum, 0);                            // both are dedicated → general +b = 0
  reset();
});
test('getTechTurns().dedicated: a cost-bonus (non-always-bonus) service stays in the general +b', () => {
  reset();
  getState().config.bonus_services = ['wax'];
  getState().config.services = [{ id: 'wax', label: 'Wax' }, { id: 'cheap', baseCost: 5 }];   // cheap ≤ bonusMax → bonus by cost
  getState().queue = [
    E('e1', 't1', { serviceId: 'wax', cost: 0, status: 'inservice' }),   // dedicated add-on
    E('e2', 't1', { serviceId: 'cheap', cost: 5, status: 'paid' }),      // bonus by COST, not an add-on
  ];
  const t = getTechTurns('t1');
  assert.equal(t.bonus, 2);
  const ded = getDedicatedBonusServices();
  const dedSum = ded.reduce((s, x) => s + (t.dedicated[x.id] || 0), 0);
  assert.equal(dedSum, 1);                                       // only wax
  assert.equal(t.bonus - dedSum, 1);                            // the cheap cost-bonus remains in the general +b
  reset();
});
// ── per-tech capability filter (only show a service's counter for a tech who does it) ──
test('a service counter shows only for a tech who does it; the filtered list also drives the +b subtraction (no lost count)', () => {
  const dedServices = [{ id: 'wax' }, { id: 'lash' }];
  const waxOnly = { services: ['wax'] };          // does wax, not lash
  const generalist = { services: [] };            // empty menu = does everything
  // which counters show
  assert.deepEqual(dedServices.filter(s => _techDoesService(waxOnly, s.id)).map(s => s.id), ['wax']);
  assert.deepEqual(dedServices.filter(s => _techDoesService(generalist, s.id)).map(s => s.id), ['wax', 'lash']);
  // a wax-only tech who was manually assigned a lash (bonus 3 = wax2 + lash1): lash is NOT a column for them,
  // and because the SAME filtered list feeds generalBonusCount, the lash stays in their general +b (not lost).
  const tt = { bonus: 3, dedicated: { wax: 2, lash: 1 } };
  const techDed = dedServices.filter(s => _techDoesService(waxOnly, s.id));   // [wax]
  assert.equal(generalBonusCount(tt, techDed), 1);   // 3 - 2(wax) = 1 (the lash turn remains visible in +b)
});

// ── generalBonusCount (the one formula shared by the board + floor roster) ──
test('generalBonusCount: bonus minus the dedicated add-ons, clamped ≥0', () => {
  const tt = { bonus: 3, dedicated: { wax: 2, lash: 1, cheap: 1 } };
  assert.equal(generalBonusCount(tt, [{ id: 'wax' }, { id: 'lash' }]), 0);   // 3 - (2+1)
  assert.equal(generalBonusCount(tt, [{ id: 'wax' }]), 1);                   // 3 - 2 (cheap stays general)
  assert.equal(generalBonusCount(tt, []), 3);                               // none dedicated → all general
  assert.equal(generalBonusCount({ bonus: 0, dedicated: {} }, [{ id: 'x' }]), 0);  // never negative
});

test('getTechTurns().dedicated: non-default precedence — a dedicated service priced high classifies full, NOT an add-on', () => {
  reset();
  getState().config.turn_config = { precedence: 'highestValue' };
  getState().config.bonus_services = ['wax'];
  getState().config.services = [{ id: 'wax', label: 'Wax', baseCost: 50 }];
  getState().queue = [E('e1', 't1', { serviceId: 'wax', cost: 50, status: 'paid' })];   // highestValue → full
  const t = getTechTurns('t1');
  assert.equal(t.full, 1);
  assert.equal(t.bonus, 0);
  assert.deepEqual(t.dedicated, {});                            // not counted as a dedicated add-on
  reset();
});
