// Per-salon client-storage isolation (fixes the cross-salon bleed: a browser used for
// one salon showed another salon's cached data + login on its link). The state cache,
// session, outbox, and dead-letter are now keyed by salon slug; every queued write is
// stamped with its salon and a foreign-salon write is never sent. See apptoken.js
// (scopedKey + migrateLegacySalonStorage) and sync.js (isForeignWrite + dispatch stamp).
import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { scopedKey, migrateLegacySalonStorage } from '../js/app/apptoken.js';
import { isForeignWrite } from '../js/app/sync.js';

function reset() { localStorage.clear(); }

test('scopedKey suffixes the base with the current salon', () => {
  reset();
  localStorage.setItem('td_salon', 'krystal-nails-lounge');
  assert.equal(scopedKey('turndesk_state_cache'), 'turndesk_state_cache:krystal-nails-lounge');
});

test('scopedKey uses :none when no salon is set — never collides with the legacy unscoped key', () => {
  reset();
  assert.equal(scopedKey('turndesk_session'), 'turndesk_session:none');
  assert.notEqual(scopedKey('turndesk_session'), 'turndesk_session');
});

test('migration DELETES the legacy cache + session — never migrates them (that would re-bleed)', () => {
  reset();
  localStorage.setItem('td_salon', 'krystal');
  localStorage.setItem('turndesk_state_cache', JSON.stringify({ queue: [{ id: 'demo-1' }] }));
  localStorage.setItem('turndesk_session', JSON.stringify({ token: 'demo-token' }));
  migrateLegacySalonStorage();
  assert.equal(localStorage.getItem('turndesk_state_cache'), null, 'legacy cache deleted');
  assert.equal(localStorage.getItem('turndesk_session'), null, 'legacy session deleted');
  assert.equal(localStorage.getItem('turndesk_state_cache:krystal'), null, 'cache must NOT be copied to the salon key');
  assert.equal(localStorage.getItem('turndesk_session:krystal'), null, 'session must NOT be copied to the salon key');
});

test('migration PRESERVES legacy pending outbox writes into that salon Data Recovery — never auto-replays them', () => {
  reset();
  localStorage.setItem('td_salon', 'krystal');
  localStorage.setItem('turndesk_outbox', JSON.stringify([
    { type: 'mutate', op: 'record.save', payload: { record: { id: 'r1' } }, mutationId: 'm1', device: 'devA' },
  ]));
  migrateLegacySalonStorage();
  assert.equal(localStorage.getItem('turndesk_outbox'), null, 'legacy outbox cleared (never left to auto-replay)');
  const dr = JSON.parse(localStorage.getItem('turndesk_failed_ops:krystal') || '[]');
  assert.equal(dr.length, 1);
  assert.equal(dr[0].op, 'record.save');
  assert.equal(dr[0].mutationId, 'm1');
  assert.match(dr[0].error, /verify the salon/i, 'flagged as un-attributed for manual review');
});

test('migration carries the legacy dead-letter into that salon Data Recovery', () => {
  reset();
  localStorage.setItem('td_salon', 'krystal');
  localStorage.setItem('turndesk_failed_ops', JSON.stringify([{ at: 'x', error: 'old', op: 'record.save', mutationId: 'f1' }]));
  migrateLegacySalonStorage();
  assert.equal(localStorage.getItem('turndesk_failed_ops'), null);
  assert.ok(JSON.parse(localStorage.getItem('turndesk_failed_ops:krystal') || '[]').some(x => x.mutationId === 'f1'));
});

test('migration DROPS legacy audit.log ops silently — they never show as "failed" (only breadcrumbs, no recovery value)', () => {
  reset();
  localStorage.setItem('td_salon', 'krystal');
  localStorage.setItem('turndesk_outbox', JSON.stringify([
    { type: 'mutate', op: 'audit.log',  payload: { event: { id: 'a1' } }, mutationId: 'm-audit', device: 'devA' },
    { type: 'mutate', op: 'record.save', payload: { record: { id: 'r1' } }, mutationId: 'm-rec', device: 'devA' },
  ]));
  migrateLegacySalonStorage();
  const dr = JSON.parse(localStorage.getItem('turndesk_failed_ops:krystal') || '[]');
  assert.equal(dr.length, 1, 'only the record.save is quarantined — the audit.log is dropped');
  assert.equal(dr[0].op, 'record.save');
  assert.ok(!dr.some(x => x.op === 'audit.log'), 'no audit.log breadcrumb ever surfaces in Data Recovery');
});

test('migration also drops audit.log from a carried-forward legacy dead-letter', () => {
  reset();
  localStorage.setItem('td_salon', 'krystal');
  localStorage.setItem('turndesk_failed_ops', JSON.stringify([
    { at: 'x', error: 'old', op: 'audit.log',  mutationId: 'f-audit' },
    { at: 'x', error: 'old', op: 'record.save', mutationId: 'f-rec' },
  ]));
  migrateLegacySalonStorage();
  const dr = JSON.parse(localStorage.getItem('turndesk_failed_ops:krystal') || '[]');
  assert.ok(dr.some(x => x.mutationId === 'f-rec'), 'the real failed write is preserved');
  assert.ok(!dr.some(x => x.op === 'audit.log'), 'audit.log breadcrumb dropped');
});

test('migration is idempotent — a second run adds nothing', () => {
  reset();
  localStorage.setItem('td_salon', 'krystal');
  localStorage.setItem('turndesk_outbox', JSON.stringify([{ op: 'record.save', mutationId: 'm1' }]));
  migrateLegacySalonStorage();
  const after1 = localStorage.getItem('turndesk_failed_ops:krystal');
  migrateLegacySalonStorage();
  assert.equal(localStorage.getItem('turndesk_failed_ops:krystal'), after1, 'second run is a no-op');
});

test('migration DEFERS the outbox/dead-letter on a bare no-salon load — nothing lands in a bucket nobody sees', () => {
  reset();
  localStorage.setItem('turndesk_state_cache', 'x');
  localStorage.setItem('turndesk_outbox', JSON.stringify([{ op: 'record.save', mutationId: 'm1' }]));
  migrateLegacySalonStorage();   // no td_salon → salonSlug()===''
  assert.equal(localStorage.getItem('turndesk_state_cache'), null, 'cache still cleared (safe anytime)');
  assert.ok(localStorage.getItem('turndesk_outbox'), 'legacy outbox PRESERVED until a salon is known');
  assert.equal(localStorage.getItem('turndesk_failed_ops:none'), null, 'nothing quarantined into a :none bucket');
  localStorage.setItem('td_salon', 'krystal');
  migrateLegacySalonStorage();   // salon now known → deferred items migrate
  assert.equal(localStorage.getItem('turndesk_outbox'), null);
  assert.ok(JSON.parse(localStorage.getItem('turndesk_failed_ops:krystal') || '[]').length >= 1);
});

test('isForeignWrite blocks a write stamped for another salon; allows a matching or un-stamped one', () => {
  assert.equal(isForeignWrite({ salon: 'demo' }, 'krystal'), true, 'foreign salon → blocked');
  assert.equal(isForeignWrite({ salon: 'krystal' }, 'krystal'), false, 'same salon → allowed');
  assert.equal(isForeignWrite({}, 'krystal'), false, 'un-stamped item in this salon bucket → allowed');
  assert.equal(isForeignWrite(null, 'krystal'), false);
});
