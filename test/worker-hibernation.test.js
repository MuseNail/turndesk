// M1 — WebSocket Hibernation (stress-test 2026-07-11): the DO used ws.accept() + an in-memory
// this.sockets Set, so it was billed wall-clock the whole time any device held a socket. The
// hibernation API (state.acceptWebSocket + webSocketMessage + state.getWebSockets) lets the DO
// be evicted between events. These tests pin the MOVED message-dispatch + broadcast behavior
// (real hibernation/eviction is verified live via wrangler dev + the multi-socket harness).
// See cloudflare/worker.js TurnDeskDO.webSocketMessage / _broadcast.
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
function fakeWs() { return { readyState: 1, sent: [], send(s) { this.sent.push(s); } }; }
function makeState(sockets = []) {
  return { storage: makeStorage(), getWebSockets: () => sockets, setWebSocketAutoResponse: () => {}, acceptWebSocket: () => {} };
}
const frames = ws => ws.sent.map(s => JSON.parse(s));

test('webSocketMessage("hello") sends a snapshot to the caller', async () => {
  const st = makeState();
  const doInst = new TurnDeskDO(st, {});
  await st.storage.put('config:business', 'Acme');
  const ws = fakeWs();
  await doInst.webSocketMessage(ws, JSON.stringify({ type: 'hello' }));
  const f = frames(ws);
  assert.equal(f.length, 1);
  assert.equal(f[0].type, 'snapshot');
  assert.ok(f[0].state, 'snapshot carries state');
});

test('webSocketMessage("mutate") applies, acks the sender, and broadcasts the change to OTHER peers only', async () => {
  const sender = fakeWs(), peer = fakeWs();
  const st = makeState([sender, peer]);
  const doInst = new TurnDeskDO(st, {});
  await doInst.webSocketMessage(sender, JSON.stringify({ type: 'mutate', op: 'config.set', payload: { key: 'k', value: 'v', updatedAt: 1 }, mutationId: 'm1' }));
  assert.equal(await st.storage.get('config:k'), 'v', 'the mutation is applied');
  const sf = frames(sender), pf = frames(peer);
  assert.ok(sf.some(x => x.type === 'applied' && x.mutationId === 'm1'), 'sender gets an applied ack');
  assert.ok(!sf.some(x => x.type === 'change'), 'sender is NOT echoed its own change');
  assert.ok(pf.some(x => x.type === 'change' && x.op === 'config.set'), 'peer receives the change broadcast');
});

test('webSocketMessage("ping") replies pong (raw-ping fallback; normally auto-responded at the edge)', async () => {
  const st = makeState();
  const doInst = new TurnDeskDO(st, {});
  const ws = fakeWs();
  await doInst.webSocketMessage(ws, JSON.stringify({ type: 'ping' }));
  assert.deepEqual(frames(ws), [{ type: 'pong' }]);
});

test('_broadcast sends to every connected socket except the excluded one', () => {
  const a = fakeWs(), b = fakeWs(), c = fakeWs();
  const st = makeState([a, b, c]);
  const doInst = new TurnDeskDO(st, {});
  doInst._broadcast('X', b);
  assert.deepEqual(a.sent, ['X']);
  assert.deepEqual(c.sent, ['X']);
  assert.deepEqual(b.sent, [], 'the excluded socket receives nothing');
});
