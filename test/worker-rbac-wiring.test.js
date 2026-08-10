// Phase 2 Part 1 — the RBAC actor must be RESOLVED and threaded into applyMutation at the
// real call sites: HTTP POST /state/mutate (token from the request), the WS 'mutate' frame
// (token from the socket attachment), and the INTERNAL operator managerpin path. Without the
// wiring the gate would either never run (null actor slips through) or wrongly deny a real
// admin (null actor on a sensitive op).
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
const ARMED = { AUTH_ENFORCED: 'true', RBAC_ENFORCED: 'true' };
const future = Date.now() + 3600e3;
async function armedDO() {
  const d = new TurnDeskDO({ storage: makeStorage(), getWebSockets: () => [], setWebSocketAutoResponse: () => {}, acceptWebSocket: () => {} }, ARMED);
  await d.state.storage.put('config:fd_users', [{ id: 'fd-1', name: 'Sue', pin: '1111', role: 'frontdesk' }, { id: 'fd-a', name: 'Boss', pin: '2222', role: 'admin' }]);
  await d.state.storage.put('config:staff', [{ id: 't1', name: 'Ann', pin: '3333' }]);
  await d.state.storage.put('sess:tok-tech',  { kind: 'tech', id: 't1',  name: 'Ann', role: 'tech',  expires: future });
  await d.state.storage.put('sess:tok-admin', { kind: 'fd',   id: 'fd-a', name: 'Boss', role: 'admin', expires: future });
  return d;
}
const addAdmin = { op: 'config.set', payload: { key: 'fd_users', value: [{ id: 'fd-1', role: 'frontdesk' }, { id: 'fd-a', role: 'admin' }, { id: 'fd-x', pin: '9999', role: 'admin' }], updatedAt: 9 } };
const mutateReq = (token, body) => new Request('https://do/state/mutate?salon=acme', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body),
});

// ── HTTP /state/mutate resolves the token → actor ───────────────────────────
test('HTTP mutate: a tech token is FORBIDDEN on an escalation write', async () => {
  const d = await armedDO();
  const res = await d.fetch(mutateReq('tok-tech', addAdmin));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'forbidden');
  assert.equal((await d.state.storage.get('config:fd_users')).length, 2, 'not persisted');
});

test('HTTP mutate: an admin token is APPLIED on the same write (proves the token is resolved, not null)', async () => {
  const d = await armedDO();
  const res = await d.fetch(mutateReq('tok-admin', addAdmin));
  assert.equal(res.status, 200);
  assert.notEqual((await res.json()).error, 'forbidden');
  assert.equal((await d.state.storage.get('config:fd_users')).length, 3, 'admin write persisted');
});

test('HTTP mutate: a bad/absent token is FORBIDDEN on a sensitive op (null actor)', async () => {
  const d = await armedDO();
  const res = await d.fetch(mutateReq('garbage', addAdmin));
  assert.equal((await res.json()).error, 'forbidden');
});

// ── WS 'mutate' reads the socket attachment ─────────────────────────────────
function wsWithToken(token) {
  return { readyState: 1, sent: [], send(s) { this.sent.push(s); }, deserializeAttachment: () => (token ? { token } : null) };
}
test('WS mutate: a tech-attached socket is FORBIDDEN on an escalation write', async () => {
  const d = await armedDO();
  const ws = wsWithToken('tok-tech');
  await d.webSocketMessage(ws, JSON.stringify({ type: 'mutate', mutationId: 'm1', ...addAdmin }));
  const applied = ws.sent.map(JSON.parse).find(f => f.type === 'applied');
  assert.equal(applied.error, 'forbidden');
  assert.equal((await d.state.storage.get('config:fd_users')).length, 2, 'not persisted');
});

test('WS mutate: an admin-attached socket is APPLIED', async () => {
  const d = await armedDO();
  const ws = wsWithToken('tok-admin');
  await d.webSocketMessage(ws, JSON.stringify({ type: 'mutate', mutationId: 'm2', ...addAdmin }));
  const applied = ws.sent.map(JSON.parse).find(f => f.type === 'applied');
  assert.notEqual(applied.error, 'forbidden');
  assert.equal((await d.state.storage.get('config:fd_users')).length, 3);
});

// ── INTERNAL operator path still works while armed ──────────────────────────
test('operator /provision/managerpin sets an admin PIN while armed (INTERNAL bypass, H4 recovery path)', async () => {
  const d = await armedDO();
  const res = await d.fetch(new Request('https://do/provision/managerpin?salon=acme', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '4321' }),
  }));
  assert.equal(res.status, 200);
  const fd = await d.state.storage.get('config:fd_users');
  assert.ok(fd.some(u => u.id === 'fd-manager' && u.pin === '4321'), 'manager PIN set via the INTERNAL path');
});
