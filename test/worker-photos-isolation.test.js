// The /photos/* route shares ONE R2 bucket across all salons (and with per-salon
// backups/<slug>/...). Writes/deletes must be bound to the caller's authenticated
// salon, and the backup namespace must be unreachable through this route entirely —
// GET /photos is auth-exempt, so a readable backups/ key would leak a salon's full
// state. See worker.js photos handler. Auth is OFF here (AUTH_ENFORCED unset) so
// appAuthOk passes and we exercise the key-isolation logic directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../cloudflare/worker.js';

function makeBucket() {
  const store = new Map();
  return {
    _store: store,
    async put(k, body) { store.set(k, body); },
    async get(k) { return store.has(k) ? { body: store.get(k), etag: 'e', writeHttpMetadata() {} } : null; },
    async delete(k) { store.delete(k); },
  };
}
const env = (bucket) => ({ PHOTOS_BUCKET: bucket });

function photoReq(method, key, salon, body) {
  const headers = {};
  if (salon) headers['X-Salon'] = salon;
  const init = { method, headers };
  if (body != null) init.body = body;
  return new Request('https://w/photos/' + key, init);
}

test('PUT to another salon\'s photo key is rejected (403) and writes nothing', async () => {
  const bucket = makeBucket();
  const res = await worker.fetch(photoReq('PUT', 'salon-b/logo_business', 'salon-a', 'x'), env(bucket));
  assert.equal(res.status, 403);
  assert.equal(bucket._store.has('salon-b/logo_business'), false);
});

test('PUT under the caller\'s own salon prefix is allowed', async () => {
  const bucket = makeBucket();
  const res = await worker.fetch(photoReq('PUT', 'salon-a/logo_business', 'salon-a', 'x'), env(bucket));
  assert.equal(res.status, 200);
  assert.equal(bucket._store.has('salon-a/logo_business'), true);
});

test('DELETE of another salon\'s photo key is rejected (403); victim photo survives', async () => {
  const bucket = makeBucket();
  await bucket.put('salon-b/logo_business', 'x');
  const res = await worker.fetch(photoReq('DELETE', 'salon-b/logo_business', 'salon-a'), env(bucket));
  assert.equal(res.status, 403);
  assert.equal(bucket._store.has('salon-b/logo_business'), true);
});

test('a backup blob is NOT readable through the public (auth-exempt) photos GET', async () => {
  const bucket = makeBucket();
  await bucket.put('backups/salon-a/state-2026-07-10T00-00-00-000Z.json', '{"customers":"PII"}');
  const res = await worker.fetch(photoReq('GET', 'backups/salon-a/state-2026-07-10T00-00-00-000Z.json', ''), env(bucket));
  assert.equal(res.status, 404);
});

test('the backup namespace cannot be written or deleted through the photos route', async () => {
  const bucket = makeBucket();
  await bucket.put('backups/salon-a/state-x.json', 'orig');
  const del = await worker.fetch(photoReq('DELETE', 'backups/salon-a/state-x.json', 'salon-a'), env(bucket));
  assert.equal(del.status, 404);
  assert.equal(bucket._store.get('backups/salon-a/state-x.json'), 'orig', 'backup must survive');
});
