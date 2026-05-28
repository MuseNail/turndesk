// ── Reports, transactions, historical entry, refunds, deletion ──────────────
// Records live in the DO (state.records). Writes go through dispatch:
//   record.save (complete/historical/refund), record.delete (soft delete).
import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { showToast, localDateStr, todayStr, partyLetterMap, ticketTotal, newEntryId } from '../utils.js';
import { canDo, getActiveUser } from '../session.js';
import { classifyTurn } from './turns.js';
import { isPaidStatus } from './status.js';
import { squareUpsertCustomer } from './square-customers.js';
import { avgServiceTime, fmtDur } from './servicetime.js';
import { LOGO_PATH, PHOTOS_PROXY, AI_PROXY, GROUP_COLORS } from '../config.js';
import { gcRedemptions } from './giftcards.js';

const cfg = () => getState().config;
const records = () => getState().records;
const queue   = () => getState().queue;
const giftCards = () => getState().giftcards;
const svc = id => cfg().services.find(s => s.id === id);
const staffById = id => cfg().staff.find(s => s.id === id);
const activeStaff = () => cfg().staff.filter(s => !cfg().inactive_staff.includes(s.id));

let reportRange = { type: 'today', date: null, from: null, to: null, compare: 'prior' };

// ── Persist a completed entry as a record ─────────────────────────────────────
export function saveRecord(entry) {
  if (!entry.completedAt) entry.completedAt = new Date().toISOString();
  else if (entry.completedAt instanceof Date) entry.completedAt = entry.completedAt.toISOString();
  const record = {
    id: String(entry.id), name: entry.name, phone: entry.phone || '',
    services: entry.services, assignments: entry.assignments || [], items: entry.items || [], fees: entry.fees || [],
    discount: entry.discount || 0, discountNote: entry.discountNote || '', txnNote: entry.txnNote || '', totalCost: entry.totalCost || 0,
    groupId: entry.groupId || '', groupColor: entry.groupColor || '', groupLabel: entry.groupLabel || '',
    checkinTime: typeof entry.checkinTime === 'string' ? entry.checkinTime : new Date(entry.checkinTime).toISOString(),
    completedAt: entry.completedAt, status: entry.status, isAppointment: entry.isAppointment || false,
    loggedBy: getActiveUser()?.name || '',
  };
  dispatch('record.save', { record });
}

// Combine live done queue entries with stored records (queue wins for today).
export function buildCombinedRecords() {
  const deletedIds = new Set(getState().deletions.map(String));
  records().filter(r => r.status === 'deleted').forEach(r => deletedIds.add(String(r.id)));
  const liveSnaps = queue().filter(e => isPaidStatus(e.status) && !deletedIds.has(String(e.id))).map(e => ({
    id: String(e.id), name: e.name, phone: e.phone || '', services: e.services, assignments: e.assignments || [],
    items: e.items || [], fees: e.fees || [], discount: e.discount || 0, discountNote: e.discountNote || '', txnNote: e.txnNote || '',
    totalCost: e.totalCost || 0, checkinTime: e.checkinTime, completedAt: e.completedAt || null,
    status: e.status, isAppointment: e.isAppointment || false,
    groupId: e.groupId || '', groupColor: e.groupColor || '', groupLabel: e.groupLabel || '',
  }));
  const liveIds = new Set(liveSnaps.map(r => String(r.id)));
  const combined = [...liveSnaps, ...records().filter(r => !liveIds.has(String(r.id)) && r.status !== 'deleted' && !deletedIds.has(String(r.id)))];
  // Bulletproofing: derive each ticket's total from its parts so a stale cached
  // totalCost (e.g. a fee added after the total was last saved) can never skew a
  // report. Refunds keep their stored negative amount (no parts); a record with no
  // reconstructable parts keeps its stored total (don't zero legacy/odd rows).
  return combined.map(r => {
    if (r.status === 'refund' || !((r.assignments && r.assignments.length) || (r.items && r.items.length) || (r.fees && r.fees.length))) return r;
    const t = ticketTotal(r);
    return t === (r.totalCost || 0) ? r : { ...r, totalCost: t };
  });
}

// Per-customer visit history, derived from transaction records (local — no Square sync).
// Matched by phone (last-10-digits), falling back to an exact name match when there's no
// phone. Rendered into the Edit Customer modal. Called from showEditCustomer via window.
const _digits10 = s => (s || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
export function renderCustomerHistory(phone, name, targetId = 'edit-cust-history') {
  const el = document.getElementById(targetId); if (!el) return;
  const ph = _digits10(phone), nm = (name || '').trim().toLowerCase();
  const recs = buildCombinedRecords().filter(r => {
    if (r.status === 'deleted' || !(isPaidStatus(r.status) || r.status === 'refund')) return false;
    const rp = _digits10(r.phone);
    if (ph && rp) return rp.endsWith(ph) || ph.endsWith(rp);
    return !!nm && (r.name || '').trim().toLowerCase() === nm;
  }).sort((a, b) => new Date(b.checkinTime) - new Date(a.checkinTime));
  if (!recs.length) { el.innerHTML = '<p class="text-xs font-body text-on-surface-variant italic py-1">No visits recorded yet.</p>'; return; }
  const visits = recs.filter(r => r.status !== 'refund').length;
  const net = recs.reduce((s, r) => s + (r.status === 'refund' ? -Math.abs(r.totalCost || 0) : (r.totalCost || 0)), 0);
  el.innerHTML = `<div class="text-[11px] font-body text-on-surface-variant mb-2">${visits} visit${visits !== 1 ? 's' : ''} · $${net.toFixed(2)} total spent</div>` + recs.map(r => {
    const dt = new Date(r.checkinTime), isRefund = r.status === 'refund';
    const dateStr = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const svcs = (r.services || []).map(sid => svc(sid)?.label || sid).join(', ') || '—';
    const techs = [...new Set((r.assignments || []).filter(a => a.techId).map(a => staffById(a.techId)?.name).filter(Boolean))].join(', ');
    const note = (r.txnNote || r.discountNote || '').trim();
    const amt = isRefund ? `-$${Math.abs(r.totalCost || 0).toFixed(2)}` : `$${(r.totalCost || 0).toFixed(2)}`;
    return `<div class="rounded-xl border border-surface-container-high px-3 py-2 mb-1.5 ${isRefund ? 'bg-error/5' : 'bg-surface-container-low'}">
      <div class="flex items-center justify-between gap-2"><span class="text-xs font-headline font-semibold text-on-surface">${dateStr}${isRefund ? ' · refund' : ''}</span><span class="text-sm font-headline font-bold ${isRefund ? 'text-error' : 'text-primary'}">${amt}</span></div>
      <div class="text-[11px] font-body text-on-surface-variant">${svcs}${techs ? ' · ' + techs : ''}</div>
      ${note ? `<div class="text-[11px] font-body text-on-surface italic mt-0.5">“${note}”</div>` : ''}
    </div>`;
  }).join('');
}

// Lightweight per-customer summary for the queue-card "returning customer" badge (R5).
// Same record source + matching as renderCustomerHistory, but aggregated ONCE into an index
// and memoized so rendering N queue cards doesn't rebuild the combined-records set N times.
// The signature (record count + queue size + paid-today count) invalidates the cache on every
// mutation that can change the tallies (new record, queue add/remove, a ticket turning paid).
let _visitIdxCache = null, _visitIdxSig = '';
function _buildVisitIndex() {
  const byPhone = new Map(), byName = new Map();
  const bump = (map, key, r, isRef) => {
    if (!key) return;
    let v = map.get(key); if (!v) { v = { visits: 0, net: 0, tech: {} }; map.set(key, v); }
    if (!isRef) { v.visits++; (r.assignments || []).forEach(a => { if (a.techId) v.tech[a.techId] = (v.tech[a.techId] || 0) + 1; }); }
    v.net += isRef ? -Math.abs(r.totalCost || 0) : (r.totalCost || 0);
  };
  buildCombinedRecords().forEach(r => {
    if (!(isPaidStatus(r.status) || r.status === 'refund')) return;
    const isRef = r.status === 'refund';
    bump(byPhone, _digits10(r.phone), r, isRef);
    bump(byName, (r.name || '').trim().toLowerCase(), r, isRef);
  });
  return { byPhone, byName };
}
function _visitIndex() {
  const sig = records().length + '|' + queue().length + '|' + queue().filter(e => isPaidStatus(e.status)).length;
  if (!_visitIdxCache || _visitIdxSig !== sig) { _visitIdxSig = sig; _visitIdxCache = _buildVisitIndex(); }
  return _visitIdxCache;
}
export function customerVisitSummary(phone, name) {
  const idx = _visitIndex();
  const ph = _digits10(phone), nm = (name || '').trim().toLowerCase();
  const v = (ph && idx.byPhone.get(ph)) || (!ph && nm ? idx.byName.get(nm) : null);
  if (!v || v.visits <= 0) return null;
  let usualTechId = null, max = 0;
  for (const id in v.tech) if (v.tech[id] > max) { max = v.tech[id]; usualTechId = id; }
  return { visits: v.visits, totalSpent: v.net, usualTechId };
}

// ── Report range + date picker + comparison ───────
const _sod = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const _eod = d => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
const _addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
let _dpMonth = _sod(new Date());   // month shown in the date-picker calendar
const RANGE_PRESETS = [
  ['today','Today'], ['yesterday','Yesterday'], ['week','This Week'], ['lastweek','Last Week'],
  ['month','This Month'], ['lastmonth','Last Month'], ['payperiod','Pay Period'],
  ['thisyear','This Year'], ['lastyear','Last Year'], ['custom','Custom Range'],
];
const COMPARE_OPTS = [['prior','Prior period'], ['year','Prior year'], ['none','No comparison']];
const _rangeLabels = { today:'Today', yesterday:'Yesterday', week:'This Week', lastweek:'Last Week', month:'This Month', lastmonth:'Last Month', thisyear:'This Year', lastyear:'Last Year' };

export function setReportRange(type) {
  reportRange.type = type;
  if (type !== 'day') reportRange.date = null;
  syncRangeButtons();
  const showCustom = type === 'custom';
  // Reports + Transactions share one date window. A preset refreshes both immediately;
  // 'custom' waits for the operator to pick from/to in the popup, then applyCustomRange().
  if (showCustom) { renderDatePicker(); }
  else { closeDatePicker(); runReport(); renderTransactions(); }
  updateDateButtons();
}
export function selectRangeDay(dateStr) {
  reportRange.type = 'day'; reportRange.date = dateStr;
  syncRangeButtons(); closeDatePicker(); runReport(); renderTransactions(); updateDateButtons();
}
export function applyCustomRange() {
  const f = document.getElementById('dp-from')?.value, t = document.getElementById('dp-to')?.value;
  if (!f || !t) { showToast('Pick both a start and end date.'); return; }
  if (f > t) { showToast('Start date must be before end date.'); return; }
  reportRange.type = 'custom'; reportRange.from = f; reportRange.to = t;
  syncRangeButtons(); closeDatePicker(); runReport(); renderTransactions(); updateDateButtons();
}
export function setReportCompare(mode) {
  reportRange.compare = mode; closeCompareMenu(); runReport(); updateDateButtons();
}
// Prev/next arrows on the Date bubble step by the CURRENT period: a single day steps
// ±1 day (label reads Today/Yesterday/…), a week ±1 week, a month ±1 month, the pay
// period to the adjacent one, a custom range by its own length.
export function shiftReportRange(dir) {
  const cur = getReportDates(); if (!cur) return;
  const T = reportRange.type;
  if (T === 'today' || T === 'yesterday' || T === 'day') {
    reportRange.type = 'day'; reportRange.date = localDateStr(_addDays(cur.from, dir)); reportRange.from = null; reportRange.to = null;
  } else if (T === 'month' || T === 'lastmonth') {
    const from = new Date(cur.from.getFullYear(), cur.from.getMonth() + dir, 1);
    reportRange.type = 'custom'; reportRange.from = localDateStr(from); reportRange.to = localDateStr(new Date(from.getFullYear(), from.getMonth() + 1, 0));
  } else if (T === 'thisyear' || T === 'lastyear') {
    const yr = cur.from.getFullYear() + dir;
    reportRange.type = 'custom'; reportRange.from = localDateStr(new Date(yr, 0, 1)); reportRange.to = localDateStr(new Date(yr, 11, 31));
  } else if (T === 'payperiod') {
    const pp = dir < 0 ? prevPayPeriod({ from: cur.from }) : nextPayPeriod({ from: cur.from });
    reportRange.type = 'custom'; reportRange.from = localDateStr(pp.from); reportRange.to = localDateStr(pp.to);
  } else {
    const days = Math.round((_sod(cur.to) - _sod(cur.from)) / 86400000) + 1;   // week / lastweek / custom
    reportRange.type = 'custom'; reportRange.from = localDateStr(_addDays(cur.from, dir * days)); reportRange.to = localDateStr(_addDays(cur.to, dir * days));
  }
  syncRangeButtons(); closeDatePicker(); runReport(); renderTransactions(); updateDateButtons();
}
function syncRangeButtons() {
  document.querySelectorAll('.rng-btn').forEach(b => b.classList.toggle('active', b.dataset.range === reportRange.type));
}
function rangeLabel() {
  if (_rangeLabels[reportRange.type]) return _rangeLabels[reportRange.type];
  const d = getReportDates(); if (!d) return 'Custom';
  const fmt = x => x.toLocaleDateString('en-US',{month:'short',day:'numeric'});
  if (reportRange.type === 'day') { const diff = Math.round((_sod(d.from) - _sod(new Date())) / 86400000); return diff === 0 ? 'Today' : diff === -1 ? 'Yesterday' : diff === 1 ? 'Tomorrow' : fmt(d.from); }
  if (reportRange.type === 'payperiod') return `Pay Period (${fmt(d.from)} – ${fmt(d.to)})`;
  return `${fmt(d.from)} – ${fmt(d.to)}`;
}
function compareLabel() { return (COMPARE_OPTS.find(o => o[0] === reportRange.compare) || COMPARE_OPTS[0])[1]; }

// Current pay period from config.pay_period: weekly/biweekly anchored at startDate,
// or bimonthly (1st–15th, 16th–end). Returns { from, to }.
function payPeriodDates(now = new Date()) {
  const pp = cfg().pay_period || {};
  const type = pp.type || 'weekly';
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (type === 'bimonthly') {
    if (today.getDate() <= 15) return { from: new Date(today.getFullYear(), today.getMonth(), 1), to: new Date(today.getFullYear(), today.getMonth(), 15, 23,59,59) };
    return { from: new Date(today.getFullYear(), today.getMonth(), 16), to: new Date(today.getFullYear(), today.getMonth()+1, 0, 23,59,59) };
  }
  const len = type === 'biweekly' ? 14 : 7, msDay = 86400000;
  const anchor = pp.startDate ? new Date(pp.startDate + 'T00:00:00') : today;
  const mod = (((Math.floor((today - anchor) / msDay)) % len) + len) % len;
  const from = new Date(today.getTime() - mod * msDay); from.setHours(0,0,0,0);
  const to = new Date(from.getTime() + (len-1) * msDay); to.setHours(23,59,59,999);
  return { from, to };
}
function getReportDates() {
  const now = new Date(), T = reportRange.type;
  if (T === 'today') return { from: _sod(now), to: _eod(now) };
  if (T === 'yesterday') { const y = _addDays(now, -1); return { from: _sod(y), to: _eod(y) }; }
  if (T === 'day') { const d = reportRange.date ? new Date(reportRange.date + 'T12:00:00') : now; return { from: _sod(d), to: _eod(d) }; }
  if (T === 'week' || T === 'lastweek') { const dow = now.getDay() === 0 ? 6 : now.getDay() - 1; let from = _addDays(_sod(now), -dow); if (T === 'lastweek') from = _addDays(from, -7); return { from, to: _eod(_addDays(from, 6)) }; }
  if (T === 'payperiod') return payPeriodDates(now);
  if (T === 'month') return { from: new Date(now.getFullYear(),now.getMonth(),1), to: _eod(new Date(now.getFullYear(),now.getMonth()+1,0)) };
  if (T === 'lastmonth') return { from: new Date(now.getFullYear(),now.getMonth()-1,1), to: _eod(new Date(now.getFullYear(),now.getMonth(),0)) };
  if (T === 'thisyear') return { from: new Date(now.getFullYear(),0,1), to: _eod(new Date(now.getFullYear(),11,31)) };
  if (T === 'lastyear') return { from: new Date(now.getFullYear()-1,0,1), to: _eod(new Date(now.getFullYear()-1,11,31)) };
  const f = reportRange.from || document.getElementById('report-from')?.value || document.getElementById('txn-from')?.value;
  const t = reportRange.to   || document.getElementById('report-to')?.value || document.getElementById('txn-to')?.value;
  if (!f || !t) return null;
  return { from: new Date(f+'T00:00:00'), to: new Date(t+'T23:59:59') };
}
// Comparison window for the delta badges — the natural period preceding the current
// selection (prior calendar month/year/pay-period, else a same-length window), or the
// same dates one year back.
function getCompareDates() {
  if (!reportRange.compare || reportRange.compare === 'none') return null;
  const cur = getReportDates(); if (!cur) return null;
  if (reportRange.compare === 'year') { const from = new Date(cur.from); from.setFullYear(from.getFullYear()-1); const to = new Date(cur.to); to.setFullYear(to.getFullYear()-1); return { from, to }; }
  const T = reportRange.type;
  if (T === 'month' || T === 'lastmonth') return { from: new Date(cur.from.getFullYear(), cur.from.getMonth()-1, 1), to: _eod(new Date(cur.from.getFullYear(), cur.from.getMonth(), 0)) };
  if (T === 'thisyear' || T === 'lastyear') return { from: new Date(cur.from.getFullYear()-1, 0, 1), to: _eod(new Date(cur.from.getFullYear()-1, 11, 31)) };
  if (T === 'payperiod') return prevPayPeriod({ from: cur.from });
  const days = Math.round((_sod(cur.to) - _sod(cur.from)) / 86400000) + 1;
  return { from: _sod(_addDays(cur.from, -days)), to: _eod(_addDays(cur.from, -1)) };
}

// ── Date picker popup ─────────────────────────────
let _dpDragging = false, _dpDragStart = null, _dpDragEnd = null, _dpGridWired = false;
// Anchor a popup's top-left to the bottom-left of the button that opened it (clamped to
// the viewport), so it reads as a dropdown off the Date/compare bubble — not a centered modal.
function _anchorPanel(panelId, ev) {
  const panel = document.getElementById(panelId); if (!panel) return;
  panel.style.position = 'fixed';
  const pw = panel.offsetWidth, ph = panel.offsetHeight;
  const r = ev?.currentTarget?.getBoundingClientRect?.() || ev?.target?.getBoundingClientRect?.();
  let left = r ? r.left : (window.innerWidth - pw) / 2, top = r ? r.bottom + 6 : 80;
  left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
  top  = Math.max(8, Math.min(top,  window.innerHeight - ph - 8));
  panel.style.left = left + 'px'; panel.style.top = top + 'px';
}
export function openDatePicker(ev) {
  const cur = getReportDates();
  _dpMonth = _sod(reportRange.type === 'day' && reportRange.date ? new Date(reportRange.date + 'T12:00:00') : (cur?.from || new Date()));
  const m = document.getElementById('date-picker-modal'); if (m) m.classList.remove('hidden');
  renderDatePicker(); _wireDatePickerGrid(); _anchorPanel('date-picker-panel', ev);
}
export function closeDatePicker() { _dpDragging = false; const m = document.getElementById('date-picker-modal'); if (m) m.classList.add('hidden'); }
export function datePickerNavMonth(delta) { _dpMonth = new Date(_dpMonth.getFullYear(), _dpMonth.getMonth() + delta, 1); renderDatePicker(); }
function renderDatePicker() {
  const presetWrap = document.getElementById('date-picker-presets');
  if (presetWrap) presetWrap.innerHTML = RANGE_PRESETS.map(([k,l]) => `<button onclick="setReportRange('${k}')" class="dp-preset${reportRange.type===k?' active':''}">${l}</button>`).join('');
  const monthLbl = document.getElementById('date-picker-month');
  if (monthLbl) monthLbl.textContent = _dpMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const grid = document.getElementById('date-picker-grid');
  if (grid) {
    const y = _dpMonth.getFullYear(), m = _dpMonth.getMonth();
    const startDow = new Date(y, m, 1).getDay(), daysIn = new Date(y, m+1, 0).getDate();
    const today = localDateStr(new Date());
    const selDay = reportRange.type === 'day' ? reportRange.date : null;
    const rLo = reportRange.type === 'custom' ? reportRange.from : null, rHi = reportRange.type === 'custom' ? reportRange.to : null;
    let cells = ['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => `<div class="dp-dow">${d}</div>`).join('');
    for (let i = 0; i < startDow; i++) cells += '<div></div>';
    for (let d = 1; d <= daysIn; d++) {
      const ds = localDateStr(new Date(y, m, d));
      const inRange = rLo && rHi && ds >= rLo && ds <= rHi;
      cells += `<button data-date="${ds}" class="dp-day${ds===today?' today':''}${ds===selDay?' sel':''}${inRange?' dp-range':''}">${d}</button>`;
    }
    grid.innerHTML = cells;
  }
  document.getElementById('date-picker-custom')?.classList.toggle('hidden', reportRange.type !== 'custom');
  if (reportRange.type === 'custom') {
    const f = document.getElementById('dp-from'), t = document.getElementById('dp-to');
    if (f && reportRange.from) f.value = reportRange.from;
    if (t && reportRange.to) t.value = reportRange.to;
  }
}
// Drag across days = a custom range (always switches to Custom); a plain tap = single day.
// Pointer events cover both mouse and iPad touch; elementFromPoint tracks the day under the finger.
function _dpCellDate(el) { return el?.closest?.('.dp-day')?.dataset?.date || null; }
function _dpPaintRange() {
  const grid = document.getElementById('date-picker-grid'); if (!grid) return;
  const a = _dpDragStart, b = _dpDragEnd, lo = (a && b) ? (a < b ? a : b) : null, hi = (a && b) ? (a < b ? b : a) : null;
  grid.querySelectorAll('.dp-day').forEach(c => c.classList.toggle('dp-range', !!(lo && c.dataset.date >= lo && c.dataset.date <= hi)));
}
function _dpFinishDrag() {
  if (!_dpDragging) return; _dpDragging = false;
  const a = _dpDragStart, b = _dpDragEnd; if (!a || !b) return;
  if (a === b) { selectRangeDay(a); return; }
  const from = a < b ? a : b, to = a < b ? b : a;
  reportRange.type = 'custom'; reportRange.from = from; reportRange.to = to;
  syncRangeButtons(); closeDatePicker(); runReport(); renderTransactions(); updateDateButtons();
}
function _wireDatePickerGrid() {
  if (_dpGridWired) return;
  const grid = document.getElementById('date-picker-grid'); if (!grid) return;
  _dpGridWired = true;
  grid.addEventListener('pointerdown', e => { const d = _dpCellDate(e.target); if (!d) return; e.preventDefault(); _dpDragging = true; _dpDragStart = _dpDragEnd = d; _dpPaintRange(); });
  grid.addEventListener('pointermove', e => { if (!_dpDragging) return; const d = _dpCellDate(document.elementFromPoint(e.clientX, e.clientY)); if (d) { _dpDragEnd = d; _dpPaintRange(); } });
  grid.addEventListener('pointercancel', () => { _dpDragging = false; });
  window.addEventListener('pointerup', _dpFinishDrag);
}

// ── Comparison menu ───────────────────────────────
export function openCompareMenu(ev) {
  const wrap = document.getElementById('compare-menu-list');
  if (wrap) wrap.innerHTML = COMPARE_OPTS.map(([k,l]) => `<button onclick="setReportCompare('${k}')" class="cmp-opt${reportRange.compare===k?' active':''}">${l}</button>`).join('');
  const m = document.getElementById('compare-menu'); if (m) m.classList.remove('hidden');
  _anchorPanel('compare-panel', ev);
}
export function closeCompareMenu() { const m = document.getElementById('compare-menu'); if (m) m.classList.add('hidden'); }

// ── Generic single-day picker (Turns & Queue history) ──────────────────────
// A one-day calendar styled like the Reports date popup. The trigger passes the
// current value + an onPick callback (e.g. loadTurnsHistory / loadQueueHistory).
let _dayPickMonth = null, _dayPickSel = null, _dayPickCb = null;
export function openDayPicker(ev, opts = {}) {
  _dayPickCb = typeof opts.onPick === 'function' ? opts.onPick : null;
  _dayPickSel = /^\d{4}-\d{2}-\d{2}$/.test(opts.value || '') ? opts.value : null;
  const base = _dayPickSel ? new Date(_dayPickSel + 'T12:00:00') : new Date();
  _dayPickMonth = new Date(base.getFullYear(), base.getMonth(), 1);
  // Optional left rail of quick presets (e.g. Calendar's Today / In 1–6 weeks).
  const rail = document.getElementById('day-picker-presets');
  const hasPresets = Array.isArray(opts.presets) && opts.presets.length > 0;
  if (rail) {
    rail.classList.toggle('hidden', !hasPresets);
    rail.innerHTML = hasPresets ? opts.presets.map(p => `<button onclick="dayPickerPick('${p.date}')" class="dp-preset${p.date === _dayPickSel ? ' active' : ''}">${p.label}</button>`).join('') : '';
  }
  const panel = document.getElementById('day-picker-panel');
  if (panel) panel.style.width = `min(${hasPresets ? 480 : 360}px, calc(100vw - 16px))`;
  const m = document.getElementById('day-picker-modal'); if (m) m.classList.remove('hidden');
  renderDayPicker(); _anchorPanel('day-picker-panel', ev);
}
export function closeDayPicker() { const m = document.getElementById('day-picker-modal'); if (m) m.classList.add('hidden'); }
export function dayPickerNavMonth(delta) { _dayPickMonth = new Date(_dayPickMonth.getFullYear(), _dayPickMonth.getMonth() + delta, 1); renderDayPicker(); }
export function dayPickerPick(ds) { closeDayPicker(); if (_dayPickCb) _dayPickCb(ds); }
function renderDayPicker() {
  const lbl = document.getElementById('day-picker-month');
  if (lbl) lbl.textContent = _dayPickMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const grid = document.getElementById('day-picker-grid'); if (!grid) return;
  const y = _dayPickMonth.getFullYear(), m = _dayPickMonth.getMonth();
  const startDow = new Date(y, m, 1).getDay(), daysIn = new Date(y, m + 1, 0).getDate();
  const today = localDateStr(new Date());
  let cells = ['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => `<div class="dp-dow">${d}</div>`).join('');
  for (let i = 0; i < startDow; i++) cells += '<div></div>';
  for (let d = 1; d <= daysIn; d++) {
    const ds = localDateStr(new Date(y, m, d));
    cells += `<button onclick="dayPickerPick('${ds}')" class="dp-day${ds === today ? ' today' : ''}${ds === _dayPickSel ? ' sel' : ''}">${d}</button>`;
  }
  grid.innerHTML = cells;
}

function updateDateButtons() {
  const lbl = rangeLabel(), cmp = compareLabel();
  document.querySelectorAll('.date-btn-label').forEach(el => el.textContent = lbl);
  document.querySelectorAll('.compare-btn-label').forEach(el => el.textContent = cmp);
  const rl = document.getElementById('report-range-label'); if (rl) rl.textContent = `Showing: ${rangeLabel()}${reportRange.compare !== 'none' ? ` · vs ${cmp}` : ''}`;
}

export function runReport() {
  const dates = getReportDates();
  if (!dates) return;
  const { from, to } = dates;
  const filtered = buildCombinedRecords().filter(r => {
    if (r.status === 'deleted') return false;
    const d = new Date(r.checkinTime);
    return d >= from && d <= to && (isPaidStatus(r.status) || r.status === 'refund');
  });

  const svcTotal = filtered.reduce((s,r)=>s+(r.assignments||[]).reduce((a,x)=>a+(x.cost||0),0),0);
  const itemsTotal = filtered.reduce((s,r)=>s+(r.items||[]).reduce((a,x)=>a+(x.price||0)*(x.qty||0),0),0);
  const feesTotal = filtered.reduce((s,r)=>s+(r.fees||[]).reduce((a,x)=>a+(x.amount||0),0),0);
  const discountTotal = filtered.reduce((s,r)=>s+(r.discount||0),0);
  const totalIncome = filtered.reduce((s,r)=>s+(r.totalCost||0),0);
  const guestCount = filtered.filter(r => isPaidStatus(r.status)).length;
  const avgTicket = guestCount > 0 ? totalIncome / guestCount : 0;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('rpt-total-income', `$${totalIncome.toFixed(2)}`); set('rpt-total-guests', guestCount); set('rpt-avg-ticket', `$${avgTicket.toFixed(2)}`);
  set('rpt-svc-total', `$${svcTotal.toFixed(2)}`); set('rpt-items-total', `$${itemsTotal.toFixed(2)}`); set('rpt-fees-total', `$${feesTotal.toFixed(2)}`);
  set('rpt-discount-total', discountTotal > 0 ? `-$${discountTotal.toFixed(2)}` : '-$0.00');
  const refundsTotal = filtered.filter(r => r.status === 'refund').reduce((s,r)=>s+(r.totalCost||0),0);
  document.getElementById('rpt-refunds-row')?.classList.toggle('hidden', refundsTotal === 0);
  if (refundsTotal !== 0) set('rpt-refunds-total', `-$${Math.abs(refundsTotal).toFixed(2)}`);

  const fmt = d => d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
  set('report-range-label', `Showing: ${fmt(from)}${reportRange.type !== 'today' ? ' – ' + fmt(to) : ''}`);

  // Per-staff
  const staffMap = {};
  filtered.forEach(r => (r.assignments||[]).forEach(a => {
    if (!a.techId) return;
    if (!staffMap[a.techId]) staffMap[a.techId] = { income:0, count:0, fullTurns:0, halfTurns:0, bonusTurns:0 };
    const m = staffMap[a.techId]; m.income += a.cost||0; m.count++;
    const t = classifyTurn(a.cost||0, a.serviceId||''); if (t==='full') m.fullTurns++; else if (t==='half') m.halfTurns += 0.5; else m.bonusTurns++;
  }));
  // Refund records carry no assignments, so by default they don't touch per-tech
  // commission (the salon absorbs them). When opted in, subtract the refunded billed.
  if (cfg().commission_includes_refunds) {
    filtered.filter(r => r.status === 'refund').forEach(r => (r.refundTechBilled||[]).forEach(x => {
      if (!x.techId) return;
      if (!staffMap[x.techId]) staffMap[x.techId] = { income:0, count:0, fullTurns:0, halfTurns:0, bonusTurns:0 };
      staffMap[x.techId].income += x.billed || 0;
    }));
  }
  const turnsOrder = cfg().turns_order || [];
  const staffEntries = Object.entries(staffMap).sort((a,b)=>{
    const ra = turnsOrder.indexOf(a[0]) === -1 ? Infinity : turnsOrder.indexOf(a[0]);
    const rb = turnsOrder.indexOf(b[0]) === -1 ? Infinity : turnsOrder.indexOf(b[0]);
    if (ra !== rb) return ra - rb;            // rotation order; non-rotation techs last
    return b[1].income - a[1].income;          // both off-rotation → by income
  });
  const totalComm = staffEntries.reduce((sum,[id,d])=>{ const t = staffById(id); return t?.commission != null ? sum + d.income*t.commission/100 : sum; }, 0);
  set('rpt-shop-keeps', `$${(totalIncome-totalComm).toFixed(2)}`); set('rpt-total-commission', `$${totalComm.toFixed(2)}`);

  const staffBreakdown = document.getElementById('rpt-staff-breakdown');
  if (staffBreakdown) {
    staffBreakdown.innerHTML = staffEntries.length === 0 ? '<p class="text-sm font-body text-on-surface-variant py-2">No assigned services in this period.</p>'
      : `<div class="bg-primary/10 rounded-xl px-5 py-3 border border-primary/30 flex items-center justify-between mb-3"><div><div class="text-xs font-body font-semibold text-on-surface uppercase tracking-widest">Total Commission Owed</div><div class="text-xs font-body text-on-surface-variant mt-0.5">${staffEntries.filter(([id])=>staffById(id)?.commission!=null).length} staff with commission set</div></div><div class="font-headline font-bold text-primary text-xl">$${totalComm.toFixed(2)}</div></div>`
      + staffEntries.map(([techId,data])=>{
        const tech = staffById(techId), name = tech?.name || 'Unknown';
        const commPct = tech?.commission != null ? tech.commission : null;
        const commAmt = commPct != null ? data.income*commPct/100 : null;
        const totalTurns = data.fullTurns + data.halfTurns;
        const avatar = tech?.photo ? `<img src="${tech.photo}" class="w-10 h-10 rounded-full object-cover flex-shrink-0">` : `<div class="w-10 h-10 rounded-full bg-surface-container-high flex items-center justify-center flex-shrink-0"><span class="text-sm font-headline font-bold text-on-surface">${name.charAt(0)}</span></div>`;
        // Billed / Commission / Salon Keeps sit inline on the right of the staff info (one
        // compact row) instead of a separate full-width band below it.
        const metric = (label, val, color, bg) => `<div class="text-center flex-shrink-0 flex flex-col justify-center px-1" style="width:118px${bg?`;background:${bg}`:''}"><div class="text-[10px] font-body text-on-surface-variant uppercase tracking-wide leading-tight whitespace-nowrap">${label}</div><div class="font-headline font-bold text-base leading-tight ${color||'text-on-surface'}">${val}</div></div>`;
        return `<div class="bg-surface-container-lowest rounded-xl border border-surface-container-high hover:bg-surface-container transition-colors cursor-pointer overflow-hidden" onclick="drillDownStaff('${techId}')">
          <div class="flex items-stretch gap-3 px-4 py-3"><div class="flex items-center gap-3 flex-grow min-w-0">${avatar}<div class="min-w-0"><div class="font-headline font-semibold text-on-surface text-sm">${name}</div>
            <div class="text-xs font-body text-on-surface-variant flex gap-3 mt-0.5 flex-wrap"><span>${data.count} service${data.count!==1?'s':''}</span><span class="text-primary font-semibold">${totalTurns}t</span>${data.bonusTurns>0?`<span class="text-secondary">+${data.bonusTurns}b</span>`:''}${commPct!=null?`<span>${commPct}% commission</span>`:'<span class="text-outline italic">no commission set</span>'}</div></div></div>
            <div class="flex items-stretch flex-shrink-0 text-center divide-x divide-surface-container-high border-l border-surface-container-high">
              ${metric('Billed', '$'+data.income.toFixed(2))}
              ${commAmt!=null?metric(`Commission (${commPct}%)`, '$'+commAmt.toFixed(2), 'text-primary', 'rgba(26,82,82,0.06)')+metric('Salon Keeps', '$'+(data.income-commAmt).toFixed(2)):''}
            </div>
            <span class="material-symbols-outlined text-on-surface-variant flex-shrink-0 self-center" style="font-size:18px">chevron_right</span></div>
        </div>`;
      }).join('');
  }

  // Per-service
  const svcMap = {};
  filtered.forEach(r => {
    if (r.status === 'refund') return;   // a refund has no assignments; without this it would fall into the count-only branch below and inflate a service's "times" by 1 (no $ impact, but wrong count)
    (r.assignments||[]).forEach(a => { if (!a.serviceId) return; if (!svcMap[a.serviceId]) svcMap[a.serviceId] = { income:0, count:0 }; svcMap[a.serviceId].income += a.cost||0; svcMap[a.serviceId].count++; });
    if (!r.assignments || r.assignments.length === 0) r.services.forEach(sid => { if (!svcMap[sid]) svcMap[sid] = { income:0, count:0 }; svcMap[sid].count++; });
  });
  const svcBreakdown = document.getElementById('rpt-services-breakdown');
  if (svcBreakdown) {
    const entries = Object.entries(svcMap).sort((a,b)=>b[1].income-a[1].income);
    svcBreakdown.innerHTML = entries.length === 0 ? '<p class="text-sm font-body text-on-surface-variant py-2">No services in this period.</p>'
      : entries.map(([sid,data])=>{ const s = svc(sid); return `<div class="bg-surface-container-lowest rounded-xl px-5 py-3 border border-surface-container-high flex items-center justify-between cursor-pointer hover:bg-surface-container transition-colors" onclick="drillDownService('${sid}')"><div class="flex items-center gap-3"><div class="w-9 h-9 rounded-lg bg-primary flex items-center justify-center"><span class="text-xs font-headline font-bold text-on-primary">${s?.abbr||'?'}</span></div><div><div class="font-headline font-semibold text-on-surface text-sm">${s?.label||sid}</div><div class="text-xs font-body text-on-surface-variant">${data.count} time${data.count!==1?'s':''} · tap for details</div></div></div><div class="flex items-center gap-3"><div class="font-headline font-bold text-on-surface">$${data.income.toFixed(2)}</div><span class="material-symbols-outlined text-on-surface-variant" style="font-size:18px">chevron_right</span></div></div>`; }).join('');
  }

  // Per-fee + per-item
  const feeMap = {};
  filtered.forEach(r => (r.fees||[]).forEach(f => { if (!f.feeId) return; if (!feeMap[f.feeId]) feeMap[f.feeId] = { total:0, count:0 }; feeMap[f.feeId].total += f.amount||0; feeMap[f.feeId].count++; }));
  const feesBreakdown = document.getElementById('rpt-fees-breakdown');
  if (feesBreakdown) {
    const entries = Object.entries(feeMap).sort((a,b)=>b[1].total-a[1].total);
    feesBreakdown.innerHTML = entries.length === 0 ? '<p class="text-sm font-body text-on-surface-variant py-2">No fees charged in this period.</p>'
      : entries.map(([feeId,data])=>{ const fee = cfg().fees.find(f=>f.id===feeId); return `<div class="bg-surface-container-lowest rounded-xl px-5 py-3 border border-surface-container-high flex items-center justify-between cursor-pointer hover:bg-surface-container transition-colors" onclick="drillDownFee('${feeId}')"><div class="flex items-center gap-3"><div class="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style="background:rgba(26,82,82,0.10)"><span class="material-symbols-outlined" style="font-size:16px;color:#1a5252">receipt</span></div><div><div class="font-headline font-semibold text-on-surface text-sm">${fee?.label||feeId}</div><div class="text-xs font-body text-on-surface-variant">${data.count} time${data.count!==1?'s':''} charged · tap for details</div></div></div><div class="flex items-center gap-3"><div class="font-headline font-bold text-on-surface">$${data.total.toFixed(2)}</div><span class="material-symbols-outlined text-on-surface-variant" style="font-size:18px">chevron_right</span></div></div>`; }).join('');
  }
  const itemMap = {};
  filtered.forEach(r => (r.items||[]).forEach(x => { if (!x.itemId || !x.qty || x.qty <= 0) return; if (!itemMap[x.itemId]) itemMap[x.itemId] = { revenue:0, qty:0 }; itemMap[x.itemId].revenue += (x.price||0)*(x.qty||0); itemMap[x.itemId].qty += x.qty||0; }));
  const itemBreakdown = document.getElementById('rpt-items-breakdown');
  if (itemBreakdown) {
    const entries = Object.entries(itemMap).sort((a,b)=>b[1].revenue-a[1].revenue);
    itemBreakdown.innerHTML = entries.length === 0 ? '<p class="text-sm font-body text-on-surface-variant py-2">No retail items sold in this period.</p>'
      : entries.map(([itemId,data])=>{ const item = cfg().items.find(i=>i.id===itemId); return `<div class="bg-surface-container-lowest rounded-xl px-5 py-3 border border-surface-container-high flex items-center justify-between"><div class="flex items-center gap-3"><div class="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style="background:rgba(92,64,16,0.12)"><span class="text-xs font-headline font-bold" style="color:#5c4010">${item?.abbr||'?'}</span></div><div><div class="font-headline font-semibold text-on-surface text-sm">${item?.label||itemId}</div><div class="text-xs font-body text-on-surface-variant">${data.qty} unit${data.qty!==1?'s':''} sold</div></div></div><div class="font-headline font-bold text-on-surface">$${data.revenue.toFixed(2)}</div></div>`; }).join('');
  }

  // Gift cards — own subtotals, NOT folded into service income (a sale is a
  // liability until redeemed; counting both the sale and the later redemption
  // against a service would double-count). Sold/redeemed scoped to the period
  // by datePurchased / dateUsed; outstanding balance is point-in-time (all cards).
  const inPeriod = ds => ds && ds >= localDateStr(from) && ds <= localDateStr(to);
  const gcSold = giftCards().filter(g => inPeriod(g.datePurchased));
  const gcSoldValue = gcSold.reduce((s,g)=>s+(g.amount||0),0);
  const gcRedeemed = giftCards().reduce((s,g)=> s + gcRedemptions(g).reduce((a,r)=> a + (inPeriod(r.date) ? (r.amount||0) : 0), 0), 0);
  const gcOutstanding = giftCards().reduce((s,g)=>s+((g.amount||0)-(g.amountUsed||0)),0);
  // Gross income = true new cash collected: billed work + new gift-card cash, minus
  // redemptions (those tickets are already in totalBilled but were paid from cards
  // sold earlier, so the redeemed portion isn't new cash this period).
  const grossIncome = totalIncome + gcSoldValue - gcRedeemed;
  set('rpt-gross-income', `$${grossIncome.toFixed(2)}`);
  set('rpt-gc-sold', `$${gcSoldValue.toFixed(2)}`);
  set('rpt-gc-redeemed', `$${gcRedeemed.toFixed(2)}`);
  const gcBreakdown = document.getElementById('rpt-giftcards-breakdown');
  if (gcBreakdown) {
    const row = (label, value, sub, onclick) => `<div class="bg-surface-container-lowest rounded-xl px-5 py-3 border border-surface-container-high flex items-center justify-between${onclick?' cursor-pointer hover:bg-surface-container transition-colors':''}"${onclick?` onclick="${onclick}"`:''}><div><div class="font-headline font-semibold text-on-surface text-sm">${label}</div><div class="text-xs font-body text-on-surface-variant">${sub}</div></div><div class="flex items-center gap-3"><div class="font-headline font-bold text-on-surface">${value}</div>${onclick?'<span class="material-symbols-outlined text-on-surface-variant" style="font-size:18px">chevron_right</span>':''}</div></div>`;
    gcBreakdown.innerHTML =
      row('Gift Cards Sold', `$${gcSoldValue.toFixed(2)}`, `${gcSold.length} card${gcSold.length!==1?'s':''} sold this period · tap for details`, "drillDownGiftcards('sold')") +
      row('Redeemed', `$${gcRedeemed.toFixed(2)}`, 'Used this period · tap for details', "drillDownGiftcards('redeemed')") +
      row('Outstanding Balance', `$${gcOutstanding.toFixed(2)}`, 'Unredeemed value across all gift cards');
  }

  renderDeltas({ totalIncome, grossIncome, guestCount, avgTicket, shopKeeps: totalIncome - totalComm, commission: totalComm, svcTotal, itemsTotal, feesTotal, discountTotal, gcSold: gcSoldValue, gcRedeemed });
  renderPerformance(filtered);
  updateDateButtons();
  window._currentReportData = { filtered, from, to, totalIncome, guestCount, avgTicket, staffMap, svcMap, gcSoldValue, gcRedeemed, gcOutstanding };
}

// ── AI analytics: aggregate builder + ask/bridge ──────────────────────────
// Compact human-readable summary of the SELECTED range, used both for the in-app
// Gemini call and the "copy into your own AI tab" bridge. Aggregates only — no raw
// customer rows leave the device.
function buildAnalyticsSummary() {
  const dates = getReportDates(); if (!dates) return 'No date range selected.';
  const { from, to } = dates;
  const filtered = buildCombinedRecords().filter(r => { if (r.status === 'deleted') return false; const d = new Date(r.checkinTime); return d >= from && d <= to && (isPaidStatus(r.status) || r.status === 'refund'); });
  const paid = filtered.filter(r => isPaidStatus(r.status));
  const totalIncome = filtered.reduce((s, r) => s + (r.totalCost || 0), 0);
  const guests = paid.length, avg = guests ? totalIncome / guests : 0;
  const byHour = Array.from({ length: 24 }, () => ({ rev: 0, n: 0 })), byDow = Array.from({ length: 7 }, () => ({ rev: 0, n: 0 })), byDay = {}, bySvc = {};
  paid.forEach(r => {
    const d = new Date(r.checkinTime), rev = r.totalCost || 0;
    byHour[d.getHours()].rev += rev; byHour[d.getHours()].n++;
    byDow[d.getDay()].rev += rev; byDow[d.getDay()].n++;
    byDay[localDateStr(d)] = (byDay[localDateStr(d)] || 0) + rev;
    (r.assignments || []).forEach(a => { const name = svc(a.serviceId)?.label || 'Service'; (bySvc[name] = bySvc[name] || { rev: 0, n: 0 }); bySvc[name].rev += a.cost || 0; bySvc[name].n++; });
  });
  const L = [];
  L.push(`TurnDesk — ${rangeLabel()}`);
  L.push(`Totals: revenue $${totalIncome.toFixed(2)}, guests ${guests}, avg ticket $${avg.toFixed(2)}`);
  L.push(`By hour (rev/guests): ${byHour.map((b, i) => b.n ? `${_fmtHour(i)} $${b.rev.toFixed(0)}/${b.n}` : null).filter(Boolean).join(', ') || 'none'}`);
  L.push(`By weekday (rev/guests): ${byDow.map((b, i) => b.n ? `${_DOW[i].slice(0, 3)} $${b.rev.toFixed(0)}/${b.n}` : null).filter(Boolean).join(', ') || 'none'}`);
  L.push(`Top services (rev/count): ${Object.entries(bySvc).sort((a, b) => b[1].rev - a[1].rev).slice(0, 12).map(([k, v]) => `${k} $${v.rev.toFixed(0)}/${v.n}`).join(', ') || 'none'}`);
  if (Object.keys(byDay).length > 1) L.push(`Revenue by day: ${Object.entries(byDay).sort((a, b) => a[0] < b[0] ? -1 : 1).map(([k, v]) => `${k} $${v.toFixed(0)}`).join(', ')}`);
  return L.join('\n');
}
export async function aiAsk() {
  const q = document.getElementById('ai-q')?.value?.trim();
  const out = document.getElementById('ai-answer');
  if (!q) { showToast('Type a question first.'); return; }
  if (out) { out.classList.remove('hidden'); out.textContent = 'Thinking…'; }
  try {
    const res = await fetch(`${AI_PROXY}/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q, data: buildAnalyticsSummary() }) });
    const j = await res.json().catch(() => ({}));
    if (!out) return;
    if (res.ok) out.textContent = j.answer || 'No answer.';
    else if (res.status === 503 || j.error === 'AI not configured') out.textContent = 'In-app AI isn’t set up yet. Add a Gemini API key to the Worker (Settings → Worker), or use “Copy for my AI tab” below.';
    else out.textContent = 'Error: ' + (j.error || res.status);
  } catch (e) { if (out) out.textContent = 'Could not reach the AI service.'; }
}
export function aiCopyForBridge() {
  const q = document.getElementById('ai-q')?.value?.trim() || '(type your question here)';
  const text = `Here is my salon's data for ${rangeLabel()}.\n\n${buildAnalyticsSummary()}\n\nQuestion: ${q}`;
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => showToast('Copied — paste into your Claude/ChatGPT tab'), () => showToast('Copy failed'));
  else showToast('Clipboard not available');
}
export function aiOpenClaude() { window.open('https://claude.ai/new', '_blank'); }

// ── Comparison metrics + delta badges ─────────────
// Scalar metrics for an arbitrary window, mirroring runReport's definitions exactly so
// the comparison side lines up with the displayed cards. Used only for the prior period.
function computeMetrics(from, to) {
  const filtered = buildCombinedRecords().filter(r => { if (r.status === 'deleted') return false; const d = new Date(r.checkinTime); return d >= from && d <= to && (isPaidStatus(r.status) || r.status === 'refund'); });
  const sum = (arr, f) => arr.reduce((s,x)=>s+f(x),0);
  const svcTotal = sum(filtered, r => sum(r.assignments||[], x => x.cost||0));
  const itemsTotal = sum(filtered, r => sum(r.items||[], x => (x.price||0)*(x.qty||0)));
  const feesTotal = sum(filtered, r => sum(r.fees||[], x => x.amount||0));
  const discountTotal = sum(filtered, r => r.discount||0);
  const totalIncome = sum(filtered, r => r.totalCost||0);
  const guestCount = filtered.filter(r => isPaidStatus(r.status)).length;
  const avgTicket = guestCount > 0 ? totalIncome / guestCount : 0;
  const staffInc = {};
  filtered.forEach(r => (r.assignments||[]).forEach(a => { if (a.techId) staffInc[a.techId] = (staffInc[a.techId]||0) + (a.cost||0); }));
  if (cfg().commission_includes_refunds) filtered.filter(r=>r.status==='refund').forEach(r => (r.refundTechBilled||[]).forEach(x => { if (x.techId) staffInc[x.techId] = (staffInc[x.techId]||0) + (x.billed||0); }));
  const commission = Object.entries(staffInc).reduce((s,[id,inc])=>{ const t = staffById(id); return t?.commission != null ? s + inc*t.commission/100 : s; }, 0);
  const inPeriod = ds => ds && ds >= localDateStr(from) && ds <= localDateStr(to);
  const gcSold = giftCards().filter(g => inPeriod(g.datePurchased)).reduce((s,g)=>s+(g.amount||0),0);
  const gcRedeemed = giftCards().reduce((s,g)=> s + gcRedemptions(g).reduce((a,r)=> a + (inPeriod(r.date) ? (r.amount||0) : 0), 0), 0);
  return { totalIncome, grossIncome: totalIncome + gcSold - gcRedeemed, guestCount, avgTicket, shopKeeps: totalIncome - commission, commission, svcTotal, itemsTotal, feesTotal, discountTotal, gcSold, gcRedeemed };
}
const _DELTA_CARDS = [
  ['rpt-gross-income-delta','grossIncome'], ['rpt-total-income-delta','totalIncome'], ['rpt-total-guests-delta','guestCount'], ['rpt-avg-ticket-delta','avgTicket'],
  ['rpt-shop-keeps-delta','shopKeeps'], ['rpt-total-commission-delta','commission'],
  ['rpt-svc-total-delta','svcTotal'], ['rpt-items-total-delta','itemsTotal'], ['rpt-fees-total-delta','feesTotal'],
  ['rpt-discount-total-delta','discountTotal'], ['rpt-gc-sold-delta','gcSold'], ['rpt-gc-redeemed-delta','gcRedeemed'],
];
function setDelta(id, cur, prev) {
  const el = document.getElementById(id); if (!el) return;
  if (prev == null || prev === 0) { el.className = 'rpt-delta na'; el.textContent = '▲ N/A'; return; }
  const pct = (cur - prev) / Math.abs(prev) * 100, up = cur >= prev;
  el.className = `rpt-delta ${up ? 'up' : 'down'}`;
  el.textContent = `${up ? '▲' : '▼'} ${Math.abs(pct).toFixed(0)}%`;
}
function renderDeltas(cur) {
  const on = reportRange.compare && reportRange.compare !== 'none';
  if (!on) { _DELTA_CARDS.forEach(([id]) => { const el = document.getElementById(id); if (el) { el.textContent = ''; el.className = 'rpt-delta'; } }); return; }
  const cmp = getCompareDates(), prev = cmp ? computeMetrics(cmp.from, cmp.to) : null;
  _DELTA_CARDS.forEach(([id, key]) => setDelta(id, cur[key], prev ? prev[key] : null));
}

// ── Performance: by-hour graph + computed insights (no AI; pure stats) ─────
const _DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const _fmtHour = h => { const ap = h < 12 ? 'a' : 'p'; const hh = h % 12 === 0 ? 12 : h % 12; return `${hh}${ap}`; };
function renderPerformance(filtered) {
  const wrap = document.getElementById('rpt-perf'); if (!wrap) return;
  const byHour = Array.from({ length: 24 }, () => ({ rev: 0, n: 0 }));
  const byDow  = Array.from({ length: 7 },  () => ({ rev: 0, n: 0 }));
  filtered.forEach(r => {
    if (!isPaidStatus(r.status)) return;   // activity chart = completed sales only (refunds excluded)
    const d = new Date(r.checkinTime), rev = r.totalCost || 0;
    byHour[d.getHours()].rev += rev; byHour[d.getHours()].n++;
    byDow[d.getDay()].rev += rev; byDow[d.getDay()].n++;
  });
  const hoursWithData = byHour.map((b, i) => ({ i, ...b })).filter(b => b.n > 0);
  if (!hoursWithData.length) { wrap.innerHTML = '<p class="text-sm font-body text-on-surface-variant py-2">No sales in this period yet.</p>'; return; }
  const minH = Math.min(...hoursWithData.map(b => b.i)), maxH = Math.max(...hoursWithData.map(b => b.i));
  const maxRev = Math.max(...byHour.map(b => b.rev), 1);
  let bars = '';
  for (let h = minH; h <= maxH; h++) {
    const b = byHour[h], pct = Math.round(b.rev / maxRev * 100);
    bars += `<div class="perf-col" title="${_fmtHour(h)}: $${b.rev.toFixed(2)} · ${b.n} guest${b.n !== 1 ? 's' : ''}"><div class="perf-bar" style="height:${pct}%"></div><div class="perf-x">${_fmtHour(h)}</div></div>`;
  }
  const busiestHour = hoursWithData.reduce((a, b) => b.rev > a.rev ? b : a);
  const dowWithData = byDow.map((b, i) => ({ i, ...b })).filter(b => b.n > 0);
  const busiestDow = dowWithData.reduce((a, b) => b.rev > a.rev ? b : a, dowWithData[0]);
  const slowestDow = dowWithData.length > 1 ? dowWithData.reduce((a, b) => b.rev < a.rev ? b : a) : null;
  const card = (label, val) => `<div class="bg-surface-container-lowest rounded-xl px-4 py-2.5 border border-surface-container-high"><div class="text-[10px] font-body uppercase tracking-widest text-on-surface-variant">${label}</div><div class="text-sm font-headline font-bold text-on-surface mt-0.5">${val}</div></div>`;
  // Vertical (revenue) axis: max at top → $0 at the bar baseline.
  const yLab = v => v >= 1000 ? '$' + (v/1000).toFixed(1) + 'k' : '$' + Math.round(v);
  const yAxis = `<div class="perf-yaxis"><span>${yLab(maxRev)}</span><span>${yLab(maxRev/2)}</span><span>$0</span></div>`;
  wrap.innerHTML = `<div class="perf-plot">${yAxis}<div class="perf-chart">${bars}</div></div>
    <div class="grid grid-cols-3 gap-2 mt-4">
      ${card('Busiest time', `${_fmtHour(busiestHour.i)}–${_fmtHour((busiestHour.i + 1) % 24)}`)}
      ${busiestDow ? card('Busiest day', _DOW[busiestDow.i]) : ''}
      ${slowestDow ? card('Slowest day', _DOW[slowestDow.i]) : ''}
    </div>`;
}

// ── Drill-downs (popup modal + CSV/PDF export) ────
// _drill holds the structured rows for the open detail popup so Export CSV / PDF can
// rebuild the same data the modal shows.
let _drill = null;   // { title, columns:[], rows:[[...]], summary:[[label,val],...] }
export function drillDownStaff(techId) {
  const d = window._currentReportData; if (!d) return;
  const tech = staffById(techId), name = tech?.name || 'Unknown', commPct = tech?.commission != null ? tech.commission : null;
  const rows = [];
  d.filtered.forEach(r => (r.assignments||[]).forEach(a => { if (a.techId !== techId) return; rows.push({ customer: r.name, serviceId: a.serviceId, service: svc(a.serviceId)?.label || a.serviceId, cost: a.cost||0, comm: commPct!=null?(a.cost||0)*commPct/100:null, station: a.station||'', time: new Date(r.checkinTime), turnType: classifyTurn(a.cost||0, a.serviceId||''), durMs: a.serviceMs||0 }); }));
  const totalBilled = rows.reduce((s,r)=>s+r.cost,0);
  const totalComm = commPct != null ? totalBilled*commPct/100 : null;
  const totalTurns = rows.reduce((s,r)=>s+(r.turnType==='full'?1:r.turnType==='half'?0.5:0),0);
  const summary = `<div class="bg-primary/10 rounded-xl border border-primary/30 flex divide-x divide-primary/20 mb-4">
    <div class="flex-1 px-4 py-3 text-center"><div class="text-[10px] font-body text-on-surface-variant uppercase tracking-widest">Total Billed</div><div class="font-headline font-bold text-on-surface text-lg">$${totalBilled.toFixed(2)}</div></div>
    ${totalComm!=null?`<div class="flex-1 px-4 py-3 text-center"><div class="text-[10px] font-body text-on-surface-variant uppercase tracking-widest">Commission (${commPct}%)</div><div class="font-headline font-bold text-primary text-lg">$${totalComm.toFixed(2)}</div></div><div class="flex-1 px-4 py-3 text-center"><div class="text-[10px] font-body text-on-surface-variant uppercase tracking-widest">Salon Keeps</div><div class="font-headline font-bold text-on-surface text-lg">$${(totalBilled-totalComm).toFixed(2)}</div></div>`:''}
    <div class="flex-1 px-4 py-3 text-center"><div class="text-[10px] font-body text-on-surface-variant uppercase tracking-widest">Turns</div><div class="font-headline font-bold text-primary text-lg">${totalTurns}</div></div></div>`;
  // Average service time per service this tech performed (outlier-filtered, all-time
  // benchmark — the same number the live bubbles compare against). "—" until there
  // are enough clean samples.
  const avgBySvc = [...new Set(rows.map(r => r.serviceId).filter(Boolean))].map(sid => {
    const { avgMs, n } = avgServiceTime(techId, sid);
    return { label: svc(sid)?.label || sid, avgMs, n };
  });
  const resetTs = (cfg().svc_time_reset || {})[techId] || 0;
  const sinceNote = resetTs ? `<span class="text-[10px] font-body text-outline normal-case tracking-normal ml-1">since ${new Date(resetTs).toLocaleDateString()}</span>` : '';
  const avgBlock = avgBySvc.length ? `<div class="mb-4">
    <div class="flex items-center justify-between mb-1.5">
      <div class="text-[11px] font-body text-on-surface-variant uppercase tracking-widest">Avg Service Time${sinceNote}</div>
      <button onclick="resetServiceTime('${techId}')" title="Reset this technician's service-time averages (starts fresh from today; does not touch any records)" class="flex items-center gap-1 text-[11px] font-body font-semibold text-error hover:opacity-80 transition-opacity"><span class="material-symbols-outlined" style="font-size:14px">restart_alt</span>Reset</button>
    </div>
    <div class="flex flex-wrap gap-1.5">${avgBySvc.map(x => `<span class="text-xs font-body bg-surface-container-lowest border border-surface-container-high rounded-lg px-2.5 py-1"><span class="text-on-surface font-semibold">${x.label}</span> · <span class="${x.avgMs!=null?'text-primary font-bold':'text-outline'}">${x.avgMs!=null?'~'+fmtDur(x.avgMs):'—'}</span>${x.avgMs!=null?`<span class="text-outline"> (${x.n})</span>`:''}</span>`).join('')}</div></div>` : '';
  const rowsHtml = rows.map(row => { const badge = row.turnType==='full'?'1t':row.turnType==='half'?'½t':'B'; const color = row.turnType==='bonus'?'#f5c870':'#1a5252'; return `<div class="bg-surface-container-lowest rounded-xl px-4 py-3 border border-surface-container-high flex items-center justify-between"><div class="min-w-0"><div class="flex items-center gap-2"><span class="font-headline font-semibold text-on-surface text-sm">${row.customer}</span><span class="text-[10px] px-1.5 py-0.5 rounded-full font-bold" style="background:${color}20;color:${color}">${badge}</span>${row.durMs?`<span class="text-[10px] font-body text-on-surface-variant">${fmtDur(row.durMs)}</span>`:''}</div><div class="text-xs font-body text-on-surface-variant">${row.service}${row.station?' · '+row.station:''}</div><div class="text-[11px] font-body text-outline">${row.time.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} · ${row.time.toLocaleDateString()}</div></div><div class="text-right flex-shrink-0 ml-3"><div class="font-headline font-bold text-on-surface">$${row.cost.toFixed(2)}</div>${row.comm!=null?`<div class="text-xs font-body text-primary">comm $${row.comm.toFixed(2)}</div>`:''}</div></div>`; }).join('');
  const turnTxt = t => t==='full'?'1 turn':t==='half'?'½ turn':'Bonus';
  _drill = {
    title: `${name} — Service Detail`,
    columns: ['Date','Time','Customer','Service','Station','Turn','Service Time','Cost', ...(commPct!=null?['Commission']:[])],
    rows: rows.map(r => [r.time.toLocaleDateString(), r.time.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}), r.customer, r.service, r.station, turnTxt(r.turnType), r.durMs?fmtDur(r.durMs):'', '$'+r.cost.toFixed(2), ...(commPct!=null?['$'+(r.comm||0).toFixed(2)]:[])]),
    summary: [['Total Billed','$'+totalBilled.toFixed(2)], ...(totalComm!=null?[[`Commission (${commPct}%)`,'$'+totalComm.toFixed(2)],['Salon Keeps','$'+(totalBilled-totalComm).toFixed(2)]]:[]), ['Turns', String(totalTurns)]],
  };
  showDrillPanel(_drill.title, summary + avgBlock + rowsHtml);
}
// Per-tech service-time reset: non-destructive — stamps a cutoff so avgServiceTime
// ignores visits before now; the benchmark rebuilds from new visits. No records change.
export function resetServiceTime(techId) {
  const name = staffById(techId)?.name || 'this technician';
  if (!confirm(`Reset ${name}'s service-time averages? They'll rebuild from new visits going forward. No transactions or records are deleted.`)) return;
  const map = { ...(cfg().svc_time_reset || {}) };
  map[techId] = Date.now();
  dispatch('config.set', { key: 'svc_time_reset', value: map });
  showToast('Service-time averages reset');
  drillDownStaff(techId);   // refresh the open drill-down
}
export function drillDownService(sid) {
  const d = window._currentReportData; if (!d) return;
  const s = svc(sid), rows = [];
  d.filtered.forEach(r => (r.assignments||[]).forEach(a => { if (a.serviceId !== sid) return; rows.push({ customer: r.name, tech: staffById(a.techId)?.name || '—', cost: a.cost||0, station: a.station||'', time: new Date(r.checkinTime) }); }));
  _drill = {
    title: `${s?.label||sid} — Detail`,
    columns: ['Date','Time','Customer','Technician','Station','Cost'],
    rows: rows.map(r => [r.time.toLocaleDateString(), r.time.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}), r.customer, r.tech, r.station, '$'+r.cost.toFixed(2)]),
    summary: [['Services', String(rows.length)], ['Total', '$'+rows.reduce((acc,r)=>acc+r.cost,0).toFixed(2)]],
  };
  showDrillPanel(_drill.title, rows.map(row => `<div class="bg-surface-container-lowest rounded-xl px-5 py-3 border border-surface-container-high flex items-center justify-between"><div><div class="font-headline font-semibold text-on-surface text-sm">${row.customer}</div><div class="text-xs font-body text-on-surface-variant">Tech: ${row.tech}${row.station?' · '+row.station:''}</div><div class="text-[11px] font-body text-outline">${row.time.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} · ${row.time.toLocaleDateString()}</div></div><div class="font-headline font-bold text-on-surface">$${row.cost.toFixed(2)}</div></div>`).join(''));
}
export function drillDownFee(feeId) {
  const d = window._currentReportData; if (!d) return;
  const fee = cfg().fees.find(f => f.id === feeId);
  const rows = [];
  d.filtered.forEach(r => (r.fees||[]).forEach(f => { if (f.feeId !== feeId) return; rows.push({ customer: r.name||'(no name)', time: new Date(r.checkinTime), amount: f.amount||0 }); }));
  const total = rows.reduce((s,r)=>s+r.amount,0);
  _drill = {
    title: `${fee?.label||'Fee'} — Detail`,
    columns: ['Date','Time','Customer','Amount'],
    rows: rows.map(r => [r.time.toLocaleDateString(), r.time.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}), r.customer, '$'+r.amount.toFixed(2)]),
    summary: [['Times charged', String(rows.length)], ['Total', '$'+total.toFixed(2)]],
  };
  showDrillPanel(_drill.title, rows.length
    ? rows.map(r => `<div class="bg-surface-container-lowest rounded-xl px-5 py-3 border border-surface-container-high flex items-center justify-between"><div><div class="font-headline font-semibold text-on-surface text-sm">${r.customer}</div><div class="text-[11px] font-body text-outline">${r.time.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} · ${r.time.toLocaleDateString()}</div></div><div class="font-headline font-bold text-on-surface">$${r.amount.toFixed(2)}</div></div>`).join('')
    : '');
}
export function drillDownGiftcards(kind) {
  const d = window._currentReportData; if (!d) return;
  const inPeriod = ds => ds && ds >= localDateStr(d.from) && ds <= localDateStr(d.to);
  const fmt = ds => ds ? new Date(ds + 'T12:00:00').toLocaleDateString() : '—';
  if (kind === 'redeemed') {
    // One row per redemption (a card used on several dates appears several times).
    const list = [];
    giftCards().forEach(g => gcRedemptions(g).forEach(r => { if (inPeriod(r.date)) list.push({ date: r.date, serial: g.serial, to: g.to, amount: r.amount || 0 }); }));
    const total = list.reduce((s, x) => s + x.amount, 0);
    _drill = {
      title: 'Gift Cards Redeemed — Detail',
      columns: ['Date','Serial','To','Amount'],
      rows: list.map(x => [x.date || '', x.serial || '', x.to || '', '$' + x.amount.toFixed(2)]),
      summary: [['Redemptions', String(list.length)], ['Redeemed', '$' + total.toFixed(2)]],
    };
    showDrillPanel(_drill.title, list.length
      ? list.map(x => `<div class="bg-surface-container-lowest rounded-xl px-5 py-3 border border-surface-container-high flex items-center justify-between"><div class="min-w-0"><div class="font-headline font-semibold text-on-surface text-sm truncate">${x.serial ? '#' + x.serial : '(no serial)'}${x.to ? ' · ' + x.to : ''}</div><div class="text-[11px] font-body text-outline">${fmt(x.date)}</div></div><div class="font-headline font-bold text-on-surface">$${x.amount.toFixed(2)}</div></div>`).join('')
      : '');
    return;
  }
  const cards = giftCards().filter(g => inPeriod(g.datePurchased));
  const total = cards.reduce((s, g) => s + (g.amount || 0), 0);
  _drill = {
    title: 'Gift Cards Sold — Detail',
    columns: ['Date','Serial','From','To','Amount'],
    rows: cards.map(g => [g.datePurchased || '', g.serial || '', g.from || '', g.to || '', '$' + (g.amount || 0).toFixed(2)]),
    summary: [['Cards', String(cards.length)], ['Sold', '$' + total.toFixed(2)]],
  };
  showDrillPanel(_drill.title, cards.length
    ? cards.map(g => `<div class="bg-surface-container-lowest rounded-xl px-5 py-3 border border-surface-container-high flex items-center justify-between"><div class="min-w-0"><div class="font-headline font-semibold text-on-surface text-sm truncate">${g.serial ? '#' + g.serial : '(no serial)'}${g.to ? ' · to ' + g.to : ''}</div><div class="text-[11px] font-body text-outline">${fmt(g.datePurchased)}${g.from ? ' · from ' + g.from : ''}</div></div><div class="font-headline font-bold text-on-surface">$${(g.amount || 0).toFixed(2)}</div></div>`).join('')
    : '');
}
function showDrillPanel(title, html) {
  document.getElementById('rpt-drill-title').textContent = title;
  document.getElementById('rpt-drill-list').innerHTML = html || '<p class="text-sm font-body text-on-surface-variant">No detail available.</p>';
  const m = document.getElementById('rpt-drill-modal'); if (m) { m.classList.remove('hidden'); m.style.display = 'flex'; }
}
export function closeDrillDown() { const m = document.getElementById('rpt-drill-modal'); if (m) { m.classList.add('hidden'); m.style.display = ''; } }
export function exportDrillCSV() {
  if (!_drill || !_drill.rows.length) { showToast('Nothing to export.'); return; }
  const matrix = [ [_drill.title.replace(/—/g,'-')], [`Showing: ${rangeLabel()}`], ..._drill.summary, [], _drill.columns, ..._drill.rows ];
  const csv = matrix.map(line => line.map(c => `"${String(c==null?'':c).replace(/"/g,'""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿'+csv], { type:'text/csv;charset=utf-8;' }));
  const a = document.createElement('a'); a.href = url; a.download = `turndesk-detail-${localDateStr(getReportDates()?.from||new Date())}.csv`; a.click(); URL.revokeObjectURL(url);
  showToast('Detail exported as CSV (opens in Excel)');
}
export function exportDrillPDF() {
  if (!_drill || !_drill.rows.length) { showToast('Nothing to export.'); return; }
  const url = URL.createObjectURL(new Blob([buildDrillHtml(_drill)], { type:'text/html' }));
  const win = window.open(url, '_blank'); if (win) setTimeout(() => win.print(), 600); URL.revokeObjectURL(url);
  showToast('PDF opened — use Print → Save as PDF');
}
function buildDrillHtml(d) {
  const logo = cfg().logo || LOGO_PATH;
  const th = d.columns.map(c => `<th>${_eTxn(c)}</th>`).join('');
  const tr = d.rows.map(r => `<tr>${r.map((c,i) => `<td${i===r.length-1?' style="text-align:right"':''}>${_eTxn(c)}</td>`).join('')}</tr>`).join('');
  const cards = d.summary.map(([l,v]) => `<div class="card"><div class="v">${_eTxn(v)}</div><div class="l">${_eTxn(l)}</div></div>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${_eTxn(d.title)}</title><style>
    body{font-family:Arial,sans-serif;font-size:11px;color:#222;margin:20px}.h{display:flex;align-items:center;gap:14px;margin-bottom:6px}.logo{max-width:140px;max-height:52px;object-fit:contain;border-radius:8px}
    h1{color:#1a5252;font-size:18px;margin:0 0 2px}.sub{color:#666;margin:0;font-size:12px}
    .cards{display:flex;gap:12px;margin:12px 0 16px;flex-wrap:wrap}.card{background:#1a5252;color:#fff;border-radius:10px;padding:8px 16px}.card .v{font-size:18px;font-weight:800;line-height:1}.card .l{font-size:9px;text-transform:uppercase;letter-spacing:.5px;opacity:.85}
    table{width:100%;border-collapse:collapse}th{background:#1a5252;color:#fff;padding:5px 6px;text-align:left;font-size:10px}td{padding:4px 6px;border-bottom:1px solid #e0e0e0;font-size:10px}tr:nth-child(even) td{background:#fafafa}
    .footer{margin-top:20px;font-size:10px;color:#999;text-align:center}
  </style></head><body>
    <div class="h">${logo?`<img src="${logo}" class="logo" onerror="this.style.display='none'">`:''}<div><h1>${_eTxn(d.title)}</h1><p class="sub">${_eTxn(rangeLabel())}</p></div></div>
    <div class="cards">${cards}</div>
    <table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>
    <div class="footer">Generated ${new Date().toLocaleString()} · TurnDesk</div></body></html>`;
}

// ── Payroll page (per-tech commission / check / cash by pay period, prev-period compare) ─
// Its own dashboard tab. Techs are cards (horizontal scroll); each shows Billed,
// Commission, Check, Cash + a per-day breakdown, each line compared to the previous
// pay period (▲ green / ▼ red + %). Check = staff paycheck setting (set $, set % of
// commission, or variable=manual entry here, stored per tech per period). Cash = comm − check.
let _payrollOffset = 0;   // 0 = current pay period, -1 = previous, +1 = next
function prevPayPeriod({ from }) {
  const pp = cfg().pay_period || {}, type = pp.type || 'weekly', msDay = 86400000;
  if (type === 'bimonthly') {
    if (from.getDate() <= 15) { const y = from.getFullYear(), m = from.getMonth() - 1; return { from: new Date(y, m, 16), to: new Date(y, m + 1, 0, 23,59,59) }; }
    return { from: new Date(from.getFullYear(), from.getMonth(), 1), to: new Date(from.getFullYear(), from.getMonth(), 15, 23,59,59) };
  }
  const len = type === 'biweekly' ? 14 : 7;
  const f = new Date(from.getTime() - len * msDay); f.setHours(0,0,0,0);
  const t = new Date(from.getTime() - msDay); t.setHours(23,59,59,999);
  return { from: f, to: t };
}
function nextPayPeriod({ from }) {
  const pp = cfg().pay_period || {}, type = pp.type || 'weekly', msDay = 86400000;
  if (type === 'bimonthly') {
    if (from.getDate() <= 15) return { from: new Date(from.getFullYear(), from.getMonth(), 16), to: new Date(from.getFullYear(), from.getMonth() + 1, 0, 23,59,59) };
    const y = from.getFullYear(), m = from.getMonth() + 1; return { from: new Date(y, m, 1), to: new Date(y, m, 15, 23,59,59) };
  }
  const len = type === 'biweekly' ? 14 : 7;
  const f = new Date(from.getTime() + len * msDay); f.setHours(0,0,0,0);
  const t = new Date(f.getTime() + (len - 1) * msDay); t.setHours(23,59,59,999);
  return { from: f, to: t };
}
function payrollPeriodAt(offset) {
  let p = payPeriodDates(new Date());
  const step = offset < 0 ? prevPayPeriod : nextPayPeriod;
  for (let i = 0; i < Math.abs(offset); i++) p = step(p);
  return p;
}
function payrollDaysInRange(from, to) {
  const days = [], d = new Date(from.getFullYear(), from.getMonth(), from.getDate()), end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  while (d <= end) { days.push(localDateStr(new Date(d))); d.setDate(d.getDate() + 1); }
  return days;
}
function payrollRange(from, to) {
  const inRange = r => { const d = new Date(r.checkinTime); return d >= from && d <= to; };
  const recs = buildCombinedRecords().filter(r => r.status !== 'deleted' && inRange(r));
  const byTech = {};
  const ensure = id => byTech[id] = byTech[id] || { billed: 0, commission: 0, daily: {}, refund: 0, refundComm: 0, refundNotes: [] };
  recs.filter(r => isPaidStatus(r.status)).forEach(r => {
    const day = localDateStr(new Date(r.checkinTime));
    (r.assignments || []).forEach(a => {
      if (!a.techId) return;
      const tech = staffById(a.techId), pct = tech?.commission != null ? tech.commission : 0, cost = a.cost || 0, comm = cost * pct / 100;
      const t = ensure(a.techId);
      t.billed += cost; t.commission += comm;
      const dd = t.daily[day] = t.daily[day] || { billed: 0, commission: 0 };
      dd.billed += cost; dd.commission += comm;
    });
  });
  // Refunds are kept SEPARATE (not folded into billed/commission) so the Payroll page can
  // show them as their own line. Whether they dock pay is decided at render time via
  // config.commission_includes_refunds (see _netComm).
  recs.filter(r => r.status === 'refund').forEach(r => {
    (r.refundTechBilled || []).forEach(x => {
      if (!x.techId) return;
      const tech = staffById(x.techId), pct = tech?.commission != null ? tech.commission : 0, billed = x.billed || 0;
      const t = ensure(x.techId);
      t.refund += billed; t.refundComm += billed * pct / 100;
      if (r.discountNote) t.refundNotes.push(r.discountNote);
    });
  });
  return byTech;
}
function techCheckAmount(tech, commission, perKey) {
  const type = tech?.checkType || 'variable';
  if (type === 'amount') return tech.checkValue || 0;
  if (type === 'percent') return commission * (tech.checkValue || 0) / 100;
  const m = (cfg().payroll_checks || {})[tech.id + ':' + perKey];
  return m != null ? m : 0;
}
// Cash deduction: a % taken from the cash portion (commission − check) ABOVE an
// exempt threshold. e.g. cash $1150, threshold $700, 20% → deduct 20% of $450 = $90.
function techCashDeduction(tech, cashGross) {
  const pct = tech?.cashDeductPct || 0, thr = tech?.cashDeductThreshold || 0;
  if (pct <= 0) return 0;
  return Math.max(0, cashGross - thr) * pct / 100;
}
export function payrollSetCheck(techId, val) {
  const perKey = localDateStr(payrollPeriodAt(_payrollOffset).from);
  const checks = { ...(cfg().payroll_checks || {}) };
  const n = parseFloat(val);
  if (!isNaN(n) && n !== 0) checks[techId + ':' + perKey] = n; else delete checks[techId + ':' + perKey];
  dispatch('config.set', { key: 'payroll_checks', value: checks });
  renderPayrollPage();
}
export function payrollNav(dir) { _payrollOffset += dir; renderPayrollPage(); }
const _pcmp = (cur, prev) => {
  if (!prev && !cur) return '';
  if (!prev) return '<span style="color:#16a34a;font-size:9px;font-weight:800">▲</span>';
  const up = cur >= prev;
  return `<span style="color:${up ? '#16a34a' : '#dc2626'};font-size:9px;font-weight:800">${up ? '▲' : '▼'} ${Math.abs((cur - prev) / prev * 100).toFixed(0)}%</span>`;
};
const _m2 = n => '$' + (n || 0).toFixed(2);
// Refunds dock pay only when the operator opts in (Settings → Commission & Refunds).
// refundComm is already negative, so net = gross + refundComm.
const _refImpact = c => (cfg().commission_includes_refunds ? (c.refundComm || 0) : 0);
const _netComm   = c => (c.commission || 0) + _refImpact(c);
const _refNote   = notes => (notes && notes.length)
  ? ` <span title="${notes.map(n => String(n).replace(/"/g, '&quot;')).join(' · ')}" style="cursor:help;color:var(--md-on-surface-variant);font-size:11px">&#9432;</span>` : '';
const _refCells  = (cur, prev) => `<td class="num staff-sep" style="color:#dc2626">${cur.refund ? '-$' + Math.abs(cur.refund).toFixed(2) : '—'}${_refNote(cur.refundNotes)}</td><td class="num last" style="color:#dc2626">${prev.refund ? '-$' + Math.abs(prev.refund).toFixed(2) : '—'}</td>`;
export function renderPayrollPage() {
  const wrap = document.getElementById('payroll-cards'); if (!wrap) return;
  const cur = payrollPeriodAt(_payrollOffset), prev = prevPayPeriod(cur);
  const fmtD = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const lbl = document.getElementById('payroll-period-label');
  if (lbl) lbl.textContent = `${fmtD(cur.from)} – ${fmtD(cur.to)}${_payrollOffset === 0 ? ' · current' : ''}`;
  const curData = payrollRange(cur.from, cur.to), prevData = payrollRange(prev.from, prev.to);
  const curKey = localDateStr(cur.from), prevKey = localDateStr(prev.from);
  const curDays = payrollDaysInRange(cur.from, cur.to), prevDays = payrollDaysInRange(prev.from, prev.to);
  const order = cfg().turns_order || [];
  const techs = (cfg().staff || []).filter(s => !cfg().inactive_staff.includes(s.id))
    .sort((a, b) => { const ra = order.indexOf(a.id), rb = order.indexOf(b.id); return (ra === -1 ? 1e9 : ra) - (rb === -1 ? 1e9 : rb); });
  if (!techs.length) { wrap.innerHTML = '<div class="text-sm text-on-surface-variant py-8 text-center w-full">No technicians configured.</div>'; return; }
  // Excel-style table: techs as column-groups across the top (This | Last), metrics +
  // each day as rows; sticky first column holds the row labels.
  const T = techs.map(tech => {
    const c = curData[tech.id] || { billed: 0, commission: 0, daily: {}, refund: 0, refundComm: 0, refundNotes: [] };
    const p = prevData[tech.id] || { billed: 0, commission: 0, daily: {}, refund: 0, refundComm: 0, refundNotes: [] };
    const cComm = _netComm(c), pComm = _netComm(p);
    const cChk = techCheckAmount(tech, cComm, curKey), pChk = techCheckAmount(tech, pComm, prevKey);
    const cCashGross = Math.max(0, cComm - cChk), pCashGross = Math.max(0, pComm - pChk);
    const cDed = techCashDeduction(tech, cCashGross), pDed = techCashDeduction(tech, pCashGross);
    const cCash = Math.max(0, cCashGross - cDed), pCash = Math.max(0, pCashGross - pDed);
    return { tech, c, p, cChk, pChk, cDed, pDed, cCash, pCash, cTotal: cChk + cCash, pTotal: pChk + pCash, isVar: (tech.checkType || 'variable') === 'variable' };
  });
  // Each tech spans 5 columns: This-Billed | This-Comm | Δ | Last-Billed | Last-Comm.
  // The Δ column holds a single ▲/▼% — green up / red down — based on the BILLED change vs
  // the prior period (one arrow, not one per number). Compact whole dollars in the dense
  // day grid; cents on the summary rows.
  const m0 = n => '$' + Math.round(n || 0);
  const quad = (cb, cc, pb, pc) =>
      `<td class="num staff-sep">${_m2(cb)}</td><td class="num">${_m2(cc)}</td><td class="arrow-col">${_pcmp(cb, pb)}</td>`
    + `<td class="num last thislast-sep">${_m2(pb)}</td><td class="num last">${_m2(pc)}</td>`;
  const dquad = (cd, pd) =>
      `<td class="num staff-sep">${m0(cd.billed)}</td><td class="num">${m0(cd.commission)}</td><td class="arrow-col">${_pcmp(cd.billed, pd.billed)}</td>`
    + `<td class="num last thislast-sep">${m0(pd.billed)}</td><td class="num last">${m0(pd.commission)}</td>`;
  // Check / Cash are single payouts per period (no billed/comm split) → span the "This" side
  // (billed + comm + Δ) and the "Last" side (billed + comm).
  const span2 = (cVal, pVal) => `<td class="num staff-sep" colspan="3">${cVal}</td><td class="num last thislast-sep" colspan="2">${_m2(pVal)}</td>`;
  const checkCell = x => x.isVar
    ? `<td class="num staff-sep" colspan="3"><input type="number" min="0" step="1" value="${x.cChk || ''}" placeholder="0" onchange="payrollSetCheck('${x.tech.id}',this.value)" style="width:62px" class="bg-surface-container border border-surface-container-high rounded px-1 py-0.5 text-sm font-headline text-right text-on-surface focus:outline-none focus:border-primary"></td><td class="num last thislast-sep" colspan="2">${_m2(x.pChk)}</td>`
    : span2(_m2(x.cChk), x.pChk);
  const refCells = (c, p) =>
    `<td class="num staff-sep" style="color:#dc2626">${c.refund ? '-$' + Math.abs(c.refund).toFixed(0) : '—'}${_refNote(c.refundNotes)}</td><td class="num" style="color:#dc2626">${c.refundComm ? '-$' + Math.abs(c.refundComm).toFixed(0) : '—'}</td><td class="arrow-col"></td><td class="num last thislast-sep" style="color:#dc2626">${p.refund ? '-$' + Math.abs(p.refund).toFixed(0) : '—'}</td><td class="num last" style="color:#dc2626">${p.refundComm ? '-$' + Math.abs(p.refundComm).toFixed(0) : '—'}</td>`;
  const info = `<span onclick="showToast('Day cells show billed and commission, this period vs last. The Δ column is the change in billed vs the same weekday in the previous pay period.')" title="Day cells = billed and commission, this period vs last. Δ = change in billed vs the same weekday in the previous pay period." class="material-symbols-outlined" style="font-size:14px;vertical-align:middle;cursor:help;color:var(--md-on-surface-variant)">info</span>`;
  const rows = [
    `<tr><td class="sticky-col">Total</td>${T.map(x => quad(x.c.billed, x.c.commission, x.p.billed, x.p.commission)).join('')}</tr>`,
    ...(T.some(x => x.c.refund || x.p.refund) ? [
      `<tr><td class="sticky-col">Refunds</td>${T.map(x => refCells(x.c, x.p)).join('')}</tr>`,
    ] : []),
    `<tr><td class="sticky-col">Check</td>${T.map(checkCell).join('')}</tr>`,
    ...(T.some(x => x.cDed || x.pDed) ? [
      `<tr><td class="sticky-col">Cash deduction</td>${T.map(x => `<td class="num staff-sep" colspan="3" style="color:#dc2626">${x.cDed ? '-' + _m2(x.cDed) : '—'}</td><td class="num last thislast-sep" colspan="2" style="color:#dc2626">${x.pDed ? '-' + _m2(x.pDed) : '—'}</td>`).join('')}</tr>`,
    ] : []),
    `<tr><td class="sticky-col">Cash</td>${T.map(x => span2(_m2(x.cCash), x.pCash)).join('')}</tr>`,
    `<tr style="font-weight:700"><td class="sticky-col">Total paid</td>${T.map(x => span2(_m2(x.cTotal), x.pTotal)).join('')}</tr>`,
    `<tr class="section-row"><td class="sticky-col">By day ${info}</td><td colspan="${T.length * 5}"></td></tr>`,
    ...curDays.map((day, i) => {
      const dl = new Date(day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
      return `<tr><td class="sticky-col" style="font-weight:500">${dl}</td>${T.map(x => dquad(x.c.daily[day] || { billed: 0, commission: 0 }, x.p.daily[prevDays[i]] || { billed: 0, commission: 0 })).join('')}</tr>`;
    }),
  ];
  const head1 = T.map(x => `<th colspan="5" class="staff-sep" style="text-align:center"><span style="text-decoration:underline">${x.tech.name}${x.tech.commission != null ? ` ${x.tech.commission}%` : ''}</span></th>`).join('');
  const head2 = T.map(() => `<th colspan="2" class="staff-sep" style="text-align:center;font-weight:600">This</th><th class="arrow-col"></th><th colspan="2" class="thislast-sep" style="text-align:center;font-weight:600">Last</th>`).join('');
  const head3 = T.map(() => `<th class="num staff-sep">Billed</th><th class="num">Comm</th><th class="arrow-col"></th><th class="num thislast-sep">Billed</th><th class="num">Comm</th>`).join('');
  wrap.innerHTML = `<table class="data-table"><thead>
      <tr><th class="sticky-col" rowspan="3"></th>${head1}</tr>
      <tr>${head2}</tr>
      <tr>${head3}</tr></thead>
    <tbody>${rows.join('')}</tbody></table>`;
}
function payrollExportRows() {
  const cur = payrollPeriodAt(_payrollOffset), data = payrollRange(cur.from, cur.to), perKey = localDateStr(cur.from);
  const order = cfg().turns_order || [];
  return {
    cur,
    rows: (cfg().staff || []).filter(s => !cfg().inactive_staff.includes(s.id))
      .sort((a, b) => { const ra = order.indexOf(a.id), rb = order.indexOf(b.id); return (ra === -1 ? 1e9 : ra) - (rb === -1 ? 1e9 : rb); })
      .map(t => { const c = data[t.id] || { billed: 0, commission: 0, refund: 0, refundComm: 0 }; const net = _netComm(c); const chk = techCheckAmount(t, net, perKey); const cashGross = Math.max(0, net - chk); const ded = techCashDeduction(t, cashGross); const cash = Math.max(0, cashGross - ded); return { name: t.name, billed: c.billed, commission: c.commission, refund: c.refund || 0, check: chk, deduction: ded, cash, total: chk + cash }; })
      .filter(r => r.billed || r.commission || r.check || r.refund),
  };
}
export function payrollExportCSV() {
  const { cur, rows } = payrollExportRows();
  if (!rows.length) { showToast('No payroll data for this period.'); return; }
  const fmt = d => d.toLocaleDateString();
  const t = k => rows.reduce((s, r) => s + r[k], 0);
  const matrix = [
    ['TurnDesk — Payroll'], [`Pay period: ${fmt(cur.from)} – ${fmt(cur.to)}`], [],
    ['Technician', 'Billed', 'Commission', 'Refunds', 'Check', 'Cash deduction', 'Cash', 'Total paid'],
    ...rows.map(r => [r.name, `$${r.billed.toFixed(2)}`, `$${r.commission.toFixed(2)}`, r.refund ? `-$${Math.abs(r.refund).toFixed(2)}` : '$0.00', `$${r.check.toFixed(2)}`, r.deduction ? `-$${r.deduction.toFixed(2)}` : '$0.00', `$${r.cash.toFixed(2)}`, `$${r.total.toFixed(2)}`]),
    [], ['Totals', `$${t('billed').toFixed(2)}`, `$${t('commission').toFixed(2)}`, t('refund') ? `-$${Math.abs(t('refund')).toFixed(2)}` : '$0.00', `$${t('check').toFixed(2)}`, t('deduction') ? `-$${t('deduction').toFixed(2)}` : '$0.00', `$${t('cash').toFixed(2)}`, `$${t('total').toFixed(2)}`],
  ];
  const csv = matrix.map(line => line.map(c => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a'); a.href = url; a.download = `turndesk-payroll-${localDateStr(cur.from)}.csv`; a.click(); URL.revokeObjectURL(url);
  showToast('Payroll exported as CSV');
}
function payrollGrid() {
  const cur = payrollPeriodAt(_payrollOffset), prev = prevPayPeriod(cur);
  const curData = payrollRange(cur.from, cur.to), prevData = payrollRange(prev.from, prev.to);
  const curKey = localDateStr(cur.from), prevKey = localDateStr(prev.from);
  const curDays = payrollDaysInRange(cur.from, cur.to), prevDays = payrollDaysInRange(prev.from, prev.to);
  const order = cfg().turns_order || [];
  const techs = (cfg().staff || []).filter(s => !cfg().inactive_staff.includes(s.id))
    .sort((a, b) => { const ra = order.indexOf(a.id), rb = order.indexOf(b.id); return (ra === -1 ? 1e9 : ra) - (rb === -1 ? 1e9 : rb); });
  const T = techs.map(tech => { const c = curData[tech.id] || { billed: 0, commission: 0, daily: {}, refund: 0, refundComm: 0, refundNotes: [] }, p = prevData[tech.id] || { billed: 0, commission: 0, daily: {}, refund: 0, refundComm: 0, refundNotes: [] }; const cComm = _netComm(c), pComm = _netComm(p); const cChk = techCheckAmount(tech, cComm, curKey), pChk = techCheckAmount(tech, pComm, prevKey); const cCashGross = Math.max(0, cComm - cChk), pCashGross = Math.max(0, pComm - pChk); const cDed = techCashDeduction(tech, cCashGross), pDed = techCashDeduction(tech, pCashGross); const cCash = Math.max(0, cCashGross - cDed), pCash = Math.max(0, pCashGross - pDed); return { tech, c, p, cChk, pChk, cDed, pDed, cCash, pCash, cTotal: cChk + cCash, pTotal: pChk + pCash }; });
  return { cur, T, curDays, prevDays };
}
// Manager PDF: the full grid, landscape, with repeating header + per-row page breaks.
export function payrollExportPDF() {
  const { cur, T, curDays, prevDays } = payrollGrid();
  if (!T.length) { showToast('No technicians.'); return; }
  const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const period = `${fmt(cur.from)} – ${fmt(cur.to)}`;
  const pc = (cv, pv) => { if (!pv && !cv) return ''; if (!pv) return ' <b style="color:#16a34a">▲</b>'; const up = cv >= pv; return ` <b style="color:${up ? '#16a34a' : '#dc2626'};font-size:8px">${up ? '▲' : '▼'}${Math.abs((cv - pv) / pv * 100).toFixed(0)}%</b>`; };
  const m0 = n => '$' + Math.round(n || 0);
  const quad = (cb, cc, pb, pc2) => `<td class="num sep">${_m2(cb)}${pc(cb, pb)}</td><td class="num">${_m2(cc)}${pc(cc, pc2)}</td><td class="num last lsep">${_m2(pb)}</td><td class="num last">${_m2(pc2)}</td>`;
  const dquad = (cd, pd) => `<td class="num sep">${m0(cd.billed)}${pc(cd.billed, pd.billed)}</td><td class="num">${m0(cd.commission)}${pc(cd.commission, pd.commission)}</td><td class="num last lsep">${m0(pd.billed)}</td><td class="num last">${m0(pd.commission)}</td>`;
  const span2 = (cVal, pVal) => `<td class="num sep" colspan="2">${cVal}</td><td class="num last lsep" colspan="2">${_m2(pVal)}</td>`;
  const rows = [
    `<tr><td class="rl">Total</td>${T.map(x => quad(x.c.billed, x.c.commission, x.p.billed, x.p.commission)).join('')}</tr>`,
    ...(T.some(x => x.c.refund || x.p.refund) ? [
      `<tr><td class="rl">Refunds</td>${T.map(x => `<td class="num sep" style="color:#dc2626">${x.c.refund ? '-$' + Math.abs(x.c.refund).toFixed(0) : '—'}</td><td class="num" style="color:#dc2626">${x.c.refundComm ? '-$' + Math.abs(x.c.refundComm).toFixed(0) : '—'}</td><td class="num last lsep" style="color:#dc2626">${x.p.refund ? '-$' + Math.abs(x.p.refund).toFixed(0) : '—'}</td><td class="num last" style="color:#dc2626">${x.p.refundComm ? '-$' + Math.abs(x.p.refundComm).toFixed(0) : '—'}</td>`).join('')}</tr>`,
    ] : []),
    `<tr><td class="rl">Check</td>${T.map(x => span2(_m2(x.cChk), x.pChk)).join('')}</tr>`,
    ...(T.some(x => x.cDed || x.pDed) ? [
      `<tr><td class="rl">Cash deduction</td>${T.map(x => `<td class="num sep" colspan="2" style="color:#dc2626">${x.cDed ? '-' + _m2(x.cDed) : '—'}</td><td class="num last lsep" colspan="2" style="color:#dc2626">${x.pDed ? '-' + _m2(x.pDed) : '—'}</td>`).join('')}</tr>`,
    ] : []),
    `<tr><td class="rl">Cash</td>${T.map(x => span2(_m2(x.cCash), x.pCash)).join('')}</tr>`,
    `<tr><td class="rl" style="font-weight:700">Total paid</td>${T.map(x => span2(_m2(x.cTotal), x.pTotal)).join('')}</tr>`,
    `<tr class="sec"><td class="rl">By day · billed / commission</td><td colspan="${T.length * 4}"></td></tr>`,
    ...curDays.map((day, i) => { const dl = new Date(day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' }); return `<tr><td class="rl">${dl}</td>${T.map(x => dquad(x.c.daily[day] || { billed: 0, commission: 0 }, x.p.daily[prevDays[i]] || { billed: 0, commission: 0 })).join('')}</tr>`; }),
  ].join('');
  const th1 = T.map(x => `<th colspan="4" class="sep" style="text-align:center">${_eTxn(x.tech.name)}${x.tech.commission != null ? ` ${x.tech.commission}%` : ''}</th>`).join('');
  const th2 = T.map(() => `<th colspan="2" class="sep" style="text-align:center">This</th><th colspan="2" class="lsep" style="text-align:center">Last</th>`).join('');
  const th3 = T.map(() => `<th class="num sep">Billed</th><th class="num">Comm</th><th class="num lsep">Billed</th><th class="num">Comm</th>`).join('');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>TurnDesk Payroll — ${_eTxn(period)}</title><style>
    @page{size:11in 8.5in;margin:.4in} body{font-family:Arial,sans-serif;margin:0;color:#222}
    h1{color:#1a5252;font-size:15px;margin:0 0 8px} table{border-collapse:collapse;width:auto;font-size:9px}
    th,td{padding:3px 6px;border-bottom:1px solid #ddd;white-space:nowrap;text-align:left}
    thead th{background:#1a5252;color:#fff} thead{display:table-header-group} tr{page-break-inside:avoid}
    .num{text-align:right} .last{color:#888} .rl{font-weight:700;background:#f0f3f3} .sep{border-left:2px solid #1a5252} .lsep{border-left:1px solid #cfd8d8} .sec td{background:#e8eded;font-weight:700;text-transform:uppercase;font-size:8px}
  </style></head><body>
    <h1>TurnDesk — Payroll · ${_eTxn(period)}</h1>
    <table><thead><tr><th class="rl"></th>${th1}</tr><tr><th class="rl"></th>${th2}</tr><tr><th class="rl"></th>${th3}</tr></thead><tbody>${rows}</tbody></table>
  </body></html>`;
  const u = URL.createObjectURL(new Blob([html], { type: 'text/html' })); const w = window.open(u, '_blank'); if (w) setTimeout(() => w.print(), 600); URL.revokeObjectURL(u);
  showToast('Payroll PDF opened — Print → Save as PDF (landscape)');
}
// Staff PDF: a landscape GRID of compact per-tech cards (4 across) — billed total +
// billed-by-day only (no commission/check/cash/%). Many techs per page so a printed
// sheet can be cut into individual handouts.
export function payrollExportStaffPDF() {
  const { cur, T, curDays } = payrollGrid();
  const techs = T.filter(x => x.c.billed || x.c.refund);
  if (!techs.length) { showToast('No billing this period.'); return; }
  const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const period = `${fmt(cur.from)} – ${fmt(cur.to)}`;
  const cards = techs.map(x => {
    const trs = curDays.map(day => { const b = (x.c.daily[day] || { billed: 0 }).billed; const dl = new Date(day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' }); return `<tr><td>${dl}</td><td class="n">$${b.toFixed(0)}</td></tr>`; }).join('');
    const net = x.c.billed + (x.c.refund || 0);
    const rf = x.c.refund ? `<div class="crf">Refunds -$${Math.abs(x.c.refund).toFixed(2)} · Net $${net.toFixed(2)}</div>` : '';
    return `<div class="card">
      <div class="cname">${_eTxn(x.tech.name)}</div>
      <div class="ctot">$${x.c.billed.toFixed(2)} <span class="ctl">billed</span></div>
      <table class="cdays"><tbody>${trs}</tbody><tfoot><tr><td>Total</td><td class="n">$${x.c.billed.toFixed(2)}</td></tr></tfoot></table>
      ${rf}
    </div>`;
  }).join('');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Staff Billing — ${_eTxn(period)}</title><style>
    @page{size:11in 8.5in;margin:.4in} body{font-family:Arial,sans-serif;margin:0;color:#222}
    .hd{font-size:12px;color:#666;margin:0 0 8px}.hd b{color:#1a5252;font-size:15px}
    .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
    .card{border:1px dashed #9aa;border-radius:8px;padding:8px 10px;break-inside:avoid;page-break-inside:avoid}
    .cname{font-size:14px;font-weight:800;color:#1a5252;line-height:1.1}
    .ctot{font-size:17px;font-weight:800;color:#1a5252;margin:2px 0 6px}.ctl{font-size:9px;font-weight:600;color:#888;text-transform:uppercase}
    .cdays{width:100%;border-collapse:collapse;font-size:9px}.cdays td{padding:1px 2px;border-bottom:1px solid #eee}.cdays td.n{text-align:right;font-weight:700;font-variant-numeric:tabular-nums}
    .cdays tfoot td{border-top:1.5px solid #1a5252;border-bottom:none;font-weight:800;padding-top:3px}
    .crf{margin-top:5px;font-size:9px;color:#a01818;font-weight:600}
  </style></head><body>
    <div class="hd"><b>TurnDesk</b> — Staff Billing · ${_eTxn(period)}</div>
    <div class="grid">${cards}</div>
  </body></html>`;
  const u = URL.createObjectURL(new Blob([html], { type: 'text/html' })); const w = window.open(u, '_blank'); if (w) setTimeout(() => w.print(), 600); URL.revokeObjectURL(u);
  showToast('Staff PDF opened — grid of cards (cut to hand out)');
}

// ── Transactions list ─────────────────────────────
export function txnToday() { setReportRange('today'); }
export function renderTransactions() {
  const list = document.getElementById('txn-list'), empty = document.getElementById('txn-empty');
  if (!list) return;
  syncRangeButtons();
  const dates = getReportDates();   // shared Reports window (Today / Week / Month / Custom)
  let combined = buildCombinedRecords();
  if (dates) combined = combined.filter(r => { const d = new Date(r.checkinTime); return d >= dates.from && d <= dates.to; });
  combined = combined.filter(r => isPaidStatus(r.status) || r.status === 'refund').sort((a,b)=>new Date(b.checkinTime)-new Date(a.checkinTime));
  // Day/range total bar (always shown): net = paid tickets minus refunds (refunds store a
  // negative totalCost). Count is transactions as shown — a party counts once, not per guest.
  const net = combined.reduce((s,r)=>s+(r.totalCost||0),0);
  const seenParties = new Set(); let txnCount = 0;
  combined.forEach(r => { if (r.groupId && r.status !== 'refund') { if (!seenParties.has(r.groupId)) { seenParties.add(r.groupId); txnCount++; } } else txnCount++; });
  const rngEl = document.getElementById('txn-total-range'); if (rngEl) rngEl.textContent = rangeLabel();
  const cntEl = document.getElementById('txn-total-count'); if (cntEl) cntEl.textContent = txnCount;
  const cntS = document.getElementById('txn-total-count-s'); if (cntS) cntS.style.display = txnCount === 1 ? 'none' : '';
  const netEl = document.getElementById('txn-total-net'); if (netEl) netEl.textContent = (net < 0 ? '-$' : '$') + Math.abs(net).toFixed(2);
  if (combined.length === 0) { list.innerHTML = ''; empty?.classList.remove('hidden'); return; }
  empty?.classList.add('hidden');
  const letters = partyLetterMap(combined);
  const txnCard = (r) => {
    const dt = new Date(r.checkinTime);
    const timeStr = dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}), dateStr = dt.toLocaleDateString('en-US',{month:'short',day:'numeric'});
    const isRefund = r.status === 'refund';
    const badgeClass = isRefund ? 'badge-refund' : ({ waiting:'badge-waiting', inservice:'badge-inservice', complete:'badge-complete', paid:'badge-done', done:'badge-done' }[r.status] || 'badge-done');
    const serviceLabels = (r.services||[]).map(sid => svc(sid)?.label||sid).join(', ') || '—';
    const assignRows = !isRefund && (r.assignments||[]).filter(a=>a.techId||a.cost).map(a=>`<div class="text-[11px] font-body text-primary">${svc(a.serviceId)?.label||''} → ${staffById(a.techId)?.name||'—'}${a.station?' @ '+a.station:''} ${a.cost?'· $'+a.cost.toFixed(2):''}</div>`).join('');
    const refundNote = isRefund && r.discountNote ? `<div class="text-[11px] font-body text-error mt-1">Reason: ${r.discountNote}</div>` : '';
    const isPast = new Date(r.checkinTime) < new Date(new Date().setHours(0,0,0,0));
    const editable = !isRefund && canDo('historicalEntry') && isPast;   // whole card opens the edit modal
    const totalDisplay = isRefund ? `<div class="text-lg font-headline font-extrabold text-error">-$${Math.abs(r.totalCost||0).toFixed(2)}</div>` : `<div class="text-lg font-headline font-extrabold text-primary">$${(r.totalCost||0).toFixed(2)}</div>`;
    return `<div ${editable ? `onclick="showHistoricalEntryModal('${r.id}')" title="Edit transaction"` : ''} class="bg-surface-container-lowest rounded-xl px-5 py-4 border ${isRefund?'border-error/30':'border-surface-container-high'}${editable?' cursor-pointer hover:shadow-md transition-shadow':''}">
      <div class="flex items-start justify-between"><div class="flex-grow min-w-0">
        <div class="flex items-center gap-2 flex-wrap mb-1"><span class="font-headline font-bold text-on-surface">${r.name}</span><span class="text-[11px] px-2 py-0.5 rounded-full font-body font-semibold ${badgeClass}">${isRefund?'refund':r.status}</span>${!isRefund&&r.isAppointment?'<span class="badge-appointment text-[11px] px-2 py-0.5 rounded-full font-body font-semibold">Appt</span>':''}</div>
        <div class="text-xs font-body text-on-surface-variant mb-1">${serviceLabels}</div>${assignRows||''}${refundNote}
        <div class="text-[11px] font-body text-outline mt-1">${dateStr} · ${timeStr}${r.phone?' · '+r.phone:''}</div></div>
        <div class="ml-4 flex-shrink-0 flex items-center gap-2">
          <div class="flex items-center gap-1">
            ${!isRefund&&canDo('refund')?`<button onclick="event.stopPropagation();initiateRefund('${r.id}')" class="flex items-center gap-1 text-[11px] font-body text-outline hover:text-secondary transition-colors px-2 py-1 rounded-lg hover:bg-secondary/10"><span class="material-symbols-outlined" style="font-size:14px">undo</span> Refund</button>`:''}
            ${canDo('deleteTransaction')?`<button onclick="event.stopPropagation();initiateDeleteTransaction('${r.id}')" class="flex items-center gap-1 text-[11px] font-body text-outline hover:text-error transition-colors px-2 py-1 rounded-lg hover:bg-error/10"><span class="material-symbols-outlined" style="font-size:14px">delete</span> Delete</button>`:''}
          </div>
          ${totalDisplay}
        </div></div></div>`;
  };
  // Bracket a party (paid records sharing a groupId) under a header with a combined total,
  // so it's clear at a glance who was checked in / paid together. Solos render as-is.
  const blocks = []; const partyIdx = {};
  combined.forEach(r => {
    if (r.groupId && r.status !== 'refund') {
      if (partyIdx[r.groupId] == null) { partyIdx[r.groupId] = blocks.length; blocks.push({ type:'party', groupId:r.groupId, color:r.groupColor||'#1a5252', members:[] }); }
      blocks[partyIdx[r.groupId]].members.push(r);
    } else blocks.push({ type:'solo', record:r });
  });
  list.innerHTML = blocks.map(b => {
    if (b.type === 'solo') return txnCard(b.record);
    if (b.members.length === 1) return txnCard(b.members[0]);
    // A party was charged together in Square, so show ONE transaction with the
    // combined total (matching the Square report). Tap to expand the per-customer
    // tickets, which keep their own Refund / Delete / Edit actions.
    const total = b.members.reduce((s,m)=>s+(m.totalCost||0),0), c = b.color, letter = letters.get(b.groupId) || '•';
    const primary = (b.members.find(m=>/\(primary\)/i.test(m.groupLabel||'')) || b.members[0]).name;
    const dt = new Date(b.members[0].checkinTime);
    const timeStr = dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}), dateStr = dt.toLocaleDateString('en-US',{month:'short',day:'numeric'});
    const svcSet = [...new Set(b.members.flatMap(m => (m.services||[]).map(sid => svc(sid)?.label||sid)))];
    const svcSummary = svcSet.slice(0,5).join(', ') + (svcSet.length>5?'…':'');
    return `<div style="border:1.5px solid ${c}66;background:${c}0d;border-radius:14px;overflow:hidden">
      <div onclick="togglePartyTxn(this)" class="cursor-pointer px-5 py-4 flex items-start justify-between">
        <div class="flex-grow min-w-0">
          <div class="flex items-center gap-2 flex-wrap mb-1">
            <span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;background:${c};color:#fff;font-size:11px;font-weight:800;flex-shrink:0">${letter}</span>
            <span class="font-headline font-bold text-on-surface">${primary} · party of ${b.members.length}</span>
            <span class="text-[11px] px-2 py-0.5 rounded-full font-body font-semibold badge-done">paid</span>
            <span class="material-symbols-outlined party-chevron text-on-surface-variant" style="font-size:18px;transition:transform .15s">expand_more</span>
          </div>
          <div class="text-xs font-body text-on-surface-variant mb-1">${svcSummary || '—'}</div>
          <div class="text-[11px] font-body text-outline">${dateStr} · ${timeStr} · tap to expand</div>
        </div>
        <div class="text-right ml-4 flex-shrink-0"><div class="text-lg font-headline font-extrabold" style="color:${c}">$${total.toFixed(2)}</div></div>
      </div>
      <div class="party-members hidden space-y-2 px-2 pb-2">${b.members.map(txnCard).join('')}</div>
    </div>`;
  }).join('');
}
// Expand/collapse a party transaction's per-customer tickets.
export function togglePartyTxn(headerEl) {
  const members = headerEl.parentElement.querySelector('.party-members');
  const chev = headerEl.querySelector('.party-chevron');
  if (!members) return;
  members.classList.toggle('hidden');
  if (chev) chev.style.transform = members.classList.contains('hidden') ? '' : 'rotate(180deg)';
}
export function updateHistoricalButtonVisibility() {
  document.getElementById('add-historical-btn')?.classList.toggle('hidden', !canDo('historicalEntry'));
  document.getElementById('txn-merge-btn')?.classList.toggle('hidden', !canDo('historicalEntry'));
}

// ── Merge separate tickets into one party ─────────────────────────────────────
// Some tickets that were really one visit got checked in (or saved) individually, so
// they have no shared groupId and show as separate transactions. There's no trace of
// which belonged together, so the owner picks them by hand here: selecting 2+ assigns
// them a shared groupId/color (reusing an existing party's if one is selected) and
// re-saves the records, after which they bracket into one "party of N" ticket.
let _txnMergeSel = new Set();
function _txnMergeCandidates() {
  const dates = getReportDates();   // same window as the Transactions tab
  let combined = buildCombinedRecords().filter(r => isPaidStatus(r.status));   // paid only (never refunds)
  if (dates) combined = combined.filter(r => { const d = new Date(r.checkinTime); return d >= dates.from && d <= dates.to; });
  return combined.sort((a, b) => new Date(b.checkinTime) - new Date(a.checkinTime));
}
export function openTxnMergeModal() {
  if (!canDo('historicalEntry')) { showToast('You don’t have permission to merge tickets.'); return; }
  _txnMergeSel = new Set();
  renderTxnMergeList();
  const m = document.getElementById('txn-merge-modal'); if (m) { m.classList.remove('hidden'); m.style.display = 'flex'; }
}
export function closeTxnMergeModal() {
  const m = document.getElementById('txn-merge-modal'); if (m) { m.classList.add('hidden'); m.style.display = 'none'; }
  _txnMergeSel.clear();
}
export function toggleTxnMergeSelect(id) {
  id = String(id);
  if (_txnMergeSel.has(id)) _txnMergeSel.delete(id); else _txnMergeSel.add(id);
  renderTxnMergeList();
}
function renderTxnMergeList() {
  const wrap = document.getElementById('txn-merge-list'); if (!wrap) return;
  const recs = _txnMergeCandidates();
  const letters = partyLetterMap(recs);
  if (!recs.length) {
    wrap.innerHTML = '<div class="text-sm font-body text-on-surface-variant text-center py-10">No paid tickets in this date range.</div>';
  } else {
    wrap.innerHTML = recs.map(r => {
      const dt = new Date(r.checkinTime);
      const when = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' · ' + dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const sel = _txnMergeSel.has(String(r.id));
      const grp = r.groupId ? `<span style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:5px;background:${r.groupColor || '#888'};color:#fff;font-size:9px;font-weight:800;margin-right:5px;vertical-align:middle">${letters.get(r.groupId) || '•'}</span>` : '';
      const svcSummary = (r.services || []).map(sid => svc(sid)?.label || sid).join(', ');
      return `<button type="button" onclick="toggleTxnMergeSelect('${r.id}')" class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left transition-all ${sel ? 'border-primary bg-primary/5' : 'border-surface-container-high hover:bg-surface-container'}">
        <span class="material-symbols-outlined" style="font-size:20px;color:${sel ? 'var(--primary,#1a5252)' : '#9aa0a3'}">${sel ? 'check_box' : 'check_box_outline_blank'}</span>
        <div class="flex-grow min-w-0"><div class="font-headline font-semibold text-on-surface text-sm truncate">${grp}${r.name || '(no name)'}</div>
          <div class="text-[11px] font-body text-on-surface-variant truncate">${when}${svcSummary ? ' · ' + svcSummary : ''}</div></div>
        <span class="font-headline font-bold text-primary flex-shrink-0">$${(r.totalCost || 0).toFixed(2)}</span></button>`;
    }).join('');
  }
  const c = document.getElementById('txn-merge-count'); if (c) c.textContent = `${_txnMergeSel.size} selected`;
}
function _persistGroupOnRecord(id, groupId, groupColor, groupLabel) {
  // A ticket can be a live paid queue entry, a stored record, or both — update whichever
  // exist so the grouping survives the next sync and shows immediately.
  const live = queue().find(e => String(e.id) === id);
  if (live) { live.groupId = groupId; live.groupColor = groupColor; live.groupLabel = groupLabel; dispatch('queue.upsert', { entry: live }); }
  const stored = records().find(r => String(r.id) === id);
  if (stored) dispatch('record.save', { record: { ...stored, groupId, groupColor, groupLabel } });
}
export function mergeSelectedTxns() {
  if (!canDo('historicalEntry')) return;
  if (_txnMergeSel.size < 2) { showToast('Select at least 2 tickets to merge.'); return; }
  const recs = _txnMergeCandidates().filter(r => _txnMergeSel.has(String(r.id)));
  if (recs.length < 2) { showToast('Select at least 2 tickets to merge.'); return; }
  // Merge into an existing party if one was selected, else mint a new group.
  const existing = recs.find(r => r.groupId);
  const groupId = existing?.groupId || `grp-merge-${Date.now()}`;
  const groupColor = existing?.groupColor || GROUP_COLORS[Math.floor(Math.random() * GROUP_COLORS.length)];
  const ordered = [...recs].sort((a, b) => new Date(a.checkinTime) - new Date(b.checkinTime));   // earliest = primary
  const primaryName = ordered[0]?.name || '';
  ordered.forEach((r, i) => _persistGroupOnRecord(String(r.id), groupId, groupColor, i === 0 ? `${r.name} (primary)` : `${primaryName} — ${r.name}`));
  closeTxnMergeModal();
  renderTransactions();
  showToast(`Merged ${recs.length} tickets into one party ✓`);
}

// ── Transactions export (every ticket expanded, current shared date window) ───
// One row per customer/ticket (parties are NOT collapsed here — the owner wants the
// full breakdown). The Party column carries the group letter so members of one Square
// charge can be summed back together. Matches whatever range the Transactions tab shows.
function txnExportRecords() {
  const dates = getReportDates();
  let combined = buildCombinedRecords();
  if (dates) combined = combined.filter(r => { const d = new Date(r.checkinTime); return d >= dates.from && d <= dates.to; });
  return combined.filter(r => isPaidStatus(r.status) || r.status === 'refund')
    .sort((a,b) => new Date(a.checkinTime) - new Date(b.checkinTime));
}
function txnRow(r, letter) {
  const dt = new Date(r.checkinTime), isRefund = r.status === 'refund';
  const services = (r.services||[]).map(sid => svc(sid)?.label||sid).join('; ');
  const techs = [...new Set((r.assignments||[]).filter(a=>a.techId).map(a=>staffById(a.techId)?.name).filter(Boolean))].join('; ');
  const items = (r.items||[]).map(i => `${cfg().items.find(x=>x.id===i.itemId)?.label||'Item'}×${i.qty}`).join('; ');
  const feeAmt = (r.fees||[]).reduce((s,f)=>s+(f.amount||0),0);
  return {
    date: dt.toLocaleDateString(), time: dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),
    customer: r.name||'', phone: r.phone||'', party: r.groupId ? (letter||'•') : '',
    services, techs, items, fees: feeAmt ? feeAmt.toFixed(2) : '', discount: r.discount ? r.discount.toFixed(2) : '',
    total: (isRefund?'-':'') + '$' + Math.abs(r.totalCost||0).toFixed(2), totalNum: isRefund ? -Math.abs(r.totalCost||0) : (r.totalCost||0),
    status: isRefund ? 'refund' : 'paid',
  };
}
function txnExportRows() {
  const recs = txnExportRecords();
  const letters = partyLetterMap(recs);
  return recs.map(r => txnRow(r, letters.get(r.groupId)));
}
export function exportTransactionsCSV() {
  const rows = txnExportRows();
  if (!rows.length) { showToast('No transactions to export.'); return; }
  const net = rows.reduce((s,r)=>s+r.totalNum,0);
  const matrix = [
    ['TurnDesk — Transactions'], [`Showing: ${rangeLabel()}`], [`Tickets: ${rows.length}`, `Net total: $${net.toFixed(2)}`], [],
    ['Date','Time','Customer','Phone','Party','Services','Technicians','Items','Fees','Discount','Total','Status'],
    ...rows.map(r => [r.date, r.time, r.customer, r.phone, r.party, r.services, r.techs, r.items, r.fees, r.discount, r.total, r.status]),
  ];
  const csv = matrix.map(line => line.map(c => `"${String(c==null?'':c).replace(/"/g,'""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿'+csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a'); a.href = url; a.download = `turndesk-transactions-${localDateStr(getReportDates()?.from || new Date())}.csv`; a.click(); URL.revokeObjectURL(url);
  showToast('Transactions exported as CSV (opens in Excel)');
}
export function exportTransactionsPDF() {
  const rows = txnExportRows();
  if (!rows.length) { showToast('No transactions to export.'); return; }
  const url = URL.createObjectURL(new Blob([buildTxnHtml(rows)], { type: 'text/html' }));
  const win = window.open(url, '_blank');
  if (win) setTimeout(() => win.print(), 600);
  URL.revokeObjectURL(url);
  showToast('PDF opened — use Print → Save as PDF');
}
const _eTxn = s => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function buildTxnHtml(rows) {
  const logo = cfg().logo || LOGO_PATH;
  const net = rows.reduce((s,r)=>s+r.totalNum,0);
  const tr = rows.map(r => `<tr><td>${r.date}</td><td>${r.time}</td><td>${_eTxn(r.customer)}</td><td style="text-align:center">${r.party}</td><td>${_eTxn(r.services)}</td><td>${_eTxn(r.techs)}</td><td>${_eTxn(r.items)}</td><td style="text-align:right">${r.fees?'$'+r.fees:''}</td><td style="text-align:right">${r.discount?'-$'+r.discount:''}</td><td style="text-align:right">${r.total}</td><td>${r.status}</td></tr>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>TurnDesk Transactions — ${_eTxn(rangeLabel())}</title><style>
    body{font-family:Arial,sans-serif;font-size:11px;color:#222;margin:20px}.h{display:flex;align-items:center;gap:14px;margin-bottom:6px}.logo{max-width:140px;max-height:52px;width:auto;height:auto;object-fit:contain;border-radius:8px;flex-shrink:0}
    h1{color:#1a5252;font-size:18px;margin:0 0 2px}.sub{color:#666;margin:0;font-size:12px}
    .tot{background:#1a5252;color:#fff;border-radius:10px;padding:10px 16px;display:inline-block;margin:12px 0 16px}.tot .v{font-size:22px;font-weight:800;line-height:1}.tot .l{font-size:10px;text-transform:uppercase;letter-spacing:.5px;opacity:.85}
    table{width:100%;border-collapse:collapse}th{background:#1a5252;color:#fff;padding:5px 6px;text-align:left;font-size:10px}td{padding:4px 6px;border-bottom:1px solid #e0e0e0;font-size:10px;vertical-align:top}tr:nth-child(even) td{background:#fafafa}
    .footer{margin-top:20px;font-size:10px;color:#999;text-align:center}
  </style></head><body>
    <div class="h">${logo?`<img src="${logo}" class="logo" onerror="this.style.display='none'">`:''}<div><h1>TurnDesk — Transactions</h1><p class="sub">${_eTxn(rangeLabel())} · ${rows.length} ticket${rows.length===1?'':'s'}</p></div></div>
    <div class="tot"><div class="v">$${net.toFixed(2)}</div><div class="l">Net total</div></div>
    <table><thead><tr><th>Date</th><th>Time</th><th>Customer</th><th>Party</th><th>Services</th><th>Tech</th><th>Items</th><th>Fees</th><th>Disc</th><th>Total</th><th>Status</th></tr></thead><tbody>${tr}</tbody></table>
    <div class="footer">Generated ${new Date().toLocaleString()} · TurnDesk</div></body></html>`;
}

// ── CSV export ────────────────────────────────────
export function exportReportExcel() {
  const d = window._currentReportData;
  if (!d || d.filtered.length === 0) { showToast('No data to export.'); return; }
  const rows = [
    ['TurnDesk — Report'], [`Period: ${d.from.toLocaleDateString()} – ${d.to.toLocaleDateString()}`],
    [`Total Income: $${d.totalIncome.toFixed(2)}`, `Guests Served: ${d.guestCount}`, `Avg Ticket: $${(d.totalIncome/Math.max(d.guestCount,1)).toFixed(2)}`], [],
    ['CHECK-INS'], ['Date','Time','Name','Phone','Services','Type','Staff','Total','Status'],
    ...d.filtered.map(r => { const dt = new Date(r.checkinTime); const staffNames = (r.assignments||[]).map(a=>staffById(a.techId)?.name).filter(Boolean).join(', '); return [dt.toLocaleDateString(), dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}), r.name, r.phone, r.services.map(sid=>svc(sid)?.label||sid).join(', '), r.isAppointment?'Appointment':'Walk-In', staffNames, r.totalCost?`$${r.totalCost.toFixed(2)}`:'$0.00', r.status]; }),
    [], ['STAFF BREAKDOWN'], ['Technician','Services','Turns','Bonus Turns','Total Billed','Commission %','Commission Earned','Salon Keeps'],
    ...Object.entries(d.staffMap).map(([techId,data])=>{ const tech = staffById(techId); const commPct = tech?.commission!=null?tech.commission:null; const commAmt = commPct!=null?data.income*commPct/100:0; return [tech?.name||'Unknown', data.count, data.fullTurns+data.halfTurns, data.bonusTurns, `$${data.income.toFixed(2)}`, commPct!=null?`${commPct}%`:'N/A', `$${commAmt.toFixed(2)}`, `$${(data.income-commAmt).toFixed(2)}`]; }),
    [], ['GIFT CARDS (separate ledger — not in service income)'],
    ['Sold this period', `$${(d.gcSoldValue||0).toFixed(2)}`], ['Redeemed this period', `$${(d.gcRedeemed||0).toFixed(2)}`], ['Outstanding balance (all cards)', `$${(d.gcOutstanding||0).toFixed(2)}`],
  ];
  const csv = rows.map(r => r.map(c => `"${String(c||'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a'); a.href = url; a.download = `turndesk-report-${localDateStr(d.from)}.csv`; a.click(); URL.revokeObjectURL(url);
  showToast('Report downloaded as CSV (opens in Excel)');
}

// Shared report HTML builder (used by PDF print + R2 link export) — consolidates
// the two near-identical templates from the original.
function buildReportHtml(d) {
  const fmt = dt => new Date(dt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
  const fmtT = dt => new Date(dt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  const period = d.from.toDateString() === d.to.toDateString() ? fmt(d.from) : `${fmt(d.from)} – ${fmt(d.to)}`;
  const staffEntries = Object.entries(d.staffMap).sort((a,b)=>b[1].income-a[1].income);
  const totalComm = staffEntries.reduce((sum,[tid,data])=>{ const t = staffById(tid); return sum + (t?.commission!=null?data.income*t.commission/100:0); }, 0);
  const shopKeeps = d.totalIncome - totalComm;
  const staffRows = staffEntries.map(([tid,data])=>{ const t = staffById(tid); const comm = t?.commission!=null?data.income*t.commission/100:null; const turns = data.fullTurns+data.halfTurns; return `<tr><td>${t?.name||'Unknown'}</td><td>${data.count}</td><td>${turns}t${data.bonusTurns>0?' +'+data.bonusTurns+'b':''}</td><td>$${data.income.toFixed(2)}</td><td>${t?.commission!=null?t.commission+'%':'—'}</td><td>${comm!=null?'$'+comm.toFixed(2):'—'}</td><td>${comm!=null?'$'+(data.income-comm).toFixed(2):'—'}</td></tr>`; }).join('');
  const txRows = d.filtered.map(r => { const dt = new Date(r.checkinTime); const staffNames = [...new Set((r.assignments||[]).filter(a=>a.techId).map(a=>staffById(a.techId)?.name||'').filter(Boolean))].join(', '); return `<tr><td>${dt.toLocaleDateString()}</td><td>${fmtT(dt)}</td><td>${r.name}</td><td>${r.services.map(sid=>svc(sid)?.label||sid).join(', ')}</td><td>${staffNames||'—'}</td><td>$${(r.totalCost||0).toFixed(2)}</td><td>${r.status}</td></tr>`; }).join('');
  const logo = cfg().logo || LOGO_PATH;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>TurnDesk Report ${period}</title><style>
    body{font-family:Arial,sans-serif;font-size:12px;color:#222;margin:24px}.report-header{display:flex;align-items:center;gap:16px;margin-bottom:8px}.report-logo{max-width:140px;max-height:56px;width:auto;height:auto;object-fit:contain;border-radius:8px;flex-shrink:0}
    h1{color:#1a5252;font-size:20px;margin:0 0 2px}h2{color:#1a5252;font-size:14px;margin:20px 0 8px;border-bottom:2px solid #1a5252;padding-bottom:4px}
    .summary{display:flex;gap:24px;margin:12px 0 20px;flex-wrap:wrap}.card{background:#f5f5f5;border-radius:8px;padding:10px 16px;min-width:120px;text-align:center}.card .val{font-size:20px;font-weight:bold;color:#1a5252}.card .lbl{font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px}.card.amber .val{color:#a05000}
    table{width:100%;border-collapse:collapse;margin-bottom:16px}th{background:#1a5252;color:#fff;padding:6px 8px;text-align:left;font-size:11px}td{padding:5px 8px;border-bottom:1px solid #e0e0e0;font-size:11px}tr:nth-child(even) td{background:#fafafa}.footer{margin-top:24px;font-size:10px;color:#999;text-align:center}
  </style></head><body>
    <div class="report-header">${logo?`<img src="${logo}" class="report-logo" onerror="this.style.display='none'">`:''}<div><h1>TurnDesk — Daily Report</h1><p style="color:#666;margin:0">${period}</p></div></div>
    <div class="summary"><div class="card"><div class="val">$${d.totalIncome.toFixed(2)}</div><div class="lbl">Total Billed</div></div><div class="card"><div class="val">${d.guestCount}</div><div class="lbl">Guests Served</div></div><div class="card"><div class="val">$${(d.totalIncome/Math.max(d.guestCount,1)).toFixed(2)}</div><div class="lbl">Avg Ticket</div></div><div class="card"><div class="val">$${shopKeeps.toFixed(2)}</div><div class="lbl">Shop Keeps</div></div><div class="card amber"><div class="val">$${totalComm.toFixed(2)}</div><div class="lbl">Commission Owed</div></div></div>
    <h2>Staff Breakdown</h2><table><thead><tr><th>Technician</th><th>Services</th><th>Turns</th><th>Billed</th><th>Comm %</th><th>Commission</th><th>Shop Keeps</th></tr></thead><tbody>${staffRows}</tbody></table>
    <h2>Transactions (${d.filtered.length})</h2><table><thead><tr><th>Date</th><th>Time</th><th>Customer</th><th>Services</th><th>Staff</th><th>Total</th><th>Status</th></tr></thead><tbody>${txRows}</tbody></table>
    <div class="footer">Generated ${new Date().toLocaleString()} · TurnDesk</div></body></html>`;
}

export function exportReportPDF() {
  const d = window._currentReportData;
  if (!d || d.filtered.length === 0) { showToast('No data to export.'); return; }
  const url = URL.createObjectURL(new Blob([buildReportHtml(d)], { type: 'text/html' }));
  const win = window.open(url, '_blank');
  if (win) setTimeout(() => win.print(), 600);
  URL.revokeObjectURL(url);
  showToast('PDF report opened — use Print → Save as PDF');
}
export async function exportReportLink() {
  const d = window._currentReportData;
  if (!d || d.filtered.length === 0) { showToast('No data to export.'); return; }
  showToast('Uploading report…');
  try {
    const res = await fetch(`${PHOTOS_PROXY}/reports/${localDateStr(d.from)}.html`, { method: 'PUT', body: new TextEncoder().encode(buildReportHtml(d)), headers: { 'Content-Type': 'text/html;charset=utf-8' } });
    if (!res.ok) throw new Error(res.status);
    const url = (await res.json()).url;
    try { await navigator.clipboard.writeText(url); } catch (e) {}
    showToast('Link copied to clipboard ✓');
  } catch (e) { showToast('Upload failed — check connection'); }
}

// ── Refunds ───────────────────────────────────────
let _refundTxnId = null, _refundTxnRecord = null;
export function initiateRefund(recordId) {
  if (!canDo('refund')) { showToast('Permission denied'); return; }
  const rec = records().find(r => String(r.id) === String(recordId)) || buildCombinedRecords().find(r => String(r.id) === String(recordId));
  if (!rec) { showToast('Record not found.'); return; }
  if (rec.status === 'refund') { showToast('Cannot refund a refund.'); return; }
  _refundTxnId = String(recordId); _refundTxnRecord = rec;
  document.getElementById('refund-txn-name').textContent = rec.name;
  document.getElementById('refund-txn-original').textContent = `$${(rec.totalCost||0).toFixed(2)}`;
  document.getElementById('refund-amount').value = (rec.totalCost||0).toFixed(2);
  document.getElementById('refund-reason').value = '';
  const m = document.getElementById('refund-modal'); m.classList.remove('hidden'); m.style.display = 'flex';
  setTimeout(() => document.getElementById('refund-reason')?.focus(), 100);
}
export function closeRefundModal() { const m = document.getElementById('refund-modal'); m.classList.add('hidden'); m.style.display = ''; _refundTxnId = null; _refundTxnRecord = null; }

// ── Heal: recompute stored record totals from their parts (one-time fix) ────────
// Corrects any saved record whose cached totalCost drifted from its services+items+
// fees−discount (e.g. a fee added after the total was last saved). Skips refunds and
// records with no reconstructable parts. Confirms + reports the net change.
export function healRecordTotals() {
  const fixes = [];
  records().forEach(r => {
    if (r.status === 'deleted' || r.status === 'refund') return;
    if (!((r.assignments && r.assignments.length) || (r.items && r.items.length) || (r.fees && r.fees.length))) return;
    const t = ticketTotal(r), was = r.totalCost || 0;
    if (Math.abs(t - was) >= 0.005) fixes.push({ r, was, now: t });
  });
  if (!fixes.length) { showToast('All transaction totals already match their parts — nothing to fix.'); return; }
  const delta = fixes.reduce((s, f) => s + (f.now - f.was), 0);
  const msg = `${fixes.length} transaction${fixes.length > 1 ? 's' : ''} have a saved total that doesn't match their services + items + fees − discount. This corrects them (net change ${delta >= 0 ? '+' : '-'}$${Math.abs(delta).toFixed(2)}). Make sure you've exported a backup first.`;
  const apply = () => {
    fixes.forEach(f => dispatch('record.save', { record: { ...f.r, totalCost: f.now } }));
    showToast(`Recalculated ${fixes.length} total${fixes.length > 1 ? 's' : ''} (${delta >= 0 ? '+' : '-'}$${Math.abs(delta).toFixed(2)}) ✓`);
    if (document.getElementById('panel-reports')?.classList.contains('active')) runReport();
    renderTransactions();
  };
  if (window.showWarnModal) window.showWarnModal('Recalculate transaction totals?', msg, apply);
  else if (window.confirm(msg)) apply();
}

// Read-only list of paid tickets with NO fee in the last 30 days — to help spot any
// that should have had one (a dropped fee leaves no trace, so this just narrows the
// candidates). Opens in a new tab; nothing is changed.
export function listFeelessTickets() {
  const since = new Date(); since.setDate(since.getDate() - 30);
  const rows = buildCombinedRecords()
    .filter(r => isPaidStatus(r.status) && new Date(r.checkinTime) >= since && !((r.fees || []).some(f => (f.amount || 0) > 0)))
    .sort((a, b) => new Date(b.checkinTime) - new Date(a.checkinTime));
  if (!rows.length) { showToast('No fee-less paid tickets in the last 30 days.'); return; }
  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const body = rows.map(r => { const d = new Date(r.checkinTime); const svcs = (r.services || []).map(sid => svc(sid)?.label || sid).join(', '); return `<tr><td>${d.toLocaleDateString()}</td><td>${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td><td>${esc(r.name)}</td><td>${esc(svcs)}</td><td style="text-align:right">$${(r.totalCost || 0).toFixed(2)}</td></tr>`; }).join('');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Tickets with no fee — last 30 days</title><style>body{font-family:Arial,sans-serif;margin:24px;color:#222}h1{font-size:16px;color:#1a5252;margin:0 0 4px}p{color:#555;font-size:13px;margin:0}table{border-collapse:collapse;width:100%;font-size:13px;margin-top:14px}th,td{padding:6px 10px;border-bottom:1px solid #e0e0e0;text-align:left}th{background:#1a5252;color:#fff}</style></head><body><h1>Tickets with no fee — last 30 days (${rows.length})</h1><p>Scan for any that should have had a fee, then re-add it on that ticket (open → add fee → Save). Read-only — nothing here is changed.</p><table><thead><tr><th>Date</th><th>Time</th><th>Customer</th><th>Services</th><th style="text-align:right">Total</th></tr></thead><tbody>${body}</tbody></table></body></html>`;
  const u = URL.createObjectURL(new Blob([html], { type: 'text/html' })); const w = window.open(u, '_blank'); if (!w) showToast('Allow pop-ups to view the list'); setTimeout(() => URL.revokeObjectURL(u), 5000);
}
export function confirmRefund() {
  const reason = document.getElementById('refund-reason').value.trim();
  const amount = parseFloat(document.getElementById('refund-amount').value) || 0;
  if (!reason) { showToast('Please enter a reason for the refund.'); return; }
  if (amount <= 0) { showToast('Refund amount must be greater than zero.'); return; }
  if (amount > (_refundTxnRecord?.totalCost || 0)) { showToast('Refund cannot exceed the original total.'); return; }
  const o = _refundTxnRecord, now = new Date().toISOString();
  // Refunds are dated to when they're issued (checkinTime = now) so they land in the
  // CURRENT period's totals in Reports/Payroll. refundTechBilled carries the original's
  // per-tech billed (negated, scaled for partial refunds) so the Payroll page can show a
  // per-tech Refunds line and — when config.commission_includes_refunds is on — dock pay.
  const origTotal = o.totalCost || amount;
  const ratio = origTotal > 0 ? amount / origTotal : 1;
  const refundTechBilled = (o.assignments || [])
    .filter(a => a.techId)
    .map(a => ({ techId: a.techId, billed: -((a.cost || 0) * ratio) }));
  const record = { id: newEntryId(), name: o.name, phone: o.phone||'', services: o.services||[], assignments: [], items: [], fees: [], discount: 0, discountNote: reason, totalCost: -amount, checkinTime: now, completedAt: now, status: 'refund', isAppointment: false, refundOf: _refundTxnId, refundTechBilled, loggedBy: getActiveUser()?.name || '' };
  dispatch('record.save', { record });
  window.logAudit?.('Refund', `${o.name || '—'} · $${amount.toFixed(2)}${reason ? ' · ' + reason : ''}`);
  closeRefundModal();
  renderTransactions();
  if (document.getElementById('panel-reports')?.classList.contains('active')) runReport();
  showToast(`Refund of $${amount.toFixed(2)} recorded ✓`);
}

// ── Delete transaction (soft delete via DO) ───────
let _deleteTxnId = null, _deleteTxnRecord = null;
export function initiateDeleteTransaction(recordId) {
  if (!canDo('deleteTransaction')) { showToast('Permission denied'); return; }
  const fromRecords = records().find(r => String(r.id) === String(recordId));
  const fromQueue = queue().find(e => String(e.id) === String(recordId));
  _deleteTxnRecord = fromRecords || (fromQueue ? { id: String(fromQueue.id), name: fromQueue.name, totalCost: fromQueue.totalCost||0, checkinTime: fromQueue.checkinTime, status: fromQueue.status, services: fromQueue.services, assignments: fromQueue.assignments||[] } : null);
  if (!_deleteTxnRecord) { showToast('Record not found.'); return; }
  _deleteTxnId = String(recordId);
  const dt = new Date(_deleteTxnRecord.checkinTime);
  document.getElementById('del-txn-subtitle').textContent = `${_deleteTxnRecord.name} · ${dt.toLocaleDateString()} · $${(_deleteTxnRecord.totalCost||0).toFixed(2)}`;
  document.getElementById('del-txn-reason').value = '';
  document.getElementById('del-txn-step1').classList.remove('hidden');
  document.getElementById('del-txn-step2').classList.add('hidden');
  const m = document.getElementById('delete-txn-modal'); m.classList.remove('hidden'); m.style.display = 'flex';
}
export function deleteTxnStep2() { document.getElementById('del-txn-step1').classList.add('hidden'); document.getElementById('del-txn-step2').classList.remove('hidden'); setTimeout(() => document.getElementById('del-txn-reason')?.focus(), 100); }
export function closeDeleteTxnModal() { const m = document.getElementById('delete-txn-modal'); m.classList.add('hidden'); m.style.display = ''; _deleteTxnId = null; _deleteTxnRecord = null; }
export function confirmDeleteTransaction() {
  const reason = document.getElementById('del-txn-reason').value.trim();
  if (!reason) { showToast('Please enter a reason for deletion.'); return; }
  if (!_deleteTxnId) return;
  dispatch('record.delete', { id: _deleteTxnId, reason, by: getActiveUser()?.name || 'Unknown' });
  window.logAudit?.('Delete', `${_deleteTxnRecord?.name || '—'} · $${Math.abs(_deleteTxnRecord?.totalCost || 0).toFixed(2)} · ${reason}`);
  if (queue().find(e => String(e.id) === _deleteTxnId)) dispatch('queue.remove', { id: _deleteTxnId });
  // Device-local audit trail
  const log = JSON.parse(localStorage.getItem('turndesk_deletion_log') || '[]');
  log.push({ deletedAt: new Date().toISOString(), deletedBy: getActiveUser()?.name || 'Unknown', recordId: _deleteTxnId, name: _deleteTxnRecord?.name || '', total: _deleteTxnRecord?.totalCost || 0, checkinTime: _deleteTxnRecord?.checkinTime || '', reason });
  localStorage.setItem('turndesk_deletion_log', JSON.stringify(log));
  closeDeleteTxnModal();
  renderTransactions(); window.renderQueue?.(); runReport();
  showToast('Transaction deleted — reason logged ✓');
}

// ── Historical transaction entry (admin) ──────────
let _histMode = 'add', _histEditId = null, _histType = 'Walk-In', _histSelectedSvcs = [], _histAssignments = {}, _histItems = [], _histFees = [];
export function showHistoricalEntryModal(editId, prefillDate) {
  if (!canDo('historicalEntry')) { showToast('Permission denied'); return; }
  _histMode = editId ? 'edit' : 'add'; _histEditId = editId || null;
  _histSelectedSvcs = []; _histAssignments = {}; _histItems = []; _histFees = [];
  const yest = new Date(); yest.setDate(yest.getDate() - 1);
  const yesterdayStr = localDateStr(yest);
  document.getElementById('hist-date').max = yesterdayStr;
  const title = document.getElementById('hist-modal-title');
  if (_histMode === 'edit') {
    const rec = records().find(r => String(r.id) === String(editId));
    if (!rec) { showToast('Record not found'); return; }
    const dt = new Date(rec.checkinTime);
    if (localDateStr(dt) >= todayStr()) { showToast("Today's records are edited through the live queue"); return; }
    if (title) title.textContent = 'Edit Transaction';
    document.getElementById('hist-date').value = localDateStr(dt);
    document.getElementById('hist-time').value = dt.toTimeString().slice(0,5);
    document.getElementById('hist-name').value = rec.name || '';
    document.getElementById('hist-phone').value = rec.phone || '';
    document.getElementById('hist-discount').value = rec.discount > 0 ? rec.discount : '';
    document.getElementById('hist-discount-note').value = rec.discountNote || '';
    _histSelectedSvcs = [...(rec.services || [])];
    rec.assignments.forEach(a => { if (a.serviceId) _histAssignments[a.serviceId] = { techId: a.techId||'', station: a.station||'', cost: a.cost||0 }; });
    _histItems = (rec.items||[]).map(i => ({ itemId: i.itemId, qty: i.qty||1, price: i.price||0 }));
    _histFees = (rec.fees||[]).map(f => ({ feeId: f.feeId, amount: f.amount||0 }));
    _histType = rec.isAppointment ? 'Appointment' : 'Walk-In';
  } else {
    if (title) title.textContent = 'Add Historical Transaction';
    document.getElementById('hist-date').value = (prefillDate && prefillDate < todayStr()) ? prefillDate : yesterdayStr;
    document.getElementById('hist-time').value = '12:00';
    document.getElementById('hist-name').value = '';
    document.getElementById('hist-phone').value = '';
    document.getElementById('hist-discount').value = '';
    document.getElementById('hist-discount-note').value = '';
    _histType = 'Walk-In';
  }
  setHistType(_histType); _renderHistServices(); _renderHistAssignments(); _renderHistItems(); _renderHistFees(); _computeHistTotal();
  const m = document.getElementById('historical-modal'); m.classList.remove('hidden'); m.style.display = 'flex';
}
export function closeHistoricalModal() { const m = document.getElementById('historical-modal'); m.classList.add('hidden'); m.style.display = ''; }
export function setHistType(type) {
  _histType = type;
  ['Walk-In','Appointment'].forEach(t => { const el = document.getElementById(t === 'Walk-In' ? 'hist-type-walkin' : 'hist-type-appt'); if (!el) return; const on = t === type; el.classList.toggle('bg-primary',on); el.classList.toggle('text-on-primary',on); el.classList.toggle('border-primary',on); el.classList.toggle('bg-transparent',!on); el.classList.toggle('border-outline-variant',!on); el.classList.toggle('text-on-surface',!on); });
}
export function toggleHistService(sid, btn) {
  const i = _histSelectedSvcs.indexOf(sid);
  if (i >= 0) { _histSelectedSvcs.splice(i,1); delete _histAssignments[sid]; btn.classList.remove('border-primary','bg-primary/10','text-primary'); btn.classList.add('border-surface-container-high','text-on-surface-variant'); }
  else { _histSelectedSvcs.push(sid); _histAssignments[sid] = { techId:'', station:'', cost: svc(sid)?.baseCost || 0 }; btn.classList.add('border-primary','bg-primary/10','text-primary'); btn.classList.remove('border-surface-container-high','text-on-surface-variant'); }
  _renderHistAssignments(); _computeHistTotal();
}
function _renderHistServices() {
  const el = document.getElementById('hist-services'); if (!el) return;
  el.innerHTML = cfg().services.filter(s => !cfg().hidden_dash_services.includes(s.id)).map(s => { const sel = _histSelectedSvcs.includes(s.id); return `<button type="button" onclick="toggleHistService('${s.id}',this)" class="px-3 py-2 rounded-xl border-2 text-xs font-body font-semibold transition-all ${sel?'border-primary bg-primary/10 text-primary':'border-surface-container-high text-on-surface-variant hover:border-primary'}">${s.label}</button>`; }).join('');
}
function _renderHistAssignments() {
  const el = document.getElementById('hist-assignments'); if (!el) return;
  if (_histSelectedSvcs.length === 0) { el.innerHTML = '<p class="text-xs font-body text-on-surface-variant italic">Select at least one service above to assign staff.</p>'; return; }
  el.innerHTML = _histSelectedSvcs.map(sid => { const s = svc(sid), asgn = _histAssignments[sid] || { techId:'', station:'', cost:0 }; const techOpts = '<option value="">— Tech —</option>' + activeStaff().map(t => `<option value="${t.id}" ${asgn.techId===t.id?'selected':''}>${t.name}</option>`).join(''); return `<div class="flex items-center gap-2 py-2 border-b border-surface-container-high last:border-0"><div class="w-24 flex-shrink-0 text-xs font-body font-semibold text-on-surface truncate">${s?.label||sid}</div><select onchange="_histSetTech('${sid}',this.value)" class="flex-1 min-w-0 border border-surface-container-high bg-transparent rounded-lg px-2 py-1.5 text-xs font-body focus:border-primary outline-none">${techOpts}</select><input type="text" inputmode="decimal" placeholder="$0.00" value="${asgn.cost>0?asgn.cost:''}" oninput="_histSetCost('${sid}',this.value)" class="w-20 border border-surface-container-high bg-transparent rounded-lg px-2 py-1.5 text-xs font-body text-right focus:border-primary outline-none"></div>`; }).join('');
}
export function _histSetTech(sid, val) { if (_histAssignments[sid]) _histAssignments[sid].techId = val; }
export function _histSetCost(sid, val) { if (_histAssignments[sid]) _histAssignments[sid].cost = parseFloat(val) || 0; _computeHistTotal(); }
export function addHistItem() { const first = cfg().items.find(i => !_histItems.some(x => x.itemId === i.id)) || cfg().items[0]; if (!first) { showToast('No items configured'); return; } _histItems.push({ itemId: first.id, qty: 1, price: first.price || 0 }); _renderHistItems(); _computeHistTotal(); }
export function removeHistItem(idx) { _histItems.splice(idx,1); _renderHistItems(); _computeHistTotal(); }
function _renderHistItems() {
  const el = document.getElementById('hist-items'); if (!el) return;
  if (_histItems.length === 0) { el.innerHTML = ''; return; }
  el.innerHTML = _histItems.map((item,i) => { const opts = cfg().items.map(x => `<option value="${x.id}" ${item.itemId===x.id?'selected':''}>${x.label}</option>`).join(''); return `<div class="flex items-center gap-2 mb-1"><select onchange="_histItemPick(${i},this.value)" class="flex-1 min-w-0 border border-surface-container-high bg-transparent rounded-lg px-2 py-1.5 text-xs font-body focus:border-primary outline-none">${opts}</select><input type="number" min="1" value="${item.qty}" placeholder="Qty" oninput="_histItemQty(${i},this.value)" class="w-12 border border-surface-container-high bg-transparent rounded-lg px-2 py-1.5 text-xs font-body text-center focus:border-primary outline-none"><input type="text" inputmode="decimal" value="${item.price>0?item.price:''}" placeholder="$0" oninput="_histItemPrice(${i},this.value)" class="w-16 border border-surface-container-high bg-transparent rounded-lg px-2 py-1.5 text-xs font-body text-right focus:border-primary outline-none"><button onclick="removeHistItem(${i})" class="flex-shrink-0 text-error hover:bg-error/10 rounded-lg p-1"><span class="material-symbols-outlined" style="font-size:16px">close</span></button></div>`; }).join('');
}
export function _histItemPick(i, id) { _histItems[i].itemId = id; const x = cfg().items.find(a => a.id === id); if (x) _histItems[i].price = x.price || 0; _renderHistItems(); _computeHistTotal(); }
export function _histItemQty(i, v) { _histItems[i].qty = parseInt(v) || 1; _computeHistTotal(); }
export function _histItemPrice(i, v) { _histItems[i].price = parseFloat(v) || 0; _computeHistTotal(); }
export function addHistFee() { const first = cfg().fees[0]; if (!first) { showToast('No fees configured'); return; } _histFees.push({ feeId: first.id, amount: first.value || 0 }); _renderHistFees(); _computeHistTotal(); }
export function removeHistFee(idx) { _histFees.splice(idx,1); _renderHistFees(); _computeHistTotal(); }
function _renderHistFees() {
  const el = document.getElementById('hist-fees'); if (!el) return;
  if (_histFees.length === 0) { el.innerHTML = ''; return; }
  el.innerHTML = _histFees.map((fee,i) => { const opts = cfg().fees.map(f => `<option value="${f.id}" ${fee.feeId===f.id?'selected':''}>${f.label}</option>`).join(''); return `<div class="flex items-center gap-2 mb-1"><select onchange="_histFeePick(${i},this.value)" class="flex-1 min-w-0 border border-surface-container-high bg-transparent rounded-lg px-2 py-1.5 text-xs font-body focus:border-primary outline-none">${opts}</select><input type="text" inputmode="decimal" value="${fee.amount>0?fee.amount:''}" placeholder="$0" oninput="_histFeeAmt(${i},this.value)" class="w-20 border border-surface-container-high bg-transparent rounded-lg px-2 py-1.5 text-xs font-body text-right focus:border-primary outline-none"><button onclick="removeHistFee(${i})" class="flex-shrink-0 text-error hover:bg-error/10 rounded-lg p-1"><span class="material-symbols-outlined" style="font-size:16px">close</span></button></div>`; }).join('');
}
export function _histFeePick(i, id) { _histFees[i].feeId = id; const f = cfg().fees.find(x => x.id === id); if (f) _histFees[i].amount = f.value || 0; _renderHistFees(); _computeHistTotal(); }
export function _histFeeAmt(i, v) { _histFees[i].amount = parseFloat(v) || 0; _computeHistTotal(); }
function _computeHistTotal() {
  const svcTotal = _histSelectedSvcs.reduce((s,sid)=>s+(parseFloat(_histAssignments[sid]?.cost)||0),0);
  const itemsTotal = _histItems.reduce((s,i)=>s+(i.qty||0)*(i.price||0),0);
  const feesTotal = _histFees.reduce((s,f)=>s+(parseFloat(f.amount)||0),0);
  const discount = parseFloat(document.getElementById('hist-discount')?.value) || 0;
  const total = Math.max(0, svcTotal + itemsTotal + feesTotal - discount);
  const el = document.getElementById('hist-total-display'); if (el) el.textContent = `$${total.toFixed(2)}`;
  return total;
}
export { _computeHistTotal };
export function saveHistoricalTransaction() {
  const name = document.getElementById('hist-name').value.trim();
  const phone = document.getElementById('hist-phone').value.trim();
  const dateVal = document.getElementById('hist-date').value;
  const timeVal = document.getElementById('hist-time').value || '12:00';
  const discount = parseFloat(document.getElementById('hist-discount').value) || 0;
  const discountNote = document.getElementById('hist-discount-note').value.trim();
  if (!name) { showToast('Customer name is required'); return; }
  if (!dateVal) { showToast('Date is required'); return; }
  if (dateVal >= todayStr()) { showToast('Date must be before today'); return; }
  const checkinTime = new Date(`${dateVal}T${timeVal}:00`);
  const total = _computeHistTotal();
  const assignments = _histSelectedSvcs.map(sid => ({ serviceId: sid, techId: _histAssignments[sid]?.techId||'', station: _histAssignments[sid]?.station||'', cost: parseFloat(_histAssignments[sid]?.cost)||0, status: 'paid', assignedAt: checkinTime.getTime() }));
  if (assignments.length === 0 && total > 0) assignments.push({ serviceId:'', techId:'', station:'', cost: total, status:'paid', assignedAt: checkinTime.getTime() });
  const items = _histItems.filter(i => i.itemId && i.qty > 0).map(i => ({ itemId: i.itemId, qty: i.qty, price: i.price }));
  const fees = _histFees.filter(f => f.feeId && f.amount > 0).map(f => ({ feeId: f.feeId, amount: f.amount }));
  const base = { name, phone, services: _histSelectedSvcs, assignments, items, fees, discount, discountNote, totalCost: total, checkinTime: checkinTime.toISOString(), status: 'paid', isAppointment: _histType === 'Appointment', loggedBy: getActiveUser()?.name || 'Admin' };
  if (_histMode === 'edit') {
    const existing = records().find(r => String(r.id) === String(_histEditId));
    dispatch('record.save', { record: { ...existing, ...base, id: String(_histEditId), completedAt: existing?.completedAt || checkinTime.toISOString() } });
    window.logAudit?.('Edit', `Edited transaction · ${name || '—'} · $${total.toFixed(2)}`);
    showToast('Transaction updated ✓');
  } else {
    dispatch('record.save', { record: { ...base, id: newEntryId(), completedAt: checkinTime.toISOString() } });
    window.logAudit?.('Historical entry', `${name || '—'} · $${total.toFixed(2)}`);
    showToast('Historical transaction saved ✓');
  }
  if (phone) squareUpsertCustomer({ name, phone, services: _histSelectedSvcs });   // sync customer to directory + Square
  closeHistoricalModal();
  renderTransactions();
  if (document.getElementById('panel-reports')?.classList.contains('active')) runReport();
  window.renderTurns?.();   // keep the past-day Turns grid in sync when added/edited from there
}
