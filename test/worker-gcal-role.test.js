// Phase 2 Part 1 — F13: /gcal/connect|token|disconnect mint/refresh the salon's Google
// Calendar+Tasks access token; a tech must not be able to. When armed, these require a
// manager/admin session (403 otherwise). /gcal/callback + /gcal/status stay open. Behind the
// RBAC kill-switch (off ⇒ inert). Uses a mock SALON_DO whose /auth/check returns the role.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../cloudflare/worker.js';

function envWith({ role, armed = true }) {
  const resp = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
  return {
    AUTH_ENFORCED: armed ? 'true' : 'false',
    RBAC_ENFORCED: armed ? 'true' : 'false',
    GCAL_CLIENT_SECRET: 'x',   // so /gcal/token doesn't early-503 before we can observe the gate
    SALON_DO: {
      idFromName: (s) => s,
      get: () => ({ fetch: async (reqOrUrl) => {
        const u = new URL(typeof reqOrUrl === 'string' ? reqOrUrl : reqOrUrl.url);
        if (u.pathname === '/auth/check') return resp({ ok: role != null, user: role ? { kind: 'fd', id: 'u', name: 'U', role } : null });
        return resp({ entry: null });   // /registry/get (not disabled), /gcal/blob ({} → not_connected)
      } }),
    },
  };
}
let _n = 0;
const hit = (path, opts) => worker.fetch(
  new Request(`https://w${path}?salon=acme&auth=tok-${++_n}`, { method: 'GET' }),
  envWith(opts),
);

test('armed: a tech is FORBIDDEN (403) from /gcal/token', async () => {
  assert.equal((await hit('/gcal/token', { role: 'tech' })).status, 403);
});

test('armed: an admin PASSES the gate on /gcal/token (reaches the handler → 401 not_connected, not 403)', async () => {
  const r = await hit('/gcal/token', { role: 'admin' });
  assert.notEqual(r.status, 403, 'admin must pass the F13 gate');
  assert.equal(r.status, 401, 'reaches the token handler which 401s with no stored refresh token');
});

test('armed: a manager PASSES the gate on /gcal/connect (redirects, not 403)', async () => {
  const r = await hit('/gcal/connect', { role: 'manager' });
  assert.notEqual(r.status, 403, 'manager must pass the F13 gate');
});

test('armed: a reviewer is FORBIDDEN from /gcal/disconnect', async () => {
  assert.equal((await hit('/gcal/disconnect', { role: 'reviewer' })).status, 403);
});

test('RBAC-off: the gate is inert — a tech reaches the handler (401), not 403', async () => {
  const r = await hit('/gcal/token', { role: 'tech', armed: false });
  assert.notEqual(r.status, 403, 'disarmed ⇒ no F13 gate');
});
