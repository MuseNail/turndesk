// Hygiene LOWs (stress-test 2026-07-11):
//  - queue.assignmentPatch / queue.entryPatch had no stale-write guard → a stale offline
//    replay or a concurrent edit could silently revert a newer per-assignment change / note.
//  - restoreFromBackup(key) trusted a caller-supplied key with no check that it lives under
//    THIS salon's own backups/<slug>/ prefix (operator cross-tenant restore footgun).
// See cloudflare/worker.js applyMutation (queue.assignmentPatch/entryPatch) + restoreFromBackup.
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
    async list({ prefix } = {}) { const r = new Map(); for (const [k, v] of m) if (!prefix || k.startsWith(prefix)) r.set(k, v); return r; },
    async getAlarm() { return null; }, async setAlarm() {},
  };
}
function makeBucket() {
  const store = new Map();
  return {
    _store: store,
    async put(k, body) { store.set(k, body); },
    async get(k) { return store.has(k) ? { text: async () => store.get(k) } : null; },
    async list({ prefix } = {}) { return { objects: [...store.keys()].filter(k => !prefix || k.startsWith(prefix)).map(k => ({ key: k, uploaded: new Date().toISOString(), size: store.get(k).length })) }; },
  };
}

test('queue.assignmentPatch keeps a NEWER stored assignment (rejects a stale patch)', async () => {
  const s = makeStorage();
  const doInst = new TurnDeskDO({ storage: s }, {});
  await s.put('queue:e1', { id: 'e1', status: 'in_service', assignments: [{ serviceId: 's1', techId: 't1', updatedAt: 200, cost: 40 }] });
  await doInst.applyMutation({ op: 'queue.assignmentPatch', payload: { entryId: 'e1', serviceId: 's1', techId: 't1', assignment: { serviceId: 's1', techId: 't1', updatedAt: 100, cost: 10 } } }, null);
  assert.equal((await s.get('queue:e1')).assignments[0].cost, 40, 'a stale (older) assignment patch must not overwrite the newer stored one');
});

test('queue.assignmentPatch applies a NEWER patch', async () => {
  const s = makeStorage();
  const doInst = new TurnDeskDO({ storage: s }, {});
  await s.put('queue:e1', { id: 'e1', status: 'in_service', assignments: [{ serviceId: 's1', techId: 't1', updatedAt: 200, cost: 40 }] });
  await doInst.applyMutation({ op: 'queue.assignmentPatch', payload: { entryId: 'e1', serviceId: 's1', techId: 't1', assignment: { serviceId: 's1', techId: 't1', updatedAt: 300, cost: 55 } } }, null);
  assert.equal((await s.get('queue:e1')).assignments[0].cost, 55, 'a newer per-assignment patch still applies');
});

test('queue.entryPatch rejects a stale patch and applies a newer one', async () => {
  const s = makeStorage();
  const doInst = new TurnDeskDO({ storage: s }, {});
  await s.put('queue:e2', { id: 'e2', status: 'waiting', txnNote: 'A', _patchedAt: 200 });
  await doInst.applyMutation({ op: 'queue.entryPatch', payload: { entryId: 'e2', patch: { txnNote: 'OLD' }, updatedAt: 100 } }, null);
  assert.equal((await s.get('queue:e2')).txnNote, 'A', 'a stale entry patch must not revert a newer note');
  await doInst.applyMutation({ op: 'queue.entryPatch', payload: { entryId: 'e2', patch: { txnNote: 'NEW' }, updatedAt: 300 } }, null);
  assert.equal((await s.get('queue:e2')).txnNote, 'NEW', 'a newer entry patch applies');
});

test('restoreFromBackup REJECTS a key outside this salon\'s own backup prefix (no cross-tenant restore)', async () => {
  const s = makeStorage();
  const bucket = makeBucket();
  const doInst = new TurnDeskDO({ storage: s }, { PHOTOS_BUCKET: bucket });
  await s.put('meta:slug', 'acme');
  await s.put('config:sentinel', 'keep');            // proves the DO was NOT wiped
  await bucket.put('backups/other-salon/x.json', JSON.stringify({ state: { config: { business: 'B' } }, seq: 5 }));
  const res = await doInst.restoreFromBackup('backups/other-salon/x.json');
  assert.ok(res.error, 'a key under another salon\'s prefix must be refused');
  assert.equal(await s.get('config:sentinel'), 'keep', 'the DO must not be wiped by a rejected cross-tenant restore');
});

test('restoreFromBackup still accepts a key under the salon\'s OWN prefix', async () => {
  const s = makeStorage();
  const bucket = makeBucket();
  const doInst = new TurnDeskDO({ storage: s }, { PHOTOS_BUCKET: bucket });
  await s.put('meta:slug', 'acme');
  await s.put('config:business', 'Acme');
  const snap = await doInst.buildSnapshot();
  await bucket.put('backups/acme/y.json', JSON.stringify(snap));
  const res = await doInst.restoreFromBackup('backups/acme/y.json');
  assert.equal(res.restored, true, 'own-prefix restore still works');
});
