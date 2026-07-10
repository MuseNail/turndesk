// ── Muse Reports — phone-optimized Reports + Payroll viewer ──────────────────
// A SEPARATE page (reports.html) that reuses the dashboard's Durable Object sync
// (store + sync) and the dashboard's OWN report/payroll computation functions
// (reports.js exports), so the numbers here always match the big screen —
// including payroll overrides and locked-period snapshots. Strictly READ-ONLY:
// this page never dispatches a write.
//
// Access: front-desk PIN, allowed only when the account's role has the
// viewReports permission (admins always pass) — same canDo() the dashboard uses.
import './apptoken.js';   // §13 backend auth — installs the bearer-token fetch wrapper; keep FIRST
import * as reporter from './reporter.js';   // automatic error reporting (reports app shares the salon /report log)
import './modal-guard.js';   // global backdrop-close guard (drag-select in a field no longer closes popups)
import { serverLogin, scopedKey } from './apptoken.js';
import * as store from './store.js';
import * as sync from './sync.js';
import { showToast, localDateStr, todayStr, showUpdatePopup, throttleWaitMsg } from './utils.js';
import { APP_VERSION } from './config.js';
import { setActiveUser, getActiveUser, canDo } from './session.js';
import { isPaidStatus } from './features/status.js';
import {
  buildCombinedRecords, computeMetrics, paymentMix,
  payrollComputedRows, payrollFdRows, payrollPeriodAt,
} from './features/reports.js';
import { drawerReportHtml, cdPrintShift, cdPrintCounts } from './features/cashdrawer.js';

const cfg = () => store.getState().config;

const MY_KEY = scopedKey('turndesk_reports_uid');         // per-salon device-local: which fd user is signed in here (for THIS salon)
let myUid = localStorage.getItem(MY_KEY) || null;
let _view = 'reports';                     // 'reports' | 'payroll'
let _range = 'today';                      // 'today' | 'yesterday' | 'week' | 'payperiod' | 'month'
let _payOffset = 0;                        // payroll period nav

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const $ = n => '$' + (n || 0).toFixed(0);
const $2 = n => '$' + (n || 0).toFixed(2);

// ── Access ────────────────────────────────────────
const meUser = () => (cfg().fd_users || []).find(u => u.id === myUid) || null;
function hasAccess(u) {
  if (!u) return false;
  setActiveUser(u);                        // canDo() reads the session user
  return u.role === 'admin' || canDo('viewReports');
}

// ── Date ranges ───────────────────────────────────
const RANGES = [
  ['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week'],
  ['payperiod', 'Pay period'], ['month', 'This month'],
];
function rangeDates() {
  const from = new Date(), to = new Date();
  if (_range === 'yesterday') { from.setDate(from.getDate() - 1); to.setDate(to.getDate() - 1); }
  else if (_range === 'week') { from.setDate(from.getDate() - from.getDay()); }
  else if (_range === 'month') { from.setDate(1); }
  else if (_range === 'payperiod') { const p = payrollPeriodAt(0); from.setTime(p.from.getTime()); to.setTime(p.to.getTime()); }
  from.setHours(0, 0, 0, 0); to.setHours(23, 59, 59, 999);
  return { from, to };
}
const fmtD = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const rangeLabel = ({ from, to }) => localDateStr(from) === localDateStr(to) ? from.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : `${fmtD(from)} – ${fmtD(to)}`;

// ── Render ────────────────────────────────────────
function render() {
  const u = meUser();
  // Only auto-logout against LOADED data — on a fresh browser the §13 server
  // login sets myUid before the snapshot arrives, and an empty fd_users list
  // must read as "still hydrating," not "this user was removed."
  if (!u || !hasAccess(u)) {
    if (myUid && (cfg().fd_users || []).length) rappLogout(false);
    return renderLogin(myUid ? 'Signing in…' : undefined);
  }
  document.getElementById('rapp-login').classList.add('hidden');
  document.getElementById('rapp-main').classList.remove('hidden');
  document.getElementById('rapp-user-name').textContent = u.name;
  const dot = document.getElementById('rapp-conn'); if (dot) dot.style.background = store.getState().connected ? '#2a7a4f' : '#e8730a';
  const seg = `<div class="flex justify-center mb-3"><div class="subnav-seg">
    <button onclick="rappTab('reports')" class="subnav-btn${_view === 'reports' ? ' on' : ''}">Reports</button>
    <button onclick="rappTab('payroll')" class="subnav-btn${_view === 'payroll' ? ' on' : ''}">Payroll</button>
    <button onclick="rappTab('drawer')" class="subnav-btn${_view === 'drawer' ? ' on' : ''}">Drawer</button></div></div>`;
  const bodyHtml = _view === 'payroll' ? renderPayrollHtml() : _view === 'drawer' ? renderDrawerHtml() : renderReportsHtml();
  document.getElementById('rapp-body').innerHTML = seg + bodyHtml;
}
function renderLogin(errMsg) {
  document.getElementById('rapp-login').classList.remove('hidden');
  document.getElementById('rapp-main').classList.add('hidden');
  const connecting = !store.getState().connected && (cfg().fd_users || []).length === 0;
  const status = document.getElementById('rapp-login-status');
  if (status) status.textContent = errMsg || (connecting ? 'Connecting…' : '');
}

const _section = (title, inner) => `<div class="bg-surface-container-lowest rounded-2xl border border-surface-container-high overflow-hidden mb-3">
  <div class="px-4 py-2 text-[11px] font-body font-bold uppercase tracking-widest bg-surface-container text-on-surface-variant">${title}</div>${inner}</div>`;
const _row = (l, r, opts = {}) => `<div class="px-4 py-2 flex items-center justify-between gap-3 text-sm font-body border-b border-surface-container-high last:border-0">
  <span class="min-w-0 truncate ${opts.bold ? 'font-bold' : 'text-on-surface'}">${l}</span><span class="flex-shrink-0 font-headline ${opts.bold ? 'font-extrabold' : 'font-bold'} ${opts.color || ''}">${r}</span></div>`;

function renderReportsHtml() {
  const { from, to } = rangeDates();
  const m = computeMetrics(from, to);
  const filtered = buildCombinedRecords().filter(r => { if (r.status === 'deleted') return false; const d = new Date(r.checkinTime); return d >= from && d <= to && (isPaidStatus(r.status) || r.status === 'refund'); });
  const mix = paymentMix(filtered.filter(r => r.status !== 'refund'), m.tipsTotal);
  const chips = `<div class="flex gap-1.5 overflow-x-auto pb-2 -mx-1 px-1">${RANGES.map(([k, l]) =>
    `<button onclick="rappRange('${k}')" class="flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-body font-bold ${_range === k ? 'bg-primary text-on-primary' : 'bg-surface-container text-on-surface-variant'}">${l}</button>`).join('')}</div>`;
  const hero = `<div class="rounded-2xl bg-primary text-on-primary px-5 py-4 mb-3 shadow-sm">
    <div class="text-xs font-body uppercase tracking-widest opacity-80">Gross income · ${esc(rangeLabel({ from, to }))}</div>
    <div class="font-headline font-extrabold leading-none mt-1" style="font-size:40px">${$(m.grossIncome)}</div>
    <div class="text-sm font-body opacity-90 mt-1">${$(m.tipsTotal)} tips · ${m.guestCount} guest${m.guestCount === 1 ? '' : 's'} · ${$(m.avgTicket)} avg ticket</div></div>`;
  const mixCard = (label, amt, cnt) => `<div class="bg-surface-container-lowest rounded-xl border border-surface-container-high p-3">
    <div class="text-[11px] font-body font-bold uppercase text-outline">${label}</div>
    <div class="font-headline font-extrabold text-xl text-on-surface">${$2(amt)}</div>
    <div class="text-[11px] font-body text-outline">${cnt} ticket${cnt === 1 ? '' : 's'}</div></div>`;
  const mixHtml = `<div class="grid grid-cols-2 gap-2 mb-3">${mixCard('Card + tips', mix.cardMix, mix.cardCnt)}${mixCard('Cash', mix.cashMix, mix.cashCnt)}${mixCard('Zelle', mix.zelleMix, mix.zelleCnt)}${mixCard('Gift', mix.giftMix, mix.giftCnt)}</div>`;
  // Totals block — the rest of the dashboard's Reports cards, compact.
  const totals = _section('Totals', [
    _row('Services', $2(m.svcTotal)), _row('Retail items', $2(m.itemsTotal)), _row('Fees', $2(m.feesTotal)),
    ...(m.discountTotal ? [_row('Discounts', '-' + $2(m.discountTotal), { color: 'text-error' })] : []),
    _row('Gift cards sold', $2(m.gcSold)), _row('Gift cards redeemed', $2(m.gcRedeemed)),
    _row('Commission owed', $2(m.commission)), _row('Shop keeps', $2(m.shopKeeps), { bold: true }),
  ].join(''));
  // Per-staff billed (sorted desc) + service counts.
  const staffInc = {}, staffCnt = {}, svcAgg = {};
  filtered.filter(r => r.status !== 'refund').forEach(r => (r.assignments || []).forEach(a => {
    if (a.techId) { staffInc[a.techId] = (staffInc[a.techId] || 0) + (a.cost || 0); staffCnt[a.techId] = (staffCnt[a.techId] || 0) + 1; }
    const sid = a.serviceId || '?'; (svcAgg[sid] = svcAgg[sid] || { n: 0, amt: 0 }); svcAgg[sid].n++; svcAgg[sid].amt += a.cost || 0;
  }));
  const techName = id => (cfg().staff || []).find(s => s.id === id)?.name || 'Unknown';
  const svcLabel = id => (cfg().services || []).find(s => s.id === id)?.label || id;
  const staffHtml = _section('By staff', Object.entries(staffInc).sort((a, b) => b[1] - a[1])
    .map(([id, amt]) => _row(esc(techName(id)), `${$2(amt)} · ${staffCnt[id]}`)).join('') || _row('No services yet', ''));
  const svcHtml = _section('By service', Object.entries(svcAgg).sort((a, b) => b[1].amt - a[1].amt)
    .map(([id, v]) => _row(esc(svcLabel(id)), `${$2(v.amt)} · ${v.n}`)).join('') || _row('No services yet', ''));
  // Transactions, newest first (capped for phone sanity).
  const txns = filtered.sort((a, b) => new Date(b.checkinTime) - new Date(a.checkinTime)).slice(0, 100);
  const tChips = r => { const t = r.tenders || {}; return ['card', 'cash', 'gift', 'zelle'].filter(k => (t[k] || 0) > 0).join('+') || (r.status === 'refund' ? 'refund' : '—'); };
  const txnHtml = _section(`Transactions · ${filtered.length}${filtered.length > 100 ? ' (first 100)' : ''}`, txns.map(r => {
    const time = new Date(r.checkinTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const day = _range === 'today' || _range === 'yesterday' ? '' : new Date(r.checkinTime).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' }) + ' · ';
    const neg = r.status === 'refund';
    return _row(`${day}${time} · ${esc(r.name || 'Guest')} <span class="text-outline text-xs">${tChips(r)}</span>`, (neg ? '-' : '') + $2(Math.abs(r.totalCost || 0)), neg ? { color: 'text-error' } : {});
  }).join('') || _row('No transactions in this range', ''));
  return chips + hero + mixHtml + totals + staffHtml + svcHtml + txnHtml;
}

function renderPayrollHtml() {
  const { cur, T, locked } = payrollComputedRows(_payOffset);
  const fd = payrollFdRows(_payOffset);
  const label = `${fmtD(cur.from)} – ${fmtD(cur.to)}${_payOffset === 0 ? ' · current' : ''}`;
  const nav = `<div class="flex items-center justify-center gap-2 mb-3">
    <button onclick="rappPayNav(-1)" class="w-10 h-10 rounded-xl border border-surface-container-high bg-surface-container-lowest flex items-center justify-center"><span class="material-symbols-outlined">chevron_left</span></button>
    <span class="font-headline font-bold text-sm min-w-[150px] text-center">${esc(label)}${locked ? ' <span title="Locked" class="material-symbols-outlined text-primary" style="font-size:14px;vertical-align:-2px">lock</span>' : ''}</span>
    <button onclick="rappPayNav(1)" class="w-10 h-10 rounded-xl border border-surface-container-high bg-surface-container-lowest flex items-center justify-center"><span class="material-symbols-outlined">chevron_right</span></button></div>`;
  const techs = T.filter(x => x.c.billed || x.c.refund || x.cChk || x.cCash);
  const techCards = techs.map(x => `<div class="bg-surface-container-lowest rounded-2xl border border-surface-container-high p-4 mb-2">
    <div class="flex items-center justify-between mb-1">
      <span class="font-headline font-bold text-lg">${esc(x.tech.name)}${x.tech.commission != null ? ` <span class="text-xs font-body text-outline">${x.tech.commission}%</span>` : ''}</span>
      <span class="font-headline font-extrabold text-lg text-primary">${$2(x.cTotal)}</span></div>
    <div class="grid grid-cols-2 gap-x-4 text-sm font-body text-on-surface-variant">
      <div class="flex justify-between"><span>Billed</span><b>${$2(x.c.billed)}</b></div>
      <div class="flex justify-between"><span>Commission</span><b>${$2(x.c.commission)}</b></div>
      ${x.c.refund ? `<div class="flex justify-between text-error"><span>Refunds</span><b>-${$2(Math.abs(x.c.refund))}</b></div>` : ''}
      <div class="flex justify-between"><span>Check</span><b>${$2(x.cChk)}</b></div>
      ${x.cDed ? `<div class="flex justify-between text-error"><span>Deduction</span><b>-${$2(x.cDed)}</b></div>` : ''}
      <div class="flex justify-between"><span>Cash</span><b>${$2(x.cCash)}</b></div>
    </div></div>`).join('') || '<p class="text-sm font-body text-on-surface-variant text-center py-6">No technician pay this period.</p>';
  const fdRows = fd.rows.filter(r => r.hours || r.pay);
  const fdHtml = _section('Front Desk — Hourly', fdRows.map(r =>
    _row(`${esc(r.u.name)} <span class="text-outline text-xs">${r.hours.toFixed(2)}h × $${r.rate.toFixed(2)}</span>`,
      `${$2(r.pay)} <span class="text-outline text-xs font-body">(${$(r.chk)} chk · ${$(r.cash)} cash)</span>`)).join('')
    || _row('No front-desk hours this period', ''));
  return nav + techCards + `<div class="mt-3">${fdHtml}</div>`;
}

// ── Actions (read-only navigation) ────────────────
window.rappTab = v => { _view = ['payroll', 'drawer'].includes(v) ? v : 'reports'; render(); };
// Read-only cash drawer + history (with print). Print fns must be on window for the inline onclicks.
window.cdPrintShift = cdPrintShift;
window.cdPrintCounts = cdPrintCounts;
// Reports app drawer view: show per-bill counts, and hide cash-outs.
function renderDrawerHtml() { return `<div class="mb-1">${drawerReportHtml({ showBillCounts: true, hideCashOut: true })}</div>`; }
window.rappRange = k => { _range = k; render(); };
window.rappPayNav = d => { _payOffset += d; render(); };
window.rappPinSubmit = async () => {
  const input = document.getElementById('rapp-pin-entry');
  const pin = (input?.value || '').trim();
  if ((cfg().fd_users || []).length === 0) {
    // Fresh browser (no synced data yet): the server checks the PIN and mints
    // the §13 session that unlocks the snapshot; access is re-checked from the
    // hydrated config on render (hasAccess), same as always.
    if (!/^\d{4,8}$/.test(pin)) { renderLogin('Connecting… try again in a moment'); return; }
    renderLogin('Signing in…');
    const res = await serverLogin({ pin, device: 'reports-app' });
    if (input) input.value = '';
    if (res.ok && res.user.kind === 'fd') {
      myUid = res.user.id; localStorage.setItem(MY_KEY, myUid);
      sync.resync();
      render();
      return;
    }
    renderLogin(res.ok ? 'Reports is for front-desk accounts.'
      : res.error === 'slow_down' || res.retryInSec ? throttleWaitMsg(res.retryInSec)
      : res.error === 'offline' ? 'Connecting… try again in a moment' : 'Incorrect PIN');
    return;
  }
  const u = (cfg().fd_users || []).find(x => x.pin && String(x.pin) === pin) || null;
  if (!u) { if (input) input.value = ''; renderLogin('Incorrect PIN'); return; }
  if (!hasAccess(u)) { if (input) input.value = ''; setActiveUser(null); renderLogin('Your account doesn’t have Reports access.'); return; }
  myUid = u.id; localStorage.setItem(MY_KEY, myUid);
  if (input) input.value = '';
  render();
  serverLogin({ pin, userId: u.id, device: 'reports-app' }).then(r => { if (r.ok) sync.resync(); });   // §13 session mint/refresh
};
window.rappPinKey = ev => { if (ev.key === 'Enter') window.rappPinSubmit(); };
window.rappPinInput = () => {
  const pin = (document.getElementById('rapp-pin-entry')?.value || '').trim();
  if (!pin) return;
  const users = cfg().fd_users || [];
  const match = users.find(x => x.pin && String(x.pin) === pin);
  if (!match) return;
  const ambiguous = users.some(x => x.pin && String(x.pin) !== pin && String(x.pin).startsWith(pin));
  if (!ambiguous) window.rappPinSubmit();
};
window.rappLogout = (rerender = true) => {
  localStorage.removeItem(MY_KEY); myUid = null; setActiveUser(null);
  if (rerender) render();
};

// ── App-update prompt ─────────────────────────────
// Poll version.json (no-store → bypasses the SW); when a newer version is published,
// pop a prominent prompt once per version (boot + each tab-resume) so it isn't missed.
let _updateVer = null;
async function checkReportsVersion() {
  try {
    const res = await fetch('/turndesk/version.json?_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (data.version && data.version !== APP_VERSION && _updateVer !== data.version) {
      _updateVer = data.version;
      showUpdatePopup(data.version);
    }
  } catch (e) {}
}

// ── Boot ──────────────────────────────────────────
function boot() {
  reporter.initReporter();
  window.reportError = reporter.reportError;
  window.addEventListener('error', e => { try { reporter.reportError('window.error', (e && (e.error || e.message)) || 'error'); } catch (x) {} });
  window.addEventListener('unhandledrejection', e => { try { reporter.reportError('unhandledrejection', (e && e.reason) || 'rejection'); } catch (x) {} });
  sync.start();
  store.subscribe(() => render());
  render();   // instant render from cached state; subscribe re-renders on hydrate
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/turndesk/sw.js').catch(() => {});
  checkReportsVersion();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkReportsVersion(); });
  setInterval(() => { if (!document.hidden) checkReportsVersion(); }, 20 * 60 * 1000);   // poll so an always-open app self-updates
}
if (typeof document !== 'undefined' && document.getElementById && document.getElementById('rapp-login')) boot();
