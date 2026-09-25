// Ported from Muse v5.58 — self-heal for a flooded config.set outbox that could OOM the tab on boot.
// A frozen tab can enqueue thousands of config.set ops for the SAME key faster than the WS acks
// drain them; the giant outbox then froze/OOM'd the tab on every reload as reapplyOutbox +
// replayOutbox walked it. config.set is last-writer-wins per key, so superseded same-key writes are
// safe to drop. coalesceConfigSets keeps only the LAST config.set per key (order preserved) once
// the outbox is pathologically full — mirroring the existing customer.upsert coalesce.
import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { coalesceConfigSets } from '../js/app/sync.js';

const cfg = (key, val, id) => ({ type: 'mutate', op: 'config.set', payload: { key, value: val }, mutationId: id, device: 'devA' });
const other = (op, id) => ({ type: 'mutate', op, payload: {}, mutationId: id, device: 'devA' });

test('a normal small outbox is returned untouched (below the flood threshold)', () => {
  const arr = [cfg('a', 1, 'm1'), cfg('b', 2, 'm2'), other('queue.upsert', 'm3')];
  assert.deepEqual(coalesceConfigSets(arr), arr);
});

test('a flood of the SAME key collapses to the single latest write', () => {
  const arr = [];
  for (let i = 0; i < 5000; i++) arr.push(cfg('chat_seen_fd:7', { team: 1000 + i }, 'm' + i));
  const out = coalesceConfigSets(arr);
  assert.equal(out.length, 1);
  assert.equal(out[0].payload.value.team, 1000 + 4999);
  assert.equal(out[0].mutationId, 'm4999');
});

test('non-config ops are preserved, in order, alongside the coalesced config writes', () => {
  const arr = [other('record.save', 'r1')];
  for (let i = 0; i < 100; i++) arr.push(cfg('chat_seen_fd:7', { team: i }, 'c' + i));
  arr.push(other('queue.upsert', 'q1'));
  arr.push(cfg('turns_order', ['x'], 'c-turns'));
  const out = coalesceConfigSets(arr);
  assert.deepEqual(out.map(m => m.mutationId), ['r1', 'c99', 'q1', 'c-turns']);
});

test('distinct keys are all kept — only superseded same-key writes are dropped', () => {
  const arr = [];
  for (let i = 0; i < 60; i++) arr.push(cfg('key_' + i, i, 'k' + i));
  const out = coalesceConfigSets(arr);
  assert.equal(out.length, 60);
});

test('a malformed config.set with no key is never dropped', () => {
  const arr = [{ type: 'mutate', op: 'config.set', payload: {}, mutationId: 'bad', device: 'devA' }];
  for (let i = 0; i < 60; i++) arr.push(cfg('chat_seen_fd:7', { team: i }, 'c' + i));
  const out = coalesceConfigSets(arr);
  assert.ok(out.some(m => m.mutationId === 'bad'));
});
