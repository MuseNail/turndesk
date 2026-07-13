// ── Cash Register / Cash Drawer ──────────────────────────────────────────────
// A salon-wide cash drawer (one open shift at a time), synced via config.cash_drawer;
// closed shifts append to config.cash_drawer_history.
//
//   Open  → count the cash by bill denomination ($1–$100) → opening total.
//   Day   → record cash IN / cash OUT (making change, payouts) with a reason.
//   Close → count again; reconcile against EXPECTED cash and show over/short.
//
//   Expected = opening + cash sales + cash-in − cash-out.
//   "Cash sales" sums r.tenders.cash for records paid during the shift; that field is
//   the sale amount applied in cash (change already netted out — see square-pos.js).
//   Counts are bills-only by design, so any coins/cents land in over/short.
import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { getActiveUser } from '../session.js';
import { showToast, todayStr, localDateStr, newEntryId, commitNumpad, escHtml, businessName } from '../utils.js';
import { isPaidStatus } from './status.js';

const cfg = () => getState().config;
const DENOMS = [100, 50, 20, 10, 5, 1];
const HISTORY_CAP = 365;

export function currentDrawer() { return cfg().cash_drawer || null; }
export function isDrawerOpen()  { return !!currentDrawer(); }

let _cdView = 'auto';        // auto | open | active | close | in | out | history
let _countDraft = {};        // { [denom]: qty } for the open/close count sheet

const _emptyCounts = () => DENOMS.reduce((o, d) => (o[d] = 0, o), {});
export function countTotal(c) { return DENOMS.reduce((s, d) => s + d * Math.max(0, parseInt(c?.[d], 10) || 0), 0); }
const money = n => '$' + (Number(n) || 0).toFixed(2);
// Per-denomination bill count, e.g. "2×$100 · 8×$20 · 15×$1".
// Vertical bill-count table (large, phone-friendly): one row per denomination + a total row.
const billCountTable = (counts, label) => {
  const rows = DENOMS.filter(d => (counts?.[d] || 0) > 0)
    .map(d => `<tr><td class="py-1 text-on-surface">$${d}</td><td class="py-1 text-center text-on-surface-variant">&times; ${counts[d]}</td><td class="py-1 text-right text-on-surface font-semibold">${money(d * counts[d])}</td></tr>`).join('')
    || '<tr><td colspan="3" class="py-1 text-on-surface-variant text-center">No bills counted</td></tr>';
  return `<div class="mt-2">
    <div class="text-xs font-body font-bold text-on-surface-variant uppercase tracking-wide mb-1">${label} bills</div>
    <table class="w-full text-base font-body"><tbody>${rows}<tr class="border-t-2 border-surface-container-high"><td class="pt-1 font-bold text-on-surface" colspan="2">${label} total</td><td class="pt-1 text-right font-extrabold text-primary">${money(countTotal(counts))}</td></tr></tbody></table>
  </div>`;
};
const me = () => { const u = getActiveUser(); return { id: u?.id || '', name: u?.name || 'Unknown' }; };
const fmtTime = iso => { const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
const fmtDate = iso => { const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };

// ── Reconciliation math (pure — records passed in so it's unit-testable) ──────
// Cash sales for a shift = Σ r.tenders.cash for records paid within [openedAt, end].
// tenders.cash is the sale amount applied in cash (change already netted), and only the
// primary ticket of a party carries tenders, so each party is counted once.
export function shiftCashSales(records, drawer, endMs) {
  if (!drawer) return 0;
  const start = new Date(drawer.openedAt).getTime();
  const end = endMs || Date.now();
  return (records || []).reduce((s, r) => {
    if (!isPaidStatus(r.status) || !r.tenders) return s;
    const t = new Date(r.completedAt || r.checkinTime).getTime();
    if (isNaN(t) || t < start || t > end) return s;
    return s + (r.tenders.cash || 0);
  }, 0);
}
// Drawer tip payout (pure, cents): when "pay the tip in cash from the drawer" is on, the tech is
// handed the FULL tip from the drawer — except any part the customer physically paid in cash
// (that cash entered and left the drawer in one motion; recording it would double-count). The part
// collected by CARD, ZELLE or GIFT never reached the drawer, so it needs a cash-out entry or the
// drawer reconciles short. (Counting only the card's share was the old bug: a tip covered by
// Zelle/gift and paid out of the drawer was never recorded.)
export function drawerTipPayoutCents(tipCents, cashAppliedCents, cashBillCents, fromDrawer) {
  if (!fromDrawer || !(tipCents > 0)) return 0;
  const cashTip = Math.max(0, Math.min((cashAppliedCents || 0) - (cashBillCents || 0), tipCents));
  return Math.max(0, tipCents - cashTip);
}
function movementTotals(drawer) {
  let inc = 0, out = 0, tipOut = 0;
  (drawer?.movements || []).forEach(m => { if (m.type === 'out') { out += m.amount || 0; if (m.kind === 'tip') tipOut += m.amount || 0; } else inc += m.amount || 0; });
  return { inc, out, tipOut };   // tipOut is a SUBSET of out (card-tip payouts), shown as its own tally
}
export function drawerExpected(records, drawer, endMs) {
  const { inc, out } = movementTotals(drawer);
  return (drawer?.openTotal || 0) + shiftCashSales(records, drawer, endMs) + inc - out;
}
const osLabel = os => (os > 0.0001 ? '+' : os < -0.0001 ? '−' : '') + '$' + Math.abs(os).toFixed(2);
const osColor = os => os < -0.0001 ? '#fa746f' : os > 0.0001 ? '#2a7a4f' : '#6b7280';

// ── Open/show/close the popup ─────────────────────
export function openCashRegister() { _cdView = 'auto'; _show(); render(); }
export function closeCashRegister() { const m = document.getElementById('cash-register-modal'); if (!m) return; m.classList.add('hidden'); m.style.display = ''; }
function _show() { const m = document.getElementById('cash-register-modal'); if (!m) return; m.classList.remove('hidden'); m.style.display = 'flex'; }

// ── Count sheet (shared by Open + Close) ──────────
function countSheetHtml() {
  const rows = DENOMS.map(d => {
    const q = _countDraft[d] || 0;
    return `<div class="flex items-center gap-2 mb-2">
      <span class="w-12 font-headline font-semibold text-on-surface">$${d}</span>
      <span class="text-on-surface-variant text-sm">×</span>
      <input id="cd-qty-${d}" type="text" inputmode="none" value="${q > 0 ? q : ''}" placeholder="0"
        onfocus="openNumpad(this,'$${d} bills','int')" onclick="openNumpad(this,'$${d} bills','int')" oninput="cdDenomInput(${d},this.value)"
        class="w-20 border border-surface-container-high rounded-lg px-2 py-1.5 text-right text-on-surface bg-surface-container-lowest focus:outline-none focus:border-primary">
      <span class="text-on-surface-variant text-sm">=</span>
      <span id="cd-row-total-${d}" class="flex-1 text-right font-headline font-semibold text-on-surface">${money(d * q)}</span>
    </div>`;
  }).join('');
  return `<div class="mb-1">${rows}</div>
    <div class="flex items-center justify-between border-t border-surface-container-high pt-2 mt-1">
      <span class="font-headline font-bold text-on-surface">Total counted</span>
      <span id="cd-grand-total" class="font-headline font-extrabold text-primary text-lg">${money(countTotal(_countDraft))}</span>
    </div>`;
}
// Live-patch the per-row + grand totals (and the close-view over/short) as quantities are typed.
export function cdDenomInput(denom, val) {
  const q = Math.max(0, parseInt(('' + val).replace(/[^0-9]/g, '') || '0', 10) || 0);
  _countDraft[denom] = q;
  const rt = document.getElementById('cd-row-total-' + denom); if (rt) rt.textContent = money(denom * q);
  const counted = countTotal(_countDraft);
  const gt = document.getElementById('cd-grand-total'); if (gt) gt.textContent = money(counted);
  const osEl = document.getElementById('cd-close-overshort');
  if (osEl) { const os = counted - drawerExpected(getState().records, currentDrawer()); osEl.textContent = osLabel(os); osEl.style.color = osColor(os); }
}

// ── Render the active view ────────────────────────
function setTitle(t) { const el = document.getElementById('cash-register-title'); if (el) el.textContent = t; }
function historyLinkHtml() {
  return `<button onclick="cdShowHistory()" class="w-full mt-3 text-xs font-body font-semibold text-primary hover:underline">View drawer history</button>`;
}

function render() {
  const body = document.getElementById('cash-register-body'); if (!body) return;
  let view = _cdView;
  if (view === 'auto') view = isDrawerOpen() ? 'active' : 'open';
  if (['active', 'close', 'in', 'out'].includes(view) && !isDrawerOpen()) view = 'open';

  if (view === 'open') {
    _countDraft = _emptyCounts();
    setTitle('Open Cash Drawer');
    body.innerHTML = `<p class="text-sm font-body text-on-surface-variant mb-3">Count the cash in the drawer to start the day.</p>
      ${countSheetHtml()}
      <button onclick="cdConfirmOpen()" class="w-full mt-4 bg-primary text-on-primary py-3 rounded-xl font-headline font-semibold hover:bg-primary-dim transition-colors">Open Drawer</button>
      ${historyLinkHtml()}`;
    return;
  }

  if (view === 'active') {
    const d = currentDrawer();
    const { inc, out, tipOut } = movementTotals(d);
    const sales = shiftCashSales(getState().records, d);
    const expected = (d.openTotal || 0) + sales + inc - out;
    const priorDay = localDateStr(new Date(d.openedAt)) < todayStr();
    setTitle('Cash Drawer');
    const movesHtml = (d.movements || []).slice().reverse().map(m => `<div class="flex items-center justify-between text-sm py-1.5 border-b border-surface-container-high last:border-0">
        <span class="flex items-center gap-1.5 min-w-0"><span class="material-symbols-outlined flex-shrink-0" style="font-size:16px;color:${m.type === 'out' ? '#fa746f' : '#2a7a4f'}">${m.type === 'out' ? 'remove' : 'add'}</span><span class="truncate text-on-surface">${esc(m.reason) || (m.type === 'out' ? 'Cash out' : 'Cash in')}</span></span>
        <span class="font-headline font-semibold flex-shrink-0" style="color:${m.type === 'out' ? '#fa746f' : '#2a7a4f'}">${m.type === 'out' ? '−' : '+'}${money(m.amount)}</span>
      </div>`).join('') || '<p class="text-xs font-body text-on-surface-variant text-center py-2 opacity-70">No cash in/out yet</p>';
    const row = (label, val, strong) => `<div class="flex items-center justify-between ${strong ? 'font-headline font-bold text-on-surface pt-1.5 mt-1 border-t border-surface-container-high' : 'text-on-surface-variant'}"><span>${label}</span><span class="${strong ? 'text-primary' : 'text-on-surface'}">${val}</span></div>`;
    body.innerHTML = `${priorDay ? `<div class="flex items-start gap-2 mb-3 px-3 py-2 rounded-xl bg-secondary-container/60 border border-secondary/30 text-xs font-body text-on-surface"><span class="material-symbols-outlined flex-shrink-0" style="font-size:16px;color:#785a1a">warning</span><span>This drawer has been open since <strong>${fmtDate(d.openedAt)}</strong>. Close it to start a new day.</span></div>` : ''}
      <div class="text-xs font-body text-on-surface-variant mb-3">Opened by <strong>${esc(d.openedBy?.name) || '—'}</strong> at ${fmtTime(d.openedAt)}</div>
      <div class="space-y-1 text-sm font-body mb-4">
        ${row('Opening cash', money(d.openTotal))}
        ${row('Cash sales', money(sales))}
        ${row('Cash in', money(inc))}
        ${row('Cash out', '−' + money(out))}
        ${tipOut > 0 ? row('↳ tips paid out', '−' + money(tipOut)) : ''}
        ${row('Expected in drawer', money(expected), true)}
      </div>
      <div class="grid grid-cols-2 gap-2 mb-3">
        <button onclick="cdShowMovement('in')" class="py-2.5 rounded-xl border border-surface-container-high text-on-surface font-body font-semibold text-sm hover:bg-surface-container transition-colors flex items-center justify-center gap-1"><span class="material-symbols-outlined" style="font-size:16px">add</span> Cash In</button>
        <button onclick="cdShowMovement('out')" class="py-2.5 rounded-xl border border-surface-container-high text-on-surface font-body font-semibold text-sm hover:bg-surface-container transition-colors flex items-center justify-center gap-1"><span class="material-symbols-outlined" style="font-size:16px">remove</span> Cash Out</button>
      </div>
      <div class="rounded-xl border border-surface-container-high px-3 py-2 mb-4 max-h-40 overflow-y-auto">${movesHtml}</div>
      <button onclick="cdShowClose()" class="w-full bg-primary text-on-primary py-3 rounded-xl font-headline font-semibold hover:bg-primary-dim transition-colors">Close Drawer</button>
      ${historyLinkHtml()}`;
    return;
  }

  if (view === 'in' || view === 'out') {
    const isIn = view === 'in';
    setTitle(isIn ? 'Cash In' : 'Cash Out');
    body.innerHTML = `<p class="text-sm font-body text-on-surface-variant mb-3">${isIn ? 'Add cash to the drawer (e.g., a bank for making change).' : 'Remove cash from the drawer (e.g., a payout or bank drop).'}</p>
      <label class="block text-xs font-body font-semibold text-outline uppercase tracking-widest mb-1">Amount</label>
      <div class="flex items-center gap-1 mb-3"><span class="text-on-surface-variant">$</span>
        <input id="cd-move-amt" type="text" inputmode="none" placeholder="0.00" onfocus="openNumpad(this,'Amount','cost')" onclick="openNumpad(this,'Amount','cost')"
          class="flex-1 border border-surface-container-high rounded-lg px-3 py-2 text-right text-on-surface bg-surface-container-lowest focus:outline-none focus:border-primary"></div>
      <label class="block text-xs font-body font-semibold text-outline uppercase tracking-widest mb-1">Reason</label>
      <input id="cd-move-reason" type="text" placeholder="${isIn ? 'e.g., Change bank' : 'e.g., Supply run'}" maxlength="80"
        class="w-full border border-surface-container-high rounded-lg px-3 py-2 mb-4 text-on-surface bg-surface-container-lowest focus:outline-none focus:border-primary">
      <div class="grid grid-cols-2 gap-2">
        <button onclick="cdBackActive()" class="py-3 rounded-xl border border-surface-container-high text-on-surface font-headline font-semibold hover:bg-surface-container transition-colors">Cancel</button>
        <button onclick="cdSubmitMovement('${view}')" class="py-3 rounded-xl bg-primary text-on-primary font-headline font-semibold hover:bg-primary-dim transition-colors">Record ${isIn ? 'Cash In' : 'Cash Out'}</button>
      </div>`;
    return;
  }

  if (view === 'close') {
    const d = currentDrawer();
    const expected = drawerExpected(getState().records, d);
    const counted = countTotal(_countDraft);
    const os = counted - expected;
    setTitle('Close Cash Drawer');
    body.innerHTML = `<p class="text-sm font-body text-on-surface-variant mb-3">Count the cash in the drawer to close out.</p>
      ${countSheetHtml()}
      <div class="mt-3 pt-3 border-t border-surface-container-high text-sm font-body space-y-1">
        <div class="flex justify-between text-on-surface-variant"><span>Expected in drawer</span><span id="cd-close-expected" class="text-on-surface">${money(expected)}</span></div>
        <div class="flex justify-between font-headline font-bold pt-1"><span>Over / Short</span><span id="cd-close-overshort" style="color:${osColor(os)}">${osLabel(os)}</span></div>
      </div>
      <div class="grid grid-cols-2 gap-2 mt-4">
        <button onclick="cdBackActive()" class="py-3 rounded-xl border border-surface-container-high text-on-surface font-headline font-semibold hover:bg-surface-container transition-colors">Cancel</button>
        <button onclick="cdConfirmClose()" class="py-3 rounded-xl bg-primary text-on-primary font-headline font-semibold hover:bg-primary-dim transition-colors">Confirm Close</button>
      </div>`;
    return;
  }

  if (view === 'history') {
    setTitle('Drawer History');
    body.innerHTML = `<div class="max-h-[60vh] overflow-y-auto -mx-1 px-1">${drawerHistoryRowsHtml()}</div>
      <button onclick="cdBackFromHistory()" class="w-full mt-3 py-3 rounded-xl border border-surface-container-high text-on-surface font-headline font-semibold hover:bg-surface-container transition-colors">Back</button>`;
    return;
  }
}

// ── Actions ───────────────────────────────────────
export function cdShowMovement(type) { _cdView = type; render(); }
export function cdBackActive() { _cdView = 'active'; render(); }
export function cdShowClose() { _countDraft = _emptyCounts(); _cdView = 'close'; render(); }
export function cdShowHistory() { _cdView = 'history'; render(); }
export function cdBackFromHistory() { _cdView = 'auto'; render(); }

export function cdConfirmOpen() {
  commitNumpad();
  if (isDrawerOpen()) { showToast('A drawer is already open.'); _cdView = 'auto'; render(); return; }
  const total = countTotal(_countDraft);
  const drawer = { id: newEntryId(), openedAt: new Date().toISOString(), openedBy: me(), openCounts: { ..._countDraft }, openTotal: total, movements: [] };
  dispatch('config.set', { key: 'cash_drawer', value: drawer });
  window.logAudit?.('Cash drawer', `Opened drawer · ${money(total)} by ${drawer.openedBy.name}`);
  showToast(`Drawer opened · ${money(total)}`);
  _cdView = 'active'; render();
}

export function cdSubmitMovement(type) {
  commitNumpad();
  const drawer = currentDrawer();
  if (!drawer) { showToast('No drawer is open.'); _cdView = 'auto'; render(); return; }
  const amt = parseFloat((document.getElementById('cd-move-amt')?.value || '').replace(/[^0-9.]/g, '')) || 0;
  if (!(amt > 0)) { showToast('Enter an amount.'); return; }
  const reason = (document.getElementById('cd-move-reason')?.value || '').trim();
  const next = { ...drawer, movements: [...(drawer.movements || []), { id: newEntryId(), type, amount: amt, reason, at: new Date().toISOString(), by: me() }] };
  dispatch('config.set', { key: 'cash_drawer', value: next });
  window.logAudit?.('Cash drawer', `${type === 'in' ? 'Cash in' : 'Cash out'} ${money(amt)}${reason ? ' · ' + reason : ''}`);
  showToast(`${type === 'in' ? 'Cash in' : 'Cash out'} recorded`);
  _cdView = 'active'; render();
}

// Append a Cash Out to the open drawer (e.g. cash physically returned on a refund, or a card-tip
// paid to the tech in cash) so the close reconciliation accounts for it. `kind` tags the movement
// (e.g. 'tip') so tip payouts can be tallied separately. No-op if no drawer is open.
export function cdRecordCashOut(amount, reason, kind) {
  const drawer = currentDrawer();
  if (!drawer || !(amount > 0)) return false;
  const next = { ...drawer, movements: [...(drawer.movements || []), { id: newEntryId(), type: 'out', amount, reason: reason || '', at: new Date().toISOString(), by: me(), ...(kind ? { kind } : {}) }] };
  dispatch('config.set', { key: 'cash_drawer', value: next });
  window.logAudit?.('Cash drawer', `${kind === 'tip' ? 'Tip payout' : 'Cash out'} ${money(amount)}${reason ? ' · ' + reason : ''}`);
  showToast(kind === 'tip' ? `Paid ${money(amount)} tip from the drawer` : `Logged ${money(amount)} cash out from the drawer`);
  return true;
}

export function cdConfirmClose() {
  commitNumpad();
  const drawer = currentDrawer();
  if (!drawer) { showToast('No drawer is open.'); _cdView = 'auto'; render(); return; }
  const endMs = Date.now();
  const closeTotal = countTotal(_countDraft);
  const cashSales = shiftCashSales(getState().records, drawer, endMs);
  const { inc, out, tipOut } = movementTotals(drawer);
  const expected = (drawer.openTotal || 0) + cashSales + inc - out;
  const overShort = closeTotal - expected;
  const closed = { ...drawer, closedAt: new Date(endMs).toISOString(), closedBy: me(), closeCounts: { ..._countDraft }, closeTotal, cashSales, cashIn: inc, cashOut: out, tipsOut: tipOut, expected, overShort };
  const hist = [...(cfg().cash_drawer_history || []), closed];
  if (hist.length > HISTORY_CAP) hist.splice(0, hist.length - HISTORY_CAP);
  dispatch('config.set', { key: 'cash_drawer_history', value: hist });
  dispatch('config.set', { key: 'cash_drawer', value: null });
  window.logAudit?.('Cash drawer', `Closed drawer · counted ${money(closeTotal)} · ${overShort >= 0 ? 'over' : 'short'} ${money(Math.abs(overShort))}`);
  showToast('Drawer closed');
  _cdView = 'auto'; render();
}

// ── Printable drawer report (Print → Save as PDF) ──
export function cdPrintShift(shiftId, countsOnly) {
  const s = (cfg().cash_drawer_history || []).find(x => String(x.id) === String(shiftId));
  if (!s) { showToast('Drawer not found.'); return; }
  const url = URL.createObjectURL(new Blob([buildShiftHtml(s, countsOnly)], { type: 'text/html' }));
  const win = window.open(url, '_blank');
  if (win) setTimeout(() => win.print(), 600);
  URL.revokeObjectURL(url);
  showToast('Report opened — use Print → Save as PDF');
}
// Counts-only variant: opening + closing denomination counts, no cash in/out or reconciliation.
export function cdPrintCounts(shiftId) { cdPrintShift(shiftId, true); }
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function buildShiftHtml(s, countsOnly) {
  const logo = cfg().logo || '';
  const os = s.overShort || 0;
  const denomRows = (counts, label) => DENOMS.map(d => { const q = counts?.[d] || 0; return q ? `<tr><td>$${d} &times; ${q}</td><td style="text-align:right">${money(d * q)}</td></tr>` : ''; }).join('')
    + `<tr class="tot"><td>${label} total</td><td style="text-align:right">${money(countTotal(counts))}</td></tr>`;
  const moves = (s.movements || []).map(m => `<tr><td>${m.type === 'out' ? 'OUT' : 'IN'} &middot; ${esc(m.reason || (m.type === 'out' ? 'Cash out' : 'Cash in'))}${m.by?.name ? ' (' + esc(m.by.name) + ')' : ''}</td><td style="text-align:right">${m.type === 'out' ? '&minus;' : '+'}${money(m.amount)}</td></tr>`).join('')
    || '<tr><td colspan="2" style="text-align:center">No cash in/out</td></tr>';
  // Cash in/out + reconciliation — omitted on the counts-only print.
  const inOutRecon = countsOnly ? '' : `
    <h2>Cash in / out</h2><table><tbody>${moves}</tbody></table>
    <h2>Reconciliation</h2>
    <table class="recon"><tbody>
      <tr><td>Opening cash</td><td style="text-align:right">${money(s.openTotal)}</td></tr>
      <tr><td>+ Cash sales</td><td style="text-align:right">${money(s.cashSales)}</td></tr>
      <tr><td>+ Cash in</td><td style="text-align:right">${money(s.cashIn)}</td></tr>
      <tr><td>&minus; Cash out</td><td style="text-align:right">${money(s.cashOut)}</td></tr>
      ${s.tipsOut ? `<tr><td>&nbsp;&nbsp;&#8627; tip payouts</td><td style="text-align:right">${money(s.tipsOut)}</td></tr>` : ''}
      <tr class="big"><td>Expected</td><td style="text-align:right">${money(s.expected)}</td></tr>
      <tr class="big"><td>Counted</td><td style="text-align:right">${money(s.closeTotal)}</td></tr>
      <tr class="big"><td>Over / Short</td><td style="text-align:right">${osLabel(os)}</td></tr>
    </tbody></table>`;
  // 80mm thermal receipt-roll format — same Courier 13px bold as the customer receipt so it
  // prints large + crisp on the RP327 (the old letter-size layout scaled down to unreadable).
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Muse Cash Drawer — ${fmtDate(s.openedAt)}</title><style>
    @page{size:80mm auto;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0}
    body{width:72mm;margin:0 auto;padding:3mm 2mm 5mm;font-family:'Courier New',ui-monospace,monospace;font-size:13px;line-height:1.35;color:#000;font-weight:700}
    .h{text-align:center;margin-bottom:5px}.logo{max-width:40mm;max-height:16mm;object-fit:contain;display:block;margin:0 auto 3px}
    h1{font-family:Arial,Helvetica,sans-serif;font-weight:900;font-size:15px;margin:0 0 2px}
    .sub{font-size:11px;margin:0;line-height:1.35}
    h2{font-size:13px;margin:9px 0 3px;border-bottom:1px solid #000;padding-bottom:2px;text-transform:uppercase}
    table{width:100%;border-collapse:collapse;margin-bottom:3px}
    td{padding:1px 2px;font-size:13px;vertical-align:top}
    tr.tot td{font-weight:900;border-top:1px solid #000}
    .recon .big td{font-size:14px;font-weight:900;border-top:1px solid #000}
    .footer{margin-top:9px;font-size:10px;text-align:center;line-height:1.4}
  </style></head><body>
    <div class="h">${logo ? `<img src="${logo}" class="logo" onerror="this.style.display='none'">` : ''}
      <h1>${escHtml(businessName())}</h1>
      <div class="sub">${countsOnly ? 'CASH COUNT' : 'CASH DRAWER REPORT'}</div>
      <div class="sub">${fmtDate(s.openedAt)}</div>
      <div class="sub">${fmtTime(s.openedAt)} &ndash; ${fmtTime(s.closedAt)}</div>
      <div class="sub">Open: ${esc(s.openedBy?.name) || '—'} &middot; Close: ${esc(s.closedBy?.name) || '—'}</div>
    </div>
    <h2>Opening count</h2><table><tbody>${denomRows(s.openCounts, 'Opening')}</tbody></table>
    <h2>Closing count</h2><table><tbody>${denomRows(s.closeCounts, 'Closing')}</tbody></table>
    ${inOutRecon}
    ${countsOnly ? '' : `<div class="footer">Generated ${new Date().toLocaleString()}<br>Counts are bills-only; coins/cents in Over/Short.</div>`}
  </body></html>`;
}

// ── Read-only drawer + history (shared: dashboard Reports tab + phone Reports app) ──────
// View + print only — no open/close/cash-in-out controls. Each closed shift offers both a
// full-report print and a counts-only print.
export function drawerHistoryRowsHtml(opts = {}) {
  const { showBillCounts, hideCashOut } = opts;
  const hist = (cfg().cash_drawer_history || []).slice().reverse();
  return hist.map(s => {
    const os = s.overShort || 0;
    const moves = (s.movements || []).filter(m => !(hideCashOut && m.type === 'out'));
    const movesHtml = moves.length ? `<div class="mt-2 pt-1.5 border-t border-surface-container-high space-y-0.5">${moves.map(m => `<div class="flex items-center justify-between text-[11px] font-body"><span class="text-on-surface-variant">${m.type === 'out' ? 'Cash out' : 'Cash in'}${m.reason ? ' · ' + esc(m.reason) : ''} <span class="text-outline">${fmtTime(m.at)}${m.by?.name ? ' · ' + esc(m.by.name) : ''}</span></span><span style="color:${m.type === 'out' ? '#fa746f' : '#2a7a4f'};font-weight:700">${m.type === 'out' ? '−' : '+'}${money(m.amount)}</span></div>`).join('')}</div>` : '';
    const billsHtml = showBillCounts ? `<div class="mt-2 pt-1.5 border-t border-surface-container-high">${billCountTable(s.openCounts, 'Opening')}${billCountTable(s.closeCounts, 'Closing')}</div>` : '';
    return `<div class="rounded-xl border border-surface-container-high px-4 py-3 mb-2">
      <div class="flex items-center justify-between mb-1">
        <span class="font-headline font-semibold text-on-surface text-sm">${fmtDate(s.openedAt)} · ${fmtTime(s.openedAt)} – ${fmtTime(s.closedAt)}</span>
        <span class="flex items-center gap-1.5 flex-shrink-0">
          <button onclick="cdPrintCounts('${s.id}')" title="Print opening + closing counts only" class="text-on-surface-variant hover:text-primary flex items-center"><span class="material-symbols-outlined" style="font-size:18px">format_list_numbered</span></button>
          <button onclick="cdPrintShift('${s.id}')" title="Print full drawer report" class="text-primary hover:text-primary-dim flex items-center"><span class="material-symbols-outlined" style="font-size:18px">print</span></button>
        </span>
      </div>
      <div class="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs font-body text-on-surface-variant">
        <span>Opening: <span class="text-on-surface">${money(s.openTotal)}</span></span>
        <span>Cash sales: <span class="text-on-surface">${money(s.cashSales)}</span></span>
        ${hideCashOut ? `<span>Cash in: <span class="text-on-surface">${money(s.cashIn)}</span></span>` : `<span>Cash in/out: <span class="text-on-surface">${money(s.cashIn)} / ${money(s.cashOut)}</span></span>`}
        ${(s.tipsOut && !hideCashOut) ? `<span>Tips paid: <span class="text-on-surface">${money(s.tipsOut)}</span></span>` : ''}
        <span>Counted: <span class="text-on-surface">${money(s.closeTotal)}</span></span>
        <span>Expected: <span class="text-on-surface">${money(s.expected)}</span></span>
        <span>Over/Short: <span style="color:${osColor(os)};font-weight:700">${osLabel(os)}</span></span>
      </div>
      ${billsHtml}
      ${movesHtml}
      <div class="text-[11px] font-body text-outline mt-1">Closed by ${esc(s.closedBy?.name) || '—'}</div>
    </div>`;
  }).join('') || '<p class="text-sm font-body text-on-surface-variant text-center py-6 opacity-70">No closed drawers yet.</p>';
}
// Current open drawer (read-only) + the history list.
export function drawerReportHtml(opts = {}) {
  const d = currentDrawer();
  let cur;
  if (d) {
    const sales = shiftCashSales(getState().records, d);
    const expected = drawerExpected(getState().records, d);
    cur = `<div class="rounded-xl border px-4 py-3 mb-3" style="border-color:rgba(26,82,82,.3);background:rgba(26,82,82,.05)">
      <div class="flex items-center justify-between mb-1"><span class="font-headline font-semibold text-primary text-sm">Drawer open</span><span class="text-[11px] font-body text-on-surface-variant">since ${fmtTime(d.openedAt)} · ${esc(d.openedBy?.name) || '—'}</span></div>
      <div class="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs font-body text-on-surface-variant">
        <span>Opening: <span class="text-on-surface">${money(d.openTotal)}</span></span>
        <span>Cash sales: <span class="text-on-surface">${money(sales)}</span></span>
        <span class="col-span-2">Expected in drawer now: <span class="text-on-surface font-semibold">${money(expected)}</span></span>
      </div>
      ${opts.showBillCounts ? `<div class="mt-2 pt-1.5 border-t border-surface-container-high">${billCountTable(d.openCounts, 'Opening')}</div>` : ''}</div>`;
  } else {
    cur = `<div class="rounded-xl border border-surface-container-high px-4 py-3 mb-3 text-sm font-body text-on-surface-variant text-center">No drawer open right now.</div>`;
  }
  return cur + drawerHistoryRowsHtml(opts);
}
