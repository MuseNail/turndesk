// ── Per-service / entry status helpers (shared by queue + turns) ────────────
// Kept dependency-light (store + sync only) so queue.js and turns.js can both
// import it without an import cycle.

import { dispatch } from '../sync.js';

// Flow: waiting → inservice → complete → paid.
//   complete = service finished, payment pending (still active; tech earned the turn).
//   paid     = finalized sale (record created, counts in Reports, leaves the floor).
// 'done' is the LEGACY finalized status — treated everywhere as equivalent to 'paid'.
export function getAssignmentStatus(entry, assignment) {
  return assignment.status || 'waiting';
}
// Finalized = money collected / archived. Accepts legacy 'done'.
export const isPaidStatus = s => s === 'paid' || s === 'done';

// "Awaiting price" is a DISPLAY sub-state of complete: the service is finished but the front
// desk marked it "Done — tech will price," so it has no price yet (a.awaitingPrice). The
// assignment's real status stays 'complete' (so it counts as done and leaves the in-service
// flow); this only changes the pill/visual + gates checkout. Route every per-service
// serviceLineStyle() call through this so all surfaces show the violet "Awaiting price" pill.
export function isAwaitingPrice(a) { return !!(a && a.awaitingPrice && (a.status === 'complete')); }
export function effectiveServiceStatus(entry, a) {
  const s = getAssignmentStatus(entry, a);
  return (s === 'complete' && a && a.awaitingPrice) ? 'awaiting' : s;
}
// Entry-level counterpart to isAwaitingPrice: the whole ticket is finished (entry.status
// 'complete') but at least one done service still has no price, so checkout is gated. Lets the
// Turns customer card show the violet "Awaiting price" signal (avatar bubble + border/tint)
// instead of the blue "Done" — otherwise an unpriced ticket looks identical to a ready-to-pay one.
export function isEntryAwaitingPrice(entry) {
  return !!(entry && entry.status === 'complete' && (entry.assignments || []).some(isAwaitingPrice));
}
export function effectiveEntryStatus(entry) {
  return isEntryAwaitingPrice(entry) ? 'awaiting' : ((entry && entry.status) || 'waiting');
}

export function deriveEntryStatus(entry) {
  if (!entry.assignments || entry.assignments.length === 0) return entry.status || 'waiting';
  const ss = entry.assignments.map(a => getAssignmentStatus(entry, a));
  if (ss.some(s => s === 'inservice')) return 'inservice';
  if (ss.every(isPaidStatus)) return 'paid';
  if (ss.every(s => s === 'complete' || isPaidStatus(s))) return 'complete';
  return 'waiting';
}

// Set entry.status from its assignments AND stamp entry.statusSince when the
// status actually changes, so views can show a timer that resets per status
// (waiting → inservice → complete). Call this instead of assigning entry.status
// directly, BEFORE dispatching, so statusSince syncs to every device.
// Pass isRevert=true when CORRECTING a mistake (moving a status backward) so the visible
// per-status timer isn't reset to now — instead it's restored from the anchor saved before the
// (mistaken) forward transition. One level of undo, which is all a correction needs.
export function applyEntryStatus(entry, isRevert) {
  const prev = entry.status;
  const next = deriveEntryStatus(entry);
  if (next !== prev) {
    if (isRevert && entry.prevStatusSince != null) {
      entry.statusSince = entry.prevStatusSince;   // correction → restore the pre-mistake timer
    } else {
      entry.prevStatusSince = entry.statusSince;   // remember the anchor so a later revert can restore it
      entry.statusSince = Date.now();
    }
  }
  entry.status = next;
  return next;
}
// ms timestamp the entry entered its current status (falls back to check-in =
// waiting start for entries that haven't transitioned yet).
export function entryStatusSince(entry) {
  return entry.statusSince || (entry.checkinTime ? new Date(entry.checkinTime).getTime() : Date.now());
}

// Per-assignment in-service clock. Accumulates the time THIS service spent
// "In Service" into a.serviceMs across however many spells (so "Back to In
// Service" then "Complete" again adds correctly), tracking the current spell's
// start in a.svcStartedAt. Both fields ride along on the assignment object, so
// they sync to every device and persist onto the saved record automatically.
// Call this instead of assigning a.status directly so timing is never missed.
export function applyAssignmentStatus(a, newStatus) {
  if (!a) return;
  const prev = a.status || 'waiting';
  if (prev !== 'inservice' && newStatus === 'inservice') {
    a.svcStartedAt = Date.now();
  } else if (prev === 'inservice' && newStatus !== 'inservice' && a.svcStartedAt) {
    a.serviceMs = (a.serviceMs || 0) + (Date.now() - a.svcStartedAt);
    a.svcStartedAt = 0;
  }
  // "Awaiting price" only means anything while a service is complete-but-unpriced — any move
  // off complete (reopen, revert) resolves it so a stale flag can't linger.
  if (newStatus !== 'complete') a.awaitingPrice = false;
  a.status = newStatus;
  a.updatedAt = Date.now();   // per-assignment version → drives the per-assignment merge in queue.upsert (3c)
}

// Per-service-status visual tokens for the queue / turns / floor-plan cards — one source of
// truth so all three surfaces match. Each status carries THREE redundant cues (color-blind safe):
// a colored glyph shape, a tiny text pill, and a row accent. Only in-service gets the loud
// bar+tint ("the hot row"); paid fades. Palette = the staff-app STATUS_CHIP values.
// `dot` = the per-status fill for a CSS-DRAWN circle (not a text glyph): a solid colored dot per
// status. Drawing the circle keeps every status the EXACT same diameter — Unicode glyphs
// (● vs ◍) render at different sizes.
// Render it as: <span style="display:inline-block;width:.8em;height:.8em;border-radius:50%;box-sizing:border-box;{dot}"></span>
// One vocabulary + one filled-pill palette everywhere (C9/D13; recolored v4.79):
// Waiting (amber) · In Service (green = actively working) · Done (blue = finished, awaiting
// payment) · Paid (slate). Green/blue (not teal/green) so In Service and Done read as clearly
// different on the busy Turns board.
export function serviceLineStyle(status) {
  if (isPaidStatus(status))    return { key: 'paid',      dot: 'background:#8a9298', bar: '#8a9298', tint: '',                    pill: { bg: '#5b6166', fg: '#ffffff', label: 'Paid'       }, rowOpacity: 0.6 };
  if (status === 'inservice')  return { key: 'inservice', dot: 'background:#2a7a4f', bar: '#2a7a4f', tint: 'rgba(42,122,79,.08)', pill: { bg: '#2a7a4f', fg: '#ffffff', label: 'In Service' }, rowOpacity: 1 };
  if (status === 'complete')   return { key: 'complete',  dot: 'background:#1a5c7a', bar: '#1a5c7a', tint: '',                    pill: { bg: '#1a5c7a', fg: '#ffffff', label: 'Done'       }, rowOpacity: 1 };
  if (status === 'awaiting')   return { key: 'awaiting',  dot: 'background:#6b4fb0', bar: '#6b4fb0', tint: 'rgba(107,79,176,.08)', pill: { bg: '#6b4fb0', fg: '#ffffff', label: 'Awaiting price' }, rowOpacity: 1 };
  return                              { key: 'waiting',   dot: 'background:#d4860a', bar: '#d4860a', tint: '',                    pill: { bg: '#f5c870', fg: '#3a2800', label: 'Waiting'    }, rowOpacity: 0.9 };
}

export function setAssignmentStatus(entry, serviceId, newStatus, isRevert) {
  if (!entry.assignments) entry.assignments = [];
  const a = entry.assignments.find(x => x.serviceId === serviceId);
  if (a) applyAssignmentStatus(a, newStatus);
  applyEntryStatus(entry, isRevert);
  dispatch('queue.upsert', { entry });
  if (entry.status === 'paid') window.saveRecord?.(entry);   // finalize the sale only at Paid
  window.renderQueue?.(); window.updateStats?.(); window.renderTurns?.(); window.renderFloorPlan?.();
}
