// Phase 2 Part 1 — server-side RBAC on the config.set write path (F1 escalation root).
// applyMutation(msg, fromWs, actor): when RBAC is armed (AUTH_ENFORCED='true' AND
// RBAC_ENFORCED='true'), sensitive config keys require a sufficient role; a low-priv
// (tech) or unauthenticated (null) actor is refused with {error:'forbidden'} and nothing
// is persisted/broadcast. Operational/dynamic keys stay open to any session. An INTERNAL
// actor (operator/provision) and RBAC-off both bypass the gate (back-compat).
//
// The fd_users gate is VALUE-AWARE: it blocks a privileged change (add/remove a user, or
// change a PRESENT pin/role/hourlyRate) for a non-admin, but ALLOWS a cosmetic self-edit
// (theme/photo/name) — so a front-desk user changing their own theme (which rewrites the
// whole fd_users array, appearance.js:persistTheme) is never falsely denied.
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
const front = { kind: 'fd', id: 'fd-1', role: 'frontdesk' };
const mgr   = { kind: 'fd', id: 'fd-2', role: 'manager' };
const admin = { kind: 'fd', id: 'fd-3', role: 'admin' };
const INTERNAL = { internal: true };
const seedFd = (d, users) => d.state.storage.put('config:fd_users', users);
const baseFd = [{ id: 'fd-1', name: 'Sue', pin: '1111', role: 'frontdesk', theme: 'a' }];

// ── fd_users escalation (the F1 PoC) ────────────────────────────────────────
test('armed: a tech adding an admin fd_user is FORBIDDEN and not persisted', async () => {
  const d = makeDO(); await seedFd(d, baseFd);
  const next = [...baseFd, { id: 'fd-x', name: 'Hacker', pin: '9999', role: 'admin' }];
  const res = await apply(d, 'config.set', { key: 'fd_users', value: next, updatedAt: 123 }, tech);
  assert.equal(res.error, 'forbidden');
  assert.equal((await d.state.storage.get('config:fd_users')).length, 1, 'the write must not persist');
});

test('armed: an admin adding an admin fd_user is APPLIED', async () => {
  const d = makeDO(); await seedFd(d, baseFd);
  const next = [...baseFd, { id: 'fd-x', name: 'Boss', pin: '9999', role: 'admin' }];
  const res = await apply(d, 'config.set', { key: 'fd_users', value: next, updatedAt: 123 }, admin);
  assert.notEqual(res.error, 'forbidden');
  assert.equal((await d.state.storage.get('config:fd_users')).length, 2);
});

test('armed: a manager adding an admin fd_user is FORBIDDEN (fd_users is admin-only)', async () => {
  const d = makeDO(); await seedFd(d, baseFd);
  const next = [...baseFd, { id: 'fd-x', name: 'Boss', pin: '9999', role: 'admin' }];
  const res = await apply(d, 'config.set', { key: 'fd_users', value: next, updatedAt: 123 }, mgr);
  assert.equal(res.error, 'forbidden');
});

test('armed: a tech changing a PIN on an existing fd_user is FORBIDDEN', async () => {
  const d = makeDO(); await seedFd(d, baseFd);
  const next = [{ ...baseFd[0], pin: '0000' }];
  const res = await apply(d, 'config.set', { key: 'fd_users', value: next, updatedAt: 123 }, tech);
  assert.equal(res.error, 'forbidden');
});

test('armed: a tech changing a ROLE on an existing fd_user is FORBIDDEN (self-promote guard)', async () => {
  const d = makeDO(); await seedFd(d, baseFd);
  const next = [{ ...baseFd[0], role: 'admin' }];
  const res = await apply(d, 'config.set', { key: 'fd_users', value: next, updatedAt: 123 }, tech);
  assert.equal(res.error, 'forbidden');
});

// ── fd_users cosmetic self-edit (must NOT be denied) ────────────────────────
test('armed: a front-desk user changing only a THEME on fd_users is APPLIED (persistTheme path)', async () => {
  const d = makeDO(); await seedFd(d, baseFd);
  const next = [{ ...baseFd[0], theme: 'b' }];   // same pin/role/membership, only theme differs
  const res = await apply(d, 'config.set', { key: 'fd_users', value: next, updatedAt: 123 }, front);
  assert.notEqual(res.error, 'forbidden');
  assert.equal((await d.state.storage.get('config:fd_users'))[0].theme, 'b');
});

test('armed: a value-aware fd_users write with an ABSENT pin is treated as unchanged (not a pin change)', async () => {
  const d = makeDO(); await seedFd(d, baseFd);
  const next = [{ id: 'fd-1', name: 'Sue', role: 'frontdesk', theme: 'b' }];   // pin omitted entirely
  const res = await apply(d, 'config.set', { key: 'fd_users', value: next, updatedAt: 123 }, front);
  assert.notEqual(res.error, 'forbidden', 'an omitted pin is not a privileged change');
});

// ── other sensitive keys ────────────────────────────────────────────────────
test('armed: a tech flipping payment_processor is FORBIDDEN', async () => {
  const d = makeDO();
  const res = await apply(d, 'config.set', { key: 'payment_processor', value: 'helcim', updatedAt: 1 }, tech);
  assert.equal(res.error, 'forbidden');
});

test('armed: a manager CAN flip payment_processor (matches the client admin+manager affordance, no silent fail)', async () => {
  const res = await apply(makeDO(), 'config.set', { key: 'payment_processor', value: 'helcim', updatedAt: 1 }, mgr);
  assert.notEqual(res.error, 'forbidden');
});

test('armed: a tech editing payroll_adj is FORBIDDEN (H6)', async () => {
  const d = makeDO();
  const res = await apply(d, 'config.set', { key: 'payroll_adj', value: { t1: 9999 }, updatedAt: 1 }, tech);
  assert.equal(res.error, 'forbidden');
});

test('armed: a tech repointing bo_sync is FORBIDDEN (H6 exfil)', async () => {
  const d = makeDO();
  const res = await apply(d, 'config.set', { key: 'bo_sync', value: { url: 'https://evil.test', businessId: 'x' }, updatedAt: 1 }, tech);
  assert.equal(res.error, 'forbidden');
});

test('armed: a manager editing services is APPLIED (manageServices)', async () => {
  const d = makeDO();
  const res = await apply(d, 'config.set', { key: 'services', value: [{ id: 's1', name: 'Mani' }], updatedAt: 1 }, mgr);
  assert.notEqual(res.error, 'forbidden');
});

test('armed: a tech editing services is FORBIDDEN', async () => {
  const d = makeDO();
  const res = await apply(d, 'config.set', { key: 'services', value: [], updatedAt: 1 }, tech);
  assert.equal(res.error, 'forbidden');
});

// ── operational / dynamic keys stay OPEN to any session (incl. tech) ─────────
test('armed: a tech writing customer_notes is APPLIED (operational, staff-app path)', async () => {
  const d = makeDO();
  const res = await apply(d, 'config.set', { key: 'customer_notes', value: { p1: 'note' }, updatedAt: 1 }, tech);
  assert.notEqual(res.error, 'forbidden');
});

test('armed: a dynamic fd_clock_<id> punch key is APPLIED (not gated)', async () => {
  const d = makeDO();
  const res = await apply(d, 'config.set', { key: 'fd_clock_fd-1', value: [{ in: 1 }], updatedAt: 1 }, front);
  assert.notEqual(res.error, 'forbidden');
});

// ── unauthenticated (null actor) is refused for sensitive keys when armed ────
test('armed: a null (unauthenticated) actor is FORBIDDEN on a sensitive key', async () => {
  const d = makeDO(); await seedFd(d, baseFd);
  const res = await apply(d, 'config.set', { key: 'payment_processor', value: 'helcim', updatedAt: 1 }, null);
  assert.equal(res.error, 'forbidden');
});

// ── bypasses: INTERNAL + RBAC-off ───────────────────────────────────────────
test('INTERNAL actor bypasses the gate (operator/provision managerpin path)', async () => {
  const d = makeDO(); await seedFd(d, baseFd);
  const next = [...baseFd, { id: 'fd-manager', name: 'Manager', pin: '4321', role: 'admin' }];
  const res = await apply(d, 'config.set', { key: 'fd_users', value: next, updatedAt: 123 }, INTERNAL);
  assert.notEqual(res.error, 'forbidden');
  assert.equal((await d.state.storage.get('config:fd_users')).length, 2);
});

test('RBAC-off (no RBAC_ENFORCED): a tech add-admin APPLIES (back-compat)', async () => {
  const d = makeDO({ AUTH_ENFORCED: 'true' });   // RBAC_ENFORCED unset → disarmed
  await seedFd(d, baseFd);
  const next = [...baseFd, { id: 'fd-x', name: 'X', pin: '9999', role: 'admin' }];
  const res = await apply(d, 'config.set', { key: 'fd_users', value: next, updatedAt: 123 }, tech);
  assert.notEqual(res.error, 'forbidden');
  assert.equal((await d.state.storage.get('config:fd_users')).length, 2);
});

test('AUTH_ENFORCED off entirely: gate is inert (existing tests construct env {})', async () => {
  const d = makeDO({});
  const next = [{ id: 'fd-x', pin: '9999', role: 'admin' }];
  const res = await apply(d, 'config.set', { key: 'fd_users', value: next, updatedAt: 123 }, tech);
  assert.notEqual(res.error, 'forbidden');
});

// ── capability-mapped keys HONOR the owner's role_permissions (not a hardcoded floor) ──
// services/items/fees → manageServices; staff → manageStaff; so an owner who grants a lower
// role that capability isn't silently 403'd once RBAC arms.
test('armed: a frontdesk editing services is FORBIDDEN by DEFAULT (no manageServices)', async () => {
  const res = await apply(makeDO(), 'config.set', { key: 'services', value: [], updatedAt: 1 }, front);
  assert.equal(res.error, 'forbidden');
});

test('armed: a frontdesk GRANTED manageServices CAN edit services (owner role_permissions honored)', async () => {
  const d = makeDO();
  await d.state.storage.put('config:role_permissions', { frontdesk: { manageServices: true } });
  const res = await apply(d, 'config.set', { key: 'services', value: [{ id: 's1' }], updatedAt: 1 }, front);
  assert.notEqual(res.error, 'forbidden', 'the owner-granted capability must not be silently capped');
  assert.equal((await d.state.storage.get('config:services')).length, 1);
});

test('armed: a frontdesk GRANTED manageStaff CAN edit staff', async () => {
  const d = makeDO();
  await d.state.storage.put('config:role_permissions', { frontdesk: { manageStaff: true } });
  const res = await apply(d, 'config.set', { key: 'staff', value: [{ id: 't1' }], updatedAt: 1 }, front);
  assert.notEqual(res.error, 'forbidden');
});

test('armed: a frontdesk editing staff is FORBIDDEN by default (no manageStaff)', async () => {
  assert.equal((await apply(makeDO(), 'config.set', { key: 'staff', value: [], updatedAt: 1 }, front)).error, 'forbidden');
});

// ── frontdesk+ tier: money/fairness-adjacent operational keys deny TECH ──────
test('armed: a tech writing cash_drawer is FORBIDDEN', async () => {
  assert.equal((await apply(makeDO(), 'config.set', { key: 'cash_drawer', value: { open: true }, updatedAt: 1 }, tech)).error, 'forbidden');
});
test('armed: a frontdesk writing cash_drawer is APPLIED (opens the register)', async () => {
  const d = makeDO();
  const res = await apply(d, 'config.set', { key: 'cash_drawer', value: { open: true }, updatedAt: 1 }, front);
  assert.notEqual(res.error, 'forbidden');
  assert.deepEqual(await d.state.storage.get('config:cash_drawer'), { open: true }, 'the write actually persisted');
});
test('armed: a tech writing turns_order is FORBIDDEN (rotation-fairness tamper)', async () => {
  assert.equal((await apply(makeDO(), 'config.set', { key: 'turns_order', value: ['t9'], updatedAt: 1 }, tech)).error, 'forbidden');
});
test('armed: a frontdesk writing turns_order is APPLIED (manages rotation)', async () => {
  assert.notEqual((await apply(makeDO(), 'config.set', { key: 'turns_order', value: ['t1'], updatedAt: 1 }, front)).error, 'forbidden');
});
test('armed: a tech writing bonus_services is FORBIDDEN', async () => {
  assert.equal((await apply(makeDO(), 'config.set', { key: 'bonus_services', value: ['s1'], updatedAt: 1 }, tech)).error, 'forbidden');
});

// ── owner-kind actor flows through the gate as admin ────────────────────────
test('armed: an owner-kind actor (role admin) passes a sensitive key', async () => {
  const owner = { kind: 'owner', id: 'o@x.com', name: 'Owner', role: 'admin' };
  const res = await apply(makeDO(), 'config.set', { key: 'payment_processor', value: 'helcim', updatedAt: 1 }, owner);
  assert.notEqual(res.error, 'forbidden');
});
