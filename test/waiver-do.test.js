// Signed waivers are LEGAL records. They live in their own DO key `waiver:<id>`, are kept OUT of
// buildSnapshot + broadcast (PII), and MUST survive both restore and factory reset — they have no
// snapshot copy to recover from, so any wipe path that drops them is permanent, unrecoverable loss.
// A waiver R2 dump must never be offered as, or restored from, a state backup (it's a JSON array →
// restoring it would rebuild the salon from empty). These are the load-bearing assertions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnDeskDO, isWaiverDump } from '../cloudflare/worker.js';

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
    getWebSockets() { return []; },   // _broadcast reads this; no connected clients in the test
  };
}
function makeBucket() {
  const store = new Map();
  return {
    _store: store,
    async put(k, body) { store.set(k, body); },
    async get(k) { return store.has(k) ? { text: async () => store.get(k) } : null; },
    async delete(k) { if (Array.isArray(k)) k.forEach(x => store.delete(x)); else store.delete(k); },
    async list({ prefix } = {}) {
      return { objects: [...store.keys()].filter(k => !prefix || k.startsWith(prefix)).map(k => ({ key: k, uploaded: new Date().toISOString(), size: store.get(k).length })) };
    },
  };
}
const WV = id => ({ id, signerFullName: 'Sarah Miller', signerDisplay: 'Sarah M.', waiverVersion: '02', text: 'FULL TEXT', acceptedAt: Date.now(), method: 'self-kiosk' });

test('waiver.save persists to waiver:<id>, is idempotent by mutationId, and is NOT in the snapshot', async () => {
  const storage = makeStorage();
  const doInst = new TurnDeskDO({ storage }, { PHOTOS_BUCKET: makeBucket() });
  const res = await doInst.applyMutation({ op: 'waiver.save', payload: { waiver: WV('wv-1') }, mutationId: 'm1' }, null);
  assert.equal(res.applied, true);
  assert.ok(await storage.get('waiver:wv-1'), 'waiver persisted to its own key');
  // idempotent replay → deduped, no duplicate row
  const res2 = await doInst.applyMutation({ op: 'waiver.save', payload: { waiver: WV('wv-1') }, mutationId: 'm1' }, null);
  assert.equal(res2.dedup, true);
  assert.equal([...storage._m.keys()].filter(k => k.startsWith('waiver:')).length, 1);
  // never in the snapshot (PII must not ride the broadcast/snapshot channel)
  const snap = await doInst.buildSnapshot();
  assert.equal(snap.state.waivers, undefined, 'waivers must never appear in buildSnapshot');
  // a waiver with no id is rejected
  assert.ok((await doInst.applyMutation({ op: 'waiver.save', payload: { waiver: {} }, mutationId: 'm2' }, null)).error);
});

test('signed waivers SURVIVE restoreFromBackup (no snapshot copy — deleteAll must not drop them)', async () => {
  const storage = makeStorage();
  const bucket = makeBucket();
  const doInst = new TurnDeskDO({ storage }, { PHOTOS_BUCKET: bucket });
  await storage.put('meta:slug', 'demo');
  await storage.put('config:business_name', 'The Salon');
  await storage.put('waiver:wv-1', WV('wv-1'));
  const snap = await doInst.buildSnapshot();
  await bucket.put('backups/demo/state-x.json', JSON.stringify(snap));
  const res = await doInst.restoreFromBackup('backups/demo/state-x.json');
  assert.equal(res.restored, true);
  assert.ok(await storage.get('waiver:wv-1'), 'signed waiver must survive a restore');
});

test('signed waivers SURVIVE factoryReset — and so do owner login / gcal token / push subs', async () => {
  const storage = makeStorage();
  const doInst = new TurnDeskDO({ storage }, { PHOTOS_BUCKET: makeBucket() });
  await storage.put('meta:slug', 'demo');
  await storage.put('config:business_name', 'The Salon');
  await storage.put('waiver:wv-1', WV('wv-1'));
  await storage.put('owner:owner@x', { email: 'owner@x', role: 'owner', hash: 'h' });
  await storage.put('gcal:blob', { refresh: 'TOK' });
  await storage.put('push:staff-1:abc', { endpoint: 'https://push/1' });
  const res = await doInst.factoryReset();
  assert.equal(res.reset, true);
  assert.ok(await storage.get('waiver:wv-1'), 'signed waiver must survive a factory reset');
  assert.ok(await storage.get('owner:owner@x'), 'owner login must survive (no lockout)');
  assert.deepEqual(await storage.get('gcal:blob'), { refresh: 'TOK' }, 'Google token must survive');
  assert.ok(await storage.get('push:staff-1:abc'), 'push sub must survive');
  assert.equal(await storage.get('config:business_name'), undefined, 'ordinary state IS wiped by a reset');
});

test('restoreFromBackup REFUSES a waiver-dump key (would wipe the salon from an array payload)', async () => {
  const storage = makeStorage();
  const bucket = makeBucket();
  const doInst = new TurnDeskDO({ storage }, { PHOTOS_BUCKET: bucket });
  await storage.put('meta:slug', 'demo');
  await storage.put('config:business_name', 'The Salon');
  await bucket.put('backups/demo/waivers-x.json', JSON.stringify([WV('wv-1'), WV('wv-2')]));   // a dump = JSON array
  const res = await doInst.restoreFromBackup('backups/demo/waivers-x.json');
  assert.ok(res.error, 'a waiver dump must be refused as a restore source');
  assert.equal(await storage.get('config:business_name'), 'The Salon', 'salon state untouched by the refused restore');
});

test('restoreFromBackup shape-guard rejects a non-state (array) payload', async () => {
  const storage = makeStorage();
  const bucket = makeBucket();
  const doInst = new TurnDeskDO({ storage }, { PHOTOS_BUCKET: bucket });
  await storage.put('meta:slug', 'demo');
  await storage.put('config:business_name', 'The Salon');
  await bucket.put('backups/demo/state-bad.json', JSON.stringify([1, 2, 3]));   // wrong shape (no .state object)
  const res = await doInst.restoreFromBackup('backups/demo/state-bad.json');
  assert.ok(res.error, 'a payload with no .state object must be refused');
  assert.equal(await storage.get('config:business_name'), 'The Salon', 'salon state untouched');
});

test('isWaiverDump identifies waiver dumps, not state snapshots', () => {
  assert.equal(isWaiverDump('backups/demo/waivers-2026-01-01.json'), true);
  assert.equal(isWaiverDump('backups/demo/state-2026-01-01.json'), false);
  assert.equal(isWaiverDump('backups/demo/safety-2026-01-01.json'), false);
  assert.equal(isWaiverDump(''), false);
});
