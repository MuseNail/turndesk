// H1 (stress-test 2026-07-11): the fresh-system PIN "1234" fallback was an admin backdoor
// on any freshly-provisioned salon (empty fd_users) — anyone knowing the public slug could
// POST /auth/login {pin:"1234"} and get a 30-day admin session that even survived setup.
// Option 2 fix: the server never mints a session for 1234 (owners bootstrap via email/password,
// then set a manager PIN); and stale 'fallback' sessions are no longer exempt from revocation.
// See cloudflare/worker.js authLogin / authCheck.
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
const jreq = (path, body, headers = {}) => new Request('https://do' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('authLogin REJECTS pin 1234 on a salon with no front-desk users (no 1234 backdoor)', async () => {
  const s = makeStorage();
  const doInst = new TurnDeskDO({ storage: s }, {});   // fresh salon: no fd_users, no owner
  const r = await doInst.authLogin(jreq('/auth/login', { slug: 'acme', pin: '1234' }));
  assert.equal(r.status, 401, 'pin 1234 must not mint a session on a provisioned salon');
  const body = await r.json();
  assert.ok(!body.token, 'no token issued for 1234');
});

test('authLogin still accepts a real front-desk PIN', async () => {
  const s = makeStorage();
  await s.put('config:fd_users', [{ id: 'fd1', name: 'Mgr', pin: '4321', role: 'admin' }]);
  const doInst = new TurnDeskDO({ storage: s }, {});
  const r = await doInst.authLogin(jreq('/auth/login', { slug: 'acme', pin: '4321' }));
  assert.equal(r.status, 200, 'a configured front-desk PIN still logs in');
  const body = await r.json();
  assert.equal(body.user.id, 'fd1');
  assert.ok(body.token, 'a real PIN still mints a session');
});

test('authCheck revokes a leftover 1234 "fallback" session once fd_users no longer contains it', async () => {
  const s = makeStorage();
  // a session minted by the OLD 1234 path (pre-fix) that lingers after deploy
  await s.put('sess:tok-old', { kind: 'fd', id: 'fallback', name: 'Manager', role: 'admin', expires: Date.now() + 1e9 });
  const doInst = new TurnDeskDO({ storage: s }, {});
  const body = await (await doInst.authCheck(jreq('/auth/check', { token: 'tok-old' }))).json();
  assert.equal(body.ok, false, 'a leftover fallback session must no longer be exempt from revocation');
});

test('authCheck STILL exempts the master appadmin session (no user row to revoke against)', async () => {
  const s = makeStorage();
  await s.put('sess:tok-admin', { kind: 'appadmin', id: 'appadmin', name: 'App Admin', role: 'admin', expires: Date.now() + 1e9 });
  const doInst = new TurnDeskDO({ storage: s }, {});
  const body = await (await doInst.authCheck(jreq('/auth/check', { token: 'tok-admin' }))).json();
  assert.equal(body.ok, true, 'appadmin stays valid (gated by APP_ADMIN_PIN at mint time)');
});
