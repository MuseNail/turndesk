// The two pure decisions behind the phone-wake stale-board fix (sync.js):
//   _shouldReconnect — on a wake resync, is the socket dead (incl. a zombie that
//     still reports OPEN after an iOS sleep) and must be force-rebuilt?
//   _shouldResync    — should the visible-only watchdog / touch handler fire a
//     resync right now (visible, signed-in, and genuinely stale)?
// The event wiring (pageshow/resume/touchstart/interval) and the socket teardown
// are verified on-device; these pure functions hold the correctness-critical logic,
// in the repo's _decideCacheLoad / _should* style. STALE_MS is 30_000 in sync.js.
import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { _shouldReconnect, _shouldResync } from '../js/app/sync.js';

const STALE = 30000;
const NOW = 1_000_000;   // fixed, arbitrary — the fns only use (now - lastRecv)

// ── _shouldReconnect(now, lastRecv, isOpen) ──────────────────────────────────

test('_shouldReconnect: no open socket → reconnect', () => {
  assert.equal(_shouldReconnect(NOW, NOW, false), true);
});

test('_shouldReconnect: OPEN and fresh → do not reconnect', () => {
  assert.equal(_shouldReconnect(NOW, NOW - 5000, true), false);
});

test('_shouldReconnect: OPEN but silent past STALE_MS → reconnect (zombie heal)', () => {
  assert.equal(_shouldReconnect(NOW, NOW - (STALE + 1), true), true);
});

test('_shouldReconnect: OPEN, exactly STALE_MS of silence → not yet stale', () => {
  // boundary: strictly greater-than, so exactly STALE_MS still counts as fresh
  assert.equal(_shouldReconnect(NOW, NOW - STALE, true), false);
});

// ── _shouldResync(now, lastRecv, visible, authNeeded) ────────────────────────

test('_shouldResync: hidden page never resyncs (even if stale)', () => {
  assert.equal(_shouldResync(NOW, NOW - (STALE + 1), false, false), false);
});

test('_shouldResync: awaiting sign-in never resyncs (no 401 loop)', () => {
  assert.equal(_shouldResync(NOW, NOW - (STALE + 1), true, true), false);
});

test('_shouldResync: never-connected (lastRecv 0) does not resync', () => {
  // boot hydration is start()'s job, not the watchdog's
  assert.equal(_shouldResync(NOW, 0, true, false), false);
});

test('_shouldResync: visible, signed-in, fresh → no resync', () => {
  assert.equal(_shouldResync(NOW, NOW - 5000, true, false), false);
});

test('_shouldResync: visible, signed-in, stale → resync', () => {
  assert.equal(_shouldResync(NOW, NOW - (STALE + 1), true, false), true);
});

test('_shouldResync: exactly STALE_MS of silence → not yet (boundary)', () => {
  assert.equal(_shouldResync(NOW, NOW - STALE, true, false), false);
});
