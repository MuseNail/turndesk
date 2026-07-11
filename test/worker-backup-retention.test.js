// Item 3 (stress-test 2026-07-11 LOW): the DO alarm() wrote 4 R2 snapshots/salon/day forever
// with no rotation, so backups grew unbounded. Add retention: keep the newest KEEP_BACKUPS per
// salon, delete only the older surplus (never the newest N, never outside the salon's prefix).
// See cloudflare/worker.js TurnDeskDO.pruneOldBackups (called from alarm()).
import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnDeskDO } from '../cloudflare/worker.js';

function makeStorage() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? m.get(k) : undefined; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { if (Array.isArray(k)) k.forEach(x => m.delete(x)); else m.delete(k); },
    async deleteAll() { m.clear(); },
    async list({ prefix } = {}) { const r = new Map(); for (const [k, v] of m) if (!prefix || k.startsWith(prefix)) r.set(k, v); return r; },
    async getAlarm() { return null; }, async setAlarm() {},
  };
}
// R2-like bucket with distinct, monotonic `uploaded` per put (so newest-first ordering is
// deterministic) + a delete() so retention can prune.
function makeBucket() {
  const store = new Map();
  let seq = 0;
  return {
    _store: store,
    async put(k, body) { store.set(k, { body, uploaded: new Date(Date.UTC(2020, 0, 1) + (seq++) * 1000).toISOString() }); },
    async get(k) { const v = store.get(k); return v ? { text: async () => v.body } : null; },
    async delete(k) { store.delete(k); },
    async list({ prefix } = {}) { return { objects: [...store.entries()].filter(([k]) => !prefix || k.startsWith(prefix)).map(([k, v]) => ({ key: k, uploaded: v.uploaded, size: (v.body || '').length })) }; },
  };
}

test('pruneOldBackups keeps the newest KEEP_BACKUPS and deletes older snapshots', async () => {
  const storage = makeStorage(), bucket = makeBucket();
  const doInst = new TurnDeskDO({ storage }, { PHOTOS_BUCKET: bucket });
  doInst.KEEP_BACKUPS = 5;
  await storage.put('meta:slug', 'acme');
  const keys = [];
  for (let i = 0; i < 8; i++) { const k = `backups/acme/state-${i}.json`; keys.push(k); await bucket.put(k, JSON.stringify({ state: {}, seq: i })); }

  const res = await doInst.pruneOldBackups();
  assert.equal(res.pruned, 3, 'deletes the 3 oldest beyond the newest 5');
  assert.ok(await bucket.get(keys[7]), 'the newest snapshot is kept');
  assert.equal(await bucket.get(keys[0]), null, 'the oldest snapshot is deleted');
  assert.equal((await doInst.listBackups()).count, 5, 'exactly KEEP_BACKUPS remain');
});

test('pruneOldBackups is a no-op at or below the keep-window', async () => {
  const storage = makeStorage(), bucket = makeBucket();
  const doInst = new TurnDeskDO({ storage }, { PHOTOS_BUCKET: bucket });
  doInst.KEEP_BACKUPS = 5;
  await storage.put('meta:slug', 'acme');
  for (let i = 0; i < 3; i++) await bucket.put(`backups/acme/state-${i}.json`, '{}');
  const res = await doInst.pruneOldBackups();
  assert.equal(res.pruned, 0, 'nothing deleted below the window');
  assert.equal((await doInst.listBackups()).count, 3);
});

test('pruneOldBackups only deletes within the salon\'s own prefix', async () => {
  const storage = makeStorage(), bucket = makeBucket();
  const doInst = new TurnDeskDO({ storage }, { PHOTOS_BUCKET: bucket });
  doInst.KEEP_BACKUPS = 1;
  await storage.put('meta:slug', 'acme');
  for (let i = 0; i < 3; i++) await bucket.put(`backups/acme/state-${i}.json`, '{}');
  await bucket.put('backups/other/state-0.json', '{}');   // a different salon's backup
  await doInst.pruneOldBackups();
  assert.ok(await bucket.get('backups/other/state-0.json'), 'another salon\'s backups are never touched');
});
