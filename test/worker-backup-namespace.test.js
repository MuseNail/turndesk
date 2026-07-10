// Backups are namespaced per salon so a shared R2 bucket can't cross-wire tenants.
// The DO learns its slug from the request and persists it (meta:slug), so the
// timer-driven alarm() can read it on a cold start. See worker.js TurnDeskDO.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnDeskDO } from '../cloudflare/worker.js';

function makeStorage() {
  const m = new Map();
  return {
    _m: m,
    async get(k) { return m.has(k) ? m.get(k) : undefined; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { if (Array.isArray(k)) k.forEach(x => m.delete(x)); else m.delete(k); },
    async deleteAll() { m.clear(); },
    async list({ prefix } = {}) {
      const r = new Map();
      for (const [k, v] of m) if (!prefix || k.startsWith(prefix)) r.set(k, v);
      return r;
    },
    async getAlarm() { return null; },
    async setAlarm() {},
  };
}

// Bucket mock: each put stamps a strictly-increasing `uploaded` so "newest" is
// deterministic; supports delete(key|keys) for the prune test.
function makeBucket() {
  const store = new Map(); let seq = 0;
  return {
    _store: store,
    async put(k, body) { store.set(k, { body, uploaded: new Date(2026, 0, 1, 0, 0, ++seq).toISOString() }); },
    async get(k) { return store.has(k) ? { text: async () => store.get(k).body } : null; },
    async delete(k) { if (Array.isArray(k)) k.forEach(x => store.delete(x)); else store.delete(k); },
    async list({ prefix } = {}) {
      return { objects: [...store.entries()].filter(([k]) => !prefix || k.startsWith(prefix)).map(([k, v]) => ({ key: k, uploaded: v.uploaded, size: v.body.length })) };
    },
  };
}

test('DO learns + persists its slug from the request (?salon= and X-Salon)', async () => {
  const s1 = makeStorage();
  const do1 = new TurnDeskDO({ storage: s1 }, { PHOTOS_BUCKET: makeBucket() });
  await do1.fetch(new Request('https://do/state/snapshot?salon=lush'));
  assert.equal(await s1.get('meta:slug'), 'lush', 'query-param salon must be persisted');

  const s2 = makeStorage();
  const do2 = new TurnDeskDO({ storage: s2 }, { PHOTOS_BUCKET: makeBucket() });
  await do2.fetch(new Request('https://do/state/snapshot', { headers: { 'X-Salon': 'glam' } }));
  assert.equal(await s2.get('meta:slug'), 'glam', 'X-Salon header must be persisted');
});

test('backups are written under backups/<slug>/', async () => {
  const bucket = makeBucket();
  const s1 = makeStorage(); await s1.put('meta:slug', 'lush');
  const lush = new TurnDeskDO({ storage: s1 }, { PHOTOS_BUCKET: bucket });
  const r1 = await lush.backupNow();
  assert.ok(r1.key.startsWith('backups/lush/state-'), `lush key was ${r1.key}`);

  const s2 = makeStorage(); await s2.put('meta:slug', 'glam');
  const glam = new TurnDeskDO({ storage: s2 }, { PHOTOS_BUCKET: bucket });
  const r2 = await glam.backupNow();
  assert.ok(r2.key.startsWith('backups/glam/state-'), `glam key was ${r2.key}`);
});

test('listBackups is scoped to this salon only', async () => {
  const bucket = makeBucket();
  await bucket.put('backups/lush/state-a.json', '{}');
  await bucket.put('backups/glam/state-b.json', '{}');
  const s1 = makeStorage(); await s1.put('meta:slug', 'lush');
  const lush = new TurnDeskDO({ storage: s1 }, { PHOTOS_BUCKET: bucket });
  const { backups, count } = await lush.listBackups();
  assert.equal(count, 1);
  assert.ok(backups.every(b => b.key.startsWith('backups/lush/')), 'must not list other salons');
});

test('restore(null) loads THIS salon, never a newer other-salon backup', async () => {
  const bucket = makeBucket();
  // lush's backup written FIRST, glam's written SECOND (globally newest).
  const lushSnap = { state: { config: {}, queue: [], records: [{ id: 'l1' }], giftcards: [], customers: [], deletions: [], customerDeletions: [], audit: [], appointments: [], apptDeletions: [] }, seq: 3 };
  const glamSnap = { state: { config: {}, queue: [], records: [{ id: 'g1' }], giftcards: [], customers: [], deletions: [], customerDeletions: [], audit: [], appointments: [], apptDeletions: [] }, seq: 9 };
  await bucket.put('backups/lush/state-2026-07-09T19-00-00-000Z.json', JSON.stringify(lushSnap));
  await bucket.put('backups/glam/state-2026-07-09T20-00-00-000Z.json', JSON.stringify(glamSnap));

  const storage = makeStorage(); await storage.put('meta:slug', 'lush');
  const lush = new TurnDeskDO({ storage }, { PHOTOS_BUCKET: bucket });
  const res = await lush.restoreFromBackup();   // no key → newest of THIS salon
  assert.equal(res.restored, true);
  assert.ok(await storage.get('record:l1'), 'lush data must be restored');
  assert.equal(await storage.get('record:g1'), undefined, 'glam data must NOT leak in');
  assert.equal(await storage.get('meta:slug'), 'lush', 'meta:slug survives deleteAll');
});

test('slug-unknown falls back to the legacy un-prefixed key (no double slash)', async () => {
  const bucket = makeBucket();
  const storage = makeStorage();   // no meta:slug
  const doInst = new TurnDeskDO({ storage }, { PHOTOS_BUCKET: bucket });
  const r = await doInst.backupNow();
  assert.ok(r.key.startsWith('backups/state-'), `expected legacy key, got ${r.key}`);
  assert.ok(!r.key.includes('backups//'), 'must not produce a double slash');
});
