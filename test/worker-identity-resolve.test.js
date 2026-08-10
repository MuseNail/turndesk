// Phase 2 Part 1 — _resolveIdentity(token): the single source of truth for "who is this
// session, right now." Unlike the frozen sess.role, it RE-DERIVES the effective role from
// current config on every call — so a demotion or a removal takes effect on the next op
// (fixes the review's stale-role finding), not only on re-login. Also enforces the F35
// appadmin pinEpoch. Returns {kind,id,name,role} or null (invalid/expired/revoked).
import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnDeskDO } from '../cloudflare/worker.js';

function makeStorage() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? m.get(k) : undefined; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list({ prefix } = {}) { const r = new Map(); for (const [k, v] of m) if (!prefix || k.startsWith(prefix)) r.set(k, v); return r; },
    async getAlarm() { return null; }, async setAlarm() {},
  };
}
const makeDO = (env = {}) => new TurnDeskDO({ storage: makeStorage() }, env);
const future = Date.now() + 3600e3;
const put = (d, k, v) => d.state.storage.put(k, v);

test('fd session resolves to its CURRENT config role, not the frozen session role (demotion applies)', async () => {
  const d = makeDO();
  await put(d, 'config:fd_users', [{ id: 'fd-1', name: 'Sue', pin: '1', role: 'frontdesk' }]);   // demoted since login
  await put(d, 'sess:tok', { kind: 'fd', id: 'fd-1', name: 'Sue', role: 'admin', expires: future });
  const u = await d._resolveIdentity('tok');
  assert.equal(u.role, 'frontdesk', 're-derived from current config, not sess.role=admin');
});

test('fd session whose user was removed from config resolves to null (revocation)', async () => {
  const d = makeDO();
  await put(d, 'config:fd_users', [{ id: 'fd-2', role: 'admin' }]);
  await put(d, 'sess:tok', { kind: 'fd', id: 'fd-1', role: 'admin', expires: future });
  assert.equal(await d._resolveIdentity('tok'), null);
});

test('tech session resolves to role tech when active, null when inactive/removed', async () => {
  const d = makeDO();
  await put(d, 'config:staff', [{ id: 't1', name: 'Ann' }]);
  await put(d, 'sess:tok', { kind: 'tech', id: 't1', name: 'Ann', role: 'tech', expires: future });
  assert.equal((await d._resolveIdentity('tok')).role, 'tech');
  await put(d, 'config:inactive_staff', ['t1']);
  assert.equal(await d._resolveIdentity('tok'), null, 'deactivated tech is revoked');
});

test('owner session re-derives role from the owner record (owner→admin, manager→manager)', async () => {
  const d = makeDO();
  await put(d, 'owner:a@b.com', { email: 'a@b.com', role: 'owner' });
  await put(d, 'sess:tok', { kind: 'owner', id: 'a@b.com', email: 'a@b.com', role: 'admin', expires: future });
  assert.equal((await d._resolveIdentity('tok')).role, 'admin');
  await put(d, 'owner:a@b.com', { email: 'a@b.com', role: 'manager' });
  assert.equal((await d._resolveIdentity('tok')).role, 'manager');
});

test('expired or missing session resolves to null', async () => {
  const d = makeDO();
  await put(d, 'sess:old', { kind: 'fd', id: 'fd-1', role: 'admin', expires: Date.now() - 1 });
  await put(d, 'config:fd_users', [{ id: 'fd-1', role: 'admin' }]);
  assert.equal(await d._resolveIdentity('old'), null);
  assert.equal(await d._resolveIdentity('nope'), null);
  assert.equal(await d._resolveIdentity(''), null);
});

// ── F35 appadmin pinEpoch ────────────────────────────────────────────────────
test('appadmin session validates while its pinEpoch matches env, is revoked after a bump', async () => {
  const d = makeDO({ APP_ADMIN_PIN_EPOCH: '0' });
  await put(d, 'sess:tok', { kind: 'appadmin', id: 'appadmin', name: 'App Admin', role: 'admin', pinEpoch: '0', expires: future });
  assert.equal((await d._resolveIdentity('tok')).role, 'admin');
  const d2 = makeDO({ APP_ADMIN_PIN_EPOCH: '1' });   // owner rotated the master PIN + bumped the epoch
  await d2.state.storage.put('sess:tok', { kind: 'appadmin', id: 'appadmin', role: 'admin', pinEpoch: '0', expires: future });
  assert.equal(await d2._resolveIdentity('tok'), null, 'old-epoch master session revoked');
});

test('appadmin back-compat: a session with no pinEpoch validates while the env epoch is unset/0', async () => {
  const d = makeDO({});   // APP_ADMIN_PIN_EPOCH unset
  await put(d, 'sess:tok', { kind: 'appadmin', id: 'appadmin', role: 'admin', expires: future });   // no pinEpoch (pre-F35)
  assert.equal((await d._resolveIdentity('tok')).role, 'admin', 'no owner lockout on deploy');
});
