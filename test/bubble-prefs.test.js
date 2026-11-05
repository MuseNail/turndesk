// W2-6 per-user bubble-info toggles: pure cores.
// Run: node --test-force-exit --test test/bubble-prefs.test.js
import './setup-globals.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBubblePrefs, bubbleLineParts } from '../js/app/features/bubble-prefs.js';

// ── readBubblePrefs(config, key) — key is the full storage key bubble_prefs_fd:<id> ──
test('readBubblePrefs: missing key = everything shown', () => {
  assert.deepEqual(readBubblePrefs({}, 'bubble_prefs_fd:7'), { hideTime: false, hideTech: false, hideSvc: false });
});

test('readBubblePrefs: null key (signed out) = everything shown', () => {
  assert.deepEqual(readBubblePrefs({ 'bubble_prefs_fd:7': { svc: true } }, null), { hideTime: false, hideTech: false, hideSvc: false });
});

test('readBubblePrefs: reflects each flag independently', () => {
  assert.deepEqual(readBubblePrefs({ 'bubble_prefs_fd:7': { time: true } }, 'bubble_prefs_fd:7'), { hideTime: true, hideTech: false, hideSvc: false });
  assert.deepEqual(readBubblePrefs({ 'bubble_prefs_fd:7': { tech: true, svc: true } }, 'bubble_prefs_fd:7'), { hideTime: false, hideTech: true, hideSvc: true });
});

test('readBubblePrefs: one user does not read another user key', () => {
  const cfg = { 'bubble_prefs_fd:3': { svc: true, tech: true, time: true } };
  assert.deepEqual(readBubblePrefs(cfg, 'bubble_prefs_fd:7'), { hideTime: false, hideTech: false, hideSvc: false });
});

// ── bubbleLineParts(bits, hideFlags) — the joined inline text (svc · tech · cost · Wait) ──
const full = { svcLabel: 'Gel', techFirst: 'Anna', costStr: '$30', hasTech: true };
const waiting = { svcLabel: 'Gel', techFirst: '', costStr: '', hasTech: false };

test('nothing hidden, assigned+priced = svc · tech · cost', () => {
  assert.deepEqual(bubbleLineParts(full, {}), ['Gel', 'Anna', '$30']);
});

test('nothing hidden, waiting/no price = svc · Wait', () => {
  assert.deepEqual(bubbleLineParts(waiting, {}), ['Gel', 'Wait']);
});

test('hideSvc drops the label but keeps tech + cost (no orphan separator)', () => {
  assert.deepEqual(bubbleLineParts(full, { hideSvc: true }), ['Anna', '$30']);
});

test('hideTech drops the tech name AND the Wait suffix (tech-slot info), keeps svc + cost', () => {
  assert.deepEqual(bubbleLineParts(full, { hideTech: true }), ['Gel', '$30']);
  assert.deepEqual(bubbleLineParts(waiting, { hideTech: true }), ['Gel']);
});

test('cost is NOT a toggle — it survives even when svc AND tech are hidden', () => {
  assert.deepEqual(bubbleLineParts(full, { hideSvc: true, hideTech: true }), ['$30']);
});

test('all-hidden + no price = empty parts (dot-only line, no stray separators)', () => {
  assert.deepEqual(bubbleLineParts(waiting, { hideSvc: true, hideTech: true }), []);
});

test('comped service shows the Comp tag like a cost (always, not a toggle)', () => {
  const comped = { svcLabel: 'Gel', techFirst: 'Anna', costStr: 'Comp', hasTech: true };
  assert.deepEqual(bubbleLineParts(comped, { hideSvc: true, hideTech: true }), ['Comp']);
});
