// Phase 1 tiered retention (replaces the old keep-newest-120 pruneOldBackups): the
// grandfather-father-son keep-set (6h/1wk · daily/1mo · monthly/1yr · yearly/7yr) with a
// hard floor + a DR safety-snapshot exemption, GATED by BACKUP_RETENTION, per-salon
// prefix-scoped. See TurnDeskDO.pruneBackups + computeBackupKeepSet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnDeskDO, computeBackupKeepSet } from '../cloudflare/worker.js';

const DAY = 86400000;
const iso = t => new Date(t).toISOString();

function makeStorage() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? m.get(k) : undefined; }, async put(k, v) { m.set(k, v); },
    async delete(k) { if (Array.isArray(k)) k.forEach(x => m.delete(x)); else m.delete(k); }, async deleteAll() { m.clear(); },
    async list({ prefix } = {}) { const r = new Map(); for (const [k, v] of m) if (!prefix || k.startsWith(prefix)) r.set(k, v); return r; },
    async getAlarm() { return null; }, async setAlarm() {},
  };
}
function makeBucket() {
  const store = new Map();
  return {
    _store: store,
    seed(key, uploaded) { store.set(key, { body: '{}', uploaded }); },
    async put(k, body) { store.set(k, { body: String(body), uploaded: new Date().toISOString() }); },
    async get(k) { const o = store.get(k); return o ? { text: async () => o.body } : null; },
    async list({ prefix } = {}) { const keys = [...store.keys()].filter(k => !prefix || k.startsWith(prefix)); return { objects: keys.map(k => ({ key: k, uploaded: store.get(k).uploaded, size: store.get(k).body.length })), truncated: false }; },
    async delete(keys) { (Array.isArray(keys) ? keys : [keys]).forEach(k => store.delete(k)); },
  };
}
async function mkSalon(slug, env) {
  const storage = makeStorage();
  await storage.put('meta:slug', slug);
  return new TurnDeskDO({ storage }, env);
}
function seedYear(bucket, slug, now, days) {
  for (let d = 0; d < days; d++) for (const h of [0, 6, 12, 18]) { const t = now - d * DAY - h * 3600000; bucket.seed(`backups/${slug}/state-` + iso(t).replace(/[:.]/g, '-') + '.json', iso(t)); }
}

test('computeBackupKeepSet detects safety snapshots through the per-salon slug segment', () => {
  const now = Date.parse('2026-07-13T00:00:00.000Z');
  const backups = [
    { key: 'backups/acme/state-a.json', uploaded: iso(now) },
    { key: 'backups/acme/safety-b.json', uploaded: iso(now - 40 * DAY) },              // mid-history safety
    { key: 'backups/acme/state-c.json', uploaded: iso(now - 40 * DAY - 5 * 3600000) },
  ];
  const { keep } = computeBackupKeepSet(backups, now);
  assert.ok(keep.has('backups/acme/safety-b.json'), 'a per-salon safety snapshot is kept even mid-history');
});

test('pruneBackups is log-only by default (deletes nothing, reports would-prune)', async () => {
  const bucket = makeBucket(); const now = Date.now();
  const doInst = await mkSalon('acme', { PHOTOS_BUCKET: bucket });   // BACKUP_RETENTION unset
  seedYear(bucket, 'acme', now, 200);
  const before = bucket._store.size;
  const res = await doInst.pruneBackups();
  assert.equal(res.live, false, 'not live by default');
  assert.ok(res.wouldPrune > 100, 'reports a large would-prune count');
  assert.equal(bucket._store.size, before, 'log-only deletes nothing');
});

test('pruneBackups live keeps newest + safety, prunes the rest, and never touches another salon', async () => {
  const bucket = makeBucket(); const now = Date.now();
  const doInst = await mkSalon('acme', { PHOTOS_BUCKET: bucket, BACKUP_RETENTION: 'on' });
  seedYear(bucket, 'acme', now, 200);
  const safetyKey = 'backups/acme/safety-' + iso(now - 40 * DAY - 7 * 3600000).replace(/[:.]/g, '-') + '.json';
  bucket.seed(safetyKey, iso(now - 40 * DAY - 7 * 3600000));
  const newestKey = 'backups/acme/state-' + iso(now).replace(/[:.]/g, '-') + '.json';
  bucket.seed('backups/other/state-old.json', iso(now - 500 * DAY));   // a different salon's backup
  const res = await doInst.pruneBackups();
  assert.equal(res.live, true);
  assert.ok(res.pruned > 100, 'prunes a lot of old points');
  assert.ok(bucket._store.has(safetyKey), 'safety snapshot survives');
  assert.ok(bucket._store.has(newestKey), 'newest survives');
  assert.ok(bucket._store.has('backups/other/state-old.json'), "another salon's backup is never touched");
  assert.ok(bucket._store.size <= 82, 'acme reduced to ~70 (+1 other salon), got ' + bucket._store.size);
});

test('pruneBackups refuses to run on a slug-less DO (never prunes the shared backups/ root)', async () => {
  const bucket = makeBucket(); const now = Date.now();
  bucket.seed('backups/acme/state-x.json', iso(now - 500 * DAY));
  bucket.seed('backups/other/state-y.json', iso(now - 500 * DAY));
  const doInst = new TurnDeskDO({ storage: makeStorage() }, { PHOTOS_BUCKET: bucket, BACKUP_RETENTION: 'on' });   // NO meta:slug
  const res = await doInst.pruneBackups();
  assert.equal(res.skipped, 'no-slug');
  assert.equal(res.pruned, 0);
  assert.equal(bucket._store.size, 2, 'nothing deleted when the slug is unknown (cross-tenant safety)');
});
