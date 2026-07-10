// Cross-salon email login (adaptive sign-in, Part B): a salon-agnostic
// POST /auth/find-login that finds an owner's salon by email, then delegates
// password validation to THAT salon's own DO (which mints a session scoped to
// itself). The reserved '__registry__' DO only holds an email→slug index — no
// secrets — so a leaked index reveals a mapping, never a working credential.
// See worker.js TurnDeskDO.findLogin + the /registry/index-owner route.
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
// '__registry__' instance whose env.SALON_DO is a mock namespace that routes
// idFromName(slug)/get(id) back to the matching salon DO's .fetch — mirroring
// how the real Worker addresses SALON_DO.
function makeCluster(slugs, { restoreToken = 'test-restore-token' } = {}) {
  const salonDOs = {};
  const salonEnv = { RESTORE_TOKEN: restoreToken };
  for (const slug of slugs) {
    salonDOs[slug] = new TurnDeskDO({ storage: makeStorage() }, salonEnv);
  }
  const registryEnv = {
    RESTORE_TOKEN: restoreToken,
    SALON_DO: {
      idFromName: (s) => ({ _slug: s }),
      get: (id) => salonDOs[id._slug],
    },
  };
  const registry = new TurnDeskDO({ storage: makeStorage() }, registryEnv);
  return { salonDOs, registry };
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

test('find-login: rate-limited per IP — repeated attempts eventually slow down', async () => {
  const { salonDOs, registry } = makeCluster(['lush']);
  await setOwner(salonDOs.lush, { email: 'owner@lush.com', password: 'correct-horse-1' });
  await indexOwner(registry, { email: 'owner@lush.com', slug: 'lush' });

  let sawThrottle = false;
  for (let i = 0; i < 10; i++) {
    const { status } = await findLogin(registry, { email: 'owner@lush.com', password: 'wrong' });
    if (status === 429) { sawThrottle = true; break; }
  }
  assert.ok(sawThrottle, 'rapid repeated find-login attempts from one IP must eventually be throttled');
});
