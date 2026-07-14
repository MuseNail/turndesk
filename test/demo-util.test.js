import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDemoRequest } from '../cloudflare/demo-util.js';

// Mirrors test/signup-util.test.js — the demo-request lead form reuses the same
// hardened validation shape as the real signup pipeline (name + email + optional
// phone + a required free-text "what are you looking for").

test('validateDemoRequest accepts a good request', () => {
  const r = validateDemoRequest({
    name: ' Mia ', email: 'MIA@Lush.com', phone: '(909) 555-1212',
    lookingFor: 'Want to see the turns board on a busy Saturday.',
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.name, 'Mia');
  assert.equal(r.value.email, 'mia@lush.com');
  assert.equal(r.value.phone, '(909) 555-1212');
  assert.equal(r.value.lookingFor, 'Want to see the turns board on a busy Saturday.');
});

test('validateDemoRequest accepts a request with no phone (optional)', () => {
  const r = validateDemoRequest({ name: 'Mia', email: 'a@b.co', lookingFor: 'A demo please' });
  assert.equal(r.ok, true);
  assert.equal(r.value.phone, '');
});

test('validateDemoRequest rejects bad input', () => {
  assert.equal(validateDemoRequest({ name: '', email: 'a@b.co', lookingFor: 'hi' }).ok, false);
  assert.equal(validateDemoRequest({ name: 'A', email: 'nope', lookingFor: 'hi' }).ok, false);
  assert.equal(validateDemoRequest({ name: 'A', email: 'a@b.co', lookingFor: '' }).ok, false);
  assert.equal(validateDemoRequest({ name: 'x'.repeat(61), email: 'a@b.co', lookingFor: 'hi' }).ok, false);
  assert.equal(validateDemoRequest({ name: 'A', email: 'a@b.co', lookingFor: 'x'.repeat(501) }).ok, false);
  assert.equal(validateDemoRequest({ name: 'A', email: 'a@b.co', phone: 'x'.repeat(41), lookingFor: 'hi' }).ok, false);
});
