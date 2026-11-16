// Render-harness integration test for the FD schedule builder: seeds the store + a capturing DOM
// stub and drives the real renderFdSchedule, so the 2-week bands + draft-diff highlight are exercised
// without a browser/backend. (Visual/CSS correctness is confirmed separately by the owner on a device.)
import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getState } from '../js/app/store.js';

// Capturing DOM: getElementById returns a persistent fake element per id (rich enough for the
// shift-picker, which touches <select>.options, .value and .style).
const _els = new Map();
const _mkEl = () => ({
  innerHTML: '', textContent: '', value: '', options: [], style: {},
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
  querySelector() { return null }, querySelectorAll() { return [] },
  appendChild() {}, remove() {}, setAttribute() {}, getAttribute() { return null },
});
globalThis.document.getElementById = (id) => {
  if (!_els.has(id)) _els.set(id, _mkEl());
  return _els.get(id);
};

const { renderFdSchedule, fdScheduleWeek, fdSchedViewMode, openFdShiftPicker, closeFdShiftPicker } = await import('../js/app/features/fd-schedule.js');

const _weekStart = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - x.getDay()); return x; };
const _iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function seed(sched, draft) {
  const cfg = getState().config;
  cfg.fd_users = [{ id: 'u1', name: 'Maya' }];
  cfg.fd_schedule = sched;
  cfg.fd_schedule_draft = draft;
}

test('renderFdSchedule: shows TWO stacked week bands', () => {
  seed({}, null);
  fdScheduleWeek(0, true);            // window = the 2 weeks containing today
  const html = document.getElementById('fd-schedule-grid').innerHTML;
  assert.equal((html.match(/Week of/g) || []).length, 2, 'two week bands render');
  assert.ok(html.includes('Maya'), 'the user row renders');
});

test('renderFdSchedule: a draft change highlights (fd-cell-changed) in draft view, not in published view', () => {
  fdScheduleWeek(0, true);
  const midWeek = _iso(new Date(_weekStart(new Date()).getTime() + 2 * 86400000)); // Tue of this week — in window
  seed({}, { [midWeek]: { u1: { s: '09:00', e: '17:00' } } });   // published empty, draft adds a shift

  fdSchedViewMode('draft');
  assert.ok(document.getElementById('fd-schedule-grid').innerHTML.includes('fd-cell-changed'), 'draft view highlights the added cell');

  fdSchedViewMode('published');
  assert.ok(!document.getElementById('fd-schedule-grid').innerHTML.includes('fd-cell-changed'), 'published preview shows no draft highlight');

  fdSchedViewMode('draft'); // restore
});

test('renderFdSchedule: no highlight when there is no draft (null-safe)', () => {
  seed({ [_iso(new Date(_weekStart(new Date()).getTime() + 2 * 86400000))]: { u1: { s: '09:00', e: '17:00' } } }, null);
  fdSchedViewMode('draft');          // render AFTER seeding (draft is null → no changes)
  fdScheduleWeek(0, true);
  const html = document.getElementById('fd-schedule-grid').innerHTML;
  assert.ok(!html.includes('fd-cell-changed'), 'published-only schedule shows no stale "removed" highlight');
});

test('draft bar: shows the change count + wired Publish/Discard when there are changes', () => {
  const midWeek = _iso(new Date(_weekStart(new Date()).getTime() + 2 * 86400000));
  seed({}, { [midWeek]: { u1: { s: '09:00', e: '17:00' } } });
  fdSchedViewMode('draft'); fdScheduleWeek(0, true);
  const bar = document.getElementById('fd-sched-draftbar').innerHTML;
  assert.match(bar, /1 unpublished change/);
  assert.ok(bar.includes('publishFdSchedule()') && bar.includes('discardFdSchedule()'), 'Publish + Discard wired');
  assert.ok(bar.includes("fdSchedViewMode('published')"), 'the What-staff-see toggle is wired');
});

test('draft bar: "all published" note when there are no changes', () => {
  seed({}, null);
  fdScheduleWeek(0, true);
  assert.match(document.getElementById('fd-sched-draftbar').innerHTML, /All changes published/);
});

test('pay-period chip renders from config.pay_period', () => {
  getState().config.pay_period = { type: 'biweekly', startDate: '2026-11-16' };
  seed({}, null); fdScheduleWeek(0, true);
  assert.match(document.getElementById('fd-sched-payperiod').innerHTML, /Pay period .* · bi-weekly/);
});

test('published preview is read-only: clicking a cell flips back to Draft', () => {
  const midWeek = _iso(new Date(_weekStart(new Date()).getTime() + 2 * 86400000));
  seed({}, { [midWeek]: { u1: { s: '10:00', e: '18:00' } } });
  fdScheduleWeek(0, true);
  fdSchedViewMode('published');
  assert.ok(!document.getElementById('fd-schedule-grid').innerHTML.includes('fd-cell-changed'), 'published preview shows no highlight');
  openFdShiftPicker(midWeek, 'u1');   // interacting must switch back to the draft and re-render
  assert.ok(document.getElementById('fd-schedule-grid').innerHTML.includes('fd-cell-changed'), 'flipped to draft on cell interaction');
  closeFdShiftPicker();
  fdSchedViewMode('draft');
});
