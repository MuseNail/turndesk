// SaaS billing Phase 1 — operator billing routes (handleOperator /operator/billing/*).
// Drives the exported handleOperator with a mock env whose SALON_DO namespace hands back
// REAL TurnDeskDO instances (one per id, '__registry__' included) over mock storage —
// so these tests exercise the actual Worker↔DO wiring, not a stub of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnDeskDO, handleOperator, reconcileAccount } from '../cloudflare/worker.js';

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
  const instances = new Map();
  const env = {
    OPERATOR_TOKEN: 'op-secret',
    SALON_DO: {
      idFromName: n => n,
      get(id) {
        if (!instances.has(id)) instances.set(id, new TurnDeskDO({ storage: makeStorage() }, env));
        const d = instances.get(id);
        return { fetch: (reqOrUrl, init) => d.fetch(reqOrUrl instanceof Request ? reqOrUrl : new Request(reqOrUrl, init)) };
      },
    },
    _instances: instances,
  };
  return env;
}
const op = (env, path, body, method) => {
  const url = new URL('https://x' + path);
  const m = method || (body === undefined ? 'GET' : 'POST');
  const r = new Request(url, { method: m, headers: { Authorization: 'Bearer op-secret', 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return handleOperator(r, env, url, m, path);
};
const j = res => res.json();
// assign requires a REGISTERED salon (it 404s otherwise) — register one like provisioning does.
const reg = (env, slug, name) => env.SALON_DO.get('__registry__').fetch('https://do/registry/put', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ entry: { slug, name: name || slug, status: 'active', ownerEmail: 'o@x.com', plan: '', createdAt: '' } }),
});

test('operator billing routes 401 without the operator token', async () => {
  const env = makeEnv();
  const url = new URL('https://x/operator/billing/overview');
  const r = await handleOperator(new Request(url), env, url, 'GET', '/operator/billing/overview');
  assert.equal(r.status, 401);
});

test('overview seeds the four plans exactly once and returns flags+plans+accounts', async () => {
  const env = makeEnv();
  let o = await j(await op(env, '/operator/billing/overview'));
  assert.equal(o.plans.length, 4);
  assert.deepEqual(o.flags, { enforcementEnabled: false, selfserveBillingEnabled: false });
  o = await j(await op(env, '/operator/billing/overview'));
  assert.equal(o.plans.length, 4, 'second view does not re-seed');
  assert.equal(o.plans.find(p => p.planId === 'starter').versions.length, 1);
});

test('flags route flips selfserveBillingEnabled live', async () => {
  const env = makeEnv();
  const r = await j(await op(env, '/operator/billing/flags', { selfserveBillingEnabled: true }));
  assert.equal(r.flags.selfserveBillingEnabled, true);
});

test('assign creates the account pinned to the CURRENT plan version and stamps the registry entry', async () => {
  const env = makeEnv();
  await op(env, '/operator/billing/overview');   // seed
  // a registered salon
  await env.SALON_DO.get('__registry__').fetch('https://do/registry/put', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entry: { slug: 'lux-nails', name: 'Lux Nails', status: 'active', ownerEmail: 'o@x.com', plan: '', createdAt: '' } }) });
  const r = await j(await op(env, '/operator/billing/assign', { slug: 'lux-nails', planId: 'starter' }));
  assert.equal(r.account.planId, 'starter');
  assert.equal(r.account.planVersion, 1);
  assert.equal(r.account.status, 'trialing');
  assert.equal(r.account.trialEndsAt, null, 'no trial clock until the operator starts one');
  assert.equal(r.account.history[0].event, 'assign');
  const entry = (await j(await env.SALON_DO.get('__registry__').fetch('https://do/registry/get?slug=lux-nails'))).entry;
  assert.equal(entry.billingAccountId, 'lux-nails');
});

test('a plan price edit AFTER assign does not move the pinned subscriber', async () => {
  const env = makeEnv();
  await op(env, '/operator/billing/overview');
  await reg(env, 'lux-nails');
  await op(env, '/operator/billing/assign', { slug: 'lux-nails', planId: 'starter' });
  const r = await j(await op(env, '/operator/billing/plans', { planId: 'starter', priceCents: 4900 }));
  assert.equal(r.plan.versions.length, 2, 'edit appended v2');
  const o = await j(await op(env, '/operator/billing/overview'));
  const acct = o.accounts.find(a => a.accountId === 'lux-nails');
  assert.equal(acct.planVersion, 1, 'existing subscriber still pinned to v1 ($34)');
});

test('plans route creates a brand-new plan when the planId is unknown', async () => {
  const env = makeEnv();
  await op(env, '/operator/billing/overview');
  const r = await j(await op(env, '/operator/billing/plans', { planId: 'custom-deal', name: 'Custom', visible: false, priceCents: 12500, capacity: { maxStaffAccounts: null, maxCalendars: null }, features: { sms: { included: true, monthlyLimit: null } } }));
  assert.equal(r.plan.planId, 'custom-deal');
  assert.equal(r.plan.versions[0].version, 1);
  const o = await j(await op(env, '/operator/billing/overview'));
  assert.equal(o.plans.length, 5);
});

test('trial accepts only 14 or 30 days and stamps the clock', async () => {
  const env = makeEnv();
  await op(env, '/operator/billing/overview');
  await reg(env, 'lux-nails');
  await op(env, '/operator/billing/assign', { slug: 'lux-nails', planId: 'starter' });
  const bad = await op(env, '/operator/billing/trial', { slug: 'lux-nails', days: 7 });
  assert.equal(bad.status, 400);
  const before = Date.now();
  const r = await j(await op(env, '/operator/billing/trial', { slug: 'lux-nails', days: 30 }));
  assert.equal(r.account.status, 'trialing');
  assert.ok(r.account.trialEndsAt >= before + 29 * 86400000, '≈30 days out');
});

test('comp caps at 3 months', async () => {
  const env = makeEnv();
  await op(env, '/operator/billing/overview');
  await reg(env, 'lux-nails');
  await op(env, '/operator/billing/assign', { slug: 'lux-nails', planId: 'pro' });
  const bad = await op(env, '/operator/billing/comp', { slug: 'lux-nails', months: 4 });
  assert.equal(bad.status, 400);
  const r = await j(await op(env, '/operator/billing/comp', { slug: 'lux-nails', months: 3 }));
  assert.equal(r.account.status, 'comped');
  assert.ok(r.account.compUntil > Date.now() + 80 * 86400000);
});

test('cancel is sticky through a later reconcile with an approved payment', async () => {
  const env = makeEnv();
  await op(env, '/operator/billing/overview');
  await reg(env, 'lux-nails');
  await op(env, '/operator/billing/assign', { slug: 'lux-nails', planId: 'starter' });
  const r = await j(await op(env, '/operator/billing/cancel', { slug: 'lux-nails' }));
  assert.equal(r.account.status, 'canceled');
  const after = reconcileAccount(r.account, { id: 1, dateBilling: '2026-09-01', payments: [{ id: 5, status: 'approved', amount: 34, date: '2026-08-01' }] });
  assert.equal(after.status, 'canceled', 'a stray approved payment cannot resurrect it');
});

test('trial/comp/cancel on an unassigned salon 404s (no silent skeletons from operator status routes)', async () => {
  const env = makeEnv();
  await op(env, '/operator/billing/overview');
  for (const [path, body] of [['/operator/billing/trial', { slug: 'ghost', days: 14 }], ['/operator/billing/comp', { slug: 'ghost', months: 1 }], ['/operator/billing/cancel', { slug: 'ghost' }]]) {
    const r = await op(env, path, body);
    assert.equal(r.status, 404, path + ' on a missing account');
  }
});

test('operator subscribe requires a captured payment method', async () => {
  const env = makeEnv();
  await op(env, '/operator/billing/overview');
  await reg(env, 'lux-nails');
  await op(env, '/operator/billing/assign', { slug: 'lux-nails', planId: 'starter' });
  const r = await op(env, '/operator/billing/subscribe', { slug: 'lux-nails' });
  assert.equal(r.status, 409, 'no payment method on file → 409, no Helcim call');
});

test('operator subscribe refuses to mint a SECOND subscription on an already-subscribed account (no double charge)', async () => {
  const env = makeEnv();
  await op(env, '/operator/billing/overview');
  await reg(env, 'lux-nails');
  await op(env, '/operator/billing/assign', { slug: 'lux-nails', planId: 'starter' });
  // seed a captured payment method + an existing live subscription directly on the account
  const acct = (await j(await env.SALON_DO.get('__registry__').fetch('https://do/bdo/account-get?id=lux-nails'))).account;
  acct.paymentMethodType = 'card'; acct.helcimCustomerId = 7; acct.helcimSubscriptionId = 555;
  await env.SALON_DO.get('__registry__').fetch('https://do/bdo/account-put', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: acct }) });
  const realFetch = globalThis.fetch;
  let helcimTouched = false;
  globalThis.fetch = async (u) => { if (String(u).includes('api.helcim.com')) helcimTouched = true; return new Response('{}', { status: 200 }); };
  try {
    const r = await op(env, '/operator/billing/subscribe', { slug: 'lux-nails' });
    assert.equal(r.status, 409, 'already subscribed → 409');
    assert.equal(helcimTouched, false, 'no Helcim subscribe call — the first subscription is not orphaned');
  } finally { globalThis.fetch = realFetch; }
});

// Seed a captured card so an account can actually subscribe, and mock Helcim create/customer.
async function armSubscribe(env, slug) {
  const acct = (await j(await env.SALON_DO.get('__registry__').fetch('https://do/bdo/account-get?id=' + slug))).account;
  acct.paymentMethodType = 'card'; acct.helcimCustomerId = 7;
  await env.SALON_DO.get('__registry__').fetch('https://do/bdo/account-put', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: acct }) });
}
test('operator subscribe bills the plan CURRENT-version price and pins it (Helcim recurringAmount = dollars)', async () => {
  const env = makeEnv();
  await op(env, '/operator/billing/overview');
  await reg(env, 'lux-nails');
  await op(env, '/operator/billing/assign', { slug: 'lux-nails', planId: 'starter' });
  await armSubscribe(env, 'lux-nails');
  const realFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (u, init) => {
    calls.push({ url: String(u), body: init && init.body ? JSON.parse(init.body) : null });
    if (String(u).includes('/subscriptions')) return new Response(JSON.stringify([{ id: 700 }]), { status: 200 });
    if (String(u).includes('/payment-plans')) return new Response(JSON.stringify([{ id: 9 }]), { status: 200 });
    if (String(u).includes('/customers')) return new Response(JSON.stringify({ customer: { id: 7, customerCode: 'td-lux-nails' } }), { status: 200 });
    return new Response('{}', { status: 200 });
  };
  try {
    const r = await j(await op(env, '/operator/billing/subscribe', { slug: 'lux-nails' }));
    assert.equal(r.account.helcimSubscriptionId, 700);
    assert.equal(r.account.status, 'active');
    const sub = calls.find(c => c.url.includes('/subscriptions'));
    assert.equal(sub.body.subscriptions[0].recurringAmount, 34, '$34 in dollars at the Helcim edge (cents pinned internally)');
  } finally { globalThis.fetch = realFetch; }
});

test('cancel then re-assign reactivates the account so it can be subscribed again (no permanent 409 dead-end)', async () => {
  const env = makeEnv();
  await op(env, '/operator/billing/overview');
  await reg(env, 'lux-nails');
  await op(env, '/operator/billing/assign', { slug: 'lux-nails', planId: 'starter' });
  await armSubscribe(env, 'lux-nails');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => {
    if (String(u).includes('/subscriptions')) return new Response(JSON.stringify([{ id: 800 }]), { status: 200 });
    if (String(u).includes('/payment-plans')) return new Response(JSON.stringify([{ id: 9 }]), { status: 200 });
    if (String(u).includes('/customers')) return new Response(JSON.stringify({ customer: { id: 7, customerCode: 'td-lux-nails' } }), { status: 200 });
    return new Response('{}', { status: 200 });
  };
  try {
    await op(env, '/operator/billing/subscribe', { slug: 'lux-nails' });
    const canceled = await j(await op(env, '/operator/billing/cancel', { slug: 'lux-nails' }));
    assert.equal(canceled.account.status, 'canceled');
    assert.equal(canceled.account.helcimSubscriptionId, null, 'cancel clears the dead subscription id');
    // subscribing a canceled account is refused until reassigned
    const refused = await op(env, '/operator/billing/subscribe', { slug: 'lux-nails' });
    assert.equal(refused.status, 409, 'canceled → refuse subscribe');
    // reassign reactivates
    const re = await j(await op(env, '/operator/billing/assign', { slug: 'lux-nails', planId: 'pro' }));
    assert.equal(re.account.status, 'trialing', 'reassign brings a canceled account back to a fresh trialing state');
    const ok = await j(await op(env, '/operator/billing/subscribe', { slug: 'lux-nails' }));
    assert.equal(ok.account.status, 'active', 'now it can subscribe again');
    assert.equal(ok.account.helcimSubscriptionId, 800);
  } finally { globalThis.fetch = realFetch; }
});
