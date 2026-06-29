// ── Muse Staff — minimal technician app ─────────────────────────────────────
// A SEPARATE page (staff.html) that reuses the dashboard's Durable Object sync
// (store + sync) but shows ONLY the logged-in tech's assigned services. The tech
// can Start the service, enter a price, and mark it Complete — pushed back to the
// dashboard via the same queue.upsert mutation. The front desk still owns "Paid".
//
// It never renders the dashboard, reports, settings, or other customers. (UI-level
// separation only — the open transport still sends full state; true per-tech
// isolation is the server-auth item, intentionally out of scope here.)
import './apptoken.js';   // §13 backend auth — installs the bearer-token fetch wrapper; keep FIRST
import './modal-guard.js';   // global backdrop-close guard (drag-select in a field no longer closes popups)
import { serverLogin } from './apptoken.js';
import * as store from './store.js';
import * as sync from './sync.js';
import { showToast, localDateStr, todayStr, showUpdatePopup, hardReloadApp } from './utils.js';
import { applyAssignmentStatus, isPaidStatus } from './features/status.js';
import { VAPID_PUBLIC_KEY, PUSH_PROXY, GCAL_PROXY, APP_VERSION } from './config.js';
import { getFdShift, fdShiftLabel } from './features/fd-schedule.js';
import * as chat from './features/chat.js';
Object.assign(window, chat);   // chat panel uses inline onclick= handlers
import { fdPaidHours, fdPunches, roundQuarterHours, fdPunchSuspect } from './features/timeclock.js';

const cfg     = () => store.getState().config;
const queue   = () => store.getState().queue;
const records = () => store.getState().records;
const svc     = id => (cfg().services || []).find(s => s.id === id);
// Station label for an assignment's a.station id (mirrors queue.js stationLabel without importing it).
const stationLbl = id => { if (!id) return ''; const d = (cfg().stations || []).find(s => s.id === id); return d ? (d.label || d.id) : String(id); };

const MY_KEY = 'turndesk_staff_id';            // device-local: which tech is signed in on THIS device
let myId = localStorage.getItem(MY_KEY) || null;
const MY_FD_KEY = 'turndesk_staff_fd_id';      // device-local: a front-desk user signed in here (read-only schedule/hours)
let myFdId = localStorage.getItem(MY_FD_KEY) || null;
let _view = 'active';                      // 'active' | 'appts' | 'history'
let _updateVer = null;                     // newer published version detected → show the update banner
const _priceDraft = {};                    // `${entryId}:${serviceId}` -> typed price (survives re-render)

// ── Pure helpers (exported for unit tests) ───────────────────────────────────
export function staffByPin(staffList, inactiveIds, pin) {
  const p = String(pin == null ? '' : pin).trim();
  if (!p) return null;
  const inactive = new Set(inactiveIds || []);
  return (staffList || []).find(s => s.pin && String(s.pin) === p && !inactive.has(s.id)) || null;
}
// Active (not-paid) assignments for this tech, flattened to { entry, assignment }.
export function myActiveAssignments(queueArr, techId) {
  const out = [];
  if (!techId) return out;
  (queueArr || []).forEach(e => {
    if (isPaidStatus(e.status)) return;
    (e.assignments || []).forEach(a => { if (a.techId && a.techId === techId) out.push({ entry: e, assignment: a }); });
  });
  return out;
}
// This tech's COMPLETED work (complete + paid), merging stored records with the live queue
// — records are the source of truth (a queue entry is used only when no record exists for
// its id yet), same rule as the dashboard, so the tech's totals match the front desk and a
// stale paid queue copy can't shadow an edited record. Returns { name, serviceId, cost,
// date, time, paid } lines, newest first.
export function myHistory(queueArr, recordsArr, deletions, techId) {
  if (!techId) return [];
  const deleted = new Set((deletions || []).map(String));
  (recordsArr || []).forEach(r => { if (r.status === 'deleted') deleted.add(String(r.id)); });
  const recordedIds = new Set((recordsArr || []).filter(r => r.status !== 'deleted' && !deleted.has(String(r.id))).map(r => String(r.id)));
  const liveIds = new Set(), src = [];
  (queueArr || []).forEach(e => { if (deleted.has(String(e.id)) || recordedIds.has(String(e.id))) return; liveIds.add(String(e.id)); src.push(e); });
  (recordsArr || []).forEach(r => { if (r.status === 'deleted' || deleted.has(String(r.id)) || liveIds.has(String(r.id))) return; src.push(r); });
  const lines = [];
  src.forEach(rec => (rec.assignments || []).forEach(a => {
    if (a.techId !== techId) return;
    const st = a.status || 'waiting';
    if (st !== 'complete' && !isPaidStatus(st)) return;
    if (a.awaitingPrice && st === 'complete') return;   // not real history until it's priced
    const when = rec.checkinTime || rec.completedAt;
    lines.push({ name: rec.name || 'Guest', serviceId: a.serviceId, cost: a.cost || 0, date: localDateStr(new Date(when)), time: rec.completedAt || when, paid: isPaidStatus(st) });
  }));
  return lines.sort((a, b) => new Date(b.time) - new Date(a.time));
}

const me = () => (cfg().staff || []).find(s => s.id === myId) || null;
// Per-tech staff-app feature switches (set in the dashboard's technician editor).
// `app[key] !== false` so techs without the field (legacy) keep every feature ON.
const appPerm = k => { const s = me(); return !s || !s.app || s.app[k] !== false; };
const meFd = () => (cfg().fd_users || []).find(u => u.id === myFdId) || null;
const fdByPin = pin => { const p = String(pin == null ? '' : pin).trim(); return p ? ((cfg().fd_users || []).find(u => u.pin && String(u.pin) === p) || null) : null; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
function parsePrice(v) { if (v == null || String(v).trim() === '') return null; const n = parseFloat(v); return (isFinite(n) && n >= 0) ? n : null; }

// Same vocabulary + filled palette as the dashboard's serviceLineStyle (C9/D13; recolored v4.79):
// Waiting (amber) · In Service (green) · Done (blue) · Paid (slate).
const STATUS_CHIP = {
  waiting:   { bg:'#f5c870', fg:'#3a2800', label:'Waiting'    },
  inservice: { bg:'#2a7a4f', fg:'#ffffff', label:'In Service' },
  complete:  { bg:'#1a5c7a', fg:'#ffffff', label:'Done'       },
  awaiting:  { bg:'#6b4fb0', fg:'#ffffff', label:'Needs price' },   // front desk marked done; I owe a price
  paid:      { bg:'#5b6166', fg:'#ffffff', label:'Paid'       },
};
function statusChip(status) {
  const c = STATUS_CHIP[status] || STATUS_CHIP.waiting;
  return `<span class="text-[11px] font-body font-bold px-2 py-0.5 rounded-full" style="background:${c.bg};color:${c.fg}">${c.label}</span>`;
}

// Keep the chat's "me" identity + the FAB in sync with who's signed in here.
function syncChat() {
  if (myId) chat.setChatIdentity('tech:' + myId, me()?.name || 'Tech');
  else if (myFdId) chat.setChatIdentity('fd:' + myFdId, meFd()?.name || 'Front desk');
  else chat.setChatIdentity(null);
  const loggedIn = !!(myId || myFdId);
  const fab = document.getElementById('chat-fab'); if (fab) fab.style.display = loggedIn ? 'flex' : 'none';
  if (!loggedIn) chat.closeChat();
  chat.updateChatBadge();
}

// ── Render ────────────────────────────────────────
function render() {
  syncChat();
  const fd = meFd();
  if (fd) { renderFdView(fd); maybeNotifPrompt(); return; }
  const meStaff = me();
  if (!meStaff) return renderLogin();
  renderMain(meStaff);
  maybeNotifPrompt();
}

// Proactive "Allow notifications" pop-up — auto-shown once per session when someone's
// signed in on this device but hasn't granted permission yet, so chat/assignment pings
// actually reach their phone. Only when it can do something: permission still 'default'
// (never 'denied' — can't re-prompt), and not an iOS browser tab (must be installed).
function _notifEl() { return document.getElementById('staff-notif-modal'); }
function maybeNotifPrompt() {
  if (!(myId || myFdId) || !pushSupported()) return;
  if (Notification.permission !== 'default') return;
  if (isIOS() && !isStandalone()) return;
  try { if (sessionStorage.getItem('turndesk_notif_dismissed')) return; } catch {}
  const m = _notifEl(); if (!m || m.style.display === 'flex') return;
  m.classList.remove('hidden'); m.style.display = 'flex';
}
window.staffNotifAllow = () => { window.enableStaffPush(); const m = _notifEl(); if (m) { m.classList.add('hidden'); m.style.display = ''; } };   // call requestPermission first (within the tap), then hide
window.staffNotifDismiss = () => { const m = _notifEl(); if (m) { m.classList.add('hidden'); m.style.display = ''; } try { sessionStorage.setItem('turndesk_notif_dismissed', '1'); } catch {} };

// ── Front-desk view (read-only: this week's schedule + this period's clocked hours) ──
function _fdWeekStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - x.getDay()); return x; }
function _fdHM(ms) { try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return ''; } }
// Pay period at an offset from the current one (0 = current, −1 = previous, +1 = next).
// Mirrors reports.js payPeriodDates: weekly / biweekly / bimonthly, so the staff app and
// the manager's Payroll always agree.
function _fdPayPeriodAt(offset = 0) {
  const pp = cfg().pay_period || {}, type = pp.type || 'weekly';
  const now = new Date(); now.setHours(0, 0, 0, 0);
  if (type === 'bimonthly') {
    // half-month periods (1–15, 16–end); step by `offset` halves
    const idx = (now.getDate() <= 15 ? 0 : 1) + offset;
    let m = now.getMonth() + Math.floor(idx / 2);
    const y = now.getFullYear() + Math.floor(m / 12);
    m = ((m % 12) + 12) % 12;
    const h = ((idx % 2) + 2) % 2;
    return h === 0
      ? { from: new Date(y, m, 1), to: new Date(y, m, 15, 23, 59, 59, 999) }
      : { from: new Date(y, m, 16), to: new Date(y, m + 1, 0, 23, 59, 59, 999) };
  }
  // weekly / biweekly — UTC-midnight day count so a DST transition can't shift the boundary.
  const len = type === 'biweekly' ? 14 : 7;
  const anchor = pp.startDate ? new Date(pp.startDate + 'T00:00:00') : new Date(2024, 0, 7);
  const utcMid = x => Date.UTC(x.getFullYear(), x.getMonth(), x.getDate());
  const daysSince = Math.round((utcMid(now) - utcMid(anchor)) / 86400000);
  const mod = ((daysSince % len) + len) % len;
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - mod + len * offset);
  const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + (len - 1), 23, 59, 59, 999);
  return { from, to };
}

// FD view navigation state: which schedule week and pay period are shown (0 = current).
// "Turn on alerts" prompt — shown in both the tech and front-desk views so either
// can grant notification permission (needed for assignment AND chat pushes).
function notifBannerHtml() {
  return (pushSupported() && Notification.permission !== 'granted') ? `
    <button onclick="enableStaffPush()" class="w-full mb-3 rounded-xl border-2 border-primary text-primary py-3 font-headline font-bold text-sm flex items-center justify-center gap-2 hover:bg-primary/10 transition-colors">
      <span class="material-symbols-outlined" style="font-size:18px">notifications_active</span> Turn on alerts — messages &amp; assignments
    </button>` : '';
}

let _fdUser = null, _fdSchedOffset = 0, _fdPeriodOffset = 0;
window.fdNavSched = (dir) => { _fdSchedOffset += dir; if (_fdUser) renderFdView(_fdUser); };
window.fdNavPeriod = (dir) => { _fdPeriodOffset += dir; if (_fdUser) renderFdView(_fdUser); };
function renderFdView(fdUser) {
  _fdUser = fdUser;
  document.getElementById('staff-login').classList.add('hidden');
  document.getElementById('staff-main').classList.remove('hidden');
  document.getElementById('staff-tech-name').textContent = fdUser.name;
  const dot = document.getElementById('staff-conn'); if (dot) dot.style.background = store.getState().connected ? '#2a7a4f' : '#e8730a';
  const schedBase = new Date(); schedBase.setDate(schedBase.getDate() + _fdSchedOffset * 7);
  const ws = _fdWeekStart(schedBase), dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], today = todayStr();
  const we = new Date(ws); we.setDate(we.getDate() + 6);
  const sched = dayNames.map((dn, i) => {
    const d = new Date(ws); d.setDate(d.getDate() + i);
    const key = localDateStr(d), sh = getFdShift(key, fdUser.id), isToday = key === today;
    const val = sh === 'off' ? '<span style="color:#a05000">Off</span>' : (sh && sh.s) ? esc(fdShiftLabel(sh)) : '<span class="text-on-surface-variant">—</span>';
    return `<div class="flex items-center justify-between px-4 py-3 ${isToday ? 'bg-primary/10' : ''} border-b border-surface-container-high last:border-0"><span class="font-body text-lg ${isToday ? 'font-bold text-primary' : 'text-on-surface'}">${dn} ${d.getDate()}</span><span class="font-headline font-bold text-lg">${val}</span></div>`;
  }).join('');
  const per = _fdPayPeriodAt(_fdPeriodOffset);
  const { hours, openShift, flagged } = fdPaidHours(fdUser.id, +per.from, +per.to);
  const punches = fdPunches(fdUser.id).filter(p => p.in >= +per.from && p.in <= +per.to).sort((a, b) => b.in - a.in);
  const punchHtml = punches.length ? punches.map(p => {
    const suspect = fdPunchSuspect(p);
    const dur = suspect ? '<span style="color:#c0392b;font-weight:700">⚠ review</span>' : (p.out ? roundQuarterHours(p.out - p.in).toFixed(2) + 'h' : '<span style="color:#c77700">open</span>');
    return `<div class="flex items-center justify-between px-4 py-2.5 border-b border-surface-container-high last:border-0${suspect ? ' bg-error/5' : ''}"><span class="font-body text-on-surface">${new Date(p.in).toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' })}</span><span class="font-body text-on-surface-variant text-sm">${_fdHM(p.in)} – ${p.out ? _fdHM(p.out) : '…'}</span><span class="font-headline font-bold">${dur}</span></div>`;
  }).join('') : '<div class="px-4 py-5 text-center font-body text-on-surface-variant">No clock punches this period.</div>';
  const fmtD = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const schedLabel = _fdSchedOffset === 0 ? 'This week' : `${fmtD(ws)} – ${fmtD(we)}`;
  const periodLabel = _fdPeriodOffset === 0 ? 'Current pay period'
    : _fdPeriodOffset < 0 ? `${-_fdPeriodOffset} period${_fdPeriodOffset < -1 ? 's' : ''} ago`
    : `${_fdPeriodOffset} period${_fdPeriodOffset > 1 ? 's' : ''} ahead`;
  const navBtn = (fn, dir, glyph) => `<button onclick="${fn}(${dir})" class="w-9 h-9 rounded-lg border border-surface-container-high text-on-surface flex items-center justify-center active:scale-95">${glyph}</button>`;
  document.getElementById('staff-list').innerHTML = `
    ${notifBannerHtml()}
    <div class="flex items-center justify-between mb-2">
      ${navBtn('fdNavPeriod', -1, '◀')}
      <span class="text-xs font-headline font-bold uppercase tracking-widest text-on-surface-variant">${periodLabel}</span>
      ${navBtn('fdNavPeriod', 1, '▶')}
    </div>
    <div class="rounded-2xl bg-primary text-on-primary px-5 py-4 mb-4 shadow-sm">
      <div class="text-xs font-body uppercase tracking-widest opacity-80">Hours · ${fmtD(per.from)}–${fmtD(per.to)}</div>
      <div class="font-headline font-extrabold leading-none mt-1" style="font-size:40px">${hours.toFixed(2)}<span class="text-2xl"> h</span></div>
      ${fdUser.hourlyRate ? `<div class="text-sm font-body opacity-90 mt-0.5">≈ $${(hours * fdUser.hourlyRate).toFixed(2)} at $${fdUser.hourlyRate.toFixed(2)}/hr</div>` : ''}
      ${openShift ? '<div class="text-sm font-body opacity-90 mt-0.5">⏱ currently clocked in</div>' : ''}
      ${flagged ? `<div class="text-sm font-body mt-1 px-2 py-1 rounded-lg" style="background:rgba(0,0,0,.18)">⚠ ${flagged} punch${flagged > 1 ? 'es' : ''} need a manager to fix (not counted)</div>` : ''}
    </div>
    <div class="mb-4">
      <div class="flex items-center justify-between mb-2 px-1">
        <div class="text-sm font-headline font-bold uppercase tracking-widest text-on-surface-variant">My schedule · ${schedLabel}</div>
        <div class="flex gap-1.5">${navBtn('fdNavSched', -1, '◀')}${navBtn('fdNavSched', 1, '▶')}</div>
      </div>
      <div class="bg-surface-container-lowest rounded-2xl border border-surface-container-high overflow-hidden">${sched}</div>
    </div>
    <div>
      <div class="text-sm font-headline font-bold uppercase tracking-widest text-on-surface-variant mb-2 px-1">Clock punches · this period</div>
      <div class="bg-surface-container-lowest rounded-2xl border border-surface-container-high overflow-hidden">${punchHtml}</div>
    </div>
    <p class="text-xs font-body text-on-surface-variant text-center mt-4">Clock in/out happens at the front-desk station.</p>`;
}

// True while a tech is actively typing in a price field. A sync-driven re-render rebuilds
// #staff-list wholesale, which would blow away the focused input (caret + iPad keyboard);
// the typed value already survives in _priceDraft, so we just skip the rebuild until the
// field blurs and let the next sync/action catch the list up.
function priceInputFocused() {
  const el = document.activeElement;
  return !!(el && el.classList && el.classList.contains('staff-price-input'));
}

function renderLogin(errMsg) {
  document.getElementById('staff-login').classList.remove('hidden');
  document.getElementById('staff-main').classList.add('hidden');
  const connecting = !store.getState().connected && (cfg().staff || []).length === 0;
  const status = document.getElementById('staff-login-status');
  if (status) status.textContent = errMsg || (connecting ? 'Connecting…' : '');
}

function todayStats() {
  const today = todayStr();
  const lines = myHistory(queue(), records(), store.getState().deletions, myId).filter(l => l.date === today);
  return { total: lines.reduce((s, l) => s + l.cost, 0), count: lines.length };
}

function renderMain(meStaff) {
  if (_view === 'history' && !appPerm('history')) _view = 'active';   // feature switched off mid-session
  document.getElementById('staff-login').classList.add('hidden');
  document.getElementById('staff-main').classList.remove('hidden');
  document.getElementById('staff-tech-name').textContent = meStaff.name;
  const dot = document.getElementById('staff-conn');
  if (dot) dot.style.background = store.getState().connected ? '#2a7a4f' : '#e8730a';

  const st = todayStats();
  const activeCount = myActiveAssignments(queue(), myId).length;
  const tab = (id, label) => `<button onclick="staffTab('${id}')"
    class="flex-1 py-3 rounded-xl font-headline font-bold text-base transition-all ${_view === id ? 'bg-primary text-on-primary' : 'bg-surface-container text-on-surface-variant'}">${label}</button>`;

  const notifBanner = notifBannerHtml();

  const updateBanner = _updateVer ? `
    <button onclick="staffUpdateNow()" class="w-full mb-3 rounded-xl bg-secondary-container text-on-secondary-container py-3.5 font-headline font-bold text-sm flex items-center justify-center gap-2 active:scale-95 transition-all shadow-sm">
      <span class="material-symbols-outlined" style="font-size:20px">system_update</span> Update available (${_updateVer}) — tap to refresh
    </button>` : '';

  const needsPrice = queue().reduce((n, e) => isPaidStatus(e.status) ? n : n + (e.assignments || []).filter(a => a.techId === myId && a.status === 'complete' && a.awaitingPrice).length, 0);
  const needsPriceBanner = needsPrice ? `
    <button onclick="staffTab('active')" class="w-full mb-3 rounded-xl py-3 px-4 text-white font-headline font-bold text-sm flex items-center justify-center gap-2 active:scale-95 transition-all" style="background:#6b4fb0">
      <span class="material-symbols-outlined" style="font-size:19px">pending</span> ${needsPrice} service${needsPrice === 1 ? '' : 's'} need${needsPrice === 1 ? 's' : ''} a price
    </button>` : '';

  document.getElementById('staff-list').innerHTML = `
    ${updateBanner}${needsPriceBanner}${notifBanner}
    <div class="rounded-2xl bg-primary text-on-primary px-5 py-4 mb-3 flex items-end justify-between shadow-sm">
      <div><div class="text-xs font-body uppercase tracking-widest opacity-80">Today</div>
        <div class="font-headline font-extrabold leading-none" style="font-size:40px">$${st.total.toFixed(0)}</div></div>
      <div class="text-right font-body opacity-90"><div class="text-2xl font-headline font-bold leading-none">${st.count}</div>
        <div class="text-xs uppercase tracking-widest">${st.count === 1 ? 'service' : 'services'}</div></div>
    </div>
    <div class="flex gap-2 mb-3">${tab('active', `Now (${activeCount})`)}${tab('appts', 'Appts')}${appPerm('history') ? tab('history', 'History') : ''}</div>
    <div>${_view === 'active' ? renderActiveHtml() : _view === 'appts' ? renderApptsHtml() : renderHistoryHtml()}</div>`;
}

function renderActiveHtml() {
  const rows = myActiveAssignments(queue(), myId);
  if (rows.length === 0) {
    return `<div class="text-center text-on-surface-variant font-body py-16 px-6">
      <span class="material-symbols-outlined" style="font-size:52px;opacity:0.4">event_available</span>
      <div class="mt-3 text-xl font-headline font-bold">No one assigned to you</div>
      <div class="text-sm mt-1 text-outline-variant">A customer shows up here the moment the front desk assigns you.</div></div>`;
  }
  const byEntry = new Map();
  rows.forEach(({ entry, assignment }) => {
    if (!byEntry.has(entry.id)) byEntry.set(entry.id, { entry, items: [] });
    byEntry.get(entry.id).items.push(assignment);
  });
  // In-service customers first (the one being worked on draws focus).
  const cards = [...byEntry.values()].sort((a, b) => {
    const ai = a.items.some(x => x.status === 'inservice') ? 0 : 1;
    const bi = b.items.some(x => x.status === 'inservice') ? 0 : 1;
    return ai - bi;
  });
  return cards.map(({ entry, items }) => cardHtml(entry, items)).join('');
}

function cardHtml(entry, assignments) {
  const live = assignments.some(a => a.status === 'inservice');
  const ring = live ? 'border-primary' : 'border-surface-container-high';
  const note = (entry.txnNote || '').trim();
  const noteHtml = note ? `<div class="text-lg text-on-surface-variant mb-3 whitespace-pre-line">${esc(note)}</div>` : '';
  return `<div class="bg-surface-container-lowest rounded-2xl border-2 ${ring} p-4 mb-3 shadow-sm">
    <div class="font-headline font-extrabold text-2xl text-on-surface ${note ? 'mb-1' : 'mb-3'} leading-tight">${esc(entry.name || 'Guest')}</div>
    ${noteHtml}
    <div class="space-y-4">${assignments.map(a => lineHtml(entry, a)).join('')}</div>
  </div>`;
}

function lineHtml(entry, a) {
  const s = svc(a.serviceId);
  const label = s ? s.label : 'Service';
  const status = a.status || 'waiting';
  const key = entry.id + ':' + a.serviceId;
  const priceVal = (key in _priceDraft) ? _priceDraft[key] : (a.cost ? a.cost : '');
  const placeholder = (s && s.baseCost != null) ? Number(s.baseCost).toFixed(2) : '0.00';
  const btn = (txt, fn, primary) => `<button onclick="${fn}('${entry.id}','${esc(a.serviceId)}')"
    class="flex-1 py-4 rounded-xl font-headline font-bold text-lg transition-all active:scale-95 ${primary
      ? 'bg-primary hover:bg-primary-dim text-on-primary'
      : 'border-2 border-primary text-primary hover:bg-primary/10'}">${txt}</button>`;
  const awaiting = status === 'complete' && a.awaitingPrice;   // front desk marked done; tech owes the price
  const eff = awaiting ? 'awaiting' : status;
  const start    = status === 'waiting' ? btn('Start', 'staffStart', false) : '';
  const complete = (status === 'waiting' || status === 'inservice') ? btn('Complete', 'staffComplete', true) : '';
  const reopen   = (status === 'complete' && !awaiting) ? btn('Reopen', 'staffReopen', false) : '';
  const savePrice = awaiting ? `<button onclick="staffSavePrice('${entry.id}','${esc(a.serviceId)}')" class="flex-1 py-4 rounded-xl font-headline font-bold text-lg text-white transition-all active:scale-95" style="background:#6b4fb0">Save price</button>` : '';
  const stn = stationLbl(a.station);
  return `<div class="border-t border-surface-container-high pt-4 first:border-t-0 first:pt-0">
    <div class="flex items-center justify-between mb-3 gap-2">
      <div class="flex items-center gap-2 min-w-0">
        <span class="font-headline font-bold text-xl text-on-surface truncate">${esc(label)}</span>
        ${stn ? `<span class="flex-shrink-0 inline-flex items-center gap-1 text-sm font-headline font-bold text-primary bg-primary/10 rounded-lg px-2 py-0.5"><span class="material-symbols-outlined" style="font-size:15px">chair</span>${esc(stn)}</span>` : ''}
      </div>${statusChip(eff)}
    </div>
    ${awaiting ? `<div class="flex items-center gap-2 mb-3 rounded-xl px-3 py-2 text-sm font-body" style="background:rgba(107,79,176,.1);color:#534ab7"><span class="material-symbols-outlined" style="font-size:18px">info</span>Front desk marked this done — add the price.</div>` : ''}
    <div class="flex items-center gap-2 mb-3">
      <span class="text-on-surface-variant font-headline text-2xl">$</span>
      <input type="text" inputmode="decimal" value="${priceVal}" placeholder="${placeholder}"
        oninput="staffPriceInput('${entry.id}','${esc(a.serviceId)}',this.value)"
        class="staff-price-input flex-1 min-w-0 bg-surface-container border-2 rounded-xl px-4 py-3 text-3xl font-headline text-right focus:outline-none focus:border-primary ${awaiting ? '' : 'border-surface-container-high'}"${awaiting ? ' style="border-color:#6b4fb0"' : ''}>
      <button onclick="staffCalc('${entry.id}','${esc(a.serviceId)}')" title="Calculator"
        class="flex-shrink-0 w-14 h-14 flex items-center justify-center rounded-xl border-2 border-primary text-primary hover:bg-primary/10 active:scale-95 transition-all">
        <span class="material-symbols-outlined" style="font-size:26px">calculate</span>
      </button>
    </div>
    <div class="flex gap-2">${start}${reopen}${savePrice}${complete}</div>
  </div>`;
}

function renderHistoryHtml() {
  // Staff app keeps the last 30 days of history visible.
  const cutoff = new Date(); cutoff.setHours(0, 0, 0, 0); cutoff.setDate(cutoff.getDate() - 29);
  const lines = myHistory(queue(), records(), store.getState().deletions, myId)
    .filter(l => new Date(l.date + 'T12:00:00') >= cutoff);
  const dlBtn = appPerm('pdf') ? `<button onclick="staffDownloadTodayPdf()" class="w-full mb-3 rounded-xl bg-surface-container text-on-surface py-3 font-headline font-bold text-sm flex items-center justify-center gap-2 active:scale-95">
    <span class="material-symbols-outlined" style="font-size:18px">picture_as_pdf</span> Download today's transactions (PDF)</button>` : '';
  if (lines.length === 0) {
    return dlBtn + `<div class="text-center text-on-surface-variant font-body py-16 px-6">
      <span class="material-symbols-outlined" style="font-size:52px;opacity:0.4">history</span>
      <div class="mt-3 text-xl font-headline font-bold">No completed services yet</div>
      <div class="text-sm mt-1 text-outline-variant">Services you finish today show up here with your daily total.</div></div>`;
  }
  const byDate = {};
  lines.forEach(l => { (byDate[l.date] = byDate[l.date] || []).push(l); });
  const today = todayStr();
  return dlBtn + Object.keys(byDate).sort().reverse().map(date => {
    const items = byDate[date];
    const total = items.reduce((s, l) => s + l.cost, 0);
    const dateLabel = date === today ? 'Today' : new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const showNames = appPerm('histNames');
    const rowsHtml = items.map(l => `<div class="flex items-center justify-between py-2 border-t border-surface-container-high first:border-t-0">
      <div class="min-w-0"><div class="font-headline font-semibold text-on-surface truncate">${showNames ? esc(l.name) : 'Customer'}</div>
        <div class="text-sm font-body text-on-surface-variant truncate">${esc(svc(l.serviceId)?.label || 'Service')}</div></div>
      <div class="font-headline font-bold text-lg text-on-surface flex-shrink-0 ml-2">$${l.cost.toFixed(0)}${l.paid ? '' : ' <span class="text-xs text-outline-variant font-body">pending</span>'}</div>
    </div>`).join('');
    return `<div class="bg-surface-container-lowest rounded-2xl border border-surface-container-high p-4 mb-3">
      <div class="flex items-center justify-between mb-1">
        <span class="font-headline font-bold text-lg text-on-surface">${dateLabel}</span>
        <span class="font-headline font-extrabold text-xl text-primary">$${total.toFixed(0)} · ${items.length}</span>
      </div>${rowsHtml}</div>`;
  }).join('');
}

// ── My appointments (Google Calendar, read-only) ──────────────────────────────
// The tech's upcoming appointments, read straight from Google with a Worker-minted
// access token (/gcal/token) — plain REST, no gapi. The tech's calendar is found by
// the same rule the dashboard uses: Google calendar name == staff name
// (case-insensitive, trimmed). Cached 60s; refreshed when the tab is opened.
let _appts = null, _apptsAt = 0, _apptsLoading = false, _apptsErr = '';
const APPTS_TTL_MS = 60000, APPTS_DAYS = 7;
async function _gcalGet(url, token) {
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error('google_' + r.status);
  return r.json();
}
async function loadMyAppts(force) {
  const meStaff = me();
  if (_apptsLoading || !meStaff) return;
  if (!force && _apptsAt && Date.now() - _apptsAt < APPTS_TTL_MS) return;
  _apptsLoading = true;
  try {
    const tr = await fetch(GCAL_PROXY + '/token');
    if (!tr.ok) { _apptsErr = tr.status === 401 ? 'not_connected' : 'error'; _appts = _appts || []; return; }
    const token = (await tr.json()).access_token;
    const cl = await _gcalGet('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=owner&maxResults=100', token);
    const myName = (meStaff.name || '').trim().toLowerCase();
    const myCal = (cl.items || []).find(c => (c.summary || '').trim().toLowerCase() === myName);
    if (!myCal) { _apptsErr = 'nocal'; _appts = []; _apptsAt = Date.now(); return; }
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + APPTS_DAYS + 1);
    const q = new URLSearchParams({ timeMin: start.toISOString(), timeMax: end.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '150' });
    const evs = await _gcalGet(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(myCal.id)}/events?${q}`, token);
    // One row per BOOKING: events on my calendar sharing museGroupId (a party) collapse
    // into one, labelled by the primary guest — mirrors the dashboard's grid bubbles.
    const groups = new Map();
    (evs.items || []).forEach(ev => {
      if (!ev.start?.dateTime) return;   // skip all-day events
      const k = ev.extendedProperties?.private?.museGroupId || ('solo:' + ev.id);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(ev);
    });
    _appts = [...groups.values()].map(evsIn => {
      const priv = e => e.extendedProperties?.private || {};
      const first = evsIn[0];
      const startMs = +new Date(first.start.dateTime);
      const endMs = +new Date(first.end?.dateTime || (startMs + 3600000));
      const names = [...new Set(evsIn.map(e => priv(e).museName).filter(Boolean))];
      const name = priv(first).musePrimaryName || priv(first).museName || (first.summary || '').split(' — ')[0] || 'Guest';
      // Only the lines booked on MY calendar — a party can span techs.
      const myLines = evsIn.flatMap(e => { try { return JSON.parse(priv(e).museLines || '[]'); } catch { return []; } })
        .filter(l => l.calId === myCal.id && l.svcId);
      const services = [...new Set(myLines.map(l => svc(l.svcId)?.label).filter(Boolean))];
      if (!services.length) { const t = (first.summary || '').split(' — ')[1]; if (t) services.push(t); }   // non-app event fallback
      return {
        startMs, endMs, name, guests: Math.max(0, names.length - 1), services,
        notes: (first.description || '').trim(),
        confirmed: evsIn.some(e => priv(e).museConfirmed === '1'),
        noShow: evsIn.some(e => priv(e).museNoShow === '1'),
      };
    }).sort((a, b) => a.startMs - b.startMs);
    _apptsErr = ''; _apptsAt = Date.now();
  } catch { _apptsErr = 'error'; _appts = _appts || []; }
  finally { _apptsLoading = false; if (_view === 'appts' && !priceInputFocused()) render(); }
}
window.staffApptsRefresh = () => { loadMyAppts(true); showToast('Refreshing…'); };

function renderApptsHtml() {
  loadMyAppts();   // fire-and-forget — re-renders this tab when the load lands
  if (_appts === null) {
    return `<div class="text-center text-on-surface-variant font-body py-16 px-6">
      <span class="material-symbols-outlined" style="font-size:52px;opacity:0.4">event</span>
      <div class="mt-3 text-xl font-headline font-bold">Loading your appointments…</div></div>`;
  }
  let note = '';
  if (_apptsErr === 'not_connected') note = 'Google Calendar isn’t connected on the dashboard yet — ask the front desk.';
  else if (_apptsErr === 'nocal') note = `No Google calendar named “${esc(me()?.name || '')}” was found — ask the front desk to check that your calendar matches your staff name.`;
  else if (_apptsErr === 'error') note = 'Couldn’t reach Google Calendar — check your connection and tap Refresh.';
  const rows = _appts.filter(a => !a.noShow);
  const refreshBar = `<div class="flex items-center justify-between mb-3 px-1">
    <span class="text-xs font-body text-on-surface-variant">Today + next ${APPTS_DAYS} days${_apptsAt ? ' · updated ' + new Date(_apptsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''}</span>
    <button onclick="staffApptsRefresh()" class="text-sm font-headline font-bold text-primary flex items-center gap-1 active:scale-95">
      <span class="material-symbols-outlined" style="font-size:16px">refresh</span> Refresh</button></div>`;
  if (rows.length === 0) {
    return refreshBar + `<div class="text-center text-on-surface-variant font-body py-16 px-6">
      <span class="material-symbols-outlined" style="font-size:52px;opacity:0.4">event_upcoming</span>
      <div class="mt-3 text-xl font-headline font-bold">${note ? 'Appointments unavailable' : 'No upcoming appointments'}</div>
      <div class="text-sm mt-1 text-outline-variant">${esc(note) || 'New bookings for you show up here — and ping your phone when alerts are on.'}</div></div>`;
  }
  const errBanner = note ? `<div class="mb-3 rounded-xl px-4 py-3 text-sm font-body" style="background:#fdecea;color:#7a2a1a">${esc(note)} Showing the last loaded list.</div>` : '';
  const byDate = {};
  rows.forEach(a => { const d = localDateStr(new Date(a.startMs)); (byDate[d] = byDate[d] || []).push(a); });
  const today = todayStr();
  const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return localDateStr(d); })();
  const fmtT = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return refreshBar + errBanner + Object.keys(byDate).sort().map(date => {
    const items = byDate[date];
    const d = new Date(date + 'T12:00:00');
    const dayName = date === today ? 'Today' : date === tomorrow ? 'Tomorrow' : d.toLocaleDateString('en-US', { weekday: 'short' });
    const dayLabel = `${dayName} · ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    const rowsHtml = items.map(a => {
      const [t, ampm] = fmtT(a.startMs).split(' ');
      const dur = Math.max(5, Math.round((a.endMs - a.startMs) / 60000));
      const past = date === today && a.endMs < Date.now();
      return `<div class="flex gap-3 px-4 py-3 border-b border-surface-container-high last:border-0${past ? ' opacity-50' : ''}">
        <div class="flex-shrink-0 text-center w-16">
          <div class="font-headline font-extrabold text-lg leading-tight text-primary">${t}</div>
          <div class="text-[11px] font-body font-semibold text-outline">${ampm || ''} · ${dur}m</div></div>
        <div class="min-w-0 flex-1">
          <div class="font-headline font-bold text-lg leading-tight text-on-surface">${esc(a.name)}${a.guests ? ` <span class="text-xs font-body font-semibold text-outline">+${a.guests} guest${a.guests > 1 ? 's' : ''}</span>` : ''}</div>
          ${a.services.length ? `<div class="text-sm font-body text-on-surface-variant mt-0.5">${esc(a.services.join(' · '))}</div>` : ''}
          ${a.notes ? `<div class="text-xs font-body text-outline mt-1 whitespace-pre-line">📝 ${esc(a.notes)}</div>` : ''}</div>
        ${a.confirmed ? '<span class="self-start mt-1 text-[11px] font-body font-bold px-2 py-0.5 rounded-full flex-shrink-0" style="background:#2a7a4f;color:#fff">Confirmed</span>' : ''}
      </div>`;
    }).join('');
    return `<div class="mb-4">
      <div class="flex items-center justify-between mb-2 px-1">
        <span class="text-sm font-headline font-bold uppercase tracking-widest text-on-surface-variant">${dayLabel}</span>
        <span class="text-xs font-body font-semibold text-outline">${items.length} appointment${items.length > 1 ? 's' : ''}</span></div>
      <div class="bg-surface-container-lowest rounded-2xl border border-surface-container-high overflow-hidden">${rowsHtml}</div></div>`;
  }).join('');
}

// ── Today's transactions → printable PDF ──────────────────────────────────────
// Mirrors the dashboard's print-to-PDF approach (open an HTML doc + window.print);
// on iOS the print sheet offers "Save to Files" / share as PDF.
function buildStaffTodayHtml(techName, lines) {
  const dateLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const total = lines.reduce((s, l) => s + l.cost, 0);
  const logo = cfg().logo || '';
  const rows = lines.map(l => `<tr><td>${esc(svc(l.serviceId)?.label || 'Service')}</td><td>${esc(l.name)}</td><td>${l.paid ? 'Paid' : 'Pending'}</td><td style="text-align:right">$${l.cost.toFixed(2)}</td></tr>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Muse — ${esc(techName)} — ${dateLabel}</title><style>
    body{font-family:Arial,sans-serif;font-size:13px;color:#222;margin:24px}.h{display:flex;align-items:center;gap:14px;margin-bottom:6px}.logo{max-width:140px;max-height:52px;width:auto;height:auto;object-fit:contain;border-radius:8px;flex-shrink:0}
    h1{color:#1a5252;font-size:19px;margin:0 0 2px}.sub{color:#666;margin:0;font-size:12px}
    .tot{background:#1a5252;color:#fff;border-radius:10px;padding:12px 18px;display:inline-block;margin:14px 0 18px}.tot .v{font-size:26px;font-weight:800;line-height:1}.tot .l{font-size:11px;text-transform:uppercase;letter-spacing:.5px;opacity:.85}
    table{width:100%;border-collapse:collapse}th{background:#1a5252;color:#fff;padding:7px 9px;text-align:left;font-size:12px}td{padding:6px 9px;border-bottom:1px solid #e0e0e0;font-size:12px}tr:nth-child(even) td{background:#fafafa}
    .footer{margin-top:22px;font-size:10px;color:#999;text-align:center}
  </style></head><body>
    <div class="h">${logo ? `<img src="${esc(logo)}" class="logo" onerror="this.style.display='none'">` : ''}<div><h1>Muse Nails &amp; Spa</h1><p class="sub">${esc(techName)} · ${dateLabel}</p></div></div>
    <div class="tot"><div class="v">$${total.toFixed(2)}</div><div class="l">${lines.length} service${lines.length === 1 ? '' : 's'} today</div></div>
    <table><thead><tr><th>Service</th><th>Customer</th><th>Status</th><th style="text-align:right">Amount</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="footer">Generated ${new Date().toLocaleString()} · Muse Nails &amp; Spa</div></body></html>`;
}
window.staffDownloadTodayPdf = () => {
  if (!appPerm('pdf')) { showToast('PDF download is turned off for your account.'); return; }
  const today = todayStr();
  let lines = myHistory(queue(), records(), store.getState().deletions, myId).filter(l => l.date === today);
  if (!appPerm('histNames')) lines = lines.map(l => ({ ...l, name: 'Customer' }));
  if (!lines.length) { showToast('No transactions today yet.'); return; }
  const url = URL.createObjectURL(new Blob([buildStaffTodayHtml(me()?.name || 'Technician', lines)], { type: 'text/html' }));
  const win = window.open(url, '_blank');
  if (win) setTimeout(() => win.print(), 600);
  URL.revokeObjectURL(url);
  showToast('PDF opened — use Print → Save as PDF');
};

// ── Actions ───────────────────────────────────────
// 3c: send a per-assignment PATCH (not the whole entry). The DO + every device merge it into the
// CURRENT ticket, so a tech's Start/Complete/Reopen can't clobber a concurrent front-desk
// fee/item/discount edit that hasn't propagated to this device yet (the §14 clobber HIGH).
function updateAssignment(entryId, serviceId, newStatus, priced) {
  const src = queue().find(e => String(e.id) === String(entryId));
  if (!src) return;
  const a0 = (src.assignments || []).find(x => x.serviceId === serviceId && x.techId === myId);
  if (!a0) { showToast('That service is no longer assigned to you'); return; }
  const a = JSON.parse(JSON.stringify(a0));        // patch a clone of ONLY this assignment
  if (priced != null) a.cost = priced;
  if (priced != null && priced > 0) a.awaitingPrice = false;   // entering a real price resolves "Needs price"
  applyAssignmentStatus(a, newStatus);             // banks serviceMs / starts spell + stamps a.status & a.updatedAt
  sync.dispatch('queue.assignmentPatch', { entryId: String(entryId), serviceId, techId: myId, assignment: a });
}

window.staffPriceInput = (entryId, serviceId, val) => { _priceDraft[entryId + ':' + serviceId] = val; };

window.staffStart = (entryId, serviceId) => {
  const priced = parsePrice(_priceDraft[entryId + ':' + serviceId]);
  updateAssignment(entryId, serviceId, 'inservice', priced);
  showToast('Started');
};
window.staffComplete = (entryId, serviceId) => {
  const key = entryId + ':' + serviceId;
  const priced = parsePrice(_priceDraft[key]);
  // Require a real price before completing — a $0 service skews the tech's daily total and
  // the dashboard can't Pay it anyway (mirrors the dashboard's pay-time validation). The
  // effective price is the typed draft if present, else the cost already on the assignment.
  const existing = (queue().find(e => String(e.id) === String(entryId))?.assignments || [])
    .find(x => x.serviceId === serviceId && x.techId === myId);
  const effective = priced != null ? priced : parsePrice(existing?.cost);
  if (effective == null || effective <= 0) { showToast('Enter a price first'); return; }
  updateAssignment(entryId, serviceId, 'complete', priced);
  delete _priceDraft[key];
  showToast('Sent to front desk ✓');
};
window.staffReopen = (entryId, serviceId) => {
  updateAssignment(entryId, serviceId, 'inservice');
  showToast('Reopened');
};
// "Needs price": the front desk already marked this service done — the tech only owes the price.
// Keeps the service complete, sets the cost, clears the awaiting-price flag (unblocks checkout).
window.staffSavePrice = (entryId, serviceId) => {
  const key = entryId + ':' + serviceId;
  const priced = parsePrice(_priceDraft[key]);
  if (priced == null || priced <= 0) { showToast('Enter a price first'); return; }
  updateAssignment(entryId, serviceId, 'complete', priced);
  delete _priceDraft[key];
  showToast('Price sent ✓');
};
window.staffTab = (v) => { _view = (v === 'history' || v === 'appts') ? v : 'active'; render(); };

// ── Inline price calculator ───────────────────────
// Tap the calc button next to a service's price → a basic calculator. Pressing OK
// fills that service's price field with the result (via _priceDraft). Lives in a
// separate modal so the list re-rendering on sync never closes it. No eval(): a tiny
// tokenizer evaluates + − × ÷ with normal precedence (× ÷ before + −).
let _calcExpr = '';
let _calcTarget = null;   // { entryId, serviceId, key }
const _CALC_OPS = '+−×÷';
function _calcEval(expr) {
  if (!expr) return null;
  const toks = []; let num = '';
  for (const ch of expr) {
    if ((ch >= '0' && ch <= '9') || ch === '.') { num += ch; continue; }
    if (_CALC_OPS.includes(ch)) {
      if (num !== '') { toks.push(parseFloat(num)); num = ''; }
      toks.push(ch === '×' ? '*' : ch === '÷' ? '/' : ch === '−' ? '-' : '+');
    }
  }
  if (num !== '') toks.push(parseFloat(num));
  while (toks.length && typeof toks[toks.length - 1] === 'string') toks.pop();   // drop a trailing operator
  if (!toks.length) return null;
  if (typeof toks[0] === 'string') toks.unshift(0);                              // leading − → 0 − x
  const p1 = [toks[0]];                                                          // first pass: × ÷
  for (let i = 1; i < toks.length; i += 2) {
    const op = toks[i], v = toks[i + 1]; if (v == null) break;
    if (op === '*') p1[p1.length - 1] *= v;
    else if (op === '/') p1[p1.length - 1] = v === 0 ? NaN : p1[p1.length - 1] / v;
    else p1.push(op, v);
  }
  let res = p1[0];                                                               // second pass: + −
  for (let i = 1; i < p1.length; i += 2) { const op = p1[i], v = p1[i + 1]; if (op === '+') res += v; else if (op === '-') res -= v; }
  return isFinite(res) ? res : null;
}
function _calcKeysHtml() {
  const keys = [
    { k: 'C', t: 'clear' }, { k: '⌫', t: 'op' }, { k: '÷', t: 'op' }, { k: '×', t: 'op' },
    { k: '7', t: 'n' }, { k: '8', t: 'n' }, { k: '9', t: 'n' }, { k: '−', t: 'op' },
    { k: '4', t: 'n' }, { k: '5', t: 'n' }, { k: '6', t: 'n' }, { k: '+', t: 'op' },
    { k: '1', t: 'n' }, { k: '2', t: 'n' }, { k: '3', t: 'n' }, { k: '.', t: 'n' },
    { k: '0', t: 'n0' },
  ];
  const cls = t => t === 'clear' ? 'bg-error-container text-on-primary'
    : t === 'op' ? 'bg-surface-container-high text-primary'
    : 'bg-surface-container text-on-surface';
  return keys.map(({ k, t }) => `<button onclick="staffCalcKey('${k}')" class="${t === 'n0' ? 'col-span-4 ' : ''}${cls(t)} py-4 rounded-xl font-headline font-bold text-2xl active:scale-95 transition-transform">${k}</button>`).join('');
}
function _renderCalc() {
  const exprEl = document.getElementById('staff-calc-expr'), resEl = document.getElementById('staff-calc-res');
  if (exprEl) exprEl.textContent = _calcExpr || '0';
  const r = _calcExpr ? _calcEval(_calcExpr) : null;
  if (resEl) resEl.textContent = r != null ? '= $' + (Math.round(r * 100) / 100).toFixed(2) : '';
}
window.staffCalc = (entryId, serviceId) => {
  const key = entryId + ':' + serviceId;
  _calcTarget = { entryId, serviceId, key };
  const cur = (key in _priceDraft) ? _priceDraft[key] : '';
  _calcExpr = /^\d+(\.\d+)?$/.test(String(cur).trim()) ? String(cur).trim() : '';   // seed with the current price so techs can add to it
  const keysEl = document.getElementById('staff-calc-keys'); if (keysEl) keysEl.innerHTML = _calcKeysHtml();
  _renderCalc();
  const m = document.getElementById('staff-calc-modal'); if (m) { m.classList.remove('hidden'); m.style.display = 'flex'; }
};
window.staffCalcKey = (k) => {
  const last = _calcExpr.slice(-1);
  if (k === 'C') _calcExpr = '';
  else if (k === '⌫') _calcExpr = _calcExpr.slice(0, -1);
  else if (_CALC_OPS.includes(k)) {
    if (!_calcExpr) return;                                          // no leading operator
    _calcExpr = _CALC_OPS.includes(last) ? _calcExpr.slice(0, -1) + k : _calcExpr + k;   // replace a trailing operator
  } else if (k === '.') {
    const curNum = _calcExpr.split(/[+−×÷]/).pop();
    if (curNum.includes('.')) return;                               // one decimal point per number
    _calcExpr += (_calcExpr === '' || _CALC_OPS.includes(last)) ? '0.' : '.';
  } else _calcExpr += k;                                            // digit
  _renderCalc();
};
window.staffCalcOk = () => {
  const r = _calcEval(_calcExpr);
  if (r == null) { showToast('Enter an amount'); return; }
  const val = Math.round(r * 100) / 100;
  const out = Number.isInteger(val) ? String(val) : val.toFixed(2);
  if (_calcTarget) _priceDraft[_calcTarget.key] = out;
  window.staffCalcClose();
  render();
  showToast('Amount set to $' + out);
};
window.staffCalcClose = () => { const m = document.getElementById('staff-calc-modal'); if (m) { m.classList.add('hidden'); m.style.display = ''; } };

window.staffPinSubmit = async () => {
  const input = document.getElementById('staff-pin-entry');
  const pin = (input?.value || '').trim();
  if ((cfg().staff || []).length === 0 && (cfg().fd_users || []).length === 0) {
    // Fresh browser (no synced data yet): the server owns the PIN check (§13) —
    // it returns who this is AND mints the session that unlocks the snapshot.
    if (!/^\d{4,8}$/.test(pin)) { renderLogin('Connecting… try again in a moment'); return; }
    renderLogin('Signing in…');
    const res = await serverLogin({ pin, device: 'staff-app' });
    if (input) input.value = '';
    if (res.ok) {
      if (res.user.kind === 'tech') { myId = res.user.id; myFdId = null; localStorage.setItem(MY_KEY, myId); localStorage.removeItem(MY_FD_KEY); }
      else { myFdId = res.user.id; myId = null; localStorage.setItem(MY_FD_KEY, myFdId); localStorage.removeItem(MY_KEY); }
      _appts = null; _apptsAt = 0; _apptsErr = '';
      sync.resync();                                   // reconnect with the session → snapshot arrives
      render();
      registerPush();   // tech OR front-desk → subscribe for assignment + chat pushes
      return;
    }
    renderLogin(res.error === 'slow_down' || res.retryInSec ? `Too many tries — wait ${res.retryInSec || 5}s`
      : res.error === 'offline' ? 'Connecting… try again in a moment' : 'Incorrect PIN');
    return;
  }
  const match = staffByPin(cfg().staff, cfg().inactive_staff, pin);
  if (match) {
    myId = match.id; myFdId = null; localStorage.setItem(MY_KEY, myId); localStorage.removeItem(MY_FD_KEY);
    _appts = null; _apptsAt = 0; _apptsErr = '';   // never show another tech's cached appointments
    if (input) input.value = ''; render();
    registerPush();   // re-tag this device's push subscription to the signed-in tech (no-op if alerts off)
    serverLogin({ pin, userId: match.id, device: 'staff-app' }).then(r => { if (r.ok) sync.resync(); });   // §13 session mint/refresh
    return;
  }
  const fd = fdByPin(pin);   // front-desk user → read-only schedule/hours view
  if (fd) {
    myFdId = fd.id; myId = null; localStorage.setItem(MY_FD_KEY, myFdId); localStorage.removeItem(MY_KEY);
    if (input) input.value = ''; render();
    registerPush();   // subscribe this device for the fd user's chat pushes (no-op if alerts off)
    serverLogin({ pin, userId: fd.id, device: 'staff-app' }).then(r => { if (r.ok) sync.resync(); });   // §13 session mint/refresh
    return;
  }
  if (input) input.value = ''; renderLogin('Incorrect PIN');
};
window.staffPinKey = (ev) => { if (ev.key === 'Enter') window.staffPinSubmit(); };
// Auto-login as soon as a correct PIN is fully entered (no Enter needed) — but wait if
// the typed PIN is a prefix of a longer staff PIN (ambiguous), to avoid logging in early.
window.staffPinInput = () => {
  const pin = (document.getElementById('staff-pin-entry')?.value || '').trim();
  if (!pin) return;
  if (!staffByPin(cfg().staff, cfg().inactive_staff, pin) && !fdByPin(pin)) return;
  const inactive = new Set(cfg().inactive_staff || []);
  const ambiguous = (cfg().staff || []).some(s => s.pin && !inactive.has(s.id) && String(s.pin) !== pin && String(s.pin).startsWith(pin))
    || (cfg().fd_users || []).some(u => u.pin && String(u.pin) !== pin && String(u.pin).startsWith(pin));
  if (!ambiguous) window.staffPinSubmit();
};
window.staffSwitch = () => { unregisterPush(); localStorage.removeItem(MY_KEY); localStorage.removeItem(MY_FD_KEY); myId = null; myFdId = null; _appts = null; _apptsAt = 0; _apptsErr = ''; render(); };
window.staffLogout = window.staffSwitch;

// ── Push notifications (assignment alerts) ────────
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
const isStandalone  = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
const isIOS         = () => /iphone|ipad|ipod/i.test(navigator.userAgent || '');
function urlB64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const s = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(s), arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
window.enableStaffPush = async () => {
  if (!pushSupported()) { showToast("This device/browser can't do notifications"); return; }
  if (isIOS() && !isStandalone()) { showToast('iPhone: tap Share → “Add to Home Screen”, open that app, then turn on alerts'); return; }
  // Already blocked → the OS won't re-prompt; the only fix is the phone/browser settings.
  if (Notification.permission === 'denied') { showToast('Notifications are blocked for this app — turn them on in your phone’s Settings, then try again'); return; }
  let perm;
  try { perm = await Notification.requestPermission(); }
  catch (e) { showToast('Couldn’t ask for permission — reopen the app and try again'); return; }
  if (perm !== 'granted') { showToast(perm === 'denied' ? 'You tapped Don’t Allow — enable it in Settings to get alerts' : 'Notifications not turned on'); return; }
  try { const ok = await registerPush(); showToast(ok ? 'Notifications on ✓' : 'Allowed — but couldn’t reach the server to finish. Check the connection and try again.'); if (ok) render(); }
  catch (e) { showToast('Allowed, but couldn’t finish setup — try once more'); }
};
// Push ids this device should be reachable at: a tech gets the legacy raw techId
// (assignment alerts) AND the 'tech:<id>' person pid (chat); a front-desk user gets
// the 'fd:<id>' pid (chat). One browser subscription, registered under each id.
function myPushIds() {
  if (myId)   return [myId, 'tech:' + myId];
  if (myFdId) return ['fd:' + myFdId];
  return [];
}
const _pushUnsub = async (sub, id) => { try { await fetch(PUSH_PROXY + '/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ techId: id, endpoint: sub.endpoint }) }); } catch {} };
// Subscribe this device under the signed-in person's ids. No-ops unless permission is
// granted + someone is signed in. Drops any previously-tagged ids no longer in use.
async function registerPush() {
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  const ids = myPushIds(); if (!ids.length) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(VAPID_PUBLIC_KEY) });
    let prev = []; try { prev = JSON.parse(localStorage.getItem('turndesk_push_ids') || 'null') || []; } catch {}
    const legacy = localStorage.getItem('turndesk_push_techid'); if (legacy) prev.push(legacy);   // migrate the old single-id key
    for (const p of prev) if (!ids.includes(p)) await _pushUnsub(sub, p);   // device switched person → drop stale links
    // Register the browser subscription under each id; report whether the SERVER accepted it
    // (a silent failure here is exactly why "push doesn't work" was hard to see).
    const oks = await Promise.all(ids.map(id => fetch(PUSH_PROXY + '/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ techId: id, subscription: sub.toJSON() }) }).then(r => r.ok).catch(() => false)));
    localStorage.setItem('turndesk_push_ids', JSON.stringify(ids));
    localStorage.removeItem('turndesk_push_techid');
    return oks.some(Boolean);
  } catch { return false; }
}
// On logout, drop the server-side links for this device's tagged ids so it stops
// receiving that person's alerts. The browser push subscription itself is left intact
// (the next sign-in re-tags it via registerPush — no re-prompt).
async function unregisterPush() {
  let ids = []; try { ids = JSON.parse(localStorage.getItem('turndesk_push_ids') || 'null') || []; } catch {}
  const legacy = localStorage.getItem('turndesk_push_techid'); if (legacy) ids.push(legacy);
  if (!ids.length || !pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await Promise.all(ids.map(id => _pushUnsub(sub, id)));
    localStorage.removeItem('turndesk_push_ids'); localStorage.removeItem('turndesk_push_techid');
  } catch {}
}

// ── App-update prompt ─────────────────────────────
// iOS keeps a home-screen PWA suspended in memory, so it rarely cold-reloads to pick
// up a new deploy. We poll version.json (no-store → bypasses the SW) and, when a newer
// version is published, show a tap-to-update banner. Tapping clears the cache + SW and
// reloads to the freshest files (no data touched — all state lives in the Durable Object).
async function checkStaffVersion() {
  try {
    const res = await fetch('/turndesk/version.json?_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (data.version && data.version !== APP_VERSION && _updateVer !== data.version) {
      _updateVer = data.version;
      render();                       // keep the in-list banner
      showUpdatePopup(data.version);  // …plus a prominent prompt so it isn't missed
    }
  } catch (e) {}
}
window.staffUpdateNow = () => { showToast('Updating…'); hardReloadApp(); };

// ── Boot ──────────────────────────────────────────
function boot() {
  sync.start();
  store.subscribe(() => { chat.onChatSync(); if (priceInputFocused()) return; render(); });
  render();   // instant render from cached state; subscribe re-renders on hydrate
  chat.onChatSync();   // baseline the chat unread badge from cache on load
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/turndesk/sw.js').then(() => registerPush()).catch(() => {});
  checkStaffVersion();   // on cold start
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkStaffVersion(); chat.updateChatBadge(); } });   // re-check + recompute the chat badge (clears a stale count) on reopen
  setInterval(() => { if (!document.hidden) checkStaffVersion(); }, 20 * 60 * 1000);   // and poll so an always-open app self-updates
}
// Only boot inside the real page (the login shell exists); skipped when imported
// by the Node test runner (the global shim's getElementById returns null).
if (typeof document !== 'undefined' && document.getElementById && document.getElementById('staff-login')) boot();
