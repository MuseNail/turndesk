// SaaS billing Phase 1 — registry-DO storage routes (/bdo/*) + plan versioning + bootstrap seed.
// Billing state lives ONLY in the reserved '__registry__' TurnDeskDO instance, reached via
// registryStub — same pattern as salon:<slug>. These tests drive the DO handlers directly
// (mock storage, no Worker) and the pure plan-versioning helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnDeskDO, savePlanEdit, currentVersion, visiblePlans, SEED_PLANS } from '../cloudflare/worker.js';

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
const makeDO = () => new TurnDeskDO({ storage: makeStorage() }, {});
const req = (path, body) => new Request('https://do' + path, body === undefined
  ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const j = async (res) => res.json();

// ── /bdo/ storage routes ─────────────────────────────────────────────────────
test('flags default to both-false and flags-put merges partial updates', async () => {
  const d = makeDO();
  let r = await j(await d.fetch(req('/bdo/flags-get')));
  assert.deepEqual(r.flags, { enforcementEnabled: false, selfserveBillingEnabled: false });
  r = await j(await d.fetch(req('/bdo/flags-put', { selfserveBillingEnabled: true })));
  assert.equal(r.flags.selfserveBillingEnabled, true);
  assert.equal(r.flags.enforcementEnabled, false, 'untouched flag stays false');
  r = await j(await d.fetch(req('/bdo/flags-get')));
  assert.equal(r.flags.selfserveBillingEnabled, true, 'persisted');
});

test('flags-put ignores non-boolean junk', async () => {
  const d = makeDO();
  const r = await j(await d.fetch(req('/bdo/flags-put', { enforcementEnabled: 'yes', extra: 1 })));
  assert.equal(r.flags.enforcementEnabled, false, 'string "yes" is not a boolean — ignored');
});

test('plan-put/plans-get roundtrip; plan-put rejects a missing planId', async () => {
  const d = makeDO();
  const plan = { planId: 'starter', name: 'Starter', visible: true, versions: [{ version: 1, priceCents: 3400 }] };
  let r = await d.fetch(req('/bdo/plan-put', { plan }));
  assert.equal((await j(r)).ok, true);
  r = await j(await d.fetch(req('/bdo/plans-get')));
  assert.equal(r.plans.length, 1);
  assert.equal(r.plans[0].planId, 'starter');
  const bad = await d.fetch(req('/bdo/plan-put', { plan: { name: 'no id' } }));
  assert.equal(bad.status, 400);
});

test('account-put/account-get/accounts-get roundtrip; account-put rejects a missing accountId', async () => {
  const d = makeDO();
  const account = { accountId: 'lux-nails', salonSlugs: ['lux-nails'], planId: 'starter', planVersion: 1, status: 'trialing', trialEndsAt: null, history: [] };
  assert.equal((await j(await d.fetch(req('/bdo/account-put', { account })))).ok, true);
  let r = await j(await d.fetch(req('/bdo/account-get?id=lux-nails')));
  assert.equal(r.account.planId, 'starter');
  r = await j(await d.fetch(req('/bdo/account-get?id=nope')));
  assert.equal(r.account, null);
  r = await j(await d.fetch(req('/bdo/accounts-get')));
  assert.equal(r.accounts.length, 1);
  const bad = await d.fetch(req('/bdo/account-put', { account: { status: 'active' } }));
  assert.equal(bad.status, 400);
});

test('bpay pay-put/pay-take is single-use (take deletes)', async () => {
  const d = makeDO();
  assert.equal((await j(await d.fetch(req('/bdo/pay-put', { token: 'chk123', record: { secretToken: 's3cr3t', slug: 'lux-nails', ts: 5 } })))).ok, true);
  let r = await j(await d.fetch(req('/bdo/pay-take', { token: 'chk123' })));
  assert.equal(r.record.secretToken, 's3cr3t');
  r = await j(await d.fetch(req('/bdo/pay-take', { token: 'chk123' })));
  assert.equal(r.record, null, 'second take finds nothing — single-use');
});

// ── plan versioning helpers (pure) ───────────────────────────────────────────
const basePlan = () => ({
  planId: 'starter', name: 'Starter', visible: true,
  versions: [{ version: 1, priceCents: 3400, capacity: { maxStaffAccounts: 5, maxCalendars: 5 }, features: { sms: { included: true, monthlyLimit: 100 } }, createdAt: 1 }],
});

test('savePlanEdit: a price change appends a new version and leaves v1 untouched', () => {
  const p = savePlanEdit(basePlan(), { priceCents: 3900 });
  assert.equal(p.versions.length, 2);
  assert.equal(p.versions[0].priceCents, 3400, 'v1 untouched');
  assert.equal(p.versions[1].version, 2);
  assert.equal(p.versions[1].priceCents, 3900);
  assert.equal(p.versions[1].capacity.maxStaffAccounts, 5, 'unchanged fields carry forward');
});

test('savePlanEdit: sms cap change appends a version (numeric feature limits are versioned too)', () => {
  const p = savePlanEdit(basePlan(), { features: { sms: { included: true, monthlyLimit: 250 } } });
  assert.equal(p.versions.length, 2);
  assert.equal(currentVersion(p).features.sms.monthlyLimit, 250);
});

test('savePlanEdit: a name/visible-only edit does NOT bump the version', () => {
  const p = savePlanEdit(basePlan(), { name: 'Starter Plus', visible: false });
  assert.equal(p.versions.length, 1);
  assert.equal(p.name, 'Starter Plus');
  assert.equal(p.visible, false);
});

test('savePlanEdit: a PARTIAL capacity edit merges onto the current version (untouched keys survive)', () => {
  const p = savePlanEdit(basePlan(), { capacity: { maxCalendars: 9 } });   // only one of two capacity keys
  assert.equal(p.versions.length, 2);
  const v = currentVersion(p);
  assert.equal(v.capacity.maxCalendars, 9, 'changed key applied');
  assert.equal(v.capacity.maxStaffAccounts, 5, 'untouched key NOT blanked');
});

test('savePlanEdit: resending identical values in a different key order does NOT bump the version', () => {
  const p = savePlanEdit(basePlan(), { features: { sms: { monthlyLimit: 100, included: true } } });   // keys reversed, same values
  assert.equal(p.versions.length, 1, 'order-insensitive compare — no spurious version');
});

test('visiblePlans filters out hidden plans (Multi stays internal)', () => {
  const plans = [basePlan(), { ...basePlan(), planId: 'multi', visible: false }];
  assert.deepEqual(visiblePlans(plans).map(p => p.planId), ['starter']);
});

// ── bootstrap seed data ──────────────────────────────────────────────────────
test('SEED_PLANS carries the finalized tier matrix', () => {
  const by = Object.fromEntries(SEED_PLANS.map(p => [p.planId, p]));
  assert.deepEqual(Object.keys(by).sort(), ['free', 'multi', 'pro', 'starter']);
  const free = currentVersion(by.free), starter = currentVersion(by.starter), pro = currentVersion(by.pro);
  assert.equal(free.priceCents, 0);
  assert.equal(free.features.turnBoardFull, false, 'Free turn board is display-only');
  assert.equal(free.features.checkin, false);
  assert.equal(free.capacity.maxStaffAccounts, 5);
  assert.equal(starter.priceCents, 3400);
  assert.equal(starter.features.checkin, true);
  assert.equal(starter.features.merchantProcessing, true);
  assert.equal(starter.features.receiptPrinting, true);
  assert.equal(starter.features.cashdrawer, true);
  assert.equal(starter.features.floorplan, false);
  assert.equal(starter.features.giftcards, false);
  assert.deepEqual(starter.features.sms, { included: true, monthlyLimit: 100 });
  assert.equal(starter.capacity.maxCalendars, 5);
  assert.equal(pro.priceCents, 7900);
  assert.equal(pro.features.floorplan, true);
  assert.equal(pro.features.sms.monthlyLimit, null, 'Pro texting is uncapped');
  assert.equal(pro.capacity.maxStaffAccounts, null, 'Pro staff is uncapped');
  assert.equal(by.multi.visible, false, 'Multi is not publicly listed');
});
