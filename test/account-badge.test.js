// iPad header slim-down (v6.05): the account-avatar combined-unread badge text.
// accountUnreadText(chatUnread, supportUnread) is the single pure decision behind
// the badge — the DOM wiring (refreshAccountUnread in main.js) is verified on-device.
// Import the globals shim FIRST (utils.js registers a top-level document listener at import time).
import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { accountUnreadText } from '../js/app/utils.js';

test('accountUnreadText: nothing unread → empty string (badge hidden)', () => {
  assert.equal(accountUnreadText(0, 0), '');
});

test('accountUnreadText: chat-only and support-only counts show through', () => {
  assert.equal(accountUnreadText(1, 0), '1');
  assert.equal(accountUnreadText(0, 2), '2');
});

test('accountUnreadText: chat + support are summed', () => {
  assert.equal(accountUnreadText(3, 1), '4');
});

test('accountUnreadText: exactly 9 shows 9, 10+ caps at 9+', () => {
  assert.equal(accountUnreadText(9, 0), '9');
  assert.equal(accountUnreadText(10, 0), '9+');
  assert.equal(accountUnreadText(5, 5), '9+');
});

test('accountUnreadText: undefined / junk counts are treated as 0 (callers may read stale state)', () => {
  assert.equal(accountUnreadText(undefined, 3), '3');
  assert.equal(accountUnreadText(null, null), '');
  assert.equal(accountUnreadText(-4, 0), '');
});
