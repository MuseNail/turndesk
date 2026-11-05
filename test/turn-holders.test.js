// Pure cores behind item 3 "don't recommend a tech holding a still-waiting (assigned, not-started)
// customer": _hasPendingAssignment (does this tech hold a waiting assignment?) + _dropHolders (remove
// holders from a candidate pool, but fall back to the full pool if that empties it, so there's always
// a who's-next). Both pure (injected data/fn) → unit-testable without app state.
import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { _hasPendingAssignment, _dropHolders } from '../js/app/features/turns.js';

test('_hasPendingAssignment: true when any assignment status is waiting', () => {
  assert.equal(_hasPendingAssignment(['inservice', 'waiting']), true);
  assert.equal(_hasPendingAssignment(['waiting']), true);
});
test('_hasPendingAssignment: false with no waiting (in-service / complete / empty)', () => {
  assert.equal(_hasPendingAssignment(['inservice', 'complete']), false);
  assert.equal(_hasPendingAssignment([]), false);
  assert.equal(_hasPendingAssignment(undefined), false);
});
test('_dropHolders: removes techs holding a waiting customer', () => {
  const holds = id => id === 'b';
  assert.deepEqual(_dropHolders(['a', 'b', 'c'], holds), ['a', 'c']);
});
test('_dropHolders: falls back to the full pool when ALL are holders', () => {
  assert.deepEqual(_dropHolders(['a', 'b'], () => true), ['a', 'b']);
});
test('_dropHolders: tolerates empty / undefined', () => {
  assert.deepEqual(_dropHolders([], () => true), []);
  assert.deepEqual(_dropHolders(undefined, () => false), []);
});
