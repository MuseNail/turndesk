// Item 2 (stress-test 2026-07-11 LOW): operator provisioning ran seed -> owner-set -> registry
// with NO check that seed/owner-set actually succeeded, so a transient failure could register a
// salon with no owner credential (owner locked out) or return { ok:true } for a half-provisioned
// salon. Fix: only register (and report ok) once seed AND owner-set both return 2xx.
// See cloudflare/worker.js handleOperator ("POST /operator/salons").
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleOperator } from '../cloudflare/worker.js';

const jres = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

// Mock the DO namespace: one stub answers both the salon DO routes (seed/owner-set) and the
// __registry__ routes (get/put/index-owner), recording which paths were hit.
function mockEnv({ ownerSetOk = true, seedOk = true } = {}) {
  const calls = [];
  const stub = {
    async fetch(req) {
      const p = new URL(req.url).pathname;
      calls.push(p);
      if (p === '/provision/seed')      return seedOk ? jres({ ok: true }) : jres({ error: 'seed failed' }, 500);
      if (p === '/auth/owner-set')      return ownerSetOk ? jres({ ok: true }) : jres({ error: 'unauthorized' }, 403);
      if (p === '/registry/get')        return jres({ entry: null });   // slug is free
      if (p === '/registry/put')        return jres({ ok: true });
      if (p === '/registry/index-owner') return jres({ ok: true });
      return jres({ ok: true });
    },
  };
  return { env: { SALON_DO: { idFromName: n => n, get: () => stub }, RESTORE_TOKEN: 'r', OPERATOR_TOKEN: 'op' }, calls };
}

function provReq() {
  const url = new URL('https://w/operator/salons');
  const req = new Request(url, { method: 'POST', headers: { Authorization: 'Bearer op', 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: 'testsalon', name: 'Test', ownerEmail: 'o@x.com', ownerPassword: 'secret9' }) });
  return { url, req };
}

test('provision does NOT register a salon (or report ok) when owner-set fails — no locked-out salon', async () => {
  const { env, calls } = mockEnv({ ownerSetOk: false });
  const { url, req } = provReq();
  const res = await handleOperator(req, env, url, 'POST', '/operator/salons');
  assert.notEqual(res.status, 200, 'must not report success when the owner credential was not set');
  assert.ok((await res.json()).error, 'returns an error');
  assert.ok(!calls.includes('/registry/put'), 'a salon with no owner credential must NOT be written to the registry');
});

test('provision registers the salon and reports ok when every step succeeds', async () => {
  const { env, calls } = mockEnv({});
  const { url, req } = provReq();
  const res = await handleOperator(req, env, url, 'POST', '/operator/salons');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  assert.ok(calls.includes('/registry/put'), 'the registry entry is written on success');
});
