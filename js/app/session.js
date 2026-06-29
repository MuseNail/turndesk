// ── Per-device session + transient UI state (NOT synced to the DO) ───────────
// activeUser, current filters, etc. are local to each device/browser tab and
// must never be written to the shared store.

import { getState } from './store.js';
import { DEFAULT_ROLE_PERMISSIONS } from './config.js';

let activeUser = null;
export function getActiveUser()   { return activeUser; }
export function setActiveUser(u)  { activeUser = u; }

// Permission check — admin passes everything; other roles use the synced
// role_permissions map merged over the built-in defaults PER KEY, so a permission
// added after the salon last saved its map still gets its default until toggled
// (a saved map that predates a key must not silently read as "off").
export function canDo(permission) {
  if (!activeUser) return false;
  if (activeUser.role === 'admin') return true;
  const stored = (getState().config.role_permissions || {})[activeUser.role];
  const perms  = { ...(DEFAULT_ROLE_PERMISSIONS[activeUser.role] || {}), ...(stored || {}) };
  return !!perms[permission];
}

// Transient UI state shared across modules (not persisted, not synced).
export const ui = {
  currentFilter:   'all',   // queue filter
  showDoneInQueue: true,
  currentCheckinType: 'walkin',
};
