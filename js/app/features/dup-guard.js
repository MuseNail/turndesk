// ── Duplicate check-in guard (pure matching) ─────────────────────────────────
// Finds tickets already on today's board for the same phone, so the front desk can be warned
// before double-adding a customer (the failure the offline outage caused). PURE — no store/sync/DOM
// imports (importing those boots the WebSocket and hangs node tests), so the phone normalizer is
// INJECTED (glue passes notePhoneKey). Reads the LIVE queue only: paid tickets stay on the board all
// day (removed at rollover), so the queue covers both open and recently-paid without a records scan.
//
// NOTE (scope): this reads THIS device's board, so it catches same-device re-adds and anything after
// sync catches up — NOT a re-add on a second device while offline (that needs a server-side guard).

export const DEFAULT_MIN_KEY_LEN = 10;   // require a real 10-digit number; blank/short/placeholder → no match
const PAID = new Set(['paid', 'done']);  // mirrors status.js isPaidStatus

const paidAtMs = e => {
  if (typeof e.completedAt === 'number') return e.completedAt;
  if (e.completedAt) { const t = Date.parse(e.completedAt); if (!Number.isNaN(t)) return t; }
  if (typeof e.statusSince === 'number') return e.statusSince;
  return null;
};

// { phoneKey, queue, nowMs, paidWindowMs, minKeyLen?, excludeIds?, normalize } → { open:[], recentlyPaid:[] }
// phoneKey is the already-normalized key of the NEW customer; normalize is applied to each scanned
// entry's phone so the comparison is formatting-insensitive.
export function findDuplicateCheckins({ phoneKey, queue, nowMs, paidWindowMs, minKeyLen = DEFAULT_MIN_KEY_LEN, excludeIds = [], normalize }) {
  const out = { open: [], recentlyPaid: [] };
  if (!phoneKey || String(phoneKey).length < minKeyLen) return out;
  const exclude = new Set((excludeIds || []).map(String));
  const norm = typeof normalize === 'function' ? normalize : (x => x);
  for (const e of (queue || [])) {
    if (!e || exclude.has(String(e.id)) || e.status === 'deleted') continue;
    if (norm(e.phone || '') !== phoneKey) continue;
    const match = {
      id: e.id, name: e.name, status: e.status, checkinTime: e.checkinTime,
      completedAt: e.completedAt || null,
      techIds: (e.assignments || []).map(a => a.techId).filter(Boolean),
      services: e.services || [],
    };
    if (PAID.has(e.status)) {
      const at = paidAtMs(e);
      if (at != null && (nowMs - at) <= paidWindowMs) out.recentlyPaid.push({ ...match, paidAt: at });
    } else {
      out.open.push(match);
    }
  }
  return out;
}
