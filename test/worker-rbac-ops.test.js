// Phase 2 Part 1 — RBAC on the money / directory / calendar / queue ops (F7 + destruction
// hardening the review surfaced). When armed: record/gift-card/customer/appointment/queue
// WRITES require an authenticated non-tech session (frontdesk+), record.delete requires
// manager+, and the tech staff-app's own ops (assignmentPatch / entryPatch / chat / audit)
// stay OPEN so the busy floor never breaks. INTERNAL + RBAC-off bypass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnDeskDO } from '../cloudflare/worker.js';

function makeStorage() {
  const m = new Map();
  return {
    _m: m,
    async get(k) { return m.has(k) ? m.get(k) : undefined; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { if (Array.isArray(k)) k.forEach(x => m.delete(x)); else m.delete(k); },
    async deleteAll() { m.clear(); },
    async list({ prefix } = {}) { const r = new Map(); for (const [k, v] of m) if (!prefix || k.startsWith(prefix)) r.set(k, v); return r; },
    async getAlarm() { return null; }, async setAlarm() {},
  };
}
const ARMED = { AUTH_ENFORCED: 'true', RBAC_ENFORCED: 'true' };
const makeDO = (env = ARMED) => new TurnDeskDO({ storage: makeStorage() }, env);
const apply = (d, op, payload, actor) => d.applyMutation({ op, payload }, null, actor);
const tech  = { kind: 'tech', id: 't1', role: 'tech' };
const rev   = { kind: 'fd', id: 'fd-r', role: 'reviewer' };
const front = { kind: 'fd', id: 'fd-1', role: 'frontdesk' };
const mgr   = { kind: 'fd', id: 'fd-2', role: 'manager' };
const admin = { kind: 'fd', id: 'fd-3', role: 'admin' };
const INTERNAL = { internal: true };
const forbidden = (res) => assert.equal(res.error, 'forbidden');
const allowed   = (res) => assert.notEqual(res.error, 'forbidden');

// ── record.delete → manager+ (deleteTransaction) ────────────────────────────
test('armed: tech record.delete FORBIDDEN', async () => forbidden(await apply(makeDO(), 'record.delete', { id: 'r1' }, tech)));
test('armed: frontdesk record.delete FORBIDDEN (deleteTransaction is manager+)', async () => forbidden(await apply(makeDO(), 'record.delete', { id: 'r1' }, front)));
test('armed: manager record.delete APPLIED', async () => allowed(await apply(makeDO(), 'record.delete', { id: 'r1' }, mgr)));
test('armed: admin record.delete APPLIED', async () => allowed(await apply(makeDO(), 'record.delete', { id: 'r1' }, admin)));

// ── record.save / gift cards → frontdesk+ (register), deny tech ──────────────
test('armed: tech record.save FORBIDDEN (forge a commission ticket)', async () => forbidden(await apply(makeDO(), 'record.save', { record: { id: 'r1', updatedAt: 1 } }, tech)));
test('armed: frontdesk record.save APPLIED (checkout)', async () => allowed(await apply(makeDO(), 'record.save', { record: { id: 'r1', updatedAt: 1 } }, front)));
test('armed: reviewer record.save APPLIED (report grouping, reports.js:2399)', async () => allowed(await apply(makeDO(), 'record.save', { record: { id: 'r1', updatedAt: 1 } }, rev)));
test('armed: tech giftcard.save FORBIDDEN ($100k inflation, the F7 PoC)', async () => forbidden(await apply(makeDO(), 'giftcard.save', { card: { id: 'g1', amount: 100000, updatedAt: 1 } }, tech)));
test('armed: frontdesk giftcard.save APPLIED (sell/redeem)', async () => allowed(await apply(makeDO(), 'giftcard.save', { card: { id: 'g1', amount: 50, updatedAt: 1 } }, front)));
test('armed: tech giftcard.delete FORBIDDEN', async () => forbidden(await apply(makeDO(), 'giftcard.delete', { id: 'g1' }, tech)));

// ── customer / appt destruction → frontdesk+, deny tech (H7) ─────────────────
test('armed: tech customer.upsert FORBIDDEN', async () => forbidden(await apply(makeDO(), 'customer.upsert', { customer: { id: 'c1', updatedAt: 1 } }, tech)));
test('armed: tech customer.bulkDelete FORBIDDEN (wipe the directory)', async () => forbidden(await apply(makeDO(), 'customer.bulkDelete', { ids: ['c1', 'c2'] }, tech)));
test('armed: frontdesk customer.upsert APPLIED', async () => allowed(await apply(makeDO(), 'customer.upsert', { customer: { id: 'c1', updatedAt: 1 } }, front)));
test('armed: tech appt.delete FORBIDDEN (wipe the calendar)', async () => forbidden(await apply(makeDO(), 'appt.delete', { id: 'a1' }, tech)));
test('armed: frontdesk appt.upsert APPLIED', async () => allowed(await apply(makeDO(), 'appt.upsert', { appt: { id: 'a1', updatedAt: 1 } }, front)));

// ── queue whole-entry writes → frontdesk+, deny tech ────────────────────────
test('armed: tech queue.upsert FORBIDDEN (front-desk op)', async () => forbidden(await apply(makeDO(), 'queue.upsert', { entry: { id: 'e1', assignments: [] } }, tech)));
test('armed: frontdesk queue.upsert APPLIED (check-in)', async () => allowed(await apply(makeDO(), 'queue.upsert', { entry: { id: 'e1', assignments: [] } }, front)));
test('armed: tech queue.remove FORBIDDEN', async () => forbidden(await apply(makeDO(), 'queue.remove', { id: 'e1' }, tech)));

// ── the tech staff-app's OWN ops must stay OPEN (busy-floor path) ────────────
test('armed: tech queue.assignmentPatch APPLIED (Start/Complete on the staff app)', async () => {
  const d = makeDO();
  await d.state.storage.put('queue:e1', { id: 'e1', status: 'inservice', assignments: [{ serviceId: 's1', techId: 't1', status: 'inservice' }] });
  allowed(await apply(d, 'queue.assignmentPatch', { entryId: 'e1', serviceId: 's1', techId: 't1', assignment: { serviceId: 's1', techId: 't1', status: 'complete', updatedAt: 2, updatedBy: 'x' } }, tech));
});
test('armed: tech queue.entryPatch APPLIED (visit note)', async () => {
  const d = makeDO();
  await d.state.storage.put('queue:e1', { id: 'e1', status: 'waiting', assignments: [] });
  allowed(await apply(d, 'queue.entryPatch', { entryId: 'e1', patch: { txnNote: 'n' } }, tech));
});
test('armed: tech chat.append APPLIED', async () => allowed(await apply(makeDO(), 'chat.append', { message: { id: 'm1', text: 'hi' } }, tech)));
test('armed: tech audit.log APPLIED', async () => allowed(await apply(makeDO(), 'audit.log', { event: { id: 'ev1', action: 'Login' } }, tech)));

// ── bypasses ────────────────────────────────────────────────────────────────
test('INTERNAL bypasses a money-op gate', async () => allowed(await apply(makeDO(), 'record.delete', { id: 'r1' }, INTERNAL)));
test('RBAC-off: tech record.delete APPLIED (back-compat)', async () => allowed(await apply(makeDO({ AUTH_ENFORCED: 'true' }), 'record.delete', { id: 'r1' }, tech)));
