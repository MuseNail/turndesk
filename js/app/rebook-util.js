// ── Book-next-appointment (rebook) — pure helpers ────────────────────────────
// Node-safe (no DOM, no imports from DOM modules) so they can be unit-tested directly.
// The DOM side lives in features/rebook.js, mirroring the notif-util.js / notifications.js split.

// First token → first name, the rest → last name. Whitespace trimmed and collapsed.
export function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') };
}

// Offer the rebook prompt only for a real, bookable SERVICE visit on the checkout device:
// the setting is on (default ON unless explicitly false), the ticket has a customer name,
// it is not a Quick Sale, and it carries at least one service (so gift-card-page sales and
// retail-only tickets don't prompt — you rebook a service visit, not a purchase).
export function shouldOfferRebook(entry, cfg) {
  if (!entry) return false;
  if ((cfg || {}).rebook_prompt === false) return false;
  if (entry.quickSale) return false;
  if (!String(entry.name || '').trim()) return false;
  if (!((entry.services || []).length > 0)) return false;
  return true;
}
