// ── Bootstrap ────────────────────────────────────────────────────────────────
// Wires the modular app: attaches handler functions to window (so the existing
// inline onclick= markup keeps working), defines navigation, subscribes the
// store to re-render on remote changes, and runs startup.

import './apptoken.js';   // §13 backend auth — installs the bearer-token fetch wrapper; keep FIRST
import * as reporter from './reporter.js';   // automatic error reporting — arm early so it catches boot-time throws
import './modal-guard.js';   // global backdrop-close guard (drag-select in a field no longer closes popups)
import * as store from './store.js';
import * as sync from './sync.js';
import * as session from './session.js';
import { APP_VERSION } from './config.js';
import * as utils from './utils.js';
import * as auth from './features/auth.js';
import * as photos from './features/photos.js';
import * as catalog from './features/catalog.js';
import * as sqCust from './features/square-customers.js';
import * as sqCat from './features/square-catalog.js';
import * as sqPos from './features/square-pos.js';
import * as staff from './features/staff.js';
import * as checkin from './features/checkin.js';
import * as statusMod from './features/status.js';
import * as queue from './features/queue.js';
import * as turns from './features/turns.js';
import * as reports from './features/reports.js';
import * as giftcards from './features/giftcards.js';
import * as settings from './features/settings.js';
import * as calendar from './features/calendar.js';
import * as floorplan from './features/floorplan.js';
import * as appearance from './features/appearance.js';
import * as servicetime from './features/servicetime.js';
import * as chat from './features/chat.js';
import * as apptReminders from './features/appt-reminders.js';
import * as recovery from './features/recovery.js';
import * as audit from './features/audit.js';
import * as cashdrawer from './features/cashdrawer.js';
import * as sms from './features/sms.js';
import * as timeclock from './features/timeclock.js';
import * as fdSchedule from './features/fd-schedule.js';
import * as helcim from './features/helcim.js';
import * as quicksale from './features/quicksale.js';
import * as search from './features/search.js';
import * as boSync from './features/backoffice-sync.js';
import * as guide from './features/guide.js';
import * as receipt from './features/receipt.js';
import * as diagnostics from './features/diagnostics.js';

// Expose every module's exports for inline onclick= handlers + cross-module glue.
[utils, auth, photos, catalog, sqCust, sqCat, sqPos, staff, checkin, statusMod, queue, turns, reports, giftcards, settings, calendar, floorplan, appearance, servicetime, chat, apptReminders, recovery, audit, cashdrawer, sms, timeclock, fdSchedule, helcim, quicksale, search, boSync, guide, receipt, diagnostics]
  .forEach(ns => Object.assign(window, ns));
window.dispatch     = sync.dispatch;
window.calEventsFor = calendar.getCalEvents;
window.reportError  = reporter.reportError;   // so any module/inline code can log a silent failure
window.breadcrumb   = reporter.breadcrumb;

function refreshWelcomeBanner() {
  const b = document.getElementById('welcome-banner'); if (!b) return;
  b.classList.toggle('hidden', !!store.getState().config.onboarding_done || !session.getActiveUser());
}
window.refreshWelcomeBanner = refreshWelcomeBanner;
window.dismissWelcome = () => {
  try { sync.dispatch('config.set', { key: 'onboarding_done', value: true }); } catch (e) {}
  document.getElementById('welcome-banner')?.classList.add('hidden');
};

// ── Modal registry ────────────────────────────────
// Single source of truth for every dismissible modal/overlay + its close fn. Drives BOTH the
// Escape key (close the first open one) AND closeAllModals() on navigation (so a screen change
// never leaves an orphaned modal floating over the new screen / silently eating nav taps).
// `pin-modal` is handled separately in the Esc handler.
const MODAL_CLOSERS = [
  ['tech-status-menu', turns.closeTechStatusMenu], ['group-assign-modal', queue.closeGroupAssignModal],
  ['manual-modal', queue.closeManualAdd], ['warn-modal', queue.closeWarnModal],
  ['turns-assign-modal', turns.closeTurnsAssignModal], ['turns-tech-modal', turns.closeTurnsTechModal],
  ['split-merge-modal', queue.closeSplitMergeModal], ['edit-services-modal', queue.closeEditServicesModal],
  ['service-modal', catalog.closeServiceModal], ['staff-modal', staff.closeStaffModal],
  ['staff-photo-modal', photos.closeStaffPhotoModal], ['schedule-picker', staff.closeSchedulePicker], ['week-fill-modal', staff.closeWeekFill],
  ['edit-checkin-modal', queue.closeEditCheckin], ['customer-dir-modal', sqCust.closeCustomerDir],
  ['edit-customer-modal', sqCust.closeEditCustomer], ['photo-crop-modal', photos.closePhotoCrop],
  ['delete-txn-modal', reports.closeDeleteTxnModal], ['refund-modal', reports.closeRefundModal],
  ['gc-modal', giftcards.closeGcModal], ['fduser-modal', auth.closeFdUserModal],
  ['appt-modal', calendar.closeApptModal], ['historical-modal', reports.closeHistoricalModal],
  ['square-confirm-modal', sqPos.closeSquareConfirm], ['admin-code-modal', auth.closeAdminCode],
  ['date-picker-modal', reports.closeDatePicker], ['compare-menu', reports.closeCompareMenu],
  ['day-picker-modal', reports.closeDayPicker], ['txn-merge-modal', reports.closeTxnMergeModal],
  ['rpt-drill-modal', reports.closeDrillDown], ['cash-register-modal', cashdrawer.closeCashRegister],
  ['square-modal', () => { const m = document.getElementById('square-modal'); m.classList.add('hidden'); m.style.display = ''; }],
  ['global-search-modal', search.closeGlobalSearch],
  ['whatsnew-modal', () => closeWhatsNew()],
  ['numpad-modal', utils.numpadConfirm],
];
// Generic force-hide on navigation (does NOT invoke each modal's close fn, so a programmatic/
// back nav isn't gated). User-initiated closes (Esc, backdrop tap, the X button) still run the
// per-modal logic, including the Edit Customer unsaved-changes guard.
function closeAllModals() {
  for (const [id] of MODAL_CLOSERS) {
    const el = document.getElementById(id);
    if (el && !el.classList.contains('hidden')) { el.classList.add('hidden'); el.style.display = ''; }
  }
}

// ── Navigation ────────────────────────────────────
// In-app back handling: the OS/browser back gesture used to reload the PWA
// (losing state). Instead we track screen history and return to the previous
// screen; back never unloads the page (we always keep a history entry to pop).
let _screenStack = [];
let _navBack = false;
function setupBackHandler() {
  history.pushState({ muse: true }, '');
  window.addEventListener('popstate', () => {
    const prev = _screenStack.pop();
    if (prev) { _navBack = true; goTo(prev); _navBack = false; }
    history.pushState({ muse: true }, '');
  });
}
function goTo(screenId, param) {
  closeAllModals();   // a screen change never leaves a modal orphaned over the new screen
  const prevScreen = document.querySelector('.screen.active')?.id;
  if (prevScreen && prevScreen !== screenId && !_navBack) {
    _screenStack.push(prevScreen);
    if (_screenStack.length > 30) _screenStack.shift();
  }
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(screenId)?.classList.add('active');
  window.scrollTo(0, 0);
  if (screenId === 'screen-checkin') {
    session.ui.currentCheckinType = param === 'appointment' ? 'appointment' : 'walkin';
    checkin.renderGuestsContainer();
    const label = document.getElementById('checkin-type-label');
    if (label) label.innerHTML = param === 'appointment'
      ? '<span class="inline-flex items-center gap-1"><span class="material-symbols-outlined" style="font-size:14px;color:#785a1a">calendar_today</span> Appointment Check-In</span>'
      : 'Walk-In Check-In';
  }
  if (screenId === 'screen-desk') { utils.updateDeskDate(); settings.initCalHoursSelectors(); maybeShowWhatsNew(); }
}

// ── "What's new" — one-time popup after a device loads a new version ──────────
// Shown on the staff dashboard (never the customer kiosk) when this device's last-seen version
// differs from the loaded APP_VERSION. Brand-new devices are recorded silently (no popup). Plain-
// English; add an entry (newest first) each release. To re-read it: window.showWhatsNew().
const WHATS_NEW = [
  { v: 'td-v0.42', items: [
    { icon: 'tune', t: 'Small display fixes for the iPad', d: 'Landscape-iPad polish: the status label on a busy Turns lane no longer gets clipped, the Calendar day/week grid fills its space without a stray sideways scroll, and the customer-suggestion list on the check-in screen now opens upward when a guest field sits low on the screen — so its last few suggestions are never hidden behind the check-in bar.' },
  ] },
  { v: 'td-v0.41', items: [
    { icon: 'storefront', t: 'Your business name on every document', d: 'Reports, payroll, transactions, daily summaries, cash-drawer reports, and technician day-sheets now all show YOUR business name — matching your receipts — instead of a placeholder. Set your name in Settings if you haven’t yet.' },
  ] },
  { v: 'td-v0.38', items: [
    { icon: 'tablet_mac', t: 'Cleaner on the iPad', d: 'Polished the front-desk iPad layout. Pop-ups and edit panels (Edit Services, staff, appointments, the tech status card) now scroll so their Save/action button is always reachable — even with the on-screen keyboard up; the customer-list header stays put while you scroll a long list; and nothing runs off the screen edge in either orientation.' },
  ] },
  { v: 'td-v0.37', items: [
    { icon: 'shield', t: 'Reliability & safety improvements', d: 'Behind-the-scenes hardening: when two devices touch the same ticket at once (a tech updating a service, someone editing a visit note), a slower/stale device can no longer overwrite the newer change; backup restores are safer; and error logs now identify which salon they came from. Nothing changes in how you use TurnDesk.' },
  ] },
  { v: 'td-v0.36', items: [
    { icon: 'lock', t: 'More secure sign-in for new salons', d: 'The temporary “1234” front-desk code has been retired. A brand-new salon now signs in first with the owner’s email and password, then sets its own front-desk PIN — so a salon’s link can no longer be used to get in with a default code. Your existing PINs keep working exactly as before, and you can always set or reset the front-desk PIN from the operator console.' },
    { icon: 'restore', t: 'More reliable backups', d: 'Restoring from a backup now always finds your most recent snapshot, even for a salon with a long history.' },
  ] },
  { v: 'td-v0.32', items: [
    { icon: 'verified_user', t: 'Reliability & data-protection improvements', d: 'This release is behind-the-scenes work to keep your salon’s information safe and reliable: each salon’s data (customers, history, and who’s signed in) stays cleanly separated on shared devices, your photos and logo are locked to your own salon, and app updates no longer flag harmless activity-log entries as errors. Nothing changes in how you use TurnDesk.' },
  ] },
];
let _whatsNewChecked = false;
function maybeShowWhatsNew() {
  if (_whatsNewChecked) return;
  // Staff dashboard only (never the customer kiosk). Don't mark checked until the desk is actually
  // active — so an early call while still on the welcome screen retries later instead of blocking.
  if (!document.getElementById('screen-desk')?.classList.contains('active')) return;
  _whatsNewChecked = true;
  let seen = null; try { seen = localStorage.getItem('turndesk_whatsnew_seen'); } catch {}
  if (seen === APP_VERSION) return;                                   // already saw this version
  const usedBefore = (() => { try { return !!(localStorage.getItem('turndesk_device_id') || localStorage.getItem('turndesk_state_cache')); } catch { return false; } })();
  const markSeen = () => { try { localStorage.setItem('turndesk_whatsnew_seen', APP_VERSION); } catch {} };
  if (seen == null && !usedBefore) { markSeen(); return; }            // brand-new device → record silently
  const idx = WHATS_NEW.findIndex(e => e.v === seen);
  const entries = idx > 0 ? WHATS_NEW.slice(0, idx) : (idx === 0 ? [] : [WHATS_NEW[0]]);   // everything newer than seen (or the latest)
  if (!entries.length) { markSeen(); return; }
  showWhatsNew(entries);
}
function showWhatsNew(entries) {
  _wnIdx = 0;
  _renderWhatsNew(entries || [WHATS_NEW[0]]);
  const m = document.getElementById('whatsnew-modal'); if (m) { m.classList.remove('hidden'); m.style.display = 'flex'; }
}
// ‹ › in the popup header page one release at a time, up to 5 releases back.
const WHATSNEW_MAX_BACK = 5;
let _wnIdx = 0;   // 0 = newest release
function whatsNewNav(delta) {   // +1 = older, -1 = newer
  const maxIdx = Math.min(WHATS_NEW.length, WHATSNEW_MAX_BACK) - 1;
  _wnIdx = Math.max(0, Math.min(maxIdx, _wnIdx + delta));
  _renderWhatsNew([WHATS_NEW[_wnIdx]]);
}
function _renderWhatsNew(list) {
  const body = document.getElementById('whatsnew-body'); if (!body) return;
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  body.innerHTML = list.flatMap(e => e.items).map(it => `
    <div class="flex items-start gap-3">
      <span class="material-symbols-outlined text-primary flex-shrink-0" style="font-size:20px;margin-top:1px">${esc(it.icon)}</span>
      <div class="min-w-0"><div class="font-headline font-bold text-on-surface text-sm">${esc(it.t)}</div>
        <div class="text-[13px] font-body text-on-surface-variant leading-snug">${esc(it.d)}</div></div>
    </div>`).join('');
  body.scrollTop = 0;
  const vEl = document.getElementById('whatsnew-version'); if (vEl) vEl.textContent = '· ' + (list[0]?.v || APP_VERSION);
  const maxIdx = Math.min(WHATS_NEW.length, WHATSNEW_MAX_BACK) - 1;
  const prev = document.getElementById('whatsnew-prev'), next = document.getElementById('whatsnew-next');
  if (prev) prev.disabled = _wnIdx >= maxIdx;
  if (next) next.disabled = _wnIdx <= 0;
  const wrap = prev?.parentElement; if (wrap) wrap.style.display = maxIdx <= 0 ? 'none' : '';   // nothing to browse yet
}
function closeWhatsNew() {
  try { localStorage.setItem('turndesk_whatsnew_seen', APP_VERSION); } catch {}
  const m = document.getElementById('whatsnew-modal'); if (m) { m.classList.add('hidden'); m.style.display = ''; }
}
Object.assign(window, { showWhatsNew, closeWhatsNew, whatsNewNav });
// ── Grouped top nav (v4.74) ──────────────────────
// 5 tabs; grouped panels switch via the subnav segments under the header. The Reports group
// (Reports | Payroll) is gated by the viewReports role permission (Settings → Role
// Permissions) — the tab is hidden and direct opens are blocked.
const NAV_GROUPS = {
  floor:      { navId: 'nav-floor',      panels: [['turns','swap_vert','Turns'], ['queue','queue','Queue'], ['floorplan','grid_view','Floor Plan']] },
  money:      { navId: 'nav-money',      panels: [['transactions','receipt_long','Transactions'], ['giftcards','card_giftcard','Gift Cards']] },
  reportsgrp: { navId: 'nav-reportsgrp', panels: [['reports','bar_chart','Reports'], ['payroll','payments','Payroll']] },
  // Settings isn't a real group (its tab always opens Settings); 'admin' only renders the
  // Settings|Customers subnav while on the Customers panel so there's an obvious way back.
  admin:      { navId: 'nav-settings',   panels: [['settings','tune','Settings'], ['customers','contacts','Customers']] },
};
const groupOf = p => Object.keys(NAV_GROUPS).find(g => NAV_GROUPS[g].panels.some(t => t[0] === p));
const lastGroupView = {};
const canViewReportsGroup = () => session.canDo('viewReports');
function showDashGroup(g) { showDashPanel(lastGroupView[g] || NAV_GROUPS[g].panels[0][0]); }
function syncNavForRole() {
  const btn = document.getElementById('nav-reportsgrp');
  if (btn) btn.style.display = canViewReportsGroup() ? '' : 'none';
}
function renderDashSubnav(grp, activePanel) {
  document.querySelectorAll('.subnav-slot').forEach(s => { if (s.innerHTML) s.innerHTML = ''; });
  const global = document.getElementById('dash-subnav');
  if (!grp) { if (global) { global.classList.add('hidden'); global.innerHTML = ''; } return; }
  const html = '<div class="subnav-seg">' + NAV_GROUPS[grp].panels.map(([id, icon, label]) =>
    `<button class="subnav-btn${id === activePanel ? ' on' : ''}" onclick="showDashPanel('${id}')"><span class="material-symbols-outlined" style="font-size:17px">${icon}</span><span class="subnav-label">${label}</span></button>`).join('') + '</div>';
  const slot = document.getElementById('subnav-slot-' + activePanel);
  if (slot) { slot.innerHTML = html; if (global) { global.classList.add('hidden'); global.innerHTML = ''; } }
  else if (global) { global.classList.remove('hidden'); global.innerHTML = html; }   // fallback row (Customers)
}

function showDashPanel(panel) {
  if ((panel === 'reports' || panel === 'payroll') && !canViewReportsGroup()) { utils.showToast('Your role doesn’t have permission to view Reports & Payroll.'); return; }
  closeAllModals();
  ['queue','reports','transactions','payroll','turns','settings','giftcards','calendar','floorplan','customers'].forEach(p => {
    document.getElementById(`panel-${p}`)?.classList.remove('active');
  });
  ['nav-floor','nav-calendar','nav-money','nav-reportsgrp','nav-settings'].forEach(id => document.getElementById(id)?.classList.remove('active'));
  document.getElementById(`panel-${panel}`)?.classList.add('active');
  const grp = groupOf(panel);
  document.getElementById(grp ? NAV_GROUPS[grp].navId : `nav-${panel}`)?.classList.add('active');
  if (grp && grp !== 'admin') lastGroupView[grp] = panel;
  renderDashSubnav(panel === 'settings' ? null : grp, panel);
  syncNavForRole();
  // Re-render the panel being shown so it reflects the latest state. onStateChange only
  // re-renders the ACTIVE panel, so a queue change that landed while another tab was open
  // left the Queue panel stale (a check-in showed in Turns but not Queue until a refresh).
  if (panel === 'queue')        { queue.renderQueue(); queue.updateStats(); }
  if (panel === 'floorplan')    floorplan.renderFloorPlan();
  if (panel === 'reports')      reports.setReportRange('today');
  if (panel === 'transactions') reports.renderTransactions();
  if (panel === 'payroll')      reports.renderPayrollPage();
  if (panel === 'settings')     settings.renderSettingsPanel();
  if (panel === 'giftcards')    giftcards.renderGiftCards();
  if (panel === 'customers')    sqCust.renderCustomersTab();
  if (panel === 'calendar')     calendar.initCalendar();
  if (panel === 'turns') {
    const di = document.getElementById('turns-history-date'); if (di && !di.value) di.value = utils.todayStr();
    turns.renderTurns();
  }
  maybeShowWhatsNew();   // fallback trigger: catches the dashboard being reached by any path (gated to the desk screen)
}
function toggleStaffScheduleView() {
  const listView = document.getElementById('staff-list-view'), scheduleView = document.getElementById('staff-schedule-view'), btn = document.getElementById('schedule-view-btn');
  if (!listView || !scheduleView) return;
  const showingSchedule = !scheduleView.classList.contains('hidden');
  listView.classList.toggle('hidden', !showingSchedule);
  scheduleView.classList.toggle('hidden', showingSchedule);
  if (btn) { btn.style.background = showingSchedule ? '' : '#1a5252'; btn.style.color = showingSchedule ? '' : '#fff'; }
  if (!showingSchedule) staff.renderSchedule();
}
function showStaffListView() {
  document.getElementById('staff-list-view')?.classList.remove('hidden');
  document.getElementById('staff-schedule-view')?.classList.add('hidden');
  const btn = document.getElementById('schedule-view-btn'); if (btn) { btn.style.background = ''; btn.style.color = ''; }
}
Object.assign(window, { goTo, showDashPanel, showDashGroup, toggleStaffScheduleView, showStaffListView });

// Let a mouse wheel scroll the top nav horizontally when it overflows a narrow desktop window
// (touch already pans it; the scrollbar is hidden via .no-scroll). justify-content:safe center
// keeps both ends reachable when it overflows.
(() => {
  const nav = document.getElementById('dash-nav');
  if (!nav) return;
  nav.addEventListener('wheel', (e) => {
    if (!e.deltaY || nav.scrollWidth <= nav.clientWidth) return;   // only hijack a vertical wheel when it actually overflows
    e.preventDefault();
    nav.scrollLeft += e.deltaY;
  }, { passive: false });
})();

// Live-sync status pill: tapping it forces a reconnect + fresh snapshot (catches up any
// changes missed while the socket was asleep), then reports state.
window.forceSyncNow = () => {
  // If the block is a missing sign-in, retrying the sync just 401s again — open the PIN screen instead.
  if (store.getState().authNeeded) { window.showPinModal?.(); return; }
  sync.resync?.(); utils.showToast(store.getState().connected ? 'Live — syncing…' : 'Reconnecting…');
};

// ── Square auto-paid ──────────────────────────────
// The Square return tab writes turndesk_sq_paid on a successful charge; this (main)
// tab marks those customers Paid. Triggered by the storage event (return tab
// wrote it), regaining focus, and hydrate (covers a reopened app). IDs not yet in
// the hydrated queue are kept for a later pass; degrades to manual Mark Paid.
function applySquarePaidFlag() {
  let flag; try { flag = JSON.parse(localStorage.getItem('turndesk_sq_paid') || 'null'); } catch (e) { return; }
  if (!flag || !flag.ids || !flag.ids.length) return;
  if (Date.now() - (flag.at || 0) > 10 * 60 * 1000) { localStorage.removeItem('turndesk_sq_paid'); return; }
  const queue = store.getState().queue, remaining = [];
  flag.ids.forEach(id => {
    const e = queue.find(x => String(x.id) === String(id));
    if (!e) { remaining.push(id); return; }                 // not hydrated yet — retry on a later trigger
    if (!['paid', 'done'].includes(e.status)) window.updateStatus?.(String(id), 'paid');
  });
  if (remaining.length) localStorage.setItem('turndesk_sq_paid', JSON.stringify({ ids: remaining, at: flag.at }));
  else localStorage.removeItem('turndesk_sq_paid');
}
window.addEventListener('storage', e => { if (e.key === 'turndesk_sq_paid' && e.newValue) applySquarePaidFlag(); });
// NB: the day rollover is intentionally NOT triggered straight off visibilitychange — it would run
// on stale cached config before a resync lands (and could wrongly clear the roster). The resync
// fired on tab-visible pulls a fresh snapshot whose hydrate runs runDayRolloverIfNeeded with
// server-confirmed state (see onStateChange 'hydrate').
document.addEventListener('visibilitychange', () => { if (!document.hidden) { applySquarePaidFlag(); checkSquarePending(); checkAppVersion(); helcim.checkUnfinalizedCharges?.(); } });

// Installed-PWA fallback for the Square charge. On iOS a Home-Screen app is resumed
// after the Square hand-off WITHOUT the callback data, so the turndesk_sq_paid handoff
// above never fires (there's no return tab). But proceedSquarePayment stashed
// turndesk_sq_pending in this app's own storage right before launching Square, so on
// resume we ask the operator whether the charge went through — iOS gives us no way to
// know — and mark Paid on confirm. Handled once: the pending flag is cleared the moment
// we prompt, and we skip if the Safari return tab already wrote turndesk_sq_paid.
function checkSquarePending() {
  let pend; try { pend = JSON.parse(localStorage.getItem('turndesk_sq_pending') || 'null'); } catch (e) { return; }
  if (!pend || !pend.ids || !pend.ids.length) return;
  if (Date.now() - (pend.at || 0) > 8 * 60 * 1000) { localStorage.removeItem('turndesk_sq_pending'); return; }
  if (localStorage.getItem('turndesk_sq_paid')) return;   // Safari return tab is handling it
  localStorage.removeItem('turndesk_sq_pending');          // handle once
  const ids = pend.ids.map(String);
  const amt = pend.cents ? ` — $${(pend.cents / 100).toFixed(2)}` : '';
  const who = pend.names || 'this customer';
  const markPaid = () => {
    ids.forEach(id => { const e = store.getState().queue.find(x => String(x.id) === id); if (e && !['paid', 'done'].includes(e.status)) window.updateStatus?.(id, 'paid'); });
    utils.showToast('Marked paid');
  };
  if (window.showWarnModal) window.showWarnModal('Square payment complete?', `Mark ${who}${amt} as Paid? Tap Confirm if the charge went through in Square, or Cancel if it was canceled.`, markPaid);
}

// ── Store subscription → re-render the active panel on (remote) changes ───────
// Big offline banner (#offline-banner). Only "internet is off" — NOT "sign in needed"
// (authNeeded is a credential problem, not a network one; the pill handles that). Debounced
// so it never flashes during the initial connect or a 1-second wifi blip, but hidden the
// instant the connection returns.
let _offlineBannerTimer = null;
function updateOfflineBanner(state) {
  const banner = document.getElementById('offline-banner');
  if (!banner) return;
  const offline = !state.connected && !state.authNeeded;
  if (!offline) {
    if (_offlineBannerTimer) { clearTimeout(_offlineBannerTimer); _offlineBannerTimer = null; }
    banner.classList.add('hidden');
    return;
  }
  if (banner.classList.contains('hidden') && !_offlineBannerTimer) {
    _offlineBannerTimer = setTimeout(() => {
      _offlineBannerTimer = null;
      const s = store.getState();
      if (!s.connected && !s.authNeeded) banner.classList.remove('hidden');   // still offline after the grace window
    }, 3000);
  }
}

function updateSyncIndicator(state) {
  updateOfflineBanner(state);
  const dot = document.getElementById('conn-dot'), text = document.getElementById('conn-text');
  if (!dot) return;
  const pill = dot.parentElement;
  // "Sign in needed" is NOT the same as "Offline" — the server rejected this device for
  // lack of a valid session (wrong/fallback code, expired, or removed user). Say so, and
  // make the pill open the PIN screen, so nobody chases a network problem that isn't there.
  // Checked BEFORE failed-ops: signing in is the prerequisite to recovering anything, so the
  // label matches what a tap does (forceSyncNow opens the PIN screen when authNeeded).
  if (state.authNeeded) {
    dot.style.background = '#e8730a';   // amber — distinct from the red "Offline"
    if (text) text.textContent = 'Sign in needed';
    if (pill) pill.title = 'This device needs a sign-in — enter your front-desk PIN to reconnect. Tap to sign in.';
    return;
  }
  // A server-rejected/dead-lettered write is the next most urgent state — surface it instead of a green "Synced".
  const failed = (sync.failedOps?.() || []).length;
  if (failed > 0) { dot.style.background = '#fa746f'; if (text) text.textContent = `${failed} failed`; if (pill) pill.title = 'A change failed to save — open Settings → Data Recovery'; return; }
  const n = state.pendingCount || 0, queued = n === 1 ? '1 change queued' : `${n} changes queued`;
  if (state.connected) {
    dot.style.background = n > 0 ? '#f5c870' : '#2a7a4f';
    if (text) text.textContent = n > 0 ? `Syncing · ${n}` : 'Live';
    if (pill) pill.title = n > 0 ? `${queued} — sending now. Tap to force a sync.` : 'Connected — everything saved. Tap to force a sync.';
  } else {
    dot.style.background = '#fa746f';
    if (text) text.textContent = n > 0 ? `Offline · ${queued}` : 'Offline';
    if (pill) pill.title = n > 0 ? `${queued} — they'll send automatically when the connection returns. Tap to retry now.` : 'No connection — changes will queue and send when it returns. Tap to retry.';
  }
}
// One-time cleanup of a stray inert config key ('x') left by an ops probe on 2026-07-02.
// Nothing reads it; neutralize it to null once per session (self-heals across devices).
let _cfgXPurged = false;
function _purgeStrayConfigX() {
  if (_cfgXPurged) return;
  const c = store.getState().config || {};
  if (c.x != null) { _cfgXPurged = true; sync.dispatch('config.set', { key: 'x', value: null }); }
}
function onStateChange(state, changed) {
  updateSyncIndicator(state);
  if (changed === 'connection') return;
  if (changed === 'chat.append') chat.onChatSync();   // a new chat message — refresh the open panel + badge (its own op, not 'config')
  if (changed === 'hydrate') { applySquarePaidFlag(); runDayRolloverIfNeeded(); helcim.checkUnfinalizedCharges?.(); _purgeStrayConfigX(); }   // apply pending Square auto-paid + roll over the day; catch any unfinalized Helcim charge (throttled)
  if (changed === 'hydrate' || (changed && changed.startsWith('config'))) {
    photos.setLogo(); auth.updateLoggedInDisplay(); auth.renderSigninScreen(); chat.onChatSync(); timeclock.renderClockButton(); helcim.syncProcessorClass();
    syncNavForRole();   // a role_permissions toggle (any device) can show/hide the Reports tab
    // The customer directory is now a DO entity — it hydrates from the snapshot like records,
    // so no Square auto-pull on boot. (A one-time "Import from Square" seeds it; see the
    // Customers tab.) square-customers.js rebuilds its directory caches on every store change.
  }
  refreshWelcomeBanner();
  const desk = document.getElementById('screen-desk');
  if (!desk || !desk.classList.contains('active')) return;
  queue.refreshOpenAssignFields?.();   // reflect a tech's synced price into an open Assign & Price modal
  const active = document.querySelector('.dash-panel.active'); if (!active) return;
  switch (active.id) {
    case 'panel-turns':        turns.renderTurns(); break;
    case 'panel-floorplan':    floorplan.renderFloorPlan(); break;
    case 'panel-queue':        queue.renderQueue(); queue.updateStats(); break;
    case 'panel-reports':      reports.runReport(); break;
    case 'panel-transactions': reports.renderTransactions(); break;
    case 'panel-payroll':      reports.renderPayrollPage(); break;
    case 'panel-giftcards':    giftcards.renderGiftCards(); break;
  }
}

// ── Version check (display + tap for a HARD reload; no auto-reload loop) ───────
// The version badge is always a hard-reload button: on an installed iPad app a plain
// reload can keep serving the cached version, so tapping it unregisters the service
// worker + clears the cache and reloads to force the newest version. Data is untouched.
let _autoPromptedVersion = null;   // newest version we've already auto-popped this session
async function checkAppVersion() {
  const badge = document.getElementById('app-version-badge');
  if (!badge) return;
  // Up to date → tapping the version shows the latest "What's new". When an update is available
  // (below) it becomes a reload button instead.
  badge.textContent = APP_VERSION;
  badge.title = 'What’s new in this version';
  badge.style.cursor = 'pointer';
  badge.classList.remove('update-pulse');
  badge.onclick = () => showWhatsNew();
  try {
    const res = await fetch('/turndesk/version.json?_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (data.version && data.version !== APP_VERSION) {
      badge.textContent = data.version + ' ↻';
      badge.title = `Update ${data.version} available — tap to reload`;
      badge.classList.add('update-pulse');   // E2: make the update glyph discoverable
      badge.onclick = () => utils.showUpdatePopup(data.version);
      // The badge alone kept getting missed — pop a prominent prompt once per new version
      // (on boot and on every tab-resume until they update).
      if (_autoPromptedVersion !== data.version) { _autoPromptedVersion = data.version; utils.showUpdatePopup(data.version); }
    }
  } catch (e) {}
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/turndesk/sw.js').catch(e => console.warn('[SW] registration failed:', e));
}

// ── Daily rollover (self-healing, midnight boundary) ──────────────────────────
// Replaces the old fragile 4 AM `setTimeout` reset. The day boundary no longer affects data
// integrity (records are the source of truth — see buildCombinedRecords), so this is just
// board hygiene + new-day housekeeping. Runs on hydrate, on tab-visible, and on a timer
// armed to the next local midnight; idempotent, so running it repeatedly is safe.
function runDayRolloverIfNeeded() {
  const today = utils.todayStr();
  const st = store.getState();
  const recIds = new Set((st.records || []).filter(r => r.status !== 'deleted').map(r => String(r.id)));
  // Finished tickets from a previous day that are ALREADY saved as a record — safe to drop
  // from the live board (the record is the permanent copy). Computed BEFORE we clear, so the
  // archive below still sees them. Active or unrecorded entries are never auto-removed.
  const stale = (st.queue || []).filter(e =>
    (e.status === 'paid' || e.status === 'done') &&
    recIds.has(String(e.id)) &&
    utils.localDateStr(new Date(e.checkinTime)) < today);
  // New-day housekeeping — once per day GLOBALLY (gated on the SHARED, synced last_rollover_date,
  // not a per-device marker). This is the fix for "my selected technicians disappeared mid-day":
  // the housekeeping CLEARS the roster (rolloverTurns → setOrder([])), and that clear broadcasts to
  // every device. With the old per-device gate, any device first opened mid-day (its local marker
  // still on yesterday) would think it was a new day, run the clear, and wipe the roster everyone
  // was using. Reading the marker from synced config means a device that shows up mid-day sees
  // "already rolled over today" and leaves the roster alone. Only callers with FRESH server state
  // run this (hydrate + the midnight timer) — NOT the raw visibilitychange path, which can fire on
  // stale cached config before a resync lands.
  const globalLast = st.config?.last_rollover_date || '';
  const action = utils.rolloverAction(globalLast, today);
  let didRollover = false;
  if (action === 'seed') {
    // Marker absent (fresh DO, or upgrading from the per-device scheme): seed to today WITHOUT
    // clearing anything, so the upgrade itself can never wipe a live roster.
    sync.dispatch('config.set', { key: 'last_rollover_date', value: today });
  } else if (action === 'rollover') {
    sync.dispatch('config.set', { key: 'last_rollover_date', value: today });   // claim first (synced) so other devices skip
    try { turns.rolloverTurns(globalLast); } catch (e) {}                        // archive closed day + clear the rotation
    sync.dispatch('config.set', { key: 'turns_break', value: [] });
    sync.dispatch('config.set', { key: 'chat_log', value: [] });                 // staff chat starts fresh each day
    utils.showToast("New day — yesterday's history saved");
    didRollover = true;
  }
  // Safe board cleanup — runs every time (idempotent); also self-heals a stale entry that a
  // still-connected device re-pushed from its outbox after a clear.
  if (stale.length) {
    stale.forEach(e => sync.dispatch('queue.remove', { id: e.id }));
    window.logAudit?.('Day rollover', `Cleared ${stale.length} finished ticket(s) from a prior day`);
  }
  if (stale.length || didRollover) { queue.renderQueue(); queue.updateStats(); turns.renderTurns(); chat.renderChat(); chat.updateChatBadge(); }
}
// Arm a one-shot timer to the next local midnight (+30s); it re-arms itself after firing.
// Hydrate + visibilitychange are the real safety net (cover device sleep / clock changes);
// this timer only handles a device left open across midnight.
function armMidnightRollover() {
  const now = new Date();
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 30);
  setTimeout(() => { runDayRolloverIfNeeded(); armMidnightRollover(); }, nextMidnight - now);
}

// ── PWA install ───────────────────────────────────
let _pwaInstallEvent = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); _pwaInstallEvent = e; document.getElementById('pwa-install-banner')?.classList.remove('hidden'); });
window.addEventListener('appinstalled', () => { _pwaInstallEvent = null; document.getElementById('pwa-install-banner')?.classList.add('hidden'); });
window.promptPwaInstall = () => { if (!_pwaInstallEvent) return; _pwaInstallEvent.prompt(); _pwaInstallEvent.userChoice.then(() => { _pwaInstallEvent = null; document.getElementById('pwa-install-banner')?.classList.add('hidden'); }); };

// ── Keyboard shortcuts ────────────────────────────
function wireKeyboard() {
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      // A calc in progress (an amount field with a typed expression) → Enter CONFIRMS the number and
      // keeps the modal open. A second Enter (now a plain number) falls through to Save below.
      if (utils.commitAmountField(document.activeElement)) { e.preventDefault(); return; }
      const gm = document.getElementById('group-assign-modal');
      if (gm && !gm.classList.contains('hidden')) { e.preventDefault(); queue.saveGroupAssignments(); return; }
      const mm = document.getElementById('manual-modal');
      if (mm && !mm.classList.contains('hidden')) { const tag = document.activeElement?.tagName; if (tag !== 'SELECT' && tag !== 'TEXTAREA') { e.preventDefault(); queue.submitManualAdd(); return; } }
    }
    if (e.key === 'Escape') {
      for (const [id, fn] of MODAL_CLOSERS) { const el = document.getElementById(id); if (el && !el.classList.contains('hidden')) { fn(); return; } }
      const chatP = document.getElementById('chat-panel');
      if (chatP && !chatP.classList.contains('hidden')) { chat.closeChat(); return; }
      const calDD = document.getElementById('cal-selector-dropdown');
      if (calDD && !calDD.classList.contains('hidden')) { calendar.calSelectorCancel(); return; }
      const checkinScreen = document.getElementById('screen-checkin');
      if (checkinScreen && checkinScreen.classList.contains('active')) { goTo('screen-welcome'); return; }
      const pinModal = document.getElementById('pin-modal');
      if (pinModal && !pinModal.classList.contains('hidden')) { pinModal.classList.add('hidden'); pinModal.style.display = ''; }
    }
  });
}

// ── Square POS return handler ─────────────────────
// Square's mobile-web payment flow returns by opening callback_url in a NEW Safari
// tab — Apple's sandbox won't let an external app reuse an existing tab, so the tab
// itself is unavoidable (confirmed by Square). When we detect that return, show a
// tiny self-closing screen instead of booting a second live dashboard, and try to
// auto-close (best-effort; iOS usually blocks closing a non-script-opened tab).
function handleSquarePosReturn() {
  const fields = (s) => { const o = {}; try { new URLSearchParams(s).forEach((v, k) => { o[k] = v; }); } catch (e) {} return o; };
  const p = { ...fields(location.hash.replace(/^#/, '')), ...fields(location.search.replace(/^\?/, '')) };
  if (p.data) { try { Object.assign(p, JSON.parse(p.data)); } catch (e) {} }
  if (!['status', 'transaction_id', 'client_transaction_id', 'error_code'].some(k => k in p)) return false;

  const errored = p.status === 'error' || !!p.error_code;
  // On a successful charge, hand the stashed party off to the main tab to mark Paid.
  try {
    if (!errored) { const pend = JSON.parse(localStorage.getItem('turndesk_sq_pending') || 'null'); if (pend && pend.ids && pend.ids.length) localStorage.setItem('turndesk_sq_paid', JSON.stringify({ ids: pend.ids, at: Date.now() })); }
    localStorage.removeItem('turndesk_sq_pending');
  } catch (e) {}
  document.title = utils.businessName() + ' — Payment';
  document.body.innerHTML = `
    <div style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#e8ecee;font-family:-apple-system,system-ui,sans-serif;">
      <div style="text-align:center;padding:32px;max-width:340px;">
        <div style="font-size:56px;line-height:1;margin-bottom:16px;">${errored ? '⚠️' : '✓'}</div>
        <div style="font-size:22px;font-weight:800;color:#1a5252;margin-bottom:8px;">${errored ? 'Payment not completed' : 'Payment complete'}</div>
        <div style="font-size:15px;color:#555;margin-bottom:24px;">You can close this tab and return to the Muse dashboard.</div>
        <button onclick="window.close()" style="background:#1a5252;color:#fff;border:none;padding:14px 28px;border-radius:14px;font-size:16px;font-weight:700;">Close tab</button>
      </div>
    </div>`;
  try { window.close(); } catch (e) {}
  setTimeout(() => { try { window.close(); } catch (e) {} }, 300);
  return true;
}

// ── Global error surface ──────────────────────────
// On a headless front-desk iPad nobody watches the console — an uncaught error/rejection
// would otherwise leave a frozen screen with no signal. Best-effort: log + a throttled toast.
let _lastErrToast = 0;
function _errToast() {
  const now = Date.now();
  if (now - _lastErrToast < 15000) return;   // don't spam if errors cascade
  _lastErrToast = now;
  try { utils.showToast('Something went wrong. If the screen seems stuck, tap the version badge to reload.'); } catch (e) {}
}
window.addEventListener('error', e => { try { console.warn('[error]', e?.error || e?.message); _errToast(); reporter.reportError('window.error', (e && (e.error || e.message)) || 'error'); } catch (x) {} });
window.addEventListener('unhandledrejection', e => { try { console.warn('[unhandledrejection]', e?.reason); reporter.reportError('unhandledrejection', (e && e.reason) || 'rejection'); } catch (x) {} });

// ── Boot ──────────────────────────────────────────
function boot() {
  if (handleSquarePosReturn()) return; // don't boot a 2nd live app in the Square return tab
  reporter.initReporter();            // flush any queued error reports + re-flush on reconnect
  auth.routeSignedOut();              // land on the business sign-in, or the kiosk on a front-desk device
  setupBackHandler();                 // OS back returns to the previous screen, never reloads the PWA
  sync.start();                       // connect to the DO, hydrate from cache + snapshot
  store.subscribe(onStateChange);
  appearance.applyUserTheme();        // default light palette until a user logs in

  utils.startClock();
  utils.updateDeskDate();
  utils.startElapsedTimer();
  checkin.renderGuestsContainer();
  photos.setLogo();
  auth.renderSigninScreen();
  queue.renderQueue();
  auth.updateLoggedInDisplay();
  chat.initChatDeskNotify();   // dashboard opts into desktop notifications for new chat messages
  chat.onChatSync();   // baseline the chat unread badge from cache on load
  apptReminders.startApptReminders();   // appointment reminder banners (30s timer)
  updateSyncIndicator(store.getState());

  // Confirm screen: tap anywhere to return to welcome
  const confirmScreen = document.getElementById('screen-confirm');
  if (confirmScreen) {
    const reset = () => { clearTimeout(window._confirmResetTimer); goTo('screen-welcome'); };
    confirmScreen.addEventListener('click', reset);
    confirmScreen.addEventListener('touchend', e => { e.preventDefault(); reset(); });
  }

  wireKeyboard();
  armMidnightRollover();
  utils.initAmountFieldCalc();   // desktop: evaluate "40+5" typed into an amount field on blur
  checkAppVersion();
  // Also poll periodically so an always-open front-desk iPad (which never fires a fresh
  // launch/visibilitychange) still notices a new deploy and prompts on its own. Skipped while
  // hidden — visibilitychange already covers the return-to-app case.
  setInterval(() => { if (!document.hidden) checkAppVersion(); }, 20 * 60 * 1000);
  registerServiceWorker();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
