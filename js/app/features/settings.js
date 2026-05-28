// ── Settings panel ──────────────────────────────────────────────────────────
import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { showToast } from '../utils.js';
import { canDo, getActiveUser, ui } from '../session.js';
import { DEFAULT_ROLE_PERMISSIONS, APP_VERSION, STATE_PROXY } from '../config.js';
import { renderServicesMerged, renderSettingsItems, renderSettingsFees } from './catalog.js';
import { setLogo } from './photos.js';
import { getTurnConfig, saveTurnConfig, isAlwaysBonusService, saveBonusServices } from './turns.js';
import { loadSquareCustomers } from './square-customers.js';

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
  refund: 'Issue Refunds', viewReports: 'View Reports & Transactions',
  manageStaff: 'Manage Staff', manageServices: 'Manage Services & Catalog',
};
function rolePerms() {
  const stored = cfg().role_permissions;
  return (stored && Object.keys(stored).length) ? stored : DEFAULT_ROLE_PERMISSIONS;
}
export function renderRolePermissions() {
  const el = document.getElementById('role-permissions-list');
  if (!el) return;
  const rp = rolePerms();
  const roles = Object.keys(rp);
  el.innerHTML = roles.length === 0 ? '<p class="text-sm font-body text-on-surface-variant">No configurable roles found.</p>'
    : roles.map(role => `<div class="mb-5 last:mb-0"><div class="font-headline font-semibold text-on-surface text-sm mb-2 capitalize">${role}</div>
      <div class="bg-surface-container-lowest rounded-xl border border-surface-container-high overflow-hidden">
        ${Object.entries(_PERM_LABELS).map(([perm,label]) => { const enabled = rp[role]?.[perm] ?? false; return `<div class="flex items-center justify-between px-4 py-2.5 border-b border-surface-container-high last:border-0"><span class="text-sm font-body text-on-surface">${label}</span><button onclick="toggleRolePermission('${role}','${perm}')" class="mswitch relative w-14 h-7 rounded-full transition-colors flex-shrink-0 ml-4 ${enabled?'bg-primary':'bg-surface-container-high'}"><div class="absolute top-0.5 w-6 h-6 rounded-full bg-white shadow transition-all ${enabled?'left-7':'left-0.5'}"></div></button></div>`; }).join('')}
      </div></div>`).join('');
}
export function toggleRolePermission(role, perm) {
  const rp = JSON.parse(JSON.stringify(rolePerms()));
  if (!rp[role]) rp[role] = {};
  rp[role][perm] = !rp[role][perm];
  dispatch('config.set', { key: 'role_permissions', value: rp });
  renderRolePermissions();
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

// ── Audit log (synced — deletions + refunds, read from the DO snapshot) ─────────
// Cross-device: deletion details (reason/by/at) live in the DO (deletion:* keys)
// and refunds are records with status 'refund'. Pulled on demand (manual button /
// leaf open). Falls back to this device's local deletion log if the server is
// unreachable (offline).
export async function loadAuditLog() {
  const el = document.getElementById('audit-log-content');
  if (!el) return;
  el.innerHTML = '<p class="text-sm text-on-surface-variant">Loading…</p>';
  try {
    const res = await fetch(`${STATE_PROXY}/snapshot`, { cache: 'no-store' });
    if (!res.ok) throw new Error('snapshot ' + res.status);
    const st = (await res.json()).state || {};
    const recById = {};
    (st.records || []).forEach(r => { recById[String(r.id)] = r; });
    const events = [];
    (st.deletions || []).forEach(d => {
      if (!d || typeof d !== 'object') return;   // older snapshots stored bare ids — no detail to show
      const rec = recById[String(d.id)];
      events.push({ type: 'delete', at: d.at, by: d.by || '—', reason: d.reason || '', name: rec?.name || '—', amount: rec?.totalCost ?? null });
    });
    (st.records || []).filter(r => r.status === 'refund').forEach(r => {
      events.push({ type: 'refund', at: r.completedAt || r.checkinTime, by: r.loggedBy || '—', reason: r.discountNote || '', name: r.name || '—', amount: r.totalCost });
    });
    events.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
    el.innerHTML = events.length ? events.map(auditRowHtml).join('') : '<p class="text-sm text-on-surface-variant">No deletions or refunds recorded.</p>';
  } catch (e) {
    el.innerHTML = auditFallbackHtml();
  }
}
function auditRowHtml(ev) {
  const dt = ev.at ? new Date(ev.at) : null;
  const when = dt && !isNaN(dt) ? `${dt.toLocaleDateString()} ${dt.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}` : '—';
  const isDel = ev.type === 'delete';
  const badgeBg = isDel ? '#fa746f' : '#f5c870', badgeFg = isDel ? '#ffffff' : '#3a2800';
  const amt = ev.amount != null ? `$${Math.abs(ev.amount).toFixed(2)}` : '';
  return `<div class="bg-surface-container rounded-xl px-4 py-3 text-sm font-body border border-surface-container-high">
    <div class="flex items-center justify-between mb-1 gap-2">
      <div class="flex items-center gap-2 min-w-0"><span class="text-[10px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0" style="background:${badgeBg};color:${badgeFg}">${isDel ? 'Deleted' : 'Refund'}</span><span class="font-semibold text-on-surface truncate">${ev.name}</span></div>
      <span class="text-xs text-outline flex-shrink-0">${when}</span>
    </div>
    <div class="text-xs text-on-surface-variant">By ${ev.by}${amt ? ' · ' + amt : ''}</div>
    ${ev.reason ? `<div class="text-xs text-outline mt-1">Reason: ${ev.reason}</div>` : ''}
  </div>`;
}
function auditFallbackHtml() {
  const log = JSON.parse(localStorage.getItem('turndesk_deletion_log') || '[]');
  const head = '<p class="text-xs text-error mb-2">Couldn’t reach the server — showing this device’s local deletion log only.</p>';
  if (!log.length) return head + '<p class="text-sm text-on-surface-variant">No local audit entries.</p>';
  return head + [...log].reverse().map(entry => { const dt = new Date(entry.deletedAt); return `<div class="bg-surface-container rounded-xl px-4 py-3 text-sm font-body border border-surface-container-high"><div class="flex items-center justify-between mb-1"><span class="font-semibold text-on-surface">${entry.name || '—'}</span><span class="text-xs text-outline">${dt.toLocaleDateString()} ${dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span></div><div class="text-xs text-on-surface-variant">Deleted by ${entry.deletedBy} · $${(entry.total||0).toFixed(2)}</div>${entry.reason?`<div class="text-xs text-outline mt-1">Reason: ${entry.reason}</div>`:''}</div>`; }).join('');
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
  loadSquareCustomers();
  showToast('Square connected ✓');
}

export function syncSquareFromSettings() {
  if (!cfg().square_config) { showToast('Connect a Location ID first.'); return; }
  window.syncSquare?.();
}

// ── Google Calendar (Integrations leaf) ───────────
function gcalConnected() {
  try { const l = JSON.parse(localStorage.getItem('turndesk_gcal_token') || 'null'); if (l && Date.now() < l.expires - 60000) return true; } catch (e) {}
  const s = cfg().turndesk_gcal_token;
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
  ];
  el.innerHTML = rows.map(([k, v]) => `
    <div class="flex items-center justify-between px-4 py-3 border-b border-surface-container-high last:border-0">
      <span class="text-sm font-body text-on-surface-variant">${k}</span>
      <span class="text-sm font-body font-semibold text-on-surface text-right break-all ml-4">${v}</span>
    </div>`).join('');
}

// ── First-time setup wizard ───────────────────────
export function showSetupWizard() { const w = document.getElementById('setup-wizard'); if (!w) return; w.classList.remove('hidden'); w.style.display = 'flex'; setTimeout(() => document.getElementById('setup-location-id')?.focus(), 300); }
export function hideSetupWizard() { const w = document.getElementById('setup-wizard'); if (!w) return; w.classList.add('hidden'); w.style.display = ''; }
export function completeSetup() {
  const locationId = document.getElementById('setup-location-id')?.value.trim();
  if (!locationId) { showToast('Please enter your Square Location ID.'); return; }
  dispatch('config.set', { key: 'square_config', value: { locationId } });
  hideSetupWizard(); loadSquareCustomers();
  showToast('Connected to Square ✓');
}
export function skipSetup() { sessionStorage.setItem('turndesk_setup_skipped', '1'); hideSetupWizard(); showToast('Running without Square. You can connect later in Settings.'); }

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
      <p class="text-[11px] font-body text-on-surface-variant mt-1">Repeats every ${type==='biweekly'?'14':'7'} days from this date — e.g., a Monday start runs Mon–Sun.</p>` : ''}`;
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
    { label:'Services', sub:'Add, edit, delete & visibility', content:'services-merged-section', render:'renderServicesMerged' },
    { label:'Retail Items', sub:'Add-on items', content:'items-section' },
    { label:'Fees', sub:'Flat or percentage fees', content:'fees-section' },
  ]},
  { id:'staff', title:'Staff & Access', desc:'People & permissions', items:[
    { label:'Technicians', sub:'Staff, photos, schedule & active toggle', content:'staff-merged-section', render:'renderStaffMerged' },
    { label:'Front Desk Users', sub:'Dashboard PIN login accounts', content:'fdusers-merged-section', render:'renderFdUsersList' },
    { label:'Role Permissions', sub:'What each role can do', content:'settings-perms-section', render:'renderRolePermissions', adminOnly:true },
  ]},
  { id:'workflow', title:'Workflow', desc:'How the floor runs', items:[
    { label:'Turn Thresholds', sub:'Full / half / bonus cutoffs', content:'turns-thresh-section' },
    { label:'Stations', sub:'Add, rename & delete pedicure / manicure seats', content:'settings-stations-section', render:'renderStationsSettings' },
    { label:'Pay Period', sub:'Weekly / bi-weekly / bi-monthly for the quick button', content:'settings-payperiod-section', render:'renderPayPeriodSettings', adminOnly:true },
    { label:'Commission & Refunds', sub:'Whether refunds reduce tech commission', content:'settings-commission-section', render:'renderCommissionSettings', adminOnly:true },
    { label:'Numpad Entry', sub:'Cents or whole dollars', content:'settings-numpad-section', render:'renderNumpadSettings' },
    { label:'Calendar Hours', sub:'Visible time range', content:'settings-calhours-section' },
  ]},
  { id:'integrations', title:'Integrations', desc:'Square & Google', items:[
    { label:'Square', sub:'Location, connection & sync', content:'square-section' },
    { label:'Google Calendar', sub:'Connect for appointments', content:'gcal-section', render:'renderGcalSettings' },
    { label:'Customer Directory', sub:'Browse synced customers', action:'showCustomerDir' },
  ]},
  { id:'business', title:'Business', desc:'Branding', items:[
    { label:'Business Logo', sub:'Header & report logo', content:'logo-section' },
  ]},
  { id:'data', title:'Data & System', desc:'Backup, logs & info', items:[
    { label:'Backup & Restore', sub:'Export / import data', content:'backup-section' },
    { label:'Activity Log', sub:'All users, all devices', content:'settings-audit-section', render:'renderActivityLog' },
    { label:'Data Recovery', sub:'Find & restore lost check-ins', content:'settings-recovery-section', render:'renderRecoveryReport', adminOnly:true },
    { label:'App Info', sub:'Version & connection status', content:'appinfo-section', render:'renderAppInfo' },
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
export function settingsNavRoot() {
  _settingsView = 'root'; _settingsCat = null;
  _hideAllSettingsSections();
  document.getElementById('settings-category')?.classList.add('hidden');
  document.getElementById('settings-root')?.classList.remove('hidden');
  _setSettingsHeader('Settings', 'Configure app behavior and customer options', false);
}
export function settingsOpenCategory(catId) {
  const g = SETTINGS_NAV.find(x => x.id === catId); if (!g) return;
  _settingsView = 'cat'; _settingsCat = catId;
  _hideAllSettingsSections();
  document.getElementById('settings-root')?.classList.add('hidden');
  const isAdmin = getActiveUser()?.role === 'admin';
  const list = document.getElementById('settings-category');
  list.innerHTML = g.items.filter(it => !it.adminOnly || isAdmin).map(it => `
    <button onclick="${it.action ? it.action + '()' : `settingsOpenLeaf('${it.content}')`}" class="w-full flex items-center justify-between px-5 py-4 bg-surface-container-lowest rounded-xl border border-surface-container-high mb-2 hover:bg-surface-container transition-colors text-left">
      <div><div class="font-headline font-bold text-on-surface">${it.label}</div><div class="text-xs font-body text-on-surface-variant mt-0.5">${it.sub || ''}</div></div>
      <span class="material-symbols-outlined text-on-surface-variant">${it.action ? 'open_in_new' : 'chevron_right'}</span>
    </button>`).join('');
  list.classList.remove('hidden');
  _setSettingsHeader(g.title, g.desc, true);
}
export function settingsOpenLeaf(contentId) {
  let item = null;
  SETTINGS_NAV.forEach(g => g.items.forEach(it => { if (it.content === contentId) item = it; }));
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
  const c = getTurnConfig();
  const fi = document.getElementById('thresh-full'), hi = document.getElementById('thresh-half');
  if (fi) fi.value = c.fullMin;
  if (hi) hi.value = c.halfMin;
  renderBonusServicesList();
  settingsNavRoot();
}
