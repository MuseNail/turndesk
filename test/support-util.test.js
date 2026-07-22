import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TICKET_TYPES, MAX_SUBJECT, MAX_MESSAGE, MAX_THREAD,
  validateTicketInput, validateReplyInput,
  ticketKey, newTicketId, canonicalPushId,
  buildTicket, applyReply, markRead, ticketVisibleToSalon, sanitizeTicketForSalon,
} from '../cloudflare/support-util.js';

// ── validateTicketInput ──────────────────────────────────────
test('validateTicketInput accepts a good ticket', () => {
  const r = validateTicketInput({ type: 'bug', subject: '  Login broken ', message: ' It fails ' });
  assert.equal(r.ok, true);
  assert.equal(r.value.type, 'bug');
  assert.equal(r.value.subject, 'Login broken');   // trimmed
  assert.equal(r.value.message, 'It fails');        // trimmed
});

test('validateTicketInput rejects bad type', () => {
  assert.equal(validateTicketInput({ type: 'spam', subject: 'x', message: 'y' }).ok, false);
  assert.equal(validateTicketInput({ subject: 'x', message: 'y' }).ok, false);            // missing type
  for (const t of TICKET_TYPES) assert.equal(validateTicketInput({ type: t, subject: 'x', message: 'y' }).ok, true);
});

test('validateTicketInput requires subject and message', () => {
  assert.equal(validateTicketInput({ type: 'bug', subject: '', message: 'y' }).ok, false);
  assert.equal(validateTicketInput({ type: 'bug', subject: '   ', message: 'y' }).ok, false);
  assert.equal(validateTicketInput({ type: 'bug', subject: 'x', message: '' }).ok, false);
});

test('validateTicketInput enforces caps', () => {
  assert.equal(validateTicketInput({ type: 'bug', subject: 'a'.repeat(MAX_SUBJECT), message: 'y' }).ok, true);
  assert.equal(validateTicketInput({ type: 'bug', subject: 'a'.repeat(MAX_SUBJECT + 1), message: 'y' }).ok, false);
  assert.equal(validateTicketInput({ type: 'bug', subject: 'x', message: 'a'.repeat(MAX_MESSAGE) }).ok, true);
  assert.equal(validateTicketInput({ type: 'bug', subject: 'x', message: 'a'.repeat(MAX_MESSAGE + 1) }).ok, false);
});

test('validateReplyInput checks the message only', () => {
  assert.equal(validateReplyInput({ message: 'hi' }).ok, true);
  assert.equal(validateReplyInput({ message: '' }).ok, false);
  assert.equal(validateReplyInput({ message: '   ' }).ok, false);
  assert.equal(validateReplyInput({ message: 'a'.repeat(MAX_MESSAGE + 1) }).ok, false);
});

// ── ticketKey / newTicketId ──────────────────────────────────
test('ticketKey is salon-prefixed', () => {
  assert.equal(ticketKey('muse', 'tk-1'), 'ticket:muse:tk-1');
});

test('newTicketId is unique-ish and prefixed', () => {
  const a = newTicketId(1000, 'abc123');
  assert.match(a, /^tk-1000-abc123$/);
  assert.notEqual(newTicketId(1000, 'aaa'), newTicketId(1000, 'bbb'));
});

// ── canonicalPushId (resolves C2/H2 namespacing) ─────────────
test('canonicalPushId namespaces front-desk vs tech', () => {
  assert.equal(canonicalPushId({ kind: 'fd', id: '7' }), 'fd:7');
  assert.equal(canonicalPushId({ kind: 'staff', id: '7' }), '7');       // tech = raw id
  assert.equal(canonicalPushId({ kind: 'tech', id: '7' }), '7');
  assert.equal(canonicalPushId({ kind: 'appadmin', id: 'x' }), null);    // no staff push identity
  assert.equal(canonicalPushId(null), null);
  assert.equal(canonicalPushId({ id: '' }), null);
});

// ── buildTicket ──────────────────────────────────────────────
test('buildTicket stamps server fields; new ticket is unread for dev', () => {
  const t = buildTicket({
    salon: 'muse', id: 'tk-1', now: 5000,
    submitter: { kind: 'fd', id: '7', name: 'Rosa', role: 'manager' },
    type: 'bug', subject: 'Broken', message: 'It fails', appVersion: 'td-v0.49',
  });
  assert.equal(t.id, 'tk-1');
  assert.equal(t.salon, 'muse');
  assert.equal(t.submittedBy, 'Rosa');
  assert.equal(t.submitterRole, 'manager');
  assert.equal(t.submitterPushId, 'fd:7');
  assert.equal(t.appVersion, 'td-v0.49');       // diagnostic context for the dev
  assert.equal(t.type, 'bug');
  assert.equal(t.subject, 'Broken');
  assert.equal(t.status, 'open');
  assert.equal(t.unreadForDev, true);       // dev must see a brand-new ticket
  assert.equal(t.unreadForSalon, false);
  assert.equal(t.createdAt, 5000);
  assert.equal(t.updatedAt, 5000);
  assert.equal(t.messages.length, 1);
  assert.deepEqual(t.messages[0], { from: 'salon', author: 'Rosa', text: 'It fails', at: 5000 });
});

// ── applyReply — the unread state machine ────────────────────
test('salon reply flags unread-for-dev, keeps status open', () => {
  const t = buildTicket({ salon: 'muse', id: 'tk-1', now: 1, submitter: { kind: 'fd', id: '7', name: 'Rosa', role: 'manager' }, type: 'bug', subject: 's', message: 'm' });
  markRead(t, 'dev');                        // dev had read it
  assert.equal(t.unreadForDev, false);
  applyReply(t, { from: 'salon', author: 'Rosa', text: 'still broken', now: 10 });
  assert.equal(t.unreadForDev, true);        // dev must re-read
  assert.equal(t.unreadForSalon, false);
  assert.equal(t.status, 'open');
  assert.equal(t.updatedAt, 10);
  assert.equal(t.messages.length, 2);
});

test('dev reply flags unread-for-salon and sets status replied', () => {
  const t = buildTicket({ salon: 'muse', id: 'tk-1', now: 1, submitter: { kind: 'fd', id: '7', name: 'Rosa', role: 'manager' }, type: 'bug', subject: 's', message: 'm' });
  applyReply(t, { from: 'dev', author: 'You', text: 'looking into it', now: 20 });
  assert.equal(t.unreadForSalon, true);
  assert.equal(t.status, 'replied');
  assert.equal(t.updatedAt, 20);
  assert.equal(t.messages[1].from, 'dev');
});

test('applyReply caps the thread at MAX_THREAD (keeps newest)', () => {
  const t = buildTicket({ salon: 'muse', id: 'tk-1', now: 1, submitter: { kind: 'fd', id: '7', name: 'Rosa', role: 'manager' }, type: 'bug', subject: 's', message: 'm0' });
  for (let i = 1; i <= MAX_THREAD + 5; i++) applyReply(t, { from: 'salon', author: 'Rosa', text: 'm' + i, now: 1 + i });
  assert.equal(t.messages.length, MAX_THREAD);
  assert.equal(t.messages[t.messages.length - 1].text, 'm' + (MAX_THREAD + 5));   // newest kept
});

// ── markRead ─────────────────────────────────────────────────
test('markRead clears the right side only', () => {
  const t = buildTicket({ salon: 'muse', id: 'tk-1', now: 1, submitter: { kind: 'fd', id: '7', name: 'Rosa', role: 'manager' }, type: 'bug', subject: 's', message: 'm' });
  applyReply(t, { from: 'dev', author: 'You', text: 'r', now: 2 });   // unreadForSalon=true, unreadForDev=true(from build)
  markRead(t, 'salon');
  assert.equal(t.unreadForSalon, false);
  assert.equal(t.unreadForDev, true);
  markRead(t, 'dev');
  assert.equal(t.unreadForDev, false);
});

// ── isolation (resolves Q2/M4) ───────────────────────────────
test('ticketVisibleToSalon enforces exact salon match', () => {
  const t = buildTicket({ salon: 'muse', id: 'tk-1', now: 1, submitter: { kind: 'fd', id: '7', name: 'Rosa', role: 'manager' }, type: 'bug', subject: 's', message: 'm' });
  assert.equal(ticketVisibleToSalon(t, 'muse'), true);
  assert.equal(ticketVisibleToSalon(t, 'other'), false);
  assert.equal(ticketVisibleToSalon(t, ''), false);
  assert.equal(ticketVisibleToSalon(null, 'muse'), false);
});

test('sanitizeTicketForSalon drops nothing needed but is stable', () => {
  const t = buildTicket({ salon: 'muse', id: 'tk-1', now: 1, submitter: { kind: 'fd', id: '7', name: 'Rosa', role: 'manager' }, type: 'bug', subject: 's', message: 'm' });
  const s = sanitizeTicketForSalon(t);
  // salon-facing view keeps the thread + status but not internal push id
  assert.equal(s.submitterPushId, undefined);
  assert.equal(s.id, 'tk-1');
  assert.equal(s.messages.length, 1);
  assert.equal(s.unreadForSalon, false);
});
