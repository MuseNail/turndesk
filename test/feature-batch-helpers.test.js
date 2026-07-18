// Pure helpers behind the 2026-07 feature batch: staff PII normalization + list
// partition (Feature 1/2) and the stable per-customer calendar color (Feature 3).
// DOM-heavy render paths are verified in the browser preview; these lock the logic.
import './setup-globals.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSsn4, maskSsn, partitionStaff, customerColor } from '../js/app/utils.js';
import { CUSTOMER_COLORS } from '../js/app/config.js';

// ── SSN last-4 (owner chose store-last-4-only) ───────────────────────────────
test('normalizeSsn4 keeps only the last four digits', () => {
  assert.equal(normalizeSsn4('123-45-6789'), '6789');
  assert.equal(normalizeSsn4('6789'), '6789');
  assert.equal(normalizeSsn4('abc1234def5678'), '5678');
  assert.equal(normalizeSsn4('12'), '12', 'fewer than 4 digits → keep what there is');
  assert.equal(normalizeSsn4(''), '');
  assert.equal(normalizeSsn4(null), '');
  assert.equal(normalizeSsn4(undefined), '');
});

test('maskSsn renders last-4 as a masked SSN, blank when absent', () => {
  assert.equal(maskSsn('6789'), '•••-••-6789');
  assert.equal(maskSsn(''), '');
  assert.equal(maskSsn(null), '');
});

// ── Staff list partition (active always shown; inactive collapsible) ─────────
test('partitionStaff splits by inactive-id membership, preserving order', () => {
  const staff = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const { active, inactive } = partitionStaff(staff, ['b']);
  assert.deepEqual(active.map(s => s.id), ['a', 'c']);
  assert.deepEqual(inactive.map(s => s.id), ['b']);
});

test('partitionStaff tolerates a missing/empty inactive list', () => {
  const staff = [{ id: 'a' }, { id: 'b' }];
  assert.equal(partitionStaff(staff, []).inactive.length, 0);
  assert.equal(partitionStaff(staff, undefined).active.length, 2);
  assert.equal(partitionStaff(undefined, []).active.length, 0);
});

// ── Stable per-customer calendar color ───────────────────────────────────────
const GRAY = '#9ca3af';
test('customerColor is deterministic — the same key always maps to the same color', () => {
  assert.equal(customerColor('5551234567'), customerColor('5551234567'));
  assert.ok(CUSTOMER_COLORS.includes(customerColor('5551234567')), 'returns a palette color for a real key');
});

test('customerColor returns neutral gray for empty / placeholder keys (no shared fake customer)', () => {
  for (const k of ['', '   ', null, undefined, 'guest', 'Guest', 'GUEST', ' guest ']) {
    assert.equal(customerColor(k), GRAY, JSON.stringify(k) + ' → gray');
  }
  assert.ok(!CUSTOMER_COLORS.includes(GRAY), 'gray is NOT one of the real customer colors');
});

test('customerColor spreads distinct keys across the palette (not all one color)', () => {
  const keys = ['5550001111', '5552223333', '5554445555', '5556667777', '5558889999', 'maria lopez'];
  const colors = new Set(keys.map(customerColor));
  assert.ok(colors.size >= 3, 'several distinct keys yield several distinct colors');
});

test('CUSTOMER_COLORS is a real palette of distinct hex colors', () => {
  assert.ok(Array.isArray(CUSTOMER_COLORS) && CUSTOMER_COLORS.length >= 12);
  assert.equal(new Set(CUSTOMER_COLORS).size, CUSTOMER_COLORS.length, 'no duplicate hues');
  for (const c of CUSTOMER_COLORS) assert.match(c, /^#[0-9a-fA-F]{6}$/);
});
