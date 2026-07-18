// ── Queue: live queue render, status flow, modals (assign/pricing, split/merge) ─
// Reads the queue from the store; persists every change via dispatch('queue.upsert'
// | 'queue.remove'). Modal editing mutates the in-store entry as a local buffer and
// commits with a dispatch on save (matching the original "edit then save" UX).

import { getState } from '../store.js';
import { dispatch, DEVICE_ID } from '../sync.js';
import { showToast, formatElapsed, byName, todayStr, localDateStr, openNumpad, commitNumpad, partyLetterMap, newEntryId, ticketTotal, escHtml, escAttrJs, dateBtnLabel } from '../utils.js';
import { GROUP_COLORS } from '../config.js';
import { scopedKey } from '../apptoken.js';   // per-salon isolation for the device-local turns-history snapshot
import { ui, canDo, getActiveUser } from '../session.js';
import { getAssignmentStatus, applyEntryStatus, applyAssignmentStatus, setAssignmentStatus, isPaidStatus, serviceLineStyle, effectiveServiceStatus, isAwaitingPrice } from './status.js';
import { isServiceVisibleOnDash } from './catalog.js';
import { serviceTimeInfo } from './servicetime.js';
import { squareUpsertCustomer, upsertPartyCustomers, showEditCustomer, customerDirectory, closeCustomerNote, customerNeedsUpdate, customerNote, notePhoneKey, cardNotePreview } from './square-customers.js';

const cfg   = () => getState().config;
const q     = () => getState().queue;
const svc   = id => cfg().services.find(s => s.id === id);
const staffById = id => cfg().staff.find(s => s.id === id);
const activeStaff = () => cfg().staff.filter(s => !cfg().inactive_staff.includes(s.id));
// ── Station categories + stations (editable in Settings; synced as config) ────
// A CATEGORY = { id, label, color, w, h } stored in config.station_categories.
//   id    = STABLE key referenced by station.type (renaming only changes label).
//   color = floor-plan accent; w/h = default tile size for that category's stations.
// A STATION = { id, type, label } in config.stations. id is the STABLE key (used as
// the a.station value + station_layout key), so renaming only changes the label and
// never breaks seated customers, floor layout, or historical records. When either
// list is empty we fall back to the original Pedicure/Manicure defaults, so existing
// installs behave identically until the operator edits them.
export const DEFAULT_CATEGORIES = [
  { id: 'P', label: 'Pedicure', color: '#1a5c7a', w: 152, h: 116, maxTechs: 3 },
  { id: 'M', label: 'Manicure', color: '#785a1a', w: 108, h: 70,  maxTechs: 1 },
];
export const DEFAULT_STATIONS = [
  ...Array.from({length:12}, (_,i)=>({ id:`P${i+1}`, type:'P', label:`P${i+1}` })),
  ...Array.from({length:15}, (_,i)=>({ id:`M${i+1}`, type:'M', label:`M${i+1}` })),
];
const CATEGORY_PALETTE = ['#1a5c7a','#785a1a','#5c3d8f','#2a7a4f','#7a2a1a','#1a5252','#7a1a5c'];
export function stationCategories() { const c = cfg().station_categories; return Array.isArray(c) && c.length ? c : DEFAULT_CATEGORIES; }
export function categoryDef(typeId) { const cats = stationCategories(); return cats.find(c => c.id === typeId) || cats[0]; }
export function stationDefs() { const s = cfg().stations; return Array.isArray(s) && s.length ? s : DEFAULT_STATIONS; }
export function getStations()  { return stationDefs().map(s => s.id); }
export function stationType(id) { const d = stationDefs().find(s => s.id === id); return d ? d.type : (id && id[0] === 'M' ? 'M' : 'P'); }
export function stationLabel(id){ const d = stationDefs().find(s => s.id === id); return d ? (d.label || d.id) : id; }
function commitStations(next) { dispatch('config.set', { key: 'stations', value: next }); }
function commitCategories(next) { dispatch('config.set', { key: 'station_categories', value: next }); }

// ── Category CRUD ─────────────────────────────────────────────────────────────
export function addStationCategory() {
  const cats = stationCategories().map(c => ({ ...c }));
  const ids = new Set(cats.map(c => c.id));
  let id = '';
  for (let i = 0; i < 26; i++) { const ch = String.fromCharCode(65 + i); if (!ids.has(ch)) { id = ch; break; } }
  if (!id) { let n = 1; while (ids.has(`C${n}`)) n++; id = `C${n}`; }
  cats.push({ id, label: 'New Category', color: CATEGORY_PALETTE[cats.length % CATEGORY_PALETTE.length], w: 130, h: 90, maxTechs: 1 });
  commitCategories(cats);
  return id;
}
export function renameStationCategory(id, label) {
  commitCategories(stationCategories().map(c => c.id === id ? { ...c, label: (label || '').trim() || c.id } : { ...c }));
}
export function setStationCategoryColor(id, color) {
  commitCategories(stationCategories().map(c => c.id === id ? { ...c, color: color || c.color } : { ...c }));
}
// Max concurrent techs a station of this category can hold (e.g. pedicure 3, manicure 1).
// Drives the floor-plan capacity check on tech-drag + how many avatars a tile shows.
export function setStationCategoryMaxTechs(id, n) {
  const v = Math.max(1, Math.min(9, parseInt(n, 10) || 1));
  commitCategories(stationCategories().map(c => c.id === id ? { ...c, maxTechs: v } : { ...c }));
}
export function categoryMaxTechs(typeId) { return Math.max(1, parseInt(categoryDef(typeId)?.maxTechs, 10) || 1); }
export function deleteStationCategory(id) {
  if (stationCategories().length <= 1) { showToast('Keep at least one category'); return false; }
  const used = stationDefs().some(s => s.type === id);
  if (used) { showToast(`Move or remove this category's stations first`); return false; }
  commitCategories(stationCategories().filter(c => c.id !== id).map(c => ({ ...c })));
  return true;
}
export function confirmDeleteStationCategory(id) {
  const cat = categoryDef(id);
  const doDel = () => { if (deleteStationCategory(id)) renderStationsSettings(); };
  if (window.showWarnModal) window.showWarnModal('Delete category?', `Remove the "${cat?.label || id}" category?`, doDel);
  else if (confirm(`Delete category ${cat?.label || id}?`)) doDel();
}

// ── Station CRUD ──────────────────────────────────────────────────────────────
export function addStation(type) {
  const cats = stationCategories();
  const t = cats.some(c => c.id === type) ? type : cats[0].id;
  const defs = stationDefs().map(s => ({ ...s }));
  const ids = new Set(defs.map(s => s.id));
  let n = 1; while (ids.has(`${t}${n}`)) n++;
  const id = `${t}${n}`;
  defs.push({ id, type: t, label: id });
  commitStations(defs);
  return id;
}
export function renameStation(id, label) {
  commitStations(stationDefs().map(s => s.id === id ? { ...s, label: (label || '').trim() || s.id } : { ...s }));
}
export function setStationType(id, type) {
  const t = stationCategories().some(c => c.id === type) ? type : stationCategories()[0].id;
  commitStations(stationDefs().map(s => s.id === id ? { ...s, type: t } : { ...s }));
}
export function deleteStation(id) {
  const seated = q().some(e => !isPaidStatus(e.status) && (e.station === id || (e.assignments || []).some(a => a.station === id)));
  if (seated) { showToast(`Can't delete ${stationLabel(id)} — a customer is seated there`); return false; }
  commitStations(stationDefs().filter(s => s.id !== id).map(s => ({ ...s })));
  return true;
}
export function confirmDeleteStation(id) {
  const doDel = () => { if (deleteStation(id)) renderStationsSettings(); };
  if (window.showWarnModal) window.showWarnModal('Delete station?', `Remove ${stationLabel(id)} from the floor plan and the station picker?`, doDel);
  else if (confirm(`Delete ${stationLabel(id)}?`)) doDel();
}
export function renderStationsSettings() {
  const el = document.getElementById('settings-stations-section'); if (!el) return;
  const defs = stationDefs();
  const cats = stationCategories();
  const typeOpts = sel => cats.map(c => `<option value="${c.id}" ${sel===c.id?'selected':''}>${(c.label||c.id).replace(/"/g,'&quot;')}</option>`).join('');
  const group = cat => {
    const list = defs.filter(s => s.type === cat.id);
    const rows = list.map(s => `
      <div class="flex items-center gap-2 bg-surface-container-lowest rounded-xl px-3 py-2 border border-surface-container-high">
        <input value="${(s.label || s.id).replace(/"/g,'&quot;')}" onchange="renameStation('${s.id}',this.value);renderStationsSettings()"
          class="flex-1 bg-transparent border-b border-surface-container-high py-1 text-sm font-headline focus:border-primary outline-none">
        <select onchange="setStationType('${s.id}',this.value);renderStationsSettings()" class="text-xs font-body border border-surface-container-high rounded-lg px-1.5 py-1 bg-transparent">
          ${typeOpts(s.type)}
        </select>
        <button onclick="confirmDeleteStation('${s.id}')" class="w-8 h-8 rounded-lg text-outline hover:text-error hover:bg-error/10 flex items-center justify-center flex-shrink-0"><span class="material-symbols-outlined" style="font-size:18px">delete</span></button>
      </div>`).join('');
    return `<div class="mb-4 border border-surface-container-high rounded-2xl p-3">
      <div class="flex items-center gap-2 mb-2">
        <input type="color" value="${cat.color || '#1a5c7a'}" onchange="setStationCategoryColor('${cat.id}',this.value);renderStationsSettings()" title="Floor-plan color"
          class="w-7 h-7 rounded-lg border border-surface-container-high bg-transparent cursor-pointer flex-shrink-0 p-0">
        <input value="${(cat.label || cat.id).replace(/"/g,'&quot;')}" onchange="renameStationCategory('${cat.id}',this.value);renderStationsSettings()"
          class="flex-1 bg-transparent border-b border-surface-container-high py-1 text-sm font-headline font-semibold focus:border-primary outline-none">
        <label class="text-[11px] font-body text-on-surface-variant flex items-center gap-1 flex-shrink-0" title="Max techs that can work one customer at this kind of station at once">techs
          <input type="number" min="1" max="9" value="${cat.maxTechs || 1}" onchange="setStationCategoryMaxTechs('${cat.id}',this.value);renderStationsSettings()"
            class="w-11 bg-transparent border border-surface-container-high rounded-lg px-1 py-1 text-xs font-body text-center focus:border-primary outline-none"></label>
        <span class="text-xs font-body text-on-surface-variant">(${list.length})</span>
        <button onclick="addStation('${cat.id}');renderStationsSettings()" class="text-xs font-headline font-bold text-primary flex items-center gap-1 hover:opacity-70"><span class="material-symbols-outlined" style="font-size:16px">add</span>Station</button>
        <button onclick="confirmDeleteStationCategory('${cat.id}')" title="Delete category" class="w-8 h-8 rounded-lg text-outline hover:text-error hover:bg-error/10 flex items-center justify-center flex-shrink-0"><span class="material-symbols-outlined" style="font-size:18px">delete_sweep</span></button>
      </div>
      <div class="space-y-1.5">${rows || '<div class="text-xs font-body text-on-surface-variant italic px-1">No stations yet</div>'}</div>
    </div>`;
  };
  el.innerHTML = `
    <p class="text-xs font-body text-on-surface-variant mb-4">Categories group stations on the Floor Plan (each has its own color &amp; zone). Stations appear on the Floor Plan and in the Assign &amp; Price station picker. Renaming keeps history intact; a station can't be deleted while a customer is seated there, and a category can't be deleted while it still has stations.</p>
    ${cats.map(group).join('')}
    <button onclick="addStationCategory();renderStationsSettings()" class="w-full mt-1 py-2.5 rounded-xl border border-dashed border-surface-container-high text-sm font-headline font-bold text-primary flex items-center justify-center gap-1 hover:bg-primary/5"><span class="material-symbols-outlined" style="font-size:18px">add</span>Add category</button>`;
}

// Single write path for queue entries. A FINALIZED (paid) entry mirrors to its record on
// every change — so the record (the source of truth for reports/edits) can never silently
// diverge from the board (the bug behind 3 records losing a $2 fee). saveRecord is
// idempotent (overwrites by id), so the redundant save on already-record-saving paths
// (updateStatus) is harmless. Non-paid edits don't touch records.
const upsert = entry => { dispatch('queue.upsert', { entry }); if (isPaidStatus(entry.status)) window.saveRecord?.(entry); };

// ── Queue history (read-only past-day view) ───────
// Source: the daily turns-history snapshot (turns.js archives q() into
// turndesk_turns_history each night), so a past day's queue is recoverable without
// any extra storage. View is read-only — actions only make sense on today's live queue.
let queueViewingHistory = null;

export function openQueueHistoryPicker(ev) {
  const today = new Date();
  const presets = [0, 1, 2, 3, 4, 5, 6].map(n => {
    const d = new Date(today); d.setDate(d.getDate() - n);
    return { label: n === 0 ? 'Today' : n === 1 ? 'Yesterday' : `${n} days ago`, date: localDateStr(d) };
  });
  window.openDayPicker?.(ev, { value: (queueViewingHistory && queueViewingHistory.date) || todayStr(), onPick: loadQueueHistory, presets });
}
export function loadQueueHistory(dateStr) {
  if (!dateStr || dateStr === todayStr()) { clearQueueHistory(); return; }
  const hist = JSON.parse(localStorage.getItem(scopedKey('turndesk_turns_history')) || '{}')[dateStr];
  queueViewingHistory = { date: dateStr, snapshot: (hist && hist.snapshot) || [] };
  const btn = document.getElementById('queue-date-btn-val'); if (btn) btn.textContent = dateBtnLabel(dateStr);
  renderQueue();
}
export function clearQueueHistory() {
  queueViewingHistory = null;
  const btn = document.getElementById('queue-date-btn-val'); if (btn) btn.textContent = dateBtnLabel(null);
  renderQueue();
}
// Prev/next-day arrows on the Date bubble. Stepping to today (or a future day) returns
// to the live view; you can't go past today (no future queue history).
export function shiftQueueDate(dir) {
  const cur = queueViewingHistory ? new Date(queueViewingHistory.date + 'T12:00:00') : new Date();
  cur.setDate(cur.getDate() + dir);
  const today = new Date(); today.setHours(0,0,0,0); cur.setHours(0,0,0,0);
  if (cur >= today) { clearQueueHistory(); return; }
  loadQueueHistory(localDateStr(cur));
}

function renderQueueHistoryView(list, empty) {
  const { date, snapshot } = queueViewingHistory;
  empty?.classList.add('hidden');
  const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday:'long', month:'short', day:'numeric' });
  const banner = `<div class="bg-secondary-container/30 rounded-xl px-4 py-2 mb-3 text-sm font-body text-on-surface-variant flex items-center gap-2"><span class="material-symbols-outlined" style="font-size:16px">history</span> Viewing ${dateLabel} — read only</div>`;
  // Source from synced transaction records for the day (reliable + cross-device — the
  // same source Reports & Turns history use). The device-local snapshot was unreliable
  // (only written if archiveTurnsForToday ran on THIS device), so it's just a fallback.
  const recs = (window.buildCombinedRecords?.() || [])
    .filter(r => isPaidStatus(r.status) && localDateStr(new Date(r.checkinTime)) === date)
    .map(r => ({ id: r.id, name: r.name, phone: r.phone || '', services: r.services || [], assignments: r.assignments || [], totalCost: r.totalCost || 0, status: r.status, checkinTime: r.checkinTime }));
  const entries = recs.length ? recs : (snapshot || []);
  if (entries.length === 0) { list.innerHTML = banner + '<div class="text-center py-12 text-on-surface-variant text-sm font-body">No queue records saved for this day.</div>'; return; }
  const badge = { waiting:'badge-waiting', inservice:'badge-inservice', complete:'badge-complete', paid:'badge-done', done:'badge-done' };
  const groups = [ { key:'waiting', label:'Waiting' }, { key:'inservice', label:'In Service' }, { key:'complete', label:'Complete' }, { key:'paid', label:'Paid' } ];
  const row = e => {
    const techs = [...new Set((e.assignments||[]).filter(a=>a.techId).map(a=>staffById(a.techId)?.name).filter(Boolean))].join(', ');
    const svcs = (e.services||[]).map(sid => svc(sid)?.label || sid).join(', ') || '—';
    const time = new Date(e.checkinTime).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    return `<div class="bg-surface-container-lowest rounded-xl px-5 py-3 border border-surface-container-high flex items-center justify-between opacity-90">
      <div class="min-w-0"><div class="flex items-center gap-2 flex-wrap"><span class="font-headline font-semibold text-on-surface text-sm">${e.name}</span><span class="text-[11px] px-2 py-0.5 rounded-full font-body font-semibold ${badge[e.status]||'badge-done'}">${e.status}</span></div>
        <div class="text-xs font-body text-on-surface-variant">${svcs}${techs ? ' · ' + techs : ''}</div>
        <div class="text-[11px] font-body text-outline">${time}</div></div>
      <div class="font-headline font-bold text-on-surface flex-shrink-0 ml-3">$${(e.totalCost||0).toFixed(2)}</div></div>`;
  };
  list.innerHTML = banner + groups.map(g => {
    const inGroup = entries.filter(e => g.key === 'paid' ? isPaidStatus(e.status) : e.status === g.key);
    if (!inGroup.length) return '';
    return `<div class="mb-4"><div class="flex items-center gap-2 mb-2"><span class="text-[11px] font-headline font-bold uppercase tracking-widest text-on-surface-variant">${g.label}</span><span class="text-[11px] font-body text-on-surface-variant opacity-60">(${inGroup.length})</span><div class="flex-grow h-px bg-surface-container-high ml-1"></div></div><div class="space-y-2">${inGroup.map(row).join('')}</div></div>`;
  }).join('');
}

// ── Render ────────────────────────────────────────
let _partyLetters = new Map();   // groupId → A/B/C tag for the current queue render
export function renderQueue() {
  const list = document.getElementById('queue-list');
  const empty = document.getElementById('queue-empty');
  if (!list) return;
  healLoneGroups();   // a 1-person "group" auto-ungroups (e.g. a split that left one behind)
  _partyLetters = partyLetterMap(q());   // assign party letters across the whole queue (stable across status sections)
  if (queueViewingHistory) { renderQueueHistoryView(list, empty); return; }
  const _qd = document.getElementById('queue-date-btn-val'); if (_qd) _qd.textContent = dateBtnLabel(null);
  let filtered = ui.currentFilter === 'all' ? [...q()] : q().filter(e => ui.currentFilter === 'paid' ? isPaidStatus(e.status) : e.status === ui.currentFilter);
  if (ui.currentFilter === 'all' && !ui.showDoneInQueue) filtered = filtered.filter(e => !isPaidStatus(e.status));
  const order = { waiting: 0, inservice: 1, complete: 2, paid: 3, done: 3 };
  filtered.sort((a,b) => order[a.status] - order[b.status] || new Date(a.checkinTime) - new Date(b.checkinTime));

  if (filtered.length === 0) { list.innerHTML = ''; empty?.classList.remove('hidden'); return; }
  empty?.classList.add('hidden');

  if (ui.currentFilter === 'all') {
    const groups = [
      { key: 'waiting',   label: 'Waiting',    color: 'text-secondary' },
      { key: 'inservice', label: 'In Service', color: 'text-primary' },
      { key: 'complete',  label: 'Complete',   color: 'text-primary' },
      { key: 'paid',      label: 'Paid Today', color: 'text-outline' },
    ];
    list.innerHTML = groups.map(g => {
      // "Paid Today" shows only today's paid tickets, so the board self-cleans at midnight
      // even before the rollover clears yesterday's finished entries from storage.
      const entries = filtered.filter(e => g.key === 'paid' ? (isPaidStatus(e.status) && localDateStr(new Date(e.checkinTime)) === todayStr()) : e.status === g.key);
      if (entries.length === 0) return '';
      return `<div class="mb-4">
        <div class="flex items-center gap-2 mb-2">
          <span class="text-[11px] font-headline font-bold uppercase tracking-widest ${g.color}">${g.label}</span>
          <span class="text-[11px] font-body ${g.color} opacity-60">(${entries.length})</span>
          <div class="flex-grow h-px bg-surface-container-high ml-1"></div>
        </div>
        <div class="space-y-2">${entries.map(buildQueueRow).join('')}</div>
      </div>`;
    }).join('');
  } else {
    list.innerHTML = `<div class="space-y-2">${filtered.map(buildQueueRow).join('')}</div>`;
  }
}

// 1→1st, 2→2nd, 3→3rd, 11→11th, 12→12th, 21→21st …
function _ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

function buildQueueRow(e) {
  const t = new Date(e.checkinTime);
  const timeStr = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const serviceLabels = e.services.map(sid => svc(sid)?.label || sid).join(', ') || '—';
  const apptBadge = e.isAppointment ? `<span class="badge-appointment text-[10px] px-1.5 py-0.5 rounded-full font-body font-semibold">Appt</span>` : '';
  // R5: returning-customer badge (visit #, lifetime spend, usual tech) derived from transaction
  // records via reports.js (called on window to avoid a circular import). Only shown from the
  // 2nd visit on, so first-timers stay clean. A paid entry is already counted in records; a
  // not-yet-paid one is this upcoming visit, so add 1.
  const _vh = window.customerVisitSummary?.(e.phone, e.name);
  let visitBadge = '', visitSub = '';
  if (_vh) {
    const visitNum = _vh.visits + (isPaidStatus(e.status) ? 0 : 1);
    if (visitNum >= 2) {
      visitBadge = `<span class="text-[10px] px-1.5 py-0.5 rounded-full font-body font-semibold" style="background:#8fd4d3;color:#0f3d3d" title="Returning customer">★ ${_ordinal(visitNum)} visit</span>`;
      const techName = _vh.usualTechId ? (staffById(_vh.usualTechId)?.name || '') : '';
      const bits = [];
      if (_vh.totalSpent > 0) bits.push(`$${_vh.totalSpent.toFixed(0)} lifetime`);
      if (techName) bits.push(`usually w/ ${techName}`);
      if (bits.length) visitSub = `<div class="text-[10px] font-body font-semibold" style="color:#1a5252">${bits.join(' · ')}</div>`;
    }
  }
  // Per-service ROWS (not a joined string): each carries its own status glyph + pill, and only
  // the in-service row gets the bold green bar+tint — so a mixed-status customer reads at a glance.
  const assignSummary = (e.assignments || []).filter(a => a.techId || a.cost).map(a => {
    const tech = staffById(a.techId), s = svc(a.serviceId);
    const ls = serviceLineStyle(effectiveServiceStatus(e, a));
    const hot = ls.key === 'inservice';
    const sti = serviceTimeInfo(a);
    const tip = sti ? `<span class="flex-shrink-0" style="color:${sti.color};font-weight:700;margin-left:auto">${sti.text}</span>` : '';
    const rowStyle = `border-left:${hot ? 3 : 2}px solid ${ls.bar};padding-left:5px;${ls.tint ? `background:${ls.tint};` : ''}${ls.rowOpacity < 1 ? `opacity:${ls.rowOpacity};` : ''}`;
    return `<div class="flex items-center gap-1 leading-tight rounded-r" style="${rowStyle}">
      <span style="display:inline-block;width:.8em;height:.8em;border-radius:50%;box-sizing:border-box;flex-shrink:0;${ls.dot}"></span>
      <span class="${hot ? 'font-bold' : 'font-semibold'} text-on-surface">${escHtml(s ? s.label : 'Service')}</span>
      ${tech ? `<span class="text-on-surface-variant">→ ${escHtml(tech.name)}${a.station ? ' @' + escHtml(String(a.station)) : ''}</span>` : (a.station ? `<span class="text-on-surface-variant">@${escHtml(String(a.station))}</span>` : '')}
      ${a.comped ? `<span class="font-semibold" style="color:#7a5a00">${escHtml(a.compReason || 'Comp')}</span>` : (isAwaitingPrice(a) ? `<span class="font-semibold" style="color:#6b4fb0">Pending</span>` : (a.cost ? `<span class="font-semibold text-primary">$${Number(a.cost).toFixed(2)}</span>` : ''))}
      ${tip}
      <span class="text-[9px] font-bold px-1.5 rounded-full flex-shrink-0 ${tip ? '' : 'ml-auto'}" style="background:${ls.pill.bg};color:${ls.pill.fg}">${ls.pill.label}</span>
    </div>`;
  }).join('');
  const totalDisplay = e.totalCost ? `<span class="font-semibold text-primary ml-1">$${e.totalCost.toFixed(2)}</span>` : '';
  const cardBg = isPaidStatus(e.status)
    ? 'bg-surface-container-high border-surface-container-highest opacity-70'
    : `bg-surface-container-lowest ${e.isAppointment ? 'border-primary/40' : 'border-surface-container-high'}`;
  // One status cue per card: a colored left edge. For a party the group color wins (group
  // identity matters more than the status, which the per-service pills already carry).
  const statusEdgeColor = { waiting: '#f5c870', inservice: '#2a7a4f', complete: '#1a5c7a', paid: '#5b6166', done: '#5b6166' }[e.status] || '#c2cacd';
  const leftEdge = e.groupId ? `border-left:5px solid ${e.groupColor};` : `border-left:4px solid ${statusEdgeColor};`;
  const groupDot = e.groupId ? `<span style="display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;border-radius:5px;background:${e.groupColor};color:#fff;font-size:10px;font-weight:800;flex-shrink:0;margin-right:1px">${_partyLetters.get(e.groupId) || '•'}</span>` : '';
  const groupTag = e.groupLabel ? `<span class="text-[10px] font-body italic" style="color:${e.groupColor}">${e.groupLabel}</span>` : '';
  // Wait timer = the front desk's #1 triage signal. For a WAITING guest it's a pill that
  // escalates amber (≥15m) → red (≥25m); pill color only, no card outline. The number stays
  // live because updateElapsedTimes rewrites the inner data-checkin-ts span's text (the icon
  // is a sibling, so it survives). In-service shows a muted "Xm in service"; others a plain time.
  const waitMins = Math.floor((Date.now() - t.getTime()) / 60000);
  let timeEl;
  if (e.status === 'waiting') {
    const esc = waitMins >= 25 ? 'background:#f7d4d4;color:#a32d2d' : waitMins >= 15 ? 'background:#faedcf;color:#9a6b00' : 'background:var(--surface-container);color:var(--on-surface-variant)';
    timeEl = `<span class="ml-auto inline-flex items-center gap-1" style="font-size:12px;font-weight:600;padding:2px 9px;border-radius:999px;${esc}"><span class="material-symbols-outlined" style="font-size:13px">schedule</span><span data-checkin-ts="${t.getTime()}">${formatElapsed(e.checkinTime)}</span></span>`;
  } else if (e.status === 'inservice') {
    timeEl = `<span class="ml-auto inline-flex items-center gap-1 text-on-surface-variant" style="font-size:11px"><span class="material-symbols-outlined" style="font-size:13px">schedule</span><span data-checkin-ts="${t.getTime()}">${formatElapsed(e.checkinTime)}</span> in service</span>`;
  } else {
    timeEl = `<span class="text-[10px] font-body text-outline ml-auto" data-checkin-ts="${t.getTime()}">${formatElapsed(e.checkinTime)}</span>`;
  }
  // Soft-outline action buttons, all one size. Neutral tools + Remove use theme tokens so
  // they adapt to dark mode; the advance actions keep a soft tint of their meaning color.
  const btnCls = `flex items-center justify-center self-stretch rounded-xl transition-all active:scale-95 cursor-pointer`;
  const sTool = 'width:44px;background:var(--surface);border:1px solid var(--surface-container-high);color:var(--on-surface-variant)';
  const sRemove = 'width:44px;background:var(--surface);border:1px solid #e7a3a3;color:#a32d2d';
  const sStart = 'width:44px;background:#e1f3f2;border:1px solid #6fb8b6;color:#0f3d3d';
  const sBackWait = 'width:44px;background:#faedcf;border:1px solid #e0c074;color:#9a6b00';
  const sComplete = 'width:44px;background:#dfeaf1;border:1px solid #6f9fbb;color:#14506e';
  const sBackSvc = 'width:44px;background:#e0eeec;border:1px solid #8fbdb8;color:#134a45';
  const sPay = 'width:44px;background:#e3f0e8;border:1px solid #7bb394;color:#1b5e3b';
  const id = e.id;
  const hasSquare = !!cfg().square_config;
  return `
    <div class="queue-row ${cardBg} rounded-xl py-1.5 px-3 border flex items-stretch gap-1.5" data-id="${id}" style="${leftEdge}">
      <div class="flex-grow min-w-0 py-1 cursor-pointer" onclick="showGroupAssignModal('${id}')" title="Assign & Price">
        <div class="flex items-center gap-1 flex-wrap leading-tight">
          ${groupDot}<span class="font-headline font-semibold text-on-surface text-sm">${e.name}</span>${visitBadge}${groupTag ? ' ' + groupTag : ''}
          ${apptBadge}${totalDisplay}
          ${timeEl}
        </div>
        ${assignSummary ? '' : `<div class="text-[11px] font-body text-on-surface-variant truncate">${serviceLabels}</div>`}
        ${assignSummary ? `<div class="text-[11px] font-body mt-0.5 space-y-0.5">${assignSummary}</div>` : ''}
        ${visitSub}
        <div class="text-[10px] font-body text-outline">${timeStr}${e.phone ? ' · ' + e.phone : ''}</div>
        ${cardNotePreview(e.phone, e.txnNote)}
      </div>
      <div class="flex items-stretch gap-1 flex-shrink-0">
        <button onclick="showEditCheckin('${id}')" title="Edit check-in info" class="${btnCls}" style="${sTool}"><span class="material-symbols-outlined" style="font-size:19px">edit_note</span></button>
        ${e.groupId
          ? `<button onclick="showSplitMergeModal('${id}')" title="Split/Merge" class="${btnCls}" style="${sTool}"><span class="material-symbols-outlined" style="font-size:19px">call_split</span></button>`
          : `<button onclick="showMergeSelectModal('${id}')" title="Merge" class="${btnCls}" style="${sTool}"><span class="material-symbols-outlined" style="font-size:19px">merge</span></button>`}
        ${e.status === 'waiting' ? `<button onclick="tryAdvanceStatus('${id}','inservice')" title="In Service" class="${btnCls}" style="${sStart}"><span class="material-symbols-outlined" style="font-size:19px">play_circle</span></button>` : ''}
        ${e.status === 'inservice' ? `
          <button onclick="updateStatus('${id}','waiting')" title="Back to Waiting" class="${btnCls}" style="${sBackWait}"><span class="material-symbols-outlined" style="font-size:19px">arrow_back</span></button>
          <button onclick="tryAdvanceStatus('${id}','complete')" title="Complete" class="${btnCls}" style="${sComplete}"><span class="material-symbols-outlined" style="font-size:19px">task_alt</span></button>` : ''}
        ${e.status === 'complete' ? `
          <button onclick="updateStatus('${id}','inservice')" title="Back to In Service" class="${btnCls}" style="${sBackSvc}"><span class="material-symbols-outlined" style="font-size:19px">arrow_back</span></button>
          ${ticketTotal(e) > 0
            ? `<button onclick="openSquarePOS('${id}')" title="Take payment" class="${btnCls}" style="${sPay}"><span class="material-symbols-outlined" style="font-size:19px">point_of_sale</span></button>`
            : `<button onclick="tryAdvanceStatus('${id}','paid')" title="Mark Paid (no charge)" class="${btnCls}" style="${sPay}"><span class="material-symbols-outlined" style="font-size:19px">paid</span></button>`}` : ''}
        ${isPaidStatus(e.status) ? `<button onclick="confirmReopen('${id}')" title="Reopen" class="${btnCls}" style="${sTool}"><span class="material-symbols-outlined" style="font-size:19px">undo</span></button>` : ''}
        <button onclick="removeFromQueue('${id}')" title="Remove" class="${btnCls}" style="${sRemove}"><span class="material-symbols-outlined" style="font-size:17px">close</span></button>
      </div>
    </div>`;
}

export function updateStatus(id, status) {
  const entry = q().find(e => String(e.id) === String(id));
  if (!entry) return;
  const wasPaid = isPaidStatus(entry.status);
  if (entry.assignments && entry.assignments.length > 0) {
    if (status === 'inservice') entry.assignments.forEach(a => { if (a.techId && (getAssignmentStatus(entry, a) === 'waiting' || getAssignmentStatus(entry, a) === 'complete')) applyAssignmentStatus(a, 'inservice'); });
    else if (status === 'waiting') entry.assignments.forEach(a => { if (getAssignmentStatus(entry, a) === 'inservice') applyAssignmentStatus(a, 'waiting'); });
    else if (status === 'complete') entry.assignments.forEach(a => { if (a.techId) applyAssignmentStatus(a, 'complete'); });
    else if (status === 'paid') entry.assignments.forEach(a => { if (a.techId) applyAssignmentStatus(a, 'paid'); });
    applyEntryStatus(entry);
  } else { if (entry.status !== status) entry.statusSince = Date.now(); entry.status = status; }
  if (entry.status === 'paid') window.saveRecord?.(entry);
  if (entry.status === 'paid' && !wasPaid) window.logAudit?.('Payment', `${entry.name || '—'} · $${ticketTotal(entry).toFixed(2)}`);
  // R6: when a ticket is paid, commit any recorded gift-card use (log the redemption + draw down
  // the app balance, tied to this ticket). Idempotent. The Square charge is unaffected.
  if (entry.status === 'paid' && entry.giftcardRedemptions && entry.giftcardRedemptions.length) window.gcSyncTicket?.(String(entry.id), entry.giftcardRedemptions);
  // Gift cards SOLD on this ticket → create their ledger entries (Gift Cards Sold, redeemable), tied to the ticket.
  if (entry.status === 'paid' && entry.giftcardSales && entry.giftcardSales.length) window.gcCreateSalesFromTicket?.(String(entry.id), entry.giftcardSales);
  upsert(entry);
  renderQueue(); updateStats(); window.renderTurns?.(); window.renderFloorPlan?.();
}

export function removeFromQueue(id) { window.initiateDeleteTransaction?.(id); }

export function filterQueue(filter) {
  ui.currentFilter = filter;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('fchip-on'));
  document.getElementById(`tab-${filter}`)?.classList.add('fchip-on');
  renderQueue();
}

export function updateStats() {
  const all = q();
  const counts = {
    all: all.length,
    waiting: all.filter(e => e.status === 'waiting').length,
    inservice: all.filter(e => e.status === 'inservice').length,
    complete: all.filter(e => e.status === 'complete').length,
    paid: all.filter(e => isPaidStatus(e.status)).length,
  };
  const w = document.getElementById('stat-waiting'), s = document.getElementById('stat-inservice'), cmp = document.getElementById('stat-complete'), d = document.getElementById('stat-done');
  if (w) w.textContent = counts.waiting;
  if (s) s.textContent = counts.inservice;
  if (cmp) cmp.textContent = counts.complete;
  if (d) d.textContent = counts.paid;
  // Live counts on the filter chips (All / Waiting / In Service / Done / Paid).
  for (const k of ['all', 'waiting', 'inservice', 'complete', 'paid']) {
    const el = document.getElementById('tab-count-' + k);
    if (el) el.textContent = counts[k];
  }
}

export function validateAssignments(entry) {
  if (!entry.assignments || entry.assignments.length === 0) return false;
  return entry.assignments.every(a => a.techId && (a.cost > 0 || a.comped));
}

// Pay-path consolidation (v4.55): a ticket with a real total (> $0) ALWAYS goes through the Pay
// screen so the tender (cash / card / zelle / gift) is recorded — no more no-tender quick "mark
// paid" that's invisible to the drawer + tender reports. $0 / comp tickets (nothing to tender)
// still pass straight through. Returns true if it redirected (caller should stop).
function _blockDirectPaid(entryId) {
  const entry = q().find(e => String(e.id) === String(entryId));
  if (!entry) return false;
  if (ticketTotal(entry) <= 0) return false;   // $0 / comp — nothing to record
  window.openSquarePOS?.(String(entryId));
  return true;
}

export function tryAdvanceStatus(id, targetStatus) {
  const entry = q().find(e => String(e.id) === String(id));
  if (!entry) return;
  if ((targetStatus === 'complete' || targetStatus === 'paid') && !validateAssignments(entry)) {
    showToast('Assign a technician and cost first.');
    showGroupAssignModal(id);
    return;
  }
  if (targetStatus === 'paid' && _blockDirectPaid(id)) return;
  updateStatus(id, targetStatus);
}

// ── Manual Add modal ──────────────────────────────
let manualGuestCount = 0;
let groupColorIndex = 0;

function serviceButtonsHtml() {
  return cfg().services.map(s => `
    <button type="button" onclick="this.classList.toggle('selected')" data-service="${s.id}"
      class="service-btn flex flex-col items-center justify-center py-2 rounded-lg bg-surface-container text-on-surface-variant border border-outline-variant/30 hover:bg-primary/10 hover:text-primary transition-all text-xs">
      <span class="font-headline font-bold">${s.abbr}</span>
      <span class="text-[9px] font-body mt-0.5 uppercase tracking-tighter text-center leading-tight">${s.label}</span>
    </button>`).join('');
}

function renderManualGuestCard(idx) {
  const isPrimary = idx === 1;
  const container = document.getElementById('manual-guests-container');
  const card = document.createElement('div');
  card.id = `manual-guest-${idx}`;
  card.className = 'bg-surface-container-low rounded-xl p-4 border border-surface-container-high space-y-3';
  card.innerHTML = `
    <div class="flex items-center justify-between">
      <span class="text-xs font-headline font-bold tracking-widest text-primary uppercase">${isPrimary ? 'Primary Guest' : 'Guest ' + idx}</span>
      ${!isPrimary ? `<button onclick="removeManualGuest(${idx})" class="text-xs font-body text-outline hover:text-error transition-colors flex items-center gap-1"><span class="material-symbols-outlined" style="font-size:14px">remove_circle</span> Remove</button>` : ''}
    </div>
    ${!isPrimary ? `
    <label class="flex items-center gap-2 cursor-pointer" onclick="toggleManualSameContact(${idx})">
      <div id="manual-same-box-${idx}" class="w-6 h-6 rounded border-2 border-outline-variant flex items-center justify-center flex-shrink-0 transition-all" style="background:transparent">
        <span class="material-symbols-outlined hidden" id="manual-check-icon-${idx}" style="font-size:14px;color:#fff;font-variation-settings:'FILL' 1,'wght' 700">check</span>
      </div>
      <input type="checkbox" id="manual-same-${idx}" class="hidden">
      <span class="text-sm font-body text-on-surface-variant">Same contact info as primary guest</span>
    </label>` : ''}
    <div id="manual-contact-fields-${idx}" class="space-y-3">
      <div class="ac-input-wrap">
        <label class="text-[11px] font-body font-semibold text-outline-variant uppercase tracking-widest block mb-1">Phone Number</label>
        <input id="manual-phone-${idx}" type="tel" placeholder="(555) 000-0000" autocomplete="off" onfocus="openPhoneNumpad(this)" oninput="acSearchManual(this, ${idx}, 'phone')"
          class="w-full border-b border-surface-container-high bg-transparent py-2 text-base font-headline font-light focus:border-primary transition-colors placeholder:text-surface-container-highest">
        <div id="mac-phone-${idx}" class="autocomplete-list hidden"></div>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div class="ac-input-wrap">
          <label class="text-[11px] font-body font-semibold text-outline-variant uppercase tracking-widest block mb-1">First Name</label>
          <input id="manual-first-${idx}" type="text" placeholder="First" autocomplete="off" oninput="acSearchManual(this, ${idx}, 'first'); autoCapitalize(this)"
            class="w-full border-b border-surface-container-high bg-transparent py-2 text-base font-headline focus:border-primary transition-colors placeholder:text-surface-container-highest">
          <div id="mac-first-${idx}" class="autocomplete-list hidden"></div>
        </div>
        <div>
          <label class="text-[11px] font-body font-semibold text-outline-variant uppercase tracking-widest block mb-1">Last Name</label>
          <input id="manual-last-${idx}" type="text" placeholder="Last" oninput="autoCapitalize(this)"
            class="w-full border-b border-surface-container-high bg-transparent py-2 text-base font-headline focus:border-primary transition-colors placeholder:text-surface-container-highest">
        </div>
      </div>
    </div>
    ${!isPrimary ? `
    <div id="manual-firstonly-fields-${idx}" class="hidden">
      <label class="text-[11px] font-body font-semibold text-outline-variant uppercase tracking-widest block mb-1">First Name</label>
      <input id="manual-firstonly-${idx}" type="text" placeholder="First" oninput="autoCapitalize(this)"
        class="w-full border-b border-surface-container-high bg-transparent py-2 text-base font-headline focus:border-primary transition-colors placeholder:text-surface-container-highest">
    </div>` : ''}
    <div>
      <label class="text-[11px] font-body font-semibold text-outline-variant uppercase tracking-widest block mb-2">Services</label>
      <div class="grid grid-cols-4 gap-2" id="manual-services-${idx}">${serviceButtonsHtml()}</div>
    </div>`;
  // Per-visit note (txnNote) captured at check-in → carried to the record + customer/staff history.
  // (The persistent customer note is handled separately by the side panel for returning customers.)
  card.insertAdjacentHTML('beforeend', `<div>
      <label class="text-[11px] font-body font-semibold text-outline-variant uppercase tracking-widest block mb-1">Note for this visit <span class="text-outline normal-case tracking-normal">· optional</span></label>
      <textarea id="manual-visit-note-${idx}" rows="2" placeholder="e.g., design on ring fingers, in a hurry…"
        class="w-full bg-surface-container rounded-lg border border-surface-container-high px-3 py-2 text-sm font-body text-on-surface focus:outline-none focus:border-primary resize-none"></textarea>
    </div>`);
  container.appendChild(card);
}

export function toggleManualSameContact(idx) {
  const cb = document.getElementById(`manual-same-${idx}`);
  const box = document.getElementById(`manual-same-box-${idx}`);
  const checkIcon = document.getElementById(`manual-check-icon-${idx}`);
  const contactFields = document.getElementById(`manual-contact-fields-${idx}`);
  const firstOnlyFields = document.getElementById(`manual-firstonly-fields-${idx}`);
  cb.checked = !cb.checked;
  const fn = document.getElementById(`manual-first-${idx}`), fo = document.getElementById(`manual-firstonly-${idx}`);
  if (cb.checked) {
    if (box) { box.style.background = '#1a5252'; box.style.borderColor = '#1a5252'; }
    checkIcon?.classList.remove('hidden');
    contactFields?.classList.add('hidden'); firstOnlyFields?.classList.remove('hidden');
    if (fn && fo && fn.value.trim()) fo.value = fn.value.trim();   // carry the typed first name forward
  } else {
    if (box) { box.style.background = 'transparent'; box.style.borderColor = '#7a858a'; }
    checkIcon?.classList.add('hidden');
    contactFields?.classList.remove('hidden'); firstOnlyFields?.classList.add('hidden');
    if (fn && fo && fo.value.trim()) fn.value = fo.value.trim();   // carry it back
  }
}

export function showManualAdd() {
  manualGuestCount = 0;
  document.getElementById('manual-guests-container').innerHTML = '';
  addManualGuest();
  const appt = document.getElementById('manual-is-appointment'); if (appt) appt.checked = false;
  document.getElementById('manual-note-panel')?.classList.add('hidden');   // note panel appears only when a returning customer is picked
  const tw = document.getElementById('manual-appt-tech-wrap'); if (tw) tw.classList.add('hidden');
  const ts = document.getElementById('manual-appt-tech'); if (ts) { ts.innerHTML = '<option value="">— Leave unassigned —</option>'; ts.value = ''; }
  const m = document.getElementById('manual-modal'); m.classList.remove('hidden'); m.style.display = 'flex';
  setTimeout(() => document.getElementById('manual-phone-1')?.focus(), 100);
}
// Appointment check-ins can pre-assign a technician. Show the picker only when the
// "Appointment" box is checked; populate it with active staff (lazily, keeping any
// current choice). Leaving it blank leaves the check-in unassigned.
export function toggleManualApptTech() {
  const on = document.getElementById('manual-is-appointment')?.checked;
  const wrap = document.getElementById('manual-appt-tech-wrap'); if (!wrap) return;
  wrap.classList.toggle('hidden', !on);
  const sel = document.getElementById('manual-appt-tech');
  if (on && sel && sel.options.length <= 1) {
    sel.innerHTML = '<option value="">— Leave unassigned —</option>' + activeStaff().slice().sort(byName).map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  }
}
export function addManualGuest() { manualGuestCount++; renderManualGuestCard(manualGuestCount); }
export function removeManualGuest(idx) { document.getElementById(`manual-guest-${idx}`)?.remove(); }
export function closeManualAdd() {
  closeCustomerNote();   // flush + hide the customer-note side panel
  const m = document.getElementById('manual-modal'); m.classList.add('hidden'); m.style.display = '';
  manualGuestCount = 0;
  const c = document.getElementById('manual-guests-container'); if (c) c.innerHTML = '';
}

export function submitManualAdd(skipApptGuard) {
  const newEntries = [];
  const isAppointment = document.getElementById('manual-is-appointment')?.checked || false;
  const apptTechId = isAppointment ? (document.getElementById('manual-appt-tech')?.value || '') : '';
  for (let i = 1; i <= manualGuestCount; i++) {
    const card = document.getElementById(`manual-guest-${i}`);
    if (!card) continue;
    const sameContact = i > 1 && document.getElementById(`manual-same-${i}`)?.checked;
    let phone, first, last;
    if (sameContact) { first = document.getElementById(`manual-firstonly-${i}`)?.value.trim() || ''; phone = document.getElementById('manual-phone-1')?.value.trim() || ''; last = ''; }
    else { phone = document.getElementById(`manual-phone-${i}`)?.value.trim() || ''; first = document.getElementById(`manual-first-${i}`)?.value.trim() || ''; last = document.getElementById(`manual-last-${i}`)?.value.trim() || ''; }
    if (!first) { showToast('Please enter a first name for each guest.'); return; }
    const services = Array.from(card.querySelectorAll('.service-btn.selected')).map(b => b.dataset.service);
    const visitNote = document.getElementById(`manual-visit-note-${i}`)?.value.trim() || '';
    const entry = { id: newEntryId(), name: first + (last ? ' ' + last : ''), phone, services, status: 'waiting', checkinTime: new Date().toISOString(), isNew: false, skipSquare: sameContact, isAppointment };
    if (visitNote) entry.txnNote = visitNote;   // per-visit note → carried to the record + history
    // Appointment + chosen tech → pre-assign that tech to each service (remembered on
    // the check-in). Blank tech leaves it unassigned (no assignments created here).
    if (apptTechId && services.length) entry.assignments = services.map(sid => ({ serviceId: sid, techId: apptTechId, station: '', status: 'waiting', cost: 0, assignedAt: Date.now() }));
    newEntries.push(entry);
  }
  if (newEntries.length === 0) return;
  // Appointment guard: same prompt as the kiosk — offer to check in FROM today's appointment.
  if (skipApptGuard !== true && window.checkinApptGuard?.(newEntries.map(e => ({ name: e.name, phone: e.phone })), () => submitManualAdd(true))) return;
  if (newEntries.length > 1) {
    const groupId = `grp-${Date.now()}`, groupColor = GROUP_COLORS[groupColorIndex++ % GROUP_COLORS.length], primaryName = newEntries[0].name;
    newEntries.forEach((e, i) => { e.groupId = groupId; e.groupColor = groupColor; e.groupLabel = i === 0 ? `${e.name} (primary)` : `${primaryName} — ${e.name}`; });
  }
  newEntries.forEach(e => upsert(e));
  upsertPartyCustomers(newEntries);   // one Square profile per distinct phone (no shared-phone flip-flop)
  window.logAudit?.('Check-in', `${newEntries.map(e => e.name).join(' & ')} added (manual)`);
  renderQueue(); updateStats(); window.renderTurns?.();
  closeManualAdd();
  showToast(`${newEntries.map(e => e.name).join(' & ')} added to queue`);
}

// ── Edit Check-In ─────────────────────────────────
let _editCheckinId = null, _editCheckinOpenedAt = 0;
export function showEditCheckin(entryId) {
  const entry = q().find(e => String(e.id) === String(entryId));
  if (!entry) return;
  _editCheckinId = entryId;
  _editCheckinOpenedAt = entry.updatedAt || 0;
  const parts = (entry.name || '').trim().split(' ');
  const firstName = parts[0] || '', lastName = parts.slice(1).join(' ') || '';
  document.getElementById('edit-checkin-content').innerHTML = `
    <div class="grid grid-cols-2 gap-3">
      <div><label class="text-[11px] font-body font-semibold text-outline uppercase tracking-widest block mb-1">First Name</label>
        <input id="eci-first" type="text" value="${firstName}" oninput="autoCapitalize(this)" class="w-full border-2 border-surface-container-high bg-transparent rounded-xl px-4 py-2 text-base font-headline focus:border-primary outline-none"></div>
      <div><label class="text-[11px] font-body font-semibold text-outline uppercase tracking-widest block mb-1">Last Name</label>
        <input id="eci-last" type="text" value="${lastName}" oninput="autoCapitalize(this)" class="w-full border-2 border-surface-container-high bg-transparent rounded-xl px-4 py-2 text-base font-headline focus:border-primary outline-none"></div>
    </div>
    <div><label class="text-[11px] font-body font-semibold text-outline uppercase tracking-widest block mb-1">Phone</label>
      <input id="eci-phone" type="tel" value="${entry.phone || ''}" class="w-full border-2 border-surface-container-high bg-transparent rounded-xl px-4 py-2 text-base font-headline focus:border-primary outline-none"></div>
    <div><label class="text-[11px] font-body font-semibold text-outline uppercase tracking-widest block mb-1">Services</label>
      <div class="grid grid-cols-3 gap-2">
        ${cfg().services.map(s => `
          <label class="flex items-center gap-2 p-2 rounded-lg cursor-pointer hover:bg-surface-container border ${entry.services.includes(s.id) ? 'border-primary bg-primary/10' : 'border-transparent'}">
            <input type="checkbox" class="eci-svc accent-primary" value="${s.id}" ${entry.services.includes(s.id) ? 'checked' : ''}>
            <span class="text-xs font-body">${s.label}</span>
          </label>`).join('')}
      </div></div>`;
  const m = document.getElementById('edit-checkin-modal'); m.classList.remove('hidden'); m.style.display = 'flex';
}
export function closeEditCheckin() {
  const m = document.getElementById('edit-checkin-modal'); m.classList.add('hidden'); m.style.display = '';
  _editCheckinId = null;
}
export function saveEditCheckin(force) {
  const entry = q().find(e => String(e.id) === String(_editCheckinId));
  if (!entry) return;
  if (force !== true && (entry.updatedAt || 0) > (_editCheckinOpenedAt || 0) && entry.updatedBy && entry.updatedBy !== DEVICE_ID) {
    showWarnModal('Changed on another device', `${(entry.name || 'This check-in').split(' ')[0]} was updated on another device since you opened it. Saving now overwrites that change. Save anyway?`, () => saveEditCheckin(true), 'Save anyway'); return;
  }
  const first = document.getElementById('eci-first')?.value.trim();
  const last  = document.getElementById('eci-last')?.value.trim();
  const phone = document.getElementById('eci-phone')?.value.trim();
  const svcs  = [...document.querySelectorAll('.eci-svc:checked')].map(cb => cb.value);
  if (!first) { showToast('First name is required.'); return; }
  if (svcs.length === 0) { showToast('Select at least one service.'); return; }
  entry.name = last ? `${first} ${last}` : first;
  entry.phone = phone;
  entry.services = svcs;
  if (entry.assignments) entry.assignments = entry.assignments.filter(a => svcs.includes(a.serviceId));
  applyEntryStatus(entry);
  upsert(entry);
  closeEditCheckin();
  renderQueue(); window.renderTurns?.();
  showToast('Check-in updated ✓');
  // Create/mirror the customer; if the entered name differs from a saved record on
  // this phone, ask before changing the directory (shared-phone safe). Runs after the
  // edit modal closes so the prompt isn't buried.
  if (!entry.skipSquare) syncCustomersFromEntries([entry]);
}

// Sync customer edits from check-in back to the directory + Square. New or unchanged
// customers flow through silently; an entry whose name/email DIFFERS from the saved
// record on its phone is only written after an explicit "Update saved info?" confirm,
// so a shared-phone record is never overwritten by accident. One combined prompt when
// several differ (no modal stacking).
function syncCustomersFromEntries(entries) {
  const diffs = [];
  entries.forEach(e => {
    const d = customerNeedsUpdate(e);
    if (d) diffs.push({ e, d });
    else squareUpsertCustomer(e);   // new customer or no change → silent create/mirror
  });
  if (!diffs.length) return;
  const apply = () => diffs.forEach(({ e }) => squareUpsertCustomer(e, { updateName: true }));
  const body = diffs.length === 1
    ? `This number is saved as “${diffs[0].d.oldName}”. Update the saved customer to “${diffs[0].d.newName}”? This changes the directory record.`
    : `Update ${diffs.length} saved customers? ${diffs.map(({ d }) => `“${d.oldName}” → “${d.newName}”`).join('; ')}. This changes the directory records.`;
  showWarnModal('Update saved info?', body, apply, diffs.length === 1 ? 'Update saved info' : 'Update all');
}

// ── Group Assign / Price modal ────────────────────
let groupAssignEntries = [];
let activeGroupTab = 0;
let _assignOpenedAt = {};           // entryId → updatedAt at open (stale-write guard)
const _custEditedIds = new Set();   // entries whose name/phone were edited here → sync to Square on Save

// Per-assignment open-time field snapshot: entryId → serviceId → {techId,station,cost(cents),comped,compReason}.
// Captured from the STORE on every modal render so a save writes ONLY the fields the front desk
// actually changed — leaving an untouched field alone lets a tech's concurrent per-assignment patch
// (staff app) survive the whole-entry queue.upsert (see store.js mergeNewerAssignments). Reset on close.
let _assignFieldSnapshot = {};
const _costCents = v => Math.round((parseFloat(v) || 0) * 100);
function _snapshotAssignFields() {
  _assignFieldSnapshot = {};
  groupAssignEntries.forEach(id => {
    const e = q().find(x => String(x.id) === id); if (!e) return;
    const m = {};
    (e.assignments || []).forEach(a => { m[a.serviceId] = { techId: a.techId || '', station: a.station || '', cost: _costCents(a.cost), comped: !!a.comped, compReason: a.compReason || '' }; });
    _assignFieldSnapshot[String(id)] = m;
  });
}
// Write a DOM row's per-assignment fields onto `a`, but ONLY those the front desk actually changed
// vs the open-time snapshot — so an untouched field keeps a tech's concurrent change. Stamps
// a.updatedAt only when the FD changed something (so the §14 merge in store.js/worker.js orders it
// correctly: a genuine FD edit is strictly newer and wins; an untouched field carries no fresh
// stamp and the tech's assignment is preserved). A brand-new assignment (no snapshot) is written
// in full, as the original save did.
function _applyRowToAssignment(entryId, a, row, isNew) {
  const snap = isNew ? null : (_assignFieldSnapshot[String(entryId)] || {})[a.serviceId];
  const prevTech = a.techId;
  const domTech = row.querySelector('.assign-tech')?.value || '';
  const domStation = row.querySelector('.assign-station')?.value || '';
  const domComped = !!row.querySelector('.assign-comp')?.checked;
  const domCompReason = domComped ? (row.querySelector('.assign-comp-reason')?.value || 'Comp') : '';
  const domCost = domComped ? 0 : (parseFloat(row.querySelector('.assign-cost')?.value) || 0);
  if (!snap) {   // new (or un-snapshotted) row → write everything, as the original save did
    a.techId = domTech; a.station = domStation; a.comped = domComped; a.compReason = domCompReason; a.cost = domCost;
    if (a.techId && !prevTech) a.assignedAt = Date.now();
    a.updatedAt = Date.now();
    return;
  }
  let changed = false;
  if (domTech !== snap.techId) { a.techId = domTech; changed = true; }
  if (domStation !== snap.station) { a.station = domStation; changed = true; }
  if (domComped !== snap.comped) { a.comped = domComped; changed = true; }
  if (domCompReason !== snap.compReason) { a.compReason = domCompReason; changed = true; }
  if (_costCents(domCost) !== snap.cost) { a.cost = domCost; changed = true; }
  // Front-desk override: entering a real price (or comping) on an awaiting-price service resolves it.
  if (a.awaitingPrice && ((a.cost || 0) > 0 || a.comped)) { a.awaitingPrice = false; changed = true; }
  if (a.techId && !prevTech) a.assignedAt = Date.now();
  if (changed) a.updatedAt = Date.now();
}

// Guardrail: when a tech's per-assignment change syncs in while the Assign & Price modal is open,
// reflect a changed cost in the field — so the front desk SEES the tech's price instead of the
// stale open-time value (and won't overwrite it on save). Only touches a cost field that the FD
// isn't focused in AND still equals its snapshot (FD hasn't typed there); advances the snapshot so
// the changed-field-only save doesn't mistake the refreshed value for an FD edit. Called from the
// store subscription (main.js onStateChange) on every sync.
export function refreshOpenAssignFields() {
  const m = document.getElementById('group-assign-modal');
  if (!m || m.classList.contains('hidden') || !groupAssignEntries.length) return;
  groupAssignEntries.forEach(id => {
    const e = q().find(x => String(x.id) === id); if (!e) return;
    const snapEntry = _assignFieldSnapshot[String(id)] || {};
    (e.assignments || []).forEach(a => {
      const snap = snapEntry[a.serviceId]; if (!snap) return;
      const row = document.querySelector(`#group-assign-content [data-assign-entry="${id}"] [data-service-id="${a.serviceId}"]`)
               || document.querySelector(`#group-assign-content [data-service-id="${a.serviceId}"]`);
      const costEl = row && row.querySelector('.assign-cost');
      if (!costEl || costEl === document.activeElement) return;   // never clobber a field the FD is editing
      const storeCents = _costCents(a.cost);
      if (storeCents !== snap.cost && _costCents(costEl.value) === snap.cost && !a.comped) {
        costEl.value = (a.cost != null && a.cost !== 0) ? a.cost : '';
        snap.cost = storeCents;       // advance the baseline so a later save won't read this as an FD change
        updateGroupTotal();
      }
    });
  });
}

// Stale-write guard: which entries in `capturedMap` (id → updatedAt captured when a modal
// opened) has ANOTHER device changed since? Saving those now would silently overwrite the
// other device's change — so we warn first. This device's own intra-modal writes are
// excluded (updatedBy === DEVICE_ID), so it never false-warns on your own edits.
function _staleNames(capturedMap) {
  const out = [];
  Object.keys(capturedMap).forEach(id => {
    const e = q().find(x => String(x.id) === id);
    if (e && (e.updatedAt || 0) > (capturedMap[id] || 0) && e.updatedBy && e.updatedBy !== DEVICE_ID) out.push((e.name || 'a guest').split(' ')[0]);
  });
  return out;
}
export function activeGroupEntryId() { return groupAssignEntries[activeGroupTab]; }

// ── Cross-device hard lock on the Assign & Price modal ────────────────────────
// While a ticket's modal is open on one device, another device opening the SAME ticket
// (or any member of its party) is blocked with a notice. The lock lives in synced config
// (edit_locks); it's refreshed by a heartbeat while open and released on close (closing
// already saves the prices, so the desktop→iPad handoff keeps the work). A lock older than
// LOCK_TTL is treated as released (covers a device that closed/crashed without releasing).
const LOCK_TTL = 180000, LOCK_HB = 90000;
let _lockKey = null, _lockHbTimer = null;
const editLocks   = () => cfg().edit_locks || {};
const _lockKeyFor = entry => entry.groupId ? 'grp:' + entry.groupId : String(entry.id);
function _lockHeldByOther(key) { const l = editLocks()[key]; return (l && l.device !== DEVICE_ID && (Date.now() - (l.at || 0)) < LOCK_TTL) ? l : null; }
function _acquireLock(key) { dispatch('config.set', { key: 'edit_locks', value: { ...editLocks(), [key]: { device: DEVICE_ID, name: getActiveUser()?.name || '', at: Date.now() } } }); }
function _releaseLock(key) { const cur = editLocks(); if (!cur[key] || cur[key].device !== DEVICE_ID) return; const next = { ...cur }; delete next[key]; dispatch('config.set', { key: 'edit_locks', value: next }); }
function _stopLockHb() { if (_lockHbTimer) { clearInterval(_lockHbTimer); _lockHbTimer = null; } }
function _startLockHb(key) {
  _stopLockHb();
  _lockHbTimer = setInterval(() => {
    const m = document.getElementById('group-assign-modal');
    if (_lockKey !== key || !m || m.classList.contains('hidden')) { _releaseLock(key); _stopLockHb(); if (_lockKey === key) _lockKey = null; return; }
    _acquireLock(key);   // refresh the timestamp so a long edit doesn't go stale
  }, LOCK_HB);
}

// Idle nudge: if a ticket's Assign & Price modal is left open with NO interaction for ASSIGN_IDLE_MS
// (timer resets on any tap/type/focus, so active pricing never triggers it), free the lock so other
// devices can use the ticket and offer a "Keep editing" to resume. A forgotten-open modal no longer
// holds the ticket hostage; the changed-field-only save keeps a resume safe.
const ASSIGN_IDLE_MS = 180000;   // 3 minutes of no interaction
let _assignIdleTimer = null, _assignIdleBound = false;
function _stopAssignIdle() { if (_assignIdleTimer) { clearTimeout(_assignIdleTimer); _assignIdleTimer = null; } }
function _resetAssignIdle() { if (!_lockKey) return; _stopAssignIdle(); _assignIdleTimer = setTimeout(_assignIdleFired, ASSIGN_IDLE_MS); }
function _assignIdleFired() {
  const key = _lockKey; if (!key) return;
  _releaseLock(key); _stopLockHb();   // free the ticket immediately — don't wait for a response
  window.showWarnModal?.('Still editing this ticket?',
    'This ticket was left open, so it’s been unlocked for other devices. Tap “Keep editing” to keep working here.',
    () => { if (_lockKey === key) { _acquireLock(key); _startLockHb(key); _resetAssignIdle(); } }, 'Keep editing');
}
function _bindAssignIdle() {
  if (_assignIdleBound) return;
  const m = document.getElementById('group-assign-modal'); if (!m) return;
  ['pointerdown', 'keydown', 'input', 'focusin'].forEach(ev => m.addEventListener(ev, _resetAssignIdle, true));
  _assignIdleBound = true;
}

export function showGroupAssignModal(entryId) {
  const entry = q().find(e => String(e.id) === String(entryId));
  if (!entry) return;
  // Hard lock: if this ticket (or its party) is open on another device, don't open — tell the user.
  const key = _lockKeyFor(entry);
  const held = _lockHeldByOther(key);
  if (held) { window.showWarnModal?.('Ticket open on another device', `This ticket is being edited on ${held.name ? held.name + "'s device" : 'another device'}. Close it there first, then open it here.`, () => {}, 'OK'); return; }
  _lockKey = key; _acquireLock(key); _startLockHb(key);
  _bindAssignIdle(); _resetAssignIdle();
  groupAssignEntries = entry.groupId ? q().filter(e => e.groupId === entry.groupId).map(e => String(e.id)) : [String(entry.id)];
  const clicked = groupAssignEntries.indexOf(String(entryId));
  activeGroupTab = clicked >= 0 ? clicked : 0;
  _assignOpenedAt = {};
  groupAssignEntries.forEach(id => { const e = q().find(x => String(x.id) === id); _assignOpenedAt[id] = e?.updatedAt || 0; });
  renderGroupAssignTabs();
  renderGroupAssignContent();
  const m = document.getElementById('group-assign-modal'); m.classList.remove('hidden'); m.style.display = 'flex';
  // Smart focus: opening the modal for an in-service customer → jump straight to the
  // price field for the service in progress, since pricing it is the next logical step.
  const ae = q().find(e => String(e.id) === groupAssignEntries[activeGroupTab]);
  const inSvc = ae && (ae.assignments || []).find(a => getAssignmentStatus(ae, a) === 'inservice');
  if (inSvc) setTimeout(() => {
    const el = document.querySelector(`#group-assign-content [data-service-id="${inSvc.serviceId}"] .assign-cost`);
    if (el) { el.focus(); el.select && el.select(); }
  }, 60);
}

function renderGroupAssignTabs() {
  const tabs = document.getElementById('group-assign-tabs');
  if (ASSIGN_ONELIST) { tabs.innerHTML = ''; tabs.classList.add('hidden'); return; }
  tabs.classList.remove('hidden');
  tabs.innerHTML = groupAssignEntries.map((id, i) => {
    const entry = q().find(e => String(e.id) === id);
    if (!entry) return '';
    const isActive = i === activeGroupTab, color = entry.groupColor || '#1a5252';
    return `<div class="flex items-center gap-1">
        <button onclick="switchGroupTab(${i})" class="px-4 py-2 rounded-full text-sm font-body font-semibold transition-all flex items-center gap-2 ${isActive ? 'text-white' : 'bg-surface-container text-on-surface hover:bg-surface-container-high'}" style="${isActive ? `background:${color}` : ''}">
          <span class="w-2 h-2 rounded-full flex-shrink-0" style="background:${color}"></span>${entry.name.split(' ')[0]}
        </button>
        ${isActive ? `<button onclick="openCustomerFromAssign('${id}')" title="Edit customer" class="w-7 h-7 rounded-full hover:bg-surface-container-high flex items-center justify-center text-on-surface-variant transition-colors"><span class="material-symbols-outlined" style="font-size:16px">person_edit</span></button>` : ''}
      </div>`;
  }).join('');
}

export function openCustomerFromAssign(entryId) {
  const entry = q().find(e => String(e.id) === String(entryId));
  if (!entry) return;
  const match = entry.phone ? customerDirectory.find(c => c.phone && c.phone.replace(/\D/g,'').endsWith(entry.phone.replace(/\D/g,''))) : null;
  if (match) showEditCustomer(match.squareId);
  else { closeGroupAssignModal(); showEditCheckin(entryId); }
}

export function switchGroupTab(i) {
  saveCurrentGroupTabInputs();
  activeGroupTab = i;
  renderGroupAssignTabs();
  renderGroupAssignContent();
}

export function cycleServiceStatus(entryId, serviceId, newStatus) {
  if (document.getElementById('group-assign-modal')?.style.display === 'flex') saveCurrentGroupTabInputs();
  const entry = q().find(e => String(e.id) === String(entryId));
  if (!entry) return;
  const a = (entry.assignments || []).find(x => x.serviceId === serviceId);
  if (newStatus === 'inservice' && (!a || !a.techId)) { showToast('Assign a technician before marking In Service.'); return; }
  if (newStatus === 'complete' || newStatus === 'paid') {
    if (!a || !a.techId) { showToast('Assign a technician first.'); return; }
    if ((!a.cost || a.cost <= 0) && !a.comped) {
      // No price yet. Completing a service is fine if the tech will price it later — offer that
      // instead of just blocking. (Paid still needs a real price; you can't finalize a $0 sale.)
      if (newStatus === 'complete') {
        const who = staffById(a.techId)?.name || 'the tech';
        showWarnModal('Mark done — tech will set the price?',
          `${svc(serviceId)?.label || 'This service'} will show as “Awaiting price” until ${who} enters it on their app. You can also enter it here anytime. Payment stays locked until it’s priced.`,
          () => markAwaitingPrice(entryId, serviceId), 'Done — tech will price');
        return;
      }
      showToast('Enter a price first (or mark it Comp / No charge).'); return;
    }
  }
  if (newStatus === 'paid' && _blockDirectPaid(entryId)) return;
  setAssignmentStatus(entry, serviceId, newStatus);
  renderGroupAssignContent();
}

// "Done — tech will price": mark a service complete with NO price yet; the assigned tech enters
// it from the staff app (or the front desk overrides by typing a price in the modal, which clears
// the flag in _applyRowToAssignment). The flag rides on the assignment and gates checkout.
export function markAwaitingPrice(entryId, serviceId) {
  const entry = q().find(e => String(e.id) === String(entryId));
  if (!entry) return;
  const a = (entry.assignments || []).find(x => x.serviceId === serviceId);
  if (!a || !a.techId) { showToast('Assign a technician first.'); return; }
  a.awaitingPrice = true;
  a.comped = false; a.compReason = '';
  a.cost = 0;
  setAssignmentStatus(entry, serviceId, 'complete');   // dispatches queue.upsert; applyAssignmentStatus stamps a.updatedAt
  window.logAudit?.('Awaiting price', `${entry.name || '—'} · ${svc(serviceId)?.label || 'service'} → ${staffById(a.techId)?.name || 'tech'} to price`);
  renderGroupAssignContent();
}

// Comp / No-charge toggle on a service row: marks the service free ON PURPOSE (a Comp or a
// Fix/redo), which is distinct from "not priced yet" — so it passes validation and the ticket
// can close out at $0. Disables the cost field and reveals the reason picker; the actual flags
// (a.comped / a.compReason, cost forced to 0) are committed in saveCurrentGroupTabInputs.
export function toggleCompRow(cb) {
  const row = cb.closest('[data-service-id]'); if (!row) return;
  const cost = row.querySelector('.assign-cost'), reason = row.querySelector('.assign-comp-reason');
  if (cb.checked) { if (cost) { cost.value = ''; cost.disabled = true; cost.classList.add('opacity-50'); } reason?.classList.remove('hidden'); }
  else { if (cost) { cost.disabled = false; cost.classList.remove('opacity-50'); } reason?.classList.add('hidden'); }
  updateGroupTotal();
}

// Move a service's status BACK to correct a mistake (e.g. accidentally In Service →
// Waiting). Warns first. Not offered from Paid (use the whole-ticket Reopen instead).
export function revertServiceStatus(entryId, serviceId, prevStatus) {
  if (document.getElementById('group-assign-modal')?.style.display === 'flex') saveCurrentGroupTabInputs();
  const label = { waiting:'Waiting', inservice:'In Service', complete:'Complete' }[prevStatus] || prevStatus;
  showWarnModal('Move status back?', `This moves ${svc(serviceId)?.label || 'this service'} back to "${label}". Use this only to correct a mistake.`, () => {
    const e = q().find(x => String(x.id) === String(entryId)); if (!e) return;
    setAssignmentStatus(e, serviceId, prevStatus, true);   // isRevert → restore the pre-mistake status timer
    window.logAudit?.('Status revert', `${e.name || '—'} · ${svc(serviceId)?.label || 'service'} → ${label}`);
    renderGroupAssignContent();
    renderQueue(); updateStats(); window.renderTurns?.(); window.renderFloorPlan?.();
  }, 'Move back');
}

// Accept an in-modal tech suggestion: set that service row's tech dropdown. entryId scopes
// the row to one guest in the one-list layout (two guests can carry the same service).
export function acceptAssignSuggestion(serviceId, techId, entryId) {
  const scope = entryId ? `[data-assign-entry="${entryId}"] ` : '';
  const row = document.querySelector(`#group-assign-content ${scope}[data-service-id="${serviceId}"]`);
  const sel = row?.querySelector('.assign-tech');
  if (sel) { sel.value = techId; updateGroupTotal(); }
}

// Mutates the in-store entry as an editing buffer (committed by the save handlers).
export function saveCurrentGroupTabInputs() {
  if (ASSIGN_ONELIST) return _saveAssignOneList();
  const entry = q().find(e => String(e.id) === groupAssignEntries[activeGroupTab]);
  if (!entry) return;
  commitNumpad();   // flush a still-open numpad (a fee/cost typed but not ✓'d) into its field first
  // Per-customer first/last/phone are editable inline in the modal — capture them so
  // EVERY checked-in customer (not just the primary) can be edited here. If name or
  // phone actually changed, flag the entry to sync back to Square on Save.
  const firstEl = document.getElementById('ga-first'), lastEl = document.getElementById('ga-last'), phoneEl = document.getElementById('ga-phone');
  if (firstEl || lastEl || phoneEl) {
    const newName = [firstEl?.value.trim() || '', lastEl?.value.trim() || ''].filter(Boolean).join(' ');
    const newPhone = phoneEl ? phoneEl.value.trim() : (entry.phone || '');
    if ((newName && newName !== entry.name) || newPhone !== (entry.phone || '')) _custEditedIds.add(String(entry.id));
    if (newName) entry.name = newName;
    entry.phone = newPhone;
  }
  const noteEl = document.getElementById('assign-txn-note'); if (noteEl) entry.txnNote = noteEl.value;
  const rows = document.querySelectorAll('#group-assign-content [data-service-id]');
  if (!entry.assignments) entry.assignments = [];
  rows.forEach(row => {
    const sid = row.dataset.serviceId;
    let a = entry.assignments.find(x => x.serviceId === sid);
    const isNew = !a;
    if (!a) { a = { serviceId: sid, status: 'waiting' }; entry.assignments.push(a); }
    _applyRowToAssignment(entry.id, a, row, isNew);   // write only fields the FD changed; stamp updatedAt
  });
  entry.services = entry.assignments.map(a => a.serviceId);

  // ── Whole-ticket items / fees / discount ───────────────────────────────────
  // Items, a fee and a discount apply ONCE to the whole party (not per guest). They're
  // read from the single "Whole ticket" section and consolidated onto the anchor member
  // (the one with the largest service subtotal — most headroom so a whole-ticket discount
  // won't clamp a ticket to $0); every other member carries none. Because reports and the
  // Square charge sum each ticket's parts, the party net is unchanged and no migration is
  // needed — an old per-guest ticket just re-consolidates onto one anchor on first edit.
  const party = groupAssignEntries.map(id => q().find(e => String(e.id) === id)).filter(Boolean);
  const memberSvc = e => (e.assignments || []).reduce((s, a) => s + (a.cost || 0), 0);
  const partySvcSubtotal = party.reduce((s, e) => s + memberSvc(e), 0);

  const partyItems = [];
  document.querySelectorAll('#group-assign-content [data-item-id]').forEach(row => {
    const qty = parseInt(row.querySelector('.item-qty')?.value) || 0;
    const price = parseFloat(row.querySelector('.item-price')?.value) || 0;
    if (price > 0 && qty > 0) partyItems.push({ itemId: row.dataset.itemId, qty, price });
  });
  // Fees are entered at CHECKOUT (Confirm Payment), not here (v4.51). Preserve whatever the ticket
  // already carries (merged across the party) and re-home it on the anchor; recompute a percent fee
  // against the current service subtotal so editing services keeps it accurate.
  const _feeMerge = new Map();
  party.forEach(e => (e.fees || []).forEach(f => {
    const cur = _feeMerge.get(f.feeId);
    if (cur) cur.amount += (f.amount || 0); else _feeMerge.set(f.feeId, { feeId: f.feeId, amount: f.amount || 0, type: f.type });
  }));
  const partyFees = [];
  _feeMerge.forEach(f => {
    const def = cfg().fees.find(x => x.id === f.feeId);
    const amount = (f.type === 'percent' && def) ? Math.round(partySvcSubtotal * (def.value || 0) / 100 * 100) / 100 : f.amount;
    if (amount > 0) partyFees.push({ feeId: f.feeId, amount, type: f.type });
  });
  const partyItemTotal = partyItems.reduce((s, i) => s + i.price * (i.qty || 0), 0);
  const partyFeeTotal  = partyFees.reduce((s, f) => s + (f.amount || 0), 0);
  const discountType  = document.querySelector('#group-assign-content .discount-type-select')?.value || 'flat';
  const discountInput = parseFloat(document.querySelector('#group-assign-content .discount-input')?.value) || 0;
  const discountNote  = document.querySelector('#group-assign-content .discount-note-input')?.value?.trim() || '';
  let partyDiscount = discountType === 'percent' ? Math.round(partySvcSubtotal * discountInput / 100 * 100) / 100 : discountInput;

  // Anchor = largest service subtotal (ties → first). It absorbs all the extras, so the
  // discount it carries can't exceed (its services + the party items + fees) or the ticket
  // would clamp at $0 and quietly drop part of the discount — cap it and say so instead.
  let anchor = party[0] || entry, anchorSub = -1;
  party.forEach(e => { const sub = memberSvc(e); if (sub > anchorSub) { anchorSub = sub; anchor = e; } });
  const anchorBase = anchorSub + partyItemTotal + partyFeeTotal;
  if (partyDiscount > anchorBase) { partyDiscount = Math.max(0, anchorBase); showToast(`Discount capped at $${partyDiscount.toFixed(2)} for this ticket.`); }

  party.forEach(e => {
    const isAnchor = String(e.id) === String(anchor.id);
    e.items        = isAnchor ? partyItems : [];
    e.fees         = isAnchor ? partyFees  : [];
    e.discount     = isAnchor ? partyDiscount : 0;
    e.discountNote = isAnchor ? discountNote  : '';
    e.totalCost    = Math.max(0, memberSvc(e) + (isAnchor ? partyItemTotal + partyFeeTotal - partyDiscount : 0));
  });
  applyEntryStatus(entry);
  setTimeout(updateGroupTotal, 0);
}

// B5 (v4.77): the Assign & Price modal renders ONE list of every guest's lines beside a
// catalog pane — no per-guest tabs. Flip to false to restore the original tabbed layout
// (kept intact below; the owner asked to keep the way back).
const ASSIGN_ONELIST = true;

export function renderGroupAssignContent() {
  _snapshotAssignFields();   // baseline for the changed-field-only save (re-taken on every render)
  if (ASSIGN_ONELIST) return _renderAssignOneList();
  const entry = q().find(e => String(e.id) === groupAssignEntries[activeGroupTab]);
  if (!entry) return;
  const color = entry.groupColor || '#1a5252';
  const content = document.getElementById('group-assign-content');
  // Whole-ticket items / fees / discount: gathered (summed) across ALL party members so
  // the single section below shows the party's combined extras regardless of which member
  // they're stored on — and an old per-guest ticket shows its combined totals here. The
  // same section renders on every guest tab (it's whole-ticket), labelled accordingly.
  const party = groupAssignEntries.map(id => q().find(e => String(e.id) === id)).filter(Boolean);
  const isParty = party.length > 1;
  const gItems = new Map(); let gDiscount = 0, gNote = '';   // fees moved to checkout (v4.51) — not gathered here
  party.forEach(e => {
    (e.items || []).forEach(it => { const c = gItems.get(it.itemId); if (c) c.qty += (it.qty || 0); else gItems.set(it.itemId, { qty: it.qty || 0, price: it.price || 0 }); });
    gDiscount += e.discount || 0;
    if (!gNote && e.discountNote) gNote = e.discountNote;
  });
  const checkedIn = activeStaff().filter(s => cfg().turns_order.includes(s.id)).sort(byName);
  const techOptions = sel => {
    // Include the currently-assigned tech even if inactive / not in today's
    // rotation, so an existing assignment shows correctly instead of falsely as
    // "Unassigned" (lets the user see it and reassign to an active tech).
    let opts = checkedIn;
    if (sel && !checkedIn.some(s => s.id === sel)) {
      const assigned = staffById(sel);
      if (assigned) opts = [...checkedIn, assigned];
    }
    return opts.length > 0
      ? opts.map(st => `<option value="${st.id}" ${sel === st.id ? 'selected' : ''}>${st.name}${cfg().inactive_staff.includes(st.id) ? ' (inactive)' : ''}</option>`).join('')
      : `<option value="" disabled>No techs checked in — add in Turns tab</option>`;
  };
  const stationOptions = sel => stationDefs().map(s => `<option value="${s.id}" ${sel === s.id ? 'selected' : ''}>${s.label || s.id}</option>`).join('');

  const _sugMap = window.suggestTechsForEntry?.(entry) || {};
  const serviceRows = entry.services.map(sid => {
    const s = svc(sid) || { id: sid, label: sid };
    const a = (entry.assignments || []).find(x => x.serviceId === sid) || {};
    const st = getAssignmentStatus(entry, a);
    const est = isAwaitingPrice(a) ? 'awaiting' : st;
    const sug = !a.techId ? (_sugMap[sid] || null) : null;
    const statusBtnStyle = { waiting:'background:#f5c870;color:#3a2800', inservice:'background:#2a7a4f;color:#fff', complete:'background:#1a5c7a;color:#fff', awaiting:'background:#6b4fb0;color:#fff', paid:'background:#5b6166;color:#fff', done:'background:#5b6166;color:#fff' }[est] || 'background:#f5c870;color:#3a2800';
    const statusLabel = { waiting:'Waiting', inservice:'In Service', complete:'Complete', awaiting:'Awaiting price', paid:'Paid', done:'Paid' }[est] || 'Waiting';
    const nextStatus = { waiting:'inservice', inservice:'complete', complete:'paid', awaiting:'paid', paid:'waiting', done:'waiting' }[est];
    // Correct an accidental status change (e.g. marked In Service by mistake). Not offered
    // from Paid — un-doing a finalized sale goes through the whole-ticket Reopen flow.
    const prevStatus = { inservice:'waiting', complete:'inservice', awaiting:'inservice' }[est];
    return `
      <div class="bg-surface-container-low rounded-xl p-4 border border-surface-container-high mb-3" data-service-id="${sid}">
        <div class="flex items-center justify-between mb-3">
          <div class="font-headline font-semibold text-on-surface flex items-center gap-2 flex-wrap">${s.label}${sug ? `<button onclick="acceptAssignSuggestion('${sid}','${sug.techId}')" title="Assign ${sug.techName}" class="text-[10px] px-2 py-0.5 rounded-full font-body font-semibold hover:opacity-80" style="background:#1a525218;color:#1a5252">→ ${sug.techName} ✓</button>` : ''}</div>
          <div class="flex items-center gap-1.5 flex-shrink-0">
            ${prevStatus ? `<button onclick="revertServiceStatus('${entry.id}','${sid}','${prevStatus}')" title="Move status back (fix a mistake)" class="w-7 h-7 rounded-full font-body font-semibold transition-all hover:opacity-80 flex items-center justify-center" style="background:#f3f4f6;color:#6b7280"><span class="material-symbols-outlined" style="font-size:16px">undo</span></button>` : ''}
            <button onclick="cycleServiceStatus('${entry.id}','${sid}','${nextStatus}')" class="text-[11px] px-3 py-1 rounded-full font-body font-semibold transition-all hover:opacity-80" style="${statusBtnStyle}">${statusLabel} ›</button>
          </div>
        </div>
        <div class="grid grid-cols-3 gap-3">
          <div><label class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest block mb-1">Technician</label>
            <select class="assign-tech w-full bg-surface-container border border-surface-container-high rounded-lg px-3 py-2 text-sm font-body text-on-surface focus:outline-none focus:border-primary" onchange="updateGroupTotal()"><option value="">— Unassigned —</option>${techOptions(a.techId)}</select></div>
          <div><label class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest block mb-1">Station</label>
            <select class="assign-station w-full bg-surface-container border border-surface-container-high rounded-lg px-3 py-2 text-sm font-body text-on-surface focus:outline-none focus:border-primary"><option value="">— None —</option>${stationOptions(a.station || entry.station)}</select></div>
          <div><label class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest block mb-1">Cost ($)</label>
            <input type="text" inputmode="none" placeholder="${s.baseCost != null ? Number(s.baseCost).toFixed(2) : '0.00'}" value="${a.comped ? '' : (a.cost != null && a.cost !== 0 ? a.cost : '')}" ${a.comped ? 'disabled' : ''}
              class="assign-cost w-full bg-surface-container border border-surface-container-high rounded-lg px-3 py-2 text-sm font-body text-on-surface focus:outline-none focus:border-primary cursor-pointer${a.comped ? ' opacity-50' : ''}"
              onfocus="openNumpad(this,'Cost — ${escAttrJs(s.label)}')" onclick="openNumpad(this,'Cost — ${escAttrJs(s.label)}')" oninput="updateGroupTotal()"></div>
        </div>
        <div class="flex items-center gap-2 mt-2">
          <label class="flex items-center gap-1.5 text-[11px] font-body text-on-surface-variant cursor-pointer select-none">
            <input type="checkbox" class="assign-comp" ${a.comped ? 'checked' : ''} onchange="toggleCompRow(this)" style="accent-color:#1a5252;width:15px;height:15px;flex-shrink:0"> Comp / No charge
          </label>
          <select class="assign-comp-reason bg-surface-container border border-surface-container-high rounded-lg px-2 py-1 text-[11px] font-body text-on-surface focus:outline-none focus:border-primary${a.comped ? '' : ' hidden'}" onchange="updateGroupTotal()">
            <option value="Comp"${a.compReason === 'Comp' ? ' selected' : ''}>Comp</option>
            <option value="Fix"${a.compReason === 'Fix' ? ' selected' : ''}>Fix / Redo</option>
          </select>
        </div>
      </div>`;
  }).join('');

  const svcPicker = cfg().services.filter(s => isServiceVisibleOnDash(s.id)).map(s => {
    const selected = entry.services.includes(s.id);
    return `<button type="button" onclick="toggleGroupService('${s.id}')" class="service-btn flex flex-col items-center justify-center py-2 rounded-lg border transition-all text-xs ${selected ? 'text-white border-transparent selected' : 'bg-surface-container text-on-surface-variant border-outline-variant/30'}" style="${selected ? `background:${color};border-color:${color}` : ''}">
      <span class="font-headline font-bold">${s.abbr}</span><span class="text-[9px] font-body mt-0.5 uppercase tracking-tighter leading-tight text-center">${s.label}</span></button>`;
  }).join('');

  const itemRows = cfg().items.map(item => {
    const existing = gItems.get(item.id) || {};
    return `<div class="bg-surface-container-low rounded-xl p-4 border border-surface-container-high mb-3" data-item-id="${item.id}">
        <div class="flex items-center justify-between">
          <div class="font-headline font-semibold text-on-surface text-sm">${item.label}<span class="ml-2 text-[10px] font-body text-outline-variant uppercase tracking-widest">Retail Item</span></div>
          <div class="flex items-center gap-2">
            <label class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest">Qty</label>
            <div class="flex items-center rounded-lg border border-surface-container-high overflow-hidden bg-surface-container">
              <button type="button" onclick="stepItemQty(this,-1)" aria-label="Decrease quantity" class="px-2.5 py-1.5 text-on-surface-variant font-headline font-bold text-base leading-none active:bg-surface-container-high">−</button>
              <input type="text" inputmode="none" readonly value="${existing.qty || 0}" class="item-qty w-8 bg-transparent border-0 px-0 py-1.5 text-sm font-body text-center focus:outline-none pointer-events-none">
              <button type="button" onclick="stepItemQty(this,1)" aria-label="Increase quantity" class="px-2.5 py-1.5 text-on-surface-variant font-headline font-bold text-base leading-none active:bg-surface-container-high">＋</button>
            </div>
            <label class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest">$</label>
            <input type="text" inputmode="none" value="${existing.price != null && existing.price !== 0 ? existing.price : ''}" placeholder="${item.price || '0.00'}" class="item-price w-16 bg-surface-container border border-surface-container-high rounded-lg px-2 py-1.5 text-sm font-body focus:outline-none focus:border-primary text-right cursor-pointer" onfocus="openNumpad(this,'${escAttrJs(item.label)}')" onclick="openNumpad(this,'${escAttrJs(item.label)}')" oninput="updateGroupTotal()">
          </div></div></div>`;
  }).join('');

  const hasSupplement = cfg().items.length > 0;   // fees moved to checkout (v4.51)
  const _nm = (entry.name||'').trim().split(/\s+/), _first = _nm[0] || '', _last = _nm.slice(1).join(' ') || '';
  content.innerHTML = `
    <div class="flex items-center gap-2 mb-3 flex-wrap"><span class="w-3 h-3 rounded-full flex-shrink-0" style="background:${color}"></span>
      <input id="ga-first" type="text" value="${_first.replace(/"/g,'&quot;')}" oninput="autoCapitalize(this)" placeholder="First"
        class="font-headline font-bold text-on-surface bg-transparent border-b border-surface-container-high focus:border-primary outline-none px-1 py-0.5 w-24 flex-shrink-0">
      <input id="ga-last" type="text" value="${_last.replace(/"/g,'&quot;')}" oninput="autoCapitalize(this)" placeholder="Last"
        class="font-headline font-semibold text-on-surface bg-transparent border-b border-surface-container-high focus:border-primary outline-none px-1 py-0.5 w-24 flex-shrink-0">
      <input id="ga-phone" type="tel" value="${(entry.phone||'').replace(/"/g,'&quot;')}" onfocus="openPhoneNumpad(this)" placeholder="Phone"
        class="text-sm font-body text-on-surface-variant bg-transparent border-b border-surface-container-high focus:border-primary outline-none px-1 py-0.5 w-36 flex-shrink-0">
      ${entry.groupLabel ? `<span class="text-[10px] font-body italic flex-shrink-0" style="color:${color}">${entry.groupLabel}</span>` : ''}</div>
    <div class="mb-1"><label class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest block mb-2">Services</label>
      <div class="grid grid-cols-4 gap-2 mb-4">${svcPicker}</div></div>
    ${serviceRows}
    ${isParty ? `<div class="border-t border-surface-container-high mt-2 pt-2 -mb-1 flex items-center gap-1.5 text-[11px] font-body text-on-surface-variant"><span class="material-symbols-outlined" style="font-size:14px;color:${color}">receipt_long</span>The items &amp; discount below apply to the <strong>whole party</strong> (entered once). The service fee is added at checkout.</div>` : ''}
    ${hasSupplement ? `<div class="border-t border-surface-container-high mt-2 pt-3 mb-2"><div class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest mb-3">${isParty ? 'Whole-ticket ' : ''}Items</div>${itemRows}</div>` : ''}
    <div class="border-t border-surface-container-high pt-3 mb-2">
      <button type="button" onclick="assignToggleGcForm()" class="flex items-center gap-1.5 text-sm font-body font-semibold text-primary hover:underline"><span class="material-symbols-outlined" style="font-size:18px">card_giftcard</span> + Gift Card</button>
      <div id="ga-gc-form" class="hidden mt-2 p-3 rounded-xl border border-primary/40 bg-primary/5 space-y-2">
        <div class="grid grid-cols-2 gap-2">
          <div><label class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest block mb-0.5">Amount</label><input id="ga-gc-amount" type="text" inputmode="decimal" onfocus="openNumpad(this,'Gift card amount')" placeholder="0.00" class="w-full border-2 border-surface-container-high bg-transparent rounded-lg px-3 py-1.5 text-sm font-headline focus:border-primary outline-none"></div>
          <div><label class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest block mb-0.5">Serial <span class="normal-case tracking-normal text-on-surface-variant">(optional)</span></label><input id="ga-gc-serial" type="text" placeholder="#00000000" class="w-full border-2 border-surface-container-high bg-transparent rounded-lg px-3 py-1.5 text-sm font-headline focus:border-primary outline-none"></div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div><label class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest block mb-0.5">To (recipient)</label><input id="ga-gc-to" type="text" oninput="autoCapitalize(this)" class="w-full border-2 border-surface-container-high bg-transparent rounded-lg px-3 py-1.5 text-sm font-body focus:border-primary outline-none"></div>
          <div><label class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest block mb-0.5">Recipient phone</label><input id="ga-gc-phone" type="tel" placeholder="(000) 000-0000" oninput="formatPhone(this)" class="w-full border-2 border-surface-container-high bg-transparent rounded-lg px-3 py-1.5 text-sm font-body focus:border-primary outline-none"></div>
        </div>
        <div><label class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest block mb-0.5">From <span class="normal-case tracking-normal text-on-surface-variant">(note)</span></label><input id="ga-gc-from" type="text" oninput="autoCapitalize(this)" class="w-full border-2 border-surface-container-high bg-transparent rounded-lg px-3 py-1.5 text-sm font-body focus:border-primary outline-none"></div>
        <button type="button" onclick="assignAddGiftCard()" class="w-full py-2 rounded-lg bg-primary text-on-primary font-body font-bold text-sm hover:bg-primary-dim transition-colors">Add gift card to ticket</button>
      </div>
      ${(entry.giftcardSales || []).map((g, i) => `<div class="flex items-center gap-2 py-1.5 mt-1 border-t border-surface-container first:border-t-0"><span class="material-symbols-outlined text-primary flex-shrink-0" style="font-size:18px">card_giftcard</span><span class="flex-1 min-w-0 truncate font-body text-on-surface text-sm">Gift Card${g.serial ? ' #' + String(g.serial).replace(/[<>&"]/g, '') : ''}${g.to ? ' → ' + String(g.to).replace(/[<>&"]/g, '') : ''}</span><button type="button" onclick="assignRemoveGiftCard(${i})" class="text-on-surface-variant hover:text-error flex-shrink-0"><span class="material-symbols-outlined" style="font-size:16px">close</span></button><span class="font-headline font-bold text-primary text-sm flex-shrink-0">$${(+g.amount).toFixed(2)}</span></div>`).join('')}
    </div>
    <div class="border-t border-surface-container-high pt-3 mb-2"><div class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest mb-2">${isParty ? 'Whole-ticket ' : ''}Discount</div>
      <div class="bg-surface-container-low rounded-xl p-3 border border-surface-container-high">
        <div class="flex items-center gap-2 mb-2">
          <select class="discount-type-select bg-surface-container border border-surface-container-high rounded-lg px-2 py-1.5 text-xs font-body focus:outline-none focus:border-primary" onchange="updateGroupTotal()"><option value="flat">$ Off</option><option value="percent">% Off</option></select>
          <input type="text" inputmode="none" class="discount-input flex-1 bg-surface-container border border-surface-container-high rounded-lg px-3 py-1.5 text-sm font-body text-right focus:outline-none focus:border-primary cursor-pointer" value="${gDiscount && gDiscount > 0 ? gDiscount : ''}" placeholder="0" onfocus="openDiscountNumpad(this)" onclick="openDiscountNumpad(this)" oninput="updateGroupTotal()">
        </div>
        <input type="text" maxlength="60" class="discount-note-input w-full bg-surface-container border border-surface-container-high rounded-lg px-3 py-1.5 text-xs font-body focus:outline-none focus:border-primary" value="${gNote || ''}" placeholder="Reason (optional)">
      </div></div>
    <div class="border-t border-surface-container-high pt-3 flex items-center justify-between">
      <span class="font-body font-semibold text-on-surface text-sm">${isParty ? "This guest's services" : 'Subtotal'}</span>
      <span id="group-subtotal" class="font-headline font-bold text-primary">$0.00</span></div>`;
  updateGroupTotal();
  document.getElementById('group-split-btn')?.classList.toggle('hidden', !isParty);   // Split only shown for a party
  // Load this tab's transaction note into the side notes panel (per active entry).
  const noteEl = document.getElementById('assign-txn-note'); if (noteEl) noteEl.value = entry.txnNote || '';
  _setAssignCustNote(entry.phone);   // + the customer's saved note (persistent, read-only)
}

// Today's-transaction note (the side panel) — saves to the active entry as you type.
export function saveAssignTxnNote() {
  const entry = q().find(e => String(e.id) === groupAssignEntries[activeGroupTab]);
  const el = document.getElementById('assign-txn-note');
  if (entry && el) entry.txnNote = el.value;
}

// Load the editable "Customer note" field in the assign/price notes panel from the
// customer's saved (phone-keyed) note. No phone on file → disabled with a hint.
function _setAssignCustNote(phone) {
  const el = document.getElementById('assign-cust-note');
  if (!el) return;
  const key = notePhoneKey(phone);
  el.value = key ? (customerNote(phone) || '') : '';
  el.disabled = !key;
  el.placeholder = key ? 'Add allergies, preferences, anything that should follow this customer…'
                       : 'Add a phone number to save a customer note';
}
// Editable customer note in the assign/price panel — debounced save to the synced,
// phone-keyed config.customer_notes (the same store the check-in popup + Customers
// tab use), so an edit here follows the customer everywhere.
let _assignCustNoteTimer = null;
export function saveAssignCustNote() {
  clearTimeout(_assignCustNoteTimer);
  _assignCustNoteTimer = setTimeout(_persistAssignCustNote, 600);
}
function _persistAssignCustNote() {
  const entry = q().find(e => String(e.id) === groupAssignEntries[activeGroupTab]);
  const el = document.getElementById('assign-cust-note');
  if (!entry || !el) return;
  const key = notePhoneKey(entry.phone);
  if (!key) return;                                  // no phone → nothing to key the note by
  const val = el.value.trim();
  const notes = { ...(cfg().customer_notes || {}) };
  if (val) notes[key] = val; else delete notes[key];
  dispatch('config.set', { key: 'customer_notes', value: notes });
}

// ── Gift card sold on a service ticket (Phase 3 "B") — same liability-line model as Quick Sale.
export function assignToggleGcForm() {
  const f = document.getElementById('ga-gc-form'); if (!f) return;
  f.classList.toggle('hidden');
  if (!f.classList.contains('hidden')) setTimeout(() => document.getElementById('ga-gc-amount')?.focus(), 60);
}
export function assignAddGiftCard() {
  // One-list has no active tab — the gift-card form is a whole-party extra, so anchor new
  // cards on the first party member deterministically (tabbed mode keeps the active tab).
  const targetId = ASSIGN_ONELIST ? groupAssignEntries[0] : groupAssignEntries[activeGroupTab];
  const entry = q().find(e => String(e.id) === targetId); if (!entry) return;
  const amount = parseFloat(document.getElementById('ga-gc-amount')?.value) || 0;
  if (!(amount > 0)) { showToast('Enter the gift card amount.'); return; }
  entry.giftcardSales = [...(entry.giftcardSales || []), {
    amount,
    serial: (document.getElementById('ga-gc-serial')?.value || '').trim(),
    to:     (document.getElementById('ga-gc-to')?.value || '').trim(),
    phone:  (document.getElementById('ga-gc-phone')?.value || '').trim(),
    from:   (document.getElementById('ga-gc-from')?.value || '').trim(),
  }];
  saveCurrentGroupTabInputs();      // keep the other typed inputs
  renderGroupAssignContent();       // re-render: shows the new line + updated Party Total
}
export function assignRemoveGiftCard(idx) {
  const entry = q().find(e => String(e.id) === groupAssignEntries[activeGroupTab]); if (!entry) return;
  if (entry.giftcardSales && idx >= 0 && idx < entry.giftcardSales.length) { entry.giftcardSales.splice(idx, 1); saveCurrentGroupTabInputs(); renderGroupAssignContent(); }
}
// One-list: remove a card from a SPECIFIC party member's array (the rendered line carries
// its owner id + local index), so multi-member parties remove the right card.
export function assignRemoveGiftCardFor(entryId, idx) {
  const entry = q().find(e => String(e.id) === String(entryId)); if (!entry) return;
  if (entry.giftcardSales && idx >= 0 && idx < entry.giftcardSales.length) { entry.giftcardSales.splice(idx, 1); saveCurrentGroupTabInputs(); renderGroupAssignContent(); }
}

// ── B5 one-list renderer: catalog pane left, every guest's lines right ────────
function _assignSvcRowHtml(entry, sid, techOptions, stationOptions, allowRemove) {
  const s = svc(sid) || { id: sid, label: sid };
  const a = (entry.assignments || []).find(x => x.serviceId === sid) || {};
  const st = getAssignmentStatus(entry, a);
  const est = isAwaitingPrice(a) ? 'awaiting' : st;
  const sug = !a.techId ? (window.suggestTechsForEntry?.(entry)?.[sid] || null) : null;
  const statusBtnStyle = { waiting:'background:#f5c870;color:#3a2800', inservice:'background:#2a7a4f;color:#fff', complete:'background:#1a5c7a;color:#fff', awaiting:'background:#6b4fb0;color:#fff', paid:'background:#5b6166;color:#fff', done:'background:#5b6166;color:#fff' }[est] || 'background:#f5c870;color:#3a2800';
  const statusLabel = { waiting:'Waiting', inservice:'In Service', complete:'Done', awaiting:'Awaiting price', paid:'Paid', done:'Paid' }[est] || 'Waiting';
  const nextStatus = { waiting:'inservice', inservice:'complete', complete:'paid', awaiting:'paid', paid:'waiting', done:'waiting' }[est];
  const prevStatus = { inservice:'waiting', complete:'inservice', awaiting:'inservice' }[est];
  return `
    <div class="bg-surface-container-low rounded-xl p-3.5 border border-surface-container-high mb-2.5" data-service-id="${sid}">
      <div class="flex items-center justify-between mb-2.5">
        <div class="font-headline font-semibold text-on-surface flex items-center gap-2 flex-wrap">${s.label}${sug ? `<button onclick="acceptAssignSuggestion('${sid}','${sug.techId}','${entry.id}')" title="Assign ${sug.techName}" class="text-[10px] px-2 py-0.5 rounded-full font-body font-semibold hover:opacity-80" style="background:#1a525218;color:#1a5252">→ ${sug.techName} ✓</button>` : ''}</div>
        <div class="flex items-center gap-1.5 flex-shrink-0">
          ${prevStatus ? `<button onclick="revertServiceStatus('${entry.id}','${sid}','${prevStatus}')" title="Move status back (fix a mistake)" class="w-7 h-7 rounded-full font-body font-semibold transition-all hover:opacity-80 flex items-center justify-center" style="background:#f3f4f6;color:#6b7280"><span class="material-symbols-outlined" style="font-size:16px">undo</span></button>` : ''}
          <button onclick="cycleServiceStatus('${entry.id}','${sid}','${nextStatus}')" class="text-[11px] px-3 py-1 rounded-full font-body font-semibold transition-all hover:opacity-80" style="${statusBtnStyle}">${statusLabel} ›</button>
          ${allowRemove ? `<button onclick="removeServiceFromGuest('${entry.id}','${sid}')" title="Remove this service" class="w-7 h-7 rounded-full flex items-center justify-center text-outline-variant hover:text-error hover:bg-error/10 transition-colors"><span class="material-symbols-outlined" style="font-size:15px">close</span></button>` : ''}
        </div>
      </div>
      <div class="grid grid-cols-3 gap-3">
        <div><label class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest block mb-1">Technician</label>
          <select class="assign-tech w-full bg-surface-container border border-surface-container-high rounded-lg px-3 py-2 text-sm font-body text-on-surface focus:outline-none focus:border-primary" onchange="updateGroupTotal()"><option value="">— Unassigned —</option>${techOptions(a.techId)}</select></div>
        <div><label class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest block mb-1">Station</label>
          <select class="assign-station w-full bg-surface-container border border-surface-container-high rounded-lg px-3 py-2 text-sm font-body text-on-surface focus:outline-none focus:border-primary"><option value="">— None —</option>${stationOptions(a.station || entry.station)}</select></div>
        <div><label class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest block mb-1">Cost ($)</label>
          <input type="text" inputmode="none" placeholder="${s.baseCost != null ? Number(s.baseCost).toFixed(2) : '0.00'}" value="${a.comped ? '' : (a.cost != null && a.cost !== 0 ? a.cost : '')}" ${a.comped ? 'disabled' : ''}
            class="assign-cost w-full bg-surface-container border border-surface-container-high rounded-lg px-3 py-2 text-sm font-body text-on-surface focus:outline-none focus:border-primary cursor-pointer${a.comped ? ' opacity-50' : ''}"
            onfocus="openNumpad(this,'Cost — ${escAttrJs(s.label)}')" onclick="openNumpad(this,'Cost — ${escAttrJs(s.label)}')" oninput="updateGroupTotal()"></div>
      </div>
      <div class="flex items-center gap-2 mt-2">
        <label class="flex items-center gap-1.5 text-[11px] font-body text-on-surface-variant cursor-pointer select-none">
          <input type="checkbox" class="assign-comp" ${a.comped ? 'checked' : ''} onchange="toggleCompRow(this)" style="accent-color:#1a5252;width:15px;height:15px;flex-shrink:0"> Comp / No charge
        </label>
        <select class="assign-comp-reason bg-surface-container border border-surface-container-high rounded-lg px-2 py-1 text-[11px] font-body text-on-surface focus:outline-none focus:border-primary${a.comped ? '' : ' hidden'}" onchange="updateGroupTotal()">
          <option value="Comp"${a.compReason === 'Comp' ? ' selected' : ''}>Comp</option>
          <option value="Fix"${a.compReason === 'Fix' ? ' selected' : ''}>Fix / Redo</option>
        </select>
      </div>
    </div>`;
}

function _renderAssignOneList() {
  const party = groupAssignEntries.map(id => q().find(e => String(e.id) === id)).filter(Boolean);
  if (!party.length) return;
  const content = document.getElementById('group-assign-content');
  const isParty = party.length > 1;
  // Widen the shell for the two panes (the tabbed layout's max-w-2xl is too narrow).
  const shell = content.closest('.max-w-2xl'); if (shell) shell.style.maxWidth = '58rem';
  // Whole-ticket extras gathered across the party (same consolidation as the tabbed layout).
  const gItems = new Map(); let gDiscount = 0, gNote = '', gcCount = 0;
  party.forEach(e => {
    (e.items || []).forEach(it => { const c = gItems.get(it.itemId); if (c) c.qty += (it.qty || 0); else gItems.set(it.itemId, { qty: it.qty || 0, price: it.price || 0 }); });
    gDiscount += e.discount || 0;
    if (!gNote && e.discountNote) gNote = e.discountNote;
    gcCount += (e.giftcardSales || []).length;
  });
  const checkedIn = activeStaff().filter(s => cfg().turns_order.includes(s.id)).sort(byName);
  const techOptions = sel => {
    let opts = checkedIn;
    if (sel && !checkedIn.some(s => s.id === sel)) { const assigned = staffById(sel); if (assigned) opts = [...checkedIn, assigned]; }
    return opts.length > 0
      ? opts.map(st => `<option value="${st.id}" ${sel === st.id ? 'selected' : ''}>${st.name}${cfg().inactive_staff.includes(st.id) ? ' (inactive)' : ''}</option>`).join('')
      : `<option value="" disabled>No techs checked in — add in Turns tab</option>`;
  };
  const stationOptions = sel => stationDefs().map(s => `<option value="${s.id}" ${sel === s.id ? 'selected' : ''}>${s.label || s.id}</option>`).join('');

  const catalog = cfg().services.filter(s => isServiceVisibleOnDash(s.id)).map(s =>
    `<button type="button" onclick="assignCatalogTap('${s.id}')" class="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl border border-surface-container-high bg-surface-container-lowest hover:border-primary hover:bg-primary/5 transition-colors text-left mb-1.5">
      <span class="text-sm font-body font-semibold text-on-surface">${s.label}</span>
      <span class="text-xs font-headline font-bold text-outline">${s.baseCost != null ? '$' + Number(s.baseCost).toFixed(0) : ''}</span></button>`).join('');

  const guestSections = party.map(e => {
    const color = e.groupColor || '#1a5252';
    const nm = (e.name || '').trim().split(/\s+/), first = nm[0] || '', last = nm.slice(1).join(' ') || '';
    const rows = e.services.map(sid => _assignSvcRowHtml(e, sid, techOptions, stationOptions, e.services.length > 1)).join('')
      || `<div class="text-xs font-body text-on-surface-variant py-2 px-1 opacity-70">No services — tap one in the catalog.</div>`;
    return `<div data-assign-entry="${e.id}" class="mb-4">
      <div class="flex items-center gap-2 mb-2 flex-wrap">
        <span class="w-3 h-3 rounded-full flex-shrink-0" style="background:${color}"></span>
        <input type="text" value="${first.replace(/"/g,'&quot;')}" oninput="autoCapitalize(this)" placeholder="First"
          class="ga-first font-headline font-bold text-on-surface bg-transparent border-b border-surface-container-high focus:border-primary outline-none px-1 py-0.5 w-24 flex-shrink-0">
        <input type="text" value="${last.replace(/"/g,'&quot;')}" oninput="autoCapitalize(this)" placeholder="Last"
          class="ga-last font-headline font-semibold text-on-surface bg-transparent border-b border-surface-container-high focus:border-primary outline-none px-1 py-0.5 w-24 flex-shrink-0">
        <input type="tel" value="${(e.phone||'').replace(/"/g,'&quot;')}" onfocus="openPhoneNumpad(this)" placeholder="Phone"
          class="ga-phone text-sm font-body text-on-surface-variant bg-transparent border-b border-surface-container-high focus:border-primary outline-none px-1 py-0.5 w-36 flex-shrink-0">
        <button onclick="openCustomerFromAssign('${e.id}')" title="Edit customer" class="w-7 h-7 rounded-full hover:bg-surface-container-high flex items-center justify-center text-on-surface-variant transition-colors flex-shrink-0"><span class="material-symbols-outlined" style="font-size:16px">person_edit</span></button>
        ${isParty ? `<span class="ml-auto text-sm font-headline font-bold text-primary flex-shrink-0" id="ga-sub-${e.id}">$0.00</span>` : ''}
      </div>
      ${rows}
    </div>`;
  }).join('');

  const itemRows = cfg().items.map(item => {
    const existing = gItems.get(item.id) || {};
    return `<div class="bg-surface-container-low rounded-xl p-3.5 border border-surface-container-high mb-2.5" data-item-id="${item.id}">
        <div class="flex items-center justify-between">
          <div class="font-headline font-semibold text-on-surface text-sm">${item.label}<span class="ml-2 text-[10px] font-body text-outline-variant uppercase tracking-widest">Retail Item</span></div>
          <div class="flex items-center gap-2">
            <label class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest">Qty</label>
            <div class="flex items-center rounded-lg border border-surface-container-high overflow-hidden bg-surface-container">
              <button type="button" onclick="stepItemQty(this,-1)" aria-label="Decrease quantity" class="px-2.5 py-1.5 text-on-surface-variant font-headline font-bold text-base leading-none active:bg-surface-container-high">−</button>
              <input type="text" inputmode="none" readonly value="${existing.qty || 0}" class="item-qty w-8 bg-transparent border-0 px-0 py-1.5 text-sm font-body text-center focus:outline-none pointer-events-none">
              <button type="button" onclick="stepItemQty(this,1)" aria-label="Increase quantity" class="px-2.5 py-1.5 text-on-surface-variant font-headline font-bold text-base leading-none active:bg-surface-container-high">＋</button>
            </div>
            <label class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest">$</label>
            <input type="text" inputmode="none" value="${existing.price != null && existing.price !== 0 ? existing.price : ''}" placeholder="${item.price || '0.00'}" class="item-price w-16 bg-surface-container border border-surface-container-high rounded-lg px-2 py-1.5 text-sm font-body focus:outline-none focus:border-primary text-right cursor-pointer" onfocus="openNumpad(this,'${escAttrJs(item.label)}')" onclick="openNumpad(this,'${escAttrJs(item.label)}')" oninput="updateGroupTotal()">
          </div></div></div>`;
  }).join('');

  // Each gift-card line carries its OWNING entry id + that entry's local index, so the ✕
  // removes the right card on a party where cards sit on more than one member (a flat
  // party-wide index would address the wrong guest's array).
  const anyGc = party.flatMap(e => (e.giftcardSales || []).map((g, gi) => ({ g, ownerId: e.id, gi })));
  const extrasOpen = gDiscount > 0 || gcCount > 0 || [...gItems.values()].some(i => (i.qty || 0) > 0);
  const extrasSummary = [
    [...gItems.values()].reduce((s,i)=>s+(i.qty||0),0) ? `${[...gItems.values()].reduce((s,i)=>s+(i.qty||0),0)} item(s)` : '',
    gcCount ? `${gcCount} gift card(s)` : '',
    gDiscount > 0 ? `$${gDiscount.toFixed(2)} off` : '',
  ].filter(Boolean).join(' · ');

  content.innerHTML = `
    <div class="flex gap-4 items-start">
      <div class="w-44 flex-shrink-0" style="position:sticky;top:0">
        <div class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest mb-2">Services</div>
        <div style="max-height:56vh;overflow-y:auto" class="no-scroll pr-0.5">${catalog}</div>
      </div>
      <div class="flex-1 min-w-0">
        ${guestSections}
        <div class="border-t border-surface-container-high pt-2.5">
          <button type="button" onclick="assignToggleExtras()" class="flex items-center gap-1.5 text-sm font-body font-semibold text-primary hover:underline">
            <span class="material-symbols-outlined" style="font-size:18px" id="ga-extras-chev">${extrasOpen ? 'expand_more' : 'chevron_right'}</span>
            Items, gift cards &amp; discount${extrasSummary ? ` <span class="text-xs font-normal text-on-surface-variant">— ${extrasSummary}</span>` : ''}
          </button>
          <div id="ga-extras" class="${extrasOpen ? '' : 'hidden'} mt-2">
            ${isParty ? `<div class="-mt-1 mb-2 flex items-center gap-1.5 text-[11px] font-body text-on-surface-variant"><span class="material-symbols-outlined" style="font-size:14px">receipt_long</span>These apply to the <strong>whole party</strong> (entered once). The service fee is added at checkout.</div>` : ''}
            ${itemRows}
            <div class="pt-1 mb-2">
              <button type="button" onclick="assignToggleGcForm()" class="flex items-center gap-1.5 text-sm font-body font-semibold text-primary hover:underline"><span class="material-symbols-outlined" style="font-size:18px">card_giftcard</span> + Gift Card</button>
              <div id="ga-gc-form" class="hidden mt-2 p-3 rounded-xl border border-primary/40 bg-primary/5 space-y-2">
                <div class="grid grid-cols-2 gap-2">
                  <div><label class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest block mb-0.5">Amount</label><input id="ga-gc-amount" type="text" inputmode="decimal" onfocus="openNumpad(this,'Gift card amount')" placeholder="0.00" class="w-full border-2 border-surface-container-high bg-transparent rounded-lg px-3 py-1.5 text-sm font-headline focus:border-primary outline-none"></div>
                  <div><label class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest block mb-0.5">Serial <span class="normal-case tracking-normal text-on-surface-variant">(optional)</span></label><input id="ga-gc-serial" type="text" placeholder="#00000000" class="w-full border-2 border-surface-container-high bg-transparent rounded-lg px-3 py-1.5 text-sm font-headline focus:border-primary outline-none"></div>
                </div>
                <div class="grid grid-cols-2 gap-2">
                  <div><label class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest block mb-0.5">To (recipient)</label><input id="ga-gc-to" type="text" oninput="autoCapitalize(this)" class="w-full border-2 border-surface-container-high bg-transparent rounded-lg px-3 py-1.5 text-sm font-body focus:border-primary outline-none"></div>
                  <div><label class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest block mb-0.5">Recipient phone</label><input id="ga-gc-phone" type="tel" placeholder="(000) 000-0000" oninput="formatPhone(this)" class="w-full border-2 border-surface-container-high bg-transparent rounded-lg px-3 py-1.5 text-sm font-body focus:border-primary outline-none"></div>
                </div>
                <div><label class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest block mb-0.5">From <span class="normal-case tracking-normal text-on-surface-variant">(note)</span></label><input id="ga-gc-from" type="text" oninput="autoCapitalize(this)" class="w-full border-2 border-surface-container-high bg-transparent rounded-lg px-3 py-1.5 text-sm font-body focus:border-primary outline-none"></div>
                <button type="button" onclick="assignAddGiftCard()" class="w-full py-2 rounded-lg bg-primary text-on-primary font-body font-bold text-sm hover:bg-primary-dim transition-colors">Add gift card to ticket</button>
              </div>
              ${anyGc.map(({ g, ownerId, gi }) => `<div class="flex items-center gap-2 py-1.5 mt-1 border-t border-surface-container first:border-t-0"><span class="material-symbols-outlined text-primary flex-shrink-0" style="font-size:18px">card_giftcard</span><span class="flex-1 min-w-0 truncate font-body text-on-surface text-sm">Gift Card${g.serial ? ' #' + escHtml(g.serial) : ''}${g.to ? ' → ' + escHtml(g.to) : ''}</span><button type="button" onclick="assignRemoveGiftCardFor('${escAttrJs(String(ownerId))}',${gi})" class="text-on-surface-variant hover:text-error flex-shrink-0"><span class="material-symbols-outlined" style="font-size:16px">close</span></button><span class="font-headline font-bold text-primary text-sm flex-shrink-0">$${(+g.amount).toFixed(2)}</span></div>`).join('')}
            </div>
            <div class="pt-1"><div class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest mb-2">Discount</div>
              <div class="bg-surface-container-low rounded-xl p-3 border border-surface-container-high">
                <div class="flex items-center gap-2 mb-2">
                  <select class="discount-type-select bg-surface-container border border-surface-container-high rounded-lg px-2 py-1.5 text-xs font-body focus:outline-none focus:border-primary" onchange="updateGroupTotal()"><option value="flat">$ Off</option><option value="percent">% Off</option></select>
                  <input type="text" inputmode="none" class="discount-input flex-1 bg-surface-container border border-surface-container-high rounded-lg px-3 py-1.5 text-sm font-body text-right focus:outline-none focus:border-primary cursor-pointer" value="${gDiscount && gDiscount > 0 ? gDiscount : ''}" placeholder="0" onfocus="openDiscountNumpad(this)" onclick="openDiscountNumpad(this)" oninput="updateGroupTotal()">
                </div>
                <input type="text" maxlength="60" class="discount-note-input w-full bg-surface-container border border-surface-container-high rounded-lg px-3 py-1.5 text-xs font-body focus:outline-none focus:border-primary" value="${(gNote || '').replace(/"/g,'&quot;')}" placeholder="Reason (optional)">
              </div></div>
          </div>
        </div>
      </div>
    </div>`;
  updateGroupTotal();
  document.getElementById('group-split-btn')?.classList.toggle('hidden', !isParty);
  const noteEl = document.getElementById('assign-txn-note'); if (noteEl) noteEl.value = party[0].txnNote || '';
  _setAssignCustNote(party[0].phone);   // + the customer's saved note (persistent, read-only)
}

export function assignToggleExtras() {
  const x = document.getElementById('ga-extras'), chev = document.getElementById('ga-extras-chev');
  if (!x) return;
  x.classList.toggle('hidden');
  if (chev) chev.textContent = x.classList.contains('hidden') ? 'chevron_right' : 'expand_more';
}

// Catalog tap: solo → toggle for the one guest (familiar); party → ask "for whom?".
export function assignCatalogTap(sid) {
  if (groupAssignEntries.length === 1) { assignServiceToggleFor(groupAssignEntries[0], sid); return; }
  saveCurrentGroupTabInputs();
  const s = svc(sid);
  const party = groupAssignEntries.map(id => q().find(e => String(e.id) === id)).filter(Boolean);
  closeAssignGuestPick();
  const pick = document.createElement('div');
  pick.id = 'assign-guest-pick';
  pick.className = 'fixed inset-0 z-[70] flex items-center justify-center bg-on-surface/30 px-4';
  pick.innerHTML = `<div class="bg-surface-container-lowest rounded-2xl p-5 w-full max-w-xs shadow-2xl">
    <div class="font-headline font-bold text-on-surface mb-3">${s ? s.label : 'Service'} — for whom?</div>
    <div class="space-y-2 mb-3">${party.map(e => {
      const has = e.services.includes(sid);
      return `<button onclick="assignServiceToggleFor('${e.id}','${sid}'); this.querySelector('.gp-check').textContent = this.querySelector('.gp-check').textContent ? '' : 'check';"
        class="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl border border-surface-container-high hover:border-primary hover:bg-primary/5 transition-colors text-left">
        <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${e.groupColor || '#1a5252'}"></span>
        <span class="flex-1 font-body font-semibold text-sm text-on-surface">${escHtml((e.name || 'Guest').split(' ')[0])}</span>
        <span class="material-symbols-outlined gp-check text-primary" style="font-size:18px">${has ? 'check' : ''}</span></button>`;
    }).join('')}</div>
    <button onclick="closeAssignGuestPick()" class="w-full py-2.5 rounded-xl bg-primary text-on-primary font-headline font-bold text-sm">Done</button></div>`;
  document.body.appendChild(pick);
}
export function closeAssignGuestPick() { document.getElementById('assign-guest-pick')?.remove(); }
export function assignServiceToggleFor(entryId, sid) {
  saveCurrentGroupTabInputs();
  const entry = q().find(e => String(e.id) === String(entryId)); if (!entry) return;
  if (entry.services.includes(sid)) {
    if (entry.services.length === 1 && groupAssignEntries.length === 1) { showToast('At least one service required.'); return; }
    entry.services = entry.services.filter(id => id !== sid);
    if (entry.assignments) entry.assignments = entry.assignments.filter(a => a.serviceId !== sid);
  } else entry.services.push(sid);
  renderGroupAssignContent();
}
export function removeServiceFromGuest(entryId, sid) {
  const entry = q().find(e => String(e.id) === String(entryId)); if (!entry) return;
  if (entry.services.includes(sid) && entry.services.length === 1 && groupAssignEntries.length === 1) { showToast('At least one service required.'); return; }
  assignServiceToggleFor(entryId, sid);
}

// One-list save: every guest's rows are in the DOM under their [data-assign-entry] section.
// Mirrors the tabbed save exactly — per-row reads, then the whole-ticket consolidation.
function _saveAssignOneList() {
  commitNumpad();
  const party = groupAssignEntries.map(id => q().find(e => String(e.id) === id)).filter(Boolean);
  if (!party.length) return;
  party.forEach(entry => {
    const sec = document.querySelector(`#group-assign-content [data-assign-entry="${entry.id}"]`); if (!sec) return;
    const firstEl = sec.querySelector('.ga-first'), lastEl = sec.querySelector('.ga-last'), phoneEl = sec.querySelector('.ga-phone');
    if (firstEl || lastEl || phoneEl) {
      const newName = [firstEl?.value.trim() || '', lastEl?.value.trim() || ''].filter(Boolean).join(' ');
      const newPhone = phoneEl ? phoneEl.value.trim() : (entry.phone || '');
      if ((newName && newName !== entry.name) || newPhone !== (entry.phone || '')) _custEditedIds.add(String(entry.id));
      if (newName) entry.name = newName;
      entry.phone = newPhone;
    }
    if (!entry.assignments) entry.assignments = [];
    sec.querySelectorAll('[data-service-id]').forEach(row => {
      const sid = row.dataset.serviceId;
      let a = entry.assignments.find(x => x.serviceId === sid);
      const isNew = !a;
      if (!a) { a = { serviceId: sid, status: 'waiting' }; entry.assignments.push(a); }
      _applyRowToAssignment(entry.id, a, row, isNew);
    });
    entry.services = entry.assignments.map(a => a.serviceId);
  });
  const noteEl = document.getElementById('assign-txn-note'); if (noteEl) party[0].txnNote = noteEl.value;

  // Whole-ticket items / fees / discount → consolidated onto the anchor (same as tabbed).
  const memberSvc = e => (e.assignments || []).reduce((s, a) => s + (a.cost || 0), 0);
  const partySvcSubtotal = party.reduce((s, e) => s + memberSvc(e), 0);
  const partyItems = [];
  document.querySelectorAll('#group-assign-content [data-item-id]').forEach(row => {
    const qty = parseInt(row.querySelector('.item-qty')?.value) || 0;
    const price = parseFloat(row.querySelector('.item-price')?.value) || 0;
    if (price > 0 && qty > 0) partyItems.push({ itemId: row.dataset.itemId, qty, price });
  });
  const _feeMerge = new Map();
  party.forEach(e => (e.fees || []).forEach(f => {
    const cur = _feeMerge.get(f.feeId);
    if (cur) cur.amount += (f.amount || 0); else _feeMerge.set(f.feeId, { feeId: f.feeId, amount: f.amount || 0, type: f.type });
  }));
  const partyFees = [];
  _feeMerge.forEach(f => {
    const def = cfg().fees.find(x => x.id === f.feeId);
    const amount = (f.type === 'percent' && def) ? Math.round(partySvcSubtotal * (def.value || 0) / 100 * 100) / 100 : f.amount;
    if (amount > 0) partyFees.push({ feeId: f.feeId, amount, type: f.type });
  });
  const partyItemTotal = partyItems.reduce((s, i) => s + i.price * (i.qty || 0), 0);
  const partyFeeTotal  = partyFees.reduce((s, f) => s + (f.amount || 0), 0);
  const discountType  = document.querySelector('#group-assign-content .discount-type-select')?.value || 'flat';
  const discountInput = parseFloat(document.querySelector('#group-assign-content .discount-input')?.value) || 0;
  const discountNote  = document.querySelector('#group-assign-content .discount-note-input')?.value?.trim() || '';
  let partyDiscount = discountType === 'percent' ? Math.round(partySvcSubtotal * discountInput / 100 * 100) / 100 : discountInput;
  let anchor = party[0], anchorSub = -1;
  party.forEach(e => { const sub = memberSvc(e); if (sub > anchorSub) { anchorSub = sub; anchor = e; } });
  const anchorBase = anchorSub + partyItemTotal + partyFeeTotal;
  if (partyDiscount > anchorBase) { partyDiscount = Math.max(0, anchorBase); showToast(`Discount capped at $${partyDiscount.toFixed(2)} for this ticket.`); }
  party.forEach(e => {
    const isAnchor = String(e.id) === String(anchor.id);
    e.items        = isAnchor ? partyItems : [];
    e.fees         = isAnchor ? partyFees  : [];
    e.discount     = isAnchor ? partyDiscount : 0;
    e.discountNote = isAnchor ? discountNote  : '';
    e.totalCost    = Math.max(0, memberSvc(e) + (isAnchor ? partyItemTotal + partyFeeTotal - partyDiscount : 0));
    applyEntryStatus(e);
  });
  setTimeout(updateGroupTotal, 0);
}

export function toggleGroupService(sid) {
  saveCurrentGroupTabInputs();   // preserve typed name/phone/costs before the re-render
  const entry = q().find(e => String(e.id) === groupAssignEntries[activeGroupTab]);
  if (!entry) return;
  if (entry.services.includes(sid)) {
    if (entry.services.length === 1) { showToast('At least one service required.'); return; }
    entry.services = entry.services.filter(id => id !== sid);
    if (entry.assignments) entry.assignments = entry.assignments.filter(a => a.serviceId !== sid);
  } else entry.services.push(sid);
  renderGroupAssignContent();
}

// Open the touch numpad in the right mode for the discount field: a "% Off"
// discount is a plain percent (20 → 20%), not a dollar/cents amount.
export function openDiscountNumpad(inputEl) {
  const type = document.querySelector('#group-assign-content .discount-type-select')?.value || 'flat';
  openNumpad(inputEl, type === 'percent' ? '% Off' : 'Discount ($)', type === 'percent' ? 'percent' : 'cost');
}

export function updateGroupTotal() {
  // One-list (B5): EVERY guest's rows are in the DOM — sum per section and update each
  // guest's subtotal line. Tabbed: active tab from DOM, the rest from the store.
  let activeSvc = 0, partySvc = 0;
  if (ASSIGN_ONELIST) {
    const _bd = [];
    document.querySelectorAll('#group-assign-content [data-assign-entry]').forEach(sec => {
      let s = 0; sec.querySelectorAll('.assign-cost').forEach(i => { s += parseFloat(i.value) || 0; });
      partySvc += s;
      const sub = document.getElementById('ga-sub-' + sec.dataset.assignEntry); if (sub) sub.textContent = '$' + s.toFixed(2);
      const e = q().find(x => String(x.id) === sec.dataset.assignEntry);
      _bd.push({ name: ((e?.name || 'Guest').split(' ')[0]) || 'Guest', sub: s });
    });
    activeSvc = partySvc;
    // Per-person service subtotals pinned above Party Total (party only) — visible after scrolling.
    const bdEl = document.getElementById('group-party-breakdown');
    if (bdEl) {
      if (_bd.length > 1) { bdEl.innerHTML = _bd.map(p => `<div class="flex items-center justify-between"><span class="truncate">${escHtml(p.name)}</span><span class="flex-shrink-0 ml-2">$${p.sub.toFixed(2)}</span></div>`).join(''); bdEl.classList.remove('hidden'); }
      else { bdEl.innerHTML = ''; bdEl.classList.add('hidden'); }
    }
  } else {
    activeSvc = [...document.querySelectorAll('#group-assign-content .assign-cost')].reduce((a,i)=>a+(parseFloat(i.value)||0),0);
    partySvc = activeSvc;
    groupAssignEntries.forEach((id,i) => { if (i === activeGroupTab) return; const e = q().find(x => String(x.id) === id); if (e) partySvc += (e.assignments||[]).reduce((s,a)=>s+(a.cost||0),0); });
  }
  const itemTotal = [...document.querySelectorAll('#group-assign-content [data-item-id]')].reduce((sum,row)=>{
    const qty = parseInt(row.querySelector('.item-qty')?.value)||0, price = parseFloat(row.querySelector('.item-price')?.value)||0;
    return sum + price*qty;
  },0);
  // Fees are entered at checkout now (v4.51); the live total still reflects any fee already on the
  // ticket — recompute a percent fee against the current service subtotal.
  let feeTotal = 0;
  const _seenFee = new Set();
  groupAssignEntries.forEach(id => { const e = q().find(x => String(x.id) === id); (e?.fees || []).forEach(f => {
    if (_seenFee.has(f.feeId)) return; _seenFee.add(f.feeId);
    const def = cfg().fees.find(x => x.id === f.feeId);
    feeTotal += (f.type === 'percent' && def) ? Math.round(partySvc * (def.value || 0)) / 100 : (f.amount || 0);
  }); });
  const discountType = document.querySelector('#group-assign-content .discount-type-select')?.value || 'flat';
  const discountInput = parseFloat(document.querySelector('#group-assign-content .discount-input')?.value) || 0;
  const discountAmt = discountType === 'percent' ? Math.round(partySvc * discountInput / 100 * 100) / 100 : discountInput;
  // Gift cards sold on any party member ride the charge (liability, not service income — they post to the Gift Cards ledger on paid).
  let gcSaleTotal = 0; const _seenGc = new Set();
  groupAssignEntries.forEach(id => { if (_seenGc.has(id)) return; _seenGc.add(id); const e = q().find(x => String(x.id) === id); (e?.giftcardSales || []).forEach(g => { gcSaleTotal += (+g.amount || 0); }); });
  const partyTotal = Math.max(0, partySvc + itemTotal + feeTotal - discountAmt) + gcSaleTotal;
  const isParty = groupAssignEntries.length > 1;
  // Solo: the one line shows the full ticket. Party: it shows just THIS guest's services
  // (the whole-ticket items/fees/discount roll into the Party Total in the footer).
  const el = document.getElementById('group-subtotal'); if (el) el.textContent = `$${(isParty ? activeSvc : partyTotal).toFixed(2)}`;
  const pel = document.getElementById('group-party-total'); if (pel) pel.textContent = `$${partyTotal.toFixed(2)}`;
}

// Retail-item quantity stepper (touch-friendly, no keyboard). Min 0 — an item with a price
// but qty 0 is intentionally NOT counted/saved anywhere (the save and total paths both gate on
// qty > 0), so a set price never rings up until the operator steps the quantity above zero.
export function stepItemQty(btn, delta) {
  const inp = btn.closest('[data-item-id]')?.querySelector('.item-qty');
  if (!inp) return;
  inp.value = Math.max(0, (parseInt(inp.value, 10) || 0) + delta);
  updateGroupTotal();
}

export function closeGroupAssignModal() {
  // Commit whatever's typed (incl. an open numpad) and persist before closing, so a
  // fee/cost/discount added as the "last step" isn't dropped by closing without Save.
  if (groupAssignEntries.length && document.getElementById('group-assign-content')?.children.length) {
    saveCurrentGroupTabInputs();
    groupAssignEntries.forEach(id => { const e = q().find(x => String(x.id) === id); if (e) upsert(e); });
  }
  const m = document.getElementById('group-assign-modal'); m.classList.add('hidden'); m.style.display = '';
  groupAssignEntries = []; _custEditedIds.clear(); _assignFieldSnapshot = {};
  _stopAssignIdle();
  if (_lockKey) { _releaseLock(_lockKey); _stopLockHb(); _lockKey = null; }   // free the ticket for the next device (prices already saved above)
}

// Split button inside the Assign & Price modal — splits this party from here (saves + closes
// the modal, then opens the Split Party picker for the active guest's group).
export function splitFromAssignModal() {
  const id = groupAssignEntries[activeGroupTab];
  closeGroupAssignModal();
  if (id) showSplitMergeModal(id);
}

function collectGroupAssignments() { saveCurrentGroupTabInputs(); return groupAssignEntries.map(id => q().find(e => String(e.id) === id)).filter(Boolean); }
function validateGroupAssignments(entries) { return entries.filter(e => !e.assignments || e.assignments.length === 0 || e.assignments.some(a => !a.techId || (a.cost <= 0 && !a.comped))); }

export function saveGroupAssignments(force) {
  if (force !== true) {
    const stale = _staleNames(_assignOpenedAt);
    if (stale.length) { showWarnModal('Changed on another device', `${stale.join(', ')} was updated on another device since you opened this ticket. Saving now overwrites that change. Save anyway?`, () => saveGroupAssignments(true), 'Save anyway'); return; }
  }
  const entries = collectGroupAssignments();
  entries.forEach(e => { applyEntryStatus(e); upsert(e); });
  // Sync customers whose name/phone were edited here. New/unchanged ones sync silently;
  // a name/email that differs from a saved record asks "Update saved info?" first (one
  // combined prompt) so a shared-phone record is never overwritten by accident.
  syncCustomersFromEntries(entries.filter(e => _custEditedIds.has(String(e.id))));
  closeGroupAssignModal();
  renderQueue(); updateStats(); window.renderTurns?.();
  showToast('Assignments saved');
}

// ── Edit Services modal ───────────────────────────
let editServicesEntryId = null;
export function showEditServicesModal(entryId) {
  const entry = q().find(e => String(e.id) === String(entryId));
  if (!entry) return;
  editServicesEntryId = entryId;
  document.getElementById('edit-services-guest-name').textContent = `Guest: ${entry.name}`;
  document.getElementById('edit-services-grid').innerHTML = cfg().services.map(s => {
    const selected = entry.services.includes(s.id);
    return `<button type="button" onclick="this.classList.toggle('selected')" data-service="${s.id}" class="service-btn flex flex-col items-center justify-center py-3 rounded-lg border transition-all duration-200 ${selected ? 'bg-primary text-on-primary border-primary selected' : 'bg-surface-container text-on-surface-variant border-outline-variant/30 hover:bg-primary/10 hover:text-primary'}">
      <span class="text-xs font-headline font-bold">${s.abbr}</span><span class="text-[9px] font-body mt-0.5 uppercase tracking-tighter leading-tight text-center">${s.label}</span></button>`;
  }).join('');
  const m = document.getElementById('edit-services-modal'); m.classList.remove('hidden'); m.style.display = 'flex';
}
export function closeEditServicesModal() {
  const m = document.getElementById('edit-services-modal'); m.classList.add('hidden'); m.style.display = '';
  editServicesEntryId = null;
}
export function saveEditedServices() {
  const entry = q().find(e => String(e.id) === String(editServicesEntryId));
  if (!entry) return;
  const selected = [...document.querySelectorAll('#edit-services-grid .service-btn.selected')].map(b => b.dataset.service);
  if (selected.length === 0) { showToast('Please select at least one service.'); return; }
  entry.services = selected;
  if (entry.assignments) entry.assignments = entry.assignments.filter(a => selected.includes(a.serviceId));
  upsert(entry);
  closeEditServicesModal();
  renderQueue();
  showToast('Services updated');
}

// ── Split / Merge ─────────────────────────────────
export function showSplitMergeModal(entryId) {
  const entry = q().find(e => String(e.id) === String(entryId));
  if (!entry || !entry.groupId) return;
  const groupMembers = q().filter(e => e.groupId === entry.groupId);
  document.getElementById('split-merge-title').textContent = 'Split Party';
  document.getElementById('split-merge-content').innerHTML = `
    <p class="text-sm font-body text-on-surface-variant mb-4">Select guests to split into a separate ticket. They keep their services but are unlinked from the group.</p>
    <div class="space-y-2 mb-5 max-h-64 overflow-y-auto">
      ${groupMembers.map(m => `<label class="flex items-center gap-3 p-3 rounded-xl bg-surface-container cursor-pointer hover:bg-surface-container-high transition-colors">
        <input type="checkbox" id="split-cb-${m.id}" class="w-4 h-4 accent-primary">
        <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${entry.groupColor}"></span>
        <div><div class="font-headline font-semibold text-on-surface text-sm">${m.name}</div>${m.groupLabel ? `<div class="text-[10px] font-body italic text-outline">${m.groupLabel}</div>` : ''}</div></label>`).join('')}
    </div>
    <button onclick="executeSplit()" class="w-full bg-primary hover:bg-primary-dim text-on-primary py-3 rounded-xl font-headline font-bold transition-all active:scale-95">Split Selected</button>`;
  const m = document.getElementById('split-merge-modal'); m.classList.remove('hidden'); m.style.display = 'flex';
}
export function executeSplit() {
  const checked = [...document.querySelectorAll('[id^="split-cb-"]:checked')].map(cb => cb.id.replace('split-cb-', ''));
  if (checked.length === 0) { showToast('Select at least one guest to split.'); return; }
  const groups = new Set();
  checked.forEach(id => { const e = q().find(x => String(x.id) === id); if (e) { if (e.groupId) groups.add(e.groupId); e.groupId = null; e.groupColor = null; e.groupLabel = null; upsert(e); } });
  // A party needs 2+ people — if a split leaves just one member behind, un-group them too.
  groups.forEach(gid => { const left = q().filter(e => e.groupId === gid); if (left.length === 1) { const e = left[0]; e.groupId = null; e.groupColor = null; e.groupLabel = null; upsert(e); } });
  closeSplitMergeModal();
  renderQueue(); window.renderTurns?.(); window.renderFloorPlan?.();
  showToast(`${checked.length} guest${checked.length > 1 ? 's' : ''} split into a separate ticket`);
}

// A single customer left in a "group" isn't a party — un-group them (clears the group dot,
// outline, and "(primary)" label) so it stops looking grouped. Covers EVERY path that can
// strand one member: split, removing/finishing the other guests, etc. — and heals tickets
// already stuck in this state. Deferred so it never mutates the store mid-render.
function healLoneGroups() {
  const counts = {};
  q().forEach(e => { if (e.groupId) counts[e.groupId] = (counts[e.groupId] || 0) + 1; });
  const lone = q().filter(e => e.groupId && counts[e.groupId] === 1);
  if (!lone.length) return;
  setTimeout(() => {
    lone.forEach(e => { const c = q().find(x => String(x.id) === String(e.id)); if (c && c.groupId && q().filter(y => y.groupId === c.groupId).length === 1) { c.groupId = null; c.groupColor = null; c.groupLabel = null; upsert(c); } });
  }, 0);
}
export function closeSplitMergeModal() {
  const m = document.getElementById('split-merge-modal'); m.classList.add('hidden'); m.style.display = '';
}
export function showMergeSelectModal(entryId) {
  const entry = q().find(e => String(e.id) === String(entryId));
  if (!entry) return;
  const candidates = q().filter(e => String(e.id) !== String(entryId) && !isPaidStatus(e.status));
  document.getElementById('split-merge-title').textContent = 'Merge with Guest';
  document.getElementById('split-merge-content').innerHTML = `
    <p class="text-sm font-body text-on-surface-variant mb-4">Select a guest to merge with <strong>${entry.name}</strong>. They become a party with a shared color.</p>
    <div class="space-y-2 mb-5 max-h-64 overflow-y-auto no-scroll">
      ${candidates.length === 0 ? '<p class="text-sm font-body text-on-surface-variant text-center py-4">No other guests in queue.</p>' :
        candidates.map(c => `<label class="flex items-center gap-3 p-3 rounded-xl bg-surface-container cursor-pointer hover:bg-surface-container-high transition-colors">
          <input type="radio" name="merge-pick" value="${c.id}" class="w-4 h-4 accent-primary">
          ${c.groupColor ? `<span class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${c.groupColor}"></span>` : '<span class="w-2.5 h-2.5 rounded-full flex-shrink-0 bg-outline-variant"></span>'}
          <div><div class="font-headline font-semibold text-on-surface text-sm">${c.name}</div><div class="text-[11px] font-body text-on-surface-variant">${c.services.map(sid => svc(sid)?.label||sid).join(', ') || '—'}</div></div></label>`).join('')}
    </div>
    ${candidates.length > 0 ? `<button onclick="executeMerge('${entryId}')" class="w-full bg-primary hover:bg-primary-dim text-on-primary py-3 rounded-xl font-headline font-bold transition-all active:scale-95">Merge</button>` : ''}`;
  const m = document.getElementById('split-merge-modal'); m.classList.remove('hidden'); m.style.display = 'flex';
}
export function executeMerge(entryId) {
  const targetId = document.querySelector('[name="merge-pick"]:checked')?.value;
  if (!targetId) { showToast('Please select a guest to merge with.'); return; }
  const entry = q().find(e => String(e.id) === String(entryId));
  const target = q().find(e => String(e.id) === String(targetId));
  if (!entry || !target) return;
  const groupId = target.groupId || entry.groupId || `grp-${Date.now()}`;
  const groupColor = target.groupColor || entry.groupColor || GROUP_COLORS[groupColorIndex++ % GROUP_COLORS.length];
  const allMembers = q().filter(e => String(e.id) === String(entryId) || String(e.id) === String(targetId) || (e.groupId && (e.groupId === entry.groupId || e.groupId === target.groupId)));
  const primaryName = allMembers[0].name;
  allMembers.forEach((m, i) => { m.groupId = groupId; m.groupColor = groupColor; m.groupLabel = i === 0 ? `${m.name} (primary)` : `${primaryName} — ${m.name}`; upsert(m); });
  closeSplitMergeModal();
  renderQueue();
  showToast(`${entry.name} & ${target.name} merged into a party`);
}

// ── Warn modal + reopen ───────────────────────────
export function showWarnModal(title, body, onConfirm, confirmLabel) {
  document.getElementById('warn-title').textContent = title;
  document.getElementById('warn-body').textContent = body;
  const btn = document.getElementById('warn-confirm-btn');
  btn.textContent = confirmLabel || 'Confirm';
  btn.onclick = () => { closeWarnModal(); onConfirm(); };
  const m = document.getElementById('warn-modal'); m.classList.remove('hidden'); m.style.display = 'flex';
}
export function closeWarnModal() {
  const m = document.getElementById('warn-modal'); m.classList.add('hidden'); m.style.display = '';
}
export function confirmReopen(entryId) {
  const entry = q().find(e => String(e.id) === String(entryId));
  if (!entry) return;
  showWarnModal('Reopen this ticket?', `This will move ${entry.name} back to "In Service."`, () => {
    if (entry.assignments && entry.assignments.length) {
      entry.assignments.forEach(a => { if (isPaidStatus(getAssignmentStatus(entry, a)) || getAssignmentStatus(entry, a) === 'complete') applyAssignmentStatus(a, 'inservice'); });
      applyEntryStatus(entry, true);   // reopen = correction → restore the pre-paid status timer
    } else { if (entry.status !== 'inservice') entry.statusSince = Date.now(); entry.status = 'inservice'; }
    entry.completedAt = null;
    // R6: reopening a paid ticket must restore the gift-card balances it drew down.
    if (entry.giftcardRedemptions && entry.giftcardRedemptions.length) { window.gcReverseTicket?.(String(entry.id)); entry.giftcardRedemptions = []; }
    // Pay-path P0 (v4.55): drop the saved transaction so the sale stops counting until re-paid
    // (reversible — re-paying re-saves it; see voidRecordOnReopen). Do this BEFORE upsert.
    window.voidRecordOnReopen?.(String(entry.id));
    upsert(entry);
    window.logAudit?.('Reopen', `${entry.name || '—'} reopened — sale voided until re-paid`);
    renderQueue(); updateStats(); window.renderTurns?.(); window.renderFloorPlan?.();
    showToast(`${entry.name}'s ticket reopened`);
  });
}
