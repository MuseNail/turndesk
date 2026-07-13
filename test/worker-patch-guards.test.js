// Device-scoped stale-write guards (Phase 4, ported from Muse v5.41). The per-assignment /
// per-entry patch guard rejects ONLY a stale replay from the SAME device (matched by updatedBy)
// — never a cross-device action. This closes the offline-replay gap WITHOUT the clock-skew
// data-loss of a naive wall-clock compare: a tech's genuinely-later Start/Complete/price from a
// phone whose clock lags the front desk is never dropped. See worker.js applyMutation
// queue.assignmentPatch / queue.entryPatch (+ the queue.upsert _patchedAt marker preservation).
//
// The two restoreFromBackup tests below guard a separate TurnDesk-only concern: restoreFromBackup(key)
// must refuse a caller-supplied key outside THIS salon's own backups/<slug>/ prefix (operator
// cross-tenant restore footgun). Kept from the original stress-test hygiene pass.
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
const makeDO = () => new TurnDeskDO({ storage: makeStorage() }, {});
const seed = (d, entry) => d.state.storage.put('queue:' + entry.id, entry);
const apply = (d, op, payload) => d.applyMutation({ op, payload }, null);
const asg = o => ({ serviceId: 's1', techId: 't1', status: 'inservice', cost: 40, ...o });

// ── queue.assignmentPatch ──────────────────────────────────────────────────
test('assignmentPatch rejects a stale replay from the SAME device', async () => {
  const d = makeDO();
  await seed(d, { id: 'e1', status: 'inservice', assignments: [asg({ updatedAt: 200, updatedBy: 'devA' })] });
  const res = await apply(d, 'queue.assignmentPatch', { entryId: 'e1', serviceId: 's1', techId: 't1', assignment: asg({ status: 'complete', cost: 99, updatedAt: 100, updatedBy: 'devA' }) });
  assert.equal(res.stale, true, 'same-device older replay is rejected');
  const stored = await d.state.storage.get('queue:e1');
  assert.equal(stored.assignments[0].cost, 40);
  assert.equal(stored.assignments[0].updatedAt, 200);
});

test('assignmentPatch applies a newer patch from the same device', async () => {
  const d = makeDO();
  await seed(d, { id: 'e1', status: 'inservice', assignments: [asg({ updatedAt: 200, updatedBy: 'devA' })] });
  const res = await apply(d, 'queue.assignmentPatch', { entryId: 'e1', serviceId: 's1', techId: 't1', assignment: asg({ status: 'complete', cost: 55, updatedAt: 300, updatedBy: 'devA' }) });
  assert.notEqual(res.stale, true);
  assert.equal((await d.state.storage.get('queue:e1')).assignments[0].cost, 55);
});

test('assignmentPatch NEVER drops a cross-device patch, even with an older timestamp (clock-skew safety)', async () => {
  const d = makeDO();
  await seed(d, { id: 'e1', status: 'inservice', assignments: [asg({ updatedAt: 200, updatedBy: 'frontdesk' })] });   // front desk stamped it
  // tech phone (slower clock) sends its genuinely-later Start with a SMALLER timestamp
  const res = await apply(d, 'queue.assignmentPatch', { entryId: 'e1', serviceId: 's1', techId: 't1', assignment: asg({ cost: 45, updatedAt: 100, updatedBy: 'techphone' }) });
  assert.notEqual(res.stale, true, 'a different device is never rejected on a timestamp compare');
  assert.equal((await d.state.storage.get('queue:e1')).assignments[0].cost, 45, 'the cross-device tech action is applied, not silently dropped');
});

test('assignmentPatch applies when the stored assignment has no updatedBy (front-desk-set, no device stamp)', async () => {
  const d = makeDO();
  await seed(d, { id: 'e1', status: 'inservice', assignments: [asg({ updatedAt: 200 })] });   // no updatedBy
  const res = await apply(d, 'queue.assignmentPatch', { entryId: 'e1', serviceId: 's1', techId: 't1', assignment: asg({ status: 'complete', cost: 55, updatedAt: 100, updatedBy: 'techphone' }) });
  assert.notEqual(res.stale, true);
  assert.equal((await d.state.storage.get('queue:e1')).assignments[0].cost, 55);
});

// ── queue.entryPatch ───────────────────────────────────────────────────────
test('entryPatch rejects a stale replay from the same device', async () => {
  const d = makeDO();
  await seed(d, { id: 'e1', status: 'waiting', txnNote: 'original', _patchedAt: 200, _patchedBy: 'devA', assignments: [] });
  const res = await apply(d, 'queue.entryPatch', { entryId: 'e1', patch: { txnNote: 'stale' }, updatedAt: 100, updatedBy: 'devA' });
  assert.equal(res.stale, true);
  assert.equal((await d.state.storage.get('queue:e1')).txnNote, 'original');
});

test('entryPatch applies a newer same-device patch and advances _patchedAt/_patchedBy', async () => {
  const d = makeDO();
  await seed(d, { id: 'e1', status: 'waiting', txnNote: 'original', _patchedAt: 200, _patchedBy: 'devA', assignments: [] });
  const res = await apply(d, 'queue.entryPatch', { entryId: 'e1', patch: { txnNote: 'newer' }, updatedAt: 300, updatedBy: 'devA' });
  assert.notEqual(res.stale, true);
  const stored = await d.state.storage.get('queue:e1');
  assert.equal(stored.txnNote, 'newer');
  assert.equal(stored._patchedAt, 300);
  assert.equal(stored._patchedBy, 'devA');
});

test('entryPatch NEVER drops a cross-device patch even with an older timestamp', async () => {
  const d = makeDO();
  await seed(d, { id: 'e1', status: 'waiting', txnNote: 'original', _patchedAt: 200, _patchedBy: 'devA', assignments: [] });
  const res = await apply(d, 'queue.entryPatch', { entryId: 'e1', patch: { txnNote: 'fromB' }, updatedAt: 100, updatedBy: 'devB' });
  assert.notEqual(res.stale, true);
  assert.equal((await d.state.storage.get('queue:e1')).txnNote, 'fromB');
});

test('entryPatch applies an unstamped patch (back-compat)', async () => {
  const d = makeDO();
  await seed(d, { id: 'e1', status: 'waiting', txnNote: 'original', assignments: [] });
  const res = await apply(d, 'queue.entryPatch', { entryId: 'e1', patch: { txnNote: 'note2' } });
  assert.notEqual(res.stale, true);
  assert.equal((await d.state.storage.get('queue:e1')).txnNote, 'note2');
});

test('queue.upsert preserves the entryPatch guard marker so a later stale replay is still rejected', async () => {
  const d = makeDO();
  await seed(d, { id: 'e1', status: 'waiting', txnNote: 'orig', _patchedAt: 200, _patchedBy: 'devA', assignments: [] });
  // front desk does a whole-entry upsert — its client copy carries no _patchedAt marker
  await apply(d, 'queue.upsert', { entry: { id: 'e1', status: 'waiting', txnNote: 'orig', fees: 5, updatedAt: 500, assignments: [] } });
  let stored = await d.state.storage.get('queue:e1');
  assert.equal(stored._patchedAt, 200, 'marker carried forward across the whole-entry write');
  assert.equal(stored._patchedBy, 'devA');
  const res = await apply(d, 'queue.entryPatch', { entryId: 'e1', patch: { txnNote: 'stale' }, updatedAt: 100, updatedBy: 'devA' });
  assert.equal(res.stale, true, 'stale same-device replay still guarded after the upsert');
  assert.equal((await d.state.storage.get('queue:e1')).txnNote, 'orig');
});

// ── restoreFromBackup (TurnDesk salon-isolation — kept from the original hygiene pass) ──────
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
