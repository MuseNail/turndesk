import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPhone, dedupByLabel, localDateStr, byName, formatElapsed, rolloverAction } from '../js/app/utils.js';

const phone = (v) => { const o = { value: v }; formatPhone(o); return o.value; };

test('formatPhone formats a 10-digit number', () => {
  assert.equal(phone('5551234567'), '(555) 123-4567');
});

test('formatPhone strips a leading US country code (+1 / 11 digits)', () => {
  assert.equal(phone('15551234567'), '(555) 123-4567');
});

test('formatPhone handles partial input', () => {
  assert.equal(phone(''), '');
  assert.equal(phone('12'), '(12');
  assert.equal(phone('1234'), '(123) 4');       // 4 digits, no country-code strip (only 11-digit leading-1 strips)
  assert.equal(phone('555123'), '(555) 123');
});

test('dedupByLabel drops case-insensitive duplicates and blank labels', () => {
  assert.deepEqual(dedupByLabel([{ label: 'Mani' }, { label: 'mani' }, { label: 'Pedi' }]).map(x => x.label), ['Mani', 'Pedi']);
  assert.deepEqual(dedupByLabel([{ label: '' }, { label: '   ' }, { label: 'X' }]).map(x => x.label), ['X']);
  assert.deepEqual(dedupByLabel(null), []);
  assert.deepEqual(dedupByLabel(undefined), []);
});

test('localDateStr renders local Y-M-D (zero-padded), not UTC', () => {
  assert.equal(localDateStr(new Date(2026, 0, 5)), '2026-01-05');   // Jan 5
  assert.equal(localDateStr(new Date(2026, 11, 31)), '2026-12-31'); // Dec 31
});

test('byName sorts alphabetically, case-insensitive', () => {
  assert.ok(byName({ name: 'amy' }, { name: 'Bob' }) < 0);
  assert.ok(byName({ name: 'Bob' }, { name: 'amy' }) > 0);
  assert.equal(byName({}, {}), 0);
});

test('formatElapsed buckets minutes/hours from a check-in time', () => {
  assert.equal(formatElapsed(new Date(Date.now() - 30 * 1000)), 'just now');     // < 1 min
  assert.equal(formatElapsed(new Date(Date.now() - 5 * 60000)), '5m');
  assert.equal(formatElapsed(new Date(Date.now() - 75 * 60000)), '1h 15m');
});

test('rolloverAction: shared marker gates the day rollover globally', () => {
  // absent marker → seed only (never clears a live roster on first run / upgrade)
  assert.equal(rolloverAction('', '2026-06-01'), 'seed');
  assert.equal(rolloverAction(null, '2026-06-01'), 'seed');
  // a genuinely new day → roll over once
  assert.equal(rolloverAction('2026-05-31', '2026-06-01'), 'rollover');
  // already rolled over today → SKIP (this is the fix: a device opened mid-day must NOT re-clear
  // the roster the front desk already set up)
  assert.equal(rolloverAction('2026-06-01', '2026-06-01'), 'skip');
});
