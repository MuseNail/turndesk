// Data-safety guard for the front-desk per-guest customer note (regression fix): an always-present,
// always-empty note box must NOT delete a customer's saved note on flush just because the front desk
// hand-typed a known phone without ever loading/editing the note. _manualNoteShouldSkip decides whether
// to skip persisting (and thus skip the empty→delete) when the box was never loaded from or typed into.
import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { _manualNoteShouldSkip } from '../js/app/features/square-customers.js';

test('empty + never loaded + never touched → SKIP (never delete a note the box never showed)', () => {
  assert.equal(_manualNoteShouldSkip('', false, false), true);
});
test('empty but LOADED (shown then cleared) → do not skip (an intentional clear deletes)', () => {
  assert.equal(_manualNoteShouldSkip('', true, false), false);
});
test('empty but TOUCHED (typed then cleared) → do not skip', () => {
  assert.equal(_manualNoteShouldSkip('', false, true), false);
});
test('non-empty → do not skip (always save real text)', () => {
  assert.equal(_manualNoteShouldSkip('allergy', false, false), false);
});
