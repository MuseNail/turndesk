// Restore-from-backup must rebuild the FULL DO state — the customer directory,
// app-native appointments, and BOTH soft-delete tombstone sets. A gap here is
// silent data loss (restoring a backup wipes every customer). See worker.js
// TurnDeskDO.restoreFromBackup / buildSnapshot.
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

function makeBucket() {
  const store = new Map();
  return {
    _store: store,
    async put(k, body) { store.set(k, body); },
    async get(k) { return store.has(k) ? { text: async () => store.get(k) } : null; },
    async list({ prefix } = {}) {
      return { objects: [...store.keys()].filter(k => !prefix || k.startsWith(prefix)).map(k => ({ key: k, uploaded: new Date().toISOString(), size: store.get(k).length })) };
    },
  };
}

test('restoreFromBackup rebuilds customers, appointments + both tombstone sets', async () => {
  const storage = makeStorage();
  const bucket = makeBucket();
  const doInst = new TurnDeskDO({ storage }, { PHOTOS_BUCKET: bucket });

  await storage.put('config:business_name', 'Lush Nails & Spa');
  await storage.put('record:r1', { id: 'r1', total: 40 });
  await storage.put('customer:c1', { id: 'c1', firstName: 'Alice', phone: '5551112222' });
  await storage.put('customer:c2', { id: 'c2', firstName: 'Bob' });
  await storage.put('custdeletion:c9', { id: 'c9', at: '2026-01-01T00:00:00Z' });
  await storage.put('appt:a1', { id: 'a1', start: '2026-07-09T18:00:00Z', guests: [{ name: 'Alice', lines: [{ serviceId: 'svc-gel', staffId: 'staff-1' }] }] });
  await storage.put('apptdeletion:a9', { id: 'a9', at: '2026-01-02T00:00:00Z' });

  const snap = await doInst.buildSnapshot();
  assert.equal(snap.state.customers.length, 2, 'snapshot must include customers');
  assert.equal(snap.state.appointments.length, 1, 'snapshot must include appointments');
  assert.equal(snap.state.customerDeletions.length, 1);
  assert.equal(snap.state.apptDeletions.length, 1);
  await bucket.put('backups/test.json', JSON.stringify(snap));

  const res = await doInst.restoreFromBackup('backups/test.json');
  assert.equal(res.restored, true);

  assert.deepEqual(await storage.get('customer:c1'), { id: 'c1', firstName: 'Alice', phone: '5551112222' });
  assert.deepEqual(await storage.get('customer:c2'), { id: 'c2', firstName: 'Bob' });
  assert.ok(await storage.get('appt:a1'), 'appointment must be restored');
  assert.ok(await storage.get('custdeletion:c9'), 'customer tombstone must be restored');
  assert.ok(await storage.get('apptdeletion:a9'), 'appointment tombstone must be restored');
  assert.deepEqual(await storage.get('record:r1'), { id: 'r1', total: 40 });
  assert.equal(res.counts.customers, 2);
  assert.equal(res.counts.appointments, 1);
});

// C1 — owner/manager login credentials are intentionally kept OUT of the snapshot (so a
// password hash never rides the broadcast channel to clients). deleteAll() would erase them,
// locking the owner out of their own salon after a restore. They must be preserved across the wipe.
test('restoreFromBackup PRESERVES owner login credentials across the wipe (C1)', async () => {
  const storage = makeStorage();
  const bucket = makeBucket();
  const doInst = new TurnDeskDO({ storage }, { PHOTOS_BUCKET: bucket });
  const cred = { email: 'owner@demo.app', role: 'owner', salt: 's', hash: 'h' };
  await storage.put('owner:owner@demo.app', cred);
  await storage.put('config:business_name', 'Lush');
  const snap = await doInst.buildSnapshot();
  assert.equal(snap.state.owner, undefined, 'owner credentials must never appear in the snapshot');
  await bucket.put('backups/t.json', JSON.stringify(snap));
  await doInst.restoreFromBackup('backups/t.json');
  assert.deepEqual(await storage.get('owner:owner@demo.app'), cred, 'owner login must survive a restore (no lockout)');
});

// C2 — the Google Calendar refresh token and staff push subscriptions are also not in the
// snapshot; they must survive a restore so calendar sync + push alerts keep working.
test('restoreFromBackup PRESERVES the Google token + push subscriptions across the wipe (C2)', async () => {
  const storage = makeStorage();
  const bucket = makeBucket();
  const doInst = new TurnDeskDO({ storage }, { PHOTOS_BUCKET: bucket });
  await storage.put('gcal:blob', { refresh: 'REFRESH_TOKEN' });
  await storage.put('push:staff-1:abc', { endpoint: 'https://push/1' });
  await storage.put('push:staff-2:def', { endpoint: 'https://push/2' });
  const snap = await doInst.buildSnapshot();
  await bucket.put('backups/t.json', JSON.stringify(snap));
  await doInst.restoreFromBackup('backups/t.json');
  assert.deepEqual(await storage.get('gcal:blob'), { refresh: 'REFRESH_TOKEN' }, 'Google token must survive');
  assert.ok(await storage.get('push:staff-1:abc'), 'push sub 1 must survive');
  assert.ok(await storage.get('push:staff-2:def'), 'push sub 2 must survive');
});

// C3 + C4 — cfgmeta (the per-key stale-write baseline) and the audit log ARE captured in the
// snapshot, but the restore rebuild never re-persisted them. Rebuild both.
test('restoreFromBackup rebuilds config change-stamps (C3) and the audit log (C4)', async () => {
  const storage = makeStorage();
  const bucket = makeBucket();
  const doInst = new TurnDeskDO({ storage }, { PHOTOS_BUCKET: bucket });
  await storage.put('config:services', [{ id: 'svc-1' }]);
  await storage.put('cfgmeta:services', { updatedAt: 12345, updatedBy: 'dev-a' });
  await storage.put('audit:2026-07-10T00-00-00-000Z-x', { id: '2026-07-10T00-00-00-000Z-x', at: '2026-07-10T00:00:00Z', action: 'signed in' });
  const snap = await doInst.buildSnapshot();
  assert.ok(snap.state.configMeta.services, 'snapshot captures cfgmeta');
  assert.equal(snap.state.audit.length, 1, 'snapshot captures audit');
  await bucket.put('backups/t.json', JSON.stringify(snap));
  await doInst.restoreFromBackup('backups/t.json');
  assert.deepEqual(await storage.get('cfgmeta:services'), { updatedAt: 12345, updatedBy: 'dev-a' }, 'stale-write baseline restored (C3)');
  assert.ok(await storage.get('audit:2026-07-10T00-00-00-000Z-x'), 'audit trail restored (C4)');
});
