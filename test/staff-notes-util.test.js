// Item 4: per-tech notes list — pure core shared by the client store + the Worker DO.
// Run: node --test-force-exit --test test/staff-notes-util.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNotesList, applyNotePatch, notesMirror, NOTES_CAP, NOTE_MAX } from '../js/app/staff-notes-util.js';

test('normalizeNotesList: passes through an existing notesList (filtering junk)', () => {
  assert.deepEqual(
    normalizeNotesList({ notesList: [{ id: 'a', text: 'hi' }, { text: 'no id' }, null] }),
    [{ id: 'a', text: 'hi' }]
  );
});
test('normalizeNotesList: migrates a legacy notes string to one note', () => {
  assert.deepEqual(normalizeNotesList({ notes: 'prefers pedis' }), [{ id: 'legacy', text: 'prefers pedis' }]);
});
test('normalizeNotesList: empty / none → []', () => {
  assert.deepEqual(normalizeNotesList({}), []);
  assert.deepEqual(normalizeNotesList({ notes: '  ' }), []);
  assert.deepEqual(normalizeNotesList(null), []);
});

test('applyNotePatch add: appends a new note by id', () => {
  assert.deepEqual(applyNotePatch([], 'add', { id: 'n1', text: 'A' }), [{ id: 'n1', text: 'A' }]);
});
test('applyNotePatch add: idempotent on a duplicate id (safe outbox replay)', () => {
  const l = [{ id: 'n1', text: 'A' }];
  assert.deepEqual(applyNotePatch(l, 'add', { id: 'n1', text: 'A again' }), [{ id: 'n1', text: 'A' }]);
});
test('applyNotePatch add: two different ids both survive (the whole point)', () => {
  let l = applyNotePatch([], 'add', { id: 'n1', text: 'A' });
  l = applyNotePatch(l, 'add', { id: 'n2', text: 'B' });
  assert.deepEqual(l, [{ id: 'n1', text: 'A' }, { id: 'n2', text: 'B' }]);
});
test('applyNotePatch add: respects the soft cap', () => {
  let l = [];
  for (let i = 0; i < NOTES_CAP; i++) l = applyNotePatch(l, 'add', { id: 'n' + i, text: 't' });
  assert.equal(l.length, NOTES_CAP);
  assert.deepEqual(applyNotePatch(l, 'add', { id: 'over', text: 'x' }), l);   // over cap → unchanged
});
test('applyNotePatch add: clamps text to NOTE_MAX', () => {
  const long = 'x'.repeat(NOTE_MAX + 50);
  assert.equal(applyNotePatch([], 'add', { id: 'n1', text: long })[0].text.length, NOTE_MAX);
});
test('applyNotePatch edit: replaces the matching note text; no-op when missing', () => {
  const l = [{ id: 'n1', text: 'A' }];
  assert.deepEqual(applyNotePatch(l, 'edit', { id: 'n1', text: 'B' }), [{ id: 'n1', text: 'B' }]);
  assert.deepEqual(applyNotePatch(l, 'edit', { id: 'zz', text: 'B' }), l);
});
test('applyNotePatch remove: drops by id; no-op when missing', () => {
  const l = [{ id: 'n1', text: 'A' }, { id: 'n2', text: 'B' }];
  assert.deepEqual(applyNotePatch(l, 'remove', { id: 'n1' }), [{ id: 'n2', text: 'B' }]);
  assert.deepEqual(applyNotePatch(l, 'remove', { id: 'zz' }), l);
});
test('applyNotePatch: bad input is safe (no id → unchanged, null list → [])', () => {
  assert.deepEqual(applyNotePatch([{ id: 'n1', text: 'A' }], 'add', { text: 'no id' }), [{ id: 'n1', text: 'A' }]);
  assert.deepEqual(applyNotePatch(null, 'add', { id: 'n1', text: 'A' }), [{ id: 'n1', text: 'A' }]);
});
test('notesMirror: joins non-empty texts with " · "', () => {
  assert.equal(notesMirror([{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }, { id: 'c', text: '' }]), 'one · two');
  assert.equal(notesMirror([]), '');
});
