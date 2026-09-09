import test from 'node:test';
import assert from 'node:assert/strict';
import { staffOnBreakNow, breakInstancesForDay, ruleOccurrence } from '../js/app/features/breaks.js';

// Breaks come in two shapes:
//   one-off: { id, staffId, start(ISO), end(ISO), label }
//   rule:    { id, staffId, startMin, durMin, label, weekdays:[0-6], from, until, skips:[dateStr], overrides:{ dateStr:{startMin,durMin,label} } }
// Sep 10 2026 is a THURSDAY (getDay() === 4).
const oneOff = (o) => ({ id: o.id, staffId: o.staffId, start: o.start, end: o.end, label: o.label || 'Break' });
const rule = (o) => ({ id: o.id, staffId: o.staffId, startMin: o.startMin, durMin: o.durMin, label: o.label || 'Break', weekdays: o.weekdays, from: o.from || '', until: o.until || '', skips: o.skips || [], overrides: o.overrides || {} });
const iso = (h, m = 0) => { const d = new Date('2026-09-10T00:00:00'); d.setHours(h, m, 0, 0); return d.toISOString(); };
const atMs = (h, m = 0, dayOffset = 0) => { const d = new Date('2026-09-10T00:00:00'); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return +d; };
const THU = 4, FRI = 5;

// ── ruleOccurrence ──────────────────────────────
test('ruleOccurrence: weekday gate + from/until bounds + skips + overrides', () => {
  const r = rule({ id: 'r1', staffId: 's1', startMin: 720, durMin: 60, label: 'Lunch', weekdays: [THU, FRI], from: '2026-09-01', until: '2026-09-30' });
  assert.deepEqual(ruleOccurrence(r, '2026-09-10', THU), { startMin: 720, durMin: 60, label: 'Lunch' });   // Thursday, in range
  assert.equal(ruleOccurrence(r, '2026-09-09', 3), null);            // Wednesday — weekday not in set
  assert.equal(ruleOccurrence(r, '2026-08-27', THU), null);          // before `from`
  assert.equal(ruleOccurrence(r, '2026-10-01', THU), null);          // after `until`
  assert.equal(ruleOccurrence(rule({ id: 'r2', staffId: 's1', startMin: 720, durMin: 60, weekdays: [THU], skips: ['2026-09-10'] }), '2026-09-10', THU), null);   // skipped
});
test('ruleOccurrence: override changes just that date; blank until = forever', () => {
  const r = rule({ id: 'r3', staffId: 's1', startMin: 720, durMin: 60, label: 'Lunch', weekdays: [THU], overrides: { '2026-09-10': { startMin: 780, durMin: 30, label: 'Late lunch' } } });
  assert.deepEqual(ruleOccurrence(r, '2026-09-10', THU), { startMin: 780, durMin: 30, label: 'Late lunch' });   // overridden
  assert.deepEqual(ruleOccurrence(r, '2026-09-17', THU), { startMin: 720, durMin: 60, label: 'Lunch' });        // a later Thursday → rule default, no until
});

// ── breakInstancesForDay ────────────────────────
test('breakInstancesForDay: one-offs on the day + rule occurrences, kind-tagged, sorted', () => {
  const dayStartMs = atMs(0, 0);
  const oneOffs = [
    oneOff({ id: 'o1', staffId: 's1', start: iso(15), end: iso(15, 30), label: 'Coffee' }),
    oneOff({ id: 'o2', staffId: 's2', start: iso(15), end: iso(15, 30) }),                 // other tech
    oneOff({ id: 'o3', staffId: 's1', start: '2026-09-11T15:00:00.000Z', end: '2026-09-11T15:30:00.000Z' }), // other day
  ];
  const rules = [rule({ id: 'r1', staffId: 's1', startMin: 720, durMin: 60, label: 'Lunch', weekdays: [THU] })];
  const rows = breakInstancesForDay(oneOffs, rules, 's1', '2026-09-10', THU, dayStartMs);
  assert.deepEqual(rows.map(r => [r.kind, r.label]), [['rule', 'Lunch'], ['once', 'Coffee']]);   // 12:00 rule before 15:00 one-off
  assert.equal(rows[0].ruleId, 'r1');
  assert.equal(rows[1].id, 'o1');
});

// ── staffOnBreakNow ─────────────────────────────
test('staffOnBreakNow: true for an active one-off OR an active rule occurrence', () => {
  const oneOffs = [oneOff({ id: 'o1', staffId: 's1', start: iso(9), end: iso(9, 30) })];
  const rules = [rule({ id: 'r1', staffId: 's1', startMin: 720, durMin: 60, weekdays: [THU] })];   // 12:00-13:00 Thursdays
  assert.equal(staffOnBreakNow(oneOffs, rules, 's1', atMs(9, 15)), true);    // inside one-off
  assert.equal(staffOnBreakNow(oneOffs, rules, 's1', atMs(12, 30)), true);   // inside rule occurrence (Thu)
  assert.equal(staffOnBreakNow(oneOffs, rules, 's1', atMs(13, 0)), false);   // rule end exclusive
  assert.equal(staffOnBreakNow(oneOffs, rules, 's1', atMs(12, 30, 1)), false); // next day is Friday — rule only Thursdays
  assert.equal(staffOnBreakNow(oneOffs, rules, 's2', atMs(12, 30)), false);  // other tech
  assert.equal(staffOnBreakNow([], [], 's1', atMs(12, 30)), false);          // nothing
});
test('staffOnBreakNow: a skipped day is not "on break"', () => {
  const rules = [rule({ id: 'r1', staffId: 's1', startMin: 720, durMin: 60, weekdays: [THU], skips: ['2026-09-10'] })];
  assert.equal(staffOnBreakNow([], rules, 's1', atMs(12, 30)), false);
});
