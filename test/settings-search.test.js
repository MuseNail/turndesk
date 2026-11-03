// Pure helper behind the global-search "Settings" group (Item 3): _settingsSearchRows filters the
// settings nav by a query + an injected visibility predicate and returns flat result rows. Pure so it
// can be tested without app/DOM state (the real visibility uses role/perms; here it's injected).
import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { _settingsSearchRows } from '../js/app/features/settings.js';

const NAV = [
  { id: 'cat1', title: 'Workflow', items: [
    { label: 'Turn Rules', sub: 'Half / bonus', content: 'turns-thresh-section', icon: 'swap_vert' },
    { label: 'Stations', sub: 'Seats', content: 'settings-stations-section', adminOnly: true, icon: 'event_seat' },
  ] },
  { id: 'cat2', title: 'Business', items: [
    { label: 'Service Waiver', sub: 'Require & manage', content: 'waiver-section', icon: 'gavel' },
    { label: 'Customer Directory', sub: 'Browse', action: 'showCustomerDir', icon: 'contacts' },
  ] },
];
const seeAll = () => true;

test('_settingsSearchRows matches on the label', () => {
  const rows = _settingsSearchRows(NAV, 'waiver', seeAll);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, 'waiver-section');
  assert.equal(rows[0].cat, 'Business');
});

test('_settingsSearchRows matches on the sub text', () => {
  const rows = _settingsSearchRows(NAV, 'bonus', seeAll);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'Turn Rules');
});

test('_settingsSearchRows matches on the category title', () => {
  const rows = _settingsSearchRows(NAV, 'workflow', seeAll);
  assert.equal(rows.length, 2);
});

test('_settingsSearchRows excludes leaves the predicate hides', () => {
  const noAdmin = it => !it.adminOnly;
  const rows = _settingsSearchRows(NAV, 'station', noAdmin);
  assert.equal(rows.length, 0);
});

test('_settingsSearchRows returns [] for a blank query', () => {
  assert.deepEqual(_settingsSearchRows(NAV, '   ', seeAll), []);
});

test('_settingsSearchRows carries action + icon for action-type leaves', () => {
  const rows = _settingsSearchRows(NAV, 'directory', seeAll);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'showCustomerDir');
  assert.equal(rows[0].content, null);
  assert.equal(rows[0].icon, 'contacts');
});
