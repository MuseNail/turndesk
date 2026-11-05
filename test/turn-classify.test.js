// Turn classification (Item D) — pure classifier + config merge.
// Run: node --test-force-exit --test test/turn-classify.test.js
import './setup-globals.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getState } from '../js/app/store.js';
import { classifyAmount, _mergeTurnConfig, getTurnConfig, isHalfService, turnClassOf, isEstimatedTurn, getTechTurns } from '../js/app/features/turns.js';

// The full default config — MUST stay in lockstep with getTurnConfig()'s defaults.
const DEF = {
  bonusMax: 11, halfMax: 27,
  halfEnabled: true, bonusEnabled: true,
  halfByCost: true, halfByService: false,
  bonusByCost: true, bonusByService: true,
  precedence: 'bonusFirst',
  countOnAssign: true,
};
const f = (isBonusSvc = false, isHalfSvc = false) => ({ isBonusSvc, isHalfSvc });

test('default bands: ≤ bonusMax = bonus, (bonusMax, halfMax] = half, above = full', () => {
  const cases = [[0, 'unpriced'], [1, 'bonus'], [11, 'bonus'], [11.5, 'half'], [12, 'half'], [27, 'half'], [27.5, 'full'], [28, 'full'], [100, 'full']];
  for (const [amt, exp] of cases) assert.equal(classifyAmount(amt, 's', DEF, f()), exp, 'amount ' + amt);
});

test('bonus is INDEPENDENT of half: bonus keeps its own cutoff when half is OFF', () => {
  const cfg = { ...DEF, halfEnabled: false };
  assert.equal(classifyAmount(8, 's', cfg, f()), 'bonus');    // ≤ bonusMax → still bonus
  assert.equal(classifyAmount(20, 's', cfg, f()), 'full');    // above bonus cutoff, half off → full
});

test('half turns OFF: a mid-priced service counts as full (no half band)', () => {
  assert.equal(classifyAmount(15, 's', { ...DEF, halfEnabled: false }, f()), 'full');
});

test('bonus turns OFF (half on): a cheap service falls into the half band (≤ halfMax)', () => {
  assert.equal(classifyAmount(5, 's', { ...DEF, bonusEnabled: false }, f()), 'half');
});

test('both OFF: every priced service is a full turn', () => {
  const cfg = { ...DEF, halfEnabled: false, bonusEnabled: false };
  for (const cost of [5, 15, 50]) assert.equal(classifyAmount(cost, 's', cfg, f()), 'full');
});

test('bonus OFF nullifies the always-bonus list: a tagged service counts by cost', () => {
  const cfg = { ...DEF, bonusEnabled: false };
  assert.equal(classifyAmount(50, 's', cfg, f(true)), 'full');   // was bonus, now full by cost
});

test('half BY SERVICE classifies an unpriced service (service rule bypasses the unpriced gate)', () => {
  const cfg = { ...DEF, halfByService: true };
  assert.equal(classifyAmount(0, 's', cfg, f(false, true)), 'half');
});

test('bonus BY COST off (half on): a cheap priced service is half, not bonus', () => {
  const cfg = { ...DEF, bonusByCost: false };
  assert.equal(classifyAmount(5, 's', cfg, f(false)), 'half');   // no bonus-by-cost band → ≤ halfMax = half
});

test('unpriced with no service rule is unpriced in every precedence mode', () => {
  for (const precedence of ['bonusFirst', 'highestValue', 'costWins']) {
    assert.equal(classifyAmount(0, 's', { ...DEF, precedence }, f()), 'unpriced', precedence);
  }
});

test('precedence: always-bonus service priced at a full amount ($50)', () => {
  assert.equal(classifyAmount(50, 's', { ...DEF, precedence: 'bonusFirst' }, f(true)), 'bonus');
  assert.equal(classifyAmount(50, 's', { ...DEF, precedence: 'highestValue' }, f(true)), 'full');
  assert.equal(classifyAmount(50, 's', { ...DEF, precedence: 'costWins' }, f(true)), 'full');
});

test('precedence: always-bonus service priced in the half band ($15)', () => {
  assert.equal(classifyAmount(15, 's', { ...DEF, precedence: 'bonusFirst' }, f(true)), 'bonus');
  assert.equal(classifyAmount(15, 's', { ...DEF, precedence: 'highestValue' }, f(true)), 'half');
  assert.equal(classifyAmount(15, 's', { ...DEF, precedence: 'costWins' }, f(true)), 'half');
});

test('precedence: half-by-service, unpriced — half in every mode', () => {
  const base = { ...DEF, halfByService: true };
  for (const precedence of ['bonusFirst', 'highestValue', 'costWins']) {
    assert.equal(classifyAmount(0, 's', { ...base, precedence }, f(false, true)), 'half', precedence);
  }
});

test('costWins respects the By-cost method flag (half-by-cost OFF -> a $15 is not half)', () => {
  // half only by service, but this service is NOT a half service -> $15 should not become half via cost
  const cfg = { ...DEF, precedence: 'costWins', halfByCost: false, halfByService: true };
  assert.equal(classifyAmount(15, 's', cfg, f(false, false)), 'full');
});

test('getTurnConfig returns the full defaults on a fresh (empty) turn_config', () => {
  getState().config.turn_config = {};
  assert.deepEqual(getTurnConfig(), DEF);
});

test('getTurnConfig merges stored values over defaults without dropping keys', () => {
  getState().config.turn_config = { halfEnabled: false, bonusMax: 9 };
  const c = getTurnConfig();
  assert.equal(c.halfEnabled, false);
  assert.equal(c.bonusMax, 9);
  assert.equal(c.halfMax, 27);              // default kept
  assert.equal(c.precedence, 'bonusFirst'); // default kept
  getState().config.turn_config = {};       // reset
});

test('getTurnConfig migrates an old {fullMin, halfMin} install to the new cutoffs', () => {
  getState().config.turn_config = { fullMin: 28, halfMin: 12 };
  const c = getTurnConfig();
  assert.equal(c.bonusMax, 11);   // halfMin - 1
  assert.equal(c.halfMax, 27);    // fullMin - 1
  getState().config.turn_config = {};
});

test('_mergeTurnConfig never drops existing keys', () => {
  assert.deepEqual(
    _mergeTurnConfig({ fullMin: 30, bonusEnabled: false }, { fullMin: 25 }),
    { fullMin: 25, bonusEnabled: false }
  );
});

// ── Item A: turnClassOf (status-aware; expected price = baseCost; NO provisional-full) ──
test('turnClassOf: a priced service classifies by its actual cost', () => {
  getState().config.services = [{ id: 's1', baseCost: 30 }];
  getState().config.turn_config = {};
  assert.equal(turnClassOf({ serviceId: 's1', cost: 40, status: 'paid' }), 'full');
  assert.equal(turnClassOf({ serviceId: 's1', cost: 15, status: 'complete' }), 'half');
});

test('turnClassOf: complete + unpriced counts via the expected price (baseCost)', () => {
  getState().config.services = [{ id: 's1', baseCost: 30 }];
  getState().config.turn_config = {};
  assert.equal(turnClassOf({ serviceId: 's1', cost: 0, status: 'complete' }), 'full'); // 30 >= 28
});

test('turnClassOf: countOnAssign OFF — in-service + unpriced is NOT counted (base price ignored until Done)', () => {
  getState().config.services = [{ id: 's1', baseCost: 30 }];
  getState().config.turn_config = { countOnAssign: false };
  assert.equal(turnClassOf({ serviceId: 's1', cost: 0, status: 'inservice' }), 'unpriced');
});
test('turnClassOf: countOnAssign ON (default) — waiting/in-service + unpriced counts via the base price', () => {
  getState().config.services = [{ id: 's1', baseCost: 30 }];
  getState().config.turn_config = {};   // default countOnAssign = true
  assert.equal(turnClassOf({ serviceId: 's1', cost: 0, status: 'inservice' }), 'full'); // 30 >= 28
  assert.equal(turnClassOf({ serviceId: 's1', cost: 0, status: 'waiting' }), 'full');
});

test('turnClassOf: complete + NO expected price stays unpriced (exactly as today)', () => {
  getState().config.services = [{ id: 's2' }];
  getState().config.turn_config = {};
  assert.equal(turnClassOf({ serviceId: 's2', cost: 0, status: 'complete' }), 'unpriced');
});

test('turnClassOf: a comp keeps its real cost and counts by it (not lineCharge)', () => {
  getState().config.services = [{ id: 's1', baseCost: 5 }];
  getState().config.turn_config = {};
  assert.equal(turnClassOf({ serviceId: 's1', cost: 30, comped: true, status: 'complete' }), 'full');
  getState().config.services = [];   // reset
});

// ── isEstimatedTurn: the grey "~" provisional cue — only on number-bearing full/half from expected price ──
test('isEstimatedTurn: true for a counted complete+unpriced full/half number', () => {
  assert.equal(isEstimatedTurn({ cost: 0, status: 'complete' }, 'full'), true);
  assert.equal(isEstimatedTurn({ cost: 0, status: 'complete' }, 'half'), true);
});
test('isEstimatedTurn: false for bonus (shows "Bonus", not an estimate) and unpriced', () => {
  assert.equal(isEstimatedTurn({ cost: 0, status: 'complete' }, 'bonus'), false);
  assert.equal(isEstimatedTurn({ cost: 0, status: 'complete' }, 'unpriced'), false);
});
test('isEstimatedTurn: priced is never estimated; countOnAssign gates the unpriced non-complete case', () => {
  getState().config.turn_config = {};   // default on
  assert.equal(isEstimatedTurn({ cost: 30, status: 'complete' }, 'full'), false);
  assert.equal(isEstimatedTurn({ cost: 0, status: 'inservice' }, 'full'), true);   // counted early on assignment → provisional "~"
  getState().config.turn_config = { countOnAssign: false };
  assert.equal(isEstimatedTurn({ cost: 0, status: 'inservice' }, 'full'), false);  // not counted → no estimate
  getState().config.turn_config = {};
});

// ── getTechTurns integration: proves Item A counting + Item D priced-path parity over a real queue ──
test('getTechTurns tallies priced, expected-price (done-unpriced), comped and always-bonus correctly', () => {
  const now = new Date().toISOString(), ms = Date.now();
  getState().config.turn_config = {};
  getState().config.turns_skips = [];
  getState().config.bonus_services = ['svAB'];
  getState().config.half_services = [];
  getState().config.services = [
    { id: 'sv1', label: 'Gel', baseCost: 30 },   // expected $30 -> full
    { id: 'svNo', label: 'Misc' },               // no baseCost -> no early count
    { id: 'svAB', label: 'Wax' },                // always-bonus
  ];
  const E = (id, a) => ({ id, name: id, checkinTime: now, status: a.status, assignments: [{ techId: 't1', assignedAt: ms, ...a }] });
  getState().queue = [
    E('e1', { serviceId: 'sv1', cost: 40, status: 'paid' }),                 // priced full
    E('e2', { serviceId: 'sv1', cost: 0, status: 'complete' }),             // done-unpriced -> expected $30 -> full (Item A)
    E('e3', { serviceId: 'svNo', cost: 0, status: 'complete' }),           // done-unpriced, no baseCost -> NOT counted
    E('e4', { serviceId: 'sv1', cost: 40, comped: true, status: 'complete' }), // comp keeps real cost -> full
    E('e5', { serviceId: 'svAB', cost: 0, status: 'inservice' }),          // always-bonus unpriced -> bonus
  ];
  const t = getTechTurns('t1');
  assert.deepEqual(t, { full: 3, half: 0, bonus: 1, total: 3, unknown: 1 });   // e3 (no base price) is unknown "?"
  getState().queue = [];
  getState().config.services = [];
  getState().config.bonus_services = [];
});

test('getTechTurns: countOnAssign ON counts a waiting priced-by-base service; a no-base-price one stays unknown ("?")', () => {
  const now = new Date().toISOString(), ms = Date.now();
  getState().config.turns_skips = []; getState().config.bonus_services = []; getState().config.half_services = [];
  getState().config.services = [{ id: 'g', baseCost: 30 }, { id: 'n' }];   // g has a base price, n has none
  const E = (id, a) => ({ id, name: id, checkinTime: now, status: a.status, assignments: [{ techId: 't2', assignedAt: ms, ...a }] });
  getState().queue = [
    E('w1', { serviceId: 'g', cost: 0, status: 'waiting' }),   // base $30 → counts when ON
    E('w2', { serviceId: 'n', cost: 0, status: 'waiting' }),   // no base price → unknown "?"
  ];
  getState().config.turn_config = {};                          // ON (default)
  const on = getTechTurns('t2');
  assert.equal(on.total, 1); assert.equal(on.unknown, 1);
  getState().config.turn_config = { countOnAssign: false };    // OFF → waiting cost-based not counted
  const off = getTechTurns('t2');
  assert.equal(off.total, 0); assert.equal(off.unknown, 2);
  getState().queue = []; getState().config.services = []; getState().config.turn_config = {};
});

test('isHalfService is guarded: no throw when half_services is undefined', () => {
  getState().config.half_services = undefined;
  assert.equal(isHalfService('x'), false);
  getState().config.half_services = ['a'];
  assert.equal(isHalfService('a'), true);
  assert.equal(isHalfService('b'), false);
  getState().config.half_services = [];     // reset
});
