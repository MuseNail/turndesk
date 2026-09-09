import test from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicateCheckins, DEFAULT_MIN_KEY_LEN } from '../js/app/features/dup-guard.js';

// Same normalizer as notePhoneKey (square-customers.js) — injected so the module stays pure.
const norm = p => (p || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
const KEY = '9095551234';
const now = 1_000_000_000_000;
const MIN = 30 * 60 * 1000;
const isoAgo = ms => new Date(now - ms).toISOString();

const entry = o => ({ id: o.id, name: o.name || 'X', phone: o.phone, status: o.status || 'waiting', checkinTime: o.checkinTime || isoAgo(600000), completedAt: o.completedAt, assignments: o.assignments || [], services: o.services || [] });
const run = (queue, over = {}) => findDuplicateCheckins({ phoneKey: KEY, queue, nowMs: now, paidWindowMs: MIN, normalize: norm, ...over });

test('min-key-len gate: blank / short / <10 digits never match', () => {
  const q = [entry({ id: 'a', phone: '(909) 555-1234', status: 'waiting' })];
  assert.deepEqual(run(q, { phoneKey: '' }), { open: [], recentlyPaid: [] });
  assert.deepEqual(run(q, { phoneKey: '5551234' }), { open: [], recentlyPaid: [] });   // 7 digits
  assert.equal(DEFAULT_MIN_KEY_LEN, 10);
});

test('open match: same phone, not paid, formatting-insensitive', () => {
  const q = [entry({ id: 'a', name: 'Ann', phone: '(909) 555-1234', status: 'waiting' })];
  const r = run(q);
  assert.equal(r.open.length, 1);
  assert.equal(r.open[0].id, 'a');
  assert.equal(r.recentlyPaid.length, 0);
});

test('recently-paid within window matches; outside window does not', () => {
  const inWin = entry({ id: 'p1', phone: KEY, status: 'paid', completedAt: isoAgo(5 * 60 * 1000) });
  const outWin = entry({ id: 'p2', phone: KEY, status: 'paid', completedAt: isoAgo(45 * 60 * 1000) });
  const r = run([inWin, outWin]);
  assert.equal(r.recentlyPaid.length, 1);
  assert.equal(r.recentlyPaid[0].id, 'p1');
  assert.equal(r.open.length, 0);
});

test('paid with numeric completedAt also works; done counts as paid', () => {
  const r = run([entry({ id: 'p', phone: KEY, status: 'done', completedAt: now - 60000 })]);
  assert.equal(r.recentlyPaid.length, 1);
});

test('excludeIds and deleted are skipped', () => {
  const q = [
    entry({ id: 'self', phone: KEY, status: 'waiting' }),
    entry({ id: 'del', phone: KEY, status: 'deleted' }),
    entry({ id: 'keep', phone: KEY, status: 'waiting' }),
  ];
  const r = run(q, { excludeIds: ['self'] });
  assert.deepEqual(r.open.map(m => m.id), ['keep']);
});

test('different phone / no phone never match', () => {
  const q = [entry({ id: 'a', phone: '9095559999' }), entry({ id: 'b', phone: '' }), entry({ id: 'c', phone: null })];
  const r = run(q);
  assert.deepEqual(r, { open: [], recentlyPaid: [] });
});

test('normalize is applied to scanned entries: leading-1 number still matches', () => {
  const q = [entry({ id: 'a', phone: '1-909-555-1234', status: 'waiting' })];
  assert.equal(run(q).open.length, 1);
});

test('recently-paid via statusSince fallback when completedAt is missing; carries paidAt', () => {
  const e = entry({ id: 'p', phone: KEY, status: 'paid' });
  delete e.completedAt; e.statusSince = now - 3 * 60 * 1000;   // paid 3 min ago, no completedAt
  const m = run([e]).recentlyPaid;
  assert.equal(m.length, 1);
  assert.equal(m[0].paidAt, now - 3 * 60 * 1000);
});

test('match carries name/status/techIds/services for the modal', () => {
  const q = [entry({ id: 'a', name: 'Ann Lee', phone: KEY, status: 'waiting', assignments: [{ techId: 't1' }, { techId: '' }], services: ['s1'] })];
  const m = run(q).open[0];
  assert.equal(m.name, 'Ann Lee');
  assert.deepEqual(m.techIds, ['t1']);
  assert.deepEqual(m.services, ['s1']);
});
