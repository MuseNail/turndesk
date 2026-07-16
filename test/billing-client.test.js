// SaaS billing Phase 1 — the client-side visibility rule for Settings → Billing.
// canSeeBilling is the single gate the nav's dynamic `hidden` getter rides on: the
// section must not exist anywhere in the UI unless the operator's selfserve flag is
// on AND the signed-in session is the owner or an admin — never the platform
// operator's own master login (appadmin), matching the server-side denial.
import './setup-globals.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSeeBilling } from '../js/app/features/billing.js';

const ON = { selfserveBillingEnabled: true };
const OFF = { selfserveBillingEnabled: false };

test('flag off hides billing for everyone — the beta default', () => {
  assert.equal(canSeeBilling({ kind: 'owner', role: 'owner' }, OFF), false);
  assert.equal(canSeeBilling({ kind: 'fd', role: 'admin' }, OFF), false);
  assert.equal(canSeeBilling({ kind: 'owner', role: 'owner' }, null), false, 'flags not yet fetched → hidden');
});

test('with the flag on: owner and fd-admin see it', () => {
  assert.equal(canSeeBilling({ kind: 'owner', role: 'owner' }, ON), true);
  assert.equal(canSeeBilling({ kind: 'owner', role: 'manager' }, ON), true, 'an owner-kind session sees billing regardless of role');
  assert.equal(canSeeBilling({ kind: 'fd', role: 'admin' }, ON), true, 'delegated front-desk admin');
});

test('with the flag on: tech, plain front-desk, appadmin, and signed-out are all hidden', () => {
  assert.equal(canSeeBilling({ kind: 'tech', role: 'tech' }, ON), false);
  assert.equal(canSeeBilling({ kind: 'fd', role: 'frontdesk' }, ON), false);
  assert.equal(canSeeBilling({ kind: 'appadmin', role: 'admin' }, ON), false, 'the master app-admin never touches a salon’s payment method');
  assert.equal(canSeeBilling(null, ON), false);
});
