// ── Google Calendar + Tasks ─────────────────────────────────────────────────
import { getState, subscribe } from '../store.js';
import { dispatch } from '../sync.js';
import { PUSH_PROXY } from '../config.js';
import { withAuth } from '../apptoken.js';
import { showToast, localDateStr, formatPhone, byName, newEntryId, setSwitchVisual, dateBtnLabel } from '../utils.js';
import { customerDirectory, squareCustomers, squareUpsertCustomer, showEditCustomer } from './square-customers.js';

const GCAL_DISCOVERY = 'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest';
const GTASK_DISCOVERY = 'https://www.googleapis.com/discovery/v1/apis/tasks/v1/rest';
// Server-side refresh-token auth: the Worker holds the Google refresh token and mints access
// tokens on demand, so the iPad never depends on Safari/Chrome silent renewal. gapi (below) is
// still loaded for the Calendar/Tasks API calls; the access token comes from the Worker, not GIS.
const GCAL_PROXY = 'https://turndesk.musenailandspa.workers.dev/gcal';

const cfg = () => getState().config;
const queue = () => getState().queue;
const records = () => getState().records;

// config.staff has no color field — assign a stable per-staff column color by roster index
// so "color coding by staff" is preserved (mirrors queue.js CATEGORY_PALETTE).
const STAFF_PALETTE = ['#1a5252','#7b1fa2','#0277bd','#00695c','#e65100','#5c3d8f','#2a7a4f','#7a2a1a','#785a1a','#7a1a5c','#1a5c7a','#455a64'];

// Escapers for untrusted Google/Square data interpolated into innerHTML. _escHtml
// for HTML-text/attribute context; _escAttrJs for a value placed inside a single-
// quoted JS string that itself sits inside a double-quoted on*= attribute (JS-string
// escape first, then HTML-escape so the browser's attribute decode yields a clean
// JS literal). Several render fns still define their own local escHtml/_e — these are
// the module-level versions used by calEventClick / tasks / autocomplete.
const _escHtml = s => (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const _escAttrJs = s => (s == null ? '' : String(s)).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let _calGapiLoaded = false, _calRefreshTimer = null;
let _calDate = new Date(), _calCalendars = [], _calEvents = {}, _calPrimaryId = '';
// Today's appointment events, loaded INDEPENDENTLY of the calendar's viewed day (_calDate) so
// the Turns "upcoming" strip + appointment reminders always reflect TODAY even when the Calendar
// tab is parked on another date. (Before, both read _calEvents, which holds whatever day you're
// viewing — so navigating the calendar polluted Turns/reminders.) Short TTL; refreshed in the
// background by callers (fire-and-forget). Needs gapi + a Google token (Calendar opened/connected
// at least once this session); otherwise empty and callers fall back to _calEvents when it's today.
let _todayEvents = {}, _todayEventsAt = 0, _todayLoading = false;
let _unassignedOnly = false;
// Day | Week view (device-local). Week = a 7-day overview: all visible techs' bookings
// merged per day column, colored by tech; tapping a day drills into the Day view.
let _calView = localStorage.getItem('turndesk_cal_view') === 'week' ? 'week' : 'day';
const calIsWeek = () => _calView === 'week';
function calWeekStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - x.getDay()); return x; }
// Today's-Appointments panel filter (device-local): hide past-time + finished rows.
let _apptsUpcomingOnly = localStorage.getItem('turndesk_cal_upcoming') === '1';
export function toggleApptsUpcoming() {
  _apptsUpcomingOnly = !_apptsUpcomingOnly;
  localStorage.setItem('turndesk_cal_upcoming', _apptsUpcomingOnly ? '1' : '0');
  renderTodaysAppointments();
}
let _apptEditId = null, _apptLines = [], _apptExtraGuests = [], _apptEditGroupId = '';
// Re-entry guard: saveAppt runs a multi-second sequence of awaited Google writes while
// the modal stays open. Without this, an impatient second Save tap mints a fresh groupId
// and inserts a whole duplicate party (+ duplicate Square upserts). Blocks re-entry until
// the in-flight save settles.
let _apptSaving = false;
let _calSyncTimer = null, _calSelectorDraft = null, _calDragIdx = null;
let _calSlotH = 52, _calSlotMins = 30, _calTouchStartDist = null;
let _calHidden = new Set(JSON.parse(localStorage.getItem('turndesk_cal_staff_hidden') || '[]'));
let _calOrder = JSON.parse(localStorage.getItem('turndesk_cal_staff_order') || 'null');
// Off-duty auto-hide (opt-in via config.cal_autohide_offduty): calendars whose matched
// staff is off/sick/vacation are hidden by default each day. _calOffPeek holds the ones
// the operator turned on for the CURRENTLY-viewed day; it resets on day navigation.
let _calOffPeek = new Set();
const CAL_SYNC_INTERVAL = 60000;

// ── Google eventual-consistency guards ────────────────────────────────────────
// Right after a write, events.list can still RETURN just-deleted events (ghosts) and
// MISS just-inserted/updated ones for several seconds. That made edits — especially
// multi-staff bookings, which are delete+reinsert fan-outs — "not display properly"
// (duplicates, stale copies) until a later sync. Every delete records a tombstone and
// every insert/update/patch pins the resource Google returned; _gcalApplyGuards()
// reconciles each fetched list against both for a couple of minutes.
const GCAL_LAG_MS = 120000;
const _calGhosts = new Map();   // `${calId}|${eventId}` -> expiresAt
const _calPins   = new Map();   // `${calId}|${eventId}` -> { ev, expiresAt }
export function _gcalNoteDeleted(calId, eventId) {
  if (!calId || !eventId) return;
  _calGhosts.set(calId + '|' + eventId, Date.now() + GCAL_LAG_MS);
  _calPins.delete(calId + '|' + eventId);
}
export function _gcalNoteWritten(calId, ev) {
  if (!calId || !ev || !ev.id) return;
  _calPins.set(calId + '|' + ev.id, { ev, expiresAt: Date.now() + GCAL_LAG_MS });
  _calGhosts.delete(calId + '|' + ev.id);
}
export function _gcalApplyGuards(calId, items) {
  const now = Date.now();
  for (const [k, exp] of _calGhosts) if (exp <= now) _calGhosts.delete(k);
  for (const [k, v] of _calPins) if (v.expiresAt <= now) _calPins.delete(k);
  let out = (items || []).filter(e => !_calGhosts.has(calId + '|' + e.id));
  // Prefer the pinned (post-write) copy while the fetched one is older; once Google
  // catches up the fetched copy wins and the pin ages out.
  out = out.map(e => {
    const p = _calPins.get(calId + '|' + e.id);
    return (p && +new Date(p.ev.updated || 0) > +new Date(e.updated || 0)) ? p.ev : e;
  });
  for (const [k, v] of _calPins) {
    const sep = k.indexOf('|');
    if (k.slice(0, sep) === calId && !out.some(e => e.id === k.slice(sep + 1))) out.push(v.ev);
  }
  return out;
}

// The calendar's columns are the salon's active staff + a trailing "Unassigned" column.
// Column id === staffId (a real config.staff[].id); the Unassigned column id === ''.
// Colors come from STAFF_PALETTE by roster index so each tech keeps a stable color.
function buildStaffColumns() {
  const inactive = new Set(cfg().inactive_staff || []);
  const cols = (cfg().staff || [])
    .filter(s => s && s.id && !inactive.has(s.id))
    .map((s, i) => ({ id: s.id, name: s.name || 'Staff', color: STAFF_PALETTE[i % STAFF_PALETTE.length] }));
  cols.push({ id: '', name: 'Unassigned', color: '#9ca3af' });
  return cols;
}
// A column's staff is off on the viewed date? Reads the in-app schedule only (off/sick/
// vacation for _calDate). The Unassigned column (id '') and any unknown id are never "off".
function calColumnOff(cal) {
  if (!cal || !cal.id) return false;
  const st = (cfg().staff || []).find(s => s.id === cal.id);
  if (!st) return false;
  const dstr = localDateStr(_calDate), sc = cfg().schedule || {};
  const explicit = sc[dstr]?.[st.id];
  const status = explicit === '__none__' ? null
    : (explicit || sc._repeats?.[st.id]?.[new Date(dstr + 'T12:00:00').getDay()] || null);
  return status === 'off' || status === 'sick' || status === 'vacation';
}
// Auto-hide active? (opt-in setting). Calendars filter + grid both consult this.
const calAutoHideOn = () => !!cfg().cal_autohide_offduty;
// A calendar is hidden right now if manually hidden, OR (auto-hide on AND its tech is
// off today AND it hasn't been peeked-on for this day).
function calIsHidden(cal) {
  if (_calHidden.has(cal.id)) return true;
  if (calAutoHideOn() && calColumnOff(cal) && !_calOffPeek.has(cal.id)) return true;
  return false;
}
// Effective hidden-id set for seeding the Calendars filter draft (reflects what's
// actually showing right now, so off-duty rows appear unchecked).
function calEffectiveHiddenSet() { return new Set(_calCalendars.filter(calIsHidden).map(c => c.id)); }

// ── Settings: off-duty auto-hide toggle (rendered into #cal-autohide-setting) ──
export function renderCalAutoHideSetting() {
  const host = document.getElementById('cal-autohide-setting'); if (!host) return;
  const on = calAutoHideOn();
  host.innerHTML = `<label class="text-[11px] font-body font-semibold text-outline uppercase tracking-widest block mb-2">Off-duty staff</label>`
    + `<div class="flex items-start justify-between gap-4">`
    + `<div class="min-w-0"><p class="text-sm font-body font-semibold text-on-surface">Auto-hide off-duty staff</p>`
    + `<p class="text-xs font-body text-on-surface-variant mt-0.5">Show only staff scheduled to work each day. Staff marked off, sick, or vacation are hidden automatically. Open the Calendars filter to peek at one — it re-hides when you change days.</p></div>`
    + `<button onclick="toggleCalAutoHide(this)" class="flex-shrink-0 mt-0.5" aria-label="Auto-hide off-duty staff">`
    + `<div class="mswitch relative w-14 h-7 rounded-full transition-colors ${on?'bg-primary':'bg-surface-container-high'}"><div class="absolute top-0.5 w-6 h-6 rounded-full bg-white shadow transition-all ${on?'left-7':'left-0.5'}"></div></div>`
    + `</button></div>`;
}
export function toggleCalAutoHide(btn) {
  const on = !calAutoHideOn();
  dispatch('config.set', { key: 'cal_autohide_offduty', value: on });
  if (btn) setSwitchVisual(btn, on); else renderCalAutoHideSetting();
  _calOffPeek = new Set();
  if (document.getElementById('cal-grid')) { calRenderGridPreserveScroll(); renderCalSelectorList(); }
}

// Every appointment whose start day falls within [fromDate..toDate], indexed by the staff
// column(s) it touches. The SAME appt object appears under multiple column ids when its
// guests span techs. Defensive: a line with an unknown/deleted staffId falls to Unassigned.
function calApptsByColumn(fromDate, toDate) {
  const from = new Date(fromDate); from.setHours(0, 0, 0, 0);
  const to = new Date(toDate || fromDate); to.setHours(23, 59, 59, 999);
  const known = new Set(_calCalendars.map(c => c.id));   // valid column ids (incl. '')
  const map = {}; _calCalendars.forEach(c => { map[c.id] = []; });
  (getState().appointments || []).forEach(a => {
    if (!a || !a.start) return;
    const s = new Date(a.start);
    if (isNaN(s) || s < from || s > to) return;
    const cols = new Set();
    (a.guests || []).forEach(g => (g.lines || []).forEach(l => {
      const sid = (l && l.staffId) || '';
      cols.add(known.has(sid) ? sid : '');   // unknown staff → Unassigned
    }));
    if (!cols.size) cols.add('');            // a bare appt with no service lines → Unassigned
    cols.forEach(sid => { if (map[sid]) map[sid].push(a); });
  });
  return map;
}
// The (guestName, serviceId, label) rows belonging to ONE column for a booking bubble.
// Tech column: lines whose staffId === colId. Unassigned column: lines with no/unknown staff.
function linesForColumn(appt, colId) {
  const known = new Set(_calCalendars.map(c => c.id));
  const rows = [];
  (appt.guests || []).forEach(g => {
    const fn = ((g.name || '').split(' ')[0] || g.name || '').trim();
    (g.lines || []).forEach(l => {
      const sid = (l && l.staffId) || '';
      const inCol = colId === '' ? !known.has(sid) || sid === '' : sid === colId;
      if (!inCol) return;
      const label = cfg().services.find(x => x.id === l.serviceId)?.label || l.serviceId || '';
      rows.push({ fn, svcId: l.serviceId || '', label });
    });
  });
  return rows;
}
// Appt-scoped id (client mint). Deterministic ids (appt-<n>) are used only by the seeder.
function newApptId() { return 'appt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7); }
// The queue entry (if any) that checked THIS appointment in.
function _queueForAppt(apptId) { return apptId ? queue().find(x => String(x.appointmentId) === String(apptId)) || null : null; }

// Returns the loaded events for a calendar (exposed via window.calEventsFor in main.js).
export function getCalEvents(calId) { return _calEvents[calId] || []; }

// Load TODAY's events for all calendars into _todayEvents, independent of _calDate. Cached with
// a 60s TTL; fire-and-forget from the callers. Re-renders the Turns strip when a load completes.
async function ensureTodayApptEvents(force) {
  if (_todayLoading) return;
  if (!force && _todayEventsAt && Date.now() - _todayEventsAt < 60000) return;
  if (!window.gapi?.client?.calendar || !localStorage.getItem('turndesk_turndesk_gcal_token') || !_calCalendars.length) return;
  _todayLoading = true;
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(); dayEnd.setHours(23, 59, 59, 999);
  const next = {};
  try {
    await Promise.all(_calCalendars.map(async cal => {
      try { const r = await gapi.client.calendar.events.list({ calendarId: cal.id, timeMin: dayStart.toISOString(), timeMax: dayEnd.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 100 }); next[cal.id] = _gcalApplyGuards(cal.id, r.result.items); }
      catch (e) { next[cal.id] = _todayEvents[cal.id] || []; }
    }));
    _todayEvents = next; _todayEventsAt = Date.now();
    if (document.getElementById('panel-turns')?.classList.contains('active')) window.renderTurnsApptStrip?.();
  } finally { _todayLoading = false; }
}
// The event source for "today" features (Turns strip, reminders). Triggers a background refresh
// and returns the freshest today-scoped events; before the first load lands, fall back to
// _calEvents only when the calendar is showing today, so the common case never regresses.
function todayApptSource() { const t = new Date(); return calApptsByColumn(t, t); }

// For the appointment-reminder engine: today's TIMED appointment bookings (grouped like the
// Today's-Appointments panel), as { id, name, startMs }. Only events that have a start time.
export function apptsForReminders() {
  const t = new Date(); const dstr = localDateStr(t);
  const out = [];
  (getState().appointments || []).forEach(a => {
    if (!a || !a.start || a.noShow) return;
    const start = new Date(a.start);
    if (isNaN(start) || localDateStr(start) !== dstr) return;
    if (_queueForAppt(a.id)) return;   // already checked in
    const g0 = (a.guests || [])[0] || {};
    const lines = (a.guests || []).flatMap(g => g.lines || []);
    const svc = [...new Set(lines.map(l => cfg().services.find(s => s.id === l.serviceId)?.label).filter(Boolean))].join(', ');
    const techName = [...new Set(lines.map(l => (cfg().staff || []).find(s => s.id === l.staffId)?.name).filter(Boolean))].join(', ');
    out.push({ id: a.id, name: g0.name || 'Guest', startMs: start.getTime(), svc, techName });
  });
  return out;
}

// An appointment this many minutes past its start that was never checked in is
// treated as a de-facto no-show and DROPPED from the Turns strip / next-up — computed
// live each render, NEVER written to Google. (We used to PATCH museNoShow onto these,
// which permanently mis-flagged served-but-unlinked customers as No Show on past days.)
const STALE_APPT_DROP_MIN = 60;
// For the Turns sheet: today's UPCOMING timed appointments, one entry per
// (booking × assigned tech). Excludes anything not still upcoming — passed start
// time, no-show, or already in the queue (checked in / in service / complete / paid).
// Cancelled events are deleted upstream so they never appear. Lines with no tech (or
// on the unassigned calendar) come back as techStaffId:'' / techName:'Unassigned'.
export function apptsForTurns() {
  const now = Date.now(), dstr = localDateStr(new Date());
  const out = [];
  (getState().appointments || []).forEach(a => {
    if (!a || !a.start || a.noShow) return;
    const start = new Date(a.start);
    if (isNaN(start) || localDateStr(start) !== dstr) return;
    const startMs = start.getTime();
    const late = startMs < now, minsLate = late ? Math.round((now - startMs) / 60000) : 0;
    if (minsLate > STALE_APPT_DROP_MIN) return;      // very late & never checked in → drop (computed live)
    if (_queueForAppt(a.id)) return;                 // already checked in
    const g0 = (a.guests || [])[0] || {};
    const name = g0.name || 'Guest';
    const lines = (a.guests || []).flatMap(g => g.lines || []);
    const svc = [...new Set(lines.map(l => cfg().services.find(s => s.id === l.serviceId)?.label).filter(Boolean))].join(', ') || 'Appointment';
    const techs = new Map();   // staffId -> name, distinct assigned techs
    lines.forEach(l => { const st = (cfg().staff || []).find(s => s.id === l.staffId); if (st) techs.set(st.id, st.name); });
    const notes = a.notes || '';
    if (techs.size === 0) out.push({ startMs, late, minsLate, name, svc, techStaffId: '', techName: 'Unassigned', apptId: a.id, notes });
    else techs.forEach((tn, id) => out.push({ startMs, late, minsLate, name, svc, techStaffId: id, techName: tn, apptId: a.id, notes }));
  });
  out.sort((x, y) => x.startMs - y.startMs);
  return out;
}

// ── Unassigned-appointments calendar ──────────────
// The Unassigned column id is the empty string (a line with staffId null/'' → no tech yet).
export function unassignedCalId() { return ''; }
function calDisplayName(idOrCal) {
  const id = (idOrCal && typeof idOrCal === 'object') ? idOrCal.id : idOrCal;
  if (id === '' || id == null) return 'Unassigned';
  if (idOrCal && typeof idOrCal === 'object' && idOrCal.name) return idOrCal.name;
  return _calCalendars.find(c => c.id === id)?.name || 'Unassigned';
}
export function setUnassignedCal(calId) {
  dispatch('config.set', { key: 'unassigned_cal_id', value: calId || '' });
  renderGcalCalendarList();
  if (document.getElementById('panel-calendar')?.classList.contains('active')) calRenderGridPreserveScroll();
  showToast('Unassigned-appointments calendar set ✓');
}
export function renderGcalCalendarList() {
  const el = document.getElementById('gcal-calendar-list');
  if (!el) return;
  if (_calCalendars.length === 0) { el.innerHTML = '<div class="text-xs font-body text-on-surface-variant py-2">No calendars loaded yet — connect above, then reopen this page.</div>'; return; }
  const uid = unassignedCalId();
  el.innerHTML = `<div class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest mb-1">Your calendars · pick where unassigned appointments go</div>`
    + _calCalendars.map(c => {
        const isU = c.id === uid, isP = c.id === _calPrimaryId;
        return `<label class="flex items-center gap-2 py-2 px-2 rounded-lg hover:bg-surface-container cursor-pointer">
          <input type="radio" name="unassigned-cal" ${isU?'checked':''} onchange="setUnassignedCal('${c.id.replace(/'/g,"\\'")}')" style="accent-color:#1a5252;width:16px;height:16px;flex-shrink:0">
          <span style="width:12px;height:12px;border-radius:50%;background:${c.color};flex-shrink:0"></span>
          <span class="flex-grow text-sm font-body text-on-surface">${c.name}${isP?' <span style="font-size:10px;color:#9ca3af">(primary)</span>':''}</span>
          ${isU?'<span style="font-size:10px;font-weight:600;color:#1a5252">Unassigned →</span>':''}
        </label>`;
      }).join('');
}

// ── Today's Appointments list (right rail, above Tasks) ───────────────────────
// Lists the VIEWED day's appointments (follows the date nav), one row per booking
// (party + cross-calendar split = one row), sorted by time. Tap opens the appt.
export function renderTodaysAppointments() {
  const listEl = document.getElementById('cal-appts-list'); if (!listEl) return;
  const titleEl = document.getElementById('cal-appts-title'), countEl = document.getElementById('cal-appts-count');
  const isToday = new Date().toDateString() === _calDate.toDateString();
  if (titleEl) titleEl.textContent = isToday ? "Today's Appointments" : _calDate.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
  const dstr = localDateStr(_calDate);
  const rows = [];
  (getState().appointments || []).forEach(a => {
    if (!a || !a.start) return;
    const startDt = new Date(a.start);
    if (isNaN(startDt) || localDateStr(startDt) !== dstr) return;
    const g0 = (a.guests || [])[0] || {};
    const qm = _queueForAppt(a.id);
    rows.push({ startMin: startDt.getHours()*60 + startDt.getMinutes(), startDt, appt: a, name: g0.name || 'Guest', confirmed: !!a.confirmed, noShow: !!a.noShow, qm });
  });
  rows.sort((a,b) => a.startMin - b.startMin);
  const _now = new Date();
  const shown = _apptsUpcomingOnly
    ? rows.filter(r => r.startDt >= _now && !r.noShow && !['complete','paid','done'].includes(r.qm?.status))
    : rows;
  const fbtn = document.getElementById('cal-appts-filter-btn');
  if (fbtn) {
    fbtn.classList.toggle('text-primary', _apptsUpcomingOnly);
    fbtn.classList.toggle('bg-primary/10', _apptsUpcomingOnly);
    fbtn.classList.toggle('text-on-surface-variant', !_apptsUpcomingOnly);
    fbtn.title = _apptsUpcomingOnly ? 'Showing upcoming only — tap to show all' : 'Show upcoming only';
  }
  if (countEl) countEl.textContent = shown.length ? String(shown.length) : '';
  if (!shown.length) { listEl.innerHTML = `<div class="text-xs text-on-surface-variant text-center py-6 opacity-60">${_apptsUpcomingOnly ? 'No upcoming appointments' : 'No appointments'}</div>`; return; }
  const _e = s => (s||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'");
  const escHtml = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  listEl.innerHTML = shown.map(r => {
    const timeStr = r.startDt.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
    const qs = r.qm?.status;
    const stat = r.noShow ? ['#dc2626','No Show'] : qs==='inservice' ? ['#16a34a','In Service'] : qs==='complete' ? ['#0284c7','Complete'] : (qs==='paid'||qs==='done') ? ['#9ca3af','Paid'] : qs==='waiting' ? ['#2563eb','Checked In'] : r.confirmed ? ['#16a34a','Confirmed'] : (isToday && r.startDt < new Date() ? ['#ea580c','Not in'] : ['#9ca3af', isToday ? 'Unconfirmed' : '']);
    const svcLines = [];
    (r.appt.guests || []).forEach(g => { const fn = ((g.name||'').split(' ')[0]||g.name||'').trim(); (g.lines||[]).forEach(l => { const s = cfg().services.find(x=>x.id===l.serviceId); const tech = (cfg().staff||[]).find(x=>x.id===l.staffId)?.name || 'Unassigned'; svcLines.push(`${escHtml(s?.label||l.serviceId||'service')} · ${escHtml(fn)}${tech?` · <span style="opacity:0.8">${escHtml(tech)}</span>`:''}`); }); });
    const svcHtml = svcLines.slice(0,8).map(t => `<div style="font-size:10px;color:var(--on-surface-variant, #41484d);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${t}</div>`).join('');
    return `<div onclick="calEventClick(event,'${_e(r.appt.id)}')" class="rounded-lg border border-surface-container-high hover:bg-surface-container cursor-pointer px-2.5 py-2 transition-colors" style="background:var(--surface-container-lowest, #f5f7f8)">
      <div class="flex items-center gap-1.5" style="line-height:1.2">
        <span style="font-size:11px;font-weight:700;color:#1a5252;flex-shrink:0">${timeStr}</span>
        ${r.confirmed?'<span title="Confirmed" style="color:#16a34a;font-weight:800;font-size:11px;flex-shrink:0">✓</span>':''}
        <span style="font-size:12px;font-weight:700;color:var(--on-surface, #0e1a1a);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0">${escHtml(r.name)}</span>
        ${stat[1]?`<span style="font-size:9px;font-weight:700;color:${stat[0]};flex-shrink:0">${stat[1]}</span>`:''}
      </div>
      ${svcHtml}
    </div>`;
  }).join('');
}

// ── Script loading + auth ─────────────────────────
// Proactively refresh the Google token ~5 min before it expires (silent, no
// prompt) so the calendar stays connected — no 401, no manual reconnect.
function scheduleCalTokenRefresh(expires) {
  clearTimeout(_calRefreshTimer);
  const delay = Math.max(10000, expires - Date.now() - 5 * 60 * 1000);
  _calRefreshTimer = setTimeout(() => { _fetchWorkerToken().catch(() => {}); }, delay);
}
// Server-side token acquisition: ask the Worker (which holds the refresh token) for a fresh
// access token. Always works regardless of browser context (PWA / Safari / Chrome) — no GIS,
// no ITP. Throws on not_connected / reauth_required so the caller can show the Connect button.
async function _fetchWorkerToken() {
  const r = await fetch(`${GCAL_PROXY}/token`);
  if (!r.ok) { let e = 'token-' + r.status; try { e = (await r.json()).error || e; } catch {} throw new Error(e); }
  const j = await r.json();
  const saved = { token: j.access_token, expires: j.expires };
  localStorage.setItem('turndesk_turndesk_gcal_token', JSON.stringify(saved));
  if (window.gapi?.client) gapi.client.setToken({ access_token: saved.token });
  scheduleCalTokenRefresh(saved.expires);
  return saved;
}

// ── On-demand token freshness ─────────────────────
// The proactive refresh above is a single setTimeout, which browsers THROTTLE in a backgrounded
// tab — so it can fire late and the access token lapses. ensureFreshToken() re-mints from the
// Worker on demand right before any Google call when the token is expired/near expiry, so reads
// and writes always run on a valid token.
let _calInitDone = false, _calFocusHooked = false;
function _tokenFresh(skewMs = 120000) {
  try { const s = JSON.parse(localStorage.getItem('turndesk_turndesk_gcal_token') || 'null'); return !!(s && s.token && Date.now() < s.expires - skewMs); } catch (e) { return false; }
}
function ensureFreshToken() {
  if (_tokenFresh()) return Promise.resolve();
  return _fetchWorkerToken().then(() => {});
}
// First-connect side effects, run once (not on every silent refresh — that would reload the
// grid and yank the view mid-use).
function _calInitialLoad() { if (_calInitDone) return; _calInitDone = true; startCalSync(); calLoadAndRender(); loadTaskLists(); }
// A failed write is "authentication" when the token expired/was revoked or a refresh failed.
// Drop the stale token, kick a silent reconnect so the NEXT attempt works, and tell the user.
function _calWriteError(err, verb) {
  const msg = err?.result?.error?.message || err?.message || '';
  const auth = err?.status === 401 || err?.result?.error?.status === 'UNAUTHENTICATED' || /auth|credential|invalid.?token/i.test(msg);
  if (auth) {
    localStorage.removeItem('turndesk_turndesk_gcal_token');
    document.getElementById('cal-signin-btn')?.classList.remove('hidden');
    _fetchWorkerToken().catch(() => {});   // re-mint from the Worker's refresh token for the retry
    showToast('Calendar session expired — reconnecting. Please try again in a moment.');
  } else showToast(verb + ' failed: ' + (msg || 'Unknown error'));
}
// Keep the token alive when the desktop tab regains focus (the throttled setTimeout may have
// missed its window while backgrounded) and refresh the grid. Registered once.
function _hookCalFocusRefresh() {
  if (_calFocusHooked) return; _calFocusHooked = true;
  const onActive = () => { updateCalNowLine(); if (!_calInitDone) return; if (!localStorage.getItem('turndesk_turndesk_gcal_token') && !cfg().turndesk_turndesk_gcal_token) return; ensureFreshToken().then(() => calSilentSync()).catch(() => {}); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) onActive(); });
  window.addEventListener('focus', onActive);
  window.addEventListener('online', onActive);
}

export function loadGCalScripts() {
  _hookCalFocusRefresh();
  if (document.getElementById('gapi-script')) return;
  // Only gapi (the Calendar/Tasks API). The access token comes from the Worker (/gcal/token),
  // not the browser GIS sign-in — so there's no gsi/client script anymore.
  const s1 = document.createElement('script'); s1.id = 'gapi-script'; s1.src = 'https://apis.google.com/js/api.js';
  s1.onload = () => gapi.load('client', async () => { await gapi.client.init({ discoveryDocs: [GCAL_DISCOVERY, GTASK_DISCOVERY] }); _calGapiLoaded = true; _calTryReady(); });
  document.head.appendChild(s1);
}

function _calTryReady() {
  if (!_calGapiLoaded) return;
  // Bootstrap from the Worker: succeeds if a refresh token is stored, else show Connect.
  _fetchWorkerToken()
    .then(() => { document.getElementById('cal-signin-btn')?.classList.add('hidden'); calSetStatus(''); _calInitialLoad(); })
    .catch(() => { document.getElementById('cal-signin-btn')?.classList.remove('hidden'); calSetStatus('Click "Connect Google Calendar" to get started'); });
}

export function initCalendar() { _calDate = new Date(); calUpdateDateLabel(); calLoadAndRender(); }
// Re-render the calendar when appointments change on ANY device (the DO broadcast lands via
// sync.js → applyChange → notify). Only touch the DOM when the Calendar panel is showing;
// the Turns strip re-renders itself off apptsForTurns.
subscribe((state, op) => {
  if (op !== 'appt.upsert' && op !== 'appt.delete' && op !== 'hydrate') return;
  if (document.getElementById('panel-calendar')?.classList.contains('active')) {
    try { _calEvents = calApptsByColumn(calIsWeek() ? calWeekStart(_calDate) : _calDate, calIsWeek() ? (() => { const e = calWeekStart(_calDate); e.setDate(e.getDate()+6); return e; })() : _calDate); calRenderGridPreserveScroll(); renderTodaysAppointments(); } catch {}
  }
  if (document.getElementById('panel-turns')?.classList.contains('active')) { try { window.renderTurnsApptStrip?.(); } catch {} }
});
export function calSignIn(silent) {
  // Silent = re-mint from the Worker's stored refresh token (no user action). Interactive = send
  // the owner to Google's consent via the Worker; on return the app reloads and auto-connects.
  if (silent) { _fetchWorkerToken().then(() => { document.getElementById('cal-signin-btn')?.classList.add('hidden'); calSetStatus(''); if (_calInitDone) calSilentSync(); else _calInitialLoad(); }).catch(() => {}); return; }
  // Top-level navigation — no headers possible, so the §13 app token rides as ?auth=.
  location.href = withAuth(`${GCAL_PROXY}/connect?return=${encodeURIComponent(location.href.split('#')[0])}`);
}
export function calSignOut() {
  fetch(`${GCAL_PROXY}/disconnect`, { method: 'POST' }).catch(() => {});   // revoke + clear the refresh token server-side
  if (window.gapi?.client) gapi.client.setToken(null);
  localStorage.removeItem('turndesk_turndesk_gcal_token');
  _calInitDone = false;   // so a fresh sign-in re-runs the initial load
  _calCalendars = []; _calEvents = {};
  document.getElementById('cal-grid').classList.add('hidden');
  document.getElementById('cal-loading').classList.remove('hidden');
  document.getElementById('cal-signin-btn')?.classList.remove('hidden');
  calSetStatus('Signed out. Click Connect to sign back in.');
}
function calSetStatus(msg) {
  const el = document.getElementById('cal-status-msg'), loading = document.getElementById('cal-loading');
  if (!el || !loading) return;
  if (msg) { el.textContent = msg; loading.classList.remove('hidden'); document.getElementById('cal-grid').classList.add('hidden'); }
  else loading.classList.add('hidden');
}

// ── Date nav ──────────────────────────────────────
function calWeekRangeLabel() {
  const ws = calWeekStart(_calDate), we = new Date(ws); we.setDate(we.getDate() + 6);
  const f = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return ws.getMonth() === we.getMonth() ? `${f(ws)} – ${we.getDate()}` : `${f(ws)} – ${f(we)}`;
}
function calUpdateDateLabel() { const el = document.getElementById('cal-date-label'); if (el) el.textContent = calIsWeek() ? calWeekRangeLabel() : _calDate.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' }); calUpdateDateInput(); }
function calUpdateDateInput() {
  const btn = document.getElementById('cal-date-btn-val');
  if (btn) btn.textContent = calIsWeek() ? calWeekRangeLabel() : dateBtnLabel(_calDate);   // "Today · Tue, Jun 9" / "Jun 14 – 20"
  syncCalViewToggle();
}
// Day | Week toggle (toolbar). The buttons live in static HTML; active styling is set here.
export function setCalView(v) {
  const next = v === 'week' ? 'week' : 'day';
  if (next === _calView) return;
  _calView = next;
  try { localStorage.setItem('turndesk_cal_view', _calView); } catch {}
  _calOffPeek = new Set();
  calUpdateDateLabel();
  calLoadAndRender();
}
export function syncCalViewToggle() {
  // Segmented-control look (shared .subnav-seg/.subnav-btn styles): the selected side
  // is the raised white pill and shows a ✓ so the active view is unmistakable.
  const set = (id, on) => {
    const b = document.getElementById(id); if (!b) return;
    b.classList.toggle('on', on);
    const c = b.querySelector('.cal-view-check'); if (c) c.style.display = on ? '' : 'none';
  };
  set('cal-view-day', !calIsWeek());
  set('cal-view-week', calIsWeek());
}
// Tap a week-view day header / empty slot → that day in Day view.
export function calWeekOpenDay(dateStr) {
  _calOffPeek = new Set();
  _calDate = new Date(dateStr + 'T12:00:00');
  _calView = 'day';
  try { localStorage.setItem('turndesk_cal_view', 'day'); } catch {}
  calUpdateDateLabel();
  calLoadAndRender();
}
export function calNavDay(delta) { _calOffPeek = new Set(); _calDate = new Date(_calDate); _calDate.setDate(_calDate.getDate() + delta * (calIsWeek() ? 7 : 1)); calUpdateDateLabel(); calLoadAndRender(); }
export function calGoToday() { _calOffPeek = new Set(); _calDate = new Date(); calUpdateDateLabel(); calLoadAndRender(); }
export function calPickDate(val) { if (!val) return; _calOffPeek = new Set(); _calDate = new Date(val + 'T12:00:00'); calUpdateDateLabel(); calLoadAndRender(); }
// Square-style date popup: Today / In 1–6 weeks presets + month calendar (shared openDayPicker).
export function openCalDatePicker(ev) {
  const today = new Date();
  const presets = [0, 1, 2, 3, 4, 5, 6].map(n => { const d = new Date(today); d.setDate(d.getDate() + n * 7); return { label: n === 0 ? 'Today' : `In ${n} week${n > 1 ? 's' : ''}`, date: localDateStr(d) }; });
  window.openDayPicker?.(ev, { value: localDateStr(_calDate), onPick: calPickDate, presets });
}

export async function calLoadAndRender(silent) {
  try {
    _calCalendars = buildStaffColumns();
    if (_calCalendars.length <= 1) { applyCalOrder(); }   // only the Unassigned column exists yet
    applyCalOrder();
    // Day view = the viewed day; week view = Sun–Sat of the viewed week. Same _calEvents shape
    // ({ [colId]: [appt,...] }) the grid engine already consumes.
    const from = calIsWeek() ? calWeekStart(_calDate) : _calDate;
    const to = calIsWeek() ? (() => { const e = calWeekStart(_calDate); e.setDate(e.getDate() + 6); return e; })() : _calDate;
    const gbBefore = document.getElementById('cal-scroll'); const savedScroll = gbBefore ? gbBefore.scrollTop : null;
    _calEvents = calApptsByColumn(from, to);
    calRenderGrid();
    if (savedScroll !== null) requestAnimationFrame(() => { const gb = document.getElementById('cal-scroll'); if (gb) gb.scrollTop = savedScroll; });
    renderCalSelectorList(); calUpdateDateInput(); renderTodaysAppointments();
  } catch (err) {
    console.warn('[calendar] render failed:', err);
    calSetStatus('Error rendering calendar: ' + (err?.message || 'Unknown error'));
  }
}

export function calRenderGrid() {
  const grid = document.getElementById('cal-grid');
  if (!grid) return;
  syncCalViewToggle();
  if (calIsWeek()) return calRenderWeekGrid();
  const uCal = unassignedCalId();
  // "Unassigned only" view isolates the unassigned calendar full-width; turning it
  // off falls straight back to the previous calendars + order (nothing persisted).
  const visible = (_unassignedOnly && _calCalendars.some(c => c.id === uCal))
    ? _calCalendars.filter(c => c.id === uCal)
    : _calCalendars.filter(c => !calIsHidden(c));
  if (_calCalendars.length === 0) { calSetStatus('No technician calendars found.'); return; }
  if (visible.length === 0) {
    const hiddenByOff = calAutoHideOn() && _calCalendars.some(c => !_calHidden.has(c.id) && calColumnOff(c) && !_calOffPeek.has(c.id));
    calSetStatus(hiddenByOff ? 'No scheduled staff today — use the Calendars filter to show an off-duty calendar.' : 'All calendars hidden. Use Calendars filter.');
    document.getElementById('cal-loading').classList.remove('hidden'); grid.classList.add('hidden'); return;
  }
  calSetStatus(''); document.getElementById('cal-loading').classList.add('hidden'); grid.classList.remove('hidden');
  try {

  const c = JSON.parse(localStorage.getItem('turndesk_cal_hours') || 'null');
  const START_HOUR = c?.start ?? 6, END_HOUR = c?.end ?? 22, SLOT_MINS = _calSlotMins || 30;
  const SLOTS = (END_HOUR - START_HOUR) * (60 / SLOT_MINS), SLOT_H = _calSlotH || 52, HEADER_H = 48, TIME_W = 64;
  const railEl = document.getElementById('cal-right-rail');
  const railW = (railEl && railEl.style.display !== 'none') ? 280 : 0;
  const COL_W = Math.max(120, Math.floor((window.innerWidth - TIME_W - railW - 48) / visible.length));
  // When few calendars are shown a column gets very wide. Normally we cap each
  // bubble at ~2.5× its all-calendars width so a lone wide column doesn't stretch
  // bubbles across the screen — BUT in the explicit "Unassigned only" expand view
  // the whole point is to spread the appointments out, so let them fill the column.
  const normalColW = Math.max(120, Math.floor((window.innerWidth - TIME_W - railW - 48) / Math.max(1, _calCalendars.length)));
  const maxBubbleW = _unassignedOnly ? Infinity : normalColW * 2.5;
  const now = new Date(), isToday = now.toDateString() === _calDate.toDateString(), nowMin = now.getHours()*60 + now.getMinutes();
  const isPastDay = !isToday && _calDate < now;   // a fully-elapsed previous day → past appts resolve to Completed/No-Show from records
  // #3: grey a tech's column on their day off — see module-level calColumnOff().

  let hdr = `<div id="cal-header-row" style="display:flex;flex-shrink:0;position:sticky;top:0;z-index:4;border-bottom:2px solid var(--outline-variant, #7a858a);background:var(--surface-container-lowest, #f5f7f8)"><div style="width:${TIME_W}px;flex-shrink:0;height:${HEADER_H}px;position:sticky;left:0;z-index:5;background:var(--surface-container-lowest, #f5f7f8);border-right:2px solid var(--outline-variant, #7a858a)"></div>`;
  visible.forEach((cal,i) => { const isLast = i === visible.length-1; const off = calColumnOff(cal); const dot = off ? '#9ca3af' : cal.color; hdr += `<div style="width:${COL_W}px;flex-shrink:0;height:${HEADER_H}px;background:${off ? '#e5e7eb' : cal.color + '18'};border-bottom:3px solid ${dot};border-right:${isLast?'none':'2px solid rgba(0,0,0,0.12)'};display:flex;align-items:center;justify-content:center;gap:5px;padding:0 8px"><div style="width:10px;height:10px;border-radius:50%;background:${dot};flex-shrink:0"></div><span style="font-size:13px;font-family:var(--font-headline);font-weight:700;color:${off ? '#9ca3af' : 'var(--on-surface, #0e1a1a)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${calDisplayName(cal)}${off ? ' · off' : ''}</span></div>`; });
  hdr += `</div>`;

  let body = `<div id="cal-grid-body" style="display:flex;min-width:${TIME_W + COL_W*visible.length}px"><div style="width:${TIME_W}px;flex-shrink:0;position:sticky;left:0;z-index:3;background:var(--surface-container-lowest, #f5f7f8);border-right:2px solid var(--outline-variant, #7a858a)">`;
  for (let s = 0; s < SLOTS; s++) { const h = Math.floor((START_HOUR*60 + s*SLOT_MINS)/60), m = (START_HOUR*60 + s*SLOT_MINS)%60, isHour = m === 0; const label = isHour ? `${h>12?h-12:(h===0?12:h)} ${h>=12?'PM':'AM'}` : (SLOT_MINS<=15&&m===30?`${h>12?h-12:(h===0?12:h)}:30`:''); body += `<div style="height:${SLOT_H}px;display:flex;align-items:flex-start;padding:${isHour?'3px':'1px'} 8px 0">${label?`<span style="font-size:10px;font-family:var(--font-body);font-weight:${isHour?'600':'400'};color:var(--on-surface-variant, #41484d);white-space:nowrap;margin-top:-6px">${label}</span>`:''}</div>`; }
  body += '</div>';

  const SVC_GROUPS = [{ids:['fullset','fill','dip'],color:'#7b1fa2'},{ids:['pedicure','kidpedicure'],color:'#0277bd'},{ids:['manicure','polishchange','kidmani'],color:'#00695c'},{ids:['wax'],color:'#e65100'}];
  // Which calendars each booking appears on today → drives the "same appointment
  // on another calendar" link indicator (e.g. assigned tech + unassigned).
  const groupCals = {};   // (native) no cross-calendar copies — link indicator is disabled
  const calName = cid => calDisplayName(cid);
  visible.forEach((cal,colIdx) => {
    const events = _calEvents[cal.id] || [], isLast = colIdx === visible.length-1, isFirst = colIdx === 0;
    const off = calColumnOff(cal);   // #3: grey the column for a tech who's off this day
    body += `<div style="width:${COL_W}px;flex-shrink:0;position:relative;${off ? 'background:#e9ebed;opacity:0.6;' : ''}${isFirst?'border-left:2px solid rgba(0,0,0,0.12);':''}${isLast?'':'border-right:2px solid rgba(0,0,0,0.12);'}min-height:${SLOTS*SLOT_H}px"><div style="position:relative;height:${SLOTS*SLOT_H}px">`;
    for (let s = 0; s < SLOTS; s++) { const isHour = s % (60/SLOT_MINS) === 0; const h = START_HOUR + Math.floor(s*SLOT_MINS/60), m = (s*SLOT_MINS)%60; body += `<div style="position:absolute;left:0;right:0;top:${s*SLOT_H}px;height:${SLOT_H}px;border-top:${isHour?'1.5px solid rgba(0,0,0,0.12)':'1px solid rgba(0,0,0,0.05)'};cursor:pointer" onclick="calSlotClick('${cal.id}',${h},${m})"></div>`; }
    if (isToday) { const lineTop = ((nowMin - START_HOUR*60)/SLOT_MINS)*SLOT_H; if (lineTop >= 0 && lineTop <= SLOTS*SLOT_H) body += `<div class="cal-now-line" data-start="${START_HOUR}" data-slotmins="${SLOT_MINS}" data-sloth="${SLOT_H}" data-slots="${SLOTS}" style="position:absolute;left:0;right:0;top:${lineTop}px;height:0;border-top:2px dashed #e53935;z-index:5;pointer-events:none">${colIdx===0?`<div style="position:absolute;left:-3px;top:-5px;width:10px;height:10px;border-radius:50%;background:#e53935"></div>`:''}</div>`; }
    // Native: each appointment is exactly one booking bubble (all its guests/lines live on
    // the one appt), keyed by the appt id. The lane-clustering below still spreads
    // same-time bubbles side by side so concurrent appointments don't pile up.
    const bookings = new Map();
    events.forEach(a => { if (!a.start) return; bookings.set(a.id, [a]); });   // one appt = one booking
    const _e = s => (s||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;').replace(/\n/g,' ').replace(/\r/g,'');
    const escHtml = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    // Lay out bookings: position + height, then assign side-by-side lanes so that
    // different customers booked at the same time sit next to each other instead of
    // stacking on top of each other (req: cleanly see concurrent appointments).
    const layout = [];
    bookings.forEach(evs => {
      const first = evs[0];
      const startDt = new Date(first.start), endDt = new Date(first.end || (startDt.getTime()+3600000));
      const sMin = startDt.getHours()*60+startDt.getMinutes(), eMin = endDt.getHours()*60+endDt.getMinutes();
      const topMin = sMin - START_HOUR*60, durMin = Math.max(eMin-sMin,15);
      if (topMin < 0 || topMin >= (END_HOUR-START_HOUR)*60) return;
      layout.push({ evs, first, startDt, startMin: sMin, endMin: sMin + durMin, top: (topMin/SLOT_MINS)*SLOT_H, ht: (durMin/SLOT_MINS)*SLOT_H });
    });
    layout.sort((a,b) => a.startMin - b.startMin || a.endMin - b.endMin);
    let cluster = [], clusterEnd = -1;
    const finalizeCluster = cl => { const laneEnds = []; cl.forEach(b => { let li = laneEnds.findIndex(end => end <= b.startMin); if (li === -1) { li = laneEnds.length; laneEnds.push(0); } laneEnds[li] = b.endMin; b.lane = li; }); cl.forEach(b => b.laneCount = laneEnds.length); };
    layout.forEach(b => { if (cluster.length && b.startMin >= clusterEnd) { finalizeCluster(cluster); cluster = []; clusterEnd = -1; } cluster.push(b); clusterEnd = Math.max(clusterEnd, b.endMin); });
    if (cluster.length) finalizeCluster(cluster);
    layout.forEach(({ evs, first, startDt, top, ht, lane = 0, laneCount = 1 }) => {
      try {
      const timeStr = startDt.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
      const gid = '';                       // native: no group link
      const linkedCals = [];
      const linked = false;
      const innerW = Math.min(COL_W - 8, maxBubbleW), gap = laneCount > 1 ? 3 : 0;
      const laneW = (innerW - gap*(laneCount-1)) / laneCount;
      const bLeft = 4 + lane*(laneW + gap);
      const g0 = (first.guests || [])[0] || {};
      const primaryName = g0.name || 'Guest';
      const primaryPhone = g0.phone || '';
      const notes = first.notes || '', confirmed = !!first.confirmed, isPast = startDt < now;
      const noShow = !!first.noShow;
      // Appointment-ness + a queue match for the booking. The check-in link is matched
      // against EVERY copy's id (all calendars), so the Paid/Checked-In badge shows on
      // every column — not just the copy the check-in went through. Phone fallback only
      // after that; never a loose name prefix.
      let isAppt = true, qm = _queueForAppt(first.id);
      if (!qm) qm = _phoneQueueMatch((primaryPhone || '').replace(/\D/g,''), startDt.getTime());
      const qs = qm?.status || null;
      const svcRows = linesForColumn(first, cal.id);
      const dotColors = [...new Set(svcRows.map(r => (SVC_GROUPS.find(x => x.ids.some(id => (r.svcId||'').toLowerCase().includes(id)))||{}).color || '#455a64'))].slice(0,6);
      const chips = dotColors.map(c => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c};margin-right:2px;flex-shrink:0"></span>`).join('');
      let bg, border, tc = '#1a1a1a', pastStatus = '';   // status is conveyed by the bubble's color
      if (!isAppt) { bg='#eceff1'; border='#78909c'; tc='#37474f'; }
      else if (qs==='paid' || qs==='done') { bg='#f3f4f6'; border='#9ca3af'; tc='#6b7280'; }
      else if (qs==='complete') { bg='#e0f2fe'; border='#0284c7'; tc='#0c4a6e'; }
      else if (qs==='inservice') { bg='#dcfce7'; border='#16a34a'; tc='#14532d'; }
      else if (qs==='waiting') { bg='#dbeafe'; border='#2563eb'; tc='#1e3a8a'; }
      else if (isPast && isAppt && isToday) { bg='#fff7ed'; border='#ea580c'; tc='#7c2d12'; }   // TODAY only: passed start, not checked in → "running late" amber
      else { bg=cal.color+'1f'; border=cal.color; tc='#1a1a1a'; }   // upcoming appt → tinted by this tech's color
      // Past day: resolve the appointment against the records — Completed (showed up) or
      // No Show (had a phone/link to check, no record). Unknowable (no phone) stays plain.
      if (isPastDay && isAppt && !noShow) {
        const rawP = (primaryPhone || '').replace(/\D/g, '');
        const rec = _pastRecordMatch([first.id], rawP, startDt.getTime());
        if (rec) { bg='#e0f2fe'; border='#0284c7'; tc='#0c4a6e'; pastStatus='Completed'; }
        else if (rawP) { bg='#fee2e2'; border='#dc2626'; tc='#991b1b'; pastStatus='No Show'; }
      }
      if (noShow) { bg='#fee2e2'; border='#dc2626'; tc='#991b1b'; }   // manual no-show overrides all

      const phoneLine = [timeStr, primaryPhone].filter(Boolean).join('  ·  ');
      const svcHtml = svcRows.map(r => `<div style="font-size:10px;color:${tc};opacity:0.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.35">${escHtml(r.label)}${r.fn&&r.label?' — ':''}${escHtml(r.fn)}</div>`).join('');
      const linkIcon = linked ? `<span title="${_e('Same appointment — also on ' + linkedCals.map(calName).join(', '))}" class="material-symbols-outlined" style="font-size:12px;color:${border};flex-shrink:0;transform:rotate(-45deg)">link</span>` : '';
      // Once the appointment is checked in, show its queue status as a badge on the bubble.
      const qLabel = noShow ? 'No Show' : pastStatus || { waiting:'Checked In', inservice:'In Service', complete:'Complete', paid:'Paid', done:'Paid' }[qs] || '';
      const qBadge = qLabel ? `<span style="flex-shrink:0;font-size:7.5px;font-weight:800;color:#fff;background:${border};border-radius:999px;padding:1px 5px;white-space:nowrap">${qLabel}</span>` : '';
      body += `<div onclick="calEventClick(event,'${_e(first.id)}')" style="position:absolute;left:${bLeft}px;width:${laneW}px;top:${top}px;height:${Math.max(ht,26)}px;background:${bg};border-left:3px solid ${border};border-radius:6px;padding:3px 6px;cursor:pointer;overflow:hidden;z-index:1;box-shadow:0 1px 3px rgba(0,0,0,0.12)">`
        + `<div style="display:flex;align-items:center;gap:2px;overflow:hidden;line-height:1.25">${linkIcon}${chips}${confirmed?'<span title="Confirmed" style="color:#16a34a;font-weight:800;flex-shrink:0">✓</span>':''}<span style="font-size:11px;font-family:var(--font-body);font-weight:700;color:${tc};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0">${escHtml(primaryName)}</span>${qBadge}</div>`
        + (ht>30?`<div style="font-size:10px;color:${tc};opacity:0.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(phoneLine)}</div>`:'')
        + (ht>44?svcHtml:'')
        + (notes&&ht>44?`<div style="font-size:9px;color:${tc};opacity:0.7;white-space:pre-wrap;overflow-wrap:anywhere;overflow:hidden;line-height:1.3">📝 ${escHtml(notes)}</div>`:'')
        + `</div>`;
      } catch (_bErr) { console.warn('[calendar] skipped a booking render:', _bErr); }
    });
    body += '</div></div>';
  });
  body += '</div>';
  // Single scroll container for BOTH the header and the body, so they scroll horizontally
  // together and a touch starting on EITHER the headers or the grid pans the whole thing (iPad).
  // The header sticks to the top during vertical scroll; the time column sticks to the left
  // during horizontal scroll (both relative to this one scrollport).
  grid.innerHTML = `<div id="cal-scroll" style="height:100%;overflow:auto;position:relative;-webkit-overflow-scrolling:touch"><div style="min-width:${TIME_W + COL_W*visible.length}px;display:flex;flex-direction:column;min-height:100%">${hdr}${body}</div></div>`;
  const gb = document.getElementById('cal-scroll');
  if (gb) { const scrollToHour = Math.max(START_HOUR, now.getHours()-1); gb.scrollTop = Math.max(0, (scrollToHour-START_HOUR)*(60/SLOT_MINS)*SLOT_H - 10); }
  startCalNowLine();
  } catch (_calErr) { console.warn('[calendar] grid render failed:', _calErr); }
}
function calRenderGridPreserveScroll() { const gb = document.getElementById('cal-scroll'); const saved = gb ? gb.scrollTop : null; calRenderGrid(); if (saved !== null) requestAnimationFrame(() => { const n = document.getElementById('cal-scroll'); if (n) n.scrollTop = saved; }); }

// ── Week view grid ─────────────────────────────────
// 7 day columns (Sun–Sat) with every VISIBLE staff column's bookings merged per day,
// tinted by each booking's staff color — the overview competitors call "week view".
// One block per appointment (deduped by appt id; a real staff column wins over the
// Unassigned column for color/click ownership). Manual show/hide applies; the per-day
// off-duty auto-hide does not (it's a single-day concept). Tap a block → the normal
// appointment popover; tap a day header or empty space → that day's Day view.
function calRenderWeekGrid() {
  const grid = document.getElementById('cal-grid');
  if (!grid) return;
  const uCal = unassignedCalId();
  const visible = (_unassignedOnly && _calCalendars.some(c => c.id === uCal))
    ? _calCalendars.filter(c => c.id === uCal)
    : _calCalendars.filter(c => !_calHidden.has(c.id));
  if (_calCalendars.length === 0) { calSetStatus('No technician calendars found.'); return; }
  if (visible.length === 0) {
    calSetStatus('All calendars hidden. Use Calendars filter.');
    document.getElementById('cal-loading').classList.remove('hidden'); grid.classList.add('hidden'); return;
  }
  calSetStatus(''); document.getElementById('cal-loading').classList.add('hidden'); grid.classList.remove('hidden');
  try {

  const c = JSON.parse(localStorage.getItem('turndesk_cal_hours') || 'null');
  const START_HOUR = c?.start ?? 6, END_HOUR = c?.end ?? 22, SLOT_MINS = _calSlotMins || 30;
  const SLOTS = (END_HOUR - START_HOUR) * (60 / SLOT_MINS), SLOT_H = _calSlotH || 52, HEADER_H = 48, TIME_W = 64;
  const railEl = document.getElementById('cal-right-rail');
  const railW = (railEl && railEl.style.display !== 'none') ? 280 : 0;
  const COL_W = Math.max(110, Math.floor((window.innerWidth - TIME_W - railW - 48) / 7));
  const ws = calWeekStart(_calDate);
  const days = [...Array(7)].map((_, i) => { const d = new Date(ws); d.setDate(d.getDate() + i); return d; });
  const todayKey = localDateStr(new Date());
  const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
  const _e = s => (s||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;').replace(/\n/g,' ').replace(/\r/g,'');
  const escHtml = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  // Dedup bookings across visible calendars (a booking is one event per calendar).
  // ownEv = the event copy that lives ON the owning calendar — calEventClick() looks
  // the id up in _calEvents[calId], so the clicked id must belong to that calendar.
  const seen = new Map();   // apptId -> { evs:[appt], calId (owning col for color) }
  visible.forEach(cal => (_calEvents[cal.id] || []).forEach(a => {
    if (!a.start) return;
    let b = seen.get(a.id);
    if (!b) { b = { evs: [a], calId: cal.id }; seen.set(a.id, b); }
    if (b.calId === '' && cal.id !== '') b.calId = cal.id;   // prefer a real staff column for color
  }));
  const byDay = days.map(() => []);
  const dayKeys = days.map(d => localDateStr(d));
  seen.forEach(({ evs, calId }) => {
    const first = evs[0];
    const startDt = new Date(first.start);
    const endDt = new Date(first.end || (startDt.getTime() + 3600000));
    const di = dayKeys.indexOf(localDateStr(startDt));
    if (di < 0) return;
    const sMin = startDt.getHours() * 60 + startDt.getMinutes(), eMin = endDt.getHours() * 60 + endDt.getMinutes();
    const topMin = sMin - START_HOUR * 60, durMin = Math.max(eMin - sMin, 15);
    if (topMin < 0 || topMin >= (END_HOUR - START_HOUR) * 60) return;
    byDay[di].push({ evs, calId, first, startDt, startMin: sMin, endMin: sMin + durMin, top: (topMin / SLOT_MINS) * SLOT_H, ht: (durMin / SLOT_MINS) * SLOT_H });
  });

  let hdr = `<div id="cal-header-row" style="display:flex;flex-shrink:0;position:sticky;top:0;z-index:4;border-bottom:2px solid var(--outline-variant, #7a858a);background:var(--surface-container-lowest, #f5f7f8)"><div style="width:${TIME_W}px;flex-shrink:0;height:${HEADER_H}px;position:sticky;left:0;z-index:5;background:var(--surface-container-lowest, #f5f7f8);border-right:2px solid var(--outline-variant, #7a858a)"></div>`;
  days.forEach((d, i) => {
    const isToday = dayKeys[i] === todayKey, isLast = i === 6;
    hdr += `<div onclick="calWeekOpenDay('${dayKeys[i]}')" title="Open this day" style="width:${COL_W}px;flex-shrink:0;height:${HEADER_H}px;cursor:pointer;background:${isToday ? 'rgba(26,82,82,0.10)' : 'transparent'};border-bottom:3px solid ${isToday ? 'var(--md-primary, #1a5252)' : 'transparent'};border-right:${isLast ? 'none' : '2px solid rgba(0,0,0,0.12)'};display:flex;flex-direction:column;align-items:center;justify-content:center">`
      + `<span style="font-size:10px;font-family:var(--font-body);font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:${isToday ? 'var(--md-primary, #1a5252)' : 'var(--on-surface-variant, #41484d)'}">${d.toLocaleDateString('en-US', { weekday: 'short' })}${isToday ? ' · Today' : ''}</span>`
      + `<span style="font-size:16px;font-family:var(--font-headline);font-weight:800;line-height:1.1;color:${isToday ? 'var(--md-primary, #1a5252)' : 'var(--on-surface, #0e1a1a)'}">${d.getDate()}</span></div>`;
  });
  hdr += `</div>`;

  let body = `<div id="cal-grid-body" style="display:flex;min-width:${TIME_W + COL_W * 7}px"><div style="width:${TIME_W}px;flex-shrink:0;position:sticky;left:0;z-index:3;background:var(--surface-container-lowest, #f5f7f8);border-right:2px solid var(--outline-variant, #7a858a)">`;
  for (let s = 0; s < SLOTS; s++) { const h = Math.floor((START_HOUR*60 + s*SLOT_MINS)/60), m = (START_HOUR*60 + s*SLOT_MINS)%60, isHour = m === 0; const label = isHour ? `${h>12?h-12:(h===0?12:h)} ${h>=12?'PM':'AM'}` : (SLOT_MINS<=15&&m===30?`${h>12?h-12:(h===0?12:h)}:30`:''); body += `<div style="height:${SLOT_H}px;display:flex;align-items:flex-start;padding:${isHour?'3px':'1px'} 8px 0">${label?`<span style="font-size:10px;font-family:var(--font-body);font-weight:${isHour?'600':'400'};color:var(--on-surface-variant, #41484d);white-space:nowrap;margin-top:-6px">${label}</span>`:''}</div>`; }
  body += '</div>';

  days.forEach((d, di) => {
    const isToday = dayKeys[di] === todayKey, isLast = di === 6, isFirst = di === 0;
    const isPastDay = dayKeys[di] < todayKey;   // previous day → resolve past appts to Completed/No-Show
    body += `<div style="width:${COL_W}px;flex-shrink:0;position:relative;${isToday ? 'background:rgba(26,82,82,0.04);' : ''}${isFirst ? 'border-left:2px solid rgba(0,0,0,0.12);' : ''}${isLast ? '' : 'border-right:2px solid rgba(0,0,0,0.12);'}min-height:${SLOTS*SLOT_H}px"><div style="position:relative;height:${SLOTS*SLOT_H}px">`;
    for (let s = 0; s < SLOTS; s++) { const isHour = s % (60/SLOT_MINS) === 0; body += `<div style="position:absolute;left:0;right:0;top:${s*SLOT_H}px;height:${SLOT_H}px;border-top:${isHour?'1.5px solid rgba(0,0,0,0.12)':'1px solid rgba(0,0,0,0.05)'};cursor:pointer" onclick="calWeekOpenDay('${dayKeys[di]}')"></div>`; }
    if (isToday) { const lineTop = ((nowMin - START_HOUR*60)/SLOT_MINS)*SLOT_H; if (lineTop >= 0 && lineTop <= SLOTS*SLOT_H) body += `<div class="cal-now-line" data-date="${dayKeys[di]}" data-start="${START_HOUR}" data-slotmins="${SLOT_MINS}" data-sloth="${SLOT_H}" data-slots="${SLOTS}" style="position:absolute;left:0;right:0;top:${lineTop}px;height:0;border-top:2px dashed #e53935;z-index:5;pointer-events:none"><div style="position:absolute;left:-3px;top:-5px;width:10px;height:10px;border-radius:50%;background:#e53935"></div></div>`; }

    const layout = byDay[di];
    layout.sort((a,b) => a.startMin - b.startMin || a.endMin - b.endMin);
    let cluster = [], clusterEnd = -1;
    const finalizeCluster = cl => { const laneEnds = []; cl.forEach(b => { let li = laneEnds.findIndex(end => end <= b.startMin); if (li === -1) { li = laneEnds.length; laneEnds.push(0); } laneEnds[li] = b.endMin; b.lane = li; }); cl.forEach(b => b.laneCount = laneEnds.length); };
    layout.forEach(b => { if (cluster.length && b.startMin >= clusterEnd) { finalizeCluster(cluster); cluster = []; clusterEnd = -1; } cluster.push(b); clusterEnd = Math.max(clusterEnd, b.endMin); });
    if (cluster.length) finalizeCluster(cluster);

    layout.forEach(({ evs, calId, first, startDt, top, ht, lane = 0, laneCount = 1 }) => {
      try {
      const cal = _calCalendars.find(x => x.id === calId);
      const color = (calId === '' || !cal) ? '#9ca3af' : cal.color;
      const timeStr = startDt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const g0 = (first.guests || [])[0] || {};
      const primaryName = g0.name || 'Guest';
      const notes = first.notes || '';
      const confirmed = !!first.confirmed;
      const noShow = !!first.noShow;
      const guests = Math.max(0, (first.guests || []).length - 1);
      let isAppt = true;
      const gap = laneCount > 1 ? 3 : 0;
      const laneW = (COL_W - 8 - gap * (laneCount - 1)) / laneCount;
      const bLeft = 4 + lane * (laneW + gap);
      let bg = color + '1f', border = color, tc = '#1a1a1a';
      if (isPastDay && isAppt && !noShow) {
        const rawP = ((first.guests || [])[0]?.phone || '').replace(/\D/g, '');
        const rec = _pastRecordMatch([first.id], rawP, startDt.getTime());
        if (rec) { bg='#e0f2fe'; border='#0284c7'; tc='#0c4a6e'; }
        else if (rawP) { bg='#fee2e2'; border='#dc2626'; tc='#991b1b'; }
      }
      if (noShow) { bg='#fee2e2'; border='#dc2626'; tc='#991b1b'; }
      body += `<div onclick="event.stopPropagation();calEventClick(event,'${_e(first.id)}')" style="position:absolute;left:${bLeft}px;width:${laneW}px;top:${top}px;height:${Math.max(ht,24)}px;background:${bg};border-left:3px solid ${border};border-radius:6px;padding:2px 5px;cursor:pointer;overflow:hidden;z-index:1;box-shadow:0 1px 3px rgba(0,0,0,0.12)">`
        + `<div style="display:flex;align-items:center;gap:3px;overflow:hidden;line-height:1.25">${confirmed ? '<span title="Confirmed" style="color:#16a34a;font-weight:800;flex-shrink:0;font-size:10px">✓</span>' : ''}<span style="font-size:11px;font-family:var(--font-body);font-weight:700;color:${tc};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0">${escHtml(primaryName)}${guests ? ` +${guests}` : ''}</span></div>`
        + (ht > 30 ? `<div style="font-size:10px;color:${tc};opacity:0.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(timeStr)}${cal && calId !== uCal ? ' · ' + escHtml(calDisplayName(cal)) : ''}</div>` : '')
        + `</div>`;
      } catch (_bErr) { console.warn('[calendar] skipped a week booking render:', _bErr); }
    });
    body += '</div></div>';
  });
  body += '</div>';

  // Staff color key — week blocks are tinted by tech, so name the colors. Pinned above
  // the scrollport (doesn't scroll away); one chip per visible calendar, grid order.
  const legend = `<div id="cal-week-legend" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;flex-shrink:0;padding:6px 12px;border-bottom:1.5px solid var(--outline-variant, #cfd8d8);background:var(--surface-container-lowest, #f5f7f8)">`
    + `<span style="font-size:10px;font-family:var(--font-body);font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--on-surface-variant, #41484d)">Staff</span>`
    + visible.map(cal => {
        const color = cal.id === uCal ? '#9ca3af' : cal.color;
        return `<span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;font-family:var(--font-body);font-weight:600;color:var(--on-surface, #0e1a1a)"><span style="width:10px;height:10px;border-radius:50%;background:${color};flex-shrink:0"></span>${escHtml(calDisplayName(cal))}</span>`;
      }).join('')
    + `</div>`;
  grid.innerHTML = `<div style="height:100%;display:flex;flex-direction:column">${legend}<div id="cal-scroll" style="flex:1;min-height:0;overflow:auto;position:relative;-webkit-overflow-scrolling:touch"><div style="min-width:${TIME_W + COL_W * 7}px;display:flex;flex-direction:column;min-height:100%">${hdr}${body}</div></div></div>`;
  const gb = document.getElementById('cal-scroll');
  if (gb) { const scrollToHour = Math.max(START_HOUR, now.getHours() - 1); gb.scrollTop = Math.max(0, (scrollToHour - START_HOUR) * (60 / SLOT_MINS) * SLOT_H - 10); }
  startCalNowLine();
  } catch (_calErr) { console.warn('[calendar] week grid render failed:', _calErr); }
}

// ── "Now" line keep-alive ─────────────────────────
// The red current-time line is positioned at grid-render time, so on its own it only moves when
// the grid re-renders (every CAL_SYNC_INTERVAL) and FREEZES while a backgrounded / asleep iPad
// throttles timers — that's the "lags behind" report. This repositions the existing line(s)
// cheaply (no re-render) on a short timer, and onActive() snaps it the instant the iPad wakes.
// Geometry (start hour / slot size) is read from the line's data-attrs so it tracks the zoom.
let _calNowTimer = null;
function updateCalNowLine() {
  const lines = document.querySelectorAll('.cal-now-line');
  if (!lines.length) return;
  const now = new Date();
  // Week view stamps the line's own date (today's column); day view checks the viewed day.
  const lineDate = lines[0].dataset.date;
  if (lineDate ? lineDate !== localDateStr(now) : now.toDateString() !== _calDate.toDateString()) return;
  const g = lines[0].dataset, startHour = +g.start, slotMins = +g.slotmins || 30, slotH = +g.sloth || 52, slots = +g.slots;
  const nowMin = now.getHours()*60 + now.getMinutes() + now.getSeconds()/60;
  const lineTop = ((nowMin - startHour*60)/slotMins)*slotH;
  const vis = lineTop >= 0 && lineTop <= slots*slotH;
  lines.forEach(el => { el.style.display = vis ? '' : 'none'; if (vis) el.style.top = lineTop + 'px'; });
}
function startCalNowLine() { if (_calNowTimer) return; _calNowTimer = setInterval(updateCalNowLine, 30000); }

// ── Sync ──────────────────────────────────────────
async function calSilentSync() {
  if (!gapi?.client?.getToken()?.access_token) return;
  // Keep the token alive on the foreground sync tick too (self-heals the read loop if the
  // proactive refresh timer was throttled). If it's expired and can't refresh, bail to error.
  if (!_tokenFresh(0)) { try { await ensureFreshToken(); } catch (e) { setCalSyncIndicator('error'); return; } }
  try {
    setCalSyncIndicator('syncing');
    const dayStart = calIsWeek() ? calWeekStart(_calDate) : new Date(_calDate); dayStart.setHours(0,0,0,0);
    const dayEnd = new Date(dayStart); if (calIsWeek()) dayEnd.setDate(dayEnd.getDate() + 6); dayEnd.setHours(23,59,59,999);
    const newEvents = {}; let anyFail = false;
    await Promise.all(_calCalendars.map(async cal => { try { const r = await gapi.client.calendar.events.list({ calendarId: cal.id, timeMin: dayStart.toISOString(), timeMax: dayEnd.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: calIsWeek() ? 250 : 100 }); newEvents[cal.id] = _gcalApplyGuards(cal.id, r.result.items); } catch (e) { anyFail = true; console.warn('[calendar] silent sync failed for', cal.name, e); newEvents[cal.id] = _calEvents[cal.id] || []; } }));
    _calEvents = newEvents;
    // Preserve the user's scroll position on a silent refresh — calRenderGrid()
    // re-scrolls to ~1hr-before-now, which yanked the view away mid-use.
    if (document.getElementById('panel-calendar')?.classList.contains('active')) calRenderGridPreserveScroll();
    renderTodaysAppointments();
    // A per-cal failure keeps that column's stale events; flag the pill 'error' so a frozen
    // column isn't masked by a healthy green pill.
    setCalSyncIndicator(anyFail ? 'error' : 'ok');
  } catch (e) { setCalSyncIndicator('error'); }
}
function startCalSync() { if (_calSyncTimer) return; setCalSyncIndicator('ok'); _calSyncTimer = setInterval(() => calSilentSync(), CAL_SYNC_INTERVAL); }
export async function calForceSync() { setCalSyncIndicator('syncing'); try { await calSilentSync(); setCalSyncIndicator('ok'); showToast('Calendar synced ✓'); } catch (e) { setCalSyncIndicator('error'); showToast('Calendar sync failed'); } }
function setCalSyncIndicator(state) {
  const dot = document.getElementById('cal-sync-dot'), text = document.getElementById('cal-sync-text'), pill = document.getElementById('cal-sync-pill');
  if (!dot) return; if (pill) pill.style.display = 'flex';
  const states = { ok:{bg:'#2a7a4f',label:'Calendar'}, syncing:{bg:'#f5c870',label:null}, error:{bg:'#fa746f',label:'Cal ✗'}, idle:{bg:'#adb3b5',label:'Calendar'} };
  const s = states[state] || states.idle; dot.style.background = s.bg; if (text && s.label !== null) text.textContent = s.label;
}

// ── Zoom (ctrl+wheel / pinch) ─────────────────────
export function calHandleWheel(e) { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); calAdjustZoom(e.deltaY > 0 ? -1 : 1); }
export function calTouchStart(e) { if (e.touches.length === 2) _calTouchStartDist = Math.hypot(e.touches[0].clientX-e.touches[1].clientX, e.touches[0].clientY-e.touches[1].clientY); }
export function calTouchMove(e) { if (e.touches.length !== 2 || !_calTouchStartDist) return; const dist = Math.hypot(e.touches[0].clientX-e.touches[1].clientX, e.touches[0].clientY-e.touches[1].clientY); if (Math.abs(dist-_calTouchStartDist) > 20) { calAdjustZoom(dist > _calTouchStartDist ? 1 : -1); _calTouchStartDist = dist; } }
function calAdjustZoom(direction) {
  const levels = [{slotMins:60,slotH:80},{slotMins:30,slotH:52},{slotMins:15,slotH:36}];
  const cur = levels.findIndex(l => l.slotMins === _calSlotMins);
  const next = Math.max(0, Math.min(levels.length-1, cur+direction));
  if (next === cur) return; _calSlotMins = levels[next].slotMins; _calSlotH = levels[next].slotH; calRenderGridPreserveScroll();
}

// ── Unassigned-only view toggle ───────────────────
export function toggleUnassignedOnly() {
  _unassignedOnly = !_unassignedOnly;
  updateUnassignedToggleBtn();
  calRenderGridPreserveScroll();
}
function updateUnassignedToggleBtn() {
  const btn = document.getElementById('cal-unassigned-toggle'); if (!btn) return;
  btn.style.background = _unassignedOnly ? 'var(--primary, #1a5252)' : '';
  btn.style.color = _unassignedOnly ? '#fff' : '';
  btn.classList.toggle('bg-surface-container', !_unassignedOnly);
  btn.title = _unassignedOnly ? 'Showing unassigned only — tap to show all calendars' : 'Show only unassigned appointments';
}

// ── Calendar selector (show/hide + reorder) ───────
export function toggleCalSelector() {
  const dd = document.getElementById('cal-selector-dropdown'); if (!dd) return;
  if (dd.classList.contains('hidden')) {
    _calSelectorDraft = { order: _calCalendars.map(c => c.id), hidden: calEffectiveHiddenSet() };
    renderCalSelectorList(); dd.classList.remove('hidden');
    // Stop clicks INSIDE the dropdown from reaching the outside-click closer below.
    // (Toggling a row re-renders the list, detaching the clicked node, which would
    // otherwise fool `dd.contains(e.target)` into thinking the click was outside.)
    dd.onclick = (e) => e.stopPropagation();
    setTimeout(() => document.addEventListener('click', function closeDD(e) { if (!dd.contains(e.target)) { dd.classList.add('hidden'); _calSelectorDraft = null; document.removeEventListener('click', closeDD); } }), 10);
  } else { dd.classList.add('hidden'); _calSelectorDraft = null; }
}
function applyCalOrder() {
  if (!_calOrder || _calOrder.length === 0) return;
  const ordered = []; _calOrder.forEach(id => { const c = _calCalendars.find(x => x.id === id); if (c) ordered.push(c); });
  _calCalendars.forEach(c => { if (!ordered.find(x => x.id === c.id)) ordered.push(c); });
  _calCalendars = ordered;
}
function saveCalOrder() { _calOrder = _calCalendars.map(c => c.id); localStorage.setItem('turndesk_cal_staff_order', JSON.stringify(_calOrder)); }
export function renderCalSelectorList() {
  const list = document.getElementById('cal-selector-list');
  if (!list || _calCalendars.length === 0) return;
  if (!_calSelectorDraft) _calSelectorDraft = { order: _calCalendars.map(c => c.id), hidden: calEffectiveHiddenSet() };
  const draftCals = _calSelectorDraft.order.map(id => _calCalendars.find(c => c.id === id)).filter(Boolean);
  list.innerHTML = draftCals.map((c,i) => { const isHidden = _calSelectorDraft.hidden.has(c.id); const offTag = (calAutoHideOn() && calColumnOff(c)) ? ` <span style="font-size:10px;color:#9ca3af;font-weight:600">· off today</span>` : ''; return `<div class="flex items-center gap-2 py-2 px-2 rounded-lg hover:bg-surface-container cursor-pointer select-none" data-cal-idx="${i}"><span onpointerdown="calReorderStart(event,${i})" class="material-symbols-outlined" style="font-size:14px;flex-shrink:0;color:#6b7280;cursor:grab;touch-action:none">drag_indicator</span><div style="width:12px;height:12px;border-radius:50%;background:${c.color};flex-shrink:0"></div><span class="flex-grow text-sm font-body text-on-surface" onclick="calDraftToggle('${c.id}')">${calDisplayName(c)}${offTag}</span><div onclick="calDraftToggle('${c.id}')" style="width:20px;height:20px;border-radius:5px;flex-shrink:0;cursor:pointer;display:flex;align-items:center;justify-content:center;border:2.5px solid ${isHidden?'#9ca3af':'#1a5252'};background:${isHidden?'#fff':'#1a5252'}">${!isHidden?'<span class="material-symbols-outlined" style="font-size:13px;color:#fff;font-variation-settings:\'FILL\' 1;line-height:1">check</span>':''}</div></div>`; }).join('');
  const visCount = draftCals.filter(c => !_calSelectorDraft.hidden.has(c.id)).length;
  const lbl = document.getElementById('cal-selector-label'); if (lbl) lbl.textContent = visCount === _calCalendars.length ? 'Calendars' : `${visCount}/${_calCalendars.length}`;
}
export function calDraftToggle(calId) { if (!_calSelectorDraft) return; if (_calSelectorDraft.hidden.has(calId)) _calSelectorDraft.hidden.delete(calId); else _calSelectorDraft.hidden.add(calId); renderCalSelectorList(); }
export function calSelectorSave() {
  if (!_calSelectorDraft) return;
  const ordered = []; _calSelectorDraft.order.forEach(id => { const c = _calCalendars.find(x => x.id === id); if (c) ordered.push(c); });
  _calCalendars.forEach(c => { if (!ordered.find(x => x.id === c.id)) ordered.push(c); });
  _calCalendars = ordered; saveCalOrder();
  // Decompose the draft's checked/unchecked state into the two hide mechanisms:
  //  • persistent manual hide (_calHidden) — only meaningful for on-duty calendars
  //  • per-day off-duty peek (_calOffPeek) — turning ON an off-duty calendar for today
  const newHidden = new Set(_calHidden), newPeek = new Set(_calOffPeek);
  _calCalendars.forEach(c => {
    const wantVisible = !_calSelectorDraft.hidden.has(c.id);
    const off = calAutoHideOn() && calColumnOff(c);
    if (off) {
      if (wantVisible) { newPeek.add(c.id); newHidden.delete(c.id); }
      else newPeek.delete(c.id);   // hidden by the off-duty default; leave any persistent hide intact
    } else {
      newPeek.delete(c.id);
      if (wantVisible) newHidden.delete(c.id); else newHidden.add(c.id);
    }
  });
  _calHidden = newHidden; _calOffPeek = newPeek;
  localStorage.setItem('turndesk_cal_staff_hidden', JSON.stringify([..._calHidden]));
  _calSelectorDraft = null;
  const dd = document.getElementById('cal-selector-dropdown'); if (dd) { dd.classList.add('hidden'); dd.style.display = ''; }
  renderCalSelectorList(); calRenderGridPreserveScroll();
}
export function calSelectorCancel() { _calSelectorDraft = null; const dd = document.getElementById('cal-selector-dropdown'); if (dd) { dd.classList.add('hidden'); dd.style.display = ''; } renderCalSelectorList(); }
export function calDraftSelectAll(show) { if (!_calSelectorDraft) return; if (show) _calSelectorDraft.hidden.clear(); else _calCalendars.forEach(c => _calSelectorDraft.hidden.add(c.id)); renderCalSelectorList(); }
// Pointer-based reorder (HTML5 drag-and-drop doesn't work on iOS touch).
function clearCalDropMarks() { document.querySelectorAll('#cal-selector-list [data-cal-idx]').forEach(r => r.classList.remove('drop-above')); }
let _calReorderList = null;
function calRowAt(y) { const rows = _calReorderList ? [..._calReorderList.querySelectorAll('[data-cal-idx]')] : []; return rows.find(r => { const rc = r.getBoundingClientRect(); return y >= rc.top && y <= rc.bottom; }) || null; }
export function calReorderStart(e, i) {
  e.preventDefault(); e.stopPropagation();
  _calDragIdx = i; _calReorderList = document.getElementById('cal-selector-list');
  document.addEventListener('pointermove', calReorderMove);
  document.addEventListener('pointerup', calReorderEnd, { once: true });
}
function calReorderMove(e) {
  e.preventDefault(); clearCalDropMarks();
  const row = calRowAt(e.clientY);
  if (row && Number(row.dataset.calIdx) !== _calDragIdx) row.classList.add('drop-above');
}
function calReorderEnd(e) {
  document.removeEventListener('pointermove', calReorderMove);
  clearCalDropMarks();
  const row = calRowAt(e.clientY);
  if (row && _calSelectorDraft && _calDragIdx !== null) {
    const target = Number(row.dataset.calIdx);
    if (!isNaN(target) && target !== _calDragIdx) {
      const moved = _calSelectorDraft.order.splice(_calDragIdx, 1)[0];
      _calSelectorDraft.order.splice(target, 0, moved);
      renderCalSelectorList();
    }
  }
  _calDragIdx = null; _calReorderList = null;
}

// ── Event click + quick check-in ─────────────────
export function calSlotClick(colId, hour, minute) { showNewApptModal(colId, hour, minute, _calCalendars.find(c => c.id === colId)?.name); }
export function calEventClick(e, apptId) {
  e.stopPropagation();
  const a = (getState().appointments || []).find(x => x.id === apptId);
  if (!a) return;
  const startDt = new Date(a.start);
  const g0 = (a.guests || [])[0] || {};
  const title = g0.name || 'Guest', phone = g0.phone || '', notes = a.notes || '';
  const confirmed = !!a.confirmed, noShow = !!a.noShow;
  const queueMatch = _queueForAppt(a.id) || _phoneQueueMatch((phone||'').replace(/\D/g,''), startDt.getTime());
  const svcSummaryHtml = (() => {
    const blocks = (a.guests || []).map(g => ({
      name: g.name || 'Guest',
      lines: (g.lines || []).map(l => {
        const svc = cfg().services.find(s => s.id === l.serviceId)?.label || '';
        if (!svc) return '';
        const tech = (cfg().staff || []).find(s => s.id === l.staffId)?.name || 'Unassigned';
        return `${svc} — ${tech}`;
      }).filter(Boolean),
    })).filter(b => b.lines.length);
    if (!blocks.length) return '';
    const multi = blocks.length > 1;
    return `<div class="mt-2 rounded-xl bg-surface-container px-3 py-2"><div class="text-[10px] font-body font-bold uppercase tracking-widest text-outline mb-1">Services &amp; Staff</div>${blocks.map(b => `${multi ? `<div class="text-xs font-body font-bold text-on-surface mt-1.5">${_escHtml(b.name)}</div>` : ''}${b.lines.map(l => `<div class="text-xs font-body text-on-surface mt-0.5">${_escHtml(l)}</div>`).join('')}`).join('')}</div>`;
  })();
  const modal = document.createElement('div');
  modal.className = 'fixed inset-0 z-[85] flex items-center justify-center bg-on-surface/40 px-4';
  modal.onclick = ev => { if (ev.target === modal) modal.remove(); };
  let statusBadge = '';
  if (['complete','paid','done'].includes(queueMatch?.status)) statusBadge = '<span style="color:#6b7280;font-size:11px;font-weight:700">✓ Completed</span>';
  else if (queueMatch?.status === 'inservice') statusBadge = '<span style="color:#16a34a;font-size:11px;font-weight:700">● In Service</span>';
  else if (queueMatch?.status === 'waiting') statusBadge = '<span style="color:#2563eb;font-size:11px;font-weight:700">● Checked In</span>';
  else if (startDt < new Date()) statusBadge = '<span style="color:#ea580c;font-size:11px;font-weight:700">⚠ Not Checked In</span>';
  if (noShow) statusBadge = '<span style="color:#dc2626;font-size:11px;font-weight:700">⊘ No Show</span>';
  const confirmBadge = confirmed ? '<span style="color:#16a34a;font-size:11px;font-weight:700">✓ Confirmed</span>' : '';
  const when = startDt.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}) + ' · ' + startDt.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
  modal.innerHTML = `<div class="bg-surface-container-lowest rounded-2xl p-6 w-full max-w-sm shadow-2xl">
    <div class="flex items-center justify-between mb-3"><h3 class="font-headline font-bold text-on-surface text-lg">${_escHtml(title)}</h3><button onclick="this.closest('.fixed').remove()" class="w-8 h-8 rounded-full hover:bg-surface-container flex items-center justify-center"><span class="material-symbols-outlined text-on-surface-variant" style="font-size:18px">close</span></button></div>
    <div class="space-y-1 text-sm font-body text-on-surface-variant mb-4"><p><span class="font-semibold text-on-surface">${_escHtml(when)}</span></p>${phone?`<p>📞 ${_escHtml(phone)}</p>`:''}${notes?`<p class="text-xs opacity-75">${notes.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>')}</p>`:''}${svcSummaryHtml}${(statusBadge||confirmBadge)?`<div class="mt-1 flex items-center gap-2 flex-wrap">${statusBadge}${confirmBadge}</div>`:''}</div>
    <div class="space-y-2">
      <button onclick="calQuickCheckin('${_escAttrJs(apptId)}'); this.closest('.fixed').remove()" class="w-full bg-primary text-on-primary py-2.5 rounded-xl font-headline font-bold text-sm hover:bg-primary-dim transition-colors flex items-center justify-center gap-2"><span class="material-symbols-outlined" style="font-size:16px">how_to_reg</span> Quick Check-In</button>
      ${queueMatch?`<button onclick="this.closest('.fixed').remove(); showGroupAssignModal('${queueMatch.id}')" class="w-full bg-primary text-on-primary py-2.5 rounded-xl font-headline font-bold text-sm hover:bg-primary-dim transition-colors flex items-center justify-center gap-2"><span class="material-symbols-outlined" style="font-size:16px">assignment_ind</span> Assign & Price</button>`:''}
      <button onclick="calToggleConfirmed('${_escAttrJs(apptId)}'); this.closest('.fixed').remove()" class="w-full ${confirmed?'bg-secondary-container text-on-secondary-container':'border-2 border-primary text-primary hover:bg-primary/10'} py-2.5 rounded-xl font-headline font-bold text-sm transition-colors flex items-center justify-center gap-2"><span class="material-symbols-outlined" style="font-size:16px">${confirmed?'event_available':'check_circle'}</span> ${confirmed?'Confirmed — tap to undo':'Mark Confirmed'}</button>
      <button onclick="calMarkNoShow('${_escAttrJs(apptId)}'); this.closest('.fixed').remove()" class="w-full ${noShow?'bg-error/15 text-error':'border-2 border-outline-variant text-on-surface hover:bg-surface-container'} py-2.5 rounded-xl font-headline font-semibold text-sm transition-colors flex items-center justify-center gap-2"><span class="material-symbols-outlined" style="font-size:16px">person_off</span> ${noShow?'No Show — tap to undo':'Mark No Show'}</button>
      <button onclick="this.closest('.fixed').remove(); showEditApptModal('${_escAttrJs(apptId)}')" class="w-full border-2 border-outline-variant text-on-surface py-2.5 rounded-xl font-headline font-semibold text-sm hover:bg-surface-container transition-colors">Edit Appointment</button>
      <button onclick="if(confirm('Cancel this appointment?')) { deleteAppt('${_escAttrJs(apptId)}'); this.closest('.fixed').remove(); }" class="w-full text-error py-2 rounded-xl font-headline font-semibold text-sm hover:bg-error/10 transition-colors">Cancel / Delete</button>
    </div></div>`;
  document.body.appendChild(modal);
}

// Toggle the "confirmed" flag on an appointment (stored in extendedProperties so it
// syncs through Google Calendar; shown as a ✓ on the bubble + popup).
// Match a live-queue visit to an appointment by phone, but ONLY when the visit's
// check-in time is near the appointment time. Without the window, a customer's earlier
// same-day visit (e.g. a paid morning walk-in) would wrongly stamp its status onto a
// different appointment they booked for later the same day. The explicit calEventId link
// (set when checking in *from* the appointment) is matched separately and always wins.
function _phoneQueueMatch(rawPhone, apptStartMs) {
  if (!rawPhone || !isFinite(apptStartMs)) return null;
  const before = 2 * 3600 * 1000, after = 4 * 3600 * 1000;   // up to 2h early … 4h late/mid-service
  return queue().find(x => {
    if ((x.phone || '').replace(/\D/g, '') !== rawPhone) return false;
    // A completed/paid earlier visit (e.g. a morning walk-in on a shared household phone)
    // cannot be THIS later appointment — exclude finished entries so it can't stamp its
    // status onto the appt or wrongly drop it from Turns. The explicit calEventId link is
    // checked first at every call site and always wins, so a real check-in is unaffected.
    if (['complete', 'paid', 'done'].includes(x.status)) return false;
    const t = x.checkinTime ? new Date(x.checkinTime).getTime() : NaN;
    return isFinite(t) && t >= apptStartMs - before && t <= apptStartMs + after;
  }) || null;
}

// Did a PAST-day appointment actually result in a visit? The live queue only holds
// today, so for previous days we look in the records (transaction history): a paid
// record linked to one of the booking's calendar event ids (strong), else matched by
// phone within a window around the appointment time. Returns the record or null.
// A null with a phone present = no-show; a null with NO phone = unknowable (caller
// leaves it neutral rather than falsely flagging a served name-only booking).
function _pastRecordMatch(eventIds, rawPhone, apptStartMs) {
  const recs = records();
  const linked = recs.find(r => r.appointmentId && eventIds.has(String(r.appointmentId)));
  if (linked) return linked;
  if (!rawPhone || !isFinite(apptStartMs)) return null;
  const before = 2 * 3600 * 1000, after = 6 * 3600 * 1000;   // up to 2h early … 6h late
  return recs.find(r => {
    if ((r.phone || '').replace(/\D/g, '') !== rawPhone) return false;
    const t = r.checkinTime ? new Date(r.checkinTime).getTime()
            : r.completedAt ? new Date(r.completedAt).getTime() : NaN;
    return isFinite(t) && t >= apptStartMs - before && t <= apptStartMs + after;
  }) || null;
}

// ── Booking ↔ queue matching across calendar copies ──────────────────────────
// A check-in stores ONE copy's id as the queue entry's calEventId — whichever copy it
// went through — but a booking has a copy per calendar (each tech + Unassigned). Any
// queue lookup must therefore match against a SET of ids, or sibling copies read as
// "not checked in" after check-in/payment (the Melissa-Smith bug: Paid on the tech's
// column, orange on Unassigned). Booking-wide set = the status badge; person-scoped
// set = the per-guest "already checked in" guards (a party member must not be blocked
// by ANOTHER member's entry). Pure on (ev, eventsMap) — exported for unit tests.
export function _bookingEventIds(ev, eventsMap = _calEvents) {
  const ids = new Set([String(ev.id)]);
  const gid = ev.extendedProperties?.private?.museGroupId || '';
  if (gid) Object.values(eventsMap).forEach(list => (list || []).forEach(e => {
    if ((e.extendedProperties?.private?.museGroupId || '') === gid) ids.add(String(e.id));
  }));
  return ids;
}
const _evPersonName = e => (e.extendedProperties?.private?.museName || (e.summary || '').split(' — ')[0] || '').trim().toLowerCase();
export function _personEventIds(ev, eventsMap = _calEvents) {
  const ids = new Set([String(ev.id)]);
  const gid = ev.extendedProperties?.private?.museGroupId || '';
  if (!gid) return ids;
  const pname = _evPersonName(ev);
  Object.values(eventsMap).forEach(list => (list || []).forEach(e => {
    if ((e.extendedProperties?.private?.museGroupId || '') === gid && _evPersonName(e) === pname) ids.add(String(e.id));
  }));
  return ids;
}
export function _queueEntryForEventIds(queueArr, ids) {
  return (queueArr || []).find(x => x.calEventId && ids.has(String(x.calEventId))) || null;
}
const _queueByEventIds = ids => _queueEntryForEventIds(queue(), ids);

// Every calendar copy of a booking. A multi-staff/party appointment is stored as one
// Google event per staff column, all sharing museGroupId — so confirm / no-show must
// hit ALL copies, else only the clicked staff column reflects the change. Solo event
// (no groupId) → just itself.
function _eventGroupRefs(calId, eventId) {
  const ev = (_calEvents[calId] || []).find(x => x.id === eventId);
  if (!ev) return [];
  const gid = ev.extendedProperties?.private?.museGroupId || '';
  if (!gid) return [{ calId, eventId }];
  const refs = [];
  Object.entries(_calEvents).forEach(([cid, list]) => (list || []).forEach(e => {
    if ((e.extendedProperties?.private?.museGroupId || '') === gid) refs.push({ calId: cid, eventId: e.id });
  }));
  return refs.length ? refs : [{ calId, eventId }];
}
export async function calToggleConfirmed(apptId) {
  const a = (getState().appointments || []).find(x => x.id === apptId); if (!a) return;
  const appt = { ...a, confirmed: !a.confirmed };
  dispatch('appt.upsert', { appt });
  showToast(a.confirmed ? 'Marked unconfirmed' : 'Appointment confirmed ✓');
  if (document.getElementById('panel-calendar')?.classList.contains('active')) calLoadAndRender(true);
}

// Mark an appointment "No Show" (museNoShow flag in extendedProperties, synced via
// Google Calendar — shown as a red badge on the bubble + today's panel, and hidden by
// the upcoming-only filter). On marking, open the matched customer's account so the
// front desk can notate it (match by phone to the Square directory).
export async function calMarkNoShow(apptId) {
  const a = (getState().appointments || []).find(x => x.id === apptId); if (!a) return;
  const wasNoShow = !!a.noShow;
  dispatch('appt.upsert', { appt: { ...a, noShow: !wasNoShow } });
  showToast(wasNoShow ? 'No-show cleared' : 'Marked No Show');
  if (document.getElementById('panel-calendar')?.classList.contains('active')) calLoadAndRender(true);
  if (wasNoShow) return;
  // Open the matched customer's account to notate the no-show (phone match, last 10 digits).
  const raw = ((a.guests||[])[0]?.phone || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
  const cust = raw ? customerDirectory.find(c => (c.phone || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1') === raw) : null;
  if (cust) showEditCustomer(cust.squareId);
}

// ── (removed) Auto no-show ──────────────────────────────────────────────────────
// We used to auto-PATCH museNoShow='1' onto any appointment 60+ min past its start
// that wasn't matched to the live queue. That permanently mis-flagged served-but-
// unlinked customers (kiosk / walk-in / name-only check-ins never set calEventId) as
// No Show — filling past days with false no-shows. The "drop very-late appts off the
// Turns strip" intent now lives in apptsForTurns() (STALE_APPT_DROP_MIN), computed
// live and never written. No-shows are now ONLY set by the manual button (calMarkNoShow).

// ── One-time cleanup: clear past No-Show flags ──────────────────────────────────
// Operator-triggered (Settings → Data Recovery). Clears the museNoShow flag from every
// appointment between `sinceDateStr` (YYYY-MM-DD) and the START OF TODAY — past days
// only, so today's real no-shows are untouched. Auto- and manually-set flags are
// identical (no marker), so this also clears any genuine past no-shows; that's
// operationally harmless (history) and was confirmed by the owner.
export async function clearPastNoShowFlags(sinceDateStr) {
  if ((!localStorage.getItem('turndesk_turndesk_gcal_token') && !cfg().turndesk_turndesk_gcal_token) || typeof gapi === 'undefined' || !gapi.client?.calendar) { showToast('Connect Google Calendar on this device first'); return; }
  const since = new Date((sinceDateStr || '') + 'T00:00:00');
  if (isNaN(since)) { showToast('Pick a valid start date'); return; }
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  if (since >= todayStart) { showToast('Start date must be before today'); return; }
  showToast('Scanning calendar…');
  try { await ensureFreshToken(); } catch { showToast('Calendar auth failed — reconnect and retry'); return; }
  const hits = [];   // { calId, eventId }
  for (const cal of _calCalendars) {
    let pageToken;
    do {
      let r;
      try { r = await gapi.client.calendar.events.list({ calendarId: cal.id, timeMin: since.toISOString(), timeMax: todayStart.toISOString(), singleEvents: true, maxResults: 250, pageToken }); }
      catch { break; }
      (r.result.items || []).forEach(ev => { if ((ev.extendedProperties?.private || {}).museNoShow === '1') hits.push({ calId: cal.id, eventId: ev.id }); });
      pageToken = r.result.nextPageToken;
    } while (pageToken);
  }
  if (!hits.length) { showToast('No past no-show flags found in that range'); return; }
  window.showWarnModal?.('Clear past No-Show flags?',
    `${hits.length} past appointment${hits.length > 1 ? 's' : ''} flagged No Show between ${since.toLocaleDateString()} and today will be cleared. This also clears any you marked by hand in that range (history only — today is untouched). Proceed?`,
    async () => {
      let cleared = 0;
      for (const h of hits) {
        try { const p = await gapi.client.calendar.events.patch({ calendarId: h.calId, eventId: h.eventId, resource: { extendedProperties: { private: { museNoShow: null } } } }); _gcalNoteWritten(h.calId, p.result); cleared++; }
        catch { /* skip one, keep going */ }
      }
      await calLoadAndRender(true);
      showToast(`Cleared ${cleared} past no-show flag${cleared !== 1 ? 's' : ''} ✓`);
    },
    'Clear flags');
}

// One queue entry for one appointment guest (null if that guest is already checked in).
function _buildCheckinEntry(appt, guest, queueGroupId) {
  const title = guest.name || 'Guest';
  const already = queue().find(x => x.isAppointment && x.name === title && x.status !== 'paid' && x.status !== 'done' && String(x.appointmentId) === String(appt.id))
    || queue().find(x => x.isAppointment && x.name === title && x.status !== 'paid' && x.status !== 'done');
  if (already) return null;
  const rawP = (guest.phone || '').replace(/\D/g,'');
  const phone = rawP ? rawP.replace(/^1?(\d{3})(\d{3})(\d{4})$/,'($1) $2-$3') : '';
  const lines = (guest.lines || []).filter(l => l.serviceId);
  const svcs = lines.map(l => l.serviceId);
  const now = Date.now();
  const assignments = lines.map(l => ({ serviceId: l.serviceId, techId: l.staffId || '', station: '', status: 'waiting', cost: 0, assignedAt: now }));
  return { id: newEntryId(), name: title, phone, services: svcs.length ? svcs : (cfg().services.length ? [cfg().services[0].id] : []), status: 'waiting', checkinTime: new Date().toISOString(), isAppointment: true, isNew: true, skipSquare: false, groupId: queueGroupId, appointmentId: appt.id, assignments };
}
// The appt's guests, each tagged `already` if that person is already in today's queue.
function _gatherParty(apptId) {
  const a = (getState().appointments || []).find(x => x.id === apptId);
  if (!a) return [];
  return (a.guests || []).map(g => ({ appt: a, guest: g, name: g.name || 'Guest',
    already: !!queue().find(x => x.isAppointment && x.name === (g.name||'Guest') && x.status !== 'paid' && x.status !== 'done') }));
}
function _doCalCheckin(members, appt, partySize) {
  if (!members.length) { showToast('Already checked in'); return; }
  const queueGroupId = (partySize > 1 && appt) ? ('apptq_' + appt.id) : null;
  let added = 0, firstName = '';
  members.forEach(({ guest }) => {
    const entry = _buildCheckinEntry(appt, guest, queueGroupId);
    if (!entry) return;
    dispatch('queue.upsert', { entry }); squareUpsertCustomer(entry);
    added++; if (!firstName) firstName = entry.name;
  });
  if (added === 0) { showToast('Already checked in'); return; }
  const onTurns = document.getElementById('panel-turns')?.classList.contains('active');
  window.renderQueue?.(); window.updateStats?.(); window.renderTurns?.();
  if (!onTurns) window.showDashPanel?.('queue');
  showToast(added > 1 ? `${added} guests added to queue from calendar ✓` : `${firstName} added to queue from calendar ✓`);
}
export function calQuickCheckin(apptId) {
  const party = _gatherParty(apptId);
  if (party.length === 0) return;
  const appt = party[0].appt;
  if (party.length === 1) { _doCalCheckin(party.filter(p => !p.already), appt, 1); return; }
  _showQuickCheckinPicker(party, appt);
}
let _quickParty = null, _quickAppt = null;
function _showQuickCheckinPicker(party, appt) {
  _quickParty = party; _quickAppt = appt;
  const esc = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const rows = party.map((p,i) => {
    const svcs = (p.guest.lines||[]).map(l => cfg().services.find(s=>s.id===l.serviceId)?.label).filter(Boolean).join(', ');
    return `<label class="flex items-start gap-3 px-3 py-2.5 rounded-xl border ${p.already?'border-surface-container-high opacity-60':'border-primary/40 cursor-pointer hover:bg-primary/5'}">
      <input type="checkbox" data-q-idx="${i}" ${p.already?'checked disabled':'checked'} style="width:18px;height:18px;margin-top:2px;accent-color:#1a5252;flex-shrink:0">
      <div class="min-w-0"><div class="font-body font-semibold text-sm text-on-surface">${esc(p.name)}${p.already?' <span class="text-[10px] font-semibold text-on-surface-variant">· checked in</span>':''}</div>
        ${svcs?`<div class="text-xs text-on-surface-variant truncate">${esc(svcs)}</div>`:''}</div>
    </label>`;
  }).join('');
  const modal = document.createElement('div');
  modal.id = 'quick-checkin-modal';
  modal.className = 'fixed inset-0 z-[88] flex items-center justify-center bg-on-surface/40 px-4';
  modal.onclick = e => { if (e.target === modal) closeQuickCheckin(); };   // tap outside closes
  modal.innerHTML = `<div class="bg-surface-container-lowest rounded-2xl p-5 w-full max-w-sm shadow-2xl">
    <div class="flex items-center justify-between mb-1"><h3 class="font-headline font-bold text-on-surface text-lg">Check in who?</h3><button onclick="closeQuickCheckin()" class="w-8 h-8 rounded-full hover:bg-surface-container flex items-center justify-center"><span class="material-symbols-outlined text-on-surface-variant" style="font-size:18px">close</span></button></div>
    <p class="text-xs font-body text-on-surface-variant mb-3">Select the guests arriving now. The rest can be checked in later.</p>
    <div class="space-y-2 mb-4 max-h-72 overflow-y-auto no-scroll">${rows}</div>
    <div class="flex gap-2">
      <button onclick="closeQuickCheckin()" class="flex-1 py-2.5 rounded-xl border border-surface-container-high text-on-surface-variant font-headline font-semibold text-sm hover:bg-surface-container transition-colors">Cancel</button>
      <button onclick="confirmQuickCheckin()" class="flex-1 py-2.5 rounded-xl bg-primary text-on-primary font-headline font-bold text-sm hover:bg-primary-dim transition-colors">Check In Selected</button>
    </div></div>`;
  document.body.appendChild(modal);
}
export function closeQuickCheckin() { document.getElementById('quick-checkin-modal')?.remove(); _quickParty = null; }
export function confirmQuickCheckin() {
  if (!_quickParty) return;
  const sel = [], appt = _quickAppt, partySize = _quickParty.length;
  document.querySelectorAll('#quick-checkin-modal input[data-q-idx]').forEach(cb => { if (cb.checked && !cb.disabled) { const p = _quickParty[+cb.dataset.qIdx]; if (p) sel.push(p); } });
  if (!sel.length) { showToast('Select at least one guest'); return; }
  closeQuickCheckin();
  _doCalCheckin(sel, appt, partySize);
}

// ── Check-in guard: catch a manual check-in for someone who already has an appointment today ─
// Matched by phone (digits) or exact full name against today's not-yet-checked-in, not-no-show
// appointments. Returns null when the calendar isn't loaded on this device (guard degrades silently).
export function findTodayApptFor(phone, name) {
  const p = String(phone || '').replace(/\D/g, '');
  const nm = String(name || '').trim().toLowerCase();
  if (!p && !nm) return null;
  const dstr = localDateStr(new Date());
  let hit = null;
  (getState().appointments || []).forEach(a => {
    if (hit || !a || !a.start || a.noShow) return;
    const start = new Date(a.start);
    if (isNaN(start) || localDateStr(start) !== dstr) return;
    const match = (a.guests || []).some(g => {
      const gPhone = String(g.phone || '').replace(/\D/g, '');
      const gName = (g.name || '').trim().toLowerCase();
      return (p && gPhone && gPhone === p) || (nm && gName && gName === nm);
    });
    if (!match) return;
    if (_queueForAppt(a.id)) return;   // already checked in
    const lines = (a.guests || []).flatMap(g => g.lines || []).map(l => {
      const svc = cfg().services.find(s => s.id === l.serviceId)?.label || '';
      if (!svc) return '';
      const tech = (cfg().staff || []).find(s => s.id === l.staffId)?.name || '';
      return svc + (tech ? ` with ${tech}` : '');
    }).filter(Boolean);
    const g0 = (a.guests || [])[0] || {};
    hit = { apptId: a.id, name: g0.name || name, startMs: start.getTime(), summary: lines.join(', ') };
  });
  return hit;
}
// Called by the kiosk submitCheckin + desk submitManualAdd before they create entries.
// Returns true when a matching appointment was found (the prompt is up; the caller must bail).
// proceed() re-runs the caller's check-in with the guard bypassed.
let _guardMatch = null, _guardProceed = null;
export function checkinApptGuard(guests, proceed) {
  for (const g of guests || []) {
    const m = findTodayApptFor(g.phone, g.name);
    if (m) { _guardMatch = m; _guardProceed = proceed; _showApptGuardModal(m); return true; }
  }
  return false;
}
function _showApptGuardModal(m) {
  document.getElementById('appt-guard-modal')?.remove();   // replace any prior prompt WITHOUT clearing the just-set guard state
  const when = new Date(m.startMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const modal = document.createElement('div');
  modal.id = 'appt-guard-modal';
  modal.className = 'fixed inset-0 z-[95] flex items-center justify-center bg-on-surface/40 px-4';
  modal.onclick = e => { if (e.target === modal) closeApptGuardModal(); };   // tap outside = Cancel
  modal.innerHTML = `<div class="bg-surface-container-lowest rounded-2xl p-6 w-full max-w-sm shadow-2xl">
    <div class="flex items-center gap-2 mb-2"><span class="material-symbols-outlined text-primary" style="font-size:22px">event_available</span><h3 class="font-headline font-bold text-on-surface text-lg">Already booked today</h3></div>
    <p class="text-sm font-body text-on-surface-variant mb-4"><span class="font-semibold text-on-surface">${_escHtml(m.name)}</span> has an appointment today at <span class="font-semibold text-on-surface">${when}</span>${m.summary ? ` — ${_escHtml(m.summary)}` : ''}.</p>
    <div class="space-y-2">
      <button onclick="apptGuardUseAppt()" class="w-full bg-primary text-on-primary py-2.5 rounded-xl font-headline font-bold text-sm hover:bg-primary-dim transition-colors flex items-center justify-center gap-2"><span class="material-symbols-outlined" style="font-size:16px">how_to_reg</span> Check In from the Appointment</button>
      <button onclick="apptGuardProceed()" class="w-full border-2 border-outline-variant text-on-surface py-2.5 rounded-xl font-headline font-semibold text-sm hover:bg-surface-container transition-colors">Check In Separately — keep the appointment for later</button>
      <button onclick="closeApptGuardModal()" class="w-full text-on-surface-variant py-2 rounded-xl font-headline font-semibold text-sm hover:bg-surface-container transition-colors">Cancel</button>
    </div></div>`;
  document.body.appendChild(modal);
}
export function closeApptGuardModal() { document.getElementById('appt-guard-modal')?.remove(); _guardMatch = null; _guardProceed = null; }
export function apptGuardUseAppt() {
  const m = _guardMatch; closeApptGuardModal();
  if (!m) return;
  window.closeManualAdd?.();                       // harmless no-op when the desk modal isn't open
  calQuickCheckin(m.apptId);
  // Kiosk flow: keep the customer-facing screens — show the confirm screen, then bounce
  // back to welcome (mirrors submitCheckin). On the desk screen _doCalCheckin already
  // switched to the Queue panel, so leave it alone.
  if (!document.getElementById('screen-desk')?.classList.contains('active')) {
    const cn = document.getElementById('confirm-name'); if (cn) cn.textContent = m.name;
    window.goTo?.('screen-confirm');
    clearTimeout(window._confirmResetTimer);
    window._confirmResetTimer = setTimeout(() => { if (document.getElementById('screen-confirm')?.classList.contains('active')) window.goTo?.('screen-welcome'); }, 5000);
  }
}
export function apptGuardProceed() { const fn = _guardProceed; closeApptGuardModal(); if (fn) fn(); }

// ── Appointment modal ─────────────────────────────
export function apptAcSearch(input, field) {
  if (field === 'phone') formatPhone(input);
  const val = input.value.trim().toLowerCase();
  const acBox = document.getElementById(field === 'phone' ? 'appt-ac-phone' : 'appt-ac-first');
  if (!acBox) return;
  if (!val || val.length < 2) { acBox.classList.add('hidden'); acBox.innerHTML = ''; return; }
  const matches = squareCustomers.filter(c => { const full = ((c.given_name||'')+' '+(c.family_name||'')).toLowerCase(); const phone = (c.phone_number||c.phone||'').replace(/\D/g,''); if (field === 'phone') return phone.includes(val.replace(/\D/g,'')) && val.replace(/\D/g,'').length >= 3; return full.startsWith(val) || (c.given_name||'').toLowerCase().startsWith(val); }).slice(0, 8);
  if (!matches.length) { acBox.classList.add('hidden'); return; }
  acBox.innerHTML = matches.map(c => { const name = [c.given_name,c.family_name].filter(Boolean).join(' '), phone = c.phone_number||c.phone||''; return `<div class="autocomplete-item" onmousedown="apptAcFill('${_escAttrJs(name)}','${_escAttrJs(phone)}')"><span class="ac-name">${_escHtml(name)}</span>${phone?`<span class="ac-phone">${_escHtml(phone)}</span>`:''}</div>`; }).join('');
  acBox.classList.remove('hidden');
}
export function apptAcFill(name, phone) {
  const parts = name.trim().split(' ');
  document.getElementById('appt-first').value = parts[0] || '';
  document.getElementById('appt-last').value = parts.slice(1).join(' ') || '';
  document.getElementById('appt-phone').value = phone;
  document.getElementById('appt-name').value = name;
  const p = document.getElementById('appt-phone'); if (p) formatPhone(p);
  ['appt-ac-phone','appt-ac-first'].forEach(id => { const el = document.getElementById(id); if (el) { el.classList.add('hidden'); el.innerHTML = ''; } });
}
// Each guest carries their OWN service lines so multi-customer bookings can assign
// a specific service+tech per person (not one shared list for the whole booking).
export function apptAddGuest() { _syncApptGuestsFromDom(); _apptExtraGuests.push({ first:'', last:'', phone:'', lines:[{ svcId:'', staffId:'' }] }); renderApptExtraGuests(); }
export function apptRemoveGuest(idx) { _syncApptGuestsFromDom(); _apptExtraGuests.splice(idx,1); renderApptExtraGuests(); }
export function apptGuestAddLine(gi) { _syncApptGuestsFromDom(); if (!_apptExtraGuests[gi]) return; (_apptExtraGuests[gi].lines = _apptExtraGuests[gi].lines || []).push({ svcId:'', staffId:'' }); renderApptExtraGuests(); }
export function apptGuestRemoveLine(gi, li) { _syncApptGuestsFromDom(); _apptExtraGuests[gi]?.lines?.splice(li,1); renderApptExtraGuests(); }
export function apptGuestUpdateLine(gi, li, field, val) { const l = _apptExtraGuests[gi]?.lines?.[li]; if (!l) return; if (field === 'svc') l.svcId = val; else l.staffId = val; }
// Name/phone live in the DOM; pull them into the model before any re-render so
// typing guest 1 then adding guest 2 doesn't wipe guest 1 (service lines stay in
// the model already, kept current by the onchange handlers above).
function _syncApptGuestsFromDom() {
  _apptExtraGuests.forEach((g,idx) => {
    const f = document.getElementById(`appt-extra-first-${idx}`); if (f) g.first = f.value.trim();
    const l = document.getElementById(`appt-extra-last-${idx}`);  if (l) g.last  = l.value.trim();
    const p = document.getElementById(`appt-extra-phone-${idx}`); if (p) g.phone = p.value.trim();
  });
}
function _guestLinesHtml(gi) {
  const rows = (_apptExtraGuests[gi].lines || []).map((line,li) => `<div class="flex items-center gap-2">
    <select onchange="apptGuestUpdateLine(${gi},${li},'svc',this.value)" class="flex-1 border border-surface-container-high bg-transparent rounded-lg px-2 py-1.5 text-xs font-body focus:border-primary outline-none">${_buildSvcOptions(line.svcId)}</select>
    <select onchange="apptGuestUpdateLine(${gi},${li},'staff',this.value)" class="flex-1 border border-surface-container-high bg-transparent rounded-lg px-2 py-1.5 text-xs font-body focus:border-primary outline-none">${_buildTechOptions(line.staffId)}</select>
    <button type="button" onclick="apptGuestRemoveLine(${gi},${li})" class="w-7 h-7 rounded-lg text-outline hover:text-error flex items-center justify-center flex-shrink-0"><span class="material-symbols-outlined" style="font-size:15px">remove</span></button>
  </div>`).join('');
  return `<div class="mt-2"><div class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest mb-1">Services &amp; Technicians</div>
    <div class="space-y-1.5">${rows}</div>
    <button type="button" onclick="apptGuestAddLine(${gi})" class="flex items-center gap-1 text-[11px] font-body font-semibold text-primary hover:text-primary-dim mt-1.5"><span class="material-symbols-outlined" style="font-size:13px">add</span> Add service</button></div>`;
}
function renderApptExtraGuests() {
  const container = document.getElementById('appt-extra-guests'); if (!container) return;
  container.innerHTML = _apptExtraGuests.map((g,idx) => `<div class="border border-surface-container-high rounded-xl p-3 mb-2 bg-surface-container-low" data-appt-guest="${idx}"><div class="flex items-center justify-between mb-2"><span class="text-[11px] font-body font-semibold text-primary uppercase tracking-widest">Guest ${idx+2}</span><button type="button" onclick="apptRemoveGuest(${idx})" class="text-outline-variant hover:text-error transition-colors"><span class="material-symbols-outlined" style="font-size:16px">close</span></button></div><div class="ac-input-wrap mb-2"><input type="tel" placeholder="Phone (optional)" autocomplete="off" value="${(g.phone||'').replace(/"/g,'&quot;')}" id="appt-extra-phone-${idx}" oninput="apptExtraAcSearch(this,${idx},'phone')" class="w-full bg-transparent border-b border-surface-container-high py-1.5 text-sm font-headline focus:border-primary transition-colors outline-none placeholder:text-outline-variant"><div id="appt-extra-ac-phone-${idx}" class="autocomplete-list hidden"></div></div><div class="grid grid-cols-2 gap-2"><div class="ac-input-wrap"><input type="text" placeholder="First Name *" autocomplete="off" value="${(g.first||'').replace(/"/g,'&quot;')}" id="appt-extra-first-${idx}" oninput="apptExtraAcSearch(this,${idx},'first'); autoCapitalize(this)" class="w-full bg-transparent border-b border-surface-container-high py-1.5 text-sm font-headline focus:border-primary transition-colors outline-none placeholder:text-outline-variant"><div id="appt-extra-ac-first-${idx}" class="autocomplete-list hidden"></div></div><input type="text" placeholder="Last Name" value="${(g.last||'').replace(/"/g,'&quot;')}" id="appt-extra-last-${idx}" oninput="autoCapitalize(this)" class="w-full bg-transparent border-b border-surface-container-high py-1.5 text-sm font-headline focus:border-primary transition-colors outline-none placeholder:text-outline-variant"></div>${_guestLinesHtml(idx)}</div>`).join('');
}
export function apptExtraAcSearch(input, idx, field) {
  if (field === 'phone') formatPhone(input);
  const val = input.value.trim().toLowerCase();
  const acBox = document.getElementById(field === 'phone' ? `appt-extra-ac-phone-${idx}` : `appt-extra-ac-first-${idx}`);
  if (!acBox) return;
  if (!val || val.length < 2) { acBox.classList.add('hidden'); acBox.innerHTML = ''; return; }
  const matches = squareCustomers.filter(c => { const full = ((c.given_name||'')+' '+(c.family_name||'')).toLowerCase(); const phone = (c.phone_number||c.phone||'').replace(/\D/g,''); if (field === 'phone') return phone.includes(val.replace(/\D/g,'')) && val.replace(/\D/g,'').length >= 3; return full.startsWith(val) || (c.given_name||'').toLowerCase().startsWith(val); }).slice(0, 6);
  if (!matches.length) { acBox.classList.add('hidden'); return; }
  acBox.innerHTML = matches.map(c => { const name = [c.given_name,c.family_name].filter(Boolean).join(' '), phone = c.phone_number||c.phone||''; return `<div class="autocomplete-item" onmousedown="apptExtraAcFill(${idx},'${_escAttrJs(name)}','${_escAttrJs(phone)}')"><span class="ac-name">${_escHtml(name)}</span>${phone?`<span class="ac-phone">${_escHtml(phone)}</span>`:''}</div>`; }).join('');
  acBox.classList.remove('hidden');
}
export function apptExtraAcFill(idx, name, phone) {
  const parts = name.trim().split(' ');
  const f = document.getElementById(`appt-extra-first-${idx}`), l = document.getElementById(`appt-extra-last-${idx}`), p = document.getElementById(`appt-extra-phone-${idx}`);
  if (f) f.value = parts[0] || ''; if (l) l.value = parts.slice(1).join(' ') || ''; if (p) { p.value = phone; formatPhone(p); }
  [`appt-extra-ac-phone-${idx}`,`appt-extra-ac-first-${idx}`].forEach(id => { const el = document.getElementById(id); if (el) { el.classList.add('hidden'); el.innerHTML = ''; } });
}
function _buildTechOptions(sel) {
  const isU = !sel;   // '' / null → Unassigned (the default)
  return `<option value="" ${isU ? 'selected' : ''}>Unassigned</option>`
    + buildStaffColumns().filter(c => c.id !== '').map(c => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${c.name}</option>`).join('');
}
function _buildSvcOptions(sel) { return '<option value="">— Service —</option>' + cfg().services.filter(s => !cfg().hidden_dash_services.includes(s.id)).map(s => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${s.label}</option>`).join(''); }

// ── Appointment metadata (structured in extendedProperties; description = notes) ─
// New events store service lines + phone in extendedProperties.private so the
// description is purely the user's notes. Old events fall back to parsing the
// legacy "Service (Tech)\nphone\nnotes" description.
function _apptPhone(ev) {
  const ext = ev?.extendedProperties?.private || {};
  if (ext.musePhone) return ext.musePhone;
  const m = (ev?.description || '').match(/(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/);
  return m ? m[1] : '';
}
function _apptNotes(ev) {
  const ext = ev?.extendedProperties?.private || {};
  if (ext.museLines !== undefined) return ev?.description || '';   // new format: description IS the notes
  return (ev?.description || '').replace(/\([^)]*\)\s*/g, '').replace(/\d{3}[\s.-]?\d{3}[\s.-]?\d{4}/g, '').trim();
}
function _parseApptLines(ev, calId) {
  const ext = ev?.extendedProperties?.private || {};
  if (ext.museLines !== undefined) { try { return JSON.parse(ext.museLines) || []; } catch { return []; } }
  const lines = [], desc = ev?.description || '', re = /(.+?)\s*\(([^)]+)\)/g; let m;
  while ((m = re.exec(desc)) !== null) {
    const svcLabel = m[1].trim(), techName = m[2].trim();
    const s = cfg().services.find(x => x.label.toLowerCase() === svcLabel.toLowerCase());
    const cal = _calCalendars.find(x => x.name.toLowerCase() === techName.toLowerCase()) || _calCalendars.find(x => x.id === calId);
    if (s || cal) lines.push({ svcId: s?.id || '', calId: cal?.id || calId });
  }
  return lines;
}
export function renderApptServiceLines() {
  const container = document.getElementById('appt-service-lines'); if (!container) return;
  container.innerHTML = _apptLines.map((line,i) => `<div class="flex items-center gap-2" data-line="${i}"><select onchange="updateApptLine(${i},'svc',this.value)" class="flex-1 border-2 border-surface-container-high bg-transparent rounded-xl px-3 py-2 text-sm font-body focus:border-primary outline-none">${_buildSvcOptions(line.svcId)}</select><select onchange="updateApptLine(${i},'staff',this.value)" class="flex-1 border-2 border-surface-container-high bg-transparent rounded-xl px-3 py-2 text-sm font-body focus:border-primary outline-none">${_buildTechOptions(line.staffId)}</select><button type="button" onclick="removeApptLine(${i})" class="w-8 h-8 rounded-xl text-outline hover:text-error hover:bg-error/10 flex items-center justify-center transition-colors flex-shrink-0"><span class="material-symbols-outlined" style="font-size:18px">remove</span></button></div>`).join('');
}
export function addApptServiceLine(svcId, staffId) { _apptLines.push({ svcId: svcId || '', staffId: staffId || '' }); renderApptServiceLines(); }
export function removeApptLine(i) { _apptLines.splice(i,1); if (_apptLines.length === 0) addApptServiceLine(); else renderApptServiceLines(); }
export function updateApptLine(i, field, val) { if (field === 'svc') _apptLines[i].svcId = val; else _apptLines[i].staffId = val; }

// Time picker = Hour : Min · AM/PM dropdowns syncing into the hidden #appt-time
// (24h "HH:MM") that saveAppt reads. setApptTimeFields loads them from a 24h time
// (minute snapped to the nearest 15).
export function syncApptTime() {
  const h = parseInt(document.getElementById('appt-hour')?.value || '9', 10);
  const m = document.getElementById('appt-min')?.value || '00';
  const ap = document.getElementById('appt-ampm')?.value || 'AM';
  let h24 = h % 12; if (ap === 'PM') h24 += 12;
  const el = document.getElementById('appt-time'); if (el) el.value = `${String(h24).padStart(2,'0')}:${m}`;
}
function setApptTimeFields(h24, m) {
  h24 = (((parseInt(h24, 10) || 0) % 24) + 24) % 24; m = parseInt(m, 10) || 0;
  m = Math.round(m / 15) * 15; if (m === 60) { m = 0; h24 = (h24 + 1) % 24; }
  const ap = h24 >= 12 ? 'PM' : 'AM'; let h12 = h24 % 12; if (h12 === 0) h12 = 12;
  const hs = document.getElementById('appt-hour'); if (hs) hs.value = String(h12);
  const ms = document.getElementById('appt-min'); if (ms) ms.value = String(m).padStart(2, '0');
  const aps = document.getElementById('appt-ampm'); if (aps) aps.value = ap;
  const el = document.getElementById('appt-time'); if (el) el.value = `${String(h24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function showNewApptModal(calId, hour, minute, techName) {
  _apptEditId = null; _apptLines = []; _apptExtraGuests = []; _apptEditGroupId = '';
  const eg = document.getElementById('appt-extra-guests'); if (eg) eg.innerHTML = '';
  document.getElementById('appt-modal-title').textContent = 'New Appointment';
  document.getElementById('appt-event-id').value = '';
  document.getElementById('appt-cal-id').value = calId || '';
  ['appt-name','appt-first','appt-last','appt-phone','appt-notes'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('appt-delete-btn').classList.add('hidden');
  document.getElementById('appt-date').value = localDateStr(new Date(_calDate));
  setApptTimeFields(hour ?? 9, minute ?? 0);
  // Default the line to the clicked column's staff (calId is now a staffId; '' = Unassigned).
  const startStaff = (calId && buildStaffColumns().some(c => c.id === calId)) ? calId : '';
  addApptServiceLine('', startStaff);
  const m = document.getElementById('appt-modal'); m.classList.remove('hidden'); m.style.display = 'flex';
  setTimeout(() => document.getElementById('appt-phone').focus(), 100);
}
export function showConvertToApptModal(apptId) { showEditApptModal(apptId); }   // native: no plain-event conversion
export function showEditApptModal(apptId) {
  const a = (getState().appointments || []).find(x => x.id === apptId); if (!a) return;
  _apptEditId = apptId; _apptExtraGuests = []; _apptEditGroupId = '';
  const startDt = new Date(a.start), endDt = new Date(a.end || startDt.getTime()+3600000);
  const durMins = Math.max(15, Math.round((endDt-startDt)/60000));
  document.getElementById('appt-modal-title').textContent = 'Edit Appointment';
  document.getElementById('appt-event-id').value = apptId; document.getElementById('appt-cal-id').value = '';
  const g0 = (a.guests || [])[0] || {};
  const parts = (g0.name || '').split(' ');
  document.getElementById('appt-first').value = parts[0] || ''; document.getElementById('appt-last').value = parts.slice(1).join(' ') || '';
  document.getElementById('appt-name').value = g0.name || '';
  document.getElementById('appt-notes').value = a.notes || '';
  document.getElementById('appt-phone').value = g0.phone || '';
  document.getElementById('appt-date').value = localDateStr(startDt);
  setApptTimeFields(startDt.getHours(), startDt.getMinutes());
  document.getElementById('appt-delete-btn').classList.remove('hidden');
  const durSel = document.getElementById('appt-duration'); durSel.value = [...durSel.options].reduce((x,y)=>Math.abs(parseInt(y.value)-durMins)<Math.abs(parseInt(x.value)-durMins)?y:x).value;
  _apptLines = (g0.lines || []).map(l => ({ svcId: l.serviceId || '', staffId: l.staffId || '' }));
  if (_apptLines.length === 0) _apptLines.push({ svcId:'', staffId:'' });
  _apptExtraGuests = (a.guests || []).slice(1).map(g => { const gp = (g.name||'').split(' '); return { first: gp[0]||'', last: gp.slice(1).join(' ')||'', phone: g.phone||'', lines: (g.lines||[]).map(l => ({ svcId: l.serviceId||'', staffId: l.staffId||'' })) }; });
  renderApptServiceLines(); renderApptExtraGuests();
  const m = document.getElementById('appt-modal'); m.classList.remove('hidden'); m.style.display = 'flex';
}
export function closeApptModal() { const m = document.getElementById('appt-modal'); m.classList.add('hidden'); m.style.display = ''; _apptEditId = null; _apptExtraGuests = []; _apptEditGroupId = ''; const eg = document.getElementById('appt-extra-guests'); if (eg) eg.innerHTML = ''; }

// Build one person's event body. museLines/museName/musePhone (per person) + a
// shared museGroupId link everyone in the booking so quick check-in can pull the
// whole party in as one group.
function _apptEventBody(person, startDt, endDt, notes, groupId, primary) {
  const svcTitles = person.lines.filter(l => l.svcId).map(l => cfg().services.find(s=>s.id===l.svcId)?.label).filter(Boolean);
  const summary = svcTitles.length > 0 ? `${person.name} — ${svcTitles.join(', ')}` : person.name;
  const museLines = person.lines.filter(l => l.svcId || l.calId).map(l => ({ svcId: l.svcId || '', calId: l.calId || '' }));
  const priv = { museLines: JSON.stringify(museLines), musePhone: person.phone || '', museName: person.name };
  if (groupId) priv.museGroupId = groupId;
  // Every event in a booking carries the primary's name/phone so the calendar can
  // render the whole party as one bubble labelled by the primary guest.
  if (primary) { priv.musePrimaryName = primary.name; priv.musePrimaryPhone = primary.phone || ''; if (primary.isPrimary) priv.musePrimary = '1'; }
  return { summary, description: notes, start: { dateTime: startDt.toISOString() }, end: { dateTime: endDt.toISOString() }, extendedProperties: { private: priv } };
}

export async function saveAppt() {
  if (_apptSaving) return;
  const first = document.getElementById('appt-first')?.value.trim() || '', last = document.getElementById('appt-last')?.value.trim() || '';
  const name = [first,last].filter(Boolean).join(' ') || document.getElementById('appt-name')?.value.trim() || '';
  const phone = document.getElementById('appt-phone').value.trim(), dateVal = document.getElementById('appt-date').value, timeVal = document.getElementById('appt-time').value;
  const durMins = parseInt(document.getElementById('appt-duration').value) || 60, notes = document.getElementById('appt-notes').value.trim();
  if (!name) { showToast('Enter a customer name'); return; }
  if (!dateVal) { showToast('Select a date'); return; }
  // Sync the primary lines from the DOM selects (svc + staff), then the extra guests.
  document.querySelectorAll('#appt-service-lines [data-line]').forEach((row,i) => { const sels = row.querySelectorAll('select'); if (_apptLines[i]) { _apptLines[i].svcId = sels[0]?.value || ''; _apptLines[i].staffId = sels[1]?.value || ''; } });
  _syncApptGuestsFromDom();
  const anyService = _apptLines.some(l => l.svcId) || _apptExtraGuests.some(g => (g.lines||[]).some(l => l.svcId));
  if (!anyService) { showToast('Add at least one service'); return; }
  const startDt = new Date(`${dateVal}T${timeVal || '09:00'}`), endDt = new Date(startDt.getTime() + durMins*60000);

  // Build the guests array: primary + each named extra guest, each with their own lines.
  const guests = [{ name, phone, lines: _apptLines.filter(l => l.svcId || l.staffId).map(l => ({ serviceId: l.svcId || '', staffId: l.staffId || '' })) }];
  _apptExtraGuests.forEach(g => {
    const gName = [g.first, g.last].filter(Boolean).join(' ').trim();
    if (!gName) return;
    guests.push({ name: gName, phone: (g.phone||'').trim(), lines: (g.lines||[]).filter(l => l.svcId || l.staffId).map(l => ({ serviceId: l.svcId || '', staffId: l.staffId || '' })) });
  });

  const existing = _apptEditId ? (getState().appointments || []).find(a => a.id === _apptEditId) : null;
  const appt = {
    id: _apptEditId || newApptId(),
    start: startDt.toISOString(), end: endDt.toISOString(),
    guests, notes,
    confirmed: existing ? !!existing.confirmed : false,
    noShow: existing ? !!existing.noShow : false,
    checkedInQueueId: existing ? (existing.checkedInQueueId || null) : null,
    createdAt: existing ? (existing.createdAt || Date.now()) : Date.now(),
  };
  const prevStaff = new Set(existing ? (existing.guests||[]).flatMap(g => (g.lines||[]).map(l => l.staffId).filter(Boolean)) : []);

  _apptSaving = true;
  const saveBtn = document.querySelector('#appt-modal button[onclick="saveAppt()"]'); if (saveBtn) saveBtn.disabled = true;
  try {
    dispatch('appt.upsert', { appt });
    guests.forEach(g => { if (g.phone) squareUpsertCustomer({ name: g.name, phone: g.phone }); });   // keep the directory current
    try { _notifyApptTechs(appt, prevStaff); } catch {}
    closeApptModal();
    showToast(guests.length > 1 ? `Appointment saved for ${guests.length} guests ✓` : 'Appointment saved ✓');
    // The store subscription re-renders when the optimistic apply notifies; force one for safety.
    if (document.getElementById('panel-calendar')?.classList.contains('active')) calLoadAndRender(true);
  } catch (err) { console.warn('[calendar] saveAppt failed:', err); showToast('Could not save the appointment'); }
  finally { _apptSaving = false; if (saveBtn) saveBtn.disabled = false; }
}
// Push each tech newly assigned by this save (best-effort, fire-and-forget). Newly-assigned =
// a staffId on the appt now that wasn't there before (prevStaff), skipping Unassigned.
function _notifyApptTechs(appt, prevStaff) {
  const nowStaff = new Set((appt.guests||[]).flatMap(g => (g.lines||[]).map(l => l.staffId).filter(Boolean)));
  const techIds = [...nowStaff].filter(id => id && !prevStaff.has(id));
  if (!techIds.length) return;
  const startDt = new Date(appt.start);
  const when = startDt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    + ', ' + startDt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const custName = (appt.guests||[])[0]?.name || 'Guest';
  fetch(PUSH_PROXY + '/notify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ techIds, title: 'New appointment 📅', body: `${custName} — ${when}`, tag: 'muse-appt' }),
  }).catch(() => {});
}

export async function deleteAppt(apptIdParam) {
  const apptId = apptIdParam || document.getElementById('appt-event-id')?.value;
  if (!apptId) return;
  if (!apptIdParam && !confirm('Cancel this appointment?')) return;
  try {
    dispatch('appt.delete', { id: apptId });
    if (!apptIdParam) closeApptModal();
    showToast('Appointment cancelled');
    if (document.getElementById('panel-calendar')?.classList.contains('active')) calLoadAndRender(true);
  } catch (err) { console.warn('[calendar] deleteAppt failed:', err); showToast('Could not cancel the appointment'); }
}

// ── Google Tasks ──────────────────────────────────
let _taskLists = [], _currentListId = null, _tasksMinimized = false;
export async function loadTaskLists() {
  try {
    const res = await gapi.client.tasks.tasklists.list({ maxResults: 20 });
    _taskLists = res.result.items || [];
    const sel = document.getElementById('tasks-list-select'); if (!sel) return;
    sel.innerHTML = _taskLists.map(l => `<option value="${_escHtml(l.id)}">${_escHtml(l.title)}</option>`).join('');
    if (_taskLists.length > 0) { _currentListId = _taskLists[0].id; loadTasksForList(_currentListId); }
    const panel = document.getElementById('cal-tasks-panel'); if (panel) { panel.classList.remove('hidden'); panel.style.display = 'flex'; }
  } catch (e) { console.warn('[Tasks] loadTaskLists failed:', e); }
}
export async function loadTasksForList(listId) {
  if (!listId) return;
  _currentListId = listId;
  const container = document.getElementById('tasks-list'); if (!container) return;
  container.innerHTML = '<div class="text-xs text-on-surface-variant text-center py-4">Loading…</div>';
  try { const res = await gapi.client.tasks.tasks.list({ tasklist: listId, showCompleted: true, showHidden: false, maxResults: 100 }); renderTasks((res.result.items || []).sort((a,b)=>(a.status==='completed'?1:0)-(b.status==='completed'?1:0))); }
  catch (e) { container.innerHTML = '<div class="text-xs text-error text-center py-4">Failed to load tasks</div>'; }
}
function renderTasks(tasks) {
  const container = document.getElementById('tasks-list'); if (!container) return;
  if (!tasks.length) { container.innerHTML = '<div class="text-xs text-on-surface-variant text-center py-6 opacity-60">No tasks — all caught up!</div>'; return; }
  container.innerHTML = tasks.map(t => { const done = t.status === 'completed', due = t.due ? new Date(t.due) : null, dueStr = due ? due.toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '', overdue = due && due < new Date() && !done, lid = _currentListId;
    return `<div class="flex items-start gap-2 px-2 py-0.5 rounded-lg hover:bg-surface-container transition-colors group"><button onclick="toggleTask('${_escAttrJs(lid)}','${_escAttrJs(t.id)}','${done?'needsAction':'completed'}')" class="flex-shrink-0 transition-colors" style="width:15px;height:15px;min-width:15px;min-height:15px;margin-top:1px;aspect-ratio:1/1;border-radius:50%;border:2px solid ${done?'#1a5252':'#9ca3af'};background:${done?'#1a5252':'#fff'};display:flex;align-items:center;justify-content:center;padding:0;box-sizing:border-box">${done?'<span class="material-symbols-outlined text-on-primary" style="font-size:9px;line-height:1;font-variation-settings:\'FILL\' 1">check</span>':''}</button><div class="flex-1 min-w-0" style="line-height:1.25"><div class="text-xs font-body ${done?'line-through text-on-surface-variant opacity-50':'text-on-surface font-medium'}" style="line-height:1.3">${_escHtml(t.title||'(no title)')}</div>${t.notes?`<div class="text-[10px] text-on-surface-variant truncate" style="line-height:1.25">${_escHtml(t.notes)}</div>`:''}${dueStr?`<div class="text-[10px] font-semibold ${overdue?'text-error':'text-on-surface-variant'}" style="line-height:1.25">${overdue?'⚠ ':''}${dueStr}</div>`:''}</div><button onclick="deleteTask('${_escAttrJs(lid)}','${_escAttrJs(t.id)}')" class="opacity-0 group-hover:opacity-100 flex-shrink-0 text-outline-variant hover:text-error transition-all" style="margin-top:1px;height:16px;line-height:1;display:flex;align-items:center;justify-content:center;padding:0"><span class="material-symbols-outlined" style="font-size:13px;line-height:1">close</span></button></div>`;
  }).join('');
}
export function toggleTasksPanel() {
  // Vertical collapse inside the right rail: minimized Tasks shrinks to its header
  // and the Today's-Appointments panel above grows to fill the freed space.
  _tasksMinimized = !_tasksMinimized;
  const panel = document.getElementById('cal-tasks-panel'), btn = document.getElementById('tasks-minimize-btn'), body = document.getElementById('tasks-list'), selWrap = document.getElementById('tasks-list-select')?.parentElement;
  if (panel) { panel.style.flex = _tasksMinimized ? '0 0 auto' : '1 1 0'; if (body) body.style.display = _tasksMinimized ? 'none' : ''; if (selWrap) selWrap.style.display = _tasksMinimized ? 'none' : ''; }
  if (btn) { btn.querySelector('.material-symbols-outlined').textContent = _tasksMinimized ? 'expand_less' : 'expand_more'; btn.title = _tasksMinimized ? 'Show Tasks' : 'Hide Tasks'; }
}
export async function toggleTask(listId, taskId, newStatus) { try { await gapi.client.tasks.tasks.patch({ tasklist: listId, task: taskId, resource: { status: newStatus, completed: newStatus==='completed' ? new Date().toISOString() : null } }); loadTasksForList(listId); } catch (e) { showToast('Could not update task'); } }
export async function deleteTask(listId, taskId) { try { await gapi.client.tasks.tasks.delete({ tasklist: listId, task: taskId }); loadTasksForList(listId); } catch (e) { showToast('Could not delete task'); } }
export function showAddTaskModal() { const title = prompt('New task title:'); if (!title?.trim() || !_currentListId) return; gapi.client.tasks.tasks.insert({ tasklist: _currentListId, resource: { title: title.trim() } }).then(() => loadTasksForList(_currentListId)).catch(() => showToast('Could not add task')); }
