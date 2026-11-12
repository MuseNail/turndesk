// Pure helpers behind the book-next-appointment (rebook) prompt.
import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitName, shouldOfferRebook } from '../js/app/rebook-util.js';

// ── splitName: first token / rest, trimmed, collapse-safe ────────────────────
test('splitName: first + last', () => {
  assert.deepEqual(splitName('Maya Rodriguez'), { first: 'Maya', last: 'Rodriguez' });
});
test('splitName: single name → empty last', () => {
  assert.deepEqual(splitName('Cher'), { first: 'Cher', last: '' });
});
test('splitName: empty / nullish → both empty', () => {
  assert.deepEqual(splitName(''), { first: '', last: '' });
  assert.deepEqual(splitName(null), { first: '', last: '' });
  assert.deepEqual(splitName(undefined), { first: '', last: '' });
});
test('splitName: extra/leading/trailing whitespace collapses; rest kept as last', () => {
  assert.deepEqual(splitName('  Ana   Maria Lopez '), { first: 'Ana', last: 'Maria Lopez' });
});

// ── shouldOfferRebook: setting + service + name + quickSale gates ─────────────
const svc = extra => ({ name: 'Maya Rodriguez', phone: '7605550188', services: ['svc_gel'], ...extra });

test('shouldOfferRebook: ON by default (key absent) for a named service ticket', () => {
  assert.equal(shouldOfferRebook(svc(), {}), true);
});
test('shouldOfferRebook: OFF when rebook_prompt === false', () => {
  assert.equal(shouldOfferRebook(svc(), { rebook_prompt: false }), false);
});
test('shouldOfferRebook: any non-false value (e.g. true) still offers', () => {
  assert.equal(shouldOfferRebook(svc(), { rebook_prompt: true }), true);
});
test('shouldOfferRebook: false for a Quick Sale', () => {
  assert.equal(shouldOfferRebook(svc({ quickSale: true }), {}), false);
});
test('shouldOfferRebook: false when there is no service (gift-card / retail)', () => {
  assert.equal(shouldOfferRebook(svc({ services: [] }), {}), false);
  assert.equal(shouldOfferRebook({ name: 'Buyer', phone: '1', services: undefined }, {}), false);
});
test('shouldOfferRebook: false for empty / whitespace-only name', () => {
  assert.equal(shouldOfferRebook(svc({ name: '' }), {}), false);
  assert.equal(shouldOfferRebook(svc({ name: '   ' }), {}), false);
});
test('shouldOfferRebook: false for a null/undefined entry', () => {
  assert.equal(shouldOfferRebook(null, {}), false);
  assert.equal(shouldOfferRebook(undefined, {}), false);
});
test('shouldOfferRebook: tolerates a null config', () => {
  assert.equal(shouldOfferRebook(svc(), null), true);
});
