// v6.08 — iPad merges the per-service bonus counters into the main turn box, showing ONE.
// turnsDedDisplayPlan is the pure branch decision (merge inline vs separate desktop column);
// the HTML wiring in renderTurnsTechGrid is verified on-device. generalBonusCount is included
// to lock the fold-in math: on tablet only the shown service is subtracted from +Nb, so the
// others don't vanish. Import the globals shim FIRST (turns.js touches document/window at import).
import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { turnsDedDisplayPlan, generalBonusCount } from '../js/app/features/turns.js';

// ── turnsDedDisplayPlan(onTablet, showDedicated, techDedLen) ──────────────────

test('desktop + dedicated services → separate column, no merge (unchanged)', () => {
  assert.deepEqual(turnsDedDisplayPlan(false, true, 3), { merge: false, showColumn: true });
});

test('tablet + dedicated services the tech does → merge inline, no column', () => {
  assert.deepEqual(turnsDedDisplayPlan(true, true, 3), { merge: true, showColumn: false });
});

test('tablet + tech does NONE of the dedicated services → neither (no undefined line)', () => {
  assert.deepEqual(turnsDedDisplayPlan(true, true, 0), { merge: false, showColumn: false });
});

test('desktop + tech does none → column still renders (empty map), no merge', () => {
  assert.deepEqual(turnsDedDisplayPlan(false, true, 0), { merge: false, showColumn: true });
});

test('dedicated feature OFF → neither, on either viewport', () => {
  assert.deepEqual(turnsDedDisplayPlan(true, false, 3), { merge: false, showColumn: false });
  assert.deepEqual(turnsDedDisplayPlan(false, false, 3), { merge: false, showColumn: false });
});

// ── generalBonus fold-in (the correctness blocker from plan review) ───────────
// Tech has 3 bonus turns, all on the 2nd dedicated service: dedicated {svcB:3}, bonus 3.

test('desktop subtracts ALL dedicated → +Nb is 0 (each count shown in its own column cell)', () => {
  const turns = { bonus: 3, dedicated: { svcB: 3 } };
  const allDed = [{ id: 'svcA' }, { id: 'svcB' }, { id: 'svcC' }];
  assert.equal(generalBonusCount(turns, allDed), 0);
});

test('tablet subtracts only the SHOWN service → the other 3 bonuses fold into +Nb (not lost)', () => {
  const turns = { bonus: 3, dedicated: { svcB: 3 } };
  const shownOnly = [{ id: 'svcA' }];   // techDed.slice(0,1) — svcB/svcC fold into +Nb
  assert.equal(generalBonusCount(turns, shownOnly), 3);
});
