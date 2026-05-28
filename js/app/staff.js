// ── TurnDesk Staff — minimal technician app ─────────────────────────────────────
// A SEPARATE page (staff.html) that reuses the dashboard's Durable Object sync
// (store + sync) but shows ONLY the logged-in tech's assigned services. The tech
// can Start the service, enter a price, and mark it Complete — pushed back to the
// dashboard via the same queue.upsert mutation. The front desk still owns "Paid".
//
// It never renders the dashboard, reports, settings, or other customers. (UI-level
// separation only — the open transport still sends full state; true per-tech
// isolation is the server-auth item, intentionally out of scope here.)
import * as store from './store.js';
import * as sync from './sync.js';
import { showToast, localDateStr, todayStr } from './utils.js';
import { applyEntryStatus, isPaidStatus } from './features/status.js';
import { VAPID_PUBLIC_KEY, PUSH_PROXY } from './config.js';

const cfg     = () => store.getState().config;
const queue   = () => store.getState().queue;
const records = () => store.getState().records;
const svc     = id => (cfg().services || []).find(s => s.id === id);

const MY_KEY = 'turndesk_staff_id';            // device-local: which tech is signed in on THIS device
let myId = localStorage.getItem(MY_KEY) || null;
let _view = 'active';                      // 'active' | 'history'
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
// This tech's COMPLETED work (complete + paid), merging the live queue with stored
// records (queue wins by id), excluding deletions — same source/rule as the
// dashboard turns "billed today", so the tech's totals match the front desk.
// Returns { name, serviceId, cost, date, time, paid } lines, newest first.
export function myHistory(queueArr, recordsArr, deletions, techId) {
  if (!techId) return [];
  const deleted = new Set((deletions || []).map(String));
  (recordsArr || []).forEach(r => { if (r.status === 'deleted') deleted.add(String(r.id)); });
  const liveIds = new Set(), src = [];
  (queueArr || []).forEach(e => { if (deleted.has(String(e.id))) return; liveIds.add(String(e.id)); src.push(e); });
  (recordsArr || []).forEach(r => { if (r.status === 'deleted' || deleted.has(String(r.id)) || liveIds.has(String(r.id))) return; src.push(r); });
  const lines = [];
  src.forEach(rec => (rec.assignments || []).forEach(a => {
    if (a.techId !== techId) return;
    const st = a.status || 'waiting';
    if (st !== 'complete' && !isPaidStatus(st)) return;
    const when = rec.checkinTime || rec.completedAt;
    lines.push({ name: rec.name || 'Guest', serviceId: a.serviceId, cost: a.cost || 0, date: localDateStr(new Date(when)), time: rec.completedAt || when, paid: isPaidStatus(st) });
  }));
  return lines.sort((a, b) => new Date(b.time) - new Date(a.time));
}

const me = () => (cfg().staff || []).find(s => s.id === myId) || null;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
function parsePrice(v) { if (v == null || String(v).trim() === '') return null; const n = parseFloat(v); return (isFinite(n) && n >= 0) ? n : null; }

const STATUS_CHIP = {
  waiting:   { bg:'#ffe0c2', fg:'#6d3200', label:'Waiting'    },
  inservice: { bg:'#c8e6c5', fg:'#1b5e20', label:'In Service' },
  complete:  { bg:'#cfe3ef', fg:'#0a3a52', label:'Complete'   },
  paid:      { bg:'#dde2e5', fg:'#555555', label:'Paid'        },
};
function statusChip(status) {
  const c = STATUS_CHIP[status] || STATUS_CHIP.waiting;
  return `<span class="text-[11px] font-body font-bold px-2 py-0.5 rounded-full" style="background:${c.bg};color:${c.fg}">${c.label}</span>`;
}

// ── Render ────────────────────────────────────────
function render() {
  const meStaff = me();
  if (!meStaff) return renderLogin();
  renderMain(meStaff);
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
  document.getElementById('staff-login').classList.add('hidden');
  document.getElementById('staff-main').classList.remove('hidden');
  document.getElementById('staff-tech-name').textContent = meStaff.name;
  const dot = document.getElementById('staff-conn');
  if (dot) dot.style.background = store.getState().connected ? '#2a7a4f' : '#e8730a';

  const st = todayStats();
  const activeCount = myActiveAssignments(queue(), myId).length;
  const tab = (id, label) => `<button onclick="staffTab('${id}')"
    class="flex-1 py-3 rounded-xl font-headline font-bold text-base transition-all ${_view === id ? 'bg-primary text-on-primary' : 'bg-surface-container text-on-surface-variant'}">${label}</button>`;

  const notifBanner = (pushSupported() && Notification.permission !== 'granted') ? `
    <button onclick="enableStaffPush()" class="w-full mb-3 rounded-xl border-2 border-primary text-primary py-3 font-headline font-bold text-sm flex items-center justify-center gap-2 hover:bg-primary/10 transition-colors">
      <span class="material-symbols-outlined" style="font-size:18px">notifications_active</span> Turn on assignment alerts
    </button>` : '';

  document.getElementById('staff-list').innerHTML = `
    ${notifBanner}
    <div class="rounded-2xl bg-primary text-on-primary px-5 py-4 mb-3 flex items-end justify-between shadow-sm">
      <div><div class="text-xs font-body uppercase tracking-widest opacity-80">Today</div>
        <div class="font-headline font-extrabold leading-none" style="font-size:40px">$${st.total.toFixed(0)}</div></div>
      <div class="text-right font-body opacity-90"><div class="text-2xl font-headline font-bold leading-none">${st.count}</div>
        <div class="text-xs uppercase tracking-widest">${st.count === 1 ? 'service' : 'services'}</div></div>
    </div>
    <div class="flex gap-2 mb-3">${tab('active', `Now (${activeCount})`)}${tab('history', 'History')}</div>
    <div>${_view === 'active' ? renderActiveHtml() : renderHistoryHtml()}</div>`;
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
  const start    = status === 'waiting' ? btn('Start', 'staffStart', false) : '';
  const complete = (status === 'waiting' || status === 'inservice') ? btn('Complete', 'staffComplete', true) : '';
  const reopen   = status === 'complete' ? btn('Reopen', 'staffReopen', false) : '';
  return `<div class="border-t border-surface-container-high pt-4 first:border-t-0 first:pt-0">
    <div class="flex items-center justify-between mb-3">
      <span class="font-headline font-bold text-xl text-on-surface">${esc(label)}</span>${statusChip(status)}
    </div>
    <div class="flex items-center gap-2 mb-3">
      <span class="text-on-surface-variant font-headline text-2xl">$</span>
      <input type="text" inputmode="decimal" value="${priceVal}" placeholder="${placeholder}"
        oninput="staffPriceInput('${entry.id}','${esc(a.serviceId)}',this.value)"
        class="w-40 bg-surface-container border-2 border-surface-container-high rounded-xl px-4 py-3 text-3xl font-headline text-right focus:outline-none focus:border-primary">
    </div>
    <div class="flex gap-2">${start}${reopen}${complete}</div>
  </div>`;
}

function renderHistoryHtml() {
  // Staff app keeps the last 30 days of history visible.
  const cutoff = new Date(); cutoff.setHours(0, 0, 0, 0); cutoff.setDate(cutoff.getDate() - 29);
  const lines = myHistory(queue(), records(), store.getState().deletions, myId)
    .filter(l => new Date(l.date + 'T12:00:00') >= cutoff);
  const dlBtn = `<button onclick="staffDownloadTodayPdf()" class="w-full mb-3 rounded-xl bg-surface-container text-on-surface py-3 font-headline font-bold text-sm flex items-center justify-center gap-2 active:scale-95">
    <span class="material-symbols-outlined" style="font-size:18px">picture_as_pdf</span> Download today's transactions (PDF)</button>`;
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
    const rowsHtml = items.map(l => `<div class="flex items-center justify-between py-2 border-t border-surface-container-high first:border-t-0">
      <div class="min-w-0"><div class="font-headline font-semibold text-on-surface truncate">${esc(l.name)}</div>
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

// ── Today's transactions → printable PDF ──────────────────────────────────────
// Mirrors the dashboard's print-to-PDF approach (open an HTML doc + window.print);
// on iOS the print sheet offers "Save to Files" / share as PDF.
function buildStaffTodayHtml(techName, lines) {
  const dateLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const total = lines.reduce((s, l) => s + l.cost, 0);
  const logo = cfg().logo || '';
  const rows = lines.map(l => `<tr><td>${esc(svc(l.serviceId)?.label || 'Service')}</td><td>${esc(l.name)}</td><td>${l.paid ? 'Paid' : 'Pending'}</td><td style="text-align:right">$${l.cost.toFixed(2)}</td></tr>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>TurnDesk — ${esc(techName)} — ${dateLabel}</title><style>
    body{font-family:Arial,sans-serif;font-size:13px;color:#222;margin:24px}.h{display:flex;align-items:center;gap:14px;margin-bottom:6px}.logo{max-width:140px;max-height:52px;width:auto;height:auto;object-fit:contain;border-radius:8px;flex-shrink:0}
    h1{color:#1a5252;font-size:19px;margin:0 0 2px}.sub{color:#666;margin:0;font-size:12px}
    .tot{background:#1a5252;color:#fff;border-radius:10px;padding:12px 18px;display:inline-block;margin:14px 0 18px}.tot .v{font-size:26px;font-weight:800;line-height:1}.tot .l{font-size:11px;text-transform:uppercase;letter-spacing:.5px;opacity:.85}
    table{width:100%;border-collapse:collapse}th{background:#1a5252;color:#fff;padding:7px 9px;text-align:left;font-size:12px}td{padding:6px 9px;border-bottom:1px solid #e0e0e0;font-size:12px}tr:nth-child(even) td{background:#fafafa}
    .footer{margin-top:22px;font-size:10px;color:#999;text-align:center}
  </style></head><body>
    <div class="h">${logo ? `<img src="${logo}" class="logo" onerror="this.style.display='none'">` : ''}<div><h1>TurnDesk</h1><p class="sub">${esc(techName)} · ${dateLabel}</p></div></div>
    <div class="tot"><div class="v">$${total.toFixed(2)}</div><div class="l">${lines.length} service${lines.length === 1 ? '' : 's'} today</div></div>
    <table><thead><tr><th>Service</th><th>Customer</th><th>Status</th><th style="text-align:right">Amount</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="footer">Generated ${new Date().toLocaleString()} · TurnDesk</div></body></html>`;
}
window.staffDownloadTodayPdf = () => {
  const today = todayStr();
  const lines = myHistory(queue(), records(), store.getState().deletions, myId).filter(l => l.date === today);
  if (!lines.length) { showToast('No transactions today yet.'); return; }
  const url = URL.createObjectURL(new Blob([buildStaffTodayHtml(me()?.name || 'Technician', lines)], { type: 'text/html' }));
  const win = window.open(url, '_blank');
  if (win) setTimeout(() => win.print(), 600);
  URL.revokeObjectURL(url);
  showToast('PDF opened — use Print → Save as PDF');
};

// ── Actions ───────────────────────────────────────
function updateAssignment(entryId, serviceId, mut) {
  const src = queue().find(e => String(e.id) === String(entryId));
  if (!src) return;
  const entry = JSON.parse(JSON.stringify(src));   // clone so the optimistic dispatch is the only writer
  const a = (entry.assignments || []).find(x => x.serviceId === serviceId && x.techId === myId);
  if (!a) { showToast('That service is no longer assigned to you'); return; }
  mut(a);
  applyEntryStatus(entry);                          // sets status + stamps statusSince (per-status timer)
  sync.dispatch('queue.upsert', { entry });        // optimistic local apply → subscribe re-renders
}

window.staffPriceInput = (entryId, serviceId, val) => { _priceDraft[entryId + ':' + serviceId] = val; };

window.staffStart = (entryId, serviceId) => {
  const priced = parsePrice(_priceDraft[entryId + ':' + serviceId]);
  updateAssignment(entryId, serviceId, a => { a.status = 'inservice'; if (priced != null) a.cost = priced; });
  showToast('Started');
};
window.staffComplete = (entryId, serviceId) => {
  const key = entryId + ':' + serviceId;
  const priced = parsePrice(_priceDraft[key]);
  updateAssignment(entryId, serviceId, a => { a.status = 'complete'; if (priced != null) a.cost = priced; });
  delete _priceDraft[key];
  showToast('Sent to front desk ✓');
};
window.staffReopen = (entryId, serviceId) => {
  updateAssignment(entryId, serviceId, a => { a.status = 'inservice'; });
  showToast('Reopened');
};
window.staffTab = (v) => { _view = (v === 'history' ? 'history' : 'active'); render(); };

window.staffPinSubmit = () => {
  const input = document.getElementById('staff-pin-entry');
  const pin = (input?.value || '').trim();
  if ((cfg().staff || []).length === 0) { renderLogin('Connecting… try again in a moment'); return; }
  const match = staffByPin(cfg().staff, cfg().inactive_staff, pin);
  if (!match) { if (input) input.value = ''; renderLogin('Incorrect PIN'); return; }
  myId = match.id; localStorage.setItem(MY_KEY, myId);
  if (input) input.value = '';
  render();
  registerPush();   // re-tag this device's push subscription to the signed-in tech (no-op if alerts off)
};
window.staffPinKey = (ev) => { if (ev.key === 'Enter') window.staffPinSubmit(); };
// Auto-login as soon as a correct PIN is fully entered (no Enter needed) — but wait if
// the typed PIN is a prefix of a longer staff PIN (ambiguous), to avoid logging in early.
window.staffPinInput = () => {
  const pin = (document.getElementById('staff-pin-entry')?.value || '').trim();
  if (!pin) return;
  if (!staffByPin(cfg().staff, cfg().inactive_staff, pin)) return;
  const inactive = new Set(cfg().inactive_staff || []);
  const ambiguous = (cfg().staff || []).some(s => s.pin && !inactive.has(s.id) && String(s.pin) !== pin && String(s.pin).startsWith(pin));
  if (!ambiguous) window.staffPinSubmit();
};
window.staffSwitch = () => { localStorage.removeItem(MY_KEY); myId = null; render(); };
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
  if (!pushSupported()) { showToast("Notifications aren't supported on this device"); return; }
  if (isIOS() && !isStandalone()) { showToast('On iPhone/iPad: Add TurnDesk Staff to your Home Screen first, then turn on alerts.'); return; }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { showToast('Notifications not enabled'); return; }
    await registerPush();
    showToast('Assignment alerts on ✓');
    render();
  } catch { showToast('Could not enable notifications'); }
};
// Subscribe this device (if needed) and register the subscription under the current tech.
// No-ops unless permission is already granted + a tech is signed in.
async function registerPush() {
  if (!pushSupported() || Notification.permission !== 'granted' || !myId) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(VAPID_PUBLIC_KEY) });
    const prevTech = localStorage.getItem('turndesk_push_techid');
    if (prevTech && prevTech !== myId) {   // device switched techs → drop the old link
      try { await fetch(PUSH_PROXY + '/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ techId: prevTech, endpoint: sub.endpoint }) }); } catch {}
    }
    await fetch(PUSH_PROXY + '/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ techId: myId, subscription: sub.toJSON() }) });
    localStorage.setItem('turndesk_push_techid', myId);
  } catch {}
}

// ── Boot ──────────────────────────────────────────
function boot() {
  sync.start();
  store.subscribe(() => render());
  render();   // instant render from cached state; subscribe re-renders on hydrate
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/turndesk/sw.js').then(() => registerPush()).catch(() => {});
}
// Only boot inside the real page (the login shell exists); skipped when imported
// by the Node test runner (the global shim's getElementById returns null).
if (typeof document !== 'undefined' && document.getElementById && document.getElementById('staff-login')) boot();
