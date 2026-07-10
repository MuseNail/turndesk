// Cross-salon email login (adaptive sign-in, Part B): a salon-agnostic
// POST /auth/find-login that finds an owner's salon by email, then delegates
// password validation to THAT salon's own DO (which mints a session scoped to
// itself). The reserved '__registry__' DO only holds an email→slug index — no
// secrets — so a leaked index reveals a mapping, never a working credential.
// See worker.js TurnDeskDO.findLogin + the /registry/index-owner route.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { TurnDeskDO } from '../cloudflare/worker.js';

function makeStorage() {
  const m = new Map();
  return {
    _m: m,
    async get(k) { return m.has(k) ? m.get(k) : undefined; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { if (Array.isArray(k)) k.forEach(x => m.delete(x)); else m.delete(k); },
    async deleteAll() { m.clear(); },
    async list({ prefix } = {}) {
      const r = new Map();
      for (const [k, v] of m) if (!prefix || k.startsWith(prefix)) r.set(k, v);
      return r;
    },
    async getAlarm() { return null; },
    async setAlarm() {},
  };
}

// Builds a mini multi-DO cluster: one TurnDeskDO per salon slug plus a
// '__registry__' instance. A SINGLE mock SALON_DO namespace routes
// idFromName(slug)/get(id) back to the matching DO's .fetch — including
// '__registry__' → the registry instance — mirroring how the real Worker
// addresses SALON_DO. The namespace is returned so the worker's top-level
// fetch()/_handle() can be exercised end-to-end (it calls registryStub()).
function makeCluster(slugs, { restoreToken = 'test-restore-token' } = {}) {
  const salonDOs = {};
  const doByName = {};
  const namespace = {
    idFromName: (s) => ({ _slug: s }),
    get: (id) => doByName[id._slug],
  };
  const salonEnv = { RESTORE_TOKEN: restoreToken, SALON_DO: namespace };
  for (const slug of slugs) {
    salonDOs[slug] = new TurnDeskDO({ storage: makeStorage() }, salonEnv);
    doByName[slug] = salonDOs[slug];
  }
  const registryEnv = { RESTORE_TOKEN: restoreToken, SALON_DO: namespace };
  const registry = new TurnDeskDO({ storage: makeStorage() }, registryEnv);
  doByName['__registry__'] = registry;
  return { salonDOs, registry, namespace };
}

async function setOwner(salonDO, { email, password, name = 'Owner', role = 'owner', token = 'test-restore-token' }) {
  const res = await salonDO.fetch(new Request('https://do/auth/owner-set', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, email, password, name, role }),
  }));
  const j = await res.json();
  assert.equal(j.ok, true, 'owner-set must succeed in test setup');
}

async function indexOwner(registry, { email, slug }) {
  const res = await registry.fetch(new Request('https://do/registry/index-owner', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, slug }),
  }));
  return res.json();
}

async function findLogin(registry, { email, password }) {
  const res = await registry.fetch(new Request('https://do/auth/find-login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }));
  return { status: res.status, body: await res.json() };
}

async function authCheck(salonDO, token) {
  const res = await salonDO.fetch(new Request('https://do/auth/check', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  }));
  return res.json();
}

test('index-owner writes email→slug; a second salon for the same email appends (dedupe on repeat)', async () => {
  const { registry } = makeCluster(['lush', 'glam']);
  let r = await indexOwner(registry, { email: 'Owner@Lush.com', slug: 'lush' });
  assert.equal(r.ok, true);
  r = await indexOwner(registry, { email: 'owner@lush.com', slug: 'glam' });
  assert.equal(r.ok, true);
  // repeat write of an existing mapping must not duplicate
  r = await indexOwner(registry, { email: 'owner@lush.com', slug: 'lush' });
  assert.equal(r.ok, true);

  const rec = await registry.state.storage.get('owneremail:owner@lush.com');
  assert.deepEqual(rec.slugs, ['lush', 'glam'], 'must hold exactly the two distinct slugs, case-insensitively keyed');
});

test('find-login: correct email+password returns the matched salon + a token valid ONLY there', async () => {
  const { salonDOs, registry } = makeCluster(['lush', 'glam']);
  await setOwner(salonDOs.lush, { email: 'owner@lush.com', password: 'correct-horse-1' });
  await indexOwner(registry, { email: 'owner@lush.com', slug: 'lush' });

  const { status, body } = await findLogin(registry, { email: 'owner@lush.com', password: 'correct-horse-1' });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.slug, 'lush');
  assert.ok(body.token, 'must return a session token');
  assert.ok(body.user, 'must return the user record');

  const lushCheck = await authCheck(salonDOs.lush, body.token);
  assert.equal(lushCheck.ok, true, 'token must validate on the matched salon');

  const glamCheck = await authCheck(salonDOs.glam, body.token);
  assert.equal(glamCheck.ok, false, 'token minted by lush must be REJECTED by glam — no cross-tenant session');
});

test('find-login: wrong password → generic {ok:false}, no slug/email leaked', async () => {
  const { salonDOs, registry } = makeCluster(['lush']);
  await setOwner(salonDOs.lush, { email: 'owner@lush.com', password: 'correct-horse-1' });
  await indexOwner(registry, { email: 'owner@lush.com', slug: 'lush' });

  const { status, body } = await findLogin(registry, { email: 'owner@lush.com', password: 'wrong-password' });
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.slug, undefined);
  assert.equal(body.token, undefined);
  assert.equal(Object.keys(body).length, 1, 'failure body must carry nothing beyond {ok:false}');
});

test('find-login: unknown email → the SAME generic {ok:false} shape as wrong-password', async () => {
  const { salonDOs, registry } = makeCluster(['lush']);
  await setOwner(salonDOs.lush, { email: 'owner@lush.com', password: 'correct-horse-1' });
  await indexOwner(registry, { email: 'owner@lush.com', slug: 'lush' });

  const wrongPw  = await findLogin(registry, { email: 'owner@lush.com', password: 'nope' });
  const noMap    = await findLogin(registry, { email: 'nobody@nowhere.com', password: 'nope' });
  assert.equal(noMap.status, 200);
  assert.deepEqual(noMap.body, { ok: false });
  assert.deepEqual(noMap.body, wrongPw.body, 'unknown-email and wrong-password responses must be byte-identical — no enumeration signal');
});

test('find-login: email mapped to 2 salons returns the one whose password actually matches', async () => {
  const { salonDOs, registry } = makeCluster(['lush', 'glam']);
  await setOwner(salonDOs.lush, { email: 'multi@owner.com', password: 'lush-secret-1' });
  await setOwner(salonDOs.glam, { email: 'multi@owner.com', password: 'glam-secret-1' });
  await indexOwner(registry, { email: 'multi@owner.com', slug: 'lush' });
  await indexOwner(registry, { email: 'multi@owner.com', slug: 'glam' });

  const { body } = await findLogin(registry, { email: 'multi@owner.com', password: 'glam-secret-1' });
  assert.equal(body.ok, true);
  assert.equal(body.slug, 'glam', 'must match the salon whose OWN password check passes, not just the first mapped slug');

  const glamCheck = await authCheck(salonDOs.glam, body.token);
  assert.equal(glamCheck.ok, true);
  const lushCheck = await authCheck(salonDOs.lush, body.token);
  assert.equal(lushCheck.ok, false, 'the glam-minted token must not validate on lush');
});

test('find-login: registry owneremail: index holds no password/hash', async () => {
  const { salonDOs, registry } = makeCluster(['lush']);
  await setOwner(salonDOs.lush, { email: 'owner@lush.com', password: 'correct-horse-1' });
  await indexOwner(registry, { email: 'owner@lush.com', slug: 'lush' });

  const rec = await registry.state.storage.get('owneremail:owner@lush.com');
  const json = JSON.stringify(rec);
  assert.ok(!/hash|salt|password/i.test(json), `index entry must carry no credential material, got ${json}`);
  assert.deepEqual(Object.keys(rec).sort(), ['slugs']);
});

test('find-login: throttle responds with the canonical slow_down shape (not a bespoke message)', async () => {
  const { salonDOs, registry } = makeCluster(['lush']);
  await setOwner(salonDOs.lush, { email: 'owner@lush.com', password: 'correct-horse-1' });
  await indexOwner(registry, { email: 'owner@lush.com', slug: 'lush' });

  let throttled = null;
  for (let i = 0; i < 10; i++) {
    const res = await findLogin(registry, { email: 'owner@lush.com', password: 'wrong' });
    if (res.status === 429) { throttled = res; break; }
  }
  assert.ok(throttled, 'rapid repeated find-login attempts from one IP must eventually be throttled');
  // Mirror authLogin's throttle response so the client's existing slow_down handling
  // shows a wait message, instead of falling through to a misleading "incorrect password".
  assert.equal(throttled.body.error, 'slow_down', 'throttle must use the canonical slow_down token');
  assert.equal(typeof throttled.body.retryInSec, 'number', 'throttle must tell the client how long to wait');
  assert.ok(throttled.body.retryInSec > 0, 'retryInSec must be a positive number of seconds');
});

// ── Security-review fixes (adversarial round) ───────────────────────────────

// CRITICAL fix #2: the worker rebuilds a clean forward (no X-Salon / no ?salon=)
// so a poisoned header can't reach the registry DO's fetch() → _rememberSlug and
// corrupt the registry's own meta:slug (which would cross-wire the backup
// namespace). Exercised end-to-end through the real worker.fetch().
test('worker.fetch strips X-Salon before forwarding find-login → registry meta:slug never poisoned', async () => {
  const { salonDOs, registry, namespace } = makeCluster(['lush']);
  await setOwner(salonDOs.lush, { email: 'owner@lush.com', password: 'correct-horse-1' });
  await indexOwner(registry, { email: 'owner@lush.com', slug: 'lush' });

  const env = { SALON_DO: namespace };
  const res = await worker.fetch(new Request('https://api.turndesk.app/auth/find-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Salon': 'victim', 'CF-Connecting-IP': '203.0.113.9' },
    body: JSON.stringify({ email: 'owner@lush.com', password: 'correct-horse-1' }),
  }), env);
  const body = await res.json();
  assert.equal(body.ok, true, 'find-login must still work end-to-end through the worker');
  assert.equal(body.slug, 'lush');
  assert.equal(await registry.state.storage.get('meta:slug'), undefined,
    'attacker X-Salon must NOT be persisted into the registry DO (clean forward strips it)');
});

// CRITICAL fix #1: a CLIENT request may never address a reserved slug — without
// the guard, X-Salon:'__registry__' on an ordinary route would route at the
// cross-salon registry DO, where the 1234 fresh-system fallback (empty
// config:fd_users) could mint a registry admin session.
test('worker.fetch rejects a client request addressing a reserved slug (__registry__)', async () => {
  const { namespace } = makeCluster(['lush']);
  const env = { SALON_DO: namespace };
  const res = await worker.fetch(new Request('https://api.turndesk.app/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Salon': '__registry__' },
    body: JSON.stringify({ pin: '1234' }),
  }), env);
  assert.equal(res.status, 404, 'addressing the reserved registry slug must 404, not route to it');
  const body = await res.json().catch(() => ({}));
  assert.equal(body.token, undefined, 'no session token may ever be minted on the registry DO');
});

// Same guard covers the other reserved names (admin/operator/api/…), not just the registry.
test('worker.fetch rejects a client request addressing any other reserved slug (admin)', async () => {
  const { namespace } = makeCluster(['lush']);
  const env = { SALON_DO: namespace };
  const res = await worker.fetch(new Request('https://api.turndesk.app/state/snapshot', {
    method: 'GET',
    headers: { 'X-Salon': 'admin' },
  }), env);
  assert.equal(res.status, 404, 'reserved slug "admin" must 404');
});

// IMPORTANT fix: findLogin forwards the real client IP to each salon's /auth/login
// so the salon's own authfail:<ip> brute-force counter buckets by the attacker's
// IP, not 'local'. Prove the IP is threaded through by asserting the salon DO
// stamped authfail:<that-ip> after a wrong-password cross-salon attempt.
test('find-login forwards the real client IP to the salon brute-force counter', async () => {
  const { salonDOs, registry, namespace } = makeCluster(['lush']);
  await setOwner(salonDOs.lush, { email: 'owner@lush.com', password: 'correct-horse-1' });
  await indexOwner(registry, { email: 'owner@lush.com', slug: 'lush' });

  const env = { SALON_DO: namespace };
  await worker.fetch(new Request('https://api.turndesk.app/auth/find-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.7' },
    body: JSON.stringify({ email: 'owner@lush.com', password: 'wrong-password' }),
  }), env);

  const byAttacker = await salonDOs.lush.state.storage.get('authfail:198.51.100.7');
  assert.ok(byAttacker && byAttacker.n >= 1, 'the wrong guess must count against the attacker IP on the salon DO');
  const byLocal = await salonDOs.lush.state.storage.get('authfail:local');
  assert.equal(byLocal, undefined, 'the guess must NOT be bucketed under the generic "local" key');
});

// ── Security-review follow-ups (2026-07-10) ─────────────────────────────────

// A salon the operator has DISABLED (registry status:'disabled') is locked out of
// every route by appAuthOk — so handing back a token would only 401 on reload.
// find-login instead reports {error:'disabled'} so the (already password-verified)
// owner sees a clear "salon not active" message rather than a dead reload.
test('find-login: a DISABLED salon returns {error:disabled} — no token, no reload target', async () => {
  const { salonDOs, registry } = makeCluster(['lush']);
  await setOwner(salonDOs.lush, { email: 'owner@lush.com', password: 'correct-horse-1' });
  await indexOwner(registry, { email: 'owner@lush.com', slug: 'lush' });
  await registry.state.storage.put('salon:lush', { slug: 'lush', status: 'disabled' });   // operator disabled it

  const { status, body } = await findLogin(registry, { email: 'owner@lush.com', password: 'correct-horse-1' });
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'disabled', 'the correct-password owner must be told the salon is disabled');
  assert.equal(body.token, undefined, 'no session token for a disabled salon');
  assert.equal(body.slug, undefined, 'no ?salon= reload target for a disabled salon');
});

// The disabled state is revealed ONLY after a correct password (the token-match branch),
// so a guesser learns nothing: a wrong password on a disabled salon is byte-identical to
// any other failure — no enumeration signal that the salon exists-but-is-disabled.
test('find-login: a WRONG password on a disabled salon is indistinguishable from any failure', async () => {
  const { salonDOs, registry } = makeCluster(['lush']);
  await setOwner(salonDOs.lush, { email: 'owner@lush.com', password: 'correct-horse-1' });
  await indexOwner(registry, { email: 'owner@lush.com', slug: 'lush' });
  await registry.state.storage.put('salon:lush', { slug: 'lush', status: 'disabled' });

  const { body } = await findLogin(registry, { email: 'owner@lush.com', password: 'wrong' });
  assert.deepEqual(body, { ok: false }, 'without the password, disabled must look like any other rejection');
});

// A salon with an explicit active entry — and (via the existing tests) a salon with NO
// registry entry at all, like the directly-seeded demo — still returns the token.
test('find-login: an explicitly-active salon still returns the token', async () => {
  const { salonDOs, registry } = makeCluster(['lush']);
  await setOwner(salonDOs.lush, { email: 'owner@lush.com', password: 'correct-horse-1' });
  await indexOwner(registry, { email: 'owner@lush.com', slug: 'lush' });
  await registry.state.storage.put('salon:lush', { slug: 'lush', status: 'active' });

  const { body } = await findLogin(registry, { email: 'owner@lush.com', password: 'correct-horse-1' });
  assert.equal(body.ok, true);
  assert.ok(body.token, 'an active salon still mints a token');
  assert.equal(body.slug, 'lush');
});
