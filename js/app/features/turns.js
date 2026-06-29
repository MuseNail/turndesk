// ── Turns: rotation grid, drag-drop, tech status, turn classification ───────
import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { showToast, todayStr, byName, localDateStr, formatElapsed, partyLetterMap, statusTimeHtml, escHtml, dateBtnLabel } from '../utils.js';
import { GROUP_COLORS } from '../config.js';
import { canDo } from '../session.js';
import { getAssignmentStatus, isPaidStatus, entryStatusSince, applyAssignmentStatus, serviceLineStyle, effectiveServiceStatus } from './status.js';
import { renderQueue, showGroupAssignModal } from './queue.js';
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
function saveTurnsHistory() { try { localStorage.setItem('turndesk_turns_history', JSON.stringify(turnsHistory)); } catch (e) { console.warn('[turns] history save failed (quota?)', e); } }

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
// ── Coordinated per-customer suggestions (one tech per service) ───────────────
// Preference ranking for regular services — most preferred (largest) first. The
// most-preferred service is handed to the next-up (fewest-turns) tech. Wax / add-on
// are bonus: assigned first to the limited techs who can do them, and those techs
// are kept off regular work when a generalist can take it instead.
const SERVICE_PREF_ORDER = ['fullset','fill','dip','manicure','pedicure','polishchange','kidpedicure'];
const servicePrefRank = id => { const i = SERVICE_PREF_ORDER.indexOf(id); return i === -1 ? SERVICE_PREF_ORDER.length : i; };
// A limited bonus tech = a RESTRICTED menu that includes a bonus service (the
// "only 1–2 can do wax" specialists). Generalists (empty menu) are not flagged.
function isLimitedBonusTech(id) {
  const st = staffById(id); if (!st) return false;
  const list = st.services || [];
  return list.length > 0 && list.some(s => isAlwaysBonusService(s));
}

// For ONE customer: suggest a DIFFERENT tech for each still-waiting, unassigned
// service. Bonus services route to the specialists first; regular services then go
// out in preference order, the most-preferred to the fewest-turns tech, preferring
// generalists so the specialists stay free for bonus work. No tech is reused within
// the customer. Returns { serviceId: { techId, techName } }.
export function suggestTechsForEntry(entry) {
  const out = {};
  if (!entry) return out;
  const order = getActiveTurnsOrder();
  if (!order.length) return out;
  const need = (entry.services || []).filter(sid => {
    const a = (entry.assignments || []).find(x => x.serviceId === sid);
    const st = a ? getAssignmentStatus(entry, a) : 'waiting';
    return st === 'waiting' && !(a && a.techId);
  });
  if (!need.length) return out;
  const eligibleBase = order.filter(id =>
    !cfg().turns_break.includes(id) && !cfg().turns_off.includes(id) && getActiveTechEntries(id).length === 0);
  const used = new Set();
  const canDo = (id, sid) => { const st = staffById(id); return !!st && !(st.services && st.services.length > 0 && !st.services.includes(sid)); };
  // mode 'specialist' floats limited bonus techs to the front, 'generalist' to the back.
  const pick = (sid, mode) => {
    const cands = eligibleBase.filter(id => !used.has(id) && canDo(id, sid));
    if (!cands.length) return null;
    cands.sort((a, b) => {
      if (mode) {
        const la = isLimitedBonusTech(a) ? 1 : 0, lb = isLimitedBonusTech(b) ? 1 : 0;
        if (la !== lb) return mode === 'specialist' ? lb - la : la - lb;
      }
      return getTechTurns(a).total - getTechTurns(b).total || order.indexOf(a) - order.indexOf(b);
    });
    return cands[0];
  };
  const assign = (sid, mode) => { const id = pick(sid, mode); if (id) { used.add(id); out[sid] = { techId: id, techName: staffById(id)?.name || '?' }; } };
  need.filter(sid => isAlwaysBonusService(sid)).forEach(sid => assign(sid, 'specialist'));
  need.filter(sid => !isAlwaysBonusService(sid))
    .sort((a, b) => servicePrefRank(a) - servicePrefRank(b))
    .forEach(sid => assign(sid, 'generalist'));
  return out;
}

function buildSuggestions() {
  const suggestions = {};
  q().filter(e => !isPaidStatus(e.status)).forEach(e => { suggestions[e.id] = suggestTechsForEntry(e); });
  return suggestions;
}

// Accept a suggested tech for ONE service: assign it (status stays waiting) and
// open the assign/price modal so the front desk can price it, then advance to
// In Service or just save while still waiting.
export function acceptSuggestion(entryId, serviceId) {
  const entry = q().find(e => String(e.id) === String(entryId));
  if (!entry) return;
  const sug = suggestTechsForEntry(entry)[serviceId];
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
export function renderTurns() { _applyTurnsTextSize(); _applyTurnsTotals(); renderTurnsTechGrid(); renderTurnsQueue(); applyTurnsApptStripVisibility(); startTurnsApptRefresh(); }

// ── Per-device "$ billed" totals show/hide (Turns toolbar) ────────────────────
// Device-local (like the text size) — hide each tech's billed dollar total on a
// shared screen so staff don't compare earnings. Applied as a panel class; the
// CSS hides .turns-billed. Turn counts stay visible.
let _turnsTotalsShow = localStorage.getItem('turndesk_turns_totals') !== '0';
function _applyTurnsTotals() {
  document.getElementById('panel-turns')?.classList.toggle('turns-hide-totals', !_turnsTotalsShow);
  const btn = document.getElementById('turns-totals-toggle');
  if (btn) {
    btn.classList.toggle('bg-primary', _turnsTotalsShow);
    btn.classList.toggle('text-on-primary', _turnsTotalsShow);
    btn.classList.toggle('border-primary', _turnsTotalsShow);
    btn.classList.toggle('text-on-surface-variant', !_turnsTotalsShow);
    btn.classList.toggle('border-surface-container-high', !_turnsTotalsShow);
    btn.title = _turnsTotalsShow ? 'Tech billed totals shown — tap to hide' : 'Tech billed totals hidden — tap to show';
  }
  const ic = document.getElementById('turns-totals-icon');
  if (ic) ic.textContent = _turnsTotalsShow ? 'visibility' : 'visibility_off';
}
export function toggleTurnsTotals() {
  _turnsTotalsShow = !_turnsTotalsShow;
  localStorage.setItem('turndesk_turns_totals', _turnsTotalsShow ? '1' : '0');
  _applyTurnsTotals();
  showToast(_turnsTotalsShow ? 'Tech totals shown (this device) ✓' : 'Tech totals hidden (this device) ✓');
}

// ── Per-device Turns text size (C8) ───────────────
// Device-local (like turndesk_cal_hours) — the front-desk monitor can run Large while the
// iPad stays Standard. Applied as a panel class; the size overrides live in styles.css.
const turnsLarge = () => localStorage.getItem('turndesk_turns_large') === '1';
function _applyTurnsTextSize() { document.getElementById('panel-turns')?.classList.toggle('turns-large', turnsLarge()); }
export function setTurnsLarge(on) {
  localStorage.setItem('turndesk_turns_large', on ? '1' : '0');
  _applyTurnsTextSize(); renderTurnsDisplaySettings();
  showToast(on ? 'Turns board: large text (this device) ✓' : 'Turns board: standard text (this device) ✓');
}
export function renderTurnsDisplaySettings() {
  const host = document.getElementById('turns-display-buttons');
  const on  = 'flex-1 px-4 py-3 rounded-xl border font-body font-bold text-sm bg-primary text-on-primary border-primary';
  const off = 'flex-1 px-4 py-3 rounded-xl border font-body font-semibold text-sm bg-surface-container-lowest text-on-surface border-surface-container-high hover:bg-surface-container';
  if (host) host.innerHTML = `
    <button onclick="setTurnsLarge(false)" class="${turnsLarge() ? off : on}">Standard</button>
    <button onclick="setTurnsLarge(true)" class="${turnsLarge() ? on : off}">Large<span class="block text-[10px] font-normal opacity-80">easier to read from a distance</span></button>`;
  renderTurnsSepSettings();
}

// ── Per-device Turns row separator (divider vs recessed lane) ──────────────────
// Device-local (like the text size) — how the tech box is set apart from the turn
// bubbles so they don't read as one merged block. 'divider' = a thin rule; 'lane' =
// the bubbles sit in a tinted recessed track. Applied in renderTurnsTechGrid.
const turnsSep = () => localStorage.getItem('turndesk_turns_sep') === 'lane' ? 'lane' : 'divider';
export function setTurnsSep(mode) {
  localStorage.setItem('turndesk_turns_sep', mode === 'lane' ? 'lane' : 'divider');
  if (!turnsViewingHistory) renderTurnsTechGrid();
  renderTurnsSepSettings();
  showToast(mode === 'lane' ? 'Turns board: recessed lane (this device) ✓' : 'Turns board: divider line (this device) ✓');
}
function renderTurnsSepSettings() {
  const host = document.getElementById('turns-sep-buttons'); if (!host) return;
  const on  = 'flex-1 px-4 py-3 rounded-xl border font-body font-bold text-sm bg-primary text-on-primary border-primary';
  const off = 'flex-1 px-4 py-3 rounded-xl border font-body font-semibold text-sm bg-surface-container-lowest text-on-surface border-surface-container-high hover:bg-surface-container';
  const sep = turnsSep();
  host.innerHTML = `
    <button onclick="setTurnsSep('divider')" class="${sep === 'divider' ? on : off}">Divider line<span class="block text-[10px] font-normal opacity-80">a thin rule between</span></button>
    <button onclick="setTurnsSep('lane')" class="${sep === 'lane' ? on : off}">Recessed lane<span class="block text-[10px] font-normal opacity-80">bubbles in a tinted track</span></button>`;
}

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
  turnsUpcomingAppts().forEach(a => { const k = a.startMs + '|' + a.name; if (!seen.has(k)) seen.set(k, { startMs: a.startMs, name: a.name, svc: a.svc, techs: new Set(), calId: a.calId, eventId: a.eventId, notes: a.notes }); if (a.techName) seen.get(k).techs.add(a.techName); });
  const cards = [...seen.values()];
  if (sub) sub.textContent = cards.length ? `· ${cards.length} upcoming` : '· nothing upcoming';
  if (!cards.length) { host.innerHTML = `<div class="text-xs text-on-surface-variant py-3 px-1 opacity-70">No upcoming appointments today.</div>`; return; }
  const now = Date.now();
  const _tJs = s => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ').replace(/\r/g, '');
  // Compact bubble matching a turn-grid slot: w-[150px], rounded-xl, soft fill
  // (lavender = appointment, amber = ≤30 min). Two lines so the strip stays short.
  host.innerHTML = cards.map(a => {
    const time = new Date(a.startMs).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
    const mins = Math.round((a.startMs - now)/60000), late = mins < 0, soon = !late && mins <= 30;
    const techLbl = [...a.techs].join(', ') || 'Unassigned';
    const bg = late ? '#ffd9d9' : soon ? '#ffe0b2' : '#ede7f6', fg = late ? '#7a1a1a' : soon ? '#6d3200' : '#42306b';
    const badge = late ? `<span class="text-[9px] font-bold flex-shrink-0" style="color:#b91c1c">${-mins}m late</span>`
               : soon ? `<span class="text-[9px] font-bold flex-shrink-0" style="color:#9a4a00">${mins}m</span>` : '';
    return `<div class="flex-shrink-0 w-[150px] px-0.5"><div onclick="calEventClick(event,'${_tJs(a.calId)}','${_tJs(a.eventId)}','${_tJs(a.name)}','${_tJs(a.notes || '')}',true)" class="w-full rounded-xl px-2 py-1 text-left text-xs font-body cursor-pointer active:scale-95 transition-transform" style="background:${bg};color:${fg}">
      <div class="flex items-center gap-1"><span class="font-bold text-[11px] flex-shrink-0">${time}</span><span class="font-semibold text-[11px] truncate" style="flex:1;min-width:0">${_tEsc(a.name)}</span>${badge}</div>
      <div class="text-[10px] leading-tight truncate" style="opacity:.8">${_tEsc(a.svc)} · ${_tEsc(techLbl)}</div>
    </div></div>`;
  }).join('');
}
function turnsDueNoteCard(a, mins, slotH) {
  const time = new Date(a.startMs).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
  const late = mins < 0;
  const bg = late ? '#ffd9d9' : '#fff7e6', border = late ? '#dc2626' : '#f5a623', icon = late ? '#b91c1c' : '#c77700';
  const label = late ? 'Late appt' : 'Next appt', when = late ? `${-mins}m late` : `in ${mins}m`;
  const nameC = late ? '#7a1a1a' : '#5a3a00', whenC = late ? '#b91c1c' : '#8a5a00', svcC = late ? '#8a3030' : '#7a5a10';
  return `<div class="flex-shrink-0 w-[150px] px-1"><div class="w-full rounded-xl px-2 py-1.5 text-left text-xs font-body" style="background:${bg};border:2px solid ${border};min-height:${slotH || 66}px">
    <div class="flex items-center justify-between gap-0.5" style="margin-bottom:2px"><div class="flex items-center gap-1 min-w-0"><span class="material-symbols-outlined" style="font-size:13px;color:${icon}">notifications_active</span><span class="text-[9px] font-bold uppercase tracking-wide" style="color:${icon}">${label}</span></div><span class="font-bold text-[11px]" style="color:${whenC}">${when}</span></div>
    <div class="font-semibold text-[11px] truncate" style="color:${nameC}">${_tEsc(time)} · ${_tEsc(a.name)}</div>
    <div class="text-[10px] leading-tight truncate" style="color:${svcC}">${_tEsc(a.svc)}</div>
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

  const _db = document.getElementById('turns-date-btn-val'); if (_db) _db.textContent = dateBtnLabel(null);

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
  const sep = turnsSep();
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

  // Who gets the next walk-in: the AVAILABLE tech with the fewest turns; a tie goes to whoever
  // is higher in the turn order (scan top-down, replace only on strictly fewer turns). Flagged
  // in place — the row order itself never changes.
  let nextUpId = null, _nextUpTurns = Infinity;
  for (const sid of order) {
    if (getTechStatusColor(sid).label !== 'Available') continue;
    const tt = getTechTurns(sid).total;
    if (tt < _nextUpTurns) { _nextUpTurns = tt; nextUpId = sid; }
  }

  // Dynamic turn-card height: roomier when few techs, denser when many fit on screen
  // (≤5 → 76px, 6–7 → 66px, 8+ → 56px) so a busy day shows more techs without scrolling.
  const slotH = order.length <= 5 ? 76 : order.length <= 7 ? 66 : 56;

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
    const isNextUp = staffId === nextUpId;
    // Availability chip for the rotation column. GREEN is reserved for IN-SERVICE only (so it
    // never collides with an in-service turn slot): an available tech reads as a teal OUTLINE
    // chip, a busy tech as a green "Working now" chip, and the AVAILABLE tech due for the next
    // walk-in gets a single filled teal "Next up" chip — replacing the plain Available pill, no
    // separate badge. getTechStatusColor itself is left unchanged so the floor plan / history
    // keep their existing colors + labels.
    const _dot = c => `<span style="width:6px;height:6px;border-radius:50%;background:${c};display:inline-block"></span>`;
    const avPres = sc.label === 'Off'        ? { ring: '#b0b6ba', chip: 'background:#eceef0;color:#7a858a', lead: _dot('#b0b6ba'), label: 'Off' }
                 : sc.label === 'On Break'   ? { ring: '#e0a83a', chip: 'background:#faedcf;color:#9a6b00', lead: _dot('#e0a83a'), label: 'On break' }
                 : sc.label === 'In Service' ? { ring: '#2a7a4f', chip: 'background:#e9f4ee;color:#1b5e3b', lead: _dot('#2a7a4f'), label: 'Working now' }
                 : isNextUp                  ? { ring: '#1a5252', chip: 'background:#1a5252;color:#fff', lead: `<span class="material-symbols-outlined" style="font-size:11px">arrow_upward</span>`, label: 'Next up' }
                 :                             { ring: '#1a5252', chip: 'background:#fff;border:1px solid #b9c8c2;color:#1a5252', lead: _dot('#1a5252'), label: 'Available' };
    const photo = st.photo
      ? `<img src="${st.photo}" class="w-10 h-10 rounded-full object-cover border-2 flex-shrink-0" style="border-color:${avPres.ring}">`
      : `<div class="w-10 h-10 rounded-full flex items-center justify-center border-2 flex-shrink-0 text-sm font-headline font-bold" style="background:${avPres.ring}20;border-color:${avPres.ring};color:${avPres.ring}">${st.name.charAt(0).toUpperCase()}</div>`;
    const isHalf = !Number.isInteger(turns.total) && turns.total > 0;
    const turnDisplay = turns.total > 0
      ? `<span class="text-sm font-headline font-bold flex-shrink-0 ${isHalf ? 'px-1.5 py-0.5 rounded-md' : ''}" style="${isHalf ? 'background:#f5c870;color:#3a2800' : 'color:#1a5252'}">${turns.total}t</span>`
      : `<span class="text-sm font-headline text-outline-variant flex-shrink-0">0t</span>`;
    const techCol = `<div class="flex items-center gap-2 w-[155px] flex-shrink-0 pr-2">
      <button onclick="showTechStatusMenu(event,'${staffId}')" class="focus:outline-none flex-shrink-0">${photo}</button>
      <div class="min-w-0" style="flex:1">
        <div class="flex items-center gap-1.5 leading-tight"><span class="font-headline font-semibold text-on-surface text-sm truncate" style="min-width:0">${st.name}</span>${turnDisplay}<span class="turns-billed text-[10px] font-body font-semibold flex-shrink-0" style="color:#1a5252;margin-left:auto">$${billed.toFixed(0)}</span></div>
        <div class="flex items-center gap-1.5 mt-0.5"><span class="text-[10px] px-1.5 py-0.5 rounded-full font-semibold leading-none inline-flex items-center gap-1 flex-shrink-0" style="${avPres.chip}">${avPres.lead}${avPres.label}</span>${turns.bonus > 0 ? `<span class="text-[10px] text-secondary flex-shrink-0">+${turns.bonus}b</span>` : ''}</div>
      </div></div>`;

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
        return `<div class="flex-shrink-0 w-[150px] px-1"><div class="w-full h-full rounded-xl px-2 py-1.5 text-left text-xs font-body relative" style="background:#e6e6e6;color:#777;min-height:${slotH}px;border:1px dashed #b5b5b5">
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
        // Use the awaiting-price-aware status so a "Done — tech will price" service reads
        // as violet "Awaiting price", not the blue "Done" fill (its raw status is 'complete').
        const ss = effectiveServiceStatus(e, a);
        let bg, fg;
        if (isPaidStatus(ss)) { bg='#dde2e5'; fg='#555'; } else if (ss === 'awaiting') { bg='#e7e0f5'; fg='#3f2d6b'; } else if (ss === 'complete') { bg='#d3e4ef'; fg='#14425e'; } else if (ss === 'inservice') { bg='#d8ecdf'; fg='#1b4d33'; } else { bg='#ffe9c4'; fg='#5c4010'; }
        const outline = e.groupId ? `;outline:2px solid ${e.groupColor||'#e8a230'};outline-offset:-1px` : '';
        const s = svc(a.serviceId);
        const svcLabel = s ? s.label : (e.services.map(sid => svc(sid)?.label || '?').join(', '));
        const costStr = a.cost ? '$' + Number(a.cost).toFixed(0) : '';
        const timeStr = new Date(e.checkinTime).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
        const groupDot = e.groupId ? `<span style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:4px;background:${e.groupColor||'#888'};color:#fff;font-size:8px;font-weight:800;flex-shrink:0;margin-right:2px">${partyLetters.get(e.groupId)||'•'}</span>` : '';
        const splitColor = splitTags.get(String(e.id));
        const splitTag = splitColor ? `<span title="Same customer — multiple services" style="display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:5px;background:${splitColor};color:#fff;flex-shrink:0;margin-right:2px"><span class="material-symbols-outlined" style="font-size:11px;font-variation-settings:'FILL' 1">link</span></span>` : '';
        // Appointment marker (lavender, matching the upcoming-appts strip), shown on the
        // time/status row so it never adds a line or crowds the name/chip row on a busy card.
        const apptPill = e.isAppointment ? `<span title="Booked appointment" style="display:inline-flex;align-items:center;gap:2px;flex-shrink:0;background:#ede7f6;color:#42306b;font-size:8px;font-weight:700;line-height:1;padding:2px 5px;border-radius:999px"><span class="material-symbols-outlined" style="font-size:9px;font-variation-settings:'FILL' 1">event</span>Appt</span>` : '';
        return `<div class="flex-shrink-0 w-[150px] px-1 turns-filled-slot" data-entry-id="${e.id}" data-tech-id="${staffId}" data-slot="${slotIdx}">
          <button onclick="showGroupAssignModal('${e.id}')" class="w-full h-full rounded-xl px-2 py-1.5 text-left active:scale-95 transition-all text-xs font-body" style="background:${bg};color:${fg};min-height:${slotH}px${outline}">
            <div class="flex items-center justify-between gap-0.5 mb-0.5"><div class="flex items-center gap-0.5 min-w-0">${groupDot}${splitTag}<span class="font-semibold text-[11px] truncate">${e.name}</span></div>${turnLabel ? `<span class="text-[11px] font-headline font-bold flex-shrink-0 ml-1" style="${tt === 'half' ? 'background:#f5c870;color:#3a2800;padding:0 4px;border-radius:4px' : tt === 'bonus' ? 'background:#a9d2c7;color:#134b3c;padding:0 4px;border-radius:4px' : 'opacity:0.75'}">${turnLabel}</span>` : ''}</div>
            <div class="text-[10px] opacity-90 leading-tight">${svcLabel}${a.station ? ' · ' + a.station : ''}${costStr ? ' · ' + costStr : ''}</div>
            ${(() => { const sti = serviceTimeInfo(a); return sti ? `<div class="text-[10px] font-bold leading-tight" style="color:${sti.color}">${sti.text}</div>` : ''; })()}
            <div class="flex items-center gap-1"><span class="text-[9px] opacity-60" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${timeStr} · ${statusTimeHtml(entryStatusSince(e), isPaidStatus(ss))}</span>${apptPill}</div>
          </button></div>`;
      }
      return `<div class="flex-shrink-0 w-[150px] px-1 turns-drop-zone" data-tech-id="${staffId}" data-slot="${slotIdx}">
        <div class="turns-empty-slot w-full h-full rounded-xl border-2 border-dashed border-outline-variant/40 flex items-center justify-center text-outline-variant cursor-pointer hover:border-primary hover:bg-primary/5 hover:text-primary transition-all" style="min-height:${slotH}px" onclick="openTurnsAssign('${staffId}',${slotIdx})"><span class="material-symbols-outlined" style="font-size:20px">add</span></div></div>`;
    });
    // 30-min note: drop an amber "next appt" card into this tech's next-turn position
    // (right after their filled slots) when their soonest upcoming appt is ≤30 min out.
    const nextAppt = nextApptFor(staffId);
    if (nextAppt) { const mins = Math.round((nextAppt.startMs - _nowMs) / 60000); if (mins <= 30) slotArr.splice(filled.length, 0, turnsDueNoteCard(nextAppt, mins, slotH)); }
    const slotHtml = slotArr.join('');

    const rowAccent = isNextUp ? 'border-left:3px solid #1a5252;background:#eef5f5;border-radius:0 8px 8px 0;' : '';
    const slotRow = `<div class="turns-slot-row flex gap-1.5 overflow-x-auto pb-0.5" style="min-width:0;flex:1;scrollbar-width:thin">${slotHtml}</div>`;
    // Per-device separation between the tech box and the turn bubbles (see turnsSep()).
    const rightSide = sep === 'lane'
      ? `<div class="flex min-w-0" style="flex:1;background:#eef1f2;border:0.5px solid #e0e5e7;border-radius:12px;padding:4px 2px 4px 6px">${slotRow}</div>`
      : `<div class="self-stretch flex-shrink-0" style="width:1px;background:#d3dbdc;margin:6px 0"></div>${slotRow}`;
    return `<div class="flex items-center border-b border-surface-container-high py-1 gap-2" style="${rowAccent}">${techCol}${rightSide}</div>`;
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
    // Avatar bubble is STATUS-colored + consistent for everyone (green in service · blue done ·
    // amber waiting), so it reads at a glance and party members no longer get a different-colored
    // bubble. Party grouping still shows via the small letter badge (groupDot) beside the name.
    const _av = serviceLineStyle(e.status).pill;
    const avatar = `<div class="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-headline font-bold" style="background:${_av.bg};color:${_av.fg}">${escHtml(e.name.charAt(0).toUpperCase())}</div>`;
    const assignments = (e.assignments||[]).filter(a => a.techId || a.serviceId);
    const es = suggestions[e.id] || {};
    let serviceContent;
    if (assignments.length > 0) {
      serviceContent = assignments.map(a => {
        const tech = staffById(a.techId), s = svc(a.serviceId);
        const ls = serviceLineStyle(effectiveServiceStatus(e, a));
        const hot = ls.key === 'inservice';
        let techHtml = '', accept = '';
        if (tech) techHtml = `<span class="text-on-surface-variant">→ ${escHtml(tech.name)}</span>`;
        else if (es[a.serviceId]) { techHtml = `<span class="text-on-surface-variant">→ ${escHtml(es[a.serviceId].techName)}?</span>`; accept = acceptBtnHtml(e.id, a.serviceId, es[a.serviceId].techName); }
        const rowStyle = `border-left:${hot ? 3 : 2}px solid ${ls.bar};padding-left:4px;${ls.tint ? `background:${ls.tint};` : ''}${ls.rowOpacity < 1 ? `opacity:${ls.rowOpacity};` : ''}`;
        return `<div class="flex items-center gap-1 text-[10px] leading-tight rounded-r mt-0.5" style="${rowStyle}">
          <span style="display:inline-block;width:.8em;height:.8em;border-radius:50%;box-sizing:border-box;flex-shrink:0;${ls.dot}"></span>
          <span class="${hot ? 'font-bold' : 'font-semibold'} text-on-surface">${escHtml(s ? s.label : 'Service')}</span>
          ${techHtml}${a.cost ? `<span class="font-semibold text-primary">$${a.cost}</span>` : ''}
          <span class="text-[9px] font-bold px-1 rounded-full flex-shrink-0" style="background:${ls.pill.bg};color:${ls.pill.fg}">${ls.pill.label}</span>${accept}
        </div>`;
      }).join('');
    } else {
      const ls = serviceLineStyle('waiting');
      serviceContent = e.services.map(sid => { const s = svc(sid), sug = es[sid]; return `<div class="flex items-center gap-1 text-[10px] leading-tight rounded-r mt-0.5" style="border-left:2px solid ${ls.bar};padding-left:4px;opacity:${ls.rowOpacity}">
        <span style="display:inline-block;width:.8em;height:.8em;border-radius:50%;box-sizing:border-box;flex-shrink:0;${ls.dot}"></span>
        <span class="font-semibold text-on-surface">${escHtml(s ? s.label : sid)}</span>
        ${sug ? `<span class="text-on-surface-variant">→ ${escHtml(sug.techName)}?</span>${acceptBtnHtml(e.id, sid, sug.techName)}` : ''}
        <span class="text-[9px] font-bold px-1 rounded-full flex-shrink-0" style="background:${ls.pill.bg};color:${ls.pill.fg}">${ls.pill.label}</span>
      </div>`; }).join('');
    }
    // C9/D13 vocabulary (recolored v4.79): In Service = green, Done(complete) = blue, Waiting = amber
    // — match the status pills rendered inside this same card (and the floor-plan tints).
    const borderColor = e.status==='inservice' ? '#2a7a4f' : e.status==='complete' ? '#1a5c7a' : '#d4860a';
    const bgTint = e.status==='inservice' ? 'rgba(42,122,79,0.10)' : e.status==='complete' ? 'rgba(26,92,122,0.12)' : 'rgba(255,224,178,0.25)';
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
      ? `<img src="${st.photo}" style="width:175px;height:175px;border-radius:50%;object-fit:cover;border:6px solid ${sc.bg}">`
      : `<div style="width:175px;height:175px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:${sc.bg}20;border:6px solid ${sc.bg};color:${sc.bg};font-family:var(--font-headline);font-weight:700;font-size:72px">${(st.name||'?').charAt(0).toUpperCase()}</div>`;
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


// ── History (device-local archive) ────────────────
// Archive one day's turns snapshot into the device-local history (a fallback for the
// history grids; Reports + turns grids primarily rebuild from synced records). Filtered to
// the given day so the rollover keys the JUST-ENDED day correctly — the old "archive today
// at 4 AM" mis-keyed it, since todayStr() was already the new day by then.
export function archiveTurnsForDay(dateStr) {
  turnsHistory[dateStr] = {
    order: [...cfg().turns_order],
    snapshot: q().filter(e => localDateStr(new Date(e.checkinTime)) === dateStr)
      .map(e => ({ id: String(e.id), name: e.name, phone: e.phone||'', services: e.services, assignments: e.assignments||[], totalCost: e.totalCost||0, status: e.status, checkinTime: e.checkinTime })),
  };
  const keys = Object.keys(turnsHistory).sort().slice(-90);
  const pruned = {}; keys.forEach(k => pruned[k] = turnsHistory[k]);
  turnsHistory = pruned; saveTurnsHistory();
}
// Close out a finished day during the daily rollover: archive it, then clear the rotation
// so the new day starts fresh.
export function rolloverTurns(closedDateStr) { archiveTurnsForDay(closedDateStr); setOrder([]); setOff([]); }
export function openTurnsHistoryPicker(ev) {
  const today = new Date();
  const presets = [0, 1, 2, 3, 4, 5, 6].map(n => {
    const d = new Date(today); d.setDate(d.getDate() - n);
    return { label: n === 0 ? 'Today' : n === 1 ? 'Yesterday' : `${n} days ago`, date: localDateStr(d) };
  });
  window.openDayPicker?.(ev, { value: turnsViewingHistory || todayStr(), onPick: loadTurnsHistory, presets });
}
export function loadTurnsHistory(dateStr) {
  const today = todayStr();
  if (!dateStr || dateStr === today) { clearTurnsHistory(); return; }
  turnsViewingHistory = dateStr;
  const btn = document.getElementById('turns-date-btn-val'); if (btn) btn.textContent = dateBtnLabel(dateStr);
  renderTurnsTechGrid(); renderTurnsQueue();
}
export function clearTurnsHistory() {
  turnsViewingHistory = null;
  const btn = document.getElementById('turns-date-btn-val'); if (btn) btn.textContent = dateBtnLabel(null);
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
      <div class="turns-billed text-[10px] font-body font-semibold mt-0.5" style="color:#1a5252">$${billed.toFixed(0)} billed</div></div></div>`;

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
          <div class="flex items-center justify-between gap-0.5 mb-0.5"><div class="flex items-center gap-0.5 min-w-0">${groupDot}${splitTag}<span class="font-semibold text-[11px] truncate">${e.name}</span></div>${turnLabel ? `<span class="text-[11px] font-headline font-bold flex-shrink-0 ml-1" style="${tt === 'half' ? 'background:#f5c870;color:#3a2800;padding:0 4px;border-radius:4px' : tt === 'bonus' ? 'background:#a9d2c7;color:#134b3c;padding:0 4px;border-radius:4px' : 'opacity:0.75'}">${turnLabel}</span>` : ''}</div>
          <div class="text-[10px] opacity-90 leading-tight">${svcLabel}${a.station ? ' · ' + a.station : ''}${costStr ? ' · ' + costStr : ''}</div>
          <div class="text-[9px] opacity-60">${timeStr}</div>
        </button></div>`;
    }).join('');

    return `<div class="flex items-center border-b border-surface-container-high py-1 gap-2">${techCol}
      <div class="turns-slot-row flex gap-1.5 overflow-x-auto pb-0.5" style="min-width:0;flex:1;scrollbar-width:thin">${slotHtml}</div></div>`;
  };

  grid.innerHTML = banner + order.map(rowFor).filter(Boolean).join('') + rowFor('__unassigned__');
  // Mouse-wheel → horizontal scroll for each tech's turn row (same as the live grid; the past-day
  // rows were missing this handler, so the wheel didn't scroll them).
  grid.querySelectorAll('.turns-slot-row').forEach(row => {
    row.addEventListener('wheel', e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && row.scrollWidth > row.clientWidth) { row.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
  });
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
  const a = document.createElement('a'); a.href = url; a.download = `muse-turns-${dateStr}.csv`; a.click(); URL.revokeObjectURL(url);
  showToast('Turns exported as CSV (opens in Excel)');
}
export function exportTurnsPDF() {
  const { dateStr, rows } = turnsExportData();
  const dt = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const totalTurns = rows.reduce((s, r) => s + r.turnsTotal, 0), totalBilled = rows.reduce((s, r) => s + r.billed, 0);
  const sumRows = rows.map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.status)}</td><td style="text-align:center">${r.turnsTotal}</td><td style="text-align:center">${r.bonus}</td><td style="text-align:right">$${r.billed.toFixed(2)}</td></tr>`).join('');
  const detRows = rows.flatMap(r => r.detail.map(d => `<tr><td>${esc(r.name)}</td><td style="text-align:center">${esc(d.turn)}</td><td>${esc(d.customer)}</td><td>${esc(d.service)}</td><td>${esc(d.station)}</td><td style="text-align:right">${d.cost ? '$' + Number(d.cost).toFixed(2) : ''}</td><td>${esc(d.status)}</td><td>${esc(d.time)}</td></tr>`)).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Muse Turns — ${esc(dt)}</title>
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
