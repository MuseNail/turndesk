// ── Front-desk → kiosk check-in waiver handoff (pure helpers) ────────────────
// The front desk builds a check-in, then Sends it to the designated check-in kiosk; the
// customer reviews their name + masked phone on the kiosk and checks the acknowledgment box
// (their e-signature) — only THEN is the queue entry created + the waiver saved.
//
// Transport: a single synced config key `kiosk_handoff` broadcast live via config.set. It is
// one of two shapes:
//   pending:   { nonce, targetDevice, byDevice, byUser, ts, primaryIndex, entries:[<finished queue entry>] }
//   tombstone: { done:<nonce>, result:'confirmed'|'cancelled'|'expired'|'takeover', ts }
//
// Two invariants keep it safe:
//  1. The desk ships FINISHED queue entries (parity by construction), each with a DETERMINISTIC
//     id keyed to the nonce → a re-Confirm upserts the same rows / overwrites the same waiver
//     key → idempotent (no double check-in).
//  2. It is cleared to a TOMBSTONE, never null — null is skipped by the hydrate overlay
//     (store.js), so a null clear would not survive a snapshot re-hydrate (stuck kiosk window);
//     the tombstone also lets the desk tell confirmed from expired/cancelled.
//
// This module is pure (no browser/DOM/dispatch) so it is unit-testable in node and safe to
// import from both the front-desk and kiosk glue in checkin/queue.
import { signerDisplayName } from '../waiver-util.js';

export const HANDOFF_TTL_MS = 4 * 60 * 1000;   // a pending handoff older than this is stale

// Deterministic ids — generated once at Send, reused verbatim on Confirm so an outbox
// replay / double-tap / reload collapses onto the same queue rows + waiver record.
export function handoffNonce(now, rand) { return 'ho-' + now + '-' + rand; }
export function handoffEntryId(nonce, i) { return 'hoff-' + nonce + '-' + i; }
export function handoffWaiverId(nonce) { return 'wv-' + nonce; }

// Mask a guest's phone to the last 4 (all the kiosk ever shows). Tolerant of formatting;
// masks whatever digits exist when fewer than 4 (never reveals more than the last 4).
export function handoffMasked(guest) {
  const p = String((guest && guest.phone) || '').replace(/\D/g, '');
  if (!p) return '';
  return '••••' + p.slice(-4);
}

export function handoffTombstone(nonce, result, now) { return { done: nonce, result, ts: now }; }
export function handoffIsTombstone(h) { return !!(h && h.done); }
export function handoffResult(h) { return h && h.done ? (h.result || 'cleared') : null; }

// A handoff the kiosk should act on: pending (not a tombstone), has entries, within TTL.
export function handoffFresh(h, nowMs, ttlMs = HANDOFF_TTL_MS) {
  if (!h || h.done) return false;
  if (!Array.isArray(h.entries) || h.entries.length === 0) return false;
  if (typeof h.ts !== 'number') return false;
  return (nowMs - h.ts) <= ttlMs;
}

export function buildHandoff(entries, targetDevice, byUser, byDevice, nonce, now) {
  return { nonce, targetDevice, byDevice, byUser: byUser || null, ts: now, primaryIndex: 0, entries: entries || [] };
}

const primaryEntry = h => (h && Array.isArray(h.entries)) ? h.entries[h.primaryIndex || 0] : null;

// The e-sign display name for the primary (first + last-initial). Delegates to signerDisplayName
// so the on-screen "Signing as" exactly matches the signerDisplay stored on the legal record.
export function handoffPrimaryName(h) {
  const e = primaryEntry(h);
  const parts = String((e && e.name) || '').trim().split(/\s+/).filter(Boolean);
  return signerDisplayName(parts[0] || '', parts.slice(1).join(' '));
}

export function handoffMultiGuest(h) { return !!(h && Array.isArray(h.entries) && h.entries.length > 1); }
