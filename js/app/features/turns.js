// ── Turns: rotation grid, drag-drop, tech status, turn classification ───────
import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { showToast, todayStr, byName, localDateStr, formatElapsed, partyLetterMap, statusTimeHtml } from '../utils.js';
import { GROUP_COLORS } from '../config.js';
import { canDo } from '../session.js';
import { getAssignmentStatus, isPaidStatus, entryStatusSince, applyAssignmentStatus } from './status.js';
import { renderQueue, updateStats, showGroupAssignModal, switchGroupTab } from './queue.js';
import { serviceTimeInfo } from './servicetime.js';

const cfg = () => getState().config;
const q   = () => getState().queue;
const svc = id => cfg().services.find(s => s.id === id);
const staffById = id => cfg().staff.find(s => s.id === id);
const isStaffActive = id => !cfg().inactive_staff.includes(id);
const activeStaff = () => cfg().staff.filter(s => isStaffActive(s.id));

const setOrder = order => dispatch('config.set', { key: 'turns_order', value: order });
const setBreak = arr   => dispatch('config.set', { key: 'turns_break', value: arr });
const setOff   = arr   => dispatch('config.set', { key: 'turns_off',   value: arr });

let turnsViewingHistory = null;
let turnsHistory = JSON.parse(localStorage.getItem('turndesk_turns_history') || '{}');
function saveTurnsHistory() { localStorage.setItem('turndesk_turns_history', JSON.stringify(turnsHistory)); }

// ── Turn config + classification (formerly in app.js) ─────────────────────────
export function getTurnConfig() {
  const defaults = { fullMin: 28, halfMin: 12 };
  const tc = cfg().turn_config || {};
  return Object.keys(tc).length ? { ...defaults, ...tc } : defaults;
}
export function saveTurnConfig(c) { dispatch('config.set', { key: 'turn_config', value: c }); }
export function isAlwaysBonusService(serviceId) { return cfg().bonus_services.includes(serviceId); }
export function saveBonusServices(ids) { dispatch('config.set', { key: 'bonus_services', value: ids }); }

export function classifyTurn(cost, serviceId) {
  if (isAlwaysBonusService(serviceId)) return 'bonus';
  const c = getTurnConfig();
  if (!cost || cost <= 0) return 'unpriced';
  if (cost >= c.fullMin) return 'full';
  if (cost >= c.halfMin) return 'half';
  return 'bonus';
}

// The rotation, excluding any ids that are blank or belong to deactivated staff
// (a tech deactivated after being added to the rotation must not linger on the
// grid / in suggestions). turns_order self-heals on the next roster edit.
export function getActiveTurnsOrder() { return cfg().turns_order.filter(id => id && typeof id === 'string' && isStaffActive(id)); }

export function getActiveTechEntries(staffId) {
  return q().filter(e => e.status === 'inservice' && (e.assignments||[]).some(a => a.techId === staffId && getAssignmentStatus(e, a) === 'inservice'));
}

export function getTechAllAssignments(techId) {
  const today = new Date(); today.setHours(0,0,0,0);
  const result = [];
  q().forEach(e => {
    const d = new Date(e.checkinTime);
    if (d < today) return;
    (e.assignments||[]).forEach(a => { if (a.techId === techId) result.push({ entry: e, assignment: a }); });
  });
  result.sort((a, b) => {
    const ta = a.assignment.assignedAt || new Date(a.entry.checkinTime).getTime();
    const tb = b.assignment.assignedAt || new Date(b.entry.checkinTime).getTime();
    return ta - tb;
  });
  return result;
}

// Manual "skip a turn": records a phantom full turn for a tech (no customer) so the
// rotation advances past them. Stored per-day in config.turns_skips, counted like a full
// turn, and shown as a removable greyed slot in the grid.
export const todaySkips = techId => (cfg().turns_skips || []).filter(s => s.techId === techId && localDateStr(new Date(s.at)) === todayStr());
export function skipTurnForTech(techId) {
  if (!techId) return;
  const kept = (cfg().turns_skips || []).filter(s => localDateStr(new Date(s.at)) === todayStr());   // prune older days
  dispatch('config.set', { key: 'turns_skips', value: [...kept, { id: 'skip-' + Date.now(), techId, at: new Date().toISOString() }] });
  renderTurns(); showToast('Turn skipped');
}
export function skipTurnFromModal() { const id = turnsAssignTarget?.techId; closeTurnsAssignModal(); skipTurnForTech(id); }
export function removeTurnSkip(skipId) {
  dispatch('config.set', { key: 'turns_skips', value: (cfg().turns_skips || []).filter(s => s.id !== skipId) });
  renderTurns();
}

export function getTechTurns(techId) {
  let full = 0, half = 0, bonus = 0;
  getTechAllAssignments(techId).forEach(({ assignment: a }) => {
    const t = classifyTurn(a.cost || 0, a.serviceId || '');
    if (t === 'full') full++; else if (t === 'half') half += 0.5; else if (t === 'bonus') bonus++;
  });
  full += todaySkips(techId).length;   // each manual skip counts as a full turn
  return { full, half, bonus, total: full + half };
}

export function getTechStatusColor(staffId) {
  if (cfg().turns_off.includes(staffId))   return { bg: '#f3f4f6', text: '#9ca3af', label: 'Off' };
  if (cfg().turns_break.includes(staffId)) return { bg: '#f5c870', text: '#3a2800', label: 'On Break' };
  if (getActiveTechEntries(staffId).length > 0) return { bg: '#fa746f', text: '#fff', label: 'In Service' };
  return { bg: '#2a7a4f', text: '#fff', label: 'Available' };
}

// ── Suggestion engine ─────────────────────────────
export function suggestTechForService(serviceId) {
  const order = getActiveTurnsOrder();
  if (order.length === 0) return null;
  const eligible = order.filter(id => {
    const st = staffById(id);
    if (!st) return false;
    if (cfg().turns_break.includes(id) || cfg().turns_off.includes(id)) return false;
    if (st.services && st.services.length > 0 && !st.services.includes(serviceId)) return false;
    return getActiveTechEntries(id).length === 0;
  });
  if (eligible.length === 0) return null;
  let best = null, bestTurns = Infinity, bestIdx = Infinity;
  eligible.forEach(id => {
    const turns = getTechTurns(id).total, idx = order.indexOf(id);
    if (turns < bestTurns || (turns === bestTurns && idx < bestIdx)) { best = id; bestTurns = turns; bestIdx = idx; }
  });
  if (!best) return null;
  return { techId: best, techName: staffById(best)?.name || '?' };
}
function buildSuggestions() {
  const suggestions = {};
  q().filter(e => !isPaidStatus(e.status)).forEach(e => {
    suggestions[e.id] = {};
    e.services.forEach(sid => {
      const a = (e.assignments || []).find(x => x.serviceId === sid);
      const st = a ? getAssignmentStatus(e, a) : 'waiting';
      if (st !== 'waiting' || (a && a.techId)) return;
      const s = suggestTechForService(sid);
      if (s) suggestions[e.id][sid] = s;
    });
  });
  return suggestions;
}

// Accept a suggested tech for ONE service: assign it (status stays waiting) and
// open the assign/price modal so the front desk can price it, then advance to
// In Service or just save while still waiting.
export function acceptSuggestion(entryId, serviceId) {
  const entry = q().find(e => String(e.id) === String(entryId));
  if (!entry) return;
  const sug = suggestTechForService(serviceId);
  if (!sug) { showToast('No available technician to suggest right now.'); return; }
  if (!entry.assignments) entry.assignments = [];
  let a = entry.assignments.find(x => x.serviceId === serviceId);
  if (!a) { a = { serviceId, status: 'waiting' }; entry.assignments.push(a); }
  a.techId = sug.techId;
  applyAssignmentStatus(a, 'waiting');
  if (!a.assignedAt) a.assignedAt = Date.now();
  dispatch('queue.upsert', { entry });
  showGroupAssignModal(String(entryId));
}
function acceptBtnHtml(entryId, serviceId, techName) {
  // onpointerdown stop: otherwise the card's drag engine arms pendingEntry on this tap,
  // then hijacks the first scroll gesture inside the modal we open (freezes scrolling).
  return ` <button onpointerdown="event.stopPropagation()" onclick="event.stopPropagation();acceptSuggestion('${entryId}','${serviceId}')" title="Assign ${techName}" style="pointer-events:auto;cursor:pointer;color:#1a5252;vertical-align:middle" class="hover:opacity-70"><span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle;font-variation-settings:'FILL' 1">check_circle</span></button>`;
}

// ── Render ────────────────────────────────────────
export function renderTurns() { renderTurnsTechGrid(); renderTurnsQueue(); applyTurnsApptStripVisibility(); startTurnsApptRefresh(); }

// ── Upcoming appointments (Google Calendar) on the Turns sheet ────────────────
// Strip = the "Next up" row (toggled by the Appointments button, device-local).
// In-grid note = an always-on amber card in a tech's next-turn slot when their next
// upcoming appt is ≤30 min away. Data comes from window.apptsForTurns() (calendar.js),
// which already filters to upcoming-only (not passed / no-show / checked-in).
let _turnsApptTimer = null;
let _turnsApptShow = localStorage.getItem('turndesk_turns_appts_show') === '1';
const _tEsc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function turnsUpcomingAppts() { try { return window.apptsForTurns?.() || []; } catch { return []; } }

export function toggleTurnsApptStrip() {
  _turnsApptShow = !_turnsApptShow;
  localStorage.setItem('turndesk_turns_appts_show', _turnsApptShow ? '1' : '0');
  applyTurnsApptStripVisibility();
}
function applyTurnsApptStripVisibility() {
  const strip = document.getElementById('turns-appts-strip'), btn = document.getElementById('turns-appts-toggle');
  const panel = document.getElementById('panel-turns');
  const hide = !_turnsApptShow || !!turnsViewingHistory;
  if (strip) strip.classList.toggle('hidden', hide);
  if (btn) {
    btn.classList.toggle('bg-primary', _turnsApptShow);
    btn.classList.toggle('text-on-primary', _turnsApptShow);
    btn.classList.toggle('border-primary', _turnsApptShow);
    btn.classList.toggle('text-on-surface-variant', !_turnsApptShow);
    btn.classList.toggle('border-surface-container-high', !_turnsApptShow);
  }
  if (!hide) renderTurnsApptStrip();
  // Keep the strip anchored under the header (no page scroll) by shrinking the
  // grid + side-panel scroll height to absorb the strip's height; only the grid
  // scrolls. 210px is the header budget; +12 is the strip's bottom margin (mb-3).
  if (panel) { const extra = (!hide && strip) ? strip.offsetHeight + 12 : 0; panel.style.setProperty('--turns-offset', (210 + extra) + 'px'); }
}
export function renderTurnsApptStrip() {
  const host = document.getElementById('turns-appts-cards'); if (!host) return;
  const sub = document.getElementById('turns-appts-sub');
  // Collapse the per-tech entries back to one card per booking for the strip.
  const seen = new Map();
  turnsUpcomingAppts().forEach(a => { const k = a.startMs + '|' + a.name; if (!seen.has(k)) seen.set(k, { startMs: a.startMs, name: a.name, svc: a.svc, techs: new Set() }); if (a.techName) seen.get(k).techs.add(a.techName); });
  const cards = [...seen.values()];
  if (sub) sub.textContent = cards.length ? `· ${cards.length} upcoming` : '· nothing upcoming';
  if (!cards.length) { host.innerHTML = `<div class="text-xs text-on-surface-variant py-3 px-1 opacity-70">No upcoming appointments today.</div>`; return; }
  const now = Date.now();
  // Compact bubble matching a turn-grid slot: w-[150px], rounded-xl, soft fill
  // (lavender = appointment, amber = ≤30 min). Two lines so the strip stays short.
  host.innerHTML = cards.map(a => {
    const time = new Date(a.startMs).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
    const mins = Math.round((a.startMs - now)/60000), soon = mins <= 30;
    const techLbl = [...a.techs].join(', ') || 'Unassigned';
    const bg = soon ? '#ffe0b2' : '#ede7f6', fg = soon ? '#6d3200' : '#42306b';
    return `<div class="flex-shrink-0 w-[150px] px-0.5"><div class="w-full rounded-xl px-2 py-1 text-left text-xs font-body" style="background:${bg};color:${fg}">
      <div class="flex items-center gap-1"><span class="font-bold text-[11px] flex-shrink-0">${time}</span><span class="font-semibold text-[11px] truncate" style="flex:1;min-width:0">${_tEsc(a.name)}</span>${soon?`<span class="text-[9px] font-bold flex-shrink-0" style="color:#9a4a00">${mins}m</span>`:''}</div>
      <div class="text-[10px] leading-tight truncate" style="opacity:.8">${_tEsc(a.svc)} · ${_tEsc(techLbl)}</div>
    </div></div>`;
  }).join('');
}
function turnsDueNoteCard(a, mins) {
  const time = new Date(a.startMs).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
  return `<div class="flex-shrink-0 w-[150px] px-1"><div class="w-full rounded-xl px-2 py-1.5 text-left text-xs font-body" style="background:#fff7e6;border:2px solid #f5a623;min-height:66px">
    <div class="flex items-center justify-between gap-0.5" style="margin-bottom:2px"><div class="flex items-center gap-1 min-w-0"><span class="material-symbols-outlined" style="font-size:13px;color:#c77700">notifications_active</span><span class="text-[9px] font-bold uppercase tracking-wide" style="color:#c77700">Next appt</span></div><span class="font-bold text-[11px]" style="color:#8a5a00">in ${mins}m</span></div>
    <div class="font-semibold text-[11px] truncate" style="color:#5a3a00">${_tEsc(time)} · ${_tEsc(a.name)}</div>
    <div class="text-[10px] leading-tight truncate" style="color:#7a5a10">${_tEsc(a.svc)}</div>
  </div></div>`;
}
function startTurnsApptRefresh() {
  if (_turnsApptTimer) return;
  _turnsApptTimer = setInterval(() => {
    const p = document.getElementById('panel-turns');
    if (!p || !p.classList.contains('active')) return;
    if (_turnsApptShow && !turnsViewingHistory) renderTurnsApptStrip();
    renderTurnsTechGrid();   // refresh the 30-min in-grid notes + countdowns
  }, 60000);
}

export function renderTurnsTechGrid() {
  const grid = document.getElementById('turns-tech-grid');
  if (!grid) return;
  if (turnsViewingHistory) { renderTurnsHistoryView(); return; }

  const todayLabel = document.getElementById('turns-date-label');
  if (todayLabel) todayLabel.textContent = new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
  const bc = document.getElementById('turns-break-count'); if (bc) bc.textContent = cfg().turns_break.length;

  const order = getActiveTurnsOrder();
  const partyLetters = partyLetterMap(q());   // same party letter as the queue/side cards
  // A single customer can show up as several cards in the grid — multiple services, whether
  // with the SAME tech or split across techs. Tag every one of that customer's slots with a
  // matching colored link chip so the front desk sees at a glance it's the same person.
  const splitTags = new Map();   // entryId -> color
  let _splitN = 0;
  q().forEach(e => {
    const assigned = (e.assignments || []).filter(a => a.techId).length;
    if (assigned >= 2) { splitTags.set(String(e.id), GROUP_COLORS[_splitN % GROUP_COLORS.length]); _splitN++; }
  });
  let activeCount = 0;
  if (order.length === 0) {
    grid.innerHTML = '<div class="text-sm font-body text-on-surface-variant py-8 text-center opacity-60"><span class="material-symbols-outlined text-4xl block mb-2">swap_vert</span>No technicians added today.<br>Click <strong>Technicians</strong> to set up the turn order.</div>';
    const el = document.getElementById('turns-active-count'); if (el) el.textContent = '0';
    return;
  }
  // Next upcoming appt per tech (for the 30-min in-grid note). Empty if Google
  // Calendar isn't connected/synced on this device.
  const _nowMs = Date.now(), _upcoming = turnsUpcomingAppts();
  const nextApptFor = id => _upcoming.filter(a => a.techStaffId === id).sort((a,b) => a.startMs - b.startMs)[0] || null;

  const rows = order.map(staffId => {
    const st = staffById(staffId);
    if (!st) return '';
    const turns = getTechTurns(staffId);
    const allAssign = getTechAllAssignments(staffId);
    // Billed today = this tech's assignment costs for work performed (Complete OR
    // Paid) — the tech earns the turn when the work is done, regardless of payment.
    const billed = allAssign.reduce((sum, it) => { const ast = getAssignmentStatus(it.entry, it.assignment); return sum + ((ast === 'complete' || isPaidStatus(ast)) ? (it.assignment.cost || 0) : 0); }, 0);
    if (allAssign.some(a => getAssignmentStatus(a.entry, a.assignment) === 'inservice')) activeCount++;
    const sc = getTechStatusColor(staffId);
    const photo = st.photo
      ? `<img src="${st.photo}" class="w-10 h-10 rounded-full object-cover border-2 flex-shrink-0" style="border-color:${sc.bg}">`
      : `<div class="w-10 h-10 rounded-full flex items-center justify-center border-2 flex-shrink-0 text-sm font-headline font-bold" style="background:${sc.bg}20;border-color:${sc.bg};color:${sc.bg}">${st.name.charAt(0).toUpperCase()}</div>`;
    const isHalf = !Number.isInteger(turns.total) && turns.total > 0;
    const turnDisplay = turns.total > 0
      ? `<span class="text-sm font-headline font-bold ${isHalf ? 'px-1.5 py-0.5 rounded-md' : ''}" style="${isHalf ? 'background:#f5c870;color:#3a2800' : 'color:' + sc.bg}">${turns.total}t</span>`
      : `<span class="text-sm font-headline text-outline-variant">0t</span>`;
    const techCol = `<div class="flex items-center gap-2 w-[155px] flex-shrink-0 pr-2">
      <button onclick="showTechStatusMenu(event,'${staffId}')" class="focus:outline-none flex-shrink-0">${photo}</button>
      <div class="min-w-0"><div class="font-headline font-semibold text-on-surface text-sm truncate leading-tight">${st.name}</div>
      <div class="flex items-center gap-1.5 mt-0.5"><span class="text-[10px] px-1.5 py-0.5 rounded-full font-semibold leading-none" style="background:${sc.bg};color:${sc.text}">${sc.label}</span>${turnDisplay}${turns.bonus > 0 ? `<span class="text-[10px] text-secondary">+${turns.bonus}b</span>` : ''}</div>
      <div class="text-[10px] font-body font-semibold mt-0.5" style="color:#1a5252">$${billed.toFixed(0)} billed</div></div></div>`;

    const MIN_SLOTS = 5;
    // Merge real assignments with any manual "skipped turns" for this tech, ordered by time.
    const filled = [
      ...allAssign.map(it => ({ kind: 'a', ...it, _t: it.assignment.assignedAt || new Date(it.entry.checkinTime).getTime() })),
      ...todaySkips(staffId).map(sk => ({ kind: 'skip', skip: sk, _t: new Date(sk.at).getTime() })),
    ].sort((x, y) => x._t - y._t);
    const totalSlots = Math.max(MIN_SLOTS, filled.length + 1);
    let turnCounter = 0;
    const slotArr = Array.from({ length: totalSlots }, (_, slotIdx) => {
      const item = filled[slotIdx];
      if (item && item.kind === 'skip') {
        turnCounter += 1;
        const ts = new Date(item.skip.at).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
        const tl = Number.isInteger(turnCounter) ? turnCounter : turnCounter.toFixed(1);
        return `<div class="flex-shrink-0 w-[150px] px-1"><div class="w-full rounded-xl px-2 py-1.5 text-left text-xs font-body relative" style="background:#e6e6e6;color:#777;min-height:66px;border:1px dashed #b5b5b5">
          <button onclick="event.stopPropagation();removeTurnSkip('${item.skip.id}')" title="Remove skipped turn" style="position:absolute;top:2px;right:3px;color:#999;line-height:1" class="hover:opacity-70"><span class="material-symbols-outlined" style="font-size:15px">close</span></button>
          <div class="flex items-center gap-1 pr-4"><span class="material-symbols-outlined" style="font-size:14px">skip_next</span><span class="font-semibold text-[11px]">Skipped</span><span class="text-[11px] font-headline font-bold ml-auto" style="opacity:.75">${tl}</span></div>
          <div class="text-[10px] opacity-90 leading-tight mt-1">Turn passed · no customer</div>
          <div class="text-[9px] opacity-60 mt-1">${ts}</div>
        </div></div>`;
      }
      if (item) {
        const { entry: e, assignment: a } = item;
        const cost = a.cost || 0;
        const tt = classifyTurn(cost, a.serviceId || '');
        if (tt === 'full') turnCounter += 1; else if (tt === 'half') turnCounter += 0.5;
        const turnLabelNum = Number.isInteger(turnCounter) ? turnCounter : turnCounter.toFixed(1);
        const turnLabel = tt === 'bonus' ? 'Bonus' : (cost === 0 ? '?' : '' + turnLabelNum);
        const ss = getAssignmentStatus(e, a);
        let bg, fg;
        if (isPaidStatus(ss)) { bg='#dde2e5'; fg='#555'; } else if (ss === 'complete') { bg='#cfe3ef'; fg='#0a3a52'; } else if (ss === 'inservice') { bg='#c8e6c5'; fg='#1b5e20'; } else { bg='#ffe0b2'; fg='#6d3200'; }
        const outline = e.groupId ? `;outline:2px solid ${e.groupColor||'#e8a230'};outline-offset:-1px` : '';
        const s = svc(a.serviceId);
        const svcLabel = s ? s.label : (e.services.map(sid => svc(sid)?.label || '?').join(', '));
        const costStr = a.cost ? '$' + Number(a.cost).toFixed(0) : '';
        const timeStr = new Date(e.checkinTime).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
        const groupDot = e.groupId ? `<span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:4px;background:${e.groupColor||'#888'};color:#fff;font-size:8px;font-weight:800;flex-shrink:0;margin-right:2px">${partyLetters.get(e.groupId)||'•'}</span>` : '';
        const splitColor = splitTags.get(String(e.id));
        const splitTag = splitColor ? `<span title="Same customer — multiple services" style="display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:5px;background:${splitColor};color:#fff;flex-shrink:0;margin-right:2px"><span class="material-symbols-outlined" style="font-size:11px;font-variation-settings:'FILL' 1">link</span></span>` : '';
        return `<div class="flex-shrink-0 w-[150px] px-1 turns-filled-slot" data-entry-id="${e.id}" data-tech-id="${staffId}" data-slot="${slotIdx}">
          <button onclick="showGroupAssignModal('${e.id}')" class="w-full rounded-xl px-2 py-1.5 text-left active:scale-95 transition-all text-xs font-body" style="background:${bg};color:${fg};min-height:66px${outline}">
            <div class="flex items-center justify-between gap-0.5 mb-0.5"><div class="flex items-center gap-0.5 min-w-0">${groupDot}${splitTag}<span class="font-semibold text-[11px] truncate">${e.name}</span></div>${turnLabel ? `<span class="text-[11px] font-headline font-bold flex-shrink-0 ml-1" style="opacity:0.75">${turnLabel}</span>` : ''}</div>
            <div class="text-[10px] opacity-90 leading-tight">${svcLabel}${a.station ? ' · ' + a.station : ''}${costStr ? ' · ' + costStr : ''}</div>
            ${(() => { const sti = serviceTimeInfo(a); return sti ? `<div class="text-[10px] font-bold leading-tight" style="color:${sti.color}">${sti.text}</div>` : ''; })()}
            <div class="text-[9px] opacity-60">${timeStr} · ${statusTimeHtml(entryStatusSince(e), isPaidStatus(ss))}</div>
          </button></div>`;
      }
      return `<div class="flex-shrink-0 w-[150px] px-1 turns-drop-zone" data-tech-id="${staffId}" data-slot="${slotIdx}">
        <div class="turns-empty-slot w-full rounded-xl border-2 border-dashed border-outline-variant/40 flex items-center justify-center text-outline-variant cursor-pointer hover:border-primary hover:bg-primary/5 hover:text-primary transition-all" style="min-height:66px" onclick="openTurnsAssign('${staffId}',${slotIdx})"><span class="material-symbols-outlined" style="font-size:20px">add</span></div></div>`;
    });
    // 30-min note: drop an amber "next appt" card into this tech's next-turn position
    // (right after their filled slots) when their soonest upcoming appt is ≤30 min out.
    const nextAppt = nextApptFor(staffId);
    if (nextAppt) { const mins = Math.round((nextAppt.startMs - _nowMs) / 60000); if (mins >= 0 && mins <= 30) slotArr.splice(filled.length, 0, turnsDueNoteCard(nextAppt, mins)); }
    const slotHtml = slotArr.join('');

    return `<div class="flex items-center border-b border-surface-container-high py-2 gap-2">${techCol}
      <div class="turns-slot-row flex gap-1.5 overflow-x-auto pb-0.5" style="min-width:0;flex:1;scrollbar-width:thin">${slotHtml}</div></div>`;
  }).filter(Boolean).join('');

  grid.innerHTML = rows || '<div class="text-sm text-on-surface-variant py-4 text-center">No active technicians.</div>';
  const el = document.getElementById('turns-active-count'); if (el) el.textContent = activeCount;
  grid.querySelectorAll('.turns-slot-row').forEach(row => {
    row.addEventListener('wheel', e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && row.scrollWidth > row.clientWidth) { row.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
  });
  // Rebuilding innerHTML snaps every row's horizontal scroll back to the first turn.
  // Keep the NEXT open slot (first "+") in view — don't jump to the far end. If the row
  // fits without overflow, don't scroll at all. rAF lets layout settle first (iPad).
  requestAnimationFrame(() => grid.querySelectorAll('.turns-slot-row').forEach(row => {
    if (row.scrollWidth <= row.clientWidth + 1) return;            // fits — no scroll
    const next = row.querySelector('.turns-drop-zone');            // first empty slot
    if (!next) { row.scrollLeft = row.scrollWidth; return; }       // all full — show the end
    const delta = (next.getBoundingClientRect().right - row.getBoundingClientRect().left) - row.clientWidth + 12;
    if (delta > 0) row.scrollLeft += delta;                        // reveal just the next box
  }));
}

export function renderTurnsQueue() {
  const waitingList = document.getElementById('turns-waiting-list');
  const activeList  = document.getElementById('turns-active-list');
  if (!waitingList || !activeList) return;
  const waiting = q().filter(e => { if (isPaidStatus(e.status)) return false; if (!e.assignments || e.assignments.length === 0) return e.status === 'waiting'; return e.assignments.some(a => getAssignmentStatus(e, a) === 'waiting'); });
  const inservice = q().filter(e => { if (!e.assignments || e.assignments.length === 0) return e.status === 'inservice'; return e.assignments.some(a => getAssignmentStatus(e, a) === 'inservice'); });
  const complete = q().filter(e => e.status === 'complete');   // service done, payment pending
  const wLabel = document.getElementById('turns-waiting-label'); if (wLabel) wLabel.textContent = waiting.length + ' in queue';
  const aLabel = document.getElementById('turns-active-label'); if (aLabel) aLabel.textContent = (complete.length ? complete.length + ' complete · ' : '') + inservice.length + ' in service';
  const suggestions = buildSuggestions();
  const partyLetters = partyLetterMap(q());   // same party → same letter as the queue

  function buildCard(e) {
    const timeStr = new Date(e.checkinTime).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    const groupDot = e.groupId ? `<span style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:5px;background:${e.groupColor||'#888'};color:#fff;font-size:9px;font-weight:800;flex-shrink:0">${partyLetters.get(e.groupId) || '•'}</span>` : '';
    const groupLbl = e.groupLabel ? `<span class="text-[10px] font-body italic ml-0.5" style="color:${e.groupColor||'#888'}">${e.groupLabel}</span>` : '';
    const avatar = e.groupId
      ? `<div class="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-headline font-bold" style="background:${e.groupColor}20;color:${e.groupColor};border:2px solid ${e.groupColor}">${e.name.charAt(0).toUpperCase()}</div>`
      : `<div class="w-8 h-8 rounded-full bg-primary-container flex items-center justify-center flex-shrink-0"><span class="text-xs font-headline font-bold text-primary">${e.name.charAt(0).toUpperCase()}</span></div>`;
    const assignments = (e.assignments||[]).filter(a => a.techId || a.serviceId);
    const es = suggestions[e.id] || {};
    let serviceContent;
    if (assignments.length > 0) {
      serviceContent = assignments.map(a => {
        const tech = staffById(a.techId), s = svc(a.serviceId), ss = getAssignmentStatus(e, a);
        const dot = isPaidStatus(ss)?'✓ ':ss==='complete'?'◍ ':ss==='inservice'?'● ':'○ ';
        const parts = [dot + (s ? s.label : '')];
        let accept = '';
        if (tech) parts.push('→ ' + tech.name); else if (es[a.serviceId]) { parts.push('→ ' + es[a.serviceId].techName + '?'); accept = acceptBtnHtml(e.id, a.serviceId, es[a.serviceId].techName); }
        if (a.cost) parts.push('$' + a.cost);
        return `<div class="text-[10px] text-on-surface-variant leading-tight">${parts.join(' ')}${accept}</div>`;
      }).join('');
    } else {
      serviceContent = e.services.map(sid => { const s = svc(sid), sug = es[sid]; return `<div class="text-[10px] text-on-surface-variant leading-tight">○ ${s?s.label:sid}${sug?` <span class="font-semibold" style="color:#1a5252">→ ${sug.techName}?</span>${acceptBtnHtml(e.id, sid, sug.techName)}`:''}</div>`; }).join('');
    }
    const borderColor = e.status==='inservice' ? '#2a7a4f' : e.status==='complete' ? '#1a5c7a' : '#d4860a';
    const bgTint = e.status==='inservice' ? 'rgba(200,230,197,0.25)' : e.status==='complete' ? 'rgba(207,227,239,0.45)' : 'rgba(255,224,178,0.25)';
    return `<div class="px-3 py-2 cursor-grab hover:brightness-95 transition-all select-none border-b border-surface-container-high border-l-4" style="border-left-color:${borderColor};background:${bgTint}" data-entry-id="${e.id}" onclick="showGroupAssignModal('${e.id}')">
      <div class="flex items-start gap-2 pointer-events-none">${avatar}
        <div class="min-w-0 flex-grow"><div class="flex items-center gap-1 flex-wrap leading-tight">${groupDot}<span class="font-headline font-semibold text-on-surface text-sm">${e.name}</span>${groupLbl}<span class="text-[10px] font-body text-on-surface-variant ml-1">${timeStr} · <span data-checkin-ts="${entryStatusSince(e)}">${formatElapsed(entryStatusSince(e))}</span></span></div>${serviceContent}</div></div></div>`;
  }
  waitingList.innerHTML = waiting.length === 0 ? '<div class="px-4 py-3 text-xs text-on-surface-variant text-center">No one waiting</div>' : waiting.map(buildCard).join('');
  const activeCards = [...complete, ...inservice];   // completed (awaiting payment) at the top, then in-service
  activeList.innerHTML = activeCards.length === 0 ? '<div class="px-4 py-3 text-xs text-on-surface-variant text-center">No one active</div>' : activeCards.map(buildCard).join('');
}

function reorderTurnSlots(techId, moveEntryId, beforeEntryId) {
  const allAssign = getTechAllAssignments(techId);
  const moveItem = allAssign.find(a => String(a.entry.id) === String(moveEntryId));
  const beforeItem = allAssign.find(a => String(a.entry.id) === String(beforeEntryId));
  if (!moveItem || !beforeItem) return;
  const reordered = allAssign.filter(a => String(a.entry.id) !== String(moveEntryId));
  const idx = reordered.findIndex(a => String(a.entry.id) === String(beforeEntryId));
  reordered.splice(idx, 0, moveItem);
  const base = Date.now();
  const touched = new Set();
  reordered.forEach((item, i) => { item.assignment.assignedAt = base + i; touched.add(item.entry); });
  touched.forEach(entry => dispatch('queue.upsert', { entry }));
  renderTurns();
  showToast('Turn order updated ✓');
}

// ── Assign-to-slot modal ──────────────────────────
let turnsAssignTarget = null;
export function openTurnsAssign(techId, slotIndex) {
  turnsAssignTarget = { techId, slotIndex };
  const tech = staffById(techId);
  document.getElementById('turns-assign-label').textContent = `Assign to ${tech?.name || ''}`;
  const options = [];
  q().forEach(e => {
    if (isPaidStatus(e.status)) return;
    e.services.forEach(sid => {
      const a = (e.assignments || []).find(x => x.serviceId === sid);
      const ss = a ? getAssignmentStatus(e, a) : 'waiting';
      if (ss !== 'waiting' || (a && a.techId === techId)) return;
      options.push({ entry: e, serviceId: sid, svcLabel: svc(sid)?.label || sid });
    });
  });
  const list = document.getElementById('turns-assign-list');
  if (options.length === 0) list.innerHTML = '<div class="text-sm font-body text-on-surface-variant text-center py-4">No waiting services to assign</div>';
  else {
    const byCustomer = {};
    options.forEach(o => { const k = String(o.entry.id); if (!byCustomer[k]) byCustomer[k] = { entry: o.entry, svcs: [] }; byCustomer[k].svcs.push(o); });
    list.innerHTML = Object.values(byCustomer).map(({ entry: e, svcs }) => {
      const timeStr = new Date(e.checkinTime).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
      const svcButtons = svcs.map(({ serviceId, svcLabel }) => `<button onclick="assignServiceFromTurns('${e.id}','${serviceId}')" class="w-full flex items-center gap-3 px-4 py-2 hover:bg-surface-container transition-colors text-left border-t border-surface-container-high"><div class="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0"></div><span class="text-sm font-body font-semibold text-on-surface">${svcLabel}</span></button>`).join('');
      return `<div class="border border-surface-container-high rounded-xl mb-2 overflow-hidden"><div class="px-4 py-2 bg-surface-container flex items-center justify-between"><span class="font-headline font-semibold text-on-surface text-sm">${e.name}</span><span class="text-[11px] font-body text-on-surface-variant">${timeStr}</span></div>${svcButtons}</div>`;
    }).join('');
  }
  const m = document.getElementById('turns-assign-modal'); m.classList.remove('hidden'); m.style.display = 'flex';
}
export function assignServiceFromTurns(entryId, serviceId) {
  const techId = turnsAssignTarget?.techId;
  closeTurnsAssignModal();
  showGroupAssignModal(entryId);
  setTimeout(() => {
    const rows = document.querySelectorAll('#group-assign-content [data-service-id]');
    rows.forEach(row => {
      if (row.dataset.serviceId === serviceId) {
        const techSelect = row.querySelector('.assign-tech');
        if (techSelect && techId) techSelect.value = techId;
        row.style.outline = '2px solid #1a5252';
        row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        setTimeout(() => { row.style.outline = ''; }, 1500);
        window.updateGroupTotal?.();
      }
    });
  }, 250);
}
export function closeTurnsAssignModal() {
  const m = document.getElementById('turns-assign-modal'); m.classList.add('hidden'); m.style.display = '';
}

// ── Tech status menu ──────────────────────────────
let _techStatusMenuId = null;
export function showTechStatusMenu(event, staffId) {
  event.stopPropagation();
  const menu = document.getElementById('tech-status-menu');
  if (_techStatusMenuId === staffId && menu && !menu.classList.contains('hidden')) { closeTechStatusMenu(); return; }
  _techStatusMenuId = staffId;
  const st = staffById(staffId);
  if (!menu || !st) return;
  document.getElementById('tech-status-menu-name').textContent = st.name;
  const photoEl = document.getElementById('tech-status-menu-photo');
  if (photoEl) {
    const sc = getTechStatusColor(staffId);
    photoEl.innerHTML = st.photo
      ? `<img src="${st.photo}" style="width:128px;height:128px;border-radius:50%;object-fit:cover;border:6px solid ${sc.bg}">`
      : `<div style="width:128px;height:128px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:${sc.bg}20;border:6px solid ${sc.bg};color:${sc.bg};font-family:var(--font-headline);font-weight:700;font-size:52px">${(st.name||'?').charAt(0).toUpperCase()}</div>`;
  }
  const isBreak = cfg().turns_break.includes(staffId);
  document.getElementById('tsm-available').style.opacity = isBreak ? '0.4' : '1';
  document.getElementById('tsm-break').style.opacity = isBreak ? '1' : '0.4';
  const profileSvcs = (st.services && st.services.length > 0) ? st.services.map(sid => svc(sid)?.label).filter(Boolean) : cfg().services.map(s => s.label);
  document.getElementById('tech-status-menu-services').innerHTML = profileSvcs.length > 0 ? profileSvcs.map(l => `<div>${l}</div>`).join('') : '<div class="italic text-outline">No services configured</div>';
  const rect = event.currentTarget.getBoundingClientRect();
  menu.style.left = Math.min(rect.left, window.innerWidth - 290) + 'px';
  menu.classList.remove('hidden');
  // Content-aware: flip above the tech if it would overflow the bottom of the viewport.
  const menuH = menu.offsetHeight;
  const openAbove = (window.innerHeight - rect.bottom) < (menuH + 16) && rect.top > (menuH + 16);
  menu.style.top = (openAbove ? rect.top - menuH - 8 : rect.bottom + 8) + 'px';
  setTimeout(() => document.addEventListener('click', closeTechStatusMenu, { once: true }), 10);
}
export function closeTechStatusMenu() { document.getElementById('tech-status-menu')?.classList.add('hidden'); _techStatusMenuId = null; }
export function setTechBreak(isBreak) {
  if (!_techStatusMenuId) return;
  const id = _techStatusMenuId;
  let brk = cfg().turns_break.filter(x => x !== id);
  if (isBreak) brk.push(id);
  setBreak(brk);
  setOff(cfg().turns_off.filter(x => x !== id));
  closeTechStatusMenu();
  renderTurnsTechGrid();
}
export function setTechOff() {
  if (!_techStatusMenuId) return;
  toggleTurnsOffStaff(_techStatusMenuId);
  closeTechStatusMenu();
}
export function toggleTurnsOffStaff(staffId) {
  const off = cfg().turns_off;
  if (off.includes(staffId)) setOff(off.filter(id => id !== staffId));
  else { setOff([...off, staffId]); setBreak(cfg().turns_break.filter(id => id !== staffId)); }
  renderTurns();
}

// ── Tech selector modal (roster) ──────────────────
export function showTurnsTechSelector() {
  const list = document.getElementById('turns-tech-selector-list');
  const currentOrder = getActiveTurnsOrder();
  const activeOnly = activeStaff();
  if (activeOnly.length === 0) {
    list.innerHTML = `<div class="text-sm font-body text-on-surface-variant py-6 text-center">No staff found. Add staff in <strong>Settings → Staff Management</strong> first.</div>`;
    const m = document.getElementById('turns-tech-modal'); m.classList.remove('hidden'); m.style.display = 'flex'; return;
  }
  const remaining = activeOnly.filter(s => !currentOrder.includes(s.id)).sort(byName);
  const allForDisplay = [...currentOrder.map(id => activeOnly.find(s => s.id === id)).filter(Boolean), ...remaining];
  list.innerHTML = allForDisplay.map(st => {
    const inOrder = currentOrder.includes(st.id), orderIdx = currentOrder.indexOf(st.id);
    const photo = st.photo ? `<img src="${st.photo}" class="w-9 h-9 rounded-full object-cover flex-shrink-0">` : `<div class="w-9 h-9 rounded-full bg-surface-container-high flex items-center justify-center flex-shrink-0"><span class="text-xs font-headline font-bold text-on-surface">${st.name.charAt(0)}</span></div>`;
    return `<div class="flex items-center gap-3 p-3 rounded-xl mb-1 cursor-pointer select-none tech-order-item ${inOrder ? 'bg-primary/10 border border-primary/30' : 'bg-surface-container border border-transparent'}" data-staff-id="${st.id}" data-in-order="${inOrder}" onclick="toggleTurnsTechOrder('${st.id}')">
      <span class="material-symbols-outlined text-outline-variant cursor-grab tech-drag-handle" style="font-size:20px" onpointerdown="startTechReorder(event)">drag_indicator</span>${photo}
      <div class="flex-grow"><div class="font-headline font-semibold text-on-surface text-sm">${st.name}</div>${inOrder ? `<div class="text-[11px] font-body text-primary">Turn order: #${orderIdx+1}</div>` : '<div class="text-[11px] font-body text-on-surface-variant">Not in today\'s rotation</div>'}</div>
      <div class="w-6 h-6 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${inOrder ? 'bg-primary border-primary' : 'border-outline-variant'}">${inOrder ? '<span class="material-symbols-outlined text-on-primary" style="font-size:14px;font-variation-settings:\'FILL\' 1">check</span>' : ''}</div></div>`;
  }).join('');
  const m = document.getElementById('turns-tech-modal'); m.classList.remove('hidden'); m.style.display = 'flex';
}
export function checkAllTechs() { setOrder([...activeStaff()].sort(byName).map(s => s.id)); showTurnsTechSelector(); }
export function uncheckAllTechs() { setOrder([]); showTurnsTechSelector(); }
export function toggleTurnsTechOrder(staffId) {
  const order = getActiveTurnsOrder();
  setOrder(order.includes(staffId) ? order.filter(id => id !== staffId) : [...order, staffId]);
  showTurnsTechSelector();
}
export function saveTurnsTechOrder() {
  closeTurnsTechModal();
  renderTurns();
  showToast(getActiveTurnsOrder().length + ' technician' + (getActiveTurnsOrder().length !== 1 ? 's' : '') + ' in today\'s rotation');
}
export function closeTurnsTechModal() { const m = document.getElementById('turns-tech-modal'); m.classList.add('hidden'); m.style.display = ''; }

// Tech selector drag-reorder
let _reorderDragging = null, _reorderClone = null, _reorderList = null;
export function startTechReorder(e) {
  e.stopPropagation();
  const item = e.currentTarget.closest('.tech-order-item');
  if (!item) return;
  _reorderDragging = item; _reorderList = item.parentNode;
  const rect = item.getBoundingClientRect();
  _reorderClone = item.cloneNode(true);
  _reorderClone.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;opacity:0.9;pointer-events:none;z-index:9999;border-radius:12px;box-shadow:0 12px 30px rgba(0,0,0,0.28);transform:rotate(-1.5deg) scale(1.02);`;
  document.body.appendChild(_reorderClone);
  item.style.opacity = '0.3';
  document.addEventListener('pointermove', onTechReorderMove);
  document.addEventListener('pointerup', onTechReorderEnd, { once: true });
  e.preventDefault();
}
function onTechReorderMove(e) {
  if (!_reorderClone) return;
  _reorderClone.style.top = (e.clientY - 25) + 'px';
  const items = [..._reorderList.querySelectorAll('.tech-order-item')];
  items.forEach(i => i.classList.remove('drop-above'));
  const hovered = items.find(i => { if (i === _reorderDragging) return false; const r = i.getBoundingClientRect(); return e.clientY >= r.top && e.clientY <= r.bottom; });
  if (hovered) hovered.classList.add('drop-above');
}
function onTechReorderEnd(e) {
  document.removeEventListener('pointermove', onTechReorderMove);
  if (_reorderClone) { _reorderClone.remove(); _reorderClone = null; }
  if (!_reorderDragging) return;
  _reorderDragging.style.opacity = '';
  const items = [..._reorderList.querySelectorAll('.tech-order-item')];
  items.forEach(i => i.classList.remove('drop-above'));
  const hovered = items.find(i => { if (i === _reorderDragging) return false; const r = i.getBoundingClientRect(); return e.clientY >= r.top && e.clientY <= r.bottom; });
  if (hovered && hovered !== _reorderDragging) {
    _reorderList.insertBefore(_reorderDragging, hovered);
    setOrder([..._reorderList.querySelectorAll('.tech-order-item[data-in-order="true"]')].map(el => el.dataset.staffId));
    showTurnsTechSelector();
  }
  _reorderDragging = null; _reorderList = null;
}

export function saveTurnsAndSync() { renderTurns(); showToast('Turns saved & synced ✓'); }

// ── History (device-local archive) ────────────────
export function archiveTurnsForToday() {
  const today = todayStr();
  turnsHistory[today] = {
    order: [...cfg().turns_order],
    snapshot: q().map(e => ({ id: String(e.id), name: e.name, phone: e.phone||'', services: e.services, assignments: e.assignments||[], totalCost: e.totalCost||0, status: e.status, checkinTime: e.checkinTime })),
  };
  const keys = Object.keys(turnsHistory).sort().slice(-90);
  const pruned = {}; keys.forEach(k => pruned[k] = turnsHistory[k]);
  turnsHistory = pruned; saveTurnsHistory();
  setOrder([]);
}
export function openTurnsHistoryPicker(ev) {
  window.openDayPicker?.(ev, { value: turnsViewingHistory || todayStr(), onPick: loadTurnsHistory });
}
export function loadTurnsHistory(dateStr) {
  const today = todayStr();
  if (!dateStr || dateStr === today) { clearTurnsHistory(); return; }
  turnsViewingHistory = dateStr;
  const btn = document.getElementById('turns-date-btn-val'); if (btn) btn.textContent = new Date(dateStr+'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric' });
  document.getElementById('turns-date-label').textContent = new Date(dateStr+'T12:00:00').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
  renderTurnsTechGrid(); renderTurnsQueue();
}
export function clearTurnsHistory() {
  turnsViewingHistory = null;
  const btn = document.getElementById('turns-date-btn-val'); if (btn) btn.textContent = 'Today';
  const lbl = document.getElementById('turns-date-label'); if (lbl) lbl.textContent = new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
  renderTurns();
}
// Prev/next-day arrows on the Date bubble. Stepping to today (or a future day) returns
// to the live grid; you can't go past today (no future turns).
export function shiftTurnsDate(dir) {
  const cur = turnsViewingHistory ? new Date(turnsViewingHistory + 'T12:00:00') : new Date();
  cur.setDate(cur.getDate() + dir);
  const today = new Date(); today.setHours(0,0,0,0); cur.setHours(0,0,0,0);
  if (cur >= today) { clearTurnsHistory(); return; }
  loadTurnsHistory(localDateStr(cur));
}
// Past-day grid: built from the synced transaction records for the date (the same
// source Reports uses, so the two always agree), grouped per technician like the
// live grid. The device-local turndesk_turns_history snapshot is used only as a
// fallback for the tech ordering. Renders IDENTICALLY to the live grid — party
// dots (multiple guests on one ticket), split-tech link chips (one guest under
// 2+ techs), and group outlines — but greyed + read-only so a past day can't be
// changed by accident. Filled bubbles still open the historical edit modal for
// managers (intentional edit), so the look matches the live "paid" bubble exactly.
function histDayRecords(dateStr) {
  return (window.buildCombinedRecords?.() || []).filter(r => isPaidStatus(r.status) && localDateStr(new Date(r.checkinTime)) === dateStr);
}
function histAssignmentsByTech(recs) {
  const byTech = {};
  recs.forEach(r => (r.assignments || []).forEach(a => {
    const tid = a.techId || '__unassigned__';
    (byTech[tid] ||= []).push({ entry: r, assignment: a });
  }));
  Object.values(byTech).forEach(list => list.sort((x, y) =>
    (x.assignment.assignedAt || new Date(x.entry.checkinTime).getTime()) -
    (y.assignment.assignedAt || new Date(y.entry.checkinTime).getTime())));
  return byTech;
}
function renderTurnsHistoryView() {
  const grid = document.getElementById('turns-tech-grid');
  if (!grid) return;
  const dateStr = turnsViewingHistory;
  const dayRecs = histDayRecords(dateStr);
  const byTech = histAssignmentsByTech(dayRecs);
  const snap = turnsHistory[dateStr];

  // Same markers the live grid computes — fed from the day's records instead of q().
  // Party letters tie multiple guests on one ticket together; link chips flag one
  // guest with multiple service cards (same tech or split across techs).
  const partyLetters = partyLetterMap(dayRecs);
  const splitTags = new Map(); let _splitN = 0;
  dayRecs.forEach(r => {
    const assigned = (r.assignments || []).filter(a => a.techId).length;
    if (assigned >= 2) { splitTags.set(String(r.id), GROUP_COLORS[_splitN % GROUP_COLORS.length]); _splitN++; }
  });

  let order = (snap?.order || []).filter(id => id && staffById(id));
  if (order.length === 0) order = getActiveTurnsOrder();
  Object.keys(byTech).forEach(tid => { if (tid !== '__unassigned__' && !order.includes(tid)) order.push(tid); });

  const canAdd = canDo('historicalEntry');
  const addBtn = canAdd
    ? `<button onclick="showHistoricalEntryModal(null,'${dateStr}')" class="ml-auto flex items-center gap-1 bg-primary text-on-primary px-3 py-1.5 rounded-lg text-xs font-headline font-bold active:scale-95 transition-all"><span class="material-symbols-outlined" style="font-size:16px">add</span> Add turn to this day</button>`
    : '';
  const banner = `<div class="bg-secondary-container/30 rounded-xl px-4 py-2 mb-3 text-sm font-body text-on-surface-variant flex items-center gap-2"><span class="material-symbols-outlined" style="font-size:16px">history</span> Past day — built from saved transactions${canAdd ? '. Tap a turn to edit.' : ''}${addBtn}</div>`;

  const hasData = Object.values(byTech).some(l => l.length);
  if (!hasData) {
    grid.innerHTML = banner + `<div class="text-sm font-body text-on-surface-variant py-8 text-center opacity-70">No completed turns recorded for this day.${canAdd ? '<br>Use “Add turn to this day” to recreate them.' : ''}</div>`;
    return;
  }

  const rowFor = (tid) => {
    const items = byTech[tid] || [];
    if (!items.length) return '';
    const isUnassigned = tid === '__unassigned__';
    const st = isUnassigned ? null : staffById(tid);
    if (!isUnassigned && !st) return '';
    const name = isUnassigned ? 'Unassigned' : st.name;
    const accent = isUnassigned ? '#9aa0a3' : '#1a5252';

    let full = 0, half = 0, bonus = 0, billed = 0;
    items.forEach(({ assignment: a }) => {
      const t = classifyTurn(a.cost || 0, a.serviceId || '');
      if (t === 'full') full++; else if (t === 'half') half += 0.5; else if (t === 'bonus') bonus++;
      billed += a.cost || 0;
    });
    const total = full + half;
    const isHalf = !Number.isInteger(total) && total > 0;
    const photo = (!isUnassigned && st.photo)
      ? `<img src="${st.photo}" class="w-10 h-10 rounded-full object-cover border-2 flex-shrink-0" style="border-color:${accent}">`
      : `<div class="w-10 h-10 rounded-full flex items-center justify-center border-2 flex-shrink-0 text-sm font-headline font-bold" style="background:${accent}20;border-color:${accent};color:${accent}">${isUnassigned ? '?' : name.charAt(0).toUpperCase()}</div>`;
    const turnDisplay = total > 0
      ? `<span class="text-sm font-headline font-bold ${isHalf ? 'px-1.5 py-0.5 rounded-md' : ''}" style="${isHalf ? 'background:#f5c870;color:#3a2800' : 'color:' + accent}">${total}t</span>`
      : `<span class="text-sm font-headline text-outline-variant">0t</span>`;
    const techCol = `<div class="flex items-center gap-2 w-[155px] flex-shrink-0 pr-2">${photo}
      <div class="min-w-0"><div class="font-headline font-semibold text-on-surface text-sm truncate leading-tight">${name}</div>
      <div class="flex items-center gap-1.5 mt-0.5">${turnDisplay}${bonus > 0 ? `<span class="text-[10px] text-secondary">+${bonus}b</span>` : ''}</div>
      <div class="text-[10px] font-body font-semibold mt-0.5" style="color:#1a5252">$${billed.toFixed(0)} billed</div></div></div>`;

    let turnCounter = 0;
    const slotHtml = items.map(({ entry: e, assignment: a }) => {
      const cost = a.cost || 0;
      const tt = classifyTurn(cost, a.serviceId || '');
      if (tt === 'full') turnCounter += 1; else if (tt === 'half') turnCounter += 0.5;
      const turnLabelNum = Number.isInteger(turnCounter) ? turnCounter : turnCounter.toFixed(1);
      const turnLabel = tt === 'bonus' ? 'Bonus' : (cost === 0 ? '?' : '' + turnLabelNum);
      const s = svc(a.serviceId);
      const svcLabel = s ? s.label : (e.services || []).map(sid => svc(sid)?.label || '?').join(', ');
      const costStr = cost ? '$' + Number(cost).toFixed(0) : '';
      const timeStr = new Date(e.checkinTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      // Same group outline + party dot + split-tech link chip as the live grid.
      const outline = e.groupId ? `;outline:2px solid ${e.groupColor||'#e8a230'};outline-offset:-1px` : '';
      const groupDot = e.groupId ? `<span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:4px;background:${e.groupColor||'#888'};color:#fff;font-size:8px;font-weight:800;flex-shrink:0;margin-right:2px">${partyLetters.get(e.groupId)||'•'}</span>` : '';
      const splitColor = splitTags.get(String(e.id));
      const splitTag = splitColor ? `<span title="Same customer — multiple services" style="display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:5px;background:${splitColor};color:#fff;flex-shrink:0;margin-right:2px"><span class="material-symbols-outlined" style="font-size:11px;font-variation-settings:'FILL' 1">link</span></span>` : '';
      const tap = canAdd ? `onclick="showHistoricalEntryModal('${e.id}')"` : '';
      return `<div class="flex-shrink-0 w-[150px] px-1">
        <button ${tap} class="w-full rounded-xl px-2 py-1.5 text-left ${canAdd ? 'active:scale-95 cursor-pointer' : 'cursor-default'} transition-all text-xs font-body" style="background:#dde2e5;color:#555;min-height:66px${outline}">
          <div class="flex items-center justify-between gap-0.5 mb-0.5"><div class="flex items-center gap-0.5 min-w-0">${groupDot}${splitTag}<span class="font-semibold text-[11px] truncate">${e.name}</span></div>${turnLabel ? `<span class="text-[11px] font-headline font-bold flex-shrink-0 ml-1" style="opacity:0.75">${turnLabel}</span>` : ''}</div>
          <div class="text-[10px] opacity-90 leading-tight">${svcLabel}${a.station ? ' · ' + a.station : ''}${costStr ? ' · ' + costStr : ''}</div>
          <div class="text-[9px] opacity-60">${timeStr}</div>
        </button></div>`;
    }).join('');

    return `<div class="flex items-center border-b border-surface-container-high py-2 gap-2">${techCol}
      <div class="flex gap-1.5 overflow-x-auto pb-0.5" style="min-width:0;flex:1;scrollbar-width:thin">${slotHtml}</div></div>`;
  };

  grid.innerHTML = banner + order.map(rowFor).filter(Boolean).join('') + rowFor('__unassigned__');
}

// ── Export (CSV + PDF) — the currently-viewed day (today or a history date) ────
const _statusWord = ss => isPaidStatus(ss) ? 'Paid' : ss === 'complete' ? 'Complete' : ss === 'inservice' ? 'In service' : 'Waiting';
// Roll an assignment list (+ today's skips) into a per-tech summary + per-turn detail.
function _turnRowsFromItems(items, skips, isHistory) {
  const merged = [
    ...items.map(it => ({ kind: 'a', it, t: it.assignment.assignedAt || new Date(it.entry.checkinTime).getTime() })),
    ...(skips || []).map(sk => ({ kind: 'skip', sk, t: new Date(sk.at).getTime() })),
  ].sort((a, b) => a.t - b.t);
  let counter = 0, full = 0, half = 0, bonus = 0, billed = 0;
  const detail = [];
  merged.forEach(m => {
    if (m.kind === 'skip') {
      counter += 1; full += 1;
      detail.push({ turn: counter, customer: '(skipped turn)', service: 'Turn passed · no customer', station: '', cost: 0, status: 'Skipped', time: new Date(m.sk.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
      return;
    }
    const { entry: e, assignment: a } = m.it;
    const tt = classifyTurn(a.cost || 0, a.serviceId || '');
    if (tt === 'full') { counter += 1; full += 1; } else if (tt === 'half') { counter += 0.5; half += 0.5; } else if (tt === 'bonus') bonus += 1;
    const ss = getAssignmentStatus(e, a);
    if (isHistory || ss === 'complete' || isPaidStatus(ss)) billed += a.cost || 0;   // earned once the work is done
    const s = svc(a.serviceId);
    detail.push({
      turn: tt === 'bonus' ? 'Bonus' : (a.cost ? (Number.isInteger(counter) ? counter : counter.toFixed(1)) : '?'),
      customer: e.name, service: s ? s.label : (e.services || []).map(sid => svc(sid)?.label || '?').join(', '),
      station: a.station || '', cost: a.cost || 0, status: _statusWord(ss),
      time: new Date(e.checkinTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
  });
  return { turnsTotal: full + half, bonus, billed, detail };
}
function turnsExportData() {
  const dateStr = turnsViewingHistory || todayStr();
  const isHistory = !!turnsViewingHistory;
  const rows = [];
  if (isHistory) {
    const byTech = histAssignmentsByTech(histDayRecords(dateStr));
    const snap = turnsHistory[dateStr];
    let order = (snap?.order || []).filter(id => id && staffById(id));
    if (order.length === 0) order = getActiveTurnsOrder();
    Object.keys(byTech).forEach(tid => { if (tid !== '__unassigned__' && !order.includes(tid)) order.push(tid); });
    if (byTech['__unassigned__']) order.push('__unassigned__');
    order.forEach(tid => {
      const items = byTech[tid] || []; if (!items.length) return;
      const name = tid === '__unassigned__' ? 'Unassigned' : staffById(tid)?.name; if (!name) return;
      rows.push({ name, status: '—', ..._turnRowsFromItems(items, [], true) });
    });
  } else {
    getActiveTurnsOrder().forEach(staffId => {
      const st = staffById(staffId); if (!st) return;
      rows.push({ name: st.name, status: getTechStatusColor(staffId).label, ..._turnRowsFromItems(getTechAllAssignments(staffId), todaySkips(staffId), false) });
    });
  }
  return { dateStr, isHistory, rows };
}
export function exportTurnsCSV() {
  const { dateStr, rows } = turnsExportData();
  const m = [];
  m.push(['Technician Turns', new Date(dateStr + 'T12:00:00').toLocaleDateString()]);
  m.push([]); m.push(['SUMMARY']); m.push(['Technician', 'Status', 'Turns', 'Bonus', 'Billed']);
  rows.forEach(r => m.push([r.name, r.status, r.turnsTotal, r.bonus, '$' + r.billed.toFixed(2)]));
  m.push([]); m.push(['DETAIL']); m.push(['Technician', 'Turn', 'Customer', 'Service', 'Station', 'Cost', 'Status', 'Time']);
  rows.forEach(r => r.detail.forEach(d => m.push([r.name, d.turn, d.customer, d.service, d.station, d.cost ? '$' + Number(d.cost).toFixed(2) : '', d.status, d.time])));
  const csv = m.map(line => line.map(c => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a'); a.href = url; a.download = `turndesk-turns-${dateStr}.csv`; a.click(); URL.revokeObjectURL(url);
  showToast('Turns exported as CSV (opens in Excel)');
}
export function exportTurnsPDF() {
  const { dateStr, rows } = turnsExportData();
  const dt = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const totalTurns = rows.reduce((s, r) => s + r.turnsTotal, 0), totalBilled = rows.reduce((s, r) => s + r.billed, 0);
  const sumRows = rows.map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.status)}</td><td style="text-align:center">${r.turnsTotal}</td><td style="text-align:center">${r.bonus}</td><td style="text-align:right">$${r.billed.toFixed(2)}</td></tr>`).join('');
  const detRows = rows.flatMap(r => r.detail.map(d => `<tr><td>${esc(r.name)}</td><td style="text-align:center">${esc(d.turn)}</td><td>${esc(d.customer)}</td><td>${esc(d.service)}</td><td>${esc(d.station)}</td><td style="text-align:right">${d.cost ? '$' + Number(d.cost).toFixed(2) : ''}</td><td>${esc(d.status)}</td><td>${esc(d.time)}</td></tr>`)).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>TurnDesk Turns — ${esc(dt)}</title>
    <style>@page{size:8.5in 11in;margin:0.5in}body{font-family:Arial,Helvetica,sans-serif;color:#1a1a1a}h1{font-size:18px;margin:0 0 2px}h2{font-size:13px;margin:18px 0 6px;border-bottom:2px solid #1a5252;padding-bottom:2px}.sub{color:#666;font-size:12px;margin-bottom:8px}table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #ccc;padding:4px 6px;text-align:left}th{background:#f0f4f4}</style></head>
    <body><h1>Technician Turns</h1><div class="sub">${esc(dt)} · ${rows.length} technician${rows.length !== 1 ? 's' : ''} · ${totalTurns} turns · $${totalBilled.toFixed(2)} billed</div>
    <h2>Summary</h2><table><thead><tr><th>Technician</th><th>Status</th><th style="text-align:center">Turns</th><th style="text-align:center">Bonus</th><th style="text-align:right">Billed</th></tr></thead><tbody>${sumRows || '<tr><td colspan="5">No turns this day.</td></tr>'}</tbody></table>
    <h2>Detail</h2><table><thead><tr><th>Technician</th><th style="text-align:center">Turn</th><th>Customer</th><th>Service</th><th>Station</th><th style="text-align:right">Cost</th><th>Status</th><th>Time</th></tr></thead><tbody>${detRows || '<tr><td colspan="8">No turns this day.</td></tr>'}</tbody></table>
    </body></html>`;
  const u = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const w = window.open(u, '_blank'); if (w) setTimeout(() => w.print(), 600); else showToast('Allow pop-ups to print');
  setTimeout(() => URL.revokeObjectURL(u), 5000);
}

// ── Drag & drop (event delegation) ────────────────
(function initTurnsDrag() {
  let dragEntryId = null, dragTechId = null, dragClone = null, isDragging = false;
  const DRAG_THRESH = 6; let startX = 0, startY = 0, pendingEntry = null;
  let justDragged = false;   // suppress the click that trails a real drag (so a reorder doesn't also open Assign&Price)
  // Touch: a customer bubble only becomes draggable after a tap-and-hold, so a normal
  // swipe scrolls the tech's turn row (overflow-x) / the waiting list instead of grabbing
  // the bubble. Mouse keeps the move-threshold drag (no drag-to-scroll on desktop).
  let longPressTimer = null, longPressArmed = false, pointerKind = 'mouse';
  const LONG_PRESS_MS = 400;   // hold this long before a bubble lifts
  const TOUCH_CANCEL = 10;     // finger travel (px) before the hold fires = "scroll", not "grab"
  function getTarget(e, selector) { let el = e.target; while (el && el !== document.body) { if (el.matches && el.matches(selector)) return el; el = el.parentElement; } return null; }
  function startDrag(card) {
    isDragging = true; dragEntryId = card.dataset.entryId; dragTechId = card.dataset.techId || null;
    const rect = card.getBoundingClientRect();
    dragClone = card.cloneNode(true);
    dragClone.style.cssText = ['position:fixed',`left:${rect.left}px`,`top:${rect.top}px`,`width:${rect.width}px`,'opacity:0.92','pointer-events:none','z-index:9999','border-radius:12px','box-shadow:0 14px 44px rgba(0,0,0,0.28)','transform:rotate(1.5deg) scale(1.03)','transition:none','background:white'].join(';');
    document.body.appendChild(dragClone);
    card.style.opacity = '0.2'; card.style.transform = 'scale(0.97)';
  }
  function endDrag(e) {
    if (!isDragging) { pendingEntry = null; return; }
    isDragging = false;
    justDragged = true; setTimeout(() => { justDragged = false; }, 400);
    if (dragClone) { dragClone.remove(); dragClone = null; }
    document.querySelectorAll('#turns-waiting-list [data-entry-id], #turns-active-list [data-entry-id], .turns-filled-slot').forEach(c => { c.style.opacity = ''; c.style.transform = ''; });
    document.querySelectorAll('.turns-empty-slot').forEach(s => s.classList.remove('turns-drop-highlight'));
    document.querySelectorAll('.turns-reorder-target').forEach(s => s.classList.remove('turns-reorder-target'));
    const capturedId = dragEntryId, capturedTech = dragTechId;
    dragEntryId = null; dragTechId = null; pendingEntry = null;
    if (!capturedId) return;
    const pt = document.elementFromPoint(e.clientX, e.clientY);
    const filledTarget = pt?.closest('.turns-filled-slot');
    if (filledTarget && filledTarget.dataset.techId === capturedTech && filledTarget.dataset.entryId !== capturedId) {
      window.showWarnModal?.('Reorder turns?', 'Move this customer before the selected slot? All other turns shift accordingly.', () => reorderTurnSlots(capturedTech, capturedId, filledTarget.dataset.entryId));
      return;
    }
    const dropZone = pt?.closest('.turns-drop-zone');
    if (!dropZone) return;
    const targetTech = dropZone.dataset.techId;
    if (capturedTech && capturedTech !== targetTech) {
      const entry = q().find(x => String(x.id) === String(capturedId));
      if (entry?.assignments) {
        entry.assignments.forEach(a => { if (a.techId === capturedTech) a.techId = targetTech; });
        dispatch('queue.upsert', { entry });
        renderQueue(); renderTurns();
        showToast('Moved to ' + (staffById(targetTech)?.name || 'tech'));
      }
      return;
    }
    turnsAssignTarget = { techId: targetTech };
    showGroupAssignModal(capturedId);
    setTimeout(() => { document.querySelectorAll('#group-assign-content .assign-tech').forEach(sel => { if (!sel.value) sel.value = targetTech; }); window.updateGroupTotal?.(); }, 260);
  }
  document.addEventListener('pointerdown', function(e) {
    if (e.button !== 0) return;
    const card = getTarget(e, '.turns-filled-slot, #turns-waiting-list [data-entry-id], #turns-active-list [data-entry-id]');
    if (!card) return;
    // We don't preventDefault, so a tap still fires the button's click (opens
    // Assign&Price); a drag suppresses the trailing click via justDragged.
    startX = e.clientX; startY = e.clientY; pendingEntry = card; longPressArmed = false;
    pointerKind = e.pointerType || 'mouse';
    clearTimeout(longPressTimer);
    if (pointerKind === 'touch') {
      // Arm the drag only after a stationary hold; a swipe cancels it (below) so the row scrolls.
      longPressTimer = setTimeout(() => {
        if (pendingEntry && !isDragging) { longPressArmed = true; startDrag(pendingEntry); if (navigator.vibrate) navigator.vibrate(12); }
      }, LONG_PRESS_MS);
    }
  });
  document.addEventListener('pointermove', function(e) {
    if (isDragging && dragClone) {
      const w = parseFloat(dragClone.style.width);
      dragClone.style.left = (e.clientX - w/2) + 'px'; dragClone.style.top = (e.clientY - 30) + 'px';
      document.querySelectorAll('.turns-empty-slot').forEach(slot => { const r = slot.getBoundingClientRect(); slot.classList.toggle('turns-drop-highlight', e.clientX>=r.left && e.clientX<=r.right && e.clientY>=r.top && e.clientY<=r.bottom); });
      // Reorder target: highlight the same-tech filled slot the dragged customer would land before.
      document.querySelectorAll('.turns-filled-slot').forEach(slot => {
        const r = slot.getBoundingClientRect();
        const over = e.clientX>=r.left && e.clientX<=r.right && e.clientY>=r.top && e.clientY<=r.bottom;
        slot.classList.toggle('turns-reorder-target', over && slot.dataset.techId === dragTechId && slot.dataset.entryId !== dragEntryId);
      });
      return;
    }
    if (pendingEntry && !isDragging) {
      const dx = e.clientX - startX, dy = e.clientY - startY, dist = Math.sqrt(dx*dx + dy*dy);
      if (pointerKind === 'touch') {
        // Moved before the hold fired → it's a scroll, not a grab: stand down.
        if (dist > TOUCH_CANCEL) { clearTimeout(longPressTimer); pendingEntry = null; }
      } else if (dist > DRAG_THRESH) {
        startDrag(pendingEntry);
      }
    }
  });
  document.addEventListener('pointerup', function(e) { clearTimeout(longPressTimer); if (isDragging) endDrag(e); else pendingEntry = null; isDragging = false; longPressArmed = false; });
  document.addEventListener('pointercancel', function() {
    clearTimeout(longPressTimer); longPressArmed = false;
    isDragging = false; if (dragClone) { dragClone.remove(); dragClone = null; }
    document.querySelectorAll('.turns-filled-slot, #turns-waiting-list [data-entry-id], #turns-active-list [data-entry-id]').forEach(c => { c.style.opacity=''; c.style.transform=''; });
    document.querySelectorAll('.turns-empty-slot').forEach(s => s.classList.remove('turns-drop-highlight'));
    document.querySelectorAll('.turns-reorder-target').forEach(s => s.classList.remove('turns-reorder-target'));
    pendingEntry = null; dragEntryId = null; dragTechId = null;
  });
  // While a touch-drag is live, stop the page/row from scrolling under the clone.
  // Non-passive so preventDefault actually cancels the scroll on iOS Safari.
  document.addEventListener('touchmove', function(e) { if (isDragging) e.preventDefault(); }, { passive: false });
  // After a real drag, swallow the trailing click so a filled slot's onclick
  // (open Assign&Price) doesn't fire on top of the reorder. Capture phase → runs
  // before the inline onclick and stops it reaching the target.
  document.addEventListener('click', function(e) {
    if (justDragged) { justDragged = false; e.stopPropagation(); e.preventDefault(); }
  }, true);
})();

// ── Resizable Turns/Waiting divider (device-local width) ──────────────────────
// Drag #turns-split-handle to widen/narrow the waiting+active panel; the tech grid
// (flex-grow) takes the rest. Width persists per device (like the calendar-hours pref).
(function initTurnsSplit() {
  const KEY = 'turndesk_turns_split', MIN = 260, MAX = 680;
  const panel = () => document.getElementById('turns-side-panel');
  function restore() { const v = parseInt(localStorage.getItem(KEY) || '', 10); const p = panel(); if (p && v >= MIN && v <= MAX) p.style.width = v + 'px'; }
  document.addEventListener('DOMContentLoaded', restore); restore();
  let dragging = false;
  document.addEventListener('pointerdown', e => {
    if (!(e.target.closest && e.target.closest('#turns-split-handle'))) return;
    dragging = true; e.preventDefault(); document.body.style.userSelect = 'none';
  });
  document.addEventListener('pointermove', e => {
    if (!dragging) return;
    const p = panel(); if (!p) return;
    const w = Math.max(MIN, Math.min(MAX, p.getBoundingClientRect().right - e.clientX));
    p.style.width = w + 'px';
  });
  document.addEventListener('pointerup', () => {
    if (!dragging) return; dragging = false; document.body.style.userSelect = '';
    const p = panel(); if (p) localStorage.setItem(KEY, String(parseInt(p.style.width, 10) || 380));
  });
})();
