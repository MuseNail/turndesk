// Auth/access hardening (data-safety review D-group):
//  - safeEqual: constant-time secret compare (D4)
//  - RESTORE_TOKEN gates fail CLOSED when the secret is unset (D1)
//  - signup per-IP pending cap (D5)
// See cloudflare/worker.js safeEqual / authOwnerSet / the /state/* gates / the /signup/request handler.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnDeskDO, safeEqual } from '../cloudflare/worker.js';

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

// ── D4: safeEqual ──────────────────────────────────────────────────────────────
test('safeEqual matches equal strings, rejects differing/length-mismatched, is null-safe', () => {
  assert.equal(safeEqual('abc123XYZ', 'abc123XYZ'), true);
  assert.equal(safeEqual('abc123XYZ', 'abc123XYw'), false);
  assert.equal(safeEqual('abc', 'abcd'), false, 'length mismatch → false');
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual(null, ''), true, 'null normalizes to empty string');
  assert.equal(safeEqual('x', null), false);
  assert.equal(safeEqual(undefined, undefined), true);
});

// ── D1: authOwnerSet fails CLOSED when RESTORE_TOKEN is unset ────────────────────
test('authOwnerSet is DENIED (403) when RESTORE_TOKEN is unset — no owner takeover on a misconfig', async () => {
  const s = makeStorage();
  const doInst = new TurnDeskDO({ storage: s }, {});   // env has NO RESTORE_TOKEN
  const r = await doInst.authOwnerSet(jreq('/auth/owner-set', { email: 'attacker@x.com', password: 'takeover1', token: 'anything' }));
  assert.equal(r.status, 403, 'must fail closed');
  assert.equal(await s.get('owner:attacker@x.com'), undefined, 'no owner credential written');
});

test('authOwnerSet rejects a wrong token and accepts the correct one', async () => {
  const s = makeStorage();
  const doInst = new TurnDeskDO({ storage: s }, { RESTORE_TOKEN: 'op-secret-abc123' });
  assert.equal((await doInst.authOwnerSet(jreq('/auth/owner-set', { email: 'o@x.com', password: 'secret9', token: 'wrong' }))).status, 403);
  const ok = await doInst.authOwnerSet(jreq('/auth/owner-set', { email: 'o@x.com', password: 'secret9', token: 'op-secret-abc123' }));
  assert.equal(ok.status, 200);
  assert.ok(await s.get('owner:o@x.com'), 'owner credential written only on the valid token');
});

test('/state/restore is DENIED (403) when RESTORE_TOKEN is unset — destructive route fails closed', async () => {
  const doInst = new TurnDeskDO({ storage: makeStorage() }, { PHOTOS_BUCKET: { async get(){return null;}, async list(){return {objects:[]};}, async put(){} } });   // no RESTORE_TOKEN
  const r = await doInst.fetch(jreq('/state/restore', { confirm: true }));
  assert.equal(r.status, 403);
});

// ── D5: signup per-EMAIL pending cap (not per-IP — avoids shared-NAT false positives) ──
test('signup caps repeated pending requests from the same EMAIL, but not a different email on the same IP', async () => {
  const doInst = new TurnDeskDO({ storage: makeStorage() }, {});
  const ip = { 'CF-Connecting-IP': '203.0.113.7' };   // same egress IP throughout (e.g. shared NAT)
  const bodyA = { business: 'A Salon', ownerName: 'Owner A', email: 'a@test.com', password: 'secret9' };
  for (let i = 0; i < 3; i++) {
    assert.equal((await doInst.fetch(jreq('/signup/request', bodyA, ip))).status, 200, `signup ${i + 1} should succeed`);
  }
  assert.equal((await doInst.fetch(jreq('/signup/request', bodyA, ip))).status, 429, '4th pending from the SAME email is capped');
  // A DIFFERENT owner behind the same shared IP must NOT be blocked by the cap.
  const bodyB = { business: 'B Salon', ownerName: 'Owner B', email: 'b@test.com', password: 'secret9' };
  assert.equal((await doInst.fetch(jreq('/signup/request', bodyB, ip))).status, 200, 'different email on the same IP is not falsely capped');
});
