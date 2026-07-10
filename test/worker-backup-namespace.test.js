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
