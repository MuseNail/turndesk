// SaaS billing Phase 1 — salon-scoped /billing/* routes (handleBilling) + the /bdo/ public-surface 404.
// billingAdminOk requires a valid owner-or-admin session UNCONDITIONALLY (even where general
// AUTH_ENFORCED is off, payment routes stay strictly gated), and denies the platform operator's
// own master login (kind 'appadmin') — consistent with auth.js's "never the master app-admin".
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { TurnDeskDO, handleBilling } from '../cloudflare/worker.js';

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
function makeEnv() {
  const instances = new Map(), storages = new Map();
  const env = {
    SALON_DO: {
      idFromName: n => n,
      get(id) {
        if (!instances.has(id)) { const st = makeStorage(); storages.set(id, st); instances.set(id, new TurnDeskDO({ storage: st }, env)); }
        const d = instances.get(id);
        return { fetch: (reqOrUrl, init) => d.fetch(reqOrUrl instanceof Request ? reqOrUrl : new Request(reqOrUrl, init)) };
      },
    },
    _storages: storages,
  };
  return env;
}
const FUTURE = Date.now() + 86400000;
async function seedSessions(env, slug) {
  const st = (env.SALON_DO.get(slug), env._storages.get(slug));   // instantiate then grab storage
  await st.put('owner:o@x.com', { email: 'o@x.com', name: 'Owner', role: 'owner' });
  await st.put('sess:tokOwner', { kind: 'owner', id: 'o1', name: 'Owner', role: 'owner', email: 'o@x.com', expires: FUTURE });
  await st.put('config:fd_users', [{ id: 'fd-manager', name: 'Mgr', role: 'admin', pin: '9999' }]);
  await st.put('sess:tokFdAdmin', { kind: 'fd', id: 'fd-manager', name: 'Mgr', role: 'admin', expires: FUTURE });
  await st.put('config:staff', [{ id: 't1', name: 'Tina' }]);
  await st.put('sess:tokTech', { kind: 'tech', id: 't1', name: 'Tina', role: 'tech', expires: FUTURE });
  await st.put('sess:tokAppAdmin', { kind: 'appadmin', id: 'appadmin', name: 'App Admin', role: 'admin', expires: FUTURE });
}
const call = (env, path, { token, body, method, salon = 'lux-nails' } = {}) => {
  const url = new URL('https://x' + path);
  const m = method || (body === undefined ? 'GET' : 'POST');
  const r = new Request(url, { method: m, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'X-Salon': salon, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return handleBilling(r, env, url, m, path, salon);
};
const j = res => res.json();
const regDO = env => env.SALON_DO.get('__registry__');
const seedPlansAndAccount = async (env, account) => {
  const { billingPlansEnsureSeed } = await import('../cloudflare/worker.js');
  await billingPlansEnsureSeed(env);
  if (account) await regDO(env).fetch('https://do/bdo/account-put', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account }) });
};
const baseAccount = o => ({ accountId: 'lux-nails', salonSlugs: ['lux-nails'], planId: 'starter', planVersion: 1, status: 'trialing', trialEndsAt: null, compUntil: null, currentPeriodEnd: null, paymentMethodType: null, helcimCustomerId: null, helcimCustomerCode: null, helcimSubscriptionId: null, pastDueSince: null, lastFailureReason: null, achAuthorization: null, history: [], ...o });

test('/billing/status: owner and fd-admin pass; tech, appadmin, and no-token are 401', async () => {
  const env = makeEnv();
  await seedSessions(env, 'lux-nails');
  await seedPlansAndAccount(env, baseAccount());
  for (const token of ['tokOwner', 'tokFdAdmin']) {
    const r = await call(env, '/billing/status', { token });
    assert.equal(r.status, 200, token + ' should pass');
  }
  for (const token of ['tokTech', 'tokAppAdmin', undefined]) {
    const r = await call(env, '/billing/status', { token });
    assert.equal(r.status, 401, String(token) + ' should be denied');
  }
});

test('/billing/status returns only THIS salon account + only visible plans (current version only)', async () => {
  const env = makeEnv();
  await seedSessions(env, 'lux-nails');
  await seedPlansAndAccount(env, baseAccount());
  await regDO(env).fetch('https://do/bdo/account-put', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: baseAccount({ accountId: 'other-salon', salonSlugs: ['other-salon'] }) }) });
  const r = await j(await call(env, '/billing/status', { token: 'tokOwner' }));
  assert.equal(r.account.accountId, 'lux-nails');
  assert.equal(JSON.stringify(r).includes('other-salon'), false, 'another salon account never leaks');
  assert.deepEqual(r.plans.map(p => p.planId).sort(), ['free', 'pro', 'starter'], 'multi (visible:false) is not listed');
  assert.ok(r.plans[0].priceCents !== undefined && !r.plans[0].versions, 'plans are flattened to their current version');
  assert.equal(typeof r.flags.selfserveBillingEnabled, 'boolean');
});

test('/billing/subscribe is 403 while selfserveBillingEnabled is false — the beta promise gate', async () => {
  const env = makeEnv();
  await seedSessions(env, 'lux-nails');
  await seedPlansAndAccount(env, baseAccount({ paymentMethodType: 'card', helcimCustomerId: 7 }));
  const r = await call(env, '/billing/subscribe', { token: 'tokOwner', body: { planId: 'starter' } });
  assert.equal(r.status, 403);
});

test('/billing/subscribe with the flag on creates a Helcim subscription and pins the current version', async () => {
  const env = makeEnv();
  await seedSessions(env, 'lux-nails');
  await seedPlansAndAccount(env, baseAccount({ paymentMethodType: 'card', helcimCustomerId: 7 }));
  await regDO(env).fetch('https://do/bdo/flags-put', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selfserveBillingEnabled: true, helcimPlanId: 42 }) });
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    calls.push({ url: String(u), body: init && init.body ? JSON.parse(init.body) : null });
    if (String(u).includes('/subscriptions')) return new Response(JSON.stringify([{ id: 900 }]), { status: 200 });
    return new Response('{}', { status: 200 });
  };
  try {
    const r = await j(await call(env, '/billing/subscribe', { token: 'tokOwner', body: { planId: 'pro' } }));
    assert.equal(r.account.helcimSubscriptionId, 900);
    assert.equal(r.account.status, 'active');
    assert.equal(r.account.planId, 'pro');
    assert.equal(r.account.planVersion, 1);
    const subCall = calls.find(c => c.url.includes('/subscriptions'));
    assert.equal(subCall.body.subscriptions[0].recurringAmount, 79, 'cents → dollars at the Helcim edge');
  } finally { globalThis.fetch = realFetch; }
});

test('/billing/subscribe on an already-subscribed account only re-pins (plan change) — no second Helcim subscription', async () => {
  const env = makeEnv();
  await seedSessions(env, 'lux-nails');
  await seedPlansAndAccount(env, baseAccount({ paymentMethodType: 'card', helcimCustomerId: 7, helcimSubscriptionId: 900, status: 'active' }));
  await regDO(env).fetch('https://do/bdo/flags-put', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selfserveBillingEnabled: true }) });
  const realFetch = globalThis.fetch;
  let helcimTouched = false;
  globalThis.fetch = async (u) => { if (String(u).includes('api.helcim.com')) helcimTouched = true; return new Response('{}', { status: 200 }); };
  try {
    const r = await j(await call(env, '/billing/subscribe', { token: 'tokOwner', body: { planId: 'pro' } }));
    assert.equal(r.account.planId, 'pro');
    assert.equal(r.pending, true, 'flagged pending so the client can be honest the price isn’t in effect yet');
    assert.equal(r.account.history.at(-1).event, 'plan-change-requested');
    assert.equal(helcimTouched, false, 'Phase 1 records intent; the live subscription is not touched');
  } finally { globalThis.fetch = realFetch; }
});

test('/billing/subscribe to Free while subscribed cancels the live Helcim subscription (downgrade, not a $0 charge)', async () => {
  const env = makeEnv();
  await seedSessions(env, 'lux-nails');
  await seedPlansAndAccount(env, baseAccount({ paymentMethodType: 'card', helcimCustomerId: 7, helcimSubscriptionId: 900, status: 'active' }));
  await regDO(env).fetch('https://do/bdo/flags-put', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selfserveBillingEnabled: true }) });
  const realFetch = globalThis.fetch;
  let cancelHit = false;
  globalThis.fetch = async (u, init) => { if (String(u).includes('/subscriptions/') && init && init.method === 'PATCH') cancelHit = true; return new Response('{}', { status: 200 }); };
  try {
    const r = await j(await call(env, '/billing/subscribe', { token: 'tokOwner', body: { planId: 'free' } }));
    assert.equal(r.account.planId, 'free');
    assert.equal(r.account.helcimSubscriptionId, null, 'the live subscription is cleared');
    assert.equal(cancelHit, true, 'Helcim cancel was called');
  } finally { globalThis.fetch = realFetch; }
});

test('ACH portal-token requires a prior recorded authorization (NACHA) — 428 without it', async () => {
  const env = makeEnv();
  await seedSessions(env, 'lux-nails');
  await seedPlansAndAccount(env, baseAccount());
  await regDO(env).fetch('https://do/bdo/flags-put', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selfserveBillingEnabled: true }) });
  const r = await call(env, '/billing/portal-token', { token: 'tokOwner', body: { ach: true } });
  assert.equal(r.status, 428);
  await call(env, '/billing/ach-authorize', { token: 'tokOwner', body: {} });
  const acct = (await j(await regDO(env).fetch('https://do/bdo/account-get?id=lux-nails'))).account;
  assert.equal(acct.achAuthorization.textVersion, 'ach-auth-v1', 'the server-authoritative wording version, not a client-supplied string');
  assert.ok(/^[0-9a-f]{64}$/.test(acct.achAuthorization.textHash), 'a hash of the exact accepted wording is stored as self-contained evidence');
  assert.ok(acct.achAuthorization.acceptedAt > 0);
});

test('verify-complete validates the SHA-256(raw+secret) hash, is single-use, and sets the payment method', async () => {
  const env = makeEnv();
  await seedSessions(env, 'lux-nails');
  await seedPlansAndAccount(env, baseAccount());
  await regDO(env).fetch('https://do/bdo/pay-put', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'chk1', record: { secretToken: 'shh', slug: 'lux-nails', ts: Date.now() } }) });
  const raw = JSON.stringify({ data: { status: 'APPROVED', customerCode: 'CST100', cardToken: 'ct-1' } });
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw + 'shh'));
  const hash = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  const bad = await call(env, '/billing/verify-complete', { token: 'tokOwner', body: { checkoutToken: 'chk1', rawDataResponse: raw, hash: 'wrong' } });
  assert.equal(bad.status, 400, 'wrong hash rejected');
  // the take is single-use, so re-store for the good attempt
  await regDO(env).fetch('https://do/bdo/pay-put', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'chk1', record: { secretToken: 'shh', slug: 'lux-nails', ts: Date.now() } }) });
  const ok = await j(await call(env, '/billing/verify-complete', { token: 'tokOwner', body: { checkoutToken: 'chk1', rawDataResponse: raw, hash } }));
  assert.equal(ok.account.paymentMethodType, 'card');
  assert.equal(ok.account.helcimCustomerCode, 'CST100');
  const again = await call(env, '/billing/verify-complete', { token: 'tokOwner', body: { checkoutToken: 'chk1', rawDataResponse: raw, hash } });
  assert.equal(again.status, 400, 'checkout token is single-use');
});

test('the Worker 404s /bdo/* on its public surface', async () => {
  const env = makeEnv();
  const r = await worker.fetch(new Request('https://x/bdo/flags-get', { headers: { 'X-Salon': 'lux-nails' } }), env);
  assert.equal(r.status, 404);
});
