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
export function applyEntryStatus(entry) {
  const prev = entry.status;
  const next = deriveEntryStatus(entry);
  if (next !== prev) entry.statusSince = Date.now();
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
  a.status = newStatus;
}

export function setAssignmentStatus(entry, serviceId, newStatus) {
  if (!entry.assignments) entry.assignments = [];
  const a = entry.assignments.find(x => x.serviceId === serviceId);
  if (a) applyAssignmentStatus(a, newStatus);
  applyEntryStatus(entry);
  dispatch('queue.upsert', { entry });
  if (entry.status === 'paid') window.saveRecord?.(entry);   // finalize the sale only at Paid
  window.renderQueue?.(); window.updateStats?.(); window.renderTurns?.(); window.renderFloorPlan?.();
}
