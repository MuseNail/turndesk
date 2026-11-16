// ── Front-desk weekly schedule (separate from the tech schedule; carries HOURS) ──
// config.fd_schedule = {
//   "YYYY-MM-DD": { <fdId>: {s:"HH:MM", e:"HH:MM"} | "off" },   // explicit per-date
//   _repeats:     { <fdId>: { 0..6: {s,e} | "off" | null } },   // weekly default (Sun..Sat)
// }
// A working day is an object {s,e}; "off" = day off; null = unset; SCHED_NONE = one-off blank
// that overrides a weekly repeat (mirrors the tech schedule). Pay is from the time clock, NOT
// this — the schedule is the plan (e.g. come in later / leave earlier).
import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { localDateStr, showToast } from '../utils.js';
import { resolveFdShift, SCHED_NONE, structuralChangeCount, hasUnpublishedChanges, repeatForwardDates, cellChangeKind } from '../fd-schedule-util.js';

const cfg = () => getState().config;
let fdWeekStart = _weekStart(new Date());
let fdPickerTarget = null;     // { date, fdId } of the clicked cell
let fdShiftMode = 'week';      // 'week' (these dates only) | 'every' (repeat forward N weeks)
let fdSelectedDays = new Set();// day-of-week (0..6) the editor will stamp

// ── Draft vs published ────────────────────────────────────────────────────────
// Staff read PUBLISHED (config.fd_schedule); the builder edits a DRAFT (config.fd_schedule_draft)
// until Publish promotes it. Clearing the draft stores `null` (config.set can't delete a key), so
// emptiness is always a null/empty-object check, never an `in`/`!==undefined` test.
const _publishedSched = () => cfg().fd_schedule || {};
const _draftSched = () => {
  const d = cfg().fd_schedule_draft;
  return (d && Object.keys(d).length) ? d : JSON.parse(JSON.stringify(_publishedSched()));
};
let _schedView = 'draft';   // 'draft' = editing the draft | 'published' = read-only preview of what staff see
const _activeSched = () => _schedView === 'published' ? _publishedSched() : _draftSched();

function _weekStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - x.getDay()); return x; }
function _addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
const _esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const _fmtTime = hhmm => { if (!hhmm) return ''; const [h, m] = hhmm.split(':').map(Number); const ap = h >= 12 ? 'p' : 'a'; const h12 = h % 12 === 0 ? 12 : h % 12; return m ? `${h12}:${String(m).padStart(2, '0')}${ap}` : `${h12}${ap}`; };
const _shiftLabel = sh => (sh && sh.s) ? `${_fmtTime(sh.s)}–${_fmtTime(sh.e)}` : '';
const _toMin = hhmm => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
const _hoursBetween = (s, e) => (_toMin(e) - _toMin(s)) / 60;
const _shiftHours = sh => (sh && sh.s) ? Math.max(0, _hoursBetween(sh.s, sh.e)) : 0;
const _fmtHrs = h => h % 1 === 0 ? String(h) : h.toFixed(1);

// Effective shift for a date: {s,e} (working) | 'off' | null (unset). Staff-facing → PUBLISHED copy.
export function getFdShift(date, fdId) {
  return resolveFdShift(_publishedSched(), date, fdId);
}
export const fdShiftLabel = _shiftLabel;   // reused by the staff app's FD view

export function fdScheduleWeek(delta, today = false) {
  if (today) fdWeekStart = _weekStart(new Date());
  else { fdWeekStart = new Date(fdWeekStart); fdWeekStart.setDate(fdWeekStart.getDate() + delta * 14); }   // 2-week window
  renderFdSchedule();
}

export function toggleFdScheduleView() {
  const listV = document.getElementById('fdusers-list-view'), schedV = document.getElementById('fdusers-schedule-view'), btn = document.getElementById('fd-schedule-view-btn');
  if (!listV || !schedV) return;
  const showingSched = !schedV.classList.contains('hidden');
  const nowSched = showingSched ? false : true;   // after the toggle below
  listV.classList.toggle('hidden', nowSched);
  schedV.classList.toggle('hidden', !nowSched);
  // Make the button say what it DOES next, so it's clear how to get back (was: same label both ways).
  if (btn) btn.innerHTML = nowSched
    ? `<span class="material-symbols-outlined" style="font-size:16px">arrow_back</span> Front Desk Users`
    : `<span class="material-symbols-outlined" style="font-size:16px">calendar_month</span> Schedule`;
  if (nowSched) renderFdSchedule();
}

export function renderFdSchedule() {
  const grid = document.getElementById('fd-schedule-grid'); if (!grid) return;
  const label = document.getElementById('fd-schedule-week-label');
  const sched = _activeSched();   // draft while editing; published while previewing "what staff see"
  const pub = _publishedSched();
  const draftRaw = cfg().fd_schedule_draft;
  const showDiff = _schedView === 'draft' && !!(draftRaw && Object.keys(draftRaw).length);   // highlight only real draft changes
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const fmtShort = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const windowEnd = new Date(fdWeekStart); windowEnd.setDate(windowEnd.getDate() + 13);
  if (label) label.textContent = `${fmtShort(fdWeekStart)} – ${fmtShort(windowEnd)}`;
  const users = cfg().fd_users || [];
  if (!users.length) { grid.innerHTML = '<div class="text-sm font-body text-on-surface-variant py-8 text-center">No front-desk users yet — add one above.</div>'; return; }
  const week1 = new Date(fdWeekStart); week1.setDate(week1.getDate() + 7);
  grid.innerHTML = _renderWeekBand(new Date(fdWeekStart), sched, pub, draftRaw, showDiff, today, users)
                 + _renderWeekBand(week1, sched, pub, draftRaw, showDiff, today, users);
}

// One stacked week band: a "Week of …" label, the Sun–Sat day header, then a row per FD user.
function _renderWeekBand(weekStart, sched, pub, draftRaw, showDiff, today, users) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dates = days.map((_, i) => { const d = new Date(weekStart); d.setDate(d.getDate() + i); return d; });
  const isToday = d => d.toDateString() === today.toDateString();
  const stickyBg = 'background:var(--surface-container-lowest, #f5f7f8)';
  const fmtShort = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const headerCols = dates.map((d, i) => `<div class="text-center px-2 py-1.5 min-w-[92px]${isToday(d) ? ' bg-primary/5' : ''}"><div class="text-[11px] font-body font-semibold text-on-surface-variant uppercase tracking-widest">${days[i]}</div><div class="text-sm font-headline font-bold ${isToday(d) ? 'text-primary' : 'text-on-surface'}">${d.getDate()}</div></div>`).join('');
  const rows = users.map(u => {
    let weekHours = 0;
    const cells = dates.map(d => {
      const key = localDateStr(d), sh = resolveFdShift(sched, key, u.id);
      const isRepeat = !sched[key]?.[u.id] && sched._repeats?.[u.id]?.[d.getDay()];
      const off = sh === 'off', work = !!(sh && sh.s);
      if (work) weekHours += _shiftHours(sh);
      const bg = off ? 'background:#f5c870;color:#3a2800;' : work ? 'background:#dcebea;color:#0a3a3a;' : '';
      const txt = off ? 'Off' : work ? _shiftLabel(sh) : '';
      const isPast = d < today && !isToday(d);
      // Draft diff (structural): amber ring on any changed cell; struck old value for edited/removed.
      const diff = showDiff ? cellChangeKind(pub, draftRaw, key, u.id) : null;
      const oldEx = (diff === 'edited' || diff === 'removed') ? pub[key]?.[u.id] : null;
      const oldLbl = (oldEx && oldEx.s) ? _shiftLabel(oldEx) : (oldEx === 'off' ? 'Off' : '');
      const oldTag = (diff && oldLbl) ? `<span class="fd-cell-old">${oldLbl}</span>` : '';
      const repeatDot = (isRepeat && !diff) ? '<span style="position:absolute;top:3px;right:3px;width:6px;height:6px;border-radius:50%;background:#15514f;box-shadow:0 0 0 1px rgba(255,255,255,0.7)"></span>' : '';
      return `<div class="min-w-[92px] px-1 py-0.5"><button onclick="openFdShiftPicker('${key}','${u.id}')" class="w-full h-9 rounded-lg text-[11px] font-body font-semibold transition-all hover:opacity-80 border relative ${diff ? 'fd-cell-changed' : ''} ${(off || work) ? 'border-transparent' : 'border-dashed border-outline-variant/50 hover:bg-surface-container'} ${isPast ? 'opacity-50' : ''}" style="${bg}">${oldTag}${txt}${repeatDot}</button></div>`;
    }).join('');
    const photo = u.photo ? `<img src="${_esc(u.photo)}" class="w-8 h-8 rounded-full object-cover border border-surface-container-high flex-shrink-0">` : `<div class="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center flex-shrink-0"><span class="text-xs font-headline font-bold text-on-surface">${_esc((u.name || '?').charAt(0).toUpperCase())}</span></div>`;
    const hrsLine = weekHours > 0 ? `<div class="text-[11px] font-body text-on-surface-variant leading-tight">${_fmtHrs(weekHours)}h</div>` : '';
    return `<div class="flex items-center border-b border-surface-container-high last:border-0"><div class="flex items-center gap-2 w-[150px] pr-2 py-1 flex-shrink-0 sticky left-0 z-10" style="${stickyBg}">${photo}<div class="min-w-0 flex-grow"><div class="text-sm font-body font-semibold text-on-surface truncate leading-tight">${_esc(u.name)}</div>${hrsLine}</div></div>${cells}</div>`;
  }).join('');
  return `<div class="mt-4 first:mt-0"><div class="text-[11px] font-body font-semibold text-on-surface-variant uppercase tracking-widest px-1 mb-1">Week of ${fmtShort(weekStart)}</div>`
       + `<div class="flex items-center border-b-2 border-surface-container-high" style="${stickyBg}"><div class="w-[150px] flex-shrink-0 sticky left-0 z-10" style="${stickyBg}"></div>${headerCols}</div>${rows}</div>`;
}

export function openFdShiftPicker(date, fdId) {
  fdPickerTarget = { date, fdId };
  const u = (cfg().fd_users || []).find(x => x.id === fdId);
  const d = new Date(date + 'T12:00:00'), cur = resolveFdShift(_draftSched(), date, fdId), dow = d.getDay();
  const lab = document.getElementById('fd-shift-picker-label');
  if (lab) lab.textContent = `${u?.name || ''} — ${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`;
  _ensureFdTimeOptions();
  _fdSetTimeFields('fd-start', (cur && cur.s) ? cur.s : '09:00');
  _fdSetTimeFields('fd-end',   (cur && cur.e) ? cur.e : '17:00');
  fdShiftMode = 'week';   // default to this-week; "Repeat next 4 weeks" is an explicit choice
  fdSelectedDays = new Set([dow]);
  fdSyncShiftTime();
  _renderFdDayChips();
  _renderFdMode();
  const m = document.getElementById('fd-shift-picker'); if (m) { m.classList.remove('hidden'); m.style.display = 'flex'; }
}
export function closeFdShiftPicker() { const m = document.getElementById('fd-shift-picker'); if (m) { m.classList.add('hidden'); m.style.display = ''; } fdPickerTarget = null; }

// ── Time dropdowns (Hour : Min : AM/PM, 15-min — mirrors the appointment picker) ──
function _ensureFdTimeOptions() {
  ['fd-start-hour', 'fd-end-hour'].forEach(id => { const el = document.getElementById(id); if (el && !el.options.length) el.innerHTML = Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join(''); });
  ['fd-start-min', 'fd-end-min'].forEach(id => { const el = document.getElementById(id); if (el && !el.options.length) el.innerHTML = ['00', '15', '30', '45'].map(m => `<option value="${m}">${m}</option>`).join(''); });
}
function _setVal(id, v) { const el = document.getElementById(id); if (el) el.value = v; }
function _getVal(id) { return document.getElementById(id)?.value || ''; }
function _fdSetTimeFields(prefix, hhmm) {
  let [h24, m] = String(hhmm || '09:00').split(':').map(Number);
  h24 = ((h24 % 24) + 24) % 24; m = Math.round((m || 0) / 15) * 15; if (m === 60) { m = 0; h24 = (h24 + 1) % 24; }
  const ap = h24 >= 12 ? 'PM' : 'AM'; let h12 = h24 % 12; if (h12 === 0) h12 = 12;
  _setVal(prefix + '-hour', String(h12)); _setVal(prefix + '-min', String(m).padStart(2, '0')); _setVal(prefix + '-ampm', ap);
}
function _fdReadTime(prefix) {
  const h = parseInt(_getVal(prefix + '-hour') || '9', 10), m = _getVal(prefix + '-min') || '00', ap = _getVal(prefix + '-ampm') || 'AM';
  let h24 = h % 12; if (ap === 'PM') h24 += 12;
  return `${String(h24).padStart(2, '0')}:${m}`;
}
export function fdSyncShiftTime() {
  const h = _hoursBetween(_fdReadTime('fd-start'), _fdReadTime('fd-end'));
  const el = document.getElementById('fd-shift-hours');
  if (el) el.innerHTML = h > 0 ? `<b style="color:var(--primary)">${_fmtHrs(h)} hours</b>` : `<span style="color:#c0392b">End must be after start</span>`;
}

// ── "Apply to" day chips + this-week/every-week mode ──
const _FD_CHIP_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
function _renderFdDayChips() {
  const wrap = document.getElementById('fd-day-chips'); if (!wrap) return;
  const curDow = fdPickerTarget ? new Date(fdPickerTarget.date + 'T12:00:00').getDay() : -1;
  wrap.innerHTML = _FD_CHIP_LABELS.map((l, dow) => {
    const on = fdSelectedDays.has(dow);
    const cls = on ? 'bg-primary text-on-primary border border-primary' : 'border border-surface-container-high text-on-surface-variant';
    const ring = dow === curDow ? 'box-shadow:0 0 0 2px rgba(21,81,79,.25);' : '';
    return `<button type="button" onclick="fdToggleShiftDay(${dow})" class="flex-1 h-9 rounded-lg text-xs font-body font-bold transition-colors ${cls}" style="${ring}">${l}</button>`;
  }).join('');
}
export function fdToggleShiftDay(dow) {
  if (fdSelectedDays.has(dow)) fdSelectedDays.delete(dow); else fdSelectedDays.add(dow);
  _renderFdDayChips();
}
function _renderFdMode() {
  const week = document.getElementById('fd-mode-week'), every = document.getElementById('fd-mode-every');
  const setOn = (el, on) => { if (!el) return; el.style.background = on ? 'var(--surface-container-lowest)' : 'transparent'; el.style.boxShadow = on ? '0 1px 3px rgba(0,0,0,.12)' : 'none'; el.style.color = on ? 'var(--on-surface)' : 'var(--on-surface-variant)'; };
  setOn(week, fdShiftMode === 'week'); setOn(every, fdShiftMode === 'every');
}
export function fdSetShiftMode(mode) { fdShiftMode = mode; _renderFdMode(); }

// ── Save / Off / Clear over the selected days, in this-week or every-week mode ──
// value: {s,e} (working) | 'off' | null (clear)
function _applyFdShift(value) {
  if (!fdPickerTarget) return;
  const { fdId } = fdPickerTarget;
  if (!fdSelectedDays.size) { showToast('Pick at least one day.'); return; }
  const sched = JSON.parse(JSON.stringify(_draftSched()));   // edits write the DRAFT, not published
  const wkStart = _weekStart(new Date(fdPickerTarget.date + 'T12:00:00'));
  // Write one explicit per-date entry. Clear (value null) over a date a LEGACY repeat still covers
  // writes SCHED_NONE (a real blank) so the old pattern doesn't leak back; otherwise delete the cell.
  const _writeDate = (dt, dow) => {
    if (value === null) {
      if (sched._repeats?.[fdId]?.[dow]) { sched[dt] = sched[dt] || {}; sched[dt][fdId] = SCHED_NONE; }
      else if (sched[dt]?.[fdId] !== undefined) { delete sched[dt][fdId]; if (!Object.keys(sched[dt]).length) delete sched[dt]; }
    } else { sched[dt] = sched[dt] || {}; sched[dt][fdId] = value; }
  };
  if (fdShiftMode === 'every') {   // "Repeat next 4 weeks" — stamp explicit dates forward (overwrite); no standing pattern
    repeatForwardDates(localDateStr(wkStart), 4, [...fdSelectedDays]).forEach(dt => _writeDate(dt, new Date(dt + 'T12:00:00').getDay()));
  } else {                         // just this week
    fdSelectedDays.forEach(dow => _writeDate(localDateStr(_addDays(wkStart, dow)), dow));
  }
  dispatch('config.set', { key: 'fd_schedule_draft', value: sched });
  closeFdShiftPicker();
  renderFdSchedule();
}

// ── Publish / Discard / preview toggle ────────────────────────────────────────
export function publishFdSchedule() {
  if (!hasUnpublishedChanges(_publishedSched(), cfg().fd_schedule_draft)) return;
  const go = () => {
    dispatch('config.set', { key: 'fd_schedule', value: JSON.parse(JSON.stringify(_draftSched())) });
    dispatch('config.set', { key: 'fd_schedule_draft', value: null });   // published first, then clear
    _schedView = 'draft';
    showToast('Schedule published ✓');
    renderFdSchedule();
  };
  if (window.showWarnModal) window.showWarnModal('Publish schedule?', 'This makes your changes visible to all front-desk staff now.', go, 'Publish');
  else go();
}
export function discardFdSchedule() {
  if (!hasUnpublishedChanges(_publishedSched(), cfg().fd_schedule_draft)) return;
  const go = () => {
    dispatch('config.set', { key: 'fd_schedule_draft', value: null });
    _schedView = 'draft';
    showToast('Draft discarded');
    renderFdSchedule();
  };
  if (window.showWarnModal) window.showWarnModal('Discard changes?', 'This throws away all unpublished changes and reverts to the published schedule.', go, 'Discard');
  else go();
}
export function fdSchedViewMode(mode) { _schedView = (mode === 'published') ? 'published' : 'draft'; renderFdSchedule(); }
export function saveFdShift() {
  const s = _fdReadTime('fd-start'), e = _fdReadTime('fd-end');
  if (_hoursBetween(s, e) <= 0) { showToast('End time must be after start time.'); return; }
  _applyFdShift({ s, e });
}
export function setFdShiftOff() { _applyFdShift('off'); }
export function clearFdShift() { _applyFdShift(null); }
