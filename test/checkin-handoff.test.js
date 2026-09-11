import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HANDOFF_TTL_MS, handoffNonce, handoffEntryId, handoffWaiverId,
  handoffMasked, handoffFresh, handoffIsTombstone, handoffResult,
  buildHandoff, handoffTombstone, handoffPrimaryName, handoffMultiGuest,
} from '../js/app/features/checkin-handoff.js';
import { buildWaiverRecord } from '../js/app/waiver-util.js';

// The handoff signal (a synced config key `kiosk_handoff`) is one of:
//   pending:   { nonce, targetDevice, byDevice, byUser, ts, primaryIndex, entries:[<finished queue entry>] }
//   tombstone: { done:<nonce>, result:'confirmed'|'cancelled'|'expired'|'takeover', ts }
// Entries are FULL queue entries built at the desk (parity by construction), each with a
// deterministic id so a re-Confirm is idempotent.

const entry = (o) => ({ id: o.id, name: o.name, phone: o.phone || '', services: o.services || [], status: 'waiting' });

// ── deterministic ids ───────────────────────────
test('deterministic ids: nonce → stable entry + waiver ids', () => {
  const n = handoffNonce(1000, 'abc');
  assert.equal(n, 'ho-1000-abc');
  assert.equal(handoffEntryId(n, 0), 'hoff-ho-1000-abc-0');
  assert.equal(handoffEntryId(n, 2), 'hoff-ho-1000-abc-2');
  assert.equal(handoffWaiverId(n), 'wv-ho-1000-abc');
  // same nonce → same ids (idempotent re-Confirm)
  assert.equal(handoffEntryId(n, 0), handoffEntryId(n, 0));
});

// ── handoffMasked ───────────────────────────────
test('handoffMasked: last-4 only, tolerant of formatting / short / blank', () => {
  assert.equal(handoffMasked(entry({ phone: '(909) 555-1234' })), '••••1234');
  assert.equal(handoffMasked(entry({ phone: '5551234' })), '••••1234');
  assert.equal(handoffMasked(entry({ phone: '12' })), '••••12');   // short → mask what exists
  assert.equal(handoffMasked(entry({ phone: '' })), '');
  assert.equal(handoffMasked(null), '');
});

// ── handoffFresh ────────────────────────────────
test('handoffFresh: pending + has entries + within TTL', () => {
  const h = buildHandoff([entry({ id: 'e', name: 'Ann' })], 'devK', 'Sam', 'devD', 'ho-1', 1000);
  assert.equal(handoffFresh(h, 1000 + 1000), true);
  assert.equal(handoffFresh(h, 1000 + HANDOFF_TTL_MS), true);        // boundary inclusive
  assert.equal(handoffFresh(h, 1000 + HANDOFF_TTL_MS + 1), false);   // expired
  assert.equal(handoffFresh(null, 1000), false);
  assert.equal(handoffFresh({ nonce: 'x', ts: 1000, entries: [] }, 1000), false);  // no entries
  assert.equal(handoffFresh(handoffTombstone('ho-1', 'confirmed', 1000), 1000), false); // tombstone is never fresh
});

// ── tombstone helpers ───────────────────────────
test('tombstone: done/result detection', () => {
  const t = handoffTombstone('ho-9', 'confirmed', 1000);
  assert.deepEqual(t, { done: 'ho-9', result: 'confirmed', ts: 1000 });
  assert.equal(handoffIsTombstone(t), true);
  assert.equal(handoffResult(t), 'confirmed');
  const h = buildHandoff([entry({ id: 'e', name: 'Ann' })], 'devK', 'Sam', 'devD', 'ho-1', 1000);
  assert.equal(handoffIsTombstone(h), false);
  assert.equal(handoffResult(h), null);
});

// ── buildHandoff ────────────────────────────────
test('buildHandoff: carries entries, target, sender, nonce, ts, primaryIndex 0', () => {
  const es = [entry({ id: 'hoff-ho-1-0', name: 'Ann Lee' }), entry({ id: 'hoff-ho-1-1', name: 'Bo' })];
  const h = buildHandoff(es, 'devK', 'Sam', 'devD', 'ho-1', 5000);
  assert.equal(h.targetDevice, 'devK');
  assert.equal(h.byUser, 'Sam');
  assert.equal(h.byDevice, 'devD');
  assert.equal(h.nonce, 'ho-1');
  assert.equal(h.ts, 5000);
  assert.equal(h.primaryIndex, 0);
  assert.equal(h.entries.length, 2);
  assert.equal(h.done, undefined);   // pending, not a tombstone
});

// ── handoffPrimaryName + multi-guest ────────────
test('handoffPrimaryName: first + last-initial of the primary entry', () => {
  const h = buildHandoff([entry({ id: 'e', name: 'Ann Lee' }), entry({ id: 'e2', name: 'Bo' })], 'devK', 'Sam', 'devD', 'ho-1', 1000);
  assert.equal(handoffPrimaryName(h), 'Ann L.');
  assert.equal(handoffMultiGuest(h), true);
  const solo = buildHandoff([entry({ id: 'e', name: 'Cher' })], 'devK', 'Sam', 'devD', 'ho-2', 1000);
  assert.equal(handoffPrimaryName(solo), 'Cher');   // no last name → first only
  assert.equal(handoffMultiGuest(solo), false);
});

// ── waiver-util: the new methods must survive (F1) ──
test('buildWaiverRecord: front-desk-bypass + front-desk-takeover are not coerced to self-kiosk', () => {
  const base = { id: 'w', now: 1, primary: { firstName: 'A', lastName: 'B', phone: '5551234' }, guests: [], waiverVersion: '01', source: 'text', text: 't' };
  assert.equal(buildWaiverRecord({ ...base, method: 'front-desk-bypass' }).method, 'front-desk-bypass');
  assert.equal(buildWaiverRecord({ ...base, method: 'front-desk-takeover' }).method, 'front-desk-takeover');
  assert.equal(buildWaiverRecord({ ...base, method: 'front-desk-kiosk' }).method, 'front-desk-kiosk');
  assert.equal(buildWaiverRecord({ ...base, method: 'bogus' }).method, 'self-kiosk');   // unknown still coerced
});
