// ── Appointment reminders ───────────────────────────────────────────────────
// Floating top-center banners that fire a configurable lead time before each upcoming
// Google-Calendar appointment, persist until the operator taps OK, and never block the app
// (the container is pointer-events:none; only the OK button is interactive). Appointments come
// from the connected calendar (calendar.js apptsForReminders), so reminders only fire when
// Google Calendar is signed in + synced. Lead-time choice is a synced setting; the "already
// fired" set is device-local and resets each day.
import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { getActiveUser } from '../session.js';

const cfg = () => getState().config;
const ALL_LEADS = [5, 15, 30, 60];           // minutes offered in the settings menu
const FIRED_KEY = 'turndesk_appt_reminded';      // device-local; { day, keys[] }
const _esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function reminderLeads() {
  const v = cfg().appt_reminder_leads;
  return Array.isArray(v) ? ALL_LEADS.filter(n => v.includes(n)) : [30];   // default: 30 min only
}
const _today = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
function firedSet() {
  try { const r = JSON.parse(localStorage.getItem(FIRED_KEY) || 'null'); if (r && r.day === _today()) return new Set(r.keys || []); } catch (e) {}
  return new Set();
}
function saveFired(set) { try { localStorage.setItem(FIRED_KEY, JSON.stringify({ day: _today(), keys: [...set] })); } catch (e) {} }
const _leadLabel = L => (L >= 60 ? (L / 60) + ' hr' : L + ' min');
const _fmtTime = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

let _timer = null;
export function startApptReminders() {
  if (_timer) clearInterval(_timer);
  checkApptReminders();
  _timer = setInterval(checkApptReminders, 30000);   // every 30s
}

export function checkApptReminders() {
  if (!getActiveUser()) return;                       // only when a staff member is logged in
  const leads = reminderLeads(); if (!leads.length) return;
  const appts = (window.apptsForReminders ? window.apptsForReminders() : []);
  if (!appts.length) return;
  const now = Date.now();
  const fired = firedSet(); let changed = false;
  appts.forEach(a => {
    if (!(a.startMs > now)) return;                   // already started / past
    leads.forEach(L => {
      const key = a.id + '@' + L;
      // fire once when we're inside the lead window (catches up if the app opened mid-window)
      if (now >= a.startMs - L * 60000 && now < a.startMs && !fired.has(key)) {
        fired.add(key); changed = true;
        showApptBanner(a, L);
      }
    });
  });
  if (changed) saveFired(fired);
}

function showApptBanner(a, L) {
  const host = document.getElementById('appt-reminder-banners'); if (!host) return;
  const el = document.createElement('div');
  el.style.cssText = 'pointer-events:auto;display:flex;align-items:center;gap:12px;background:#1a5252;color:#fff;border-radius:12px;padding:10px 14px;box-shadow:0 6px 24px rgba(0,0,0,.28);max-width:96vw;font-family:Inter,sans-serif';
  el.innerHTML = `<span class="material-symbols-outlined" style="font-size:22px;flex-shrink:0">notifications_active</span>`
    + `<div style="min-width:0"><div style="font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_esc(a.name)} — appointment in ${_leadLabel(L)}</div>`
    + `<div style="font-size:12px;opacity:.85">Starts ${_fmtTime(a.startMs)}</div></div>`
    + `<button style="flex-shrink:0;background:#fff;color:#1a5252;border:none;border-radius:8px;padding:7px 16px;font-weight:700;font-size:13px;cursor:pointer">OK</button>`;
  el.querySelector('button').onclick = () => el.remove();
  host.appendChild(el);
}

// ── Settings: lead-time toggles (rendered into #appt-reminder-settings) ──────────
export function renderApptReminderSettings() {
  const host = document.getElementById('appt-reminder-settings'); if (!host) return;
  const on = reminderLeads();
  host.innerHTML = ALL_LEADS.map(L => {
    const active = on.includes(L);
    return `<button onclick="toggleApptReminderLead(${L})" class="px-3 py-1.5 rounded-full text-xs font-body font-semibold border transition-all" style="${active ? 'background:#1a5252;color:#fff;border-color:#1a5252' : 'background:transparent;border-color:var(--outline-variant,#7a858a);color:var(--on-surface,#0e1a1a)'}">${_leadLabel(L)} before</button>`;
  }).join('');
}
export function toggleApptReminderLead(L) {
  const cur = new Set(reminderLeads());
  if (cur.has(L)) cur.delete(L); else cur.add(L);
  dispatch('config.set', { key: 'appt_reminder_leads', value: ALL_LEADS.filter(x => cur.has(x)) });
  renderApptReminderSettings();
}
