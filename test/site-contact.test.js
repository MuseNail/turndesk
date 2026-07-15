// Marketing-site contact form (site/assets/contact.js) — the standalone site's own module,
// deliberately NOT the app's apiorigin.js: the site shares the github.io origin with the live
// app, so the site override must be (a) an EXACT-match allow-list like the app's, and
// (b) NEVER persisted — writing td_api_origin (or any key) from a marketing page would
// silently repoint the real app / future leads to staging.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROD_ORIGIN, STAGING_ORIGIN, resolveApiOrigin, validateContact } from '../site/assets/contact.js';

const STAGING = 'https://turndesk-staging.musenailandspa.workers.dev';
const LOCAL = 'http://localhost:8787';

// ── resolveApiOrigin(search): pure, exact-match, non-persistent ───────────────
test('no override → production origin', () => {
  assert.equal(resolveApiOrigin(''), PROD_ORIGIN);
  assert.equal(resolveApiOrigin('?utm_source=x'), PROD_ORIGIN);
});

test('?api=<exact staging origin> is honored (encoded or plain)', () => {
  assert.equal(STAGING_ORIGIN, STAGING);
  assert.equal(resolveApiOrigin('?api=' + encodeURIComponent(STAGING)), STAGING);
  assert.equal(resolveApiOrigin('?api=' + STAGING), STAGING);
});

test('?api=localhost wrangler-dev origin is honored', () => {
  assert.equal(resolveApiOrigin('?api=' + encodeURIComponent(LOCAL)), LOCAL);
});

test('SECURITY: an arbitrary hostile ?api= is ignored → production', () => {
  assert.equal(resolveApiOrigin('?api=https://evil.example.com'), PROD_ORIGIN);
});

test('SECURITY: a look-alike staging worker on ANOTHER account is rejected (no wildcard)', () => {
  assert.equal(resolveApiOrigin('?api=' + encodeURIComponent('https://turndesk-staging.attacker.workers.dev')), PROD_ORIGIN);
});

test('SECURITY: resolveApiOrigin never touches localStorage (non-persistent by design)', () => {
  global.localStorage = { getItem() { throw new Error('read'); }, setItem() { throw new Error('write'); }, removeItem() { throw new Error('remove'); } };
  try {
    assert.equal(resolveApiOrigin('?api=' + encodeURIComponent(STAGING)), STAGING);
    assert.equal(resolveApiOrigin('?api=https://evil.example.com'), PROD_ORIGIN);
  } finally { delete global.localStorage; }
});

// ── validateContact: mirrors cloudflare/demo-util.js's limits + messages ──────
const FULL = { name: 'Mia Tran', email: 'mia@salon.com', phone: '(909) 555-1212', lookingFor: 'Walk-in rotation for 6 techs' };

test('a complete request validates, with trimmed values', () => {
  const r = validateContact({ name: '  Mia Tran ', email: ' MIA@salon.com ', phone: ' (909) 555-1212 ', lookingFor: ' rotation ' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { name: 'Mia Tran', email: 'mia@salon.com', phone: '(909) 555-1212', lookingFor: 'rotation' });
});

test('phone is optional', () => {
  assert.equal(validateContact({ ...FULL, phone: '' }).ok, true);
});

test('missing name is rejected', () => {
  const r = validateContact({ ...FULL, name: '  ' });
  assert.equal(r.ok, false);
  assert.match(r.error, /name/i);
});

test('missing or malformed email is rejected', () => {
  assert.equal(validateContact({ ...FULL, email: '' }).ok, false);
  assert.equal(validateContact({ ...FULL, email: 'not-an-email' }).ok, false);
  assert.equal(validateContact({ ...FULL, email: 'a@b' }).ok, false, 'no TLD dot');
  assert.match(validateContact({ ...FULL, email: 'x' }).error, /email/i);
});

test('missing lookingFor is rejected', () => {
  const r = validateContact({ ...FULL, lookingFor: ' ' });
  assert.equal(r.ok, false);
  assert.match(r.error, /looking for/i);
});

test('server limits are mirrored: name ≤60, email ≤120, phone ≤40, lookingFor ≤500', () => {
  assert.equal(validateContact({ ...FULL, name: 'x'.repeat(61) }).ok, false);
  assert.equal(validateContact({ ...FULL, email: 'a'.repeat(115) + '@b.com' }).ok, false);
  assert.equal(validateContact({ ...FULL, phone: '1'.repeat(41) }).ok, false);
  assert.equal(validateContact({ ...FULL, lookingFor: 'x'.repeat(501) }).ok, false);
  assert.equal(validateContact({ ...FULL, name: 'x'.repeat(60), phone: '1'.repeat(40), lookingFor: 'x'.repeat(500) }).ok, true);
});

test('missing fields object does not throw', () => {
  assert.equal(validateContact({}).ok, false);
  assert.equal(validateContact(undefined).ok, false);
});
