// ── Reports, transactions, historical entry, refunds, deletion ──────────────
// Records live in the DO (state.records). Writes go through dispatch:
//   record.save (complete/historical/refund), record.delete (soft delete).
import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { showToast, localDateStr, todayStr, partyLetterMap, ticketTotal, newEntryId, dateBtnLabel, xlsxBlob } from '../utils.js';
import { canDo, getActiveUser } from '../session.js';
import { classifyTurn } from './turns.js';
import { isPaidStatus } from './status.js';
import { squareUpsertCustomer } from './square-customers.js';
import { avgServiceTime, fmtDur } from './servicetime.js';
import { LOGO_PATH, PHOTOS_PROXY, AI_PROXY, GROUP_COLORS, SQUARE_PROXY, HELCIM_PROXY } from '../config.js';
import { helcimActive, refundOnHelcim } from './helcim.js';
import { gcRedemptions, gcTotalUsed } from './giftcards.js';
import { fdPaidHours, fdPunches, fdSetPunches, roundQuarterHours, fdPunchSuspect } from './timeclock.js';
import { printTechReceipts80 } from './receipt.js';
import { drawerReportHtml } from './cashdrawer.js';

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
    discount: entry.discount || 0, discountNote: entry.discountNote || '', txnNote: entry.txnNote || '', totalCost: entry.status === 'refund' ? (entry.totalCost || 0) : ticketTotal(entry),
    groupId: entry.groupId || '', groupColor: entry.groupColor || '', groupLabel: entry.groupLabel || '',
    checkinTime: typeof entry.checkinTime === 'string' ? entry.checkinTime : new Date(entry.checkinTime).toISOString(),
    completedAt: entry.completedAt, status: entry.status, isAppointment: entry.isAppointment || false,
    loggedBy: getActiveUser()?.name || '',
    ...(entry.appointmentId ? { appointmentId: entry.appointmentId } : {}),
    ...(entry.squareOrderId ? { squareOrderId: entry.squareOrderId } : {}),
    ...(entry.squarePaymentIds?.length ? { squarePaymentIds: entry.squarePaymentIds } : {}),
    ...(entry.tenders ? { tenders: entry.tenders } : {}),
    ...(entry.tip ? { tip: entry.tip } : {}),   // card tip — tracked separately; NOT part of totalCost
    ...(entry.squareUnrecorded?.length ? { squareUnrecorded: entry.squareUnrecorded } : {}),   // tenders that failed to POST to Square (cash/Zelle) — flagged for Reconcile
    ...(entry.quickSale ? { quickSale: true } : {}),   // no-service retail / gift-card sale — excluded from Guests Served
    ...(entry.soldBy ? { soldBy: entry.soldBy } : {}),  // front-desk staff who rang it up
    ...(entry.giftcardSales?.length ? { giftcardSales: entry.giftcardSales } : {}),   // gift cards sold on this ticket (liability, not income); ledger entry created on paid
  };
  dispatch('record.save', { record });
}

// On REOPEN, drop the saved transaction so the sale stops counting in Reports/Payroll/Transactions
// until it's re-paid. Sets status:'deleted' via record.save (NOT record.delete) so NO deletion
// tombstone is written — buildCombinedRecords excludes every 'deleted' record everywhere, and
// re-paying the ticket cleanly re-saves a fresh 'paid' record (the deletion-guard would otherwise
// block a re-save forever). Reversible by design. No-op if there's no counted record for the id.
export function voidRecordOnReopen(id) {
  const rec = getState().records.find(r => String(r.id) === String(id));
  if (!rec || rec.status === 'deleted' || !(isPaidStatus(rec.status) || rec.status === 'refund')) return;
  dispatch('record.save', { record: { ...rec, status: 'deleted', voidedReason: 'reopened', voidedAt: new Date().toISOString() } });
  if (rec.giftcardSales?.length) window.gcReverseSalesForTicket?.(String(id));   // un-create gift cards that were sold on this ticket
}

// Combine stored records with the live queue. Records are the SINGLE SOURCE OF TRUTH for
// finished sales: a paid queue entry is included only when no record exists for its id yet.
export function buildCombinedRecords() {
  const deletedIds = new Set(getState().deletions.map(String));
  records().filter(r => r.status === 'deleted').forEach(r => deletedIds.add(String(r.id)));
  // For every recorded ticket the record wins; a paid queue entry surfaces only when there's
  // no record for it yet (e.g. a crash between the queue upsert and saveRecord). This means a
  // historical edit always takes effect and a leftover/duplicate queue copy can never shadow
  // or skew it — independent of the day boundary. The queue↔record sync invariant in queue.js
  // (paid upserts mirror to the record) keeps records current, so this is always correct.
  const recordedIds = new Set(records().filter(r => r.status !== 'deleted' && !deletedIds.has(String(r.id))).map(r => String(r.id)));
  const liveSnaps = queue().filter(e => isPaidStatus(e.status) && !deletedIds.has(String(e.id)) && !recordedIds.has(String(e.id))).map(e => ({
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

// Group ids that have at least one member carrying tenders. A multi-person party records the
// WHOLE group's tender split on its primary member only (square-pos.js _finalizeTerminalPaid),
// so the other members have their own totalCost but no tenders — they must NOT be treated as
// "untracked" sales (that double-counted them against the primary's full-group tender).
function tenderedGroupIds(filtered) {
  const s = new Set();
  filtered.forEach(r => { if (r.tenders && r.groupId) s.add(r.groupId); });
  return s;
}
// A tenderless row counts as "Other / Untracked" ONLY if it isn't a non-primary member of a
// tendered party. Shared by runReport, computeMetrics, and drillDownPay('other') so all three
// agree (and so card+cash+gift+zelle+other === totalIncome + tipsTotal).
function isOtherTender(r, tenderedGroups) {
  return !r.tenders && !(r.groupId && tenderedGroups.has(r.groupId));
}
// Payment Mix totals from a filtered record set. Tips ride on the card (Square deposits card +
// tips together). Single source of truth for the four+one mix figures. (Exported for the
// Muse Reports phone app.)
export function paymentMix(filtered, tipsTotal) {
  const tg = tenderedGroupIds(filtered);
  const cnt = pred => filtered.reduce((n, r) => pred(r) ? n + 1 : n, 0);
  return {
    cardMix:  filtered.reduce((s,r)=>s+(r.tenders?.card||0),0) + tipsTotal,
    cashMix:  filtered.reduce((s,r)=>s+(r.tenders?.cash||0),0),
    giftMix:  filtered.reduce((s,r)=>s+(r.tenders?.gift||0),0),
    zelleMix: filtered.reduce((s,r)=>s+(r.tenders?.zelle||0),0),
    otherMix: filtered.reduce((s,r)=> isOtherTender(r, tg) ? s+(r.totalCost||0) : s, 0),
    // Ticket counts per tender (shown beside the amount on the Payment Mix cards).
    cardCnt:  cnt(r => (r.tenders?.card  || 0) > 0),
    cashCnt:  cnt(r => (r.tenders?.cash  || 0) > 0),
    giftCnt:  cnt(r => (r.tenders?.gift  || 0) > 0),
    zelleCnt: cnt(r => (r.tenders?.zelle || 0) > 0),
    otherCnt: cnt(r => isOtherTender(r, tg)),
  };
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
const COMPARE_OPTS = [['prior','Previous period'], ['lastweek','Same period last week'], ['lastmonth','Same period last month'], ['lastyear','Same period last year'], ['none','No comparison']];
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
  const d = getReportDates(); if (!d) return 'Custom';
  const fmt = x => x.toLocaleDateString('en-US',{month:'short',day:'numeric'});
  // Single-day selections show the date like every other tab's picker ("Today · Tue, Jun 9" / "Mon, Jun 8").
  if (reportRange.type === 'today' || reportRange.type === 'yesterday' || reportRange.type === 'day') return dateBtnLabel(localDateStr(d.from));
  if (_rangeLabels[reportRange.type]) return `${_rangeLabels[reportRange.type]} · ${fmt(d.from)} – ${fmt(d.to)}`;   // This Week · Jun 8 – Jun 14
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
  const len = type === 'biweekly' ? 14 : 7;
  // With no configured start date, anchor to a FIXED reference Sunday (2024-01-07) so week/biweek
  // boundaries are stable. (Anchoring to `today` made the period slide every day — and start in the
  // future: mod=0 → from=today, to=today+6.) A configured startDate always wins. Day counts use
  // UTC midnights + calendar arithmetic (new Date(y,m,d±n)) so a DST transition between the anchor
  // and today — or inside the period — can't shift the boundary by a day.
  const anchor = pp.startDate ? new Date(pp.startDate + 'T00:00:00') : new Date(2024, 0, 7);
  const utcMid = d => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const daysSince = Math.round((utcMid(today) - utcMid(anchor)) / 86400000);
  const mod = ((daysSince % len) + len) % len;
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - mod);
  const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + (len - 1), 23, 59, 59, 999);
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
  const C = reportRange.compare;
  // Fixed offsets — shift the SAME window back by a week / month / year.
  if (C === 'lastyear' || C === 'year') { const from = new Date(cur.from); from.setFullYear(from.getFullYear()-1); const to = new Date(cur.to); to.setFullYear(to.getFullYear()-1); return { from, to }; }
  if (C === 'lastweek') return { from: _sod(_addDays(cur.from, -7)), to: _eod(_addDays(cur.to, -7)) };
  if (C === 'lastmonth') { const from = new Date(cur.from); from.setMonth(from.getMonth()-1); const to = new Date(cur.to); to.setMonth(to.getMonth()-1); return { from: _sod(from), to: _eod(to) }; }
  // 'prior' = the natural period immediately preceding the current selection.
  const T = reportRange.type;
  if (T === 'month' || T === 'lastmonth') return { from: new Date(cur.from.getFullYear(), cur.from.getMonth()-1, 1), to: _eod(new Date(cur.from.getFullYear(), cur.from.getMonth(), 0)) };
  if (T === 'thisyear' || T === 'lastyear') return { from: new Date(cur.from.getFullYear()-1, 0, 1), to: _eod(new Date(cur.from.getFullYear()-1, 11, 31)) };
  if (T === 'payperiod') return prevPayPeriod({ from: cur.from });
  const days = Math.round((_sod(cur.to) - _sod(cur.from)) / 86400000) + 1;
  return { from: _sod(_addDays(cur.from, -days)), to: _eod(_addDays(cur.from, -1)) };
}
// Short label for a compare window, e.g. "Jun 1 – 7" or "Jun 8 – 14, 2025".
function _cmpRangeShort(c) {
  if (!c) return '';
  const fmt = x => x.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const yr = c.from.getFullYear() !== new Date().getFullYear() ? ', ' + c.from.getFullYear() : '';
  if (_sod(c.from).getTime() === _sod(c.to).getTime()) return fmt(c.from) + yr;
  return `${fmt(c.from)} – ${fmt(c.to)}${yr}`;
}
function compareDatesLabel() { return _cmpRangeShort(getCompareDates()); }

// ── Date picker popup ─────────────────────────────
let _dpPendingStart = null, _dpGridWired = false;   // click-start (awaiting click-end) range selection
const _fmtDpDate = ds => new Date(ds + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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
  _dpPendingStart = null;
  const cur = getReportDates();
  _dpMonth = _sod(reportRange.type === 'day' && reportRange.date ? new Date(reportRange.date + 'T12:00:00') : (cur?.from || new Date()));
  const m = document.getElementById('date-picker-modal'); if (m) m.classList.remove('hidden');
  renderDatePicker(); _wireDatePickerGrid(); _anchorPanel('date-picker-panel', ev);
}
export function closeDatePicker() { _dpPendingStart = null; const m = document.getElementById('date-picker-modal'); if (m) m.classList.add('hidden'); }
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
    let cells = ['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => `<div class="dp-dow">${d}</div>`).join('');
    for (let i = 0; i < startDow; i++) cells += '<div></div>';
    for (let d = 1; d <= daysIn; d++) {
      const ds = localDateStr(new Date(y, m, d));
      cells += `<button data-date="${ds}" class="dp-day${ds===today?' today':''}">${d}</button>`;
    }
    grid.innerHTML = cells;
    _dpApplyHighlight();   // paint the active range (preset OR custom) every render
  }
  _dpSetHint();
}
// Highlight the selected range on the calendar. With no override it reads the CURRENTLY active
// range (so presets like "This Week" highlight too); during selection it's called with the
// pending start + hovered day to preview the range. Endpoints render solid, the middle tinted.
function _dpApplyHighlight(lo, hi) {
  const grid = document.getElementById('date-picker-grid'); if (!grid) return;
  if (lo == null) {
    if (_dpPendingStart) { lo = hi = _dpPendingStart; }
    else { const d = getReportDates(); if (d) { lo = localDateStr(d.from); hi = localDateStr(d.to); } }
  }
  if (lo && hi && lo > hi) { const t = lo; lo = hi; hi = t; }
  const single = lo && lo === hi;
  grid.querySelectorAll('.dp-day').forEach(c => {
    const ds = c.dataset.date;
    c.classList.toggle('sel',      !!(single && ds === lo));
    c.classList.toggle('dp-range', !!(lo && hi && !single && ds >= lo && ds <= hi));
    c.classList.toggle('dp-rstart',!!(lo && hi && !single && ds === lo));
    c.classList.toggle('dp-rend',  !!(lo && hi && !single && ds === hi));
  });
}
function _dpSetHint() {
  const hint = document.getElementById('date-picker-hint'); if (!hint) return;
  hint.textContent = _dpPendingStart
    ? `Start ${_fmtDpDate(_dpPendingStart)} — click the end date (or the same day for one day)`
    : 'Click a day for that day, or click a start then an end date for a range.';
}
function _dpCellDate(el) { return el?.closest?.('.dp-day')?.dataset?.date || null; }
// Click-to-select: first click sets the start (awaiting a second click), second click closes the
// range. Same-day twice = a single day. Hover previews the range. Works on iPad (tap-tap; no hover).
function _dpClickDay(ds) {
  if (_dpPendingStart == null) {
    _dpPendingStart = ds;
    _dpApplyHighlight(ds, ds); _dpSetHint();
    return;
  }
  const a = _dpPendingStart; _dpPendingStart = null;
  const lo = a < ds ? a : ds, hi = a < ds ? ds : a;
  if (lo === hi) { selectRangeDay(lo); return; }
  reportRange.type = 'custom'; reportRange.from = lo; reportRange.to = hi;
  syncRangeButtons(); closeDatePicker(); runReport(); renderTransactions(); updateDateButtons();
}
function _wireDatePickerGrid() {
  if (_dpGridWired) return;
  const grid = document.getElementById('date-picker-grid'); if (!grid) return;
  _dpGridWired = true;
  grid.addEventListener('click', e => { const ds = _dpCellDate(e.target); if (ds) _dpClickDay(ds); });
  grid.addEventListener('mouseover', e => { if (_dpPendingStart == null) return; const ds = _dpCellDate(e.target); if (ds) _dpApplyHighlight(_dpPendingStart, ds); });
}

// ── Comparison menu ───────────────────────────────
export function openCompareMenu(ev) {
  const wrap = document.getElementById('compare-menu-list');
  if (wrap) {
    const saved = reportRange.compare;   // probe each option's resolved dates without changing state
    wrap.innerHTML = COMPARE_OPTS.map(([k, l]) => {
      reportRange.compare = k;
      const when = k === 'none' ? 'off' : (_cmpRangeShort(getCompareDates()) || '—');
      return `<button onclick="setReportCompare('${k}')" class="cmp-opt${saved === k ? ' active' : ''}" style="display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;text-align:left"><span>${l}</span><span class="text-on-surface-variant" style="font-size:11px;white-space:nowrap">${when}</span></button>`;
    }).join('');
    reportRange.compare = saved;
  }
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
  const cmpDates = reportRange.compare !== 'none' ? compareDatesLabel() : '';
  document.querySelectorAll('.compare-btn-label').forEach(el => el.textContent = reportRange.compare === 'none' ? 'No comparison' : `${cmp}${cmpDates ? ' · ' + cmpDates : ''}`);
  const rl = document.getElementById('report-range-label'); if (rl) rl.textContent = `Showing: ${rangeLabel()}${reportRange.compare !== 'none' ? ` · vs ${cmp}${cmpDates ? ' (' + cmpDates + ')' : ''}` : ''}`;
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
  const totalIncome = filtered.reduce((s,r)=>s+(r.totalCost||0),0);   // "Total Billed" — bill only, no tips; still drives Avg Ticket / Shop Keeps
  const guestCount = filtered.filter(r => isPaidStatus(r.status) && !r.quickSale).length;   // retail/gift-card-only Quick Sales aren't "guests"
  const avgTicket = guestCount > 0 ? totalIncome / guestCount : 0;
  const tipsTotal = filtered.reduce((s,r)=>s+(r.tip||0),0);
  // Payment Mix — how the money was actually collected (single source: paymentMix()).
  const { cardMix, cashMix, giftMix, zelleMix, otherMix, cardCnt, cashCnt, giftCnt, zelleCnt, otherCnt } = paymentMix(filtered, tipsTotal);

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  const tix = n => n > 0 ? (n === 1 ? '1 ticket' : n + ' tickets') : '';
  set('rpt-paycnt-card', tix(cardCnt)); set('rpt-paycnt-cash', tix(cashCnt)); set('rpt-paycnt-gift', tix(giftCnt)); set('rpt-paycnt-zelle', tix(zelleCnt)); set('rpt-paycnt-other', tix(otherCnt));
  set('rpt-total-guests', guestCount); set('rpt-avg-ticket', `$${avgTicket.toFixed(2)}`);
  set('rpt-svc-total', `$${svcTotal.toFixed(2)}`); set('rpt-items-total', `$${itemsTotal.toFixed(2)}`); set('rpt-fees-total', `$${feesTotal.toFixed(2)}`);
  set('rpt-discount-total', discountTotal > 0 ? `-$${discountTotal.toFixed(2)}` : '-$0.00');
  set('rpt-total-tips', `$${tipsTotal.toFixed(2)}`);
  set('rpt-pay-card', `$${cardMix.toFixed(2)}`); set('rpt-pay-cash', `$${cashMix.toFixed(2)}`); set('rpt-pay-gift', `$${giftMix.toFixed(2)}`); set('rpt-pay-zelle', `$${zelleMix.toFixed(2)}`); set('rpt-pay-other', `$${otherMix.toFixed(2)}`);
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
  const gcOutstanding = giftCards().reduce((s,g)=>s+Math.max(0,(g.amount||0)-gcTotalUsed(g)),0);   // authoritative redemption sum, floored at 0
  // Gross income = true new cash collected: billed work + new gift-card cash, minus
  // redemptions (those tickets are already in totalBilled but were paid from cards
  // sold earlier, so the redeemed portion isn't new cash this period).
  const grossIncome = totalIncome + gcSoldValue - gcRedeemed + tipsTotal;   // "Total Money Collected"
  set('rpt-gross-income', `$${grossIncome.toFixed(2)}`);
  set('rpt-gc-sold', `$${gcSoldValue.toFixed(2)}`);
  set('rpt-gc-redeemed', `$${gcRedeemed.toFixed(2)}`);
  const drawerEl = document.getElementById('rpt-drawer'); if (drawerEl) drawerEl.innerHTML = drawerReportHtml();
  const gcBreakdown = document.getElementById('rpt-giftcards-breakdown');
  if (gcBreakdown) {
    const row = (label, value, sub, onclick) => `<div class="bg-surface-container-lowest rounded-xl px-5 py-3 border border-surface-container-high flex items-center justify-between${onclick?' cursor-pointer hover:bg-surface-container transition-colors':''}"${onclick?` onclick="${onclick}"`:''}><div><div class="font-headline font-semibold text-on-surface text-sm">${label}</div><div class="text-xs font-body text-on-surface-variant">${sub}</div></div><div class="flex items-center gap-3"><div class="font-headline font-bold text-on-surface">${value}</div>${onclick?'<span class="material-symbols-outlined text-on-surface-variant" style="font-size:18px">chevron_right</span>':''}</div></div>`;
    gcBreakdown.innerHTML =
      row('Gift Cards Sold', `$${gcSoldValue.toFixed(2)}`, `${gcSold.length} card${gcSold.length!==1?'s':''} sold this period · tap for details`, "drillDownGiftcards('sold')") +
      row('Redeemed', `$${gcRedeemed.toFixed(2)}`, 'Used this period · tap for details', "drillDownGiftcards('redeemed')") +
      row('Outstanding Balance', `$${gcOutstanding.toFixed(2)}`, 'Unredeemed value across all gift cards');
  }

  renderDeltas({ totalIncome, grossIncome, guestCount, avgTicket, shopKeeps: totalIncome - totalComm, commission: totalComm, svcTotal, itemsTotal, feesTotal, discountTotal, gcSold: gcSoldValue, gcRedeemed, tipsTotal, cardMix, cashMix, giftMix, zelleMix, otherMix });
  renderPerformance(filtered, from, to);
  updateDateButtons();
  window._currentReportData = { filtered, from, to, totalIncome, guestCount, avgTicket, staffMap, svcMap, gcSoldValue, gcRedeemed, gcOutstanding, tipsTotal, cardMix, cashMix, giftMix, zelleMix, otherMix };
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
  L.push(`Muse Nails & Spa — ${rangeLabel()}`);
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
// the comparison side lines up with the displayed cards. Used for the prior period and
// by the Muse Reports phone app.
export function computeMetrics(from, to) {
  const filtered = buildCombinedRecords().filter(r => { if (r.status === 'deleted') return false; const d = new Date(r.checkinTime); return d >= from && d <= to && (isPaidStatus(r.status) || r.status === 'refund'); });
  const sum = (arr, f) => arr.reduce((s,x)=>s+f(x),0);
  const svcTotal = sum(filtered, r => sum(r.assignments||[], x => x.cost||0));
  const itemsTotal = sum(filtered, r => sum(r.items||[], x => (x.price||0)*(x.qty||0)));
  const feesTotal = sum(filtered, r => sum(r.fees||[], x => x.amount||0));
  const discountTotal = sum(filtered, r => r.discount||0);
  const totalIncome = sum(filtered, r => r.totalCost||0);
  const guestCount = filtered.filter(r => isPaidStatus(r.status) && !r.quickSale).length;   // retail/gift-card-only Quick Sales aren't "guests"
  const avgTicket = guestCount > 0 ? totalIncome / guestCount : 0;
  const staffInc = {};
  filtered.forEach(r => (r.assignments||[]).forEach(a => { if (a.techId) staffInc[a.techId] = (staffInc[a.techId]||0) + (a.cost||0); }));
  if (cfg().commission_includes_refunds) filtered.filter(r=>r.status==='refund').forEach(r => (r.refundTechBilled||[]).forEach(x => { if (x.techId) staffInc[x.techId] = (staffInc[x.techId]||0) + (x.billed||0); }));
  const commission = Object.entries(staffInc).reduce((s,[id,inc])=>{ const t = staffById(id); return t?.commission != null ? s + inc*t.commission/100 : s; }, 0);
  const inPeriod = ds => ds && ds >= localDateStr(from) && ds <= localDateStr(to);
  const gcSold = giftCards().filter(g => inPeriod(g.datePurchased)).reduce((s,g)=>s+(g.amount||0),0);
  const gcRedeemed = giftCards().reduce((s,g)=> s + gcRedemptions(g).reduce((a,r)=> a + (inPeriod(r.date) ? (r.amount||0) : 0), 0), 0);
  const tipsTotal = sum(filtered, r => r.tip||0);
  const { cardMix, cashMix, giftMix, zelleMix, otherMix } = paymentMix(filtered, tipsTotal);
  return { totalIncome, grossIncome: totalIncome + gcSold - gcRedeemed + tipsTotal, guestCount, avgTicket, shopKeeps: totalIncome - commission, commission, svcTotal, itemsTotal, feesTotal, discountTotal, gcSold, gcRedeemed, tipsTotal, cardMix, cashMix, giftMix, zelleMix, otherMix };
}
const _DELTA_CARDS = [
  ['rpt-gross-income-delta','grossIncome'], ['rpt-total-tips-delta','tipsTotal'], ['rpt-total-guests-delta','guestCount'], ['rpt-avg-ticket-delta','avgTicket'],
  ['rpt-shop-keeps-delta','shopKeeps'], ['rpt-total-commission-delta','commission'],
  ['rpt-svc-total-delta','svcTotal'], ['rpt-items-total-delta','itemsTotal'], ['rpt-fees-total-delta','feesTotal'],
  ['rpt-discount-total-delta','discountTotal'], ['rpt-gc-sold-delta','gcSold'], ['rpt-gc-redeemed-delta','gcRedeemed'],
  ['rpt-pay-card-delta','cardMix'], ['rpt-pay-cash-delta','cashMix'], ['rpt-pay-gift-delta','giftMix'], ['rpt-pay-zelle-delta','zelleMix'], ['rpt-pay-other-delta','otherMix'],
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

// ── Performance: bar graph with selectable time-grouping + metric + $/# unit ─────
const _DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const _fmtHour = h => { const ap = h < 12 ? 'a' : 'p'; const hh = h % 12 === 0 ? 12 : h % 12; return `${hh}${ap}`; };
let perfGran = 'hour', perfMetric = 'revenue', perfUnit = 'amount';   // device-local chart prefs
// units: '$' dollars-only · '#' count-only · '$#' either (the $/# toggle applies). gc:'sold'|'redeemed'
// pulls from the gift-card ledger (by date) instead of records; avg:true = per-bucket avg ticket.
const PERF_METRICS = [
  { key:'revenue',    label:'Total revenue',       units:'$',  val: r => r.totalCost || 0 },
  { key:'services',   label:'Services',            units:'$',  val: r => (r.assignments || []).reduce((s, a) => s + (a.cost || 0), 0) },
  { key:'guests',     label:'Guests served',       units:'#',  cnt: () => 1 },
  { key:'avg',        label:'Avg ticket',          units:'$',  avg: true },
  { key:'tips',       label:'Tips collected',      units:'$',  val: r => r.tip || 0 },
  { key:'fees',       label:'Fees collected',      units:'$',  val: r => (r.fees || []).reduce((s, f) => s + (f.amount || 0), 0) },
  { key:'items',      label:'Items sold',          units:'$#', val: r => (r.items || []).reduce((s, i) => s + (i.price || 0) * (i.qty || 0), 0), cnt: r => (r.items || []).reduce((s, i) => s + (i.qty || 0), 0) },
  { key:'card',       label:'Card',                units:'$#', val: r => (r.tenders && r.tenders.card) || 0,  cnt: r => (r.tenders && r.tenders.card  > 0) ? 1 : 0 },
  { key:'cash',       label:'Cash',                units:'$#', val: r => (r.tenders && r.tenders.cash) || 0,  cnt: r => (r.tenders && r.tenders.cash  > 0) ? 1 : 0 },
  { key:'zelle',      label:'Zelle',               units:'$#', val: r => (r.tenders && r.tenders.zelle) || 0, cnt: r => (r.tenders && r.tenders.zelle > 0) ? 1 : 0 },
  { key:'gcSold',     label:'Gift cards sold',     units:'$#', gc: 'sold' },
  { key:'gcRedeemed', label:'Gift cards redeemed', units:'$#', gc: 'redeemed' },
];
const _perfMetric = () => PERF_METRICS.find(m => m.key === perfMetric) || PERF_METRICS[0];
const _perfEffUnit = m => m.units === '$' ? 'amount' : m.units === '#' ? 'count' : perfUnit;
export function setPerfGran(g)   { perfGran = g;   runReport(); }
export function setPerfMetric(k) { perfMetric = k; runReport(); }
export function setPerfUnit(u)   { perfUnit = u;   runReport(); }

const _weekStart = d => { const x = _sod(d); const dow = x.getDay() === 0 ? 6 : x.getDay() - 1; return _addDays(x, -dow); };   // Monday-anchored
// Ordered bucket axis for a granularity over [from,to]: keys + display labels + a keyOf(date)→key.
function _perfAxis(from, to, gran) {
  const order = [], label = {};
  const add = (k, l) => { if (!(k in label)) { order.push(k); label[k] = l; } };
  if (gran === 'hour') { for (let h = 0; h < 24; h++) add(String(h), _fmtHour(h)); return { order, label, keyOf: d => String(d.getHours()), trim: true }; }
  if (gran === 'day')  { let d = _sod(from); while (d <= to) { add(localDateStr(d), d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })); d = _addDays(d, 1); } return { order, label, keyOf: d => localDateStr(d) }; }
  if (gran === 'week') { let d = _weekStart(from); while (d <= to) { add(localDateStr(d), d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })); d = _addDays(d, 7); } return { order, label, keyOf: d => localDateStr(_weekStart(d)) }; }
  if (gran === 'month'){ let d = new Date(from.getFullYear(), from.getMonth(), 1); while (d <= to) { const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); add(k, d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })); d = new Date(d.getFullYear(), d.getMonth() + 1, 1); } return { order, label, keyOf: d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') }; }
  for (let y = from.getFullYear(); y <= to.getFullYear(); y++) add(String(y), String(y));
  return { order, label, keyOf: d => String(d.getFullYear()) };
}
function _syncPerfControls(metric, unit) {
  document.querySelectorAll('#perf-gran button').forEach(b => { const on = b.dataset.g === perfGran; b.style.background = on ? 'var(--surface-container-lowest,#fff)' : 'transparent'; b.style.boxShadow = on ? '0 1px 3px rgba(0,0,0,.12)' : 'none'; b.style.color = on ? 'var(--on-surface)' : 'var(--on-surface-variant)'; });
  const sel = document.getElementById('perf-metric');
  if (sel) { if (sel.options.length !== PERF_METRICS.length) sel.innerHTML = PERF_METRICS.map(m => `<option value="${m.key}">${m.label}</option>`).join(''); sel.value = perfMetric; }
  const dual = metric.units === '$#';
  document.querySelectorAll('#perf-unit button').forEach(b => { const on = b.dataset.u === unit; b.disabled = !dual; b.style.opacity = dual ? '1' : '.4'; b.style.background = on ? 'var(--primary)' : 'transparent'; b.style.color = on ? '#fff' : 'var(--on-surface-variant)'; });
}
function renderPerformance(filtered, from, to) {
  const wrap = document.getElementById('rpt-perf'); if (!wrap) return;
  if (!from || !to) { const d = getReportDates(); if (d) { from = d.from; to = d.to; } }
  if (!from || !to) return;
  const metric = _perfMetric(), unit = _perfEffUnit(metric);
  _syncPerfControls(metric, unit);
  const axis = _perfAxis(from, to, perfGran);
  const acc = {}; axis.order.forEach(k => acc[k] = { v: 0, rev: 0, g: 0 });
  if (metric.gc) {
    giftCards().forEach(g => {
      if (metric.gc === 'sold') { if (g.datePurchased) { const d = new Date(g.datePurchased + 'T12:00:00'); if (d >= from && d <= to) { const k = axis.keyOf(d); if (acc[k]) acc[k].v += unit === 'count' ? 1 : (g.amount || 0); } } }
      else gcRedemptions(g).forEach(rd => { if (rd.date) { const d = new Date(rd.date + 'T12:00:00'); if (d >= from && d <= to) { const k = axis.keyOf(d); if (acc[k]) acc[k].v += unit === 'count' ? 1 : (rd.amount || 0); } } });
    });
  } else {
    filtered.filter(r => isPaidStatus(r.status)).forEach(r => {
      const k = axis.keyOf(new Date(r.checkinTime)); if (!acc[k]) return;
      if (metric.avg) { acc[k].rev += r.totalCost || 0; acc[k].g += 1; }
      else acc[k].v += unit === 'count' ? (metric.cnt ? metric.cnt(r) : 0) : (metric.val ? metric.val(r) : 0);
    });
    if (metric.avg) axis.order.forEach(k => { acc[k].v = acc[k].g > 0 ? acc[k].rev / acc[k].g : 0; });
  }
  // 'hour' = hour-of-day profile, trimmed to active hours; the rest = a continuous timeline.
  let keys = axis.order;
  if (axis.trim) {
    const active = axis.order.filter(k => acc[k].v > 0 || acc[k].g > 0).map(k => parseInt(k, 10));
    if (active.length) { const mn = Math.min(...active), mx = Math.max(...active); keys = []; for (let h = mn; h <= mx; h++) keys.push(String(h)); }
  }
  const vals = keys.map(k => acc[k].v);
  if (!vals.some(v => v > 0)) { wrap.innerHTML = '<p class="text-sm font-body text-on-surface-variant py-2">No data in this period yet.</p>'; return; }
  const maxV = Math.max(...vals, 1);
  const fmtFull = v => unit === 'count' ? String(Math.round(v)) : '$' + v.toFixed(2);
  const yLab = v => unit === 'count' ? String(Math.round(v)) : (v >= 1000 ? '$' + (v / 1000).toFixed(1) + 'k' : '$' + Math.round(v));
  const bars = keys.map(k => { const v = acc[k].v, pct = Math.round(v / maxV * 100); return `<div class="perf-col" style="min-width:24px" title="${axis.label[k]}: ${fmtFull(v)}"><div class="perf-bar" style="height:${pct}%"></div><div class="perf-x">${axis.label[k]}</div></div>`; }).join('');
  const yAxis = `<div class="perf-yaxis"><span>${yLab(maxV)}</span><span>${yLab(maxV / 2)}</span><span>${unit === 'count' ? '0' : '$0'}</span></div>`;
  const withData = keys.map(k => ({ k, v: acc[k].v })).filter(x => x.v > 0);
  const best = withData.reduce((a, b) => b.v > a.v ? b : a, withData[0]);
  const total = vals.reduce((s, v) => s + v, 0);
  const gNoun = perfGran;
  const card = (l, v) => `<div class="bg-surface-container-lowest rounded-xl px-4 py-2.5 border border-surface-container-high"><div class="text-[10px] font-body uppercase tracking-widest text-on-surface-variant">${l}</div><div class="text-sm font-headline font-bold text-on-surface mt-0.5">${v}</div></div>`;
  let insights;
  if (metric.avg) {
    let rev = 0, g = 0; keys.forEach(k => { rev += acc[k].rev; g += acc[k].g; });
    insights = card(`Best ${gNoun}`, axis.label[best.k]) + card('Overall avg', '$' + (g > 0 ? rev / g : 0).toFixed(2)) + card(`${gNoun}s with sales`, String(withData.length));
  } else {
    insights = card(`Best ${gNoun}`, axis.label[best.k]) + card('Total', fmtFull(total)) + card(`Avg / ${gNoun}`, fmtFull(withData.length ? total / withData.length : 0));
  }
  const yTitle = `${metric.label} ${unit === 'count' ? '(#)' : '($)'} — by ${gNoun}`;
  wrap.innerHTML = `<div class="text-xs font-body text-on-surface-variant mb-2">${yTitle}</div><div class="perf-plot">${yAxis}<div class="perf-chart" style="overflow-x:auto">${bars}</div></div>
    <div class="grid grid-cols-3 gap-2 mt-4">${insights}</div>`;
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
// Shared simple drill row: customer · optional sub-line · time, with a right-aligned amount.
const _drillRow = (customer, time, amount, sub, neg) => `<div class="bg-surface-container-lowest rounded-xl px-5 py-3 border border-surface-container-high flex items-center justify-between"><div class="min-w-0"><div class="font-headline font-semibold text-on-surface text-sm truncate">${customer}</div>${sub?`<div class="text-xs font-body text-on-surface-variant truncate">${sub}</div>`:''}<div class="text-[11px] font-body text-outline">${time.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} · ${time.toLocaleDateString()}</div></div><div class="font-headline font-bold flex-shrink-0 ml-3 ${neg?'text-error':'text-on-surface'}">${neg?'-':''}$${amount.toFixed(2)}</div></div>`;
const _drillTime = r => new Date(r.completedAt || r.checkinTime);
// Compact total bar (count + total) shown above the rows so the drill confirms the card's number.
const _drillSummaryBar = summary => `<div class="bg-primary/10 rounded-xl border border-primary/30 flex divide-x divide-primary/20 mb-2 sticky top-0 z-10">${summary.map(([l,v])=>`<div class="flex-1 px-3 py-2 text-center"><div class="text-[10px] font-body text-on-surface-variant uppercase tracking-widest">${l}</div><div class="font-headline font-bold text-on-surface text-base">${v}</div></div>`).join('')}</div>`;
const _drillBody = (summary, rows, html) => _drillSummaryBar(summary) + (rows.length ? html : '<p class="text-sm font-body text-on-surface-variant text-center py-4 opacity-70">None this period.</p>');

// Tap the "Total Tips" card → every ticket that carried a card tip this period.
export function drillDownTips() {
  const d = window._currentReportData; if (!d) return;
  const rows = d.filtered.filter(r => (r.tip||0) > 0).map(r => ({ customer: r.name||'(no name)', time: _drillTime(r), amount: r.tip||0 })).sort((a,b)=>b.time-a.time);
  const total = rows.reduce((s,r)=>s+r.amount,0);
  _drill = { title:'Total Tips — Detail', columns:['Date','Time','Customer','Tip'], rows: rows.map(r=>[r.time.toLocaleDateString(), r.time.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}), r.customer, '$'+r.amount.toFixed(2)]), summary:[['Tickets with tips', String(rows.length)], ['Total Tips', '$'+total.toFixed(2)]] };
  showDrillPanel(_drill.title, _drillBody(_drill.summary, rows, rows.map(r=>_drillRow(r.customer, r.time, r.amount)).join('')));
}

// Tap "Retail Items" → one row per item line (a 2-item ticket shows twice).
export function drillDownItems() {
  const d = window._currentReportData; if (!d) return;
  const rows = [];
  d.filtered.forEach(r => (r.items||[]).forEach(x => { const qty = x.qty||0; if (qty <= 0) return; const label = cfg().items.find(i=>i.id===x.itemId)?.label || x.itemId || 'Item'; rows.push({ customer: r.name||'(no name)', time: _drillTime(r), label, qty, amount: (x.price||0)*qty }); }));
  rows.sort((a,b)=>b.time-a.time);
  const total = rows.reduce((s,r)=>s+r.amount,0), qtyTotal = rows.reduce((s,r)=>s+r.qty,0);
  _drill = { title:'Retail Items — Detail', columns:['Date','Time','Customer','Item','Qty','Total'], rows: rows.map(r=>[r.time.toLocaleDateString(), r.time.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}), r.customer, r.label, String(r.qty), '$'+r.amount.toFixed(2)]), summary:[['Items sold', String(qtyTotal)], ['Total', '$'+total.toFixed(2)]] };
  showDrillPanel(_drill.title, _drillBody(_drill.summary, rows, rows.map(r=>_drillRow(r.customer, r.time, r.amount, `${r.label} × ${r.qty}`)).join('')));
}

// Tap the "Fees" total → every fee line charged this period (all fee types together).
export function drillDownFeesAll() {
  const d = window._currentReportData; if (!d) return;
  const rows = [];
  d.filtered.forEach(r => (r.fees||[]).forEach(f => { const amt = f.amount||0; if (!amt) return; const label = cfg().fees.find(x=>x.id===f.feeId)?.label || f.label || 'Fee'; rows.push({ customer: r.name||'(no name)', time: _drillTime(r), label, amount: amt }); }));
  rows.sort((a,b)=>b.time-a.time);
  const total = rows.reduce((s,r)=>s+r.amount,0);
  _drill = { title:'Fees — Detail', columns:['Date','Time','Customer','Fee','Amount'], rows: rows.map(r=>[r.time.toLocaleDateString(), r.time.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}), r.customer, r.label, '$'+r.amount.toFixed(2)]), summary:[['Fees charged', String(rows.length)], ['Total', '$'+total.toFixed(2)]] };
  showDrillPanel(_drill.title, _drillBody(_drill.summary, rows, rows.map(r=>_drillRow(r.customer, r.time, r.amount, r.label)).join('')));
}

// Tap "Discounts" → every ticket with a discount (+ the reason note).
export function drillDownDiscounts() {
  const d = window._currentReportData; if (!d) return;
  const rows = d.filtered.filter(r => (r.discount||0) > 0).map(r => ({ customer: r.name||'(no name)', time: _drillTime(r), sub: r.discountNote||'', amount: r.discount||0 })).sort((a,b)=>b.time-a.time);
  const total = rows.reduce((s,r)=>s+r.amount,0);
  _drill = { title:'Discounts — Detail', columns:['Date','Time','Customer','Reason','Discount'], rows: rows.map(r=>[r.time.toLocaleDateString(), r.time.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}), r.customer, r.sub, '-$'+r.amount.toFixed(2)]), summary:[['Discounted tickets', String(rows.length)], ['Total Discounts', '-$'+total.toFixed(2)]] };
  showDrillPanel(_drill.title, _drillBody(_drill.summary, rows, rows.map(r=>_drillRow(r.customer, r.time, r.amount, r.sub, true)).join('')));
}

// Tap a Payment Mix box → every ticket collected via that tender this period.
// card/cash/gift read r.tenders (only a party's primary ticket carries them, so each party
// shows once); "other" = paid sales with no recorded tender. Each kind's total reconciles to
// its Payment Mix headline: card includes the card tip (same swipe), other sums totalCost of
// untracked sales (matching otherMix, refunds included since they carry no tenders).
export function drillDownPay(kind) {
  const d = window._currentReportData; if (!d) return;
  const meta = {
    card:  { title: 'Card Payments — Detail',        label: 'Card (incl. tips)', col: 'Card' },
    cash:  { title: 'Cash Payments — Detail',        label: 'Cash',              col: 'Cash' },
    gift:  { title: 'Gift Card Payments — Detail',   label: 'Gift Card',         col: 'Gift Card' },
    zelle: { title: 'Zelle Payments — Detail',       label: 'Zelle',             col: 'Zelle' },
    other: { title: 'Other / Untracked — Detail',    label: 'Other / Untracked', col: 'Amount' },
  }[kind];
  if (!meta) return;
  const otherGroups = kind === 'other' ? tenderedGroupIds(d.filtered) : null;
  const rows = [];
  d.filtered.forEach(r => {
    let amount = 0, sub = '';
    if (kind === 'other') {
      if (!isOtherTender(r, otherGroups)) return;              // matches otherMix (excludes tendered-party members)
      amount = r.totalCost || 0;
      if (r.status === 'refund') sub = 'refund';
    } else if (kind === 'card') {
      if (!r.tenders) return;
      amount = (r.tenders.card || 0) + (r.tip || 0);           // tip rides on the same card → matches cardMix
      if (amount <= 0) return;
      if ((r.tip || 0) > 0) sub = `incl. $${(r.tip).toFixed(2)} tip`;
    } else {                                                    // cash | gift
      if (!r.tenders || !(r.tenders[kind] > 0)) return;
      amount = r.tenders[kind];
      if (kind === 'cash' && (r.tenders.change || 0) > 0) sub = `received $${(r.tenders.cashReceived || 0).toFixed(2)} · change $${(r.tenders.change).toFixed(2)}`;
    }
    rows.push({ customer: r.name || '(no name)', time: _drillTime(r), amount, sub, neg: amount < 0 });
  });
  rows.sort((a, b) => b.time - a.time);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  _drill = {
    title: meta.title,
    columns: ['Date', 'Time', 'Customer', 'Note', meta.col],
    rows: rows.map(r => [r.time.toLocaleDateString(), r.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), r.customer, r.sub, (r.neg ? '-' : '') + '$' + Math.abs(r.amount).toFixed(2)]),
    summary: [['Tickets', String(rows.length)], [meta.label, '$' + total.toFixed(2)]],
  };
  showDrillPanel(_drill.title, _drillBody(_drill.summary, rows, rows.map(r => _drillRow(r.customer, r.time, Math.abs(r.amount), r.sub, r.neg)).join('')));
}

// Tap "Refunds Issued" → every refund record this period (reason + amount).
export function drillDownRefunds() {
  const d = window._currentReportData; if (!d) return;
  const rows = d.filtered.filter(r => r.status === 'refund')
    .map(r => ({ customer: r.name || '(no name)', time: _drillTime(r), amount: Math.abs(r.totalCost || 0), sub: r.discountNote || '' }))
    .sort((a, b) => b.time - a.time);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  _drill = {
    title: 'Refunds Issued — Detail',
    columns: ['Date', 'Time', 'Customer', 'Reason', 'Refund'],
    rows: rows.map(r => [r.time.toLocaleDateString(), r.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), r.customer, r.sub, '-$' + r.amount.toFixed(2)]),
    summary: [['Refunds', String(rows.length)], ['Total Refunded', '-$' + total.toFixed(2)]],
  };
  showDrillPanel(_drill.title, _drillBody(_drill.summary, rows, rows.map(r => _drillRow(r.customer, r.time, r.amount, r.sub, true)).join('')));
}

// ── Reconciliation: recorded total vs the amount actually charged ───────────────
// Flags paid tickets in the current period where the recorded bill ≠ what the customer was
// charged (tenders card+cash+gift). +diff = charged MORE than recorded (a dropped fee → record
// is short → shrinks Total Money Collected). −diff = recorded MORE than charged (e.g. a gift card
// not captured in the tender split). Tickets paid before tender-tracking (older / direct Mark-
// Paid) carry no tenders and can't be auto-checked — those are listed as a count to hand-check.
export function openReconcile() {
  const dates = getReportDates(); if (!dates) { showToast('Pick a date range first.'); return; }
  const { from, to } = dates;
  const recs = buildCombinedRecords().filter(r => {
    if (r.status === 'deleted' || !isPaidStatus(r.status)) return false;
    const d = new Date(r.completedAt || r.checkinTime);
    return d >= from && d <= to;
  });
  const groups = {};
  recs.forEach(r => { const k = r.groupId || ('solo:' + r.id); (groups[k] = groups[k] || []).push(r); });
  const rows = []; let unchecked = 0;
  Object.values(groups).forEach(members => {
    const withT = members.find(m => m.tenders);
    if (!withT) { unchecked++; return; }
    const t = withT.tenders;
    const charged = Math.round(((t.card||0)+(t.cash||0)+(t.gift||0)+(t.zelle||0))*100)/100;
    // Gift cards SOLD are charged on top of the bill (liability, not in totalCost) — count them on the
    // recorded side too, so a gift-card sale doesn't read as a mismatch.
    const recorded = Math.round(members.reduce((s,m)=>s+(m.totalCost||0)+(m.giftcardSales||[]).reduce((a,g)=>a+(+g.amount||0),0),0)*100)/100;
    const diff = Math.round((charged - recorded)*100)/100;
    if (Math.abs(diff) >= 0.01) rows.push({ id: String(withT.id), names: members.map(m=>m.name).join(' & '), time: new Date(withT.completedAt||withT.checkinTime), recorded, charged, diff });
  });
  rows.sort((a,b)=>b.time-a.time);
  const totalDiff = Math.round(rows.reduce((s,r)=>s+r.diff,0)*100)/100;
  _drill = { title:'Reconciliation — recorded vs charged', columns:['Date','Customer','Recorded','Charged','Difference'],
    rows: rows.map(r=>[r.time.toLocaleDateString(), r.names, '$'+r.recorded.toFixed(2), '$'+r.charged.toFixed(2), (r.diff>=0?'+':'-')+'$'+Math.abs(r.diff).toFixed(2)]),
    summary:[['Mismatches', String(rows.length)], ['Net difference', (totalDiff>=0?'+':'-')+'$'+Math.abs(totalDiff).toFixed(2)]] };
  const note = unchecked ? `<div class="text-[11px] font-body text-on-surface-variant mb-2 px-1">${unchecked} ticket${unchecked!==1?'s':''} can't be auto-checked (paid before card-tender tracking / direct Mark-Paid) — compare those to Square by hand.</div>` : '';
  const body = rows.length ? rows.map(r => {
    const over = r.diff > 0;   // charged > recorded → record short (likely a dropped fee)
    const col = over ? '#c53030' : '#9a4a00', label = over ? 'record short' : 'record over';
    return `<div onclick="closeDrillDown(); showHistoricalEntryModal('${r.id}')" class="bg-surface-container-lowest rounded-xl px-5 py-3 border border-surface-container-high flex items-center justify-between cursor-pointer hover:bg-surface-container transition-colors"><div class="min-w-0"><div class="font-headline font-semibold text-on-surface text-sm truncate">${r.names}</div><div class="text-[11px] font-body text-on-surface-variant">recorded $${r.recorded.toFixed(2)} · charged $${r.charged.toFixed(2)}</div><div class="text-[11px] font-body text-outline">${r.time.toLocaleDateString()} · tap to open &amp; fix</div></div><div class="text-right flex-shrink-0 ml-3"><div class="font-headline font-bold" style="color:${col}">${over?'+':'−'}$${Math.abs(r.diff).toFixed(2)}</div><div class="text-[10px] font-body" style="color:${col}">${label}</div></div></div>`;
  }).join('') : '<p class="text-sm font-body text-on-surface-variant text-center py-4">Everything matches what was charged — no mismatches this period. ✓</p>';
  showDrillPanel(_drill.title, _drillSummaryBar(_drill.summary) + note + body);
}

// ── Square Settlement Reconciliation: app records vs Square's ACTUAL payments ────────
// The other reconcile (openReconcile) checks the app against its OWN recorded tenders. This one
// pulls the REAL payments from Square (List Payments) and matches them to records by the stored
// squarePaymentId, so you see the true charged total and exactly which transactions don't line up:
//   • in Square, not in the app  → charged but unrecorded (or recorded without the payment id)
//   • in the app, not in Square  → recorded/marked-paid with no matching Square charge
// Pure matcher (testable). payments: [{id,total,tip,status,sourceType,last4,note,createdAt}] (cents).
export function reconcileSquareData(payments, recs, giftSales, refunds) {
  const completed = (payments || []).filter(p => p.status === 'COMPLETED' || p.status === 'APPROVED');
  const net = p => (p.total || 0) - (p.refunded || 0);
  // A FULLY-refunded payment is net zero (money came in and went back out) — it's resolved, so it's
  // not a reconciliation discrepancy: exclude it from the counts + the "not in app" list.
  const live = completed.filter(p => net(p) > 0);
  const appIds = new Set();
  (recs || []).forEach(r => (r.squarePaymentIds || []).forEach(id => appIds.add(id)));
  // Gift-card SALES are charged through Square too, so their payments are legitimately in Square —
  // count them as matched (not "in Square, not app") and toward the app total.
  (giftSales || []).forEach(g => (g.squarePaymentIds || []).forEach(id => appIds.add(id)));
  const sqIds = new Set(completed.map(p => p.id));
  const inSquareNotApp = live.filter(p => !appIds.has(p.id));
  // A record is a real "in app, not Square" discrepancy only if it carried money that SHOULD be in
  // Square (card + cash + Zelle > 0) yet has no matching Square payment. A sale paid entirely by gift
  // card is a REDEMPTION — that money was collected when the card was sold, so it never hits Square
  // again and isn't a discrepancy. Tender-less legacy records fall back to their full total.
  const expectsSquare = r => r.tenders ? ((r.tenders.card || 0) + (r.tenders.cash || 0) + (r.tenders.zelle || 0)) > 0.005 : (r.totalCost || 0) > 0.005;
  const inAppNotSquare = (recs || []).filter(r => expectsSquare(r) && !(r.squarePaymentIds || []).some(id => sqIds.has(id)));
  // App's view of what SHOULD be in Square = card + cash + Zelle + tips (gift-card REDEMPTIONS never
  // hit Square, so excluded; tips ARE in Square; gift-card SALES paid via Square are added; refunds
  // are subtracted to match Square's net). A tender-less record (older / deep-link era) has no
  // breakdown, so fall back to its full total.
  const recCents = (recs || []).reduce((s, r) => {
    const sq = r.tenders ? ((r.tenders.card || 0) + (r.tenders.cash || 0) + (r.tenders.zelle || 0)) : (r.totalCost || 0);
    return s + Math.round((sq + (r.tip || 0)) * 100);
  }, 0);
  // Count a gift-card SALE only when its Square payment actually appears in this batch — matching by
  // the real payment id (not the card's recorded purchase date, which can be blank or back-dated) and
  // naturally scoping the total to the period, since the fetched payments ARE the period.
  const giftCents = (giftSales || []).reduce((s, g) => ((g.squarePaymentIds || []).some(id => sqIds.has(id)) ? s + Math.round((g.amount || 0) * 100) : s), 0);
  const refundCents = (refunds || []).reduce((s, r) => s + Math.round(Math.abs(r.totalCost || 0) * 100), 0);
  return {
    squareCount: live.length,
    matchedCount: live.length - inSquareNotApp.length,
    inSquareNotApp, inAppNotSquare,
    squareTotalCents: completed.reduce((s, p) => s + net(p), 0),   // net of refunds (matches the deposit)
    appTotalCents: recCents + giftCents - refundCents,
  };
}
// Paginated List Payments via the Square proxy (amounts already in cents/minor units).
async function fetchSquarePayments(beginISO, endISO, locationId) {
  const out = [];
  let cursor = '';
  for (let page = 0; page < 12; page++) {   // safety cap ~1200 payments
    const params = new URLSearchParams({ begin_time: beginISO, end_time: endISO, location_id: locationId, sort_order: 'ASC', limit: '100' });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`${SQUARE_PROXY}/v2/payments?${params.toString()}`);
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.errors?.[0]?.detail || `Square error ${res.status}`); }
    const j = await res.json();
    (j.payments || []).forEach(p => out.push({
      id: p.id,
      total: p.total_money?.amount || 0,
      refunded: p.refunded_money?.amount || 0,   // how much of this payment has been refunded
      tip: p.tip_money?.amount || 0,
      status: p.status || '',
      sourceType: p.source_type || '',
      last4: p.card_details?.card?.last_4 || '',
      note: p.note || '',
      createdAt: p.created_at || '',
    }));
    cursor = j.cursor || '';
    if (!cursor) break;
  }
  return out;
}
export async function openSquareReconcile() {
  const dates = getReportDates(); if (!dates) { showToast('Pick a date range first.'); return; }
  const sc = cfg().square_config;
  if (!sc?.locationId) { showToast('Add your Square Location ID in Settings → Square first.'); return; }
  const { from, to } = dates;
  showDrillPanel('Square Reconciliation', '<p class="text-sm font-body text-on-surface-variant text-center py-6">Pulling transactions from Square…</p>');
  let payments;
  try { payments = await fetchSquarePayments(from.toISOString(), to.toISOString(), sc.locationId); }
  catch (e) { showDrillPanel('Square Reconciliation', `<p class="text-sm font-body text-error text-center py-6">Couldn't load Square payments: ${(e.message || 'error')}</p>`); return; }
  const recs = buildCombinedRecords().filter(r => {
    if (r.status === 'deleted' || !isPaidStatus(r.status)) return false;
    const d = new Date(r.completedAt || r.checkinTime);
    return d >= from && d <= to;
  });
  // Every gift-card SALE charged through Square (has a payment id). The matcher scopes these to the
  // period by matching their ids against the fetched Square payments — more reliable than the card's
  // recorded purchase date (which defaults to today but can be edited / left blank).
  const giftSales = giftCards().filter(g => (g.squarePaymentIds || []).length);
  // Refunds in this period — subtracted from the app side so it nets like Square's deposit.
  const refundRecs = buildCombinedRecords().filter(r => { if (r.status !== 'refund') return false; const d = new Date(r.completedAt || r.checkinTime); return d >= from && d <= to; });
  const R = reconcileSquareData(payments, recs, giftSales, refundRecs);
  const $ = c => '$' + (c / 100).toFixed(2);
  const diff = R.squareTotalCents - R.appTotalCents;
  const summary = [
    ['Square collected', $(R.squareTotalCents)],
    ['App (card+cash+Zelle+tips)', $(R.appTotalCents)],
    ['Difference', (diff >= 0 ? '+' : '−') + '$' + Math.abs(diff / 100).toFixed(2)],
    ['Matched', `${R.matchedCount}/${R.squareCount}`],
  ];
  const fmtTime = iso => { try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };
  const sqRows = R.inSquareNotApp.length ? R.inSquareNotApp.map(p => {
    const label = (p.note || '(no note)').replace(/^Custom Amount - /, '');
    const src = p.sourceType === 'CARD' ? (p.last4 ? 'Card ••' + p.last4 : 'Card') : (p.sourceType === 'EXTERNAL' ? 'External' : p.sourceType === 'CASH' ? 'Cash' : p.sourceType || '');
    return `<div class="bg-surface-container-lowest rounded-xl px-4 py-2.5 border border-surface-container-high flex items-center justify-between"><div class="min-w-0"><div class="font-headline font-semibold text-on-surface text-sm truncate">${_eTxn(label)}</div><div class="text-[11px] font-body text-outline">${fmtTime(p.createdAt)} · ${src}</div></div><div class="font-headline font-bold text-on-surface flex-shrink-0 ml-3">${$(p.total)}</div></div>`;
  }).join('') : '<p class="text-xs font-body text-on-surface-variant py-2 px-1 opacity-70">None — every Square charge is tied to an app record. ✓</p>';
  const appRows = R.inAppNotSquare.length ? R.inAppNotSquare.map(r => {
    const tnd = r.tenders ? Object.entries({ card: r.tenders.card, cash: r.tenders.cash, gift: r.tenders.gift, zelle: r.tenders.zelle }).filter(([, v]) => v > 0).map(([k]) => k).join('+') : 'no tender';
    return `<div class="bg-surface-container-lowest rounded-xl px-4 py-2.5 border border-surface-container-high flex items-center justify-between"><div class="min-w-0"><div class="font-headline font-semibold text-on-surface text-sm truncate">${_eTxn(r.name || '(no name)')}</div><div class="text-[11px] font-body text-outline">${new Date(r.completedAt || r.checkinTime).toLocaleDateString()} · ${tnd}</div></div><div class="font-headline font-bold text-on-surface flex-shrink-0 ml-3">$${(r.totalCost || 0).toFixed(2)}</div></div>`;
  }).join('') : '<p class="text-xs font-body text-on-surface-variant py-2 px-1 opacity-70">None — every app sale matches a Square charge. ✓</p>';
  const section = (title, n, rows, hint) => `<div class="text-xs font-headline font-bold text-on-surface uppercase tracking-widest mt-3 mb-1.5">${title} <span class="text-on-surface-variant">(${n})</span></div><div class="text-[11px] font-body text-on-surface-variant mb-2 px-1">${hint}</div><div class="space-y-1.5">${rows}</div>`;
  _drill = {
    title: 'Square Reconciliation',
    columns: ['Side', 'When', 'Who', 'Source / Tender', 'Amount'],
    rows: [
      ...R.inSquareNotApp.map(p => ['In Square, not app', fmtTime(p.createdAt), (p.note || '').replace(/^Custom Amount - /, ''), p.sourceType + (p.last4 ? ' ••' + p.last4 : ''), $(p.total)]),
      ...R.inAppNotSquare.map(r => ['In app, not Square', new Date(r.completedAt || r.checkinTime).toLocaleDateString(), r.name || '', r.tenders ? 'tender' : 'no tender', '$' + (r.totalCost || 0).toFixed(2)]),
    ],
    summary,
  };
  showDrillPanel('Square Reconciliation',
    _drillSummaryBar(summary)
    + section('In Square, not in the app', R.inSquareNotApp.length, sqRows, 'Charged in Square but no app record carries this payment — charged-but-unrecorded, or recorded before payment-ID tracking.')
    + section('In the app, not matched to Square', R.inAppNotSquare.length, appRows, 'Marked paid in the app with no matching Square charge — older Mark-Paid / deep-link sales, or a possible double-record.'));
}

// Reconcile against Helcim: pull the terminal's APPROVED purchases for the period and match them to
// records by the stored transaction id (Helcim sales record their transactionId in squarePaymentIds).
export async function helcimReconcile() {
  const dates = getReportDates(); if (!dates) { showToast('Pick a date range first.'); return; }
  if (!cfg().helcim_device_code) { showToast('Set your Helcim terminal in Settings → Payments first.'); return; }
  const { from, to } = dates;
  showDrillPanel('Helcim Reconciliation', '<p class="text-sm font-body text-on-surface-variant text-center py-6">Pulling transactions from Helcim…</p>');
  let txns;
  try {
    const r = await fetch(`${HELCIM_PROXY}/transactions?dateFrom=${localDateStr(from)}&dateTo=${localDateStr(to)}`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json().catch(() => ({}));
    const arr = Array.isArray(j) ? j : (j.value || j.data || j.transactions || j.cardTransactions || []);
    txns = arr.filter(t => String(t.type || '').toLowerCase().includes('purchase') && String(t.status || '').toUpperCase() === 'APPROVED');
  } catch (e) {
    showDrillPanel('Helcim Reconciliation', `<p class="text-sm font-body text-error text-center py-6">Couldn't load Helcim transactions: ${(e.message || 'error')}.<br>Is the Worker deployed with the /helcim/transactions endpoint?</p>`);
    return;
  }
  const recs = buildCombinedRecords().filter(r => {
    if (r.status === 'deleted' || !isPaidStatus(r.status)) return false;
    const d = new Date(r.completedAt || r.checkinTime); return d >= from && d <= to;
  });
  const recByTxn = new Map();
  recs.forEach(r => (r.squarePaymentIds || []).forEach(id => recByTxn.set(String(id), r)));
  const txnId = t => String(t.transactionId || t.id || '');
  const matched = txns.filter(t => recByTxn.has(txnId(t)));
  const inHelcimNotApp = txns.filter(t => !recByTxn.has(txnId(t)));
  const helcimTxnIds = new Set(txns.map(txnId));
  const inAppNotHelcim = recs.filter(r => {
    if (!(r.tenders && r.tenders.card > 0)) return false;
    return !(r.squarePaymentIds || []).some(id => helcimTxnIds.has(String(id)));
  });
  const helcimCents = txns.reduce((s, t) => s + Math.round((+t.amount || 0) * 100), 0);
  const $ = c => '$' + (c / 100).toFixed(2);
  const fmtTime = iso => { try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };
  // Reconciliation identity: recorded card (+tips) + the surcharge Helcim adds on top (Fee Saver —
  // customer-paid, NOT salon revenue) + charges not yet recorded in the app = Helcim's gross total.
  // The surcharge is why the app's card total reads lower than Helcim's: the app books the bill, Helcim
  // charges bill + surcharge. (A real per-ticket mismatch still shows in the two lists below.)
  let matchedRecCents = 0, surchargeCents = 0;
  matched.forEach(t => {
    const r = recByTxn.get(txnId(t));
    const recCard = Math.round(((r?.tenders?.card || 0) + (r?.tip || 0)) * 100);
    matchedRecCents += recCard;
    surchargeCents += Math.round((+t.amount || 0) * 100) - recCard;
  });
  const unrecordedCents = inHelcimNotApp.reduce((s, t) => s + Math.round((+t.amount || 0) * 100), 0);
  const summary = [
    ['Helcim charged', $(helcimCents)],
    ['Card charges', String(txns.length)],
    ['Matched to a record', `${matched.length}/${txns.length}`],
    ['Recorded card + tips', $(matchedRecCents)],
    ['Surcharge (Fee Saver)', $(surchargeCents)],
    ['Charged, not yet recorded', $(unrecordedCents)],
  ];
  const card = (title, sub, amt) => `<div class="bg-surface-container-lowest rounded-xl px-4 py-2.5 border border-surface-container-high flex items-center justify-between"><div class="min-w-0"><div class="font-headline font-semibold text-on-surface text-sm truncate">${_eTxn(title)}</div><div class="text-[11px] font-body text-outline">${_eTxn(sub)}</div></div><div class="font-headline font-bold text-on-surface flex-shrink-0 ml-3">${amt}</div></div>`;
  const hRows = inHelcimNotApp.length ? inHelcimNotApp.map(t => card(t.cardHolderName || t.invoiceNumber || '(charge)', `${fmtTime(t.dateCreated)} · ${t.cardType || t.type || 'card'}`, '$' + (+t.amount || 0).toFixed(2))).join('') : '<p class="text-xs font-body text-on-surface-variant py-2 px-1 opacity-70">None — every Helcim charge ties to an app record. ✓</p>';
  const aRows = inAppNotHelcim.length ? inAppNotHelcim.map(r => card(r.name || '(no name)', `${new Date(r.completedAt || r.checkinTime).toLocaleDateString()} · card`, '$' + (r.totalCost || 0).toFixed(2))).join('') : '<p class="text-xs font-body text-on-surface-variant py-2 px-1 opacity-70">None — every app card sale matches a Helcim charge. ✓</p>';
  const section = (title, n, rows, hint) => `<div class="text-xs font-headline font-bold text-on-surface uppercase tracking-widest mt-3 mb-1.5">${title} <span class="text-on-surface-variant">(${n})</span></div><div class="text-[11px] font-body text-on-surface-variant mb-2 px-1">${hint}</div><div class="space-y-1.5">${rows}</div>`;
  _drill = {
    title: 'Helcim Reconciliation',
    columns: ['Side', 'When', 'Who', 'Detail', 'Amount'],
    rows: [
      ...inHelcimNotApp.map(t => ['In Helcim, not app', fmtTime(t.dateCreated), t.cardHolderName || t.invoiceNumber || '', t.cardType || t.type || '', '$' + (+t.amount || 0).toFixed(2)]),
      ...inAppNotHelcim.map(r => ['In app, not Helcim', new Date(r.completedAt || r.checkinTime).toLocaleDateString(), r.name || '', 'card', '$' + (r.totalCost || 0).toFixed(2)]),
    ],
    summary,
  };
  const reconNote = `<div class="text-[11px] font-body text-on-surface-variant mb-1 px-1 py-2 bg-surface-container-low rounded-lg">Recorded card + tips <b>${$(matchedRecCents)}</b> + Fee Saver surcharge <b>${$(surchargeCents)}</b> + not-yet-recorded <b>${$(unrecordedCents)}</b> = Helcim <b>${$(helcimCents)}</b>. The surcharge is the customer-paid card fee Helcim adds on top — it isn't salon revenue, so the app's card total is correctly lower than Helcim's gross.</div>`;
  showDrillPanel('Helcim Reconciliation',
    _drillSummaryBar(summary)
    + reconNote
    + section('In Helcim, not in the app', inHelcimNotApp.length, hRows, 'Charged on the terminal but no app record carries this transaction id — charged-but-unrecorded.')
    + section('In the app, not matched to Helcim', inAppNotHelcim.length, aRows, 'Marked paid with a card in the app but no matching Helcim charge — a Square-era card sale, or a possible mismatch.'));
}
// The Transactions "Reconcile" button routes to whichever processor is active.
export function openProcessorReconcile() { if (helcimActive()) helcimReconcile(); else openSquareReconcile(); }

function showDrillPanel(title, html) {
  document.getElementById('rpt-drill-title').textContent = title;
  document.getElementById('rpt-drill-list').innerHTML = html || '<p class="text-sm font-body text-on-surface-variant">No detail available.</p>';
  const m = document.getElementById('rpt-drill-modal'); if (m) { m.classList.remove('hidden'); m.style.display = 'flex'; }
}
export function closeDrillDown() { _tcDraft = null; _tcUser = null; _tcOrig = ''; const m = document.getElementById('rpt-drill-modal'); if (m) { m.classList.add('hidden'); m.style.display = ''; } }
export function exportDrillCSV() {
  if (!_drill || !_drill.rows.length) { showToast('Nothing to export.'); return; }
  const matrix = [ [_drill.title.replace(/—/g,'-')], [`Showing: ${rangeLabel()}`], ..._drill.summary, [], _drill.columns, ..._drill.rows ];
  const csv = matrix.map(line => line.map(c => `"${String(c==null?'':c).replace(/"/g,'""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿'+csv], { type:'text/csv;charset=utf-8;' }));
  const a = document.createElement('a'); a.href = url; a.download = `muse-detail-${localDateStr(getReportDates()?.from||new Date())}.csv`; a.click(); URL.revokeObjectURL(url);
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
    <div class="footer">Generated ${new Date().toLocaleString()} · Muse Nails &amp; Spa</div></body></html>`;
}

// ── Payroll page (per-tech commission / check / cash by pay period, prev-period compare) ─
// Its own dashboard tab. Techs are cards (horizontal scroll); each shows Billed,
// Commission, Check, Cash + a per-day breakdown, each line compared to the previous
// pay period (▲ green / ▼ red + %). Check = staff paycheck setting (set $, set % of
// commission, or variable=manual entry here, stored per tech per period). Cash = comm − check.
let _payrollOffset = 0;   // 0 = current pay period, -1 = previous, +1 = next
// Device-local: show the prior-pay-period comparison columns (This | Last + Δ). Default on.
let _payrollCompare = localStorage.getItem('turndesk_payroll_compare') !== '0';
export function payrollToggleCompare() {
  _payrollCompare = !_payrollCompare;
  localStorage.setItem('turndesk_payroll_compare', _payrollCompare ? '1' : '0');
  renderPayrollPage();
}
// Technicians | Front Desk pay view (device-local).
let _payrollView = localStorage.getItem('turndesk_payroll_view') === 'fd' ? 'fd' : 'tech';
export function payrollSetView(v) {
  _payrollView = v === 'fd' ? 'fd' : 'tech';
  try { localStorage.setItem('turndesk_payroll_view', _payrollView); } catch {}
  renderPayrollPage();
}
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
export function payrollPeriodAt(offset) {
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
// ── Payroll lock: manually freeze a pay period's numbers against later %/check/rule changes ──
// _payrollLiveT holds the live-computed rows from the last render so Lock can snapshot them.
let _payrollLiveT = [], _payrollLiveKey = '', _payrollLiveSpan = null, _payrollLiveFd = [];
// Per-tech per-period manual overrides (config.payroll_adj[techId:perKey] = {check?,deduction?,cash?,checkNum?}).
export function payrollSetOverride(techId, field, val) {
  if (!['check', 'deduction', 'cash'].includes(field)) return;
  const perKey = localDateStr(payrollPeriodAt(_payrollOffset).from);
  const adj = JSON.parse(JSON.stringify(cfg().payroll_adj || {}));
  const k = techId + ':' + perKey; adj[k] = adj[k] || {};
  const n = parseFloat(val);
  if (val === '' || val == null || isNaN(n)) delete adj[k][field]; else adj[k][field] = n;
  if (!Object.keys(adj[k]).length) delete adj[k];
  dispatch('config.set', { key: 'payroll_adj', value: adj });
  renderPayrollPage();
}
export function payrollSetCheckNum(techId, val) {
  const perKey = localDateStr(payrollPeriodAt(_payrollOffset).from);
  const adj = JSON.parse(JSON.stringify(cfg().payroll_adj || {}));
  const k = techId + ':' + perKey; adj[k] = adj[k] || {};
  const v = (val || '').trim();
  if (!v) delete adj[k].checkNum; else adj[k].checkNum = v;
  if (!Object.keys(adj[k]).length) delete adj[k];
  dispatch('config.set', { key: 'payroll_adj', value: adj });
}
// Right-click / double-click a payroll cell → swap it to an input; save on blur/Enter, cancel on Escape.
export function payrollEditCell(ev) {
  ev.preventDefault();
  const td = ev.currentTarget; if (!td || td.querySelector('input')) return;
  const field = td.dataset.field, techId = td.dataset.tech, raw = td.dataset.val || '';
  if (td.dataset.locked === '1' && field !== 'checkNum') { showToast('Unlock this pay period to override.'); return; }
  const isNum = field !== 'checkNum';
  const val = isNum ? (raw && +raw ? String(Math.round(+raw * 100) / 100) : '') : raw;
  td.innerHTML = `<input type="${isNum ? 'number' : 'text'}"${isNum ? ' step="0.01" min="0"' : ''} value="${val}" style="width:${isNum ? 70 : 90}px" class="bg-surface-container border border-primary rounded px-1.5 py-0.5 text-sm font-headline text-${isNum ? 'right' : 'center'} text-on-surface focus:outline-none">`;
  const inp = td.querySelector('input'); inp.focus(); inp.select();
  let done = false;
  const commit = () => { if (done) return; done = true; if (field === 'checkNum') { payrollSetCheckNum(techId, inp.value); renderPayrollPage(); } else payrollSetOverride(techId, field, inp.value); };
  inp.addEventListener('blur', commit);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); else if (e.key === 'Escape') { done = true; renderPayrollPage(); } });
}
export function payrollLockPeriod() {
  if (!['admin','manager'].includes(getActiveUser()?.role)) { showToast('Only an admin or manager can lock payroll.'); return; }
  if (!_payrollLiveKey) return;
  const rows = (_payrollLiveT || []).filter(x => x.c.billed || x.c.refund || x.cChk || x.cDed || x.cCash).map(x => ({
    techId: x.tech.id, name: x.tech.name, commPct: x.tech.commission,
    billed: x.c.billed || 0, commission: x.c.commission || 0, refund: x.c.refund || 0, refundComm: x.c.refundComm || 0, refundNotes: x.c.refundNotes || [],
    check: x.cChk || 0, deduction: x.cDed || 0, cash: x.cCash || 0, total: x.cTotal || 0, daily: x.c.daily || {},
  }));
  // Front-desk hourly pay is frozen in the same snapshot (hours · rate · check/cash).
  const fd = (_payrollLiveFd || []).filter(r => r.hours || r.pay).map(r => ({
    userId: r.u.id, name: r.u.name, hours: r.hours || 0, rate: r.rate || 0, pay: r.pay || 0, check: r.chk || 0, cash: r.cash || 0,
  }));
  const locks = { ...(cfg().payroll_locks || {}) };
  locks[_payrollLiveKey] = { lockedAt: new Date().toISOString(), lockedBy: getActiveUser()?.name || '', from: _payrollLiveSpan?.from, to: _payrollLiveSpan?.to, techs: rows, fd };
  dispatch('config.set', { key: 'payroll_locks', value: locks });
  showToast('Pay period locked 🔒');
  renderPayrollPage();
}
export function payrollUnlockPeriod() {
  if (!['admin','manager'].includes(getActiveUser()?.role)) { showToast('Only an admin or manager can unlock payroll.'); return; }
  const key = _payrollLiveKey;
  const doIt = () => { const locks = { ...(cfg().payroll_locks || {}) }; delete locks[key]; dispatch('config.set', { key: 'payroll_locks', value: locks }); showToast('Pay period unlocked'); renderPayrollPage(); };
  if (window.showWarnModal) window.showWarnModal('Unlock this pay period?', 'Payroll will recompute from current settings — the saved snapshot is discarded.', doIt, 'Unlock');
  else doIt();
}
// Front-desk pay rows for a period (clocked hours × rate + Check/Cash split), with the
// payroll_adj overrides and the lock snapshot applied — shared by the Payroll page and
// the Muse Reports phone app. Check defaults to the FULL pay.
export function payrollFdRows(offset = _payrollOffset) {
  const cur = payrollPeriodAt(offset);
  const curKey = localDateStr(cur.from);
  const adjAll = cfg().payroll_adj || {};
  const lock = (cfg().payroll_locks || {})[curKey];
  const snapById = lock?.fd ? Object.fromEntries(lock.fd.map(s => [s.userId, s])) : null;
  const from = new Date(cur.from); from.setHours(0, 0, 0, 0);
  const to = new Date(cur.to); to.setHours(23, 59, 59, 999);
  const rows = (cfg().fd_users || []).map(u => {
    const a = adjAll[u.id + ':' + curKey] || {};
    const snap = snapById?.[u.id];
    if (snap) return { u, hours: snap.hours, open: false, flagged: 0, rate: snap.rate, pay: snap.pay, chk: snap.check, cash: snap.cash, adj: a };
    const r = fdPaidHours(u.id, +from, +to);
    const pay = r.hours * (u.hourlyRate || 0);
    const chk = a.check != null ? a.check : pay;
    const cash = a.cash != null ? a.cash : Math.max(0, pay - chk);
    return { u, hours: r.hours, open: r.openShift, flagged: r.flagged, rate: u.hourlyRate || 0, pay, chk, cash, adj: a };
  });
  return { rows, locked: !!lock, cur };
}

export function renderPayrollPage() {
  window.renderClockedInNow?.();   // live "clocked in now" card (gated by viewClockedIn)
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
    .sort((a, b) => (a.legalName || a.name || '').localeCompare(b.legalName || b.name || '', undefined, { sensitivity: 'base' }));   // payroll: A→Z by legal name
  if (!techs.length) { wrap.innerHTML = '<div class="text-sm text-on-surface-variant py-8 text-center w-full">No technicians configured.</div>'; return; }
  // Excel-style table: techs as column-groups across the top (This | Last), metrics +
  // each day as rows; sticky first column holds the row labels.
  const _adj = cfg().payroll_adj || {};
  const T = techs.map(tech => {
    const c = curData[tech.id] || { billed: 0, commission: 0, daily: {}, refund: 0, refundComm: 0, refundNotes: [] };
    const p = prevData[tech.id] || { billed: 0, commission: 0, daily: {}, refund: 0, refundComm: 0, refundNotes: [] };
    const cComm = _netComm(c), pComm = _netComm(p);
    // Per-tech per-period manual overrides (config.payroll_adj): check / deduction / cash can each be
    // hand-set; anything not overridden falls back to the rule (cash defaults to commission−check−deduction).
    const a = _adj[tech.id + ':' + curKey] || {};
    const aPrev = _adj[tech.id + ':' + prevKey] || {};   // prev-period override, so "vs previous" shows what was actually paid, not just the memorized rule value
    const cChk = a.check != null ? a.check : techCheckAmount(tech, cComm, curKey);
    const pChk = aPrev.check != null ? aPrev.check : techCheckAmount(tech, pComm, prevKey);
    const cCashGross = Math.max(0, cComm - cChk), pCashGross = Math.max(0, pComm - pChk);
    const cDed = a.deduction != null ? a.deduction : techCashDeduction(tech, cCashGross);
    const pDed = aPrev.deduction != null ? aPrev.deduction : techCashDeduction(tech, pCashGross);
    const cCash = a.cash != null ? a.cash : Math.max(0, cCashGross - cDed);
    const pCash = aPrev.cash != null ? aPrev.cash : Math.max(0, pCashGross - pDed);
    return { tech, c, p, cChk, pChk, cDed, pDed, cCash, pCash, cTotal: cChk + cCash, pTotal: pChk + pCash, isVar: (tech.checkType || 'variable') === 'variable', adj: a };
  });
  // Lock: keep the LIVE rows for the Lock button; if this period is locked, override the displayed
  // numbers with the frozen snapshot so later %/check/rule changes don't rewrite history.
  const _lockKey = localDateStr(cur.from);
  const _plock = (cfg().payroll_locks || {})[_lockKey];
  _payrollLiveT = T; _payrollLiveKey = _lockKey; _payrollLiveSpan = { from: localDateStr(cur.from), to: localDateStr(cur.to) };
  if (_plock) {
    const byId = {}; (_plock.techs || []).forEach(s => byId[s.techId] = s);
    T.forEach(x => { const s = byId[x.tech.id]; if (!s) return;
      x.c = { ...x.c, billed: s.billed, commission: s.commission, refund: s.refund || 0, refundComm: s.refundComm || 0, refundNotes: s.refundNotes || x.c.refundNotes, daily: s.daily || x.c.daily };
      x.cChk = s.check; x.cDed = s.deduction; x.cCash = s.cash; x.cTotal = s.total;
    });
  }
  // Same for the PREVIOUS period's "Last" columns: a locked prior period shows its frozen
  // snapshot (what was actually paid), so a later %/check/rule change can't rewrite the comparison.
  const _plockPrev = (cfg().payroll_locks || {})[prevKey];
  if (_plockPrev) {
    const byIdP = {}; (_plockPrev.techs || []).forEach(s => byIdP[s.techId] = s);
    T.forEach(x => { const s = byIdP[x.tech.id]; if (!s) return;
      x.p = { ...x.p, billed: s.billed, commission: s.commission, refund: s.refund || 0, refundComm: s.refundComm || 0, refundNotes: s.refundNotes || x.p.refundNotes, daily: s.daily || x.p.daily };
      x.pChk = s.check; x.pDed = s.deduction; x.pCash = s.cash; x.pTotal = s.total;
    });
  }
  // Each tech spans 5 columns: This-Billed | This-Comm | Δ | Last-Billed | Last-Comm.
  // The Δ column holds a single ▲/▼% — green up / red down — based on the BILLED change vs
  // the prior period (one arrow, not one per number). Compact whole dollars in the dense
  // day grid; cents on the summary rows.
  const m0 = n => '$' + Math.round(n || 0);
  const cmp = _payrollCompare;   // show the prior-pay-period comparison columns (This | Last + Δ)?
  const colsPer = cmp ? 5 : 2;   // columns each tech spans
  const quad = (cb, cc, pb, pc) =>
      `<td class="num staff-sep">${_m2(cb)}</td><td class="num">${_m2(cc)}</td>`
    + (cmp ? `<td class="arrow-col">${_pcmp(cb, pb)}</td><td class="num last thislast-sep">${_m2(pb)}</td><td class="num last">${_m2(pc)}</td>` : '');
  const dquad = (cd, pd) =>
      `<td class="num staff-sep">${m0(cd.billed)}</td><td class="num">${m0(cd.commission)}</td>`
    + (cmp ? `<td class="arrow-col">${_pcmp(cd.billed, pd.billed)}</td><td class="num last thislast-sep">${m0(pd.billed)}</td><td class="num last">${m0(pd.commission)}</td>` : '');
  // Check / Cash are single payouts per period (no billed/comm split) → span the "This" side
  // (billed + comm + Δ) and the "Last" side (billed + comm).
  const span2 = (cVal, pVal) => cmp
    ? `<td class="num staff-sep" colspan="3">${cVal}</td><td class="num last thislast-sep" colspan="2">${_m2(pVal)}</td>`
    : `<td class="num staff-sep" colspan="2">${cVal}</td>`;
  // check / deduction / cash are editable override inputs (disabled when the period is locked); a *
  // marks a manual override. Check # records the issued check number (editable even when locked).
  const _locked = !!_plock;
  const _ovMark = (x, f) => (x.adj && x.adj[f] != null) ? '<span title="Manual override — right-click to change" style="color:#c77700;font-weight:700"> *</span>' : '';
  // Clean number by default; right-click (or double-click) a cell to override — the input appears for
  // that cell only. An overridden value shows a * and stays editable; locked periods can't be overridden.
  const ovCell = (x, field, val, pHtml, color) => {
    const txt = val ? `${field === 'deduction' ? '-' : ''}${_m2(val)}` : '—';
    return `<td class="num staff-sep" colspan="${cmp ? 3 : 2}" data-tech="${x.tech.id}" data-field="${field}" data-val="${val || 0}"${_locked ? ' data-locked="1"' : ''} oncontextmenu="payrollEditCell(event)" ondblclick="payrollEditCell(event)" title="Right-click to override" style="cursor:context-menu${color === 'text-error' ? ';color:#dc2626' : ''}">${txt}${_ovMark(x, field)}</td>${cmp ? `<td class="num last thislast-sep" colspan="2"${color === 'text-error' ? ' style="color:#dc2626"' : ''}>${pHtml}</td>` : ''}`;
  };
  const checkNumCell = x => `<td class="num staff-sep" colspan="${colsPer}" data-tech="${x.tech.id}" data-field="checkNum" data-val="${x.adj?.checkNum ? _eTxn(x.adj.checkNum) : ''}" oncontextmenu="payrollEditCell(event)" ondblclick="payrollEditCell(event)" title="Right-click to enter the check #" style="text-align:center;cursor:context-menu;color:var(--md-on-surface-variant)">${x.adj?.checkNum ? _eTxn(x.adj.checkNum) : '—'}</td>`;
  const refCells = (c, p) =>
    `<td class="num staff-sep" style="color:#dc2626">${c.refund ? '-$' + Math.abs(c.refund).toFixed(0) : '—'}${_refNote(c.refundNotes)}</td><td class="num" style="color:#dc2626">${c.refundComm ? '-$' + Math.abs(c.refundComm).toFixed(0) : '—'}</td>`
    + (cmp ? `<td class="arrow-col"></td><td class="num last thislast-sep" style="color:#dc2626">${p.refund ? '-$' + Math.abs(p.refund).toFixed(0) : '—'}</td><td class="num last" style="color:#dc2626">${p.refundComm ? '-$' + Math.abs(p.refundComm).toFixed(0) : '—'}</td>` : '');
  const info = `<button onclick="showToast('Day cells show billed and commission, this period vs last. The Δ column is the change in billed vs the same weekday in the previous pay period.')" title="Day cells = billed and commission, this period vs last. Δ = change in billed vs the same weekday in the previous pay period." style="width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;cursor:help;border:none;background:transparent;border-radius:50%"><span class="material-symbols-outlined" style="font-size:15px;color:var(--md-on-surface-variant)">info</span></button>`;
  const rows = [
    `<tr><td class="sticky-col">Total</td>${T.map(x => quad(x.c.billed, x.c.commission, x.p.billed, x.p.commission)).join('')}</tr>`,
    ...(T.some(x => x.c.refund || x.p.refund) ? [
      `<tr><td class="sticky-col">Refunds</td>${T.map(x => refCells(x.c, x.p)).join('')}</tr>`,
    ] : []),
    `<tr><td class="sticky-col">Check</td>${T.map(x => ovCell(x, 'check', x.cChk, _m2(x.pChk))).join('')}</tr>`,
    `<tr><td class="sticky-col" style="font-weight:400;font-size:11px;color:var(--md-on-surface-variant)">Check #</td>${T.map(checkNumCell).join('')}</tr>`,
    `<tr><td class="sticky-col">Cash deduction</td>${T.map(x => ovCell(x, 'deduction', x.cDed, x.pDed ? '-' + _m2(x.pDed) : '—', 'text-error')).join('')}</tr>`,
    `<tr><td class="sticky-col">Cash</td>${T.map(x => ovCell(x, 'cash', x.cCash, _m2(x.pCash))).join('')}</tr>`,
    `<tr style="font-weight:700"><td class="sticky-col">Total paid</td>${T.map(x => span2(_m2(x.cTotal), x.pTotal)).join('')}</tr>`,
    `<tr class="section-row"><td class="sticky-col">By day ${info}</td><td colspan="${T.length * colsPer}"></td></tr>`,
    ...curDays.map((day, i) => {
      const dl = new Date(day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
      return `<tr><td class="sticky-col" style="font-weight:500">${dl}</td>${T.map(x => dquad(x.c.daily[day] || { billed: 0, commission: 0 }, x.p.daily[prevDays[i]] || { billed: 0, commission: 0 })).join('')}</tr>`;
    }),
  ];
  const head1 = T.map(x => { const legal = x.tech.legalName || '', pref = x.tech.name || legal || ''; const showLegal = legal && legal.toLowerCase() !== pref.toLowerCase(); return `<th colspan="${colsPer}" class="staff-sep" style="text-align:center"><span style="text-decoration:underline">${_eTxn(pref)}${x.tech.commission != null ? ` ${x.tech.commission}%` : ''}</span>${showLegal ? `<div style="font-weight:400;font-size:10px;color:var(--md-on-surface-variant)">${_eTxn(legal)}</div>` : ''}</th>`; }).join('');
  const head2 = T.map(() => `<th colspan="2" class="staff-sep" style="text-align:center;font-weight:600">This</th><th class="arrow-col"></th><th colspan="2" class="thislast-sep" style="text-align:center;font-weight:600">Last</th>`).join('');
  const head3 = T.map(() => cmp
    ? `<th class="num staff-sep">Billed</th><th class="num">Comm</th><th class="arrow-col"></th><th class="num thislast-sep">Billed</th><th class="num">Comm</th>`
    : `<th class="num staff-sep">Billed</th><th class="num">Comm</th>`).join('');
  // ── Front-desk hourly pay (clocked hours × rate) + Check/Cash split ──
  // Same mechanics as techs: Check defaults to the FULL pay; right-click Check or Cash
  // to override (payroll_adj keyed by the fd user id); a locked period renders the
  // frozen snapshot (lock.fd) so later punch/rate fixes don't rewrite paid history.
  const _fdEdit = ['admin', 'manager'].includes(getActiveUser()?.role);
  const _fdRows = payrollFdRows(_payrollOffset).rows;
  _payrollLiveFd = _fdRows;   // Lock snapshots these (see payrollLockPeriod)
  const _fdT = k => _fdRows.reduce((s, r) => s + (r[k] || 0), 0);
  const _fdOv = (r, field, val) => {
    const txt = val ? _m2(val) : '—';
    const mark = (r.adj && r.adj[field] != null) ? '<span title="Manual override — right-click to change" style="color:#c77700;font-weight:700"> *</span>' : '';
    return `<td class="num" data-tech="${r.u.id}" data-field="${field}" data-val="${val || 0}"${_locked ? ' data-locked="1"' : ''} oncontextmenu="payrollEditCell(event)" ondblclick="payrollEditCell(event)" title="Right-click to override" style="cursor:context-menu">${txt}${mark}</td>`;
  };
  const _fdCheckNum = r => `<td data-tech="${r.u.id}" data-field="checkNum" data-val="${r.adj?.checkNum ? _eTxn(r.adj.checkNum) : ''}" oncontextmenu="payrollEditCell(event)" ondblclick="payrollEditCell(event)" title="Right-click to enter the check #" style="text-align:center;cursor:context-menu;color:var(--md-on-surface-variant)">${r.adj?.checkNum ? _eTxn(r.adj.checkNum) : '—'}</td>`;
  // ALWAYS available (even with no FD staff / no hourly rate set) so it's a stable, discoverable
  // home for front-desk hours — empty state guides the operator to add staff.
  const _fdBody = _fdRows.length
    ? _fdRows.map(r => `<tr><td class="sticky-col"${_fdEdit ? ` onclick="openTimecard('${r.u.id}')" style="cursor:pointer" title="Tap to adjust clock times"` : ''}>${_eTxn(r.u.name)}${r.open ? ' <span title="Still clocked in" style="color:#c77700">⏱</span>' : ''}${r.flagged ? ` <span title="${r.flagged} punch(es) need review — a forgotten clock-out/in, not counted. Tap to fix." style="color:#c0392b">⚠${r.flagged}</span>` : ''}</td><td class="num">${r.hours.toFixed(2)}</td><td class="num">$${r.rate.toFixed(2)}</td><td class="num" style="font-weight:700">$${r.pay.toFixed(2)}</td>${_fdOv(r, 'check', r.chk)}${_fdOv(r, 'cash', r.cash)}${_fdCheckNum(r)}</tr>`).join('')
      + `<tr style="font-weight:700"><td class="sticky-col">Total</td><td class="num">${_fdT('hours').toFixed(2)}</td><td class="num"></td><td class="num">$${_fdT('pay').toFixed(2)}</td><td class="num">$${_fdT('chk').toFixed(2)}</td><td class="num">$${_fdT('cash').toFixed(2)}</td><td></td></tr>`
    : `<tr><td colspan="7" style="text-align:center;color:var(--md-on-surface-variant);padding:16px;font-style:italic">No front-desk staff yet — add them in Settings → Staff &amp; Access.</td></tr>`;
  const _fdHtml = `<div>
      <div class="flex items-center gap-2 mb-2 flex-wrap"><h3 class="text-sm font-headline font-bold text-on-surface uppercase tracking-widest">Front Desk — Hourly</h3><span class="text-[11px] font-body text-on-surface-variant">check defaults to the full pay · right-click Check or Cash to override${_fdEdit ? ' · tap a name to adjust times' : ''}</span></div>
      <div class="overflow-x-auto rounded-xl border border-surface-container-high" style="scrollbar-width:thin"><table class="data-table">
        <thead><tr><th class="sticky-col">Staff</th><th class="num">Hours</th><th class="num">Rate</th><th class="num">Pay</th><th class="num">Check</th><th class="num">Cash</th><th style="text-align:center">Check #</th></tr></thead>
        <tbody>${_fdBody}</tbody>
      </table></div></div>`;
  const _isAdmin = ['admin', 'manager'].includes(getActiveUser()?.role);
  const _lockBar = _plock
    ? `<div class="flex items-center justify-between gap-2 mb-3 px-4 py-2.5 rounded-xl" style="background:rgba(26,82,82,.08);border:1px solid rgba(26,82,82,.28)"><div class="flex items-center gap-2 text-sm font-body text-on-surface"><span class="material-symbols-outlined text-primary" style="font-size:18px">lock</span><span><b>Locked</b>${_plock.lockedAt ? ' · ' + new Date(_plock.lockedAt).toLocaleDateString() : ''}${_plock.lockedBy ? ' by ' + _eTxn(_plock.lockedBy) : ''} — showing the saved snapshot.</span></div>${_isAdmin ? '<button onclick="payrollUnlockPeriod()" class="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-surface-container-high text-on-surface font-body font-semibold text-xs hover:bg-surface-container flex-shrink-0"><span class="material-symbols-outlined" style="font-size:15px">lock_open</span> Unlock</button>' : ''}</div>`
    : (_isAdmin ? `<div class="flex items-center justify-between gap-2 mb-3 px-4 py-2.5 rounded-xl border border-surface-container-high flex-wrap"><div class="text-sm font-body text-on-surface-variant">Lock this pay period to freeze it against future commission / check / deduction changes.</div><button onclick="payrollLockPeriod()" class="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-primary text-on-primary font-body font-semibold text-xs hover:bg-primary-dim flex-shrink-0"><span class="material-symbols-outlined" style="font-size:15px">lock</span> Lock this pay period</button></div>` : '');
  // (b) Technicians | Front Desk — one pay table at a time; (a) ONLY the table's own
  // wrapper scrolls horizontally, never the page.
  const _techHtml = `<div class="overflow-x-auto rounded-xl border border-surface-container-high" style="scrollbar-width:thin"><table class="data-table"><thead>${cmp
      ? `<tr><th class="sticky-col" rowspan="3"></th>${head1}</tr><tr>${head2}</tr><tr>${head3}</tr>`
      : `<tr><th class="sticky-col" rowspan="2"></th>${head1}</tr><tr>${head3}</tr>`}</thead>
    <tbody>${rows.join('')}</tbody></table></div>`;
  wrap.innerHTML = _lockBar + (_payrollView === 'fd' ? _fdHtml : _techHtml);
  document.getElementById('payroll-view-tech')?.classList.toggle('on', _payrollView !== 'fd');
  document.getElementById('payroll-view-fd')?.classList.toggle('on', _payrollView === 'fd');
  // Reflect the toggle state on the header button.
  const _cbtn = document.getElementById('payroll-compare-btn');
  if (_cbtn) {
    _cbtn.classList.toggle('border-primary', cmp);
    _cbtn.classList.toggle('text-primary', cmp);
    _cbtn.classList.toggle('bg-primary/10', cmp);
    _cbtn.classList.toggle('border-outline-variant/60', !cmp);
    _cbtn.classList.toggle('text-on-surface', !cmp);
    const _clbl = document.getElementById('payroll-compare-label');
    if (_clbl) _clbl.textContent = cmp ? 'Comparing: Last' : 'Compare: Off';
  }
}

// ── Front-desk timecard editor (admin/manager) ───────────────────────────────
// Opened from a Front-Desk row in Payroll. Lists the user's clock punches for the
// selected pay period with editable in/out times, add a missed punch, delete, and
// close a forgotten clock-out. Edits replace the user's punch list via fdSetPunches.
const _tcCanEdit = () => ['admin', 'manager'].includes(getActiveUser()?.role);
const _tc2 = n => String(n).padStart(2, '0');
const _tcDate = ms => { const d = new Date(ms); return d.getFullYear() + '-' + _tc2(d.getMonth() + 1) + '-' + _tc2(d.getDate()); };
const _tcTime = ms => { const d = new Date(ms); return _tc2(d.getHours()) + ':' + _tc2(d.getMinutes()); };
const _tcCombine = (dateStr, timeStr) => { if (!dateStr || !timeStr) return null; const t = new Date(dateStr + 'T' + timeStr); return isNaN(t) ? null : t.getTime(); };
const _tcDateLabel = ms => new Date(ms).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
// The date field is a button → opens the native calendar popup only (no typing, no separate icon).
export function tcOpenDate(idx) {
  const el = document.getElementById('tc-date-' + idx); if (!el) return;
  if (typeof el.showPicker === 'function') { try { el.showPicker(); return; } catch {} }
  el.focus(); el.click();   // fallback for browsers without showPicker
}
// Hour : Min : AM/PM dropdowns (15-min) — same picker as the front-desk schedule. `allowBlank`
// lets the OUT side be empty ("—") to represent a still-open punch.
const _tcSel = 'bg-surface-container border border-surface-container-high rounded px-1.5 py-1.5 text-xs font-body text-on-surface focus:outline-none focus:border-primary';
function _tcTrio(which, idx, userId, ms, allowBlank) {
  const has = typeof ms === 'number';
  let h12 = 9, mm = '00', ap = 'AM';
  if (has) { const d = new Date(ms); const total = (d.getHours() * 60 + Math.round(d.getMinutes() / 15) * 15) % 1440; const h = Math.floor(total / 60); ap = h >= 12 ? 'PM' : 'AM'; const x = h % 12; h12 = x === 0 ? 12 : x; mm = _tc2(total % 60); }
  const oc = `onchange="tcUpdate('${userId}',${idx})"`;
  const hOpts = (allowBlank ? `<option value="" ${has ? '' : 'selected'}>—</option>` : '') + Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${has && h12 === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('');
  const mOpts = ['00', '15', '30', '45'].map(m => `<option value="${m}" ${has && mm === m ? 'selected' : ''}>${m}</option>`).join('');
  const apOpts = ['AM', 'PM'].map(a => `<option value="${a}" ${has && ap === a ? 'selected' : ''}>${a}</option>`).join('');
  return `<select id="tc-${which}h-${idx}" ${oc} class="${_tcSel}" style="min-width:46px">${hOpts}</select><span class="text-on-surface-variant text-xs">:</span><select id="tc-${which}m-${idx}" ${oc} class="${_tcSel}" style="min-width:46px">${mOpts}</select><select id="tc-${which}ap-${idx}" ${oc} class="${_tcSel}" style="min-width:54px">${apOpts}</select>`;
}
function _tcReadTrio(which, idx) {
  const h = document.getElementById(`tc-${which}h-${idx}`)?.value;
  if (!h) return null;                       // blank OUT → still open
  const m = document.getElementById(`tc-${which}m-${idx}`)?.value || '00';
  const ap = document.getElementById(`tc-${which}ap-${idx}`)?.value || 'AM';
  const h24 = (parseInt(h, 10) % 12) + (ap === 'PM' ? 12 : 0);
  return `${_tc2(h24)}:${m}`;
}

// The timecard is a DRAFT editor (v4.57): edits mutate a local copy and only commit to the synced
// store on Save. Cancel / closing the panel discards them. _tcDraft is the full punch list (the
// shown rows are this period's subset, edited by their index in the draft); _tcOrig snapshots the
// opened state to detect unsaved changes.
let _tcDraft = null, _tcUser = null, _tcOrig = '';
export function openTimecard(userId) {
  if (!_tcCanEdit()) { showToast('Only an admin or manager can adjust times.'); return; }
  const u = (cfg().fd_users || []).find(x => x.id === userId); if (!u) return;
  _tcUser = userId;
  _tcDraft = JSON.parse(JSON.stringify(fdPunches(userId)));   // fresh working copy from the store
  _tcOrig = JSON.stringify(_tcDraft);
  _renderTimecard();
}
// Open a user's timecard navigated to the pay period that CONTAINS atMs. Used by the
// "Clocked in now" card to jump straight to a forgotten/stale punch (which lives in an
// earlier period and is otherwise invisible in the current-period timecard).
export function openTimecardAt(userId, atMs) {
  if (atMs) {
    for (let off = 0; off >= -60; off--) {
      const per = payrollPeriodAt(off);
      const f = new Date(per.from); f.setHours(0, 0, 0, 0);
      const t = new Date(per.to);   t.setHours(23, 59, 59, 999);
      if (atMs >= +f && atMs <= +t) { _payrollOffset = off; break; }
    }
    renderPayrollPage();   // reflect the period nav (label + cards) behind the timecard
  }
  openTimecard(userId);
}
function _renderTimecard() {
  const userId = _tcUser, u = (cfg().fd_users || []).find(x => x.id === userId);
  if (!u || !_tcDraft) return;
  const cur = payrollPeriodAt(_payrollOffset);
  const from = new Date(cur.from); from.setHours(0, 0, 0, 0);
  const to = new Date(cur.to); to.setHours(23, 59, 59, 999);
  const rows = _tcDraft.map((p, idx) => ({ p, idx })).filter(({ p }) => p.in && p.in >= +from && p.in <= +to).sort((a, b) => a.p.in - b.p.in);
  let _tcFlagged = 0;
  const body = rows.map(({ p, idx }) => {
    const suspect = fdPunchSuspect(p); if (suspect) _tcFlagged++;
    const hrs = p.out ? roundQuarterHours(p.out - p.in) : 0;
    return `<div class="flex items-center gap-1.5 py-2 border-b border-surface-container-high flex-wrap rounded-lg" ${suspect ? 'style="background:rgba(192,57,43,.08)"' : ''}>
      <button type="button" onclick="tcOpenDate(${idx})" class="bg-surface-container border border-surface-container-high rounded-lg px-3 py-2 text-sm font-body text-on-surface hover:bg-surface-container-high flex items-center gap-2" style="min-width:150px"><span class="material-symbols-outlined text-on-surface-variant" style="font-size:16px">calendar_today</span>${_tcDateLabel(p.in)}</button>
      <input type="date" id="tc-date-${idx}" value="${_tcDate(p.in)}" onchange="tcUpdate('${userId}',${idx})" style="position:absolute;width:1px;height:1px;opacity:0;border:0;padding:0;margin:-1px;overflow:hidden">
      <span class="inline-flex items-center gap-0.5">${_tcTrio('in', idx, userId, p.in, false)}</span>
      <span class="text-on-surface-variant text-xs">→</span>
      <span class="inline-flex items-center gap-0.5">${_tcTrio('out', idx, userId, p.out, true)}</span>
      <span class="text-xs font-body font-semibold ml-auto" style="${suspect ? 'color:#c0392b' : (p.out ? '' : 'color:#c77700')}">${suspect ? '⚠ not paid' : (p.out ? hrs.toFixed(2) + 'h' : 'open')}</span>
      <button onclick="tcDeletePunch('${userId}',${idx})" title="Delete punch" class="text-on-surface-variant hover:text-error"><span class="material-symbols-outlined" style="font-size:18px">delete</span></button>
    </div>`;
  }).join('') || '<p class="text-sm font-body text-on-surface-variant py-3">No punches in this pay period. Use “Add punch” to enter one.</p>';
  const total = rows.reduce((s, { p }) => s + (fdPunchSuspect(p) ? 0 : (p.out ? roundQuarterHours(p.out - p.in) : 0)), 0);
  const dirty = _tcOrig !== JSON.stringify(_tcDraft);
  const html = `<div class="text-[11px] font-body text-on-surface-variant mb-2">${_eTxn(u.name)} · ${u.hourlyRate ? '$' + u.hourlyRate.toFixed(2) + '/hr' : 'no rate set'} · hours round to the nearest 15 min · changes aren’t saved until you tap Save</div>
    ${_tcFlagged ? `<div class="text-xs font-body mb-2 px-3 py-2 rounded-lg" style="background:rgba(192,57,43,.08);color:#a02318">⚠ ${_tcFlagged} punch${_tcFlagged > 1 ? 'es' : ''} over 16h or left open — excluded from pay. Fix the clock-out time (or delete) to count it.</div>` : ''}
    ${body}
    <div class="flex items-center justify-between mt-3">
      <button onclick="tcAddPunch('${userId}')" class="text-sm font-body font-semibold text-primary flex items-center gap-1"><span class="material-symbols-outlined" style="font-size:18px">add</span> Add punch</button>
      <span class="text-sm font-headline font-bold text-on-surface">${total.toFixed(2)} h · $${(total * (u.hourlyRate || 0)).toFixed(2)}</span>
    </div>
    <div class="flex items-center justify-between mt-4 pt-3 border-t border-surface-container-high">
      <button onclick="tcCancel()" class="px-4 py-2 rounded-xl border border-surface-container-high text-on-surface-variant font-body font-semibold text-sm">Cancel</button>
      <div class="flex items-center gap-3">${dirty ? '<span class="text-xs font-body" style="color:#c77700">● Unsaved changes</span>' : '<span class="text-xs font-body text-on-surface-variant">No changes</span>'}
        <button onclick="tcSave()" class="px-5 py-2 rounded-xl ${dirty ? 'bg-primary text-on-primary' : 'bg-surface-container-high text-on-surface-variant'} font-body font-semibold text-sm">Save</button></div>
    </div>`;
  showDrillPanel('Timecard — ' + (u.name || ''), html);
}
export function tcUpdate(userId, idx) {
  if (!_tcCanEdit() || !_tcDraft) return;
  const date = document.getElementById('tc-date-' + idx)?.value;
  const inMs = _tcCombine(date, _tcReadTrio('in', idx));
  if (!inMs) { showToast('Enter a clock-in date and time.'); return; }
  const outT = _tcReadTrio('out', idx);                            // null when the OUT hour is "—" (open)
  let outMs = _tcCombine(date, outT);
  if (outMs != null && outMs <= inMs) outMs += 24 * 3600 * 1000;   // out before in → shift ended after midnight
  if (!_tcDraft[idx]) return;
  _tcDraft[idx] = { in: inMs, out: outT ? outMs : null };          // draft only — not committed until Save
  _renderTimecard();
}
export function tcAddPunch(userId) {
  if (!_tcCanEdit() || !_tcDraft) return;
  // Default a new punch to TODAY, 9:00 AM in → 5:00 PM out (a typical shift the
  // manager can adjust), rather than the period-start date with an open clock-out.
  const start = new Date(); start.setHours(9, 0, 0, 0);
  const end = new Date(); end.setHours(17, 0, 0, 0);
  _tcDraft.push({ in: +start, out: +end });
  _renderTimecard();
}
export function tcDeletePunch(userId, idx) {
  if (!_tcCanEdit() || !_tcDraft) return;
  if (idx < 0 || idx >= _tcDraft.length) return;
  _tcDraft.splice(idx, 1);
  _renderTimecard();
}
// Commit the draft to the synced store, or discard it. Closing the panel (X / backdrop) also discards.
export function tcSave() {
  if (!_tcDraft || !_tcUser) return;
  fdSetPunches(_tcUser, _tcDraft);
  showToast('Timecard saved ✓');
  _tcDraft = null; _tcUser = null; _tcOrig = '';
  closeDrillDown(); renderPayrollPage();
}
export function tcCancel() { _tcDraft = null; _tcUser = null; _tcOrig = ''; closeDrillDown(); }
// Apply the same per-period adjustments the Payroll PAGE applies, so every export
// matches what's on screen: manual right-click overrides (config.payroll_adj) and,
// when the period is locked, the frozen snapshot (config.payroll_locks).
// (Exported for the Muse Reports phone app.)
export function payrollComputedRows(offset = _payrollOffset) {
  const { cur, T, curDays, prevDays } = payrollGrid(offset);
  const curKey = localDateStr(cur.from);
  const adjAll = cfg().payroll_adj || {};
  T.forEach(x => {
    const a = adjAll[x.tech.id + ':' + curKey] || {};
    x.adj = a;
    if (a.check != null || a.deduction != null || a.cash != null) {
      const cComm = _netComm(x.c);
      const cChk = a.check != null ? a.check : techCheckAmount(x.tech, cComm, curKey);
      const gross = Math.max(0, cComm - cChk);
      const cDed = a.deduction != null ? a.deduction : techCashDeduction(x.tech, gross);
      const cCash = a.cash != null ? a.cash : Math.max(0, gross - cDed);
      x.cChk = cChk; x.cDed = cDed; x.cCash = cCash; x.cTotal = cChk + cCash;
    }
  });
  const lock = (cfg().payroll_locks || {})[curKey];
  if (lock) {
    const byId = {}; (lock.techs || []).forEach(s => byId[s.techId] = s);
    T.forEach(x => {
      const s = byId[x.tech.id]; if (!s) return;
      x.c = { ...x.c, billed: s.billed, commission: s.commission, refund: s.refund || 0, refundComm: s.refundComm || 0, refundNotes: s.refundNotes || x.c.refundNotes, daily: s.daily || x.c.daily };
      x.cChk = s.check; x.cDed = s.deduction; x.cCash = s.cash; x.cTotal = s.total;
    });
  }
  // The "vs previous" comparison must show what was actually PAID last period, so resolve the
  // previous period the SAME way as the current one: the manual override (payroll_adj) wins over
  // the memorized rule value (techCheckAmount reads payroll_checks), and a locked previous period's
  // frozen snapshot wins over both. Previously the prev side used only the memorized rule value.
  const prevKey = localDateStr(prevPayPeriod(cur).from);
  T.forEach(x => {
    const ap = adjAll[x.tech.id + ':' + prevKey] || {};
    if (ap.check != null || ap.deduction != null || ap.cash != null) {
      const pComm = _netComm(x.p);
      const pChk = ap.check != null ? ap.check : techCheckAmount(x.tech, pComm, prevKey);
      const gross = Math.max(0, pComm - pChk);
      const pDed = ap.deduction != null ? ap.deduction : techCashDeduction(x.tech, gross);
      const pCash = ap.cash != null ? ap.cash : Math.max(0, gross - pDed);
      x.pChk = pChk; x.pDed = pDed; x.pCash = pCash; x.pTotal = pChk + pCash;
    }
  });
  const prevLock = (cfg().payroll_locks || {})[prevKey];
  if (prevLock) {
    const byIdP = {}; (prevLock.techs || []).forEach(s => byIdP[s.techId] = s);
    T.forEach(x => {
      const s = byIdP[x.tech.id]; if (!s) return;
      x.p = { ...x.p, billed: s.billed, commission: s.commission, refund: s.refund || 0, refundComm: s.refundComm || 0, refundNotes: s.refundNotes || x.p.refundNotes, daily: s.daily || x.p.daily };
      x.pChk = s.check; x.pDed = s.deduction; x.pCash = s.cash; x.pTotal = s.total;
    });
  }
  return { cur, T, curDays, prevDays, locked: !!lock };
}
// Every paid service line a tech worked in the period — the per-staff "itemized" tab.
function payrollTechLines(techId, from, to) {
  const tech = staffById(techId), pct = tech?.commission != null ? tech.commission : 0;
  const inRange = r => { const d = new Date(r.checkinTime); return d >= from && d <= to; };
  const lines = [];
  buildCombinedRecords().filter(r => r.status !== 'deleted' && isPaidStatus(r.status) && inRange(r)).forEach(r => {
    (r.assignments || []).forEach(a => {
      if (a.techId !== techId) return;
      const cost = a.cost || 0;
      lines.push({
        date: localDateStr(new Date(r.checkinTime)),
        customer: r.name || 'Guest',
        service: (cfg().services || []).find(s => s.id === a.serviceId)?.label || a.serviceId || 'Service',
        billed: cost, comm: cost * pct / 100,
      });
    });
  });
  return lines.sort((a, b) => a.date.localeCompare(b.date) || a.customer.localeCompare(b.customer));
}
// Excel workbook: a Totals tab (same layout the old CSV had) + one tab per tech with
// their pay summary, by-day table, and itemized service lines. Amounts are NUMBERS so
// the owner can sum/filter in Excel. Numbers match the on-screen page (overrides + locks).
export function payrollExportExcel() {
  const { cur, T, curDays, locked } = payrollComputedRows();
  const rows = T.filter(x => x.c.billed || x.c.refund || x.cChk || x.cCash);
  if (!rows.length) { showToast('No payroll data for this period.'); return; }
  const fmt = d => d.toLocaleDateString();
  const r2 = n => Math.round((n || 0) * 100) / 100;
  const period = `Pay period: ${fmt(cur.from)} – ${fmt(cur.to)}${locked ? ' · LOCKED snapshot' : ''}`;
  const sum = k => r2(rows.reduce((s, x) => s + (k(x) || 0), 0));
  const totals = {
    name: 'Totals',
    rows: [
      ['Muse Nails & Spa — Payroll'], [period], [],
      ['Technician', 'Billed', 'Commission', 'Refunds', 'Check', 'Cash deduction', 'Cash', 'Total paid'],
      ...rows.map(x => [x.tech.name, r2(x.c.billed), r2(x.c.commission), x.c.refund ? -r2(Math.abs(x.c.refund)) : 0, r2(x.cChk), x.cDed ? -r2(x.cDed) : 0, r2(x.cCash), r2(x.cTotal)]),
      [],
      ['Totals', sum(x => x.c.billed), sum(x => x.c.commission), -sum(x => Math.abs(x.c.refund || 0)), sum(x => x.cChk), -sum(x => x.cDed), sum(x => x.cCash), sum(x => x.cTotal)],
    ],
  };
  const techSheets = rows.map(x => {
    const daily = curDays.map(day => {
      const d = x.c.daily[day] || { billed: 0, commission: 0 };
      const dl = new Date(day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
      return [dl, r2(d.billed), r2(d.commission)];
    });
    const lines = payrollTechLines(x.tech.id, cur.from, cur.to);
    return {
      name: x.tech.name || 'Tech',
      rows: [
        [`${x.tech.name}${x.tech.commission != null ? ` — ${x.tech.commission}% commission` : ''}`], [period], [],
        ['Summary'],
        ['Billed', r2(x.c.billed)],
        ...(x.c.refund ? [['Refunds', -r2(Math.abs(x.c.refund))]] : []),
        ['Commission', r2(x.c.commission)],
        ['Check', r2(x.cChk)],
        ...(x.cDed ? [['Cash deduction', -r2(x.cDed)]] : []),
        ['Cash', r2(x.cCash)],
        ['Total paid', r2(x.cTotal)],
        [],
        ['By day', 'Billed', 'Commission'],
        ...daily,
        [],
        ['Itemized services'],
        ['Date', 'Customer', 'Service', 'Billed', 'Commission'],
        ...lines.map(l => [l.date, l.customer, l.service, r2(l.billed), r2(l.comm)]),
      ],
    };
  });
  const blob = xlsxBlob([totals, ...techSheets]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `muse-payroll-${localDateStr(cur.from)}.xlsx`; a.click(); URL.revokeObjectURL(url);
  showToast('Payroll exported — Totals tab + one tab per staff');
}
function payrollGrid(offset = _payrollOffset) {
  const cur = payrollPeriodAt(offset), prev = prevPayPeriod(cur);
  const curData = payrollRange(cur.from, cur.to), prevData = payrollRange(prev.from, prev.to);
  const curKey = localDateStr(cur.from), prevKey = localDateStr(prev.from);
  const curDays = payrollDaysInRange(cur.from, cur.to), prevDays = payrollDaysInRange(prev.from, prev.to);
  const order = cfg().turns_order || [];
  const techs = (cfg().staff || []).filter(s => !cfg().inactive_staff.includes(s.id))
    .sort((a, b) => (a.legalName || a.name || '').localeCompare(b.legalName || b.name || '', undefined, { sensitivity: 'base' }));   // payroll: A→Z by legal name
  const T = techs.map(tech => { const c = curData[tech.id] || { billed: 0, commission: 0, daily: {}, refund: 0, refundComm: 0, refundNotes: [] }, p = prevData[tech.id] || { billed: 0, commission: 0, daily: {}, refund: 0, refundComm: 0, refundNotes: [] }; const cComm = _netComm(c), pComm = _netComm(p); const cChk = techCheckAmount(tech, cComm, curKey), pChk = techCheckAmount(tech, pComm, prevKey); const cCashGross = Math.max(0, cComm - cChk), pCashGross = Math.max(0, pComm - pChk); const cDed = techCashDeduction(tech, cCashGross), pDed = techCashDeduction(tech, pCashGross); const cCash = Math.max(0, cCashGross - cDed), pCash = Math.max(0, pCashGross - pDed); return { tech, c, p, cChk, pChk, cDed, pDed, cCash, pCash, cTotal: cChk + cCash, pTotal: pChk + pCash }; });
  return { cur, T, curDays, prevDays };
}
// Manager PDF: the full grid, landscape. Smart pagination: techs are CHUNKED into
// groups of 4 column-blocks per page (one full table each, row labels + headers
// repeated), so a wide roster can't run off the right edge of the page any more.
// Vertical overflow inside a page still repeats the header (thead display rule).
// Numbers match the on-screen page (overrides + lock snapshots applied).
export function payrollExportPDF() {
  const { cur, T, curDays, prevDays, locked } = payrollComputedRows();
  if (!T.length) { showToast('No technicians.'); return; }
  const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const period = `${fmt(cur.from)} – ${fmt(cur.to)}${locked ? ' · locked snapshot' : ''}`;
  const pc = (cv, pv) => { if (!pv && !cv) return ''; if (!pv) return ' <b style="color:#16a34a">▲</b>'; const up = cv >= pv; return ` <b style="color:${up ? '#16a34a' : '#dc2626'};font-size:8px">${up ? '▲' : '▼'}${Math.abs((cv - pv) / pv * 100).toFixed(0)}%</b>`; };
  const m0 = n => '$' + Math.round(n || 0);
  const quad = (cb, cc, pb, pc2) => `<td class="num sep">${_m2(cb)}${pc(cb, pb)}</td><td class="num">${_m2(cc)}${pc(cc, pc2)}</td><td class="num last lsep">${_m2(pb)}</td><td class="num last">${_m2(pc2)}</td>`;
  const dquad = (cd, pd) => `<td class="num sep">${m0(cd.billed)}${pc(cd.billed, pd.billed)}</td><td class="num">${m0(cd.commission)}${pc(cd.commission, pd.commission)}</td><td class="num last lsep">${m0(pd.billed)}</td><td class="num last">${m0(pd.commission)}</td>`;
  const span2 = (cVal, pVal) => `<td class="num sep" colspan="2">${cVal}</td><td class="num last lsep" colspan="2">${_m2(pVal)}</td>`;
  const TECHS_PER_PAGE = 4;
  const pages = [];
  for (let p = 0; p < T.length; p += TECHS_PER_PAGE) {
    const G = T.slice(p, p + TECHS_PER_PAGE);
    const rows = [
      `<tr><td class="rl">Total</td>${G.map(x => quad(x.c.billed, x.c.commission, x.p.billed, x.p.commission)).join('')}</tr>`,
      ...(G.some(x => x.c.refund || x.p.refund) ? [
        `<tr><td class="rl">Refunds</td>${G.map(x => `<td class="num sep" style="color:#dc2626">${x.c.refund ? '-$' + Math.abs(x.c.refund).toFixed(0) : '—'}</td><td class="num" style="color:#dc2626">${x.c.refundComm ? '-$' + Math.abs(x.c.refundComm).toFixed(0) : '—'}</td><td class="num last lsep" style="color:#dc2626">${x.p.refund ? '-$' + Math.abs(x.p.refund).toFixed(0) : '—'}</td><td class="num last" style="color:#dc2626">${x.p.refundComm ? '-$' + Math.abs(x.p.refundComm).toFixed(0) : '—'}</td>`).join('')}</tr>`,
      ] : []),
      `<tr><td class="rl">Check</td>${G.map(x => span2(_m2(x.cChk), x.pChk)).join('')}</tr>`,
      ...(G.some(x => x.cDed || x.pDed) ? [
        `<tr><td class="rl">Cash deduction</td>${G.map(x => `<td class="num sep" colspan="2" style="color:#dc2626">${x.cDed ? '-' + _m2(x.cDed) : '—'}</td><td class="num last lsep" colspan="2" style="color:#dc2626">${x.pDed ? '-' + _m2(x.pDed) : '—'}</td>`).join('')}</tr>`,
      ] : []),
      `<tr><td class="rl">Cash</td>${G.map(x => span2(_m2(x.cCash), x.pCash)).join('')}</tr>`,
      `<tr><td class="rl" style="font-weight:700">Total paid</td>${G.map(x => span2(_m2(x.cTotal), x.pTotal)).join('')}</tr>`,
      `<tr class="sec"><td class="rl">By day · billed / commission</td><td colspan="${G.length * 4}"></td></tr>`,
      ...curDays.map((day, i) => { const dl = new Date(day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' }); return `<tr><td class="rl">${dl}</td>${G.map(x => dquad(x.c.daily[day] || { billed: 0, commission: 0 }, x.p.daily[prevDays[i]] || { billed: 0, commission: 0 })).join('')}</tr>`; }),
    ].join('');
    const th1 = G.map(x => `<th colspan="4" class="sep" style="text-align:center">${_eTxn(x.tech.name)}${x.tech.commission != null ? ` ${x.tech.commission}%` : ''}</th>`).join('');
    const th2 = G.map(() => `<th colspan="2" class="sep" style="text-align:center">This</th><th colspan="2" class="lsep" style="text-align:center">Last</th>`).join('');
    const th3 = G.map(() => `<th class="num sep">Billed</th><th class="num">Comm</th><th class="num lsep">Billed</th><th class="num">Comm</th>`).join('');
    const pageNo = Math.floor(p / TECHS_PER_PAGE) + 1, pageCount = Math.ceil(T.length / TECHS_PER_PAGE);
    pages.push(`<div class="pg"${p + TECHS_PER_PAGE < T.length ? ' style="page-break-after:always"' : ''}>
      <h1>Muse Nails &amp; Spa — Payroll · ${_eTxn(period)}${pageCount > 1 ? ` <span class="pgno">· staff ${p + 1}–${p + G.length} of ${T.length} (page ${pageNo}/${pageCount})</span>` : ''}</h1>
      <table><thead><tr><th class="rl"></th>${th1}</tr><tr><th class="rl"></th>${th2}</tr><tr><th class="rl"></th>${th3}</tr></thead><tbody>${rows}</tbody></table>
    </div>`);
  }
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Muse Payroll — ${_eTxn(period)}</title><style>
    @page{size:11in 8.5in;margin:.4in} body{font-family:Arial,sans-serif;margin:0;color:#222}
    h1{color:#1a5252;font-size:15px;margin:0 0 8px} .pgno{color:#888;font-weight:400;font-size:11px} table{border-collapse:collapse;width:auto;font-size:9px}
    th,td{padding:3px 6px;border-bottom:1px solid #ddd;white-space:nowrap;text-align:left}
    thead th{background:#1a5252;color:#fff} thead{display:table-header-group} tr{page-break-inside:avoid}
    .num{text-align:right} .last{color:#888} .rl{font-weight:700;background:#f0f3f3} .sep{border-left:2px solid #1a5252} .lsep{border-left:1px solid #cfd8d8} .sec td{background:#e8eded;font-weight:700;text-transform:uppercase;font-size:8px}
  </style></head><body>${pages.join('')}</body></html>`;
  const u = URL.createObjectURL(new Blob([html], { type: 'text/html' })); const w = window.open(u, '_blank'); if (w) setTimeout(() => w.print(), 600); URL.revokeObjectURL(u);
  showToast('Payroll PDF opened — Print → Save as PDF (landscape)');
}
// Staff PDF: a landscape GRID of compact per-tech cards (4 across) — billed total +
// billed-by-day only (no commission/check/cash/%). Many techs per page so a printed
// sheet can be cut into individual handouts. The button opens a PICKER first so the
// owner can print receipts for just the staff who need one.
export function payrollExportStaffPDF() {
  const { cur, T } = payrollComputedRows();
  const techs = T.filter(x => x.c.billed || x.c.refund);
  if (!techs.length) { showToast('No billing this period.'); return; }
  const fmtD = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  document.getElementById('_staffpdf-modal')?.remove();
  const m = document.createElement('div');
  m.id = '_staffpdf-modal';
  m.className = 'fixed inset-0 z-[90] flex items-center justify-center bg-on-surface/40 px-4';
  m.onclick = e => { if (e.target === m) m.remove(); };
  const boxes = techs.map(x => `
    <label class="flex items-center gap-3 px-4 py-2.5 border-b border-surface-container-high last:border-0 cursor-pointer hover:bg-surface-container transition-colors">
      <input type="checkbox" class="staffpdf-cb w-5 h-5 accent-primary flex-shrink-0" value="${_eTxn(x.tech.id)}" checked onchange="staffPdfCount()">
      <span class="font-body font-semibold text-on-surface min-w-0 truncate">${_eTxn(x.tech.name)}</span>
      <span class="ml-auto text-sm font-body text-on-surface-variant flex-shrink-0">$${Math.round(x.c.billed)}</span>
    </label>`).join('');
  m.innerHTML = `<div class="bg-surface-container-lowest rounded-2xl p-5 w-full max-w-sm shadow-2xl">
    <div class="flex items-center justify-between mb-1">
      <h3 class="font-headline font-bold text-on-surface text-lg">Print staff receipts</h3>
      <button onclick="this.closest('.fixed').remove()" class="w-8 h-8 rounded-full hover:bg-surface-container flex items-center justify-center"><span class="material-symbols-outlined text-on-surface-variant" style="font-size:18px">close</span></button>
    </div>
    <p class="text-xs font-body text-on-surface-variant mb-3">${fmtD(cur.from)} – ${fmtD(cur.to)} · checked staff get a receipt</p>
    <div class="flex items-center gap-4 mb-2 text-sm font-body font-semibold">
      <button onclick="staffPdfAll(true)" class="text-primary hover:underline">Select all</button>
      <button onclick="staffPdfAll(false)" class="text-on-surface-variant hover:underline">Deselect all</button>
      <span id="staffpdf-count" class="ml-auto text-xs font-normal text-on-surface-variant"></span>
    </div>
    <div class="rounded-xl border border-surface-container-high overflow-y-auto" style="max-height:50vh">${boxes}</div>
    <div class="flex items-center gap-2 mt-4">
      <button onclick="this.closest('.fixed').remove()" class="px-4 py-2 rounded-xl border border-surface-container-high text-on-surface-variant font-body font-semibold text-sm">Cancel</button>
      <button id="staffpdf-go80" onclick="staffPdfPrint80()" title="Print on the 80mm receipt roll" class="ml-auto flex items-center gap-1 px-4 py-2 rounded-xl border border-primary text-primary font-headline font-bold text-sm hover:bg-primary/5"><span class="material-symbols-outlined" style="font-size:16px">print</span> 80mm roll</button>
      <button id="staffpdf-go" onclick="staffPdfPrint()" class="px-5 py-2 rounded-xl bg-primary text-on-primary font-headline font-bold text-sm">Letter sheet</button>
    </div>
  </div>`;
  document.body.appendChild(m);
  staffPdfCount();
}
export function staffPdfAll(on) {
  document.querySelectorAll('#_staffpdf-modal .staffpdf-cb').forEach(cb => { cb.checked = on; });
  staffPdfCount();
}
export function staffPdfCount() {
  const all = document.querySelectorAll('#_staffpdf-modal .staffpdf-cb');
  const sel = document.querySelectorAll('#_staffpdf-modal .staffpdf-cb:checked');
  const lbl = document.getElementById('staffpdf-count');
  if (lbl) lbl.textContent = `${sel.length} of ${all.length} selected`;
  [document.getElementById('staffpdf-go'), document.getElementById('staffpdf-go80')].forEach(go => {
    if (go) { go.disabled = !sel.length; go.style.opacity = sel.length ? '' : '0.5'; }
  });
}
export function staffPdfPrint() {
  const ids = new Set([...document.querySelectorAll('#_staffpdf-modal .staffpdf-cb:checked')].map(cb => cb.value));
  if (!ids.size) { showToast('Select at least one staff member.'); return; }
  document.getElementById('_staffpdf-modal')?.remove();
  _staffReceiptsPdf(ids);
}
function _staffReceiptsPdf(idSet) {
  const { cur, T, curDays } = payrollComputedRows();
  const techs = T.filter(x => (x.c.billed || x.c.refund) && idSet.has(x.tech.id));
  if (!techs.length) { showToast('No billing for the selected staff.'); return; }
  const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const period = `${fmt(cur.from)} – ${fmt(cur.to)}`;
  // Each tech = a plain receipt: centered shop / name / period, the day list, then the total.
  // Uniform size, no bold, all black, monospace — reads like a register slip you cut & hand out.
  const receipts = techs.map(x => {
    const rows = curDays.map(day => {
      const b = (x.c.daily[day] || { billed: 0 }).billed;
      const dl = new Date(day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
      return `<div class="line"><span>${dl}</span><span>$${b.toFixed(0)}</span></div>`;
    }).join('');
    const net = x.c.billed + (x.c.refund || 0);
    const rf = x.c.refund ? `<div class="line"><span>Refunds</span><span>-$${Math.abs(x.c.refund).toFixed(2)}</span></div><div class="line"><span>Net</span><span>$${net.toFixed(2)}</span></div>` : '';
    return `<div class="receipt">
      <div class="ctr">Muse Nails &amp; Spa</div>
      <div class="ctr">${_eTxn(x.tech.name)}</div>
      <div class="ctr">${_eTxn(period)}</div>
      <div class="dash"></div>
      ${rows}
      <div class="dash"></div>
      <div class="line"><span>Total</span><span>$${x.c.billed.toFixed(2)}</span></div>
      ${rf}
    </div>`;
  });
  // Two rows of four receipts per landscape sheet (8), page-break between sheets.
  const PER_SHEET = 8;
  let sheets = '';
  for (let i = 0; i < receipts.length; i += PER_SHEET) {
    const last = i + PER_SHEET >= receipts.length;
    sheets += `<div class="sheet"${last ? '' : ' style="page-break-after:always"'}>${receipts.slice(i, i + PER_SHEET).join('')}</div>`;
  }
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Staff Billing</title><style>
    @page{size:11in 8.5in;margin:.4in} body{font-family:'Courier New',monospace;margin:0;color:#000;font-size:10pt}
    .sheet{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
    .receipt{border:1px dashed #999;border-radius:6px;padding:9px 11px;break-inside:avoid;page-break-inside:avoid;line-height:1.32}
    .ctr{text-align:center}
    .dash{border-top:1px dashed #000;margin:5px 0}
    .line{display:flex;justify-content:space-between;gap:10px}
    .line span:last-child{font-variant-numeric:tabular-nums}
  </style></head><body>${sheets}</body></html>`;
  const u = URL.createObjectURL(new Blob([html], { type: 'text/html' })); const w = window.open(u, '_blank'); if (w) setTimeout(() => w.print(), 600); URL.revokeObjectURL(u);
  showToast('Staff receipts opened — two rows per sheet (cut to hand out)');
}
// 80mm receipt-roll version of the staff billing slips — one strip per tech,
// auto-cut, for the front-desk thermal printer.
export function staffPdfPrint80() {
  const ids = new Set([...document.querySelectorAll('#_staffpdf-modal .staffpdf-cb:checked')].map(cb => cb.value));
  if (!ids.size) { showToast('Select at least one staff member.'); return; }
  document.getElementById('_staffpdf-modal')?.remove();
  const { cur, T, curDays } = payrollComputedRows();
  const techs = T.filter(x => (x.c.billed || x.c.refund) && ids.has(x.tech.id));
  if (!techs.length) { showToast('No billing for the selected staff.'); return; }
  const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const period = `${fmt(cur.from)} – ${fmt(cur.to)}`;
  const rows = techs.map(x => ({
    name: x.tech.name,
    period,
    days: curDays.map(day => [
      new Date(day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' }),
      (x.c.daily[day] || { billed: 0 }).billed,
    ]),
    total: x.c.billed,
    refund: x.c.refund || 0,
  }));
  printTechReceipts80(rows);
}

// ── Transactions list ─────────────────────────────
export function txnToday() { setReportRange('today'); }
// "Paid by" chips for a transaction card — shows every tender that contributed, so a split
// (e.g. Card + Cash + Gift + Zelle) is obvious at a glance. Refunds and tender-less rows (older /
// direct Mark-Paid / deep-link) render nothing here.
function _paidByHtml(r) {
  if (r.status === 'refund' || !r.tenders) return '';
  const t = r.tenders;
  const chip = (label, amt, bg, fg) => `<span class="text-[10px] font-body font-bold px-2 py-0.5 rounded-full whitespace-nowrap" style="background:${bg};color:${fg}">${label} $${amt.toFixed(2)}</span>`;
  const chips = [];
  if (t.card  > 0) chips.push(chip('Card',  t.card,  'rgba(26,82,82,0.10)',  '#1a5252'));
  if (t.cash  > 0) chips.push(chip('Cash',  t.cash,  'rgba(42,122,79,0.12)', '#2a7a4f'));
  if (t.gift  > 0) chips.push(chip('Gift',  t.gift,  'rgba(212,134,10,0.16)','#a05000'));
  if (t.zelle > 0) chips.push(chip('Zelle', t.zelle, 'rgba(91,63,176,0.12)', '#5b3fb0'));
  if (!chips.length) return '';
  const split = chips.length > 1 ? '<span class="text-[9px] font-body font-semibold text-on-surface-variant uppercase tracking-wide">split</span>' : '';
  return `<div class="flex items-center gap-1.5 flex-wrap mt-1"><span class="text-[10px] font-body text-on-surface-variant uppercase tracking-wide">Paid</span>${chips.join('')}${split}</div>`;
}

// Read-only breakdown of a transaction (every service + its tech/cost, items, fees, discount,
// total, tip, and how it was paid). Opens in the drill panel; offers Edit when the row is editable.
export function showTxnDetail(recordId) {
  const all = buildCombinedRecords();
  const r = all.find(x => String(x.id) === String(recordId));
  if (!r) { showToast('Transaction not found.'); return; }
  const isRefund = r.status === 'refund', dt = new Date(r.checkinTime);
  const money = n => '$' + Math.abs(n || 0).toFixed(2);
  const line = (label, val, o = {}) => `<div class="flex justify-between items-baseline gap-3 py-1.5 ${o.border ? 'border-t border-surface-container-high mt-1 pt-2' : ''}"><span class="text-sm font-body ${o.strong ? 'font-headline font-bold text-on-surface' : 'text-on-surface-variant'} min-w-0">${_eTxn(label)}</span><span class="text-sm font-body whitespace-nowrap ${o.neg ? 'text-error' : o.strong ? 'font-headline font-bold text-on-surface' : 'text-on-surface'}">${o.neg ? '-' : ''}${money(val)}</span></div>`;
  const rows = [], drillRows = [];
  const add = (label, val, o) => { rows.push(line(label, val, o)); drillRows.push([label, (o?.neg ? '-' : '') + money(val)]); };
  (r.assignments || []).forEach(a => add(`${svc(a.serviceId)?.label || a.serviceId || 'Service'}${a.techId ? ' · ' + (staffById(a.techId)?.name || '—') : ''}${a.station ? ' @ ' + a.station : ''}${a.comped ? ' · ' + (a.compReason || 'Comp') : ''}`, a.cost || 0));
  if (!(r.assignments || []).length && !isRefund) (r.services || []).forEach(sid => add(svc(sid)?.label || sid, 0));
  (r.items || []).forEach(it => add(`${cfg().items.find(i => i.id === it.itemId)?.label || 'Item'} × ${it.qty || 1}`, (it.price || 0) * (it.qty || 0)));
  (r.fees || []).forEach(f => add(cfg().fees.find(x => x.id === f.feeId)?.label || 'Fee', f.amount || 0));
  if ((r.discount || 0) > 0) add(`Discount${r.discountNote ? ' (' + r.discountNote + ')' : ''}`, r.discount, { neg: true });
  rows.push(line(isRefund ? 'Refund total' : 'Sales Total', r.totalCost || 0, { strong: true, border: true, neg: isRefund }));
  drillRows.push([isRefund ? 'Refund total' : 'Sales Total', (isRefund ? '-' : '') + money(r.totalCost)]);
  if ((r.tip || 0) > 0) { rows.push(line('Tip (on card)', r.tip)); drillRows.push(['Tip', money(r.tip)]); }
  // Paid by — this record's tenders, or its party's primary (tenders live on the primary only).
  let tenders = r.tenders;
  if (!tenders && r.groupId) tenders = all.find(x => x.groupId === r.groupId && x.tenders)?.tenders;
  let paid = '';
  if (tenders) ['card', 'cash', 'gift', 'zelle'].forEach(k => { if (tenders[k] > 0) { const lbl = { card: 'Card', cash: 'Cash', gift: 'Gift card', zelle: 'Zelle' }[k]; paid += line('Paid · ' + lbl, tenders[k]); drillRows.push(['Paid ' + lbl, money(tenders[k])]); } });
  const isPast = dt < new Date(new Date().setHours(0, 0, 0, 0));
  const editBtn = (!isRefund && canDo('historicalEntry') && isPast)
    ? `<button onclick="closeDrillDown(); showHistoricalEntryModal('${r.id}')" class="w-full mt-3 py-2.5 rounded-xl border border-primary text-primary font-headline font-bold text-sm hover:bg-primary/5 transition-colors">Edit this transaction</button>` : '';
  _drill = { title: `${r.name || 'Transaction'} — Detail`, columns: ['Line', 'Amount'], rows: drillRows, summary: [[isRefund ? 'Refund' : 'Total', money(r.totalCost)], ...((r.tip || 0) > 0 ? [['Tip', money(r.tip)]] : [])] };
  showDrillPanel(`${_eTxn(r.name || 'Transaction')} — Detail`,
    `<div class="text-[11px] font-body text-outline mb-2">${dt.toLocaleDateString()} · ${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${r.phone ? ' · ' + _eTxn(r.phone) : ''} · ${isRefund ? 'Refund' : (r.status || 'paid')}${isRefund && r.discountNote ? ' · ' + _eTxn(r.discountNote) : ''}</div>${rows.join('')}${paid ? `<div class="mt-2 pt-2 border-t border-surface-container-high">${paid}</div>` : ''}${editBtn}`);
}

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
  const refundsTotal = combined.filter(r => r.status === 'refund').reduce((s,r)=>s+Math.abs(r.totalCost||0),0);
  const rfWrap = document.getElementById('txn-total-refunds-wrap'), rfEl = document.getElementById('txn-total-refunds');
  if (rfWrap) rfWrap.classList.toggle('hidden', refundsTotal === 0);
  if (rfEl && refundsTotal > 0) rfEl.textContent = `-$${refundsTotal.toFixed(2)}`;
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
    const assignRows = !isRefund && (r.assignments||[]).filter(a=>a.techId||a.cost||a.comped).map(a=>`<div class="text-[11px] font-body text-primary">${svc(a.serviceId)?.label||''} → ${staffById(a.techId)?.name||'—'}${a.station?' @ '+a.station:''} ${a.comped?'· '+(a.compReason||'Comp'):(a.cost?'· $'+a.cost.toFixed(2):'')}</div>`).join('');
    const refundNote = isRefund && r.discountNote ? `<div class="text-[11px] font-body text-error mt-1">Reason: ${r.discountNote}</div>` : '';
    const isPast = new Date(r.checkinTime) < new Date(new Date().setHours(0,0,0,0));
    const editable = !isRefund && canDo('historicalEntry') && isPast;   // whole card opens the edit modal
    const totalDisplay = isRefund ? `<div class="text-lg font-headline font-extrabold text-error">-$${Math.abs(r.totalCost||0).toFixed(2)}</div>` : `<div class="text-lg font-headline font-extrabold text-primary">$${(r.totalCost||0).toFixed(2)}</div>`;
    return `<div onclick="showTxnDetail('${r.id}')" title="Tap for the full breakdown" class="bg-surface-container-lowest rounded-xl px-5 py-4 border ${isRefund?'border-error/30':'border-surface-container-high'} cursor-pointer hover:shadow-md transition-shadow">
      <div class="flex items-start justify-between"><div class="flex-grow min-w-0">
        <div class="flex items-center gap-2 flex-wrap mb-1"><span class="font-headline font-bold text-on-surface">${r.name}</span><span class="text-[11px] px-2 py-0.5 rounded-full font-body font-semibold ${badgeClass}">${isRefund?'refund':r.status}</span>${!isRefund&&r.isAppointment?'<span class="badge-appointment text-[11px] px-2 py-0.5 rounded-full font-body font-semibold">Appt</span>':''}</div>
        <div class="text-xs font-body text-on-surface-variant mb-1">${serviceLabels}</div>${assignRows||''}${refundNote}
        <div class="text-[11px] font-body text-outline mt-1">${dateStr} · ${timeStr}${r.phone?' · '+r.phone:''}</div>${_paidByHtml(r)}${r.tip ? `<div class="text-[11px] font-body text-primary font-semibold mt-0.5">Tip $${r.tip.toFixed(2)}</div>` : ''}</div>
        <div class="ml-4 flex-shrink-0 flex items-center gap-2">
          <div class="flex items-center gap-1">
            ${!isRefund?`<button onclick="event.stopPropagation();printCustomerReceipt('${r.id}')" title="Print receipt on the roll" class="flex items-center gap-1 text-[11px] font-body text-outline hover:text-primary transition-colors px-2 py-1 rounded-lg hover:bg-primary/10"><span class="material-symbols-outlined" style="font-size:14px">print</span> Print</button>`:''}
            ${!isRefund?`<button onclick="event.stopPropagation();reprintTerminalReceipt('${r.id}')" title="Reprint the card receipt on the terminal" class="flex items-center gap-1 text-[11px] font-body text-outline hover:text-primary transition-colors px-2 py-1 rounded-lg hover:bg-primary/10"><span class="material-symbols-outlined" style="font-size:14px">receipt_long</span> Receipt</button>`:''}
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
  // Restricted to the app manager + admin only (not configurable per-role) — historical
  // entry rewrites financial records, so it stays locked to the two trusted roles.
  const allowed = ['admin', 'manager'].includes(getActiveUser()?.role);
  document.getElementById('add-historical-btn')?.classList.toggle('hidden', !allowed);
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
    tip: r.tip ? r.tip.toFixed(2) : '',
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
    ['Muse Nails & Spa — Transactions'], [`Showing: ${rangeLabel()}`], [`Tickets: ${rows.length}`, `Net total: $${net.toFixed(2)}`], [],
    ['Date','Time','Customer','Phone','Party','Services','Technicians','Items','Fees','Discount','Tip','Total','Status'],
    ...rows.map(r => [r.date, r.time, r.customer, r.phone, r.party, r.services, r.techs, r.items, r.fees, r.discount, r.tip, r.total, r.status]),
  ];
  const csv = matrix.map(line => line.map(c => `"${String(c==null?'':c).replace(/"/g,'""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿'+csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a'); a.href = url; a.download = `muse-transactions-${localDateStr(getReportDates()?.from || new Date())}.csv`; a.click(); URL.revokeObjectURL(url);
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
  const tr = rows.map(r => `<tr><td>${r.date}</td><td>${r.time}</td><td>${_eTxn(r.customer)}</td><td style="text-align:center">${r.party}</td><td>${_eTxn(r.services)}</td><td>${_eTxn(r.techs)}</td><td>${_eTxn(r.items)}</td><td style="text-align:right">${r.fees?'$'+r.fees:''}</td><td style="text-align:right">${r.discount?'-$'+r.discount:''}</td><td style="text-align:right">${r.tip?'$'+r.tip:''}</td><td style="text-align:right">${r.total}</td><td>${r.status}</td></tr>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Muse Transactions — ${_eTxn(rangeLabel())}</title><style>
    body{font-family:Arial,sans-serif;font-size:11px;color:#222;margin:20px}.h{display:flex;align-items:center;gap:14px;margin-bottom:6px}.logo{max-width:140px;max-height:52px;width:auto;height:auto;object-fit:contain;border-radius:8px;flex-shrink:0}
    h1{color:#1a5252;font-size:18px;margin:0 0 2px}.sub{color:#666;margin:0;font-size:12px}
    .tot{background:#1a5252;color:#fff;border-radius:10px;padding:10px 16px;display:inline-block;margin:12px 0 16px}.tot .v{font-size:22px;font-weight:800;line-height:1}.tot .l{font-size:10px;text-transform:uppercase;letter-spacing:.5px;opacity:.85}
    table{width:100%;border-collapse:collapse}th{background:#1a5252;color:#fff;padding:5px 6px;text-align:left;font-size:10px}td{padding:4px 6px;border-bottom:1px solid #e0e0e0;font-size:10px;vertical-align:top}tr:nth-child(even) td{background:#fafafa}
    .footer{margin-top:20px;font-size:10px;color:#999;text-align:center}
  </style></head><body>
    <div class="h">${logo?`<img src="${logo}" class="logo" onerror="this.style.display='none'">`:''}<div><h1>Muse Nails &amp; Spa — Transactions</h1><p class="sub">${_eTxn(rangeLabel())} · ${rows.length} ticket${rows.length===1?'':'s'}</p></div></div>
    <div class="tot"><div class="v">$${net.toFixed(2)}</div><div class="l">Net total</div></div>
    <table><thead><tr><th>Date</th><th>Time</th><th>Customer</th><th>Party</th><th>Services</th><th>Tech</th><th>Items</th><th>Fees</th><th>Disc</th><th>Tip</th><th>Total</th><th>Status</th></tr></thead><tbody>${tr}</tbody></table>
    <div class="footer">Generated ${new Date().toLocaleString()} · Muse Nails &amp; Spa</div></body></html>`;
}

// ── CSV export ────────────────────────────────────
export function exportReportExcel() {
  const d = window._currentReportData;
  if (!d || d.filtered.length === 0) { showToast('No data to export.'); return; }
  // Per-day totals section ("tab") — same filtered records, grouped by calendar day,
  // using the same billed/guest/tips/payment-mix logic as the main report.
  const _byDay = {};
  d.filtered.forEach(r => { const k = localDateStr(new Date(r.checkinTime)); (_byDay[k] = _byDay[k] || []).push(r); });
  const _dailyRows = Object.keys(_byDay).sort().map(k => {
    const recs = _byDay[k];
    const billed = recs.reduce((s, r) => s + (r.totalCost || 0), 0);
    const guests = recs.filter(r => isPaidStatus(r.status)).length;
    const tips = recs.reduce((s, r) => s + (r.tip || 0), 0);
    const mix = paymentMix(recs, tips);
    return [new Date(k + 'T12:00:00').toLocaleDateString(), guests, `$${billed.toFixed(2)}`, `$${tips.toFixed(2)}`, `$${mix.cardMix.toFixed(2)}`, `$${mix.cashMix.toFixed(2)}`, `$${mix.zelleMix.toFixed(2)}`, `$${mix.giftMix.toFixed(2)}`, `$${mix.otherMix.toFixed(2)}`];
  });
  const rows = [
    ['Muse Nails & Spa — Report'], [`Period: ${d.from.toLocaleDateString()} – ${d.to.toLocaleDateString()}`],
    [`Total Billed: $${d.totalIncome.toFixed(2)}`, `Guests Served: ${d.guestCount}`, `Avg Ticket: $${(d.totalIncome/Math.max(d.guestCount,1)).toFixed(2)}`],
    [`Total Money Collected: $${(d.totalIncome+(d.gcSoldValue||0)-(d.gcRedeemed||0)+(d.tipsTotal||0)).toFixed(2)}`, `Total Tips: $${(d.tipsTotal||0).toFixed(2)}`],
    [`Payment Mix — Card (incl. tips): $${(d.cardMix||0).toFixed(2)}`, `Cash: $${(d.cashMix||0).toFixed(2)}`, `Gift: $${(d.giftMix||0).toFixed(2)}`, `Zelle: $${(d.zelleMix||0).toFixed(2)}`, `Other: $${(d.otherMix||0).toFixed(2)}`], [],
    ['DAILY TOTALS'], ['Date','Guests','Billed','Tips','Card','Cash','Zelle','Gift','Other'],
    ..._dailyRows, [],
    ['CHECK-INS'], ['Date','Time','Name','Phone','Services','Type','Staff','Total','Status'],
    ...d.filtered.map(r => { const dt = new Date(r.checkinTime); const staffNames = (r.assignments||[]).map(a=>staffById(a.techId)?.name).filter(Boolean).join(', '); return [dt.toLocaleDateString(), dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}), r.name, r.phone, r.services.map(sid=>svc(sid)?.label||sid).join(', '), r.isAppointment?'Appointment':'Walk-In', staffNames, r.totalCost?`$${r.totalCost.toFixed(2)}`:'$0.00', r.status]; }),
    [], ['STAFF BREAKDOWN'], ['Technician','Services','Turns','Bonus Turns','Total Billed','Commission %','Commission Earned','Salon Keeps'],
    ...Object.entries(d.staffMap).map(([techId,data])=>{ const tech = staffById(techId); const commPct = tech?.commission!=null?tech.commission:null; const commAmt = commPct!=null?data.income*commPct/100:0; return [tech?.name||'Unknown', data.count, data.fullTurns+data.halfTurns, data.bonusTurns, `$${data.income.toFixed(2)}`, commPct!=null?`${commPct}%`:'N/A', `$${commAmt.toFixed(2)}`, `$${(data.income-commAmt).toFixed(2)}`]; }),
    [], ['GIFT CARDS (separate ledger — not in service income)'],
    ['Sold this period', `$${(d.gcSoldValue||0).toFixed(2)}`], ['Redeemed this period', `$${(d.gcRedeemed||0).toFixed(2)}`], ['Outstanding balance (all cards)', `$${(d.gcOutstanding||0).toFixed(2)}`],
  ];
  const csv = rows.map(r => r.map(c => `"${String(c||'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a'); a.href = url; a.download = `muse-report-${localDateStr(d.from)}.csv`; a.click(); URL.revokeObjectURL(url);
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
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Muse Report ${period}</title><style>
    body{font-family:Arial,sans-serif;font-size:12px;color:#222;margin:24px}.report-header{display:flex;align-items:center;gap:16px;margin-bottom:8px}.report-logo{max-width:140px;max-height:56px;width:auto;height:auto;object-fit:contain;border-radius:8px;flex-shrink:0}
    h1{color:#1a5252;font-size:20px;margin:0 0 2px}h2{color:#1a5252;font-size:14px;margin:20px 0 8px;border-bottom:2px solid #1a5252;padding-bottom:4px}
    .summary{display:flex;gap:24px;margin:12px 0 20px;flex-wrap:wrap}.card{background:#f5f5f5;border-radius:8px;padding:10px 16px;min-width:120px;text-align:center}.card .val{font-size:20px;font-weight:bold;color:#1a5252}.card .lbl{font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px}.card.amber .val{color:#a05000}
    table{width:100%;border-collapse:collapse;margin-bottom:16px}th{background:#1a5252;color:#fff;padding:6px 8px;text-align:left;font-size:11px}td{padding:5px 8px;border-bottom:1px solid #e0e0e0;font-size:11px}tr:nth-child(even) td{background:#fafafa}.footer{margin-top:24px;font-size:10px;color:#999;text-align:center}
  </style></head><body>
    <div class="report-header">${logo?`<img src="${logo}" class="report-logo" onerror="this.style.display='none'">`:''}<div><h1>Muse Nails &amp; Spa — Daily Report</h1><p style="color:#666;margin:0">${period}</p></div></div>
    <div class="summary"><div class="card"><div class="val">$${(d.totalIncome+(d.gcSoldValue||0)-(d.gcRedeemed||0)+(d.tipsTotal||0)).toFixed(2)}</div><div class="lbl">Total Money Collected</div></div><div class="card"><div class="val">$${d.totalIncome.toFixed(2)}</div><div class="lbl">Total Billed</div></div><div class="card"><div class="val">${d.guestCount}</div><div class="lbl">Guests Served</div></div><div class="card"><div class="val">$${(d.totalIncome/Math.max(d.guestCount,1)).toFixed(2)}</div><div class="lbl">Avg Ticket</div></div><div class="card"><div class="val">$${(d.tipsTotal||0).toFixed(2)}</div><div class="lbl">Total Tips</div></div><div class="card"><div class="val">$${shopKeeps.toFixed(2)}</div><div class="lbl">Shop Keeps</div></div><div class="card amber"><div class="val">$${totalComm.toFixed(2)}</div><div class="lbl">Commission Owed</div></div></div>
    <h2>Staff Breakdown</h2><table><thead><tr><th>Technician</th><th>Services</th><th>Turns</th><th>Billed</th><th>Comm %</th><th>Commission</th><th>Shop Keeps</th></tr></thead><tbody>${staffRows}</tbody></table>
    <h2>Transactions (${d.filtered.length})</h2><table><thead><tr><th>Date</th><th>Time</th><th>Customer</th><th>Services</th><th>Staff</th><th>Total</th><th>Status</th></tr></thead><tbody>${txRows}</tbody></table>
    <div class="footer">Generated ${new Date().toLocaleString()} · Muse Nails &amp; Spa</div></body></html>`;
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
    // Unguessable key: GET /photos/* stays public (so the link is shareable without
    // leaking the §13 app token), so a plain date key would let anyone enumerate
    // daily reports — the random suffix makes the URL itself the capability.
    const rand = Math.random().toString(36).slice(2, 10);
    const res = await fetch(`${PHOTOS_PROXY}/reports/${localDateStr(d.from)}-${rand}.html`, { method: 'PUT', body: new TextEncoder().encode(buildReportHtml(d)), headers: { 'Content-Type': 'text/html;charset=utf-8' } });
    if (!res.ok) throw new Error(res.status);
    const url = (await res.json()).url;
    try { await navigator.clipboard.writeText(url); } catch (e) {}
    showToast('Link copied to clipboard ✓');
  } catch (e) { showToast('Upload failed — check connection'); }
}

// ── Refunds ───────────────────────────────────────
let _refundTxnId = null, _refundTxnRecord = null;
// A sale can be refunded IN Square for any portion recorded there as a payment — card, cash, or
// Zelle (external). Card sends money back to the card; cash/Zelle are recorded refunds (the operator
// returns those by hand). Gift-card portions never hit Square, so they're excluded. A tender-less
// record (older / deep-link era) falls back to its full total.
const _squareRefundable = rec => (rec?.squarePaymentIds?.length)
  ? (((rec?.tenders?.card || 0) + (rec?.tenders?.cash || 0) + (rec?.tenders?.zelle || 0)) || (rec?.totalCost || 0))
  : 0;
// Helcim can only refund the CARD portion back to the card (cash/Zelle were never in Helcim —
// those are returned from the drawer / by hand). The stored Helcim card txn = squarePaymentIds[0].
const _helcimRefundable = rec => {
  if (!rec?.squarePaymentIds?.length) return 0;
  if (rec.tenders) return rec.tenders.card || 0;     // mixed tenders → only the card is Helcim-refundable
  return rec.totalCost || 0;                          // older record with no tender breakdown → assume all card
};
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
  // Card-refund toggle: shown only when the sale has a card payment to send back; ALWAYS reset to OFF
  // (per-refund opt-in) so nothing goes back to the card without an explicit tap. Routes to the ACTIVE
  // processor — Helcim now, or Square for legacy sales.
  const helcim = helcimActive();
  const cardAmt = helcim ? _helcimRefundable(rec) : _squareRefundable(rec);
  const row = document.getElementById('refund-square-row'), cb = document.getElementById('refund-to-square');
  if (cb) cb.checked = false;
  if (row) row.classList.toggle('hidden', cardAmt <= 0);
  const procLbl = document.getElementById('refund-processor-label');
  if (procLbl) procLbl.textContent = helcim ? 'to the card (Helcim)' : 'in Square';
  if (cardAmt > 0) { const a = document.getElementById('refund-square-amt'); if (a) a.textContent = helcim ? `up to $${cardAmt.toFixed(2)} back to the card` : `up to $${cardAmt.toFixed(2)} in Square`; }
  // Cash-from-drawer row: shown only when a drawer is open, so a cash refund can log a Cash Out
  // and the close reconciliation isn't thrown short. Always reset OFF (per-refund opt-in).
  const coRow = document.getElementById('refund-cash-out-row'), coCb = document.getElementById('refund-cash-out');
  if (coCb) coCb.checked = false;
  if (coRow) coRow.classList.toggle('hidden', !cfg().cash_drawer);
  const m = document.getElementById('refund-modal'); m.classList.remove('hidden'); m.style.display = 'flex';
  setTimeout(() => document.getElementById('refund-reason')?.focus(), 100);
}
// Refund a sale's Square payments — card (money back to the card), cash, and Zelle/external
// (recorded refunds). Refunds across the sale's payments to cover the amount (CARD first so real
// money goes back before cash/external records), each capped at its refundable balance, idempotent
// per (record + payment + cents). Returns { ok, refundIds, refundedCents, error }.
async function refundInSquare(record, amountDollars, reason) {
  const ids = record?.squarePaymentIds || [];
  if (!ids.length) return { ok: false, error: 'No Square payment on this sale.' };
  const pays = [];
  for (const id of ids) {
    try {
      const r = await fetch(`${SQUARE_PROXY}/v2/payments/${id}`);
      if (!r.ok) continue;
      const p = (await r.json()).payment; if (!p) continue;
      const refundable = (p.amount_money?.amount || 0) - (p.refunded_money?.amount || 0);
      if (refundable > 0) pays.push({ id, refundable, source: p.source_type || '' });
    } catch (e) {}
  }
  if (!pays.length) return { ok: false, error: 'No refundable Square payment found for this sale.' };
  const rank = s => (s === 'CARD' ? 0 : s === 'CASH' ? 1 : 2);
  pays.sort((a, b) => rank(a.source) - rank(b.source));
  const wantCents = Math.round(amountDollars * 100);
  let remaining = wantCents; const refundIds = [];
  for (const p of pays) {
    if (remaining <= 0) break;
    const cents = Math.min(remaining, p.refundable);
    if (cents <= 0) continue;
    try {
      const res = await fetch(`${SQUARE_PROXY}/v2/refunds`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotency_key: `refund-${record.id}-${p.id}-${cents}`, payment_id: p.id, amount_money: { amount: cents, currency: 'USD' }, reason: (reason || 'Refund').slice(0, 192) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: j.errors?.[0]?.detail || `Square error ${res.status}`, refundIds, refundedCents: wantCents - remaining };
      if (j.refund?.id) refundIds.push(j.refund.id);
      remaining -= cents;
    } catch (e) { return { ok: false, error: 'Could not reach Square', refundIds, refundedCents: wantCents - remaining }; }
  }
  if (remaining > 0) return { ok: false, error: `Only $${((wantCents - remaining) / 100).toFixed(2)} was refundable in Square (the rest is gift-card or already refunded).`, refundIds, refundedCents: wantCents - remaining };
  return { ok: true, refundIds, refundedCents: wantCents };
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
export async function confirmRefund() {
  const reason = document.getElementById('refund-reason').value.trim();
  const amount = parseFloat(document.getElementById('refund-amount').value) || 0;
  if (!reason) { showToast('Please enter a reason for the refund.'); return; }
  if (amount <= 0) { showToast('Refund amount must be greater than zero.'); return; }
  if (amount > (_refundTxnRecord?.totalCost || 0)) { showToast('Refund cannot exceed the original total.'); return; }
  const o = _refundTxnRecord, refundOfId = _refundTxnId, now = new Date().toISOString();
  // Optional: push the refund through the active card processor FIRST (opt-in toggle, default off).
  // If the operator asked for it but it fails, stop and surface the error — don't record an app refund
  // that implies money went back when it didn't. squareRefundIds carries the processor's refund id(s)
  // (Helcim or Square — the field name is kept, like squarePaymentIds, for back-compat).
  const wantCardRefund = !!document.getElementById('refund-to-square')?.checked;
  let squareRefundIds = null;
  let refundAmount = amount;   // may be lowered to what the processor ACTUALLY returned on a partial failure
  if (wantCardRefund && helcimActive() && _helcimRefundable(o) > 0) {
    // ── Helcim: send the card portion back to the card. ──
    const helcimTxn = o.squarePaymentIds?.[0];
    const cardAmt = Math.min(amount, _helcimRefundable(o));   // Helcim returns only the card portion
    const btn = document.querySelector('#refund-modal button[onclick="confirmRefund()"]'); if (btn) { btn.disabled = true; btn.textContent = 'Refunding to the card…'; }
    // Idempotency key = sale + txn + cents + (# refunds already recorded for this sale). A retry after a
    // timeout runs BEFORE the new refund record is saved, so the count is unchanged → SAME key → Helcim
    // returns the same refund (never a 2nd charge back). A genuine later partial of the same amount runs
    // AFTER the prior one is recorded → count differs → a fresh key → it processes normally.
    const priorRefunds = records().filter(r => r.status === 'refund' && String(r.refundOf) === String(o.id)).length;
    const r = await refundOnHelcim(helcimTxn, cardAmt, { idempotencyKey: `${o.id}-${helcimTxn}-${Math.round(cardAmt * 100)}-${priorRefunds}` });
    if (btn) { btn.disabled = false; btn.textContent = 'Confirm Refund'; }
    if (!r.ok) { showToast('Helcim refund failed: ' + r.error + ' — nothing recorded.'); return; }
    squareRefundIds = r.transactionId ? [String(r.transactionId)] : [];
    showToast(cardAmt < amount
      ? `Refunded $${cardAmt.toFixed(2)} to the card ✓ — the remaining $${(amount - cardAmt).toFixed(2)} (cash/Zelle) is recorded; return it by hand.`
      : `Refunded $${cardAmt.toFixed(2)} to the card ✓`);
  } else if (wantCardRefund && !helcimActive() && _squareRefundable(o) > 0) {
    const btn = document.querySelector('#refund-modal button[onclick="confirmRefund()"]'); if (btn) { btn.disabled = true; btn.textContent = 'Refunding in Square…'; }
    const r = await refundInSquare(o, amount, reason);
    if (btn) { btn.disabled = false; btn.textContent = 'Confirm Refund'; }
    const refunded = (r.refundedCents || 0) / 100;
    if (!r.ok) {
      // Square may have already returned PART of the money (multi-tender: card succeeded, a later
      // tender failed). Never claim "nothing recorded" when money went back — record exactly what
      // was refunded and tell the operator to finish the rest by hand.
      if (refunded > 0) {
        refundAmount = refunded;
        squareRefundIds = (r.refundIds || []).filter(Boolean);
        showToast(`Square partially refunded $${refunded.toFixed(2)} — recording that; finish the remainder by hand.`);
      } else {
        showToast('Square refund failed: ' + (r.error || 'error') + ' — nothing recorded.');
        return;
      }
    } else {
      squareRefundIds = (r.refundIds || []).filter(Boolean);
      showToast(`Refunded $${refunded.toFixed(2)} in Square ✓`);
    }
  }
  // Refunds are dated to when they're issued (checkinTime = now) so they land in the
  // CURRENT period's totals in Reports/Payroll. refundTechBilled carries the original's
  // per-tech billed (negated, scaled for partial refunds) so the Payroll page can show a
  // per-tech Refunds line and — when config.commission_includes_refunds is on — dock pay.
  const origTotal = o.totalCost || refundAmount;
  const ratio = origTotal > 0 ? refundAmount / origTotal : 1;
  const refundTechBilled = (o.assignments || [])
    .filter(a => a.techId)
    .map(a => ({ techId: a.techId, billed: -((a.cost || 0) * ratio) }));
  const record = { id: newEntryId(), name: o.name, phone: o.phone||'', services: o.services||[], assignments: [], items: [], fees: [], discount: 0, discountNote: reason, totalCost: -refundAmount, checkinTime: now, completedAt: now, status: 'refund', isAppointment: false, refundOf: refundOfId, refundTechBilled, loggedBy: getActiveUser()?.name || '', ...(squareRefundIds && squareRefundIds.length ? { squareRefundIds } : {}) };
  dispatch('record.save', { record });
  window.logAudit?.('Refund', `${o.name || '—'} · $${refundAmount.toFixed(2)}${squareRefundIds && squareRefundIds.length ? ' · refunded in Square' : ''}${reason ? ' · ' + reason : ''}`);
  // If the operator returned cash from the open drawer, log a Cash Out so the shift reconciliation
  // accounts for the physical cash that left (otherwise the drawer reads a phantom short at close).
  if (document.getElementById('refund-cash-out')?.checked) window.cdRecordCashOut?.(refundAmount, `Refund: ${o.name || ''}`.trim());
  closeRefundModal();
  renderTransactions();
  if (document.getElementById('panel-reports')?.classList.contains('active')) runReport();
  showToast(`Refund of $${refundAmount.toFixed(2)} recorded ✓`);
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
let _histMode = 'add', _histEditId = null, _histType = 'Walk-In', _histSelectedSvcs = [], _histAssignments = {}, _histItems = [], _histFees = [], _histMethod = 'card';
// Payment-method selector for a historical entry → recorded as a `tenders` map so the sale shows in
// the Payment Mix + reconcile (was previously saved with NO tender → landed in Other/Untracked).
// 'other' = leave untracked (no tender). card/cash/zelle/gift write tenders[method] = bill total.
export function setHistMethod(m) {
  _histMethod = m;
  ['card', 'cash', 'zelle', 'gift', 'other'].forEach(k => {
    const el = document.getElementById('hist-method-' + k); if (!el) return;
    const on = k === m;
    el.classList.toggle('border-primary', on); el.classList.toggle('bg-primary', on); el.classList.toggle('text-on-primary', on);
    el.classList.toggle('border-outline-variant', !on); el.classList.toggle('bg-transparent', !on); el.classList.toggle('text-on-surface', !on);
  });
}
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
    { const t = document.getElementById('hist-tip'); if (t) t.value = rec.tip > 0 ? rec.tip : ''; }
    _histSelectedSvcs = [...(rec.services || [])];
    rec.assignments.forEach(a => { if (a.serviceId) _histAssignments[a.serviceId] = { techId: a.techId||'', station: a.station||'', cost: a.cost||0 }; });
    _histItems = (rec.items||[]).map(i => ({ itemId: i.itemId, qty: i.qty||1, price: i.price||0 }));
    _histFees = (rec.fees||[]).map(f => ({ feeId: f.feeId, amount: f.amount||0 }));
    _histType = rec.isAppointment ? 'Appointment' : 'Walk-In';
    const t = rec.tenders || {}; _histMethod = ['card','cash','zelle','gift'].find(k => (t[k]||0) > 0) || 'other';
    { const rf = document.getElementById('hist-ref'); if (rf) rf.value = (rec.squarePaymentIds || [])[0] || ''; }
  } else {
    if (title) title.textContent = 'Add Historical Transaction';
    document.getElementById('hist-date').value = (prefillDate && prefillDate < todayStr()) ? prefillDate : yesterdayStr;
    document.getElementById('hist-time').value = '12:00';
    document.getElementById('hist-name').value = '';
    document.getElementById('hist-phone').value = '';
    document.getElementById('hist-discount').value = '';
    document.getElementById('hist-discount-note').value = '';
    { const t = document.getElementById('hist-tip'); if (t) t.value = ''; }
    { const rf = document.getElementById('hist-ref'); if (rf) rf.value = ''; }
    _histType = 'Walk-In'; _histMethod = 'card';
  }
  setHistType(_histType); setHistMethod(_histMethod); _renderHistServices(); _renderHistAssignments(); _renderHistItems(); _renderHistFees(); _computeHistTotal();
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
  const base = svcTotal + itemsTotal + feesTotal;
  const discount = Math.min(parseFloat(document.getElementById('hist-discount')?.value) || 0, base);   // can't discount below $0
  const total = Math.max(0, base - discount);
  const el = document.getElementById('hist-total-display'); if (el) el.textContent = `$${total.toFixed(2)}`;
  return total;
}
export { _computeHistTotal };
export function saveHistoricalTransaction() {
  const name = document.getElementById('hist-name').value.trim();
  const phone = document.getElementById('hist-phone').value.trim();
  const dateVal = document.getElementById('hist-date').value;
  const timeVal = document.getElementById('hist-time').value || '12:00';
  const discountNote = document.getElementById('hist-discount-note').value.trim();
  const tip = parseFloat(document.getElementById('hist-tip')?.value) || 0;   // card tip — recorded only; NOT part of totalCost (no re-charge)
  if (!name) { showToast('Customer name is required'); return; }
  if (!dateVal) { showToast('Date is required'); return; }
  if (dateVal >= todayStr()) { showToast('Date must be before today'); return; }
  const checkinTime = new Date(`${dateVal}T${timeVal}:00`);
  // Cap the discount against the ticket base (mirrors the live Assign & Price path) so an
  // over-discount can't silently persist a $0 record with a discount larger than the bill.
  const _histBase = _histSelectedSvcs.reduce((s,sid)=>s+(parseFloat(_histAssignments[sid]?.cost)||0),0)
    + _histItems.reduce((s,i)=>s+(i.qty||0)*(i.price||0),0)
    + _histFees.reduce((s,f)=>s+(parseFloat(f.amount)||0),0);
  const _rawDiscount = parseFloat(document.getElementById('hist-discount').value) || 0;
  const discount = Math.min(_rawDiscount, _histBase);
  if (_rawDiscount > _histBase) showToast(`Discount capped at $${_histBase.toFixed(2)}`);
  const total = _computeHistTotal();
  const assignments = _histSelectedSvcs.map(sid => ({ serviceId: sid, techId: _histAssignments[sid]?.techId||'', station: _histAssignments[sid]?.station||'', cost: parseFloat(_histAssignments[sid]?.cost)||0, status: 'paid', assignedAt: checkinTime.getTime() }));
  const items = _histItems.filter(i => i.itemId && i.qty > 0).map(i => ({ itemId: i.itemId, qty: i.qty, price: i.price }));
  const fees = _histFees.filter(f => f.feeId && f.amount > 0).map(f => ({ feeId: f.feeId, amount: f.amount }));
  // Only collapse into a synthetic lump-sum assignment when there are NO items AND NO fees — otherwise
  // the items/fees are already counted and a synthetic assignment carrying the FULL total would DOUBLE
  // them when buildCombinedRecords re-derives the record via ticketTotal (assignments + items + fees).
  if (assignments.length === 0 && items.length === 0 && fees.length === 0 && total > 0) assignments.push({ serviceId:'', techId:'', station:'', cost: total, status:'paid', assignedAt: checkinTime.getTime() });
  // Tender from the selected method (so it shows in the Payment Mix + reconcile). 'other' → no
  // tender (untracked, as before). Always set both keys (even to undefined) so editing a record to
  // 'other'/clearing the ref drops the old value rather than the spread keeping a stale one.
  const _ref = (document.getElementById('hist-ref')?.value || '').trim();
  const tenders = (_histMethod && _histMethod !== 'other' && total > 0) ? { [_histMethod]: total } : undefined;
  const base = { name, phone, services: _histSelectedSvcs, assignments, items, fees, discount, discountNote, tip, totalCost: total, checkinTime: checkinTime.toISOString(), status: 'paid', isAppointment: _histType === 'Appointment', loggedBy: getActiveUser()?.name || 'Admin', tenders, squarePaymentIds: _ref ? [_ref] : undefined };
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
