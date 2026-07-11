// H2 (stress-test 2026-07-11): listBackups() did ONE non-paginated R2 list(). R2 caps a page
// at 1000 objects (ascending key order = chronological), so once a salon has >1000 snapshots
// the page holds the OLDEST 1000 and OMITS the newest — and restoreFromBackup(null) then
// "restores latest" from a months-old snapshot. Fix: page the cursor so the newest is always found.
// See cloudflare/worker.js listBackups.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnDeskDO } from '../cloudflare/worker.js';

function makeStorage() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? m.get(k) : undefined; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async deleteAll() { m.clear(); },
    async list({ prefix } = {}) { const r = new Map(); for (const [k, v] of m) if (!prefix || k.startsWith(prefix)) r.set(k, v); return r; },
    async getAlarm() { return null; }, async setAlarm() {},
  };
}

// R2-like bucket: list() returns at most 1000 objects/page in ascending key order,
// with { truncated, cursor } to fetch the rest — exactly the paging the bug ignored.
function makePagingBucket(objs) {
  const sorted = [...objs].sort((a, b) => (a.key < b.key ? -1 : 1));
  return {
    async list({ prefix, cursor } = {}) {
      const filtered = sorted.filter(o => !prefix || o.key.startsWith(prefix));
      const start = cursor ? Number(cursor) : 0;
      const page = filtered.slice(start, start + 1000);
      const next = start + page.length;
      const truncated = next < filtered.length;
      return { objects: page.map(o => ({ key: o.key, uploaded: o.uploaded, size: 10 })), truncated, cursor: truncated ? String(next) : undefined };
    },
    async get() { return null; }, async put() {}, async delete() {},
  };
}

test('listBackups returns the NEWEST snapshot first even past one 1000-object R2 page', async () => {
  const storage = makeStorage();
  await storage.put('meta:slug', 'acme');
  const objs = [];
  for (let i = 0; i < 1500; i++) {
    const t = new Date(Date.UTC(2026, 0, 1) + i * 3600 * 1000);
    objs.push({ key: `backups/acme/state-${t.toISOString().replace(/[:.]/g, '-')}.json`, uploaded: t.toISOString() });
  }
  const newest = objs[objs.length - 1].key;
  const doInst = new TurnDeskDO({ storage }, { PHOTOS_BUCKET: makePagingBucket(objs) });

  const { backups, count } = await doInst.listBackups();
  assert.equal(count, 1500, 'all snapshots are counted across pages (not just the first 1000)');
  assert.equal(backups[0].key, newest, 'the newest snapshot must be first — restore-latest must not pick a stale one');
});
