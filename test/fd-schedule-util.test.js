// Pure helpers behind the FD schedule draft/publish + bounded-repeat work.
import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHED_NONE,
  resolveFdShift,
  repeatForwardDates,
  cellChangeKind,
  structuralChangeCount,
  hasUnpublishedChanges,
  payPeriodBoundariesInRange,
  payPeriodForDate,
  weekBandTitle,
} from '../js/app/fd-schedule-util.js';

// ── resolveFdShift: mirrors getFdShift exactly (per-date → SCHED_NONE→null → legacy repeat) ──
const REPEAT = { _repeats: { u: { 1: { s: '09:00', e: '17:00' } } } }; // Monday repeat for user u

test('resolveFdShift: explicit shift wins over the repeat', () => {
  const sched = { '2026-11-30': { u: { s: '10:00', e: '18:00' } }, ...REPEAT };
  assert.deepEqual(resolveFdShift(sched, '2026-11-30', 'u'), { s: '10:00', e: '18:00' });
});
test('resolveFdShift: explicit "off" is returned', () => {
  assert.equal(resolveFdShift({ '2026-11-30': { u: 'off' } }, '2026-11-30', 'u'), 'off');
});
test('resolveFdShift: SCHED_NONE returns null and does NOT fall through to a legacy repeat', () => {
  const sched = { '2026-11-30': { u: SCHED_NONE }, ...REPEAT }; // Nov 30 2026 is a Monday
  assert.equal(resolveFdShift(sched, '2026-11-30', 'u'), null);
});
test('resolveFdShift: falls back to the legacy repeat when no per-date entry', () => {
  assert.deepEqual(resolveFdShift(REPEAT, '2026-11-30', 'u'), { s: '09:00', e: '17:00' }); // Monday
});
test('resolveFdShift: null when nothing is set', () => {
  assert.equal(resolveFdShift(REPEAT, '2026-12-01', 'u'), null); // Tuesday, no repeat
  assert.equal(resolveFdShift({}, '2026-11-30', 'u'), null);
});

// ── repeatForwardDates: this week + next 3, selected days-of-week, crossing months ──
test('repeatForwardDates: 4 weeks of Mon+Wed from the week of Sun 2026-11-29, crossing into December', () => {
  const got = repeatForwardDates('2026-11-29', 4, [1, 3]);
  assert.deepEqual(got, [
    '2026-11-30', '2026-12-02', // week 0: Mon, Wed
    '2026-12-07', '2026-12-09', // week 1
    '2026-12-14', '2026-12-16', // week 2
    '2026-12-21', '2026-12-23', // week 3
  ]);
});

// ── cellChangeKind: STRUCTURAL diff of explicit entries (so pill & grid agree) ──
test('cellChangeKind: added / removed / edited / null', () => {
  const pub = { '2026-11-30': { u: { s: '09:00', e: '17:00' } } };
  const drf = { '2026-11-30': { u: { s: '10:00', e: '18:00' } } };
  assert.equal(cellChangeKind({}, drf, '2026-11-30', 'u'), 'added');
  assert.equal(cellChangeKind(pub, {}, '2026-11-30', 'u'), 'removed');
  assert.equal(cellChangeKind(pub, drf, '2026-11-30', 'u'), 'edited');
  assert.equal(cellChangeKind(pub, pub, '2026-11-30', 'u'), null);
});
test('cellChangeKind: a draft cell whose value equals the legacy-resolved value is still "added" (structural)', () => {
  const pub = { _repeats: { u: { 1: { s: '09:00', e: '17:00' } } } };          // Monday repeat, no explicit
  const drf = { '2026-11-30': { u: { s: '09:00', e: '17:00' } }, _repeats: { u: { 1: { s: '09:00', e: '17:00' } } } };
  assert.equal(cellChangeKind(pub, drf, '2026-11-30', 'u'), 'added');
});

// ── structuralChangeCount: whole-schedule, null-safe, counts every stamped cell ──
test('structuralChangeCount: 0 for null / empty / equal drafts', () => {
  const pub = { '2026-11-30': { u: { s: '09:00', e: '17:00' } } };
  assert.equal(structuralChangeCount(pub, null), 0);
  assert.equal(structuralChangeCount(pub, {}), 0);
  assert.equal(structuralChangeCount(pub, JSON.parse(JSON.stringify(pub))), 0);
});
test('structuralChangeCount: counts added/edited cells and a changed repeat entry', () => {
  const pub = { '2026-11-30': { u: { s: '09:00', e: '17:00' } }, _repeats: { u: { 2: { s: '09:00', e: '17:00' } } } };
  const drf = {
    '2026-11-30': { u: { s: '10:00', e: '18:00' } }, // edited
    '2026-12-01': { u: { s: '09:00', e: '17:00' } }, // added
    _repeats: { u: { 2: { s: '08:00', e: '16:00' } } }, // changed repeat
  };
  assert.equal(structuralChangeCount(pub, drf), 3);
});
test('structuralChangeCount: counts an edit on a date far outside any view window', () => {
  const pub = {};
  const drf = { '2030-01-01': { u: { s: '09:00', e: '17:00' } } };
  assert.equal(structuralChangeCount(pub, drf), 1);
});
test('structuralChangeCount: counts every cell a repeat-forward stamp wrote over a legacy-pattern salon', () => {
  const pub = { _repeats: { u: { 1: { s: '09:00', e: '17:00' }, 3: { s: '09:00', e: '17:00' } } } };
  const drf = JSON.parse(JSON.stringify(pub));
  for (const d of repeatForwardDates('2026-11-29', 4, [1, 3])) { drf[d] = { u: { s: '09:00', e: '17:00' } }; }
  assert.equal(structuralChangeCount(pub, drf), 8);
});
test('hasUnpublishedChanges: mirrors structuralChangeCount > 0', () => {
  assert.equal(hasUnpublishedChanges({ a: { u: 'off' } }, null), false);
  assert.equal(hasUnpublishedChanges({}, { '2026-11-30': { u: 'off' } }), true);
});

// ── payPeriodBoundariesInRange: period starts inside [from,to], via injected periodForDate ──
const mkPeriod = (dateStr) => { // 14-day periods anchored at 2026-11-16
  const anchor = new Date('2026-11-16T12:00:00');
  const d = new Date(dateStr + 'T12:00:00');
  const idx = Math.floor(Math.round((d - anchor) / 86400000) / 14);
  const from = new Date(anchor); from.setDate(from.getDate() + idx * 14);
  const to = new Date(from); to.setDate(to.getDate() + 13);
  return { from, to };
};
test('payPeriodBoundariesInRange: boundary inside the window', () => {
  assert.deepEqual(payPeriodBoundariesInRange(mkPeriod, '2026-11-16', '2026-11-29'), ['2026-11-16']);
  assert.deepEqual(payPeriodBoundariesInRange(mkPeriod, '2026-11-23', '2026-12-06'), ['2026-11-30']);
});
test('payPeriodBoundariesInRange: empty when no period start falls inside', () => {
  assert.deepEqual(payPeriodBoundariesInRange(mkPeriod, '2026-11-17', '2026-11-29'), []);
});

// ── payPeriodForDate: mirrors reports.js payPeriodDates, taking the config as an argument ──
test('payPeriodForDate: weekly (no startDate) → Sunday-aligned 7-day window containing the date', () => {
  const p = payPeriodForDate({ type: 'weekly' }, new Date(2026, 10, 18)); // Nov 18 2026
  assert.equal(p.from.getDay(), 0, 'from is a Sunday (anchor 2024-01-07)');
  assert.ok(p.from <= new Date(2026, 10, 18) && new Date(2026, 10, 18) <= p.to);
  assert.equal(Math.floor((p.to - p.from) / 86400000), 6); // from 00:00 day0 .. 23:59 day6 → 6 full days + EOD
});
test('payPeriodForDate: biweekly → 14-day window', () => {
  const p = payPeriodForDate({ type: 'biweekly' }, new Date(2026, 10, 18));
  assert.equal(Math.floor((p.to - p.from) / 86400000), 13);
});
test('payPeriodForDate: bimonthly → 1st–15th and 16th–end-of-month', () => {
  const a = payPeriodForDate({ type: 'bimonthly' }, new Date(2026, 10, 10));
  assert.equal(a.from.getDate(), 1); assert.equal(a.to.getDate(), 15);
  const b = payPeriodForDate({ type: 'bimonthly' }, new Date(2026, 10, 20));
  assert.equal(b.from.getDate(), 16); assert.equal(b.to.getMonth(), 10); assert.equal(b.to.getDate(), 30);
});
test('payPeriodForDate: a configured startDate wins as the anchor', () => {
  const p = payPeriodForDate({ type: 'weekly', startDate: '2026-11-16' }, new Date(2026, 10, 18));
  assert.equal(p.from.getFullYear(), 2026); assert.equal(p.from.getMonth(), 10); assert.equal(p.from.getDate(), 16);
});

// ── weekBandTitle: staff card label from the ACTUAL week offset (not the card index) ──
test('weekBandTitle: 0 → This week, 1 → Next week, else "" (caller uses a date)', () => {
  assert.equal(weekBandTitle(0), 'This week');
  assert.equal(weekBandTitle(1), 'Next week');
  assert.equal(weekBandTitle(2), '');
  assert.equal(weekBandTitle(-1), '');
});
