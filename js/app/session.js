// ── Per-device session + transient UI state (NOT synced to the DO) ───────────
// activeUser, current filters, etc. are local to each device/browser tab and
// must never be written to the shared store.

import { getState } from './store.js';
import { DEFAULT_ROLE_PERMISSIONS } from './config.js';

let activeUser = null;
export function getActiveUser()   { return activeUser; }
export function setActiveUser(u)  { activeUser = u; }

// Permission check — admin passes everything; other roles use the synced
// role_permissions map, falling back to the built-in defaults when unset.
export function canDo(permission) {
  if (!activeUser) return false;
  if (activeUser.role === 'admin') return true;
  const all   = getState().config.role_permissions || {};
  const perms = all[activeUser.role] || DEFAULT_ROLE_PERMISSIONS[activeUser.role];
  return perms ? !!perms[permission] : false;
}

// Transient UI state shared across modules (not persisted, not synced).
export const ui = {
  currentFilter:   'all',   // queue filter
  showDoneInQueue: true,
  currentCheckinType: 'walkin',
};
