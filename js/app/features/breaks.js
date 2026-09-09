// ── Break time-blocks (pure helpers) ────────────────────────────────────────
// Two shapes, both stored in synced config lists:
//   one-off  cfg().breaks       = { id, staffId, start(ISO), end(ISO), label }
//   rule     cfg().break_rules  = { id, staffId, startMin, durMin, label, weekdays:[0-6 Sun..Sat],
//                                   from:'YYYY-MM-DD', until:'YYYY-MM-DD'|'', skips:[dateStr],
//                                   overrides:{ dateStr:{ startMin?, durMin?, label? } } }
// A rule repeats on its weekdays between `from` and `until` (blank until = forever); a single day
// can be skipped (skips) or overridden (overrides). Breaks grey the tech's calendar column and
// flag them "On Break" in Assign & Price while active; they do NOT touch the Turns rotation.
// Pure + dependency-free → unit-tested in isolation; callers pass cfg().breaks / cfg().break_rules.

// Local YYYY-MM-DD for a Date (matches utils.localDateStr's format; kept inline to stay dep-free).
function _dstr(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

// The concrete { startMin, durMin, label } a rule produces on `dayStr` (weekday 0-6), or null when
// it doesn't apply that day (wrong weekday, out of [from,until], skipped). Applies an override.
export function ruleOccurrence(rule, dayStr, weekday) {
  if (!rule || !Array.isArray(rule.weekdays) || !rule.weekdays.includes(weekday)) return null;
  if (rule.from && dayStr < rule.from) return null;
  if (rule.until && dayStr > rule.until) return null;
  if ((rule.skips || []).includes(dayStr)) return null;
  const ov = (rule.overrides || {})[dayStr] || null;
  return {
    startMin: ov && ov.startMin != null ? ov.startMin : rule.startMin,
    durMin: ov && ov.durMin != null ? ov.durMin : rule.durMin,
    label: ov && ov.label != null ? ov.label : (rule.label || 'Break'),
  };
}

// All break instances for a tech on one day (one-offs falling on the day + rule occurrences),
// start-sorted, for rendering the greyed bands. Each row is kind-tagged so the click handler knows
// whether it's a one-off (id) or a recurring occurrence (ruleId + dayStr).
export function breakInstancesForDay(oneOffs, rules, staffId, dayStr, weekday, dayStartMs) {
  const sid = String(staffId == null ? '' : staffId);
  const out = [];
  (oneOffs || []).forEach(b => {
    if (!b || String(b.staffId) !== sid) return;
    const s = new Date(b.start), e = new Date(b.end);
    if (isNaN(s) || isNaN(e)) return;
    if (+s < dayStartMs || +s >= dayStartMs + 86400000) return;   // starts on this day
    out.push({ kind: 'once', id: b.id, startMin: s.getHours() * 60 + s.getMinutes(), durMin: Math.max(Math.round((e - s) / 60000), 15), label: b.label || 'Break' });
  });
  (rules || []).forEach(r => {
    if (!r || String(r.staffId) !== sid) return;
    const occ = ruleOccurrence(r, dayStr, weekday);
    if (occ) out.push({ kind: 'rule', ruleId: r.id, dayStr, startMin: occ.startMin, durMin: occ.durMin, label: occ.label });
  });
  out.sort((a, b) => a.startMin - b.startMin);
  return out;
}

// Is this tech inside a break window right now (default: current time)? Checks one-offs + today's
// rule occurrences. Drives the "· On Break" flag in the Assign & Price tech picker.
export function staffOnBreakNow(oneOffs, rules, staffId, atMs = Date.now()) {
  const sid = String(staffId == null ? '' : staffId);
  const oneActive = (oneOffs || []).some(b => {
    if (!b || String(b.staffId) !== sid) return false;
    const s = +new Date(b.start), e = +new Date(b.end);
    return isFinite(s) && isFinite(e) && s <= atMs && atMs < e;
  });
  if (oneActive) return true;
  const now = new Date(atMs), dayStr = _dstr(now), weekday = now.getDay();
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  return (rules || []).some(r => {
    if (!r || String(r.staffId) !== sid) return false;
    const occ = ruleOccurrence(r, dayStr, weekday);
    if (!occ) return false;
    const start = +dayStart + occ.startMin * 60000;
    return atMs >= start && atMs < start + occ.durMin * 60000;
  });
}
