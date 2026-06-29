// ── Front-desk time clock ────────────────────────────────────────────────────
// The logged-in front-desk user clocks in/out from a header button. Punches are
// synced per-user (config key `fd_clock_<id>` = [{ in:ms, out:ms|null }]) — a key
// per user so two devices punching different people can't clobber each other.
// Payroll computes paid hours from these punches with the owner's rounding: each
// clock-in→out segment's duration is rounded to the nearest 15 min (≤7 min grace
// rounds down, ≥8 rounds up).
import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { getActiveUser, canDo } from '../session.js';
import { showToast, escHtml } from '../utils.js';

const cfg = () => getState().config;
const _key = id => 'fd_clock_' + id;

export function fdPunches(userId) { return Array.isArray(cfg()[_key(userId)]) ? cfg()[_key(userId)] : []; }
export function fdIsClockedIn(userId) { const last = fdPunches(userId).slice(-1)[0]; return !!(last && last.in && !last.out); }
export function fdClockedSince(userId) { const last = fdPunches(userId).slice(-1)[0]; return (last && last.in && !last.out) ? last.in : null; }

function _save(userId, list) { dispatch('config.set', { key: _key(userId), value: list }); }
// Manager/admin timecard editing (reports.js) replaces a user's whole punch list.
export function fdSetPunches(userId, list) { _save(userId, Array.isArray(list) ? list : []); }

export function fdClockIn(userId) {
  if (!userId || fdIsClockedIn(userId)) return;
  _save(userId, [...fdPunches(userId), { in: Date.now(), out: null }]);
}
export function fdClockOut(userId) {
  const list = [...fdPunches(userId)];
  const last = list[list.length - 1];
  if (!last || last.out) return;                     // not clocked in → nothing to close
  list[list.length - 1] = { ...last, out: Date.now() };
  _save(userId, list);
}

// Header button: the logged-in FD user toggles their own clock. The synthetic
// "fallback" Manager (PIN 1234, no fd_users entry) can't clock — there's no profile/rate.
export function toggleMyClock() {
  const u = getActiveUser();
  if (!u || !u.id || u.id === 'fallback' || !(cfg().fd_users || []).some(x => x.id === u.id)) {
    showToast('Log in as a front-desk user to clock in.'); return;
  }
  if (!isClockStation()) { showToast('Clock in/out is only available on the salon time-clock station.'); return; }
  if (fdIsClockedIn(u.id)) { fdClockOut(u.id); showToast(`Clocked out — ${u.name}`); }
  else { fdClockIn(u.id); showToast(`Clocked in — ${u.name}`); }
  renderClockButton();
}

// One header icon, three states (per logged-in user + this device):
//   'clock'  — a front-desk user on the station device → tap toggles their punch
//   'notice' — a front-desk user NOT on the station → tap explains why clock-in is off
//   'warn'   — an admin where a station is saved but it isn't THIS device (the tell-tale of
//              a changed station id) → tap offers Fix / Dismiss
// Before v4.50 the button simply vanished off the station, leaving FD staff with no clue why.
let _clockState = 'hidden';
export function onClockBtn() {
  if (_clockState === 'clock') { toggleMyClock(); return; }
  toggleClockPopover();
}
export function renderClockButton() {
  const btn     = document.getElementById('clock-btn'); if (!btn) return;
  const dot     = document.getElementById('clock-btn-dot');
  const label   = document.getElementById('clock-btn-label');
  const divider = document.getElementById('user-menu-clock-divider');
  const u = getActiveUser();
  const isFd    = !!(u && u.id && u.id !== 'fallback' && (cfg().fd_users || []).some(x => x.id === u.id));
  const isAdmin = !!(u && u.role === 'admin');
  const stationSet = !!clockStationDeviceId(), onStation = isClockStation();

  let state = 'hidden';
  if (isFd && onStation) state = 'clock';
  else if (isFd && !onStation) state = 'notice';
  else if (isAdmin && stationSet && !onStation && !_nudgeDismissed()) state = 'warn';
  _clockState = state;

  if (state === 'hidden') {
    btn.style.display = 'none';
    if (divider) divider.style.display = 'none';
    dot?.classList.add('hidden');
    _hideClockPopover();
    return;
  }
  btn.style.display = 'flex';
  if (divider) divider.style.display = 'block';

  if (state === 'clock') {
    const inNow = fdIsClockedIn(u.id), since = fdClockedSince(u.id);
    btn.style.background = inNow ? '#2a7a4f' : '';
    btn.style.color      = inNow ? '#fff' : 'var(--primary)';
    btn.title = inNow ? `Clocked in since ${_hhmm(since)} — tap to clock out` : 'Tap to clock in';
    if (label) label.textContent = inNow ? 'Clock out' : 'Clock in';
    if (dot) dot.classList.add('hidden');
  } else {
    const warn = state === 'warn';
    btn.style.background = warn ? '#fef3c7' : '';
    btn.style.color      = warn ? '#b45309' : '#94a3a1';
    btn.title = warn ? 'Time-clock station changed — tap to fix'
      : (stationSet ? 'Clock-in unavailable on this device — tap for details' : 'Clock-in not set up — tap for details');
    if (label) label.textContent = 'Time clock';
    if (dot) dot.classList.remove('hidden');
  }
  // Keep an already-open popover's contents fresh on re-render.
  if (!document.getElementById('clock-popover')?.classList.contains('hidden')) _fillClockPopover();
}
function _hhmm(ms) { try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return ''; } }

// ── Clock-icon popover (notice / admin nudge) ────────────────────────────────
function _hideClockPopover() { document.getElementById('clock-popover')?.classList.add('hidden'); }
export function toggleClockPopover() {
  const p = document.getElementById('clock-popover'); if (!p) return;
  if (!p.classList.contains('hidden')) { p.classList.add('hidden'); return; }
  _fillClockPopover();
  const r = document.getElementById('clock-btn')?.getBoundingClientRect();
  p.style.top   = (r ? r.bottom + 8 : 52) + 'px';
  p.style.right = (r ? Math.max(8, window.innerWidth - r.right) : 12) + 'px';
  p.classList.remove('hidden');
}
function _fillClockPopover() {
  const p = document.getElementById('clock-popover'); if (!p) return;
  const stationSet = !!clockStationDeviceId();
  if (_clockState === 'warn') {
    p.innerHTML = `<div class="flex items-center gap-2 mb-1"><span class="material-symbols-outlined" style="font-size:18px;color:#f59e0b">warning</span><span class="font-headline font-bold text-sm text-on-surface">Time-clock station changed</span></div>
      <p class="text-xs font-body text-on-surface-variant">A station device is saved, but it isn’t this one — its ID likely changed (app reinstalled or storage cleared). Staff can’t clock in until a station is set.</p>
      <div class="flex gap-2 mt-3">
        <button onclick="openClockStationSetting()" class="px-3 py-2 rounded-lg bg-primary text-on-primary text-xs font-body font-semibold">Fix in Settings</button>
        <button onclick="dismissClockNudge()" class="px-3 py-2 rounded-lg border border-surface-container-high text-on-surface-variant text-xs font-body font-semibold">Dismiss</button></div>`;
  } else {
    p.innerHTML = `<div class="flex items-center gap-2 mb-1"><span class="material-symbols-outlined" style="font-size:18px;color:#c08a00">schedule</span><span class="font-headline font-bold text-sm text-on-surface">${stationSet ? 'Clock-in unavailable here' : 'Clock-in not set up'}</span></div>
      <p class="text-xs font-body text-on-surface-variant">${stationSet
        ? 'This device isn’t the salon’s time-clock station, so clock in/out is turned off here. Ask an admin to make this device the station (Settings → Pay Period).'
        : 'No time-clock station has been set yet. Ask an admin to set one (Settings → Pay Period).'}</p>`;
  }
}
export function openClockStationSetting() {
  _hideClockPopover();
  window.showDashPanel?.('settings');
  setTimeout(() => window.settingsOpenLeaf?.('settings-payperiod-section'), 30);
}
// Dismiss the admin nudge until the saved station id changes again (re-designation re-nudges
// once). Stored against the current station id, so an evicted/cleared localStorage drops the
// dismissal too — which is exactly when we want the nudge to reappear.
export function dismissClockNudge() {
  try { localStorage.setItem('turndesk_clock_nudge_dismissed', clockStationDeviceId()); } catch {}
  _hideClockPopover(); renderClockButton();
}
function _nudgeDismissed() {
  const s = clockStationDeviceId(); if (!s) return false;
  try { return localStorage.getItem('turndesk_clock_nudge_dismissed') === s; } catch { return false; }
}
// Tap-outside closes the popover (but not a tap on the clock button or inside the popover).
document.addEventListener('click', (e) => {
  const p = document.getElementById('clock-popover');
  if (!p || p.classList.contains('hidden')) return;
  if (p.contains(e.target) || document.getElementById('clock-btn')?.contains(e.target)) return;
  p.classList.add('hidden');
});

// ── Time-clock station (one designated device) ───────────────────────────────
// Clocking only works on the device an admin designated as the salon station — so a
// front-desk user can't clock in from a personal phone. The chosen device's id is stored
// in synced config (timeclock_device_id) and compared against this device's turndesk_device_id.
function _myDeviceId() { try { return localStorage.getItem('turndesk_device_id') || ''; } catch { return ''; } }
export function clockStationDeviceId() { return cfg().timeclock_device_id || ''; }
export function isClockStation() { const s = clockStationDeviceId(); return !!s && s === _myDeviceId(); }
export function setThisClockStation() {
  if (getActiveUser()?.role !== 'admin') { showToast('Only an admin can set the time-clock station.'); return; }
  const id = _myDeviceId();
  if (!id) { showToast('This device has no id yet — reload and try again.'); return; }
  dispatch('config.set', { key: 'timeclock_device_id', value: id });
  showToast('This device is now the time-clock station ✓');
  renderClockButton(); renderClockStationSetting();
}
export function clearClockStation() {
  if (getActiveUser()?.role !== 'admin') { showToast('Only an admin can change the time-clock station.'); return; }
  dispatch('config.set', { key: 'timeclock_device_id', value: '' });
  showToast('Time-clock station cleared');
  renderClockButton(); renderClockStationSetting();
}
// Fills #timeclock-station-status inside the Pay Period settings section. Diagnostic: shows
// the state + both device ids so a station-id mismatch (the cause of a vanished clock button)
// is obvious at a glance.
export function renderClockStationSetting() {
  const el = document.getElementById('timeclock-station-status'); if (!el) return;
  const setId = clockStationDeviceId(), thisId = _myDeviceId(), isThis = isClockStation(), isSet = !!setId;
  let row;
  if (isThis) {
    row = `<div class="flex items-center justify-between gap-2 px-3 py-2 rounded-lg" style="background:rgba(42,122,79,.12)"><span class="text-sm font-body" style="color:#1b5e20"><strong>This device</strong> is the time-clock station ✓</span><button onclick="clearClockStation()" class="text-xs font-body text-error underline flex-shrink-0">Remove</button></div>`;
  } else if (isSet) {
    row = `<div class="flex items-center justify-between gap-2 flex-wrap px-3 py-2 rounded-lg" style="background:#fef3c7"><span class="text-sm font-body" style="color:#7c4a03">⚠️ A station is saved, but it’s <strong>not this device</strong>. If this should be the station (e.g. the ID changed after a reinstall), make it the station again.</span><button onclick="setThisClockStation()" class="px-3 py-2 rounded-xl bg-primary text-on-primary text-sm font-body font-semibold flex-shrink-0">Make this device the station</button></div>`;
  } else {
    row = `<div class="flex items-center justify-between gap-2 flex-wrap"><span class="text-sm font-body text-on-surface-variant">No station set yet — staff can’t clock in until one is set.</span><button onclick="setThisClockStation()" class="px-3 py-2 rounded-xl bg-primary text-on-primary text-sm font-body font-semibold flex-shrink-0">Make this device the station</button></div>`;
  }
  const ids = `<div class="text-[11px] font-body text-on-surface-variant mt-2" style="font-family:ui-monospace,Menlo,Consolas,monospace"><strong>This device:</strong> ${escHtml(thisId || '—')} &nbsp;·&nbsp; <strong>Saved station:</strong> ${isSet ? escHtml(setId) + (isThis ? '' : ' (not this device)') : '— none —'}</div>`;
  el.innerHTML = row + ids;
}

// ── "Clocked in now" (live) — front-desk users with an open punch ─────────────
// Rendered at the top of Payroll, independent of the Front-Desk-Hourly section (which only
// shows when someone has a rate/hours). Gated by the viewClockedIn role permission.
export function clockedInNow() {
  return (cfg().fd_users || [])
    .filter(u => fdIsClockedIn(u.id))
    .map(u => ({ u, since: fdClockedSince(u.id) }))
    .sort((a, b) => a.since - b.since);
}
function _fmtDur(ms) {
  if (!(ms > 0)) return '0m';
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}
// "May 26, 10:00 AM" — includes the date so a stale open punch reads as not-today.
function _sinceDateTime(ms) {
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
// Total time worked TODAY (sum of today's segments — completed + the open one up to now), so a
// staff member with a mid-day break still shows their real worked time for the day. Counts only
// the portion that falls within today (a shift spanning midnight contributes today's part).
export function fdWorkedTodayMs(userId) {
  const start = new Date(); start.setHours(0, 0, 0, 0); const s = +start;
  let ms = 0;
  for (const p of fdPunches(userId)) {
    if (!p.in) continue;
    const end = p.out || Date.now();
    const from = Math.max(p.in, s);
    if (end > from) ms += end - from;
  }
  return ms;
}
export function renderClockedInNow() {
  const el = document.getElementById('clocked-in-now'); if (!el) return;
  if (!canDo('viewClockedIn')) { el.innerHTML = ''; el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  // A manager/admin can clock anyone out from here (any device) — closes a forgotten/leftover
  // shift without logging in as that person. Clock-OUT isn't station-locked (only clock-IN is).
  const canOut = ['admin', 'manager'].includes(getActiveUser()?.role);
  const list = clockedInNow();
  const rows = list.length
    ? list.map(({ u, since }) => {
        // A "clocked in" person whose open punch is stale (>18h) is almost certainly a forgotten
        // clock-out, NOT someone here now. Flag it (don't show a bogus "Nh today") and offer a Fix
        // that jumps to the timecard period holding that punch — otherwise it's invisible there.
        const open = fdPunches(u.id).slice(-1)[0];
        const suspect = open && fdPunchSuspect(open);
        const status = suspect
          ? '<span style="color:#c0392b;font-weight:700">● open</span>'
          : '<span style="color:#2a7a4f;font-weight:600">● in</span>';
        const detail = suspect
          ? `<span class="ml-auto text-xs" style="color:#c0392b">⚠ open since ${_sinceDateTime(since)} — forgotten clock-out?</span>`
          : `<span class="ml-auto text-xs text-on-surface-variant">since ${_hhmm(since)} · ${_fmtDur(fdWorkedTodayMs(u.id))} today</span>`;
        const action = !canOut ? '' : suspect
          ? `<button onclick="openTimecardAt('${u.id}',${since})" class="px-2.5 py-1 rounded-lg border border-primary text-xs font-body font-semibold text-primary hover:bg-primary/5 flex-shrink-0">Fix</button>`
          : `<button onclick="clockOutUser('${u.id}')" class="px-2.5 py-1 rounded-lg border border-surface-container-high text-xs font-body font-semibold text-on-surface hover:bg-surface-container flex-shrink-0">Clock out</button>`;
        return `<div class="flex items-center gap-3 py-2 border-b border-surface-container-high last:border-0 text-sm font-body">
        <div class="w-7 h-7 rounded-full flex items-center justify-center text-on-primary text-xs font-headline font-bold flex-shrink-0" style="background:var(--primary);overflow:hidden">${u.photo ? `<img src="${escHtml(u.photo)}" class="w-full h-full object-cover">` : escHtml((u.name || '?').charAt(0).toUpperCase())}</div>
        <span class="font-semibold text-on-surface">${escHtml(u.name || '—')}</span>
        ${status}
        ${detail}
        ${action}</div>`;
      }).join('')
    : `<div class="py-2 text-sm font-body text-on-surface-variant">Nobody is clocked in right now.</div>`;
  el.innerHTML = `<div class="mb-4 bg-surface-container-lowest rounded-xl border border-surface-container-high p-4">
    <div class="flex items-center gap-2 mb-1"><span class="material-symbols-outlined" style="font-size:18px;color:#2a7a4f">schedule</span><h3 class="text-sm font-headline font-bold text-on-surface uppercase tracking-widest">Clocked in now</h3><span class="text-[10px] font-body text-on-surface-variant border border-surface-container-high rounded px-1.5 py-0.5">live</span></div>
    ${rows}</div>`;
}
// Manager/admin clock-out of another front-desk user from the "Clocked in now" card.
export function clockOutUser(userId) {
  if (!['admin', 'manager'].includes(getActiveUser()?.role)) { showToast('Only a manager or admin can clock staff out.'); return; }
  const u = (cfg().fd_users || []).find(x => x.id === userId); if (!u) return;
  if (!fdIsClockedIn(userId)) { showToast(`${u.name} isn’t clocked in.`); renderClockedInNow(); return; }
  const since = fdClockedSince(userId);
  const doIt = () => { fdClockOut(userId); showToast(`Clocked out — ${u.name}`); renderClockedInNow(); };
  if (window.showWarnModal) window.showWarnModal(`Clock out ${u.name}?`, `This closes their open shift (clocked in since ${_hhmm(since)}) at the current time.`, doIt, 'Clock out');
  else doIt();
}
// Refresh the live elapsed time + button tooltip once a minute while Payroll is open.
setInterval(() => {
  if (document.getElementById('panel-payroll')?.classList.contains('active')) renderClockedInNow();
  if (document.getElementById('clock-btn')?.style.display !== 'none') renderClockButton();
}, 60000);

// ── Pay computation (used by payroll) ────────────────────────────────────────
// Round a duration (ms) to the nearest quarter hour → hours (e.g. 7 min → 0, 8 → 0.25).
export function roundQuarterHours(ms) { return Math.round((ms / 60000) / 15) * 15 / 60; }

// Forgotten-clock-out / -in guards (v4.56): nobody works a single stretch this long, so a segment
// over 16h (or an open punch older than 18h) is almost certainly a missed clock-out/in. It is
// EXCLUDED from paid hours and FLAGGED for a manager to fix, so one forgotten punch can't silently
// inflate someone's pay (e.g. a clock-in left open for 2 weeks → a 320h "segment").
export const MAX_SEGMENT_MS = 16 * 3600000;
export const STALE_OPEN_MS  = 18 * 3600000;
// True if a punch looks like a missed clock-out (>16h) / missed clock-in (open >18h) / bad (out≤in).
export function fdPunchSuspect(p) {
  if (!p || !p.in) return false;
  if (p.out == null) return (Date.now() - p.in) > STALE_OPEN_MS;
  const dur = p.out - p.in;
  return dur <= 0 || dur > MAX_SEGMENT_MS;
}
// Paid hours for a user whose shifts STARTED within [fromMs, toMs] — each completed segment rounded
// to the nearest 15 min, then summed. Open punches and suspect (forgotten) punches are NOT paid.
// Returns { hours, openShift, flagged } — flagged counts the suspect punches in range (needs review).
export function fdPaidHours(userId, fromMs, toMs) {
  let hours = 0, openShift = false, flagged = 0;
  for (const p of fdPunches(userId)) {
    if (!p.in || p.in < fromMs || p.in > toMs) continue;
    if (fdPunchSuspect(p)) { flagged++; continue; }   // forgotten clock-out/in → exclude from pay, flag it
    if (!p.out) { openShift = true; continue; }        // a normal in-progress shift (not stale)
    hours += roundQuarterHours(p.out - p.in);
  }
  return { hours, openShift, flagged };
}
