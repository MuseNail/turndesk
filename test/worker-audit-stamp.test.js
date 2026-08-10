// Phase 2 Part 1 — F15 audit-log integrity. Two properties:
//  (1) APPEND-ONLY: an audit.log whose event id already exists must NOT overwrite the stored
//      event (the review showed a tech could re-send a known id with benign action/detail to
//      erase the record of an incriminating action). Mirrors chat.append's id dedupe.
//  (2) SERVER-STAMPED attribution: when armed, by/role/at come from the validated session, so
//      a forged `by:'Owner'` is ignored; the client's action/detail/id are preserved. Off ⇒
//      client values kept (back-compat).
import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnDeskDO } from '../cloudflare/worker.js';

function makeStorage() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? m.get(k) : undefined; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list({ prefix } = {}) { const r = new Map(); for (const [k, v] of m) if (!prefix || k.startsWith(prefix)) r.set(k, v); return r; },
    async getAlarm() { return null; }, async setAlarm() {},
  };
}
const ARMED = { AUTH_ENFORCED: 'true', RBAC_ENFORCED: 'true' };
const makeDO = (env = {}) => new TurnDeskDO({ storage: makeStorage() }, env);
const apply = (d, op, payload, actor) => d.applyMutation({ op, payload }, null, actor);
const tech = { kind: 'tech', id: 't1', name: 'Ann', role: 'tech' };

test('audit.log is APPEND-ONLY: a duplicate event id does not overwrite the stored content', async () => {
  const d = makeDO();
  await d.state.storage.put('audit:ev1', { id: 'ev1', action: 'Deleted $500 record', by: 'Sue' });
  await apply(d, 'audit.log', { event: { id: 'ev1', action: 'viewed dashboard', by: 'x' } }, tech);
  assert.equal((await d.state.storage.get('audit:ev1')).action, 'Deleted $500 record', 'content must not be overwritten');
});

test('armed: audit.log attribution is server-stamped from the actor; forged by/role are ignored', async () => {
  const d = makeDO(ARMED);
  await apply(d, 'audit.log', { event: { id: 'ev2', action: 'Login', detail: 'signed in', by: 'Owner', role: 'admin' } }, tech);
  const ev = await d.state.storage.get('audit:ev2');
  assert.equal(ev.by, 'Ann', 'by stamped from the session, not the forged value');
  assert.equal(ev.role, 'tech', 'role stamped from the session');
  assert.equal(ev.action, 'Login', 'client action preserved');
  assert.equal(ev.detail, 'signed in', 'client detail preserved');
});

test('RBAC-off: audit.log keeps the client-provided by/action (back-compat)', async () => {
  const d = makeDO({ AUTH_ENFORCED: 'true' });   // disarmed
  await apply(d, 'audit.log', { event: { id: 'ev3', action: 'X', by: 'Sue' } }, tech);
  assert.equal((await d.state.storage.get('audit:ev3')).by, 'Sue');
});

test('armed: a fresh audit event from a real actor still stores (append works)', async () => {
  const d = makeDO(ARMED);
  await apply(d, 'audit.log', { event: { id: 'ev4', action: 'Refund' } }, { kind: 'fd', id: 'fd-2', name: 'Boss', role: 'manager' });
  const ev = await d.state.storage.get('audit:ev4');
  assert.equal(ev.action, 'Refund');
  assert.equal(ev.by, 'Boss');
  assert.equal(ev.role, 'manager');
});

test('armed: the audit BROADCAST carries the server-stamped attribution, not the forged client value', async () => {
  // Peers apply the broadcast `change` live; it must match the durable stamped record, or a
  // malicious client could show a forged actor to every device until the next snapshot reload.
  const sent = [];
  const d = new TurnDeskDO({ storage: makeStorage(), getWebSockets: () => [{ readyState: 1, send: (s) => sent.push(s) }] }, ARMED);
  await d.applyMutation({ op: 'audit.log', payload: { event: { id: 'evb', action: 'Refund', by: 'Owner', role: 'admin' } }, mutationId: 'mb' }, null, tech);
  const change = sent.map((s) => JSON.parse(s)).find((f) => f.type === 'change' && f.op === 'audit.log');
  assert.ok(change, 'a change was broadcast');
  assert.equal(change.payload.event.by, 'Ann', 'broadcast uses the stamped by');
  assert.equal(change.payload.event.role, 'tech', 'broadcast uses the stamped role');
});
