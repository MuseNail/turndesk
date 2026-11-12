// Pure helpers behind the unified notification bell.
// Adapted from Muse v6.18 for TurnDesk's sources: TD omits `supportNew` (no salon-side operator
// inbox — new-ticket triage is the operator console's job) and `tasks` (TD tasks are Google-Tasks-
// backed, not synced state). TD spec: failedWrites, supportReply, chat, clock, update.
import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNotifItems, clockStateNeedsAttention } from '../js/app/notif-util.js';

// ── buildNotifItems: role-gating + severity order + badge color ──────────────
const FULL = { failedWrites: 1, supportReply: 1, chat: 3, clock: 1, update: 1 };

test('buildNotifItems: admin sees every source, danger-first order, summed total', () => {
  const r = buildNotifItems(FULL, { isAdmin: true, isManager: true });
  assert.deepEqual(r.items.map(i => i.id), ['failedWrites', 'supportReply', 'chat', 'clock', 'update']);
  assert.equal(r.total, 1 + 1 + 3 + 1 + 1);
  assert.equal(r.hasDanger, true);
});

test('buildNotifItems: a plain staffer never sees failed-writes or the clock', () => {
  const r = buildNotifItems(FULL, { isAdmin: false, isManager: false });
  assert.deepEqual(r.items.map(i => i.id), ['supportReply', 'chat', 'update']);
  assert.equal(r.hasDanger, false, 'no danger item for a non-admin/manager');
  assert.equal(r.total, 1 + 3 + 1); // supportReply + chat + update
});

test('buildNotifItems: a manager sees failed-writes but NOT the admin-only clock', () => {
  const r = buildNotifItems(FULL, { isAdmin: false, isManager: true });
  assert.ok(r.items.some(i => i.id === 'failedWrites'));
  assert.ok(!r.items.some(i => i.id === 'clock'), 'clock is admin-only');
  assert.equal(r.hasDanger, true);
});

test('buildNotifItems: zero counts yield an empty, danger-free result', () => {
  const r = buildNotifItems({}, { isAdmin: true, isManager: true });
  assert.deepEqual(r.items, []);
  assert.equal(r.total, 0);
  assert.equal(r.hasDanger, false);
});

test('buildNotifItems: badge is non-danger when only non-failed items are present', () => {
  const r = buildNotifItems({ chat: 2, update: 1 }, { isAdmin: true, isManager: true });
  assert.equal(r.hasDanger, false);
  assert.equal(r.total, 3);
});

// ── clockStateNeedsAttention: only the actionable 'warn' state ───────────────
test('clockStateNeedsAttention: only warn is actionable (notice is a permanent, non-clearable state)', () => {
  assert.equal(clockStateNeedsAttention('warn'), true);
  assert.equal(clockStateNeedsAttention('notice'), false);
  assert.equal(clockStateNeedsAttention('clock'), false);
  assert.equal(clockStateNeedsAttention('hidden'), false);
  assert.equal(clockStateNeedsAttention(undefined), false);
});
