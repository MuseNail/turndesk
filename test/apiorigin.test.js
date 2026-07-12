// M2 client hook: apiOrigin() resolves which Worker the client talks to. Default = production;
// a localhost page = local wrangler dev; a ?api= override is honored ONLY for an EXACT-match
// allow-list (the staging worker or localhost) and is sticky in localStorage. The exact-match
// (no wildcard) is the security crux: a wildcard like turndesk-staging.*.workers.dev would let
// an attacker who registers a same-named worker on THEIR account repoint a real salon's client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { apiOrigin, PROD_ORIGIN, WORKER_ORIGINS } from '../js/app/apiorigin.js';

const STAGING = 'https://turndesk-staging.musenailandspa.workers.dev';
const LOCAL = 'http://localhost:8787';

function mockEnv({ hostname = 'musenail.github.io', search = '' } = {}) {
  const store = new Map();
  global.location = { hostname, search };
  global.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  return store;
}
test.afterEach(() => { delete global.location; delete global.localStorage; });

test('defaults to production on a normal host with no override', () => {
  mockEnv({});
  assert.equal(apiOrigin(), PROD_ORIGIN);
});

test('a localhost / 127.0.0.1 page targets the local wrangler dev worker', () => {
  mockEnv({ hostname: 'localhost' }); assert.equal(apiOrigin(), LOCAL);
  mockEnv({ hostname: '127.0.0.1' }); assert.equal(apiOrigin(), LOCAL);
});

test('?api=<exact staging origin> is honored and persisted', () => {
  const store = mockEnv({ search: '?api=' + encodeURIComponent(STAGING) });
  assert.equal(apiOrigin(), STAGING);
  assert.equal(store.get('td_api_origin'), STAGING);
});

test('SECURITY: a same-named staging worker on ANOTHER account is rejected (no wildcard)', () => {
  const store = mockEnv({ search: '?api=' + encodeURIComponent('https://turndesk-staging.attacker.workers.dev') });
  assert.equal(apiOrigin(), PROD_ORIGIN, 'must NOT route to a look-alike attacker origin');
  assert.equal(store.has('td_api_origin'), false, 'a disallowed override is never persisted');
});

test('SECURITY: an arbitrary hostile ?api= is ignored and not persisted', () => {
  const store = mockEnv({ search: '?api=https://evil.example.com' });
  assert.equal(apiOrigin(), PROD_ORIGIN);
  assert.equal(store.has('td_api_origin'), false);
});

test('a persisted ALLOWED override is used; a persisted DISALLOWED value is ignored', () => {
  let store = mockEnv({}); store.set('td_api_origin', STAGING);
  assert.equal(apiOrigin(), STAGING);
  store = mockEnv({}); store.set('td_api_origin', 'https://evil.example.com');
  assert.equal(apiOrigin(), PROD_ORIGIN);
});

test('WORKER_ORIGINS covers prod + staging + localhost (bearer-token fetch wrapper allow-list)', () => {
  assert.ok(WORKER_ORIGINS.includes(PROD_ORIGIN));
  assert.ok(WORKER_ORIGINS.includes(STAGING));
  assert.ok(WORKER_ORIGINS.includes(LOCAL));
});
