import test from 'node:test';
import assert from 'node:assert/strict';
import { syncBannerModel } from '../js/app/features/sync-banner.js';

const m = (o, surface) => syncBannerModel(o, surface);

test('hidden when connected, nothing pending or failed', () => {
  const r = m({ connected: true, pendingCount: 0, failedCount: 0, authNeeded: false });
  assert.equal(r.kind, 'hidden');
  assert.equal(r.pulse, false);
});

test('offline with pending: counts, pulse, retry, and the "do not re-enter" warning', () => {
  const r = m({ connected: false, pendingCount: 3 });
  assert.equal(r.kind, 'offline');
  assert.equal(r.pulse, true);
  assert.equal(r.action, 'retry');
  assert.match(r.title, /3 changes/);
  assert.match(r.sub, /re-enter/i);
});

test('offline with ZERO pending: distinct copy, no "0 changes", still pulses', () => {
  const r = m({ connected: false, pendingCount: 0 });
  assert.equal(r.kind, 'offline');
  assert.equal(r.pulse, true);
  assert.doesNotMatch(r.title + r.sub, /0 change/);
  assert.match(r.sub, /safe/i);
});

test('singular "1 change" wording', () => {
  assert.match(m({ connected: false, pendingCount: 1 }).title, /\b1 change\b/);
});

test('connected with pending → syncing (blue, no pulse)', () => {
  const r = m({ connected: true, pendingCount: 2 });
  assert.equal(r.kind, 'syncing');
  assert.equal(r.pulse, false);
  assert.match(r.title, /2 changes/);
});

test('failed — desk points to Data Recovery; tech is informational (no recovery action)', () => {
  const desk = m({ connected: true, failedCount: 1 }, 'desk');
  assert.equal(desk.kind, 'failed');
  assert.equal(desk.action, 'recovery');
  assert.match(desk.sub, /recovery/i);
  assert.equal(desk.pulse, true);   // a failed write must be at least as loud as offline
  const tech = m({ connected: true, failedCount: 1 }, 'tech');
  assert.equal(tech.kind, 'failed');
  assert.equal(tech.action, '');
  assert.match(tech.sub, /front desk/i);
});

test('authNeeded beats failed beats offline; action differs by surface', () => {
  const r = m({ connected: false, pendingCount: 5, failedCount: 2, authNeeded: true }, 'desk');
  assert.equal(r.kind, 'authNeeded');
  assert.equal(r.action, 'pin');
  assert.equal(m({ authNeeded: true }, 'tech').action, 'signin');
  // failed beats offline when not authNeeded
  assert.equal(m({ connected: false, pendingCount: 5, failedCount: 2 }).kind, 'failed');
});
