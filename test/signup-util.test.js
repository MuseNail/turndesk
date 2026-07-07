import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, validateSignupRequest } from '../cloudflare/signup-util.js';

test('slugify basics', () => {
  assert.equal(slugify('Lush Nails & Spa'), 'lush-nails-spa');
  assert.equal(slugify('  GlamX  Nails!! '), 'glamx-nails');
  assert.equal(slugify('AB'), 'salon');              // too short -> fallback
  assert.equal(slugify(''), 'salon');
  assert.match(slugify('x'.repeat(80)), /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/); // clamped, valid
  assert.equal(slugify('café déjà'), 'cafe-deja');   // accents folded
});

test('validateSignupRequest accepts a good request', () => {
  const r = validateSignupRequest({ business: ' Lush Nails ', ownerName: 'Mia', email: 'MIA@Lush.com', password: 'secret1', phone: '(909) 555-1212', note: 'hi' });
  assert.equal(r.ok, true);
  assert.equal(r.value.business, 'Lush Nails');
  assert.equal(r.value.email, 'mia@lush.com');
});

test('validateSignupRequest rejects bad input', () => {
  assert.equal(validateSignupRequest({ business: '', ownerName: 'A', email: 'a@b.co', password: 'secret1' }).ok, false);
  assert.equal(validateSignupRequest({ business: 'B', ownerName: '', email: 'a@b.co', password: 'secret1' }).ok, false);
  assert.equal(validateSignupRequest({ business: 'B', ownerName: 'A', email: 'nope', password: 'secret1' }).ok, false);
  assert.equal(validateSignupRequest({ business: 'B', ownerName: 'A', email: 'a@b.co', password: '123' }).ok, false);
  assert.equal(validateSignupRequest({ business: 'B', ownerName: 'A', email: 'a@b.co', password: 'secret1', note: 'x'.repeat(600) }).ok, false);
});
