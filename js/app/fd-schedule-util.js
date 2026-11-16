// ── FD schedule — pure helpers ───────────────────────────────────────────────
// Node-safe (no DOM / store / dispatch) so they're unit-testable. The DOM side lives in
// features/fd-schedule.js (admin builder) and staff.js (staff view). See test/fd-schedule-util.test.js.
//
// Schedule shape (per-salon config.fd_schedule / config.fd_schedule_draft):
//   { "YYYY-MM-DD": { <fdId>: {s,e} | "off" | SCHED_NONE }, _repeats: { <fdId>: { 0..6: {s,e}|"off"|null } } }
// _repeats is the LEGACY weekly pattern — read-only fallback only; new edits write explicit per-date shifts.

export const SCHED_NONE = '__none__';

// Local YYYY-MM-DD (no UTC shift).
function _iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Value-equality for a cell entry: {s,e} by fields; 'off'/SCHED_NONE/undefined by identity.
function _eqEntry(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  return a.s === b.s && a.e === b.e;
}

// Effective shift for a date on a GIVEN schedule copy (caller picks published or draft):
// explicit per-date → SCHED_NONE blanks (no fall-through) → legacy weekly repeat → null.
export function resolveFdShift(sched, dateStr, fdId) {
  sched = sched || {};
  const ex = sched[dateStr]?.[fdId];
  if (ex === SCHED_NONE) return null;
  if (ex) return ex;
  const dow = new Date(dateStr + 'T12:00:00').getDay();
  return sched._repeats?.[fdId]?.[dow] || null;
}

// The ISO dates a "Repeat next weeks" stamp writes: each selected day-of-week across `nWeeks`
// consecutive weeks starting at the Sunday `fromWeekStartStr`. Returned sorted ascending.
export function repeatForwardDates(fromWeekStartStr, nWeeks, dows) {
  const start = new Date(fromWeekStartStr + 'T12:00:00');
  start.setDate(start.getDate() - start.getDay()); // defensively snap to Sunday
  const set = new Set(dows);
  const out = [];
  for (let w = 0; w < nWeeks; w++) {
    for (let dow = 0; dow < 7; dow++) {
      if (!set.has(dow)) continue;
      const d = new Date(start);
      d.setDate(d.getDate() + w * 7 + dow);
      out.push(_iso(d));
    }
  }
  return out.sort();
}

// STRUCTURAL change for one cell: compares the EXPLICIT per-date entries (not resolved values),
// so the pill count and the grid highlight are driven by the same thing and always agree.
export function cellChangeKind(published, draft, dateStr, fdId) {
  const p = (published || {})[dateStr]?.[fdId];
  const d = (draft || {})[dateStr]?.[fdId];
  if (_eqEntry(p, d)) return null;
  if (p === undefined) return 'added';
  if (d === undefined) return 'removed';
  return 'edited';
}

// Whole-schedule structural change count (drives the "N unpublished changes" pill). Null-safe:
// a null / undefined / empty-object draft means "no draft" → 0 (a real draft is always a full
// clone of published plus edits, never bare `{}`).
export function structuralChangeCount(published, draft) {
  if (!draft || Object.keys(draft).length === 0) return 0;
  const pub = published || {};
  let count = 0;
  const dateKeys = new Set([...Object.keys(pub), ...Object.keys(draft)].filter(k => k !== '_repeats'));
  for (const date of dateKeys) {
    const fds = new Set([...Object.keys(pub[date] || {}), ...Object.keys(draft[date] || {})]);
    for (const fdId of fds) if (cellChangeKind(pub, draft, date, fdId) !== null) count++;
  }
  const pr = pub._repeats || {}, dr = draft._repeats || {};
  for (const u of new Set([...Object.keys(pr), ...Object.keys(dr)])) {
    for (const dow of new Set([...Object.keys(pr[u] || {}), ...Object.keys(dr[u] || {})])) {
      if (!_eqEntry(pr[u]?.[dow], dr[u]?.[dow])) count++;
    }
  }
  return count;
}

export function hasUnpublishedChanges(published, draft) {
  return structuralChangeCount(published, draft) > 0;
}

// Pay period containing `now`, from config.pay_period (passed in so this stays pure). Mirrors
// reports.js payPeriodDates: weekly/biweekly anchored at startDate (or the fixed 2024-01-07 Sunday),
// bimonthly = 1st–15th / 16th–end. One source of truth — reports.js consumes this too.
export function payPeriodForDate(payPeriodCfg, now = new Date()) {
  const pp = payPeriodCfg || {};
  const type = pp.type || 'weekly';
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (type === 'bimonthly') {
    if (today.getDate() <= 15) return { from: new Date(today.getFullYear(), today.getMonth(), 1), to: new Date(today.getFullYear(), today.getMonth(), 15, 23, 59, 59) };
    return { from: new Date(today.getFullYear(), today.getMonth(), 16), to: new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59) };
  }
  const len = type === 'biweekly' ? 14 : 7;
  const anchor = pp.startDate ? new Date(pp.startDate + 'T00:00:00') : new Date(2024, 0, 7);
  const utcMid = d => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const daysSince = Math.round((utcMid(today) - utcMid(anchor)) / 86400000);
  const mod = ((daysSince % len) + len) % len;
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - mod);
  const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + (len - 1), 23, 59, 59, 999);
  return { from, to };
}

// Pay-period start dates that fall within [fromStr, toStr], for drawing boundary markers.
// `periodForDate(dateStr) -> { from: Date, to: Date }` is injected (so this stays pure/testable).
export function payPeriodBoundariesInRange(periodForDate, fromStr, toStr) {
  const out = new Set();
  const to = new Date(toStr + 'T12:00:00');
  for (let d = new Date(fromStr + 'T12:00:00'); d <= to; d.setDate(d.getDate() + 1)) {
    const startIso = _iso(periodForDate(_iso(d)).from);
    if (startIso >= fromStr && startIso <= toStr) out.add(startIso);
  }
  return [...out].sort();
}
