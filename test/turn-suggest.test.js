// Turn suggestions: skill-aware + bonus fairness rotation (fewest turns → fewest bonus → order).
// Run: node --test-force-exit --test test/turn-suggest.test.js
import './setup-globals.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getState } from '../js/app/store.js';
import { suggestTechForService, suggestTechsForEntry, _techDoesService, _techServiceSplit } from '../js/app/features/turns.js';

const now = new Date().toISOString();
const A = (techId, serviceId, cost, status = 'paid') => ({ techId, serviceId, cost, status, assignedAt: Date.now() });
const E = (id, assignments) => ({ id, name: id, checkinTime: now, status: 'paid', services: assignments.map(a => a.serviceId), assignments });
function setup({ staff, order, bonus, services, queue }) {
  Object.assign(getState().config, {
    staff, turns_order: order, turns_break: [], turns_off: [], inactive_staff: [],
    turns_skips: [], bonus_services: bonus || [], half_services: [], services: services || [], turn_config: {},
  });
  getState().queue = queue || [];
}

test('_techDoesService: empty/absent menu does everything; a listed menu gates', () => {
  assert.equal(_techDoesService({ services: [] }, 'x'), true);
  assert.equal(_techDoesService({}, 'x'), true);
  assert.equal(_techDoesService({ services: ['a', 'b'] }, 'a'), true);
  assert.equal(_techDoesService({ services: ['a', 'b'] }, 'c'), false);
  assert.equal(_techDoesService(null, 'x'), false);
});

test('bonus suggestion: fewest turns, then fewest bonus, then order', () => {
  setup({
    staff: [{ id: 't1', name: 'T1' }, { id: 't2', name: 'T2' }, { id: 't3', name: 'T3' }],
    order: ['t1', 't2', 't3'], bonus: ['wax'],
    services: [{ id: 'gel', label: 'Gel', baseCost: 40 }, { id: 'wax', label: 'Wax', baseCost: 5 }],
    queue: [
      E('e1', [A('t1', 'gel', 40), A('t1', 'gel', 40), A('t1', 'wax', 5)]),   // t1: 2 full, 1 bonus
      E('e2', [A('t2', 'gel', 40), A('t2', 'gel', 40)]),                      // t2: 2 full, 0 bonus
      E('e3', [A('t3', 'gel', 40), A('t3', 'gel', 40), A('t3', 'gel', 40)]),  // t3: 3 full
    ],
  });
  assert.equal(suggestTechForService('wax').techId, 't2');   // ties t1 on total(2); t2 has fewer bonus
});

test('bonus suggestion skips a tech who cannot do the service (skills checked first)', () => {
  setup({
    staff: [{ id: 't1', name: 'T1', services: ['gel'] }, { id: 't2', name: 'T2', services: ['gel', 'wax'] }],
    order: ['t1', 't2'], bonus: ['wax'],
    services: [{ id: 'gel', label: 'Gel', baseCost: 40 }, { id: 'wax', label: 'Wax', baseCost: 5 }],
    queue: [E('e2', [A('t2', 'gel', 40), A('t2', 'gel', 40)])],   // t2: 2 turns; t1: 0
  });
  assert.equal(suggestTechForService('wax').techId, 't2');   // t1 has fewer turns but can't wax
});

test('regular suggestion still picks fewest turns (skills checked)', () => {
  setup({
    staff: [{ id: 't1', name: 'T1' }, { id: 't2', name: 'T2' }], order: ['t1', 't2'], bonus: [],
    services: [{ id: 'gel', label: 'Gel', baseCost: 40 }],
    queue: [E('e1', [A('t1', 'gel', 40), A('t1', 'gel', 40)])],   // t1: 2, t2: 0
  });
  assert.equal(suggestTechForService('gel').techId, 't2');
});

test('suggestTechsForEntry routes a bonus service to the fewest-turns tech (skills checked)', () => {
  setup({
    staff: [{ id: 't1', name: 'T1' }, { id: 't2', name: 'T2' }], order: ['t1', 't2'], bonus: ['wax'],
    services: [{ id: 'wax', label: 'Wax', baseCost: 5 }, { id: 'gel', label: 'Gel', baseCost: 40 }],
    queue: [
      E('e1', [A('t1', 'gel', 40)]),   // t1: 1 full
      E('e2', [A('t2', 'wax', 5)]),    // t2: 0 full, 1 bonus
      { id: 'w1', name: 'New', checkinTime: now, status: 'waiting', services: ['wax'], assignments: [] },
    ],
  });
  const sug = suggestTechsForEntry(getState().queue.find(e => e.id === 'w1'));
  assert.equal(sug.wax.techId, 't2');   // t2 has fewer total turns (0 < 1)
});

// ── _techServiceSplit(st, catalog) → { available, unavailable } (v5.84 tech-bubble 3 columns) ──
const CAT = [{ id: 's1', label: 'Gel' }, { id: 's2', label: 'Pedi' }, { id: 's3', label: 'Wax' }];
test('_techServiceSplit: empty/absent menu → everything available, nothing unavailable', () => {
  assert.deepEqual(_techServiceSplit({ services: [] }, CAT), { available: CAT, unavailable: [] });
  assert.deepEqual(_techServiceSplit({}, CAT), { available: CAT, unavailable: [] });
});
test('_techServiceSplit: a listed menu splits by the catalog, preserving catalog order', () => {
  const r = _techServiceSplit({ services: ['s2'] }, CAT);
  assert.deepEqual(r.available.map(s => s.id), ['s2']);
  assert.deepEqual(r.unavailable.map(s => s.id), ['s1', 's3']);
});
test('_techServiceSplit: an unknown service id in the menu is ignored (not in the catalog)', () => {
  const r = _techServiceSplit({ services: ['s1', 'gone'] }, CAT);
  assert.deepEqual(r.available.map(s => s.id), ['s1']);
  assert.deepEqual(r.unavailable.map(s => s.id), ['s2', 's3']);
});
