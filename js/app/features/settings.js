// ── Settings panel ──────────────────────────────────────────────────────────
import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { getAppToken, getSessionUser } from '../apptoken.js';
import { showToast, setSwitchVisual, escHtml } from '../utils.js';
import { canDo, getActiveUser, ui } from '../session.js';
import { DEFAULT_ROLE_PERMISSIONS, APP_VERSION } from '../config.js';
import { renderServicesMerged, renderSettingsItems, renderSettingsFees } from './catalog.js';
import { setLogo } from './photos.js';
import { getTurnConfig, saveTurnConfig, isAlwaysBonusService, saveBonusServices } from './turns.js';

const cfg = () => getState().config;

// ── Done-card visibility (transient UI state) ─────
export function toggleDoneVisibility() {
  ui.showDoneInQueue = !ui.showDoneInQueue;
  const icon = document.getElementById('done-toggle-icon'), label = document.getElementById('done-toggle-label');
  if (icon) icon.textContent = ui.showDoneInQueue ? 'visibility_off' : 'visibility';
  if (label) label.textContent = ui.showDoneInQueue ? 'Hide Paid' : 'Show Paid';
  window.renderQueue?.();
}

// ── Role permissions (config.role_permissions) ────
const _PERM_LABELS = {
  historicalEntry: 'Add / Edit Historical Transactions', deleteTransaction: 'Delete Transactions',
  refund: 'Issue Refunds', viewReports: 'View Reports & Payroll',
  manageStaff: 'Manage Staff', manageServices: 'Manage Services & Catalog',
  markPaidDirect: 'Mark Paid without charging (payment taken outside the app)',
  viewClockedIn: 'See Who’s Clocked In',
};
// Merged per role+key over the defaults, mirroring canDo() — the toggles must show
// what is actually enforced, even for keys added after the map was last saved.
function rolePerms() {
  const stored = cfg().role_permissions || {};
  const roles = [...new Set([...Object.keys(DEFAULT_ROLE_PERMISSIONS), ...Object.keys(stored)])];
  const out = {};
  roles.forEach(r => { out[r] = { ...(DEFAULT_ROLE_PERMISSIONS[r] || {}), ...(stored[r] || {}) }; });
  return out;
}
export function renderRolePermissions() {
  const el = document.getElementById('role-permissions-list');
  if (!el) return;
  const rp = rolePerms();
  const roles = Object.keys(rp);
  el.innerHTML = roles.length === 0 ? '<p class="text-sm font-body text-on-surface-variant">No configurable roles found.</p>'
    : roles.map(role => `<div class="mb-5 last:mb-0"><div class="font-headline font-semibold text-on-surface text-sm mb-2 capitalize">${role}</div>
      <div class="bg-surface-container-lowest rounded-xl border border-surface-container-high overflow-hidden">
        ${Object.entries(_PERM_LABELS).map(([perm,label]) => { const enabled = rp[role]?.[perm] ?? false; return `<div class="flex items-center justify-between px-4 py-2.5 border-b border-surface-container-high last:border-0"><span class="text-sm font-body text-on-surface">${label}</span><button onclick="toggleRolePermission('${role}','${perm}',this)" class="mswitch relative w-14 h-7 rounded-full transition-colors flex-shrink-0 ml-4 ${enabled?'bg-primary':'bg-surface-container-high'}"><div class="absolute top-0.5 w-6 h-6 rounded-full bg-white shadow transition-all ${enabled?'left-7':'left-0.5'}"></div></button></div>`; }).join('')}
      </div></div>`).join('');
}
export function toggleRolePermission(role, perm, btn) {
  const rp = JSON.parse(JSON.stringify(rolePerms()));
  if (!rp[role]) rp[role] = {};
  rp[role][perm] = !rp[role][perm];
  dispatch('config.set', { key: 'role_permissions', value: rp });
  if (btn) setSwitchVisual(btn, rp[role][perm]); else renderRolePermissions();
  showToast('Permission updated ✓');
}

// Re-render role-gated panels on login/logout/role change.
export function updatePermissionGatedUI() {
  if (document.getElementById('panel-transactions')?.classList.contains('active')) window.renderTransactions?.();
  if (document.getElementById('panel-reports')?.classList.contains('active')) window.runReport?.();
  // Visibility of the role-permissions section is owned by the settings drill-down
  // (it's an admin-only leaf). Re-hide the wrapper so it never leaks into another
  // open leaf — BUT NOT while that leaf is the one currently open, or toggling a
  // permission (which fires a config change → this fn) would blank the screen.
  const permSection = document.getElementById('settings-role-permissions');
  const permContent = document.getElementById('settings-perms-section');
  const leafOpen = permContent && !permContent.classList.contains('hidden');
  if (permSection && !leafOpen) permSection.classList.add('hidden');
}

// ── Turn thresholds + bonus services ──────────────
export function saveTurnThresholds() {
  const fullMin = parseInt(document.getElementById('thresh-full')?.value) || 28;
  const halfMin = parseInt(document.getElementById('thresh-half')?.value) || 12;
  if (halfMin >= fullMin) { showToast('Half min must be less than full min.'); return; }
  saveTurnConfig({ fullMin, halfMin });
  showToast('Turn thresholds saved ✓');
}
export function renderBonusServicesList() {
  const el = document.getElementById('bonus-services-list');
  if (!el) return;
  el.innerHTML = cfg().services.map(s => { const isBonus = isAlwaysBonusService(s.id); return `<label class="flex items-center gap-3 p-3 rounded-xl cursor-pointer hover:bg-surface-container transition-colors ${isBonus?'bg-primary/10 border border-primary/30':'border border-transparent'}"><input type="checkbox" class="w-5 h-5 accent-primary" ${isBonus?'checked':''} onchange="toggleBonusService('${s.id}', this.checked)"><span class="font-body font-semibold text-on-surface text-sm">${s.label}</span><span class="text-[10px] font-body text-outline">${s.abbr}</span>${isBonus?'<span class="ml-auto text-[10px] font-semibold text-primary">Always Bonus</span>':''}</label>`; }).join('');
}
export function toggleBonusService(serviceId, checked) {
  const ids = [...cfg().bonus_services];
  if (checked && !ids.includes(serviceId)) ids.push(serviceId);
  else if (!checked) { const i = ids.indexOf(serviceId); if (i > -1) ids.splice(i, 1); }
  saveBonusServices(ids);
  renderBonusServicesList();
  showToast(checked ? 'Marked as always bonus ✓' : 'Removed from always bonus');
}

// ── Calendar hours (device-local pref) ────────────
export function saveCalHours() {
  const start = parseInt(document.getElementById('cal-hour-start')?.value || '6');
  const end = parseInt(document.getElementById('cal-hour-end')?.value || '22');
  localStorage.setItem('turndesk_cal_hours', JSON.stringify({ start, end }));
  if (document.getElementById('panel-calendar')?.classList.contains('active')) window.calRenderGrid?.();
  showToast('Calendar hours updated ✓');
}
export function initCalHoursSelectors() {
  const c = JSON.parse(localStorage.getItem('turndesk_cal_hours') || 'null');
  if (!c) return;
  const s = document.getElementById('cal-hour-start'), e = document.getElementById('cal-hour-end');
  if (s) s.value = String(c.start ?? 6);
  if (e) e.value = String(c.end ?? 22);
}

// ── Square connection (from settings) ─────────────
export function saveSquareFromSettings() {
  const locationId = document.getElementById('settings-location-id')?.value.trim();
  if (!locationId) { showToast('Please enter a Location ID.'); return; }
  const applicationId = document.getElementById('settings-app-id')?.value.trim() || '';
  dispatch('config.set', { key: 'square_config', value: { ...cfg().square_config, locationId, applicationId } });
  const status = document.getElementById('settings-square-status'); if (status) status.textContent = '✓ Connected — Location: ' + locationId;
  showToast('Square connected ✓');
}

export function syncSquareFromSettings() {
  if (!cfg().square_config) { showToast('Connect a Location ID first.'); return; }
  window.syncSquare?.();
}

// ── Google Calendar (Integrations leaf) ───────────
function gcalConnected() {
  try { const l = JSON.parse(localStorage.getItem('turndesk_turndesk_gcal_token') || 'null'); if (l && Date.now() < l.expires - 60000) return true; } catch (e) {}
  const s = cfg().turndesk_turndesk_gcal_token;
  return !!(s && Date.now() < s.expires - 60000);
}
export function renderGcalSettings() {
  window.loadGCalScripts?.();
  const on = gcalConnected();
  const status = document.getElementById('gcal-settings-status');
  if (status) { status.textContent = on ? '✓ Connected' : 'Not connected'; status.style.color = on ? '#2a7a4f' : ''; }
  document.getElementById('gcal-connect-btn')?.classList.toggle('hidden', on);
  document.getElementById('gcal-disconnect-btn')?.classList.toggle('hidden', !on);
  window.renderGcalCalendarList?.();
}

// ── App Info (Data & System leaf) ─────────────────
export function renderAppInfo() {
  const el = document.getElementById('appinfo-content');
  if (!el) return;
  const st = getState();
  const rows = [
    ['App version', APP_VERSION],
    ['Device ID', localStorage.getItem('turndesk_device_id') || '—'],
    ['Live sync', st.connected ? `Connected${st.pendingCount ? ` · ${st.pendingCount} pending` : ''}` : 'Offline'],
    ['Square', cfg().square_config ? `Connected · ${cfg().square_config.locationId}` : 'Not connected'],
    ['Google Calendar', gcalConnected() ? 'Connected' : 'Not connected'],
    ['Server sign-in', getAppToken() ? `Active${getSessionUser()?.name ? ` · ${getSessionUser().name}` : ''}` : 'None yet — minted on the next PIN entry'],
  ];
  let kiosk = false; try { kiosk = localStorage.getItem('turndesk_kiosk_device') === '1'; } catch {}
  const kioskRow = `
    <div class="flex items-center justify-between px-4 py-3 border-t border-surface-container-high">
      <div class="pr-4">
        <div class="text-sm font-body font-semibold text-on-surface">Front-desk kiosk mode</div>
        <div class="text-xs font-body text-on-surface-variant mt-0.5">${kiosk ? 'This device opens to customer check-in.' : 'This device opens to the business sign-in.'}</div>
      </div>
      <button onclick="toggleKioskDevice()" class="flex-shrink-0 px-4 h-9 rounded-full text-xs font-body font-semibold transition-colors ${kiosk ? 'bg-primary text-on-primary' : 'bg-surface-container text-on-surface-variant border border-surface-container-high'}">${kiosk ? 'On' : 'Off'}</button>
    </div>`;
  el.innerHTML = rows.map(([k, v]) => `
    <div class="flex items-center justify-between px-4 py-3 border-b border-surface-container-high last:border-0">
      <span class="text-sm font-body text-on-surface-variant">${k}</span>
      <span class="text-sm font-body font-semibold text-on-surface text-right break-all ml-4">${v}</span>
    </div>`).join('') + kioskRow;
}

// ── Pay period (config.pay_period) — drives the Reports/Transactions quick button ─
export function renderPayPeriodSettings() {
  const el = document.getElementById('settings-payperiod-section'); if (!el) return;
  const pp = cfg().pay_period || {}; const type = pp.type || 'weekly';
  const needsStart = type === 'weekly' || type === 'biweekly';
  const lbl = 'text-[11px] font-body font-semibold text-outline uppercase tracking-widest block mb-1';
  const inp = 'w-full bg-surface-container border border-surface-container-high rounded-lg px-3 py-2 text-sm font-body text-on-surface focus:outline-none focus:border-primary';
  el.innerHTML = `
    <p class="text-xs font-body text-on-surface-variant mb-4">Sets the <strong>Pay Period</strong> quick button in Reports &amp; Transactions (and the pay-period option for scheduled report emails).</p>
    <label class="${lbl}">Period</label>
    <select id="pp-type" onchange="savePayPeriod(); renderPayPeriodSettings()" class="${inp} mb-3">
      <option value="weekly" ${type==='weekly'?'selected':''}>Weekly</option>
      <option value="biweekly" ${type==='biweekly'?'selected':''}>Bi-weekly (every 2 weeks)</option>
      <option value="bimonthly" ${type==='bimonthly'?'selected':''}>Bi-monthly (1st–15th, 16th–end of month)</option>
    </select>
    ${needsStart ? `<label class="${lbl}">Period start date</label>
      <input type="date" id="pp-start" value="${pp.startDate||''}" onchange="savePayPeriod()" class="${inp}">
      <p class="text-[11px] font-body text-on-surface-variant mt-1">Repeats every ${type==='biweekly'?'14':'7'} days from this date — e.g., a Monday start runs Mon–Sun.</p>` : ''}
    <div class="mt-5 pt-4 border-t border-surface-container-high">
      <label class="${lbl}">Time-Clock Station</label>
      <p class="text-xs font-body text-on-surface-variant mb-2">Front-desk staff can clock in/out <strong>only on the designated station device</strong> — so nobody can clock in from a personal phone. Set this on the salon's front-desk device.</p>
      <div id="timeclock-station-status"></div>
    </div>`;
  window.renderClockStationSetting?.();
}
export function savePayPeriod() {
  const type = document.getElementById('pp-type')?.value || 'weekly';
  const startDate = document.getElementById('pp-start')?.value || (cfg().pay_period||{}).startDate || '';
  dispatch('config.set', { key: 'pay_period', value: { type, startDate } });
  showToast('Pay period saved');
  window.renderTransactions?.(); window.runReport?.();
}

// ── Commission & refunds policy (config.commission_includes_refunds) ─────────────
export function renderCommissionSettings() {
  const el = document.getElementById('settings-commission-section'); if (!el) return;
  const on = !!cfg().commission_includes_refunds;
  el.innerHTML = `
    <p class="text-xs font-body text-on-surface-variant mb-4">When a transaction is refunded in the app, choose whether that refund <strong>reduces the technician’s commission</strong> for the original sale’s pay period.</p>
    <label class="flex items-center justify-between gap-4 cursor-pointer">
      <span class="text-sm font-body font-semibold text-on-surface">Refunds reduce tech commission</span>
      <input type="checkbox" ${on ? 'checked' : ''} onchange="setCommissionIncludesRefunds(this.checked)" class="w-5 h-5 accent-primary cursor-pointer">
    </label>
    <p class="text-[11px] font-body text-on-surface-variant mt-2">${on
      ? 'On — a refund subtracts the refunded amount from that technician’s billed total and commission (proportional for partial refunds).'
      : 'Off (default) — the salon absorbs refunds; technician commission is unchanged.'}</p>`;
}
export function setCommissionIncludesRefunds(checked) {
  dispatch('config.set', { key: 'commission_includes_refunds', value: !!checked });
  renderCommissionSettings();
  window.runReport?.(); window.renderPayrollPage?.();
  showToast(checked ? 'Refunds will reduce commission' : 'Refunds no longer affect commission');
}

// ── Numpad entry mode (config.numpad_whole_dollars) ─────────────────────────────
export function renderNumpadSettings() {
  const el = document.getElementById('settings-numpad-section'); if (!el) return;
  const whole = !!cfg().numpad_whole_dollars;
  const opt = (on, title, desc, val) => `<label class="flex items-center justify-between gap-4 cursor-pointer bg-surface-container-low rounded-xl px-4 py-3 border ${on ? 'border-primary' : 'border-surface-container-high'}">
      <span class="min-w-0"><span class="text-sm font-body font-semibold text-on-surface">${title}</span><span class="block text-[11px] font-body text-on-surface-variant">${desc}</span></span>
      <input type="radio" name="numpad-mode" ${on ? 'checked' : ''} onchange="setNumpadWholeDollars(${val})" class="w-5 h-5 accent-primary cursor-pointer flex-shrink-0"></label>`;
  el.innerHTML = `
    <p class="text-xs font-body text-on-surface-variant mb-4">How the on-screen number pad enters prices (services, items, fees).</p>
    <div class="space-y-2">
      ${opt(!whole, 'Cents', 'Every digit is a cent — type 4 5 0 0 for $45.00.', false)}
      ${opt(whole, 'Whole dollars', 'Digits build whole dollars — type 4 5 for $45.00. Use the dot for cents (e.g. $45.50).', true)}
    </div>`;
}
export function setNumpadWholeDollars(val) {
  dispatch('config.set', { key: 'numpad_whole_dollars', value: !!val });
  renderNumpadSettings();
  showToast(val ? 'Numpad: whole dollars' : 'Numpad: cents');
}

// ── Orchestrator ──────────────────────────────────
// ── Settings drill-down navigation ────────────────────────────────────────────
// Groups existing setting sections into 6 categories. Content is already rendered
// by renderSettingsPanel(); nav just toggles which section wrapper is visible.
const SETTINGS_NAV = [
  { id:'catalog', title:'Services, Items & Fees', desc:'What you sell', items:[
    { label:'Services', sub:'Add, edit, delete & visibility', content:'services-merged-section', render:'renderServicesMerged', perm:'manageServices', icon:'design_services' },
    { label:'Retail Items', sub:'Add-on items', content:'items-section', perm:'manageServices', icon:'inventory_2' },
    { label:'Fees', sub:'Flat or percentage fees', content:'fees-section', perm:'manageServices', icon:'percent' },
  ]},
  { id:'staff', title:'Staff & Access', desc:'People & permissions', items:[
    { label:'Technicians', sub:'Staff, photos, schedule & active toggle', content:'staff-merged-section', render:'renderStaffMerged', perm:'manageStaff', icon:'group' },
    { label:'Front Desk Users', sub:'Dashboard PIN login accounts', content:'fdusers-merged-section', render:'renderFdUsersList', adminOnly:true, icon:'badge' },
    { label:'Role Permissions', sub:'What each role can do', content:'settings-perms-section', render:'renderRolePermissions', adminOnly:true, icon:'lock' },
  ]},
  { id:'workflow', title:'Workflow', desc:'How the floor runs', items:[
    { label:'Turn Thresholds', sub:'Full / half / bonus cutoffs', content:'turns-thresh-section', icon:'swap_vert' },
    { label:'Stations', sub:'Add, rename & delete pedicure / manicure seats', content:'settings-stations-section', render:'renderStationsSettings', icon:'event_seat' },
    { label:'Pay Period', sub:'Weekly / bi-weekly / bi-monthly for the quick button', content:'settings-payperiod-section', render:'renderPayPeriodSettings', adminOnly:true, icon:'event_repeat' },
    { label:'Commission & Refunds', sub:'Whether refunds reduce tech commission', content:'settings-commission-section', render:'renderCommissionSettings', adminOnly:true, icon:'paid' },
    { label:'Numpad Entry', sub:'Cents or whole dollars', content:'settings-numpad-section', render:'renderNumpadSettings', icon:'dialpad' },
    { label:'Turns Board Display', sub:'Text size & tech/turn separation (divider or lane) — set per device', content:'settings-turnsdisplay-section', render:'renderTurnsDisplaySettings', icon:'format_size' },
    { label:'Calendar Hours', sub:'Visible time range', content:'settings-calhours-section', icon:'schedule' },
  ]},
  { id:'integrations', title:'Integrations', desc:'Payments & Google', items:[
    { label:'Payment Processing', sub:'Card processor, terminal & Square', content:'helcim-section', render:'renderHelcimSettings', icon:'credit_card' },
    { label:'Square', sub:'Location, connection & sync', content:'square-section', hidden:true, icon:'storefront' },   // reached from the Payment Processing panel
    { label:'Google Calendar', sub:'Connect for appointments', content:'gcal-section', render:'renderGcalSettings', icon:'calendar_month' },
    { label:'Text Messaging', sub:'SMS confirmations & replies (httpSMS)', content:'sms-section', render:'renderSmsSettings', adminOnly:true, icon:'sms' },
    { label:'Back Office sync', sub:'Push daily sales & payroll to the books app', content:'bosync-section', render:'renderBoSyncSettings', adminOnly:true, icon:'sync' },
    { label:'Customer Directory', sub:'Browse synced customers', action:'showCustomerDir', icon:'contacts' },
  ]},
  { id:'business', title:'Business', desc:'Branding', items:[
    { label:'Business Logo', sub:'Header & report logo', content:'logo-section', icon:'image' },
    { label:'Receipt & Reviews', sub:'Re-routable review-QR link on printed receipts', content:'receipt-section', render:'renderReceiptSettings', adminOnly:true, icon:'reviews' },
  ]},
  { id:'data', title:'Data & System', desc:'Backup, logs & info', items:[
    { label:'Backup & Restore', sub:'Export / import data', content:'backup-section', icon:'backup' },
    { label:'Activity Log', sub:'All users, all devices', content:'settings-audit-section', render:'renderActivityLog', icon:'history' },
    { label:'Data Recovery', sub:'Find & restore lost check-ins', content:'settings-recovery-section', render:'renderRecoveryReport', adminOnly:true, icon:'restore_page' },
    { label:'Diagnostics', sub:'Automatic error log & bug alerts', content:'settings-diagnostics-section', render:'renderDiagnostics', adminOnly:true, icon:'bug_report' },
    { label:'App Info', sub:'Version & connection status', content:'appinfo-section', render:'renderAppInfo', icon:'info' },
  ]},
];
let _settingsView = 'root', _settingsCat = null;

function _hideAllSettingsSections() {
  const panel = document.getElementById('panel-settings');
  if (!panel) return;
  [...panel.children].forEach(ch => {
    if (ch.classList.contains('settings-nav-header') || ch.id === 'settings-root' || ch.id === 'settings-category') return;
    ch.classList.add('hidden');
  });
}
function _setSettingsHeader(title, desc, showBack) {
  const t = document.getElementById('settings-nav-title'); if (t) t.textContent = title;
  const d = document.getElementById('settings-nav-desc'); if (d) d.textContent = desc || '';
  const b = document.getElementById('settings-back-btn'); if (b) b.classList.toggle('hidden', !showBack);
}
// One iconned row, shared by the category drill-down list and the search results.
// `subText` overrides the default sub line (search shows "Category · sub").
function _settingsItemRow(it, subText) {
  return `<button onclick="${it.action ? it.action + '()' : `settingsOpenLeaf('${it.content}')`}" class="w-full flex items-center gap-4 px-5 py-4 bg-surface-container-lowest rounded-xl border border-surface-container-high mb-2 hover:bg-surface-container hover:border-primary/40 transition-colors text-left">
    <div class="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0"><span class="material-symbols-outlined text-primary">${it.icon || 'settings'}</span></div>
    <div class="min-w-0 flex-1"><div class="font-headline font-bold text-on-surface">${escHtml(it.label)}</div><div class="text-xs font-body text-on-surface-variant mt-0.5">${escHtml(subText != null ? subText : (it.sub || ''))}</div></div>
    <span class="material-symbols-outlined text-on-surface-variant flex-shrink-0">${it.action ? 'open_in_new' : 'chevron_right'}</span>
  </button>`;
}

export function settingsNavRoot() {
  _settingsView = 'root'; _settingsCat = null;
  _hideAllSettingsSections();
  document.getElementById('settings-category')?.classList.add('hidden');
  const sInput = document.getElementById('settings-search'); if (sInput) sInput.value = '';
  document.getElementById('settings-search-clear')?.classList.add('hidden');
  document.getElementById('settings-results')?.classList.add('hidden');
  document.getElementById('settings-search-wrap')?.classList.remove('hidden');
  document.getElementById('settings-root')?.classList.remove('hidden');
  _setSettingsHeader('Settings', 'Configure app behavior and customer options', false);
}

// Live filter across the whole settings tree → jump straight to any leaf.
export function filterSettings(q) {
  const query = (q || '').trim().toLowerCase();
  document.getElementById('settings-search-clear')?.classList.toggle('hidden', !query);
  const results = document.getElementById('settings-results');
  const root = document.getElementById('settings-root');
  if (!query) { if (results) { results.classList.add('hidden'); results.innerHTML = ''; } root?.classList.remove('hidden'); return; }
  _settingsCat = null;   // searching resets category context so Back returns to the root
  const isAdmin = getActiveUser()?.role === 'admin';
  const matches = [];
  SETTINGS_NAV.forEach(g => g.items.forEach(it => {
    if (it.hidden || (it.adminOnly && !isAdmin) || (it.perm && !canDo(it.perm))) return;
    if ((it.label + ' ' + (it.sub || '') + ' ' + g.title).toLowerCase().includes(query)) matches.push({ ...it, cat: g.title });
  }));
  root?.classList.add('hidden');
  document.getElementById('settings-category')?.classList.add('hidden');
  if (!results) return;
  results.innerHTML = matches.length === 0
    ? `<p class="text-sm font-body text-on-surface-variant px-1 py-3">No settings match “${escHtml(query)}”.</p>`
    : matches.map(it => _settingsItemRow(it, it.cat + (it.sub ? ' · ' + it.sub : ''))).join('');
  results.classList.remove('hidden');
}
export function clearSettingsSearch() { const i = document.getElementById('settings-search'); if (i) { i.value = ''; filterSettings(''); i.focus(); } }
export function settingsOpenCategory(catId) {
  const g = SETTINGS_NAV.find(x => x.id === catId); if (!g) return;
  _settingsView = 'cat'; _settingsCat = catId;
  _hideAllSettingsSections();
  document.getElementById('settings-root')?.classList.add('hidden');
  const isAdmin = getActiveUser()?.role === 'admin';
  const list = document.getElementById('settings-category');
  const items = g.items.filter(it => !it.hidden && (!it.adminOnly || isAdmin) && (!it.perm || canDo(it.perm)));
  list.innerHTML = items.length === 0 ? '<p class="text-sm font-body text-on-surface-variant px-1 py-3">Your role doesn’t have access to these settings.</p>' : items.map(it => _settingsItemRow(it)).join('');
  list.classList.remove('hidden');
  _setSettingsHeader(g.title, g.desc, true);
}
export function settingsOpenLeaf(contentId) {
  let item = null;
  SETTINGS_NAV.forEach(g => g.items.forEach(it => { if (it.content === contentId) item = it; }));
  if (item?.adminOnly && getActiveUser()?.role !== 'admin') { showToast('Admin only.'); return; }
  if (item?.perm && !canDo(item.perm)) { showToast(`Your role doesn’t have access to ${item.label}.`); return; }
  _settingsView = 'leaf';
  _hideAllSettingsSections();
  document.getElementById('settings-root')?.classList.add('hidden');
  document.getElementById('settings-category')?.classList.add('hidden');
  if (item?.render) window[item.render]?.();
  const content = document.getElementById(contentId);
  if (content) {
    const wrapper = content.parentElement;
    if (wrapper) wrapper.classList.remove('hidden');
    content.classList.remove('hidden');
    const hdr = wrapper?.querySelector(':scope > button'); if (hdr) hdr.classList.add('hidden');
  }
  _setSettingsHeader(item?.label || 'Settings', '', true);
}
export function settingsBack() {
  if (_settingsView === 'leaf' && _settingsCat) settingsOpenCategory(_settingsCat);
  else settingsNavRoot();
}

export function renderSettingsPanel() {
  renderServicesMerged();
  renderSettingsItems();
  renderSettingsFees();
  renderRolePermissions();
  initCalHoursSelectors();
  window.renderCalAutoHideSetting?.();
  window.renderApptReminderSettings?.();
  const lbl = document.getElementById('last-backup-label'); if (lbl) lbl.textContent = localStorage.getItem('turndesk_last_backup') || 'Never';
  setLogo();
  const sqStatus = document.getElementById('settings-square-status'), sqInput = document.getElementById('settings-location-id'), sqAppInput = document.getElementById('settings-app-id');
  if (sqStatus) sqStatus.textContent = cfg().square_config ? `✓ Connected — Location: ${cfg().square_config.locationId}` : 'Not connected';
  if (sqInput && cfg().square_config?.locationId) sqInput.value = cfg().square_config.locationId;
  if (sqAppInput && cfg().square_config?.applicationId) sqAppInput.value = cfg().square_config.applicationId;
  window.renderTerminalStatus?.();
  const c = getTurnConfig();
  const fi = document.getElementById('thresh-full'), hi = document.getElementById('thresh-half');
  if (fi) fi.value = c.fullMin;
  if (hi) hi.value = c.halfMin;
  renderBonusServicesList();
  settingsNavRoot();
}
