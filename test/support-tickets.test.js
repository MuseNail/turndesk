// Integration tests for the in-app help desk at the Durable Object layer: the
// registry DO's /support/* routes (create/list/reply/dev-reply/status/mark-read),
// tenant isolation, caps, and the registry R2 backup that keeps tickets durable.
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
    async list({ prefix, limit } = {}) {
      const r = new Map();
      for (const [k, v] of m) { if (!prefix || k.startsWith(prefix)) { r.set(k, v); if (limit && r.size >= limit) break; } }
      return r;
    },
    async getAlarm() { return null; },
    async setAlarm() {},
  };
}
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
const post = (path, body) => new Request('https://do' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify(body) });
const get = (path) => new Request('https://do' + path);
const sub = { kind: 'fd', id: '7', name: 'Rosa', role: 'manager' };

test('create → stored under ticket:<salon>:<id>, unread for dev', async () => {
  const s = makeStorage();
  const doi = new TurnDeskDO({ storage: s }, {});
  const r = await doi.fetch(post('/support/create', { salon: 'muse', submitter: sub, type: 'bug', subject: 'Broken', message: 'help' }));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.ticket.submitterPushId, undefined, 'salon view hides internal push id');
  const keys = [...s._m.keys()].filter(k => k.startsWith('ticket:muse:'));
  assert.equal(keys.length, 1);
  const stored = s._m.get(keys[0]);
  assert.equal(stored.unreadForDev, true);
  assert.equal(stored.submitterPushId, 'fd:7');
  assert.equal(stored.messages[0].text, 'help');
});

test('create rejects bad input and missing salon', async () => {
  const doi = new TurnDeskDO({ storage: makeStorage() }, {});
  assert.equal((await doi.fetch(post('/support/create', { salon: 'muse', submitter: sub, type: 'nope', subject: 's', message: 'm' }))).status, 400);
  assert.equal((await doi.fetch(post('/support/create', { submitter: sub, type: 'bug', subject: 's', message: 'm' }))).status, 400);
});

test('list returns only the asking salon, newest-first, minus archived', async () => {
  const s = makeStorage();
  const doi = new TurnDeskDO({ storage: s }, {});
  await doi.fetch(post('/support/create', { salon: 'muse', submitter: sub, type: 'bug', subject: 'A', message: 'a' }));
  await doi.fetch(post('/support/create', { salon: 'other', submitter: sub, type: 'bug', subject: 'B', message: 'b' }));
  const j = await (await doi.fetch(get('/support/list?salon=muse'))).json();
  assert.equal(j.tickets.length, 1);
  assert.equal(j.tickets[0].subject, 'A');
});

test('isolation: dev-reply / status / salon-reply to a foreign salon 404s (never confirms the id)', async () => {
  const s = makeStorage();
  const doi = new TurnDeskDO({ storage: s }, {});
  await doi.fetch(post('/support/create', { salon: 'muse', submitter: sub, type: 'bug', subject: 'A', message: 'a' }));
  const id = [...s._m.keys()].find(k => k.startsWith('ticket:muse:')).split(':')[2];
  // Attacker names the real id but the WRONG salon → 404 on every mutating route.
  assert.equal((await doi.fetch(post('/support/reply', { salon: 'evil', id, message: 'x' }))).status, 404);
  assert.equal((await doi.fetch(post('/support/dev-reply', { salon: 'evil', id, message: 'x' }))).status, 404);
  assert.equal((await doi.fetch(post('/support/status', { salon: 'evil', id, status: 'resolved' }))).status, 404);
});

test('two-way thread: dev reply → replied + unread-for-salon; salon reply → unread-for-dev', async () => {
  const s = makeStorage();
  const doi = new TurnDeskDO({ storage: s }, {});
  await doi.fetch(post('/support/create', { salon: 'muse', submitter: sub, type: 'question', subject: 'Q', message: 'how?' }));
  const key = [...s._m.keys()].find(k => k.startsWith('ticket:muse:'));
  const id = key.split(':')[2];
  await doi.fetch(post('/support/dev-reply', { salon: 'muse', id, message: 'like this' }));
  let t = s._m.get(key);
  assert.equal(t.status, 'replied');
  assert.equal(t.unreadForSalon, true);
  assert.equal(t.unreadForDev, false);            // the dev just wrote it
  await doi.fetch(post('/support/reply', { salon: 'muse', id, message: 'thanks!' }));
  t = s._m.get(key);
  assert.equal(t.unreadForDev, true);             // dev must re-read
  assert.equal(t.messages.length, 3);
});

test('mark-read clears the requested side', async () => {
  const s = makeStorage();
  const doi = new TurnDeskDO({ storage: s }, {});
  await doi.fetch(post('/support/create', { salon: 'muse', submitter: sub, type: 'bug', subject: 'A', message: 'a' }));
  const key = [...s._m.keys()].find(k => k.startsWith('ticket:muse:'));
  const id = key.split(':')[2];
  await doi.fetch(post('/support/mark-read', { salon: 'muse', id, who: 'dev' }));
  assert.equal(s._m.get(key).unreadForDev, false);
});

test('open-ticket cap: the 101st open ticket is refused', async () => {
  const s = makeStorage();
  const doi = new TurnDeskDO({ storage: s }, {});
  for (let i = 0; i < 100; i++) s._m.set('ticket:muse:tk' + i, { id: 'tk' + i, salon: 'muse', status: 'open', updatedAt: i, messages: [] });
  const r = await doi.fetch(post('/support/create', { salon: 'muse', submitter: sub, type: 'bug', subject: 'X', message: 'x' }));
  assert.equal(r.status, 429);
});

test('operator all-view aggregates across salons + reports unread count', async () => {
  const s = makeStorage();
  const doi = new TurnDeskDO({ storage: s }, {});
  await doi.fetch(post('/support/create', { salon: 'muse', submitter: sub, type: 'bug', subject: 'A', message: 'a' }));
  await doi.fetch(post('/support/create', { salon: 'krystal', submitter: sub, type: 'feedback', subject: 'B', message: 'b' }));
  const j = await (await doi.fetch(get('/support/all'))).json();
  assert.equal(j.tickets.length, 2);
  assert.equal(j.unread, 2);
  const bugs = await (await doi.fetch(get('/support/all?type=bug'))).json();
  assert.equal(bugs.tickets.length, 1);
});

test('registry backup: alarm() writes a registry snapshot to R2 containing the tickets', async () => {
  const s = makeStorage();
  const bucket = makeBucket();
  const doi = new TurnDeskDO({ storage: s }, { PHOTOS_BUCKET: bucket });
  await doi.fetch(post('/support/create', { salon: 'muse', submitter: sub, type: 'bug', subject: 'Persist me', message: 'x' }));
  await doi.alarm();
  const keys = [...bucket._store.keys()].filter(k => k.startsWith('backups/__registry__/registry-'));
  assert.equal(keys.length, 1, 'a registry snapshot was written');
  const snap = JSON.parse(bucket._store.get(keys[0]).body);
  assert.equal(snap.registry, true);
  assert.equal(snap.state.tickets.length, 1);
  assert.equal(snap.state.tickets[0].subject, 'Persist me');
});

test('a plain salon DO is NOT treated as the registry (no registry backup)', async () => {
  const s = makeStorage();
  const bucket = makeBucket();
  // Seed salon-shaped state only (queue) + a slug, like a real salon instance.
  s._m.set('meta:slug', 'muse');
  s._m.set('queue:q1', { id: 'q1' });
  const doi = new TurnDeskDO({ storage: s }, { PHOTOS_BUCKET: bucket });
  await doi.alarm();
  assert.equal([...bucket._store.keys()].some(k => k.startsWith('backups/__registry__/')), false);
  assert.ok([...bucket._store.keys()].some(k => k.startsWith('backups/muse/')), 'salon backup still written');
});
