import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicateGroups } from '../js/app/features/square-customers.js';

test('findDuplicateGroups: groups by shared phone and by identical name', () => {
  const dir = [
    { squareId: 'a', firstName: 'Pat', lastName: 'Palmer', phone: '(555) 111-2222' },
    { squareId: 'b', firstName: 'Pat', lastName: 'Daughter', phone: '5551112222' },   // same phone as a
    { squareId: 'c', firstName: 'Pat', lastName: 'Palmer', phone: '+15553334444' },   // same NAME as a, diff phone
    { squareId: 'd', firstName: 'Solo', lastName: '', phone: '5559999999' },          // unique
    { squareId: 'e', firstName: 'NoPhone', lastName: '', phone: '' },                 // no phone → ignored in both
  ];
  const { byPhone, byName } = findDuplicateGroups(dir);
  // phone group: a + b share 555-111-2222 (1 group of 2)
  assert.equal(byPhone.length, 1);
  assert.deepEqual(byPhone[0].customers.map(c => c.squareId).sort(), ['a', 'b']);
  // name group: a + c share "pat palmer" (1 group of 2)
  assert.equal(byName.length, 1);
  assert.deepEqual(byName[0].customers.map(c => c.squareId).sort(), ['a', 'c']);
});
