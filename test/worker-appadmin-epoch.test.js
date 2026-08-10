// Phase 2 Part 1 — F35: the master APP_ADMIN_PIN session was revocation-exempt for 30 days,
// so rotating the secret didn't kill outstanding sessions. Now login stamps the current
// APP_ADMIN_PIN_EPOCH + a 7-day TTL, and authCheck (via _resolveIdentity) rejects a session
// whose epoch no longer matches — so rotating the PIN + bumping the epoch revokes old master
// sessions. Back-compat: while the epoch is unset/'0', pre-F35 sessions (no pinEpoch) still work.
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
const makeDO = (env) => new TurnDeskDO({ storage: makeStorage() }, env);
const req = (body) => new Request('https://do/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('appadmin login stamps the env pinEpoch and a 7-day TTL', async () => {
  const d = makeDO({ APP_ADMIN_PIN: 'SECRET', APP_ADMIN_PIN_EPOCH: '2' });
  const j = await (await d.authLogin(req({ pin: 'SECRET' }))).json();
  assert.ok(j.token, 'a master session is minted');
  const ttlDays = (j.expires - Date.now()) / (24 * 3600 * 1000);
  assert.ok(ttlDays > 6.5 && ttlDays < 7.5, `7-day TTL, got ${ttlDays.toFixed(2)}d`);
  const sess = await d.state.storage.get('sess:' + j.token);
  assert.equal(sess.pinEpoch, '2', 'session carries the current epoch');
});

test('a minted appadmin session validates, then is revoked after the owner bumps the epoch', async () => {
  const d = makeDO({ APP_ADMIN_PIN: 'SECRET', APP_ADMIN_PIN_EPOCH: '0' });
  const j = await (await d.authLogin(req({ pin: 'SECRET' }))).json();
  const chk = await (await d.authCheck(req({ token: j.token }))).json();
  assert.equal(chk.ok, true);
  assert.equal(chk.user.role, 'admin');
  d.env.APP_ADMIN_PIN_EPOCH = '1';   // owner rotated the master PIN + bumped the epoch
  const chk2 = await (await d.authCheck(req({ token: j.token }))).json();
  assert.equal(chk2.ok, false, 'old-epoch master session no longer valid');
});

test('back-compat: with the epoch unset, an appadmin login works and validates (no lockout)', async () => {
  const d = makeDO({ APP_ADMIN_PIN: 'SECRET' });   // APP_ADMIN_PIN_EPOCH unset
  const j = await (await d.authLogin(req({ pin: 'SECRET' }))).json();
  assert.ok(j.token);
  const chk = await (await d.authCheck(req({ token: j.token }))).json();
  assert.equal(chk.ok, true, 'pre-F35-shaped session (no pinEpoch) still validates while epoch unset');
});
