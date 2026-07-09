// ── Square POS deep link, orders, appointments, bookings ────────────────────
import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { canDo, getActiveUser } from '../session.js';
import { showToast, commitNumpad, ticketTotal } from '../utils.js';
import { isAwaitingPrice } from './status.js';
import { SQUARE_PROXY } from '../config.js';
import { squareUpsertCustomer } from './square-customers.js';
import { chargeOnHelcim, helcimActive, helcimCustomerCode, manualMode } from './helcim.js';
import { drawerTipPayoutCents } from './cashdrawer.js';

const cfg     = () => getState().config;
const sqConfig = () => cfg().square_config || null;
const queue    = () => getState().queue;

// ── POS deep link (with a pre-launch confirm screen) ──────────────
// Square Point of Sale API (iOS web): square-commerce-v1://payment/create?data=<percent-encoded JSON>.
// Requires the public Application ID as client_id and an https callback_url — see Settings → Square.
let _pendingPay = null;
// R6 gift-card-as-recorded-tender (staging for the current pay session). These NEVER change
// the Square charge — the full ticket total always goes to Square; we only record which cards
// were used so the app's gift-card balances stay in sync. Committed when the ticket is paid.
let _payGc = [], _payTicketId = null, _gcPickerOpen = false, _newGcOpen = false, _payCash = 0, _payTip = 0, _payZelle = 0;   // _payCash/_payTip/_payZelle in dollars
// When checked (default ON if a drawer is open), the card-collected portion of the tip is paid to
// the tech in cash on finalize via a drawer Cash Out tagged 'tip' — so the drawer reconciles and
// tip payouts are tallied. Cash tips already go straight to the tech, so this only ever logs the
// CARD tip amount.
let _payTipFromDrawer = false;
let _manualTender = 'cash';   // selected tender chip in manual (no-terminal) checkout
const _gcBal = g => (g.amount || 0) - (window.gcTotalUsed ? window.gcTotalUsed(g) : 0);
const _payTotalDollars = () => (_pendingPay?.cents || 0) / 100;                 // the BILL (svc + items + fees − discount); tip NOT included
const _payTipDollars   = () => Math.max(0, _payTip || 0);
// What must actually be collected = the bill PLUS the tip. Gift cards pay the bill only; cash,
// Zelle, then the card fill the rest (bill + tip) in that order, so a tip can be paid by any tender.
const _payCollectDollars = () => _payTotalDollars() + _payTipDollars();
const _payGiftDollars  = () => _payGc.reduce((s, t) => s + (t.amount || 0), 0);
// Cash actually applied (toward bill + tip); anything beyond is change the front desk gives back.
const _payCashAppliedDollars = () => Math.max(0, Math.min(_payCash, _payCollectDollars() - _payGiftDollars()));
// Zelle applied: an exact bank transfer (no change), applied AFTER gift + cash, toward bill + tip.
const _payZelleAppliedDollars = () => Math.max(0, Math.min(_payZelle, _payCollectDollars() - _payGiftDollars() - _payCashAppliedDollars()));
// Change owed back to the customer when they hand over more cash than the bill + tip.
const _payChangeDollars = () => Math.max(0, _payCash - Math.max(0, _payCollectDollars() - _payGiftDollars()));
// What's charged on the Terminal after gift + cash + Zelle — the card balance PLUS any tip those didn't cover.
const _payCardDueDollars = () => Math.max(0, _payCollectDollars() - _payGiftDollars() - _payCashAppliedDollars() - _payZelleAppliedDollars());
const _gcRoom = () => Math.max(0, _payTotalDollars() - _payCash - _payGiftDollars() - _payZelle);   // gift cards fill the BILL only (never a tip)
const _gcStagedFor = id => _payGc.filter(t => t.giftcardId === id).reduce((s, t) => s + (t.amount || 0), 0);
// Bill components across the party, for the Confirm Payment summary. Sales Total = the bill =
// svc + items + fees − discount = _payTotalDollars(); the tip is separate (added to the card).
function _payParts() {
  let svc = 0, items = 0, fees = 0, discount = 0;
  (_pendingPay?.ids || []).forEach(id => {
    const e = queue().find(x => String(x.id) === String(id)); if (!e) return;
    (e.assignments || []).forEach(a => svc += a.cost || 0);
    (e.items || []).forEach(i => items += (i.price || 0) * (i.qty || 0));
    (e.fees || []).forEach(f => fees += f.amount || 0);
    discount += e.discount || 0;
  });
  return { svc, items, fees, discount };
}

// ── Service fee at checkout (moved here from the Assign & Price modal, v4.51) ──────────────
// Fees live on entry.fees (anchor ticket), exactly as before — only the place they're entered
// changed. Default-ON: each configured fee is auto-applied to the anchor when the pay modal opens.
const _payParty = () => (_pendingPay?.ids || []).map(id => queue().find(e => String(e.id) === String(id))).filter(Boolean);
const _entrySvc = e => (e.assignments || []).reduce((s, a) => s + (a.cost || 0), 0);
const _paySvcSubtotal = () => _payParty().reduce((s, e) => s + _entrySvc(e), 0);
function _payAnchor() {                 // the ticket the whole-checkout fee attaches to = largest service subtotal
  const party = _payParty(); if (!party.length) return null;
  let anchor = party[0], best = -1;
  party.forEach(e => { const sub = _entrySvc(e); if (sub > best) { best = sub; anchor = e; } });
  return anchor;
}
const _feeAmount = (fee, svcSubtotal) => fee.type === 'percent' ? Math.round(svcSubtotal * (fee.value || 0)) / 100 : (fee.value || 0);
function _payApplyDefaultFees(party) {  // default-ON: add each configured fee to the anchor if the party doesn't already carry it
  if (!party.length) return;
  if (party.some(e => e.quickSale)) return;   // a Quick Sale has no service → no default service fee
  const svc = party.reduce((s, e) => s + _entrySvc(e), 0);
  let anchor = party[0], best = -1;
  party.forEach(e => { const sub = _entrySvc(e); if (sub > best) { best = sub; anchor = e; } });
  (cfg().fees || []).forEach(fee => {
    if (party.some(e => (e.fees || []).some(f => f.feeId === fee.id))) return;   // already applied → idempotent
    const amount = _feeAmount(fee, svc);
    if (amount > 0) anchor.fees = [...(anchor.fees || []), { feeId: fee.id, amount, type: fee.type }];
  });
}
function _payRecomputeBill() { if (_pendingPay) _pendingPay.cents = Math.round(_payParty().reduce((s, e) => s + ticketTotal(e) + (e.giftcardSales || []).reduce((a, g) => a + (+g.amount || 0), 0), 0) * 100); }
function _refreshPayBody() {            // re-render the per-customer blocks (separate node from the numpad-bearing summary)
  const body = document.getElementById('square-confirm-body');
  if (body) body.innerHTML = _payParty().map(payCustomerBlock).join('');
  const totalEl = document.getElementById('square-confirm-total'); if (totalEl) totalEl.textContent = `$${((_pendingPay?.cents || 0) / 100).toFixed(2)}`;
}
function _refreshPayBreakdown() {       // re-render just the totals block (keeps an open numpad on the fee field)
  const el = document.getElementById('sq-pay-breakdown'); if (el) el.innerHTML = _breakdownRows();
  sqUpdatePayBreakdown();
}
// Toggle a fee on/off for this checkout; off → remove from every party member, on → add to the anchor.
export function payToggleFee(feeId) {
  const fee = (cfg().fees || []).find(f => f.id === feeId); if (!fee) return;
  const party = _payParty(); if (!party.length) return;
  if (party.some(e => (e.fees || []).some(f => f.feeId === feeId))) {
    party.forEach(e => { if ((e.fees || []).some(f => f.feeId === feeId)) { e.fees = e.fees.filter(f => f.feeId !== feeId); dispatch('queue.upsert', { entry: e }); } });
  } else {
    const anchor = _payAnchor(); const amount = _feeAmount(fee, _paySvcSubtotal());
    if (anchor && amount > 0) { anchor.fees = [...(anchor.fees || []), { feeId, amount, type: fee.type }]; dispatch('queue.upsert', { entry: anchor }); }
  }
  _payRecomputeBill(); renderPayGc(); _refreshPayBody();
}
// Edit a flat fee's amount (numpad). Updates the holder entry + the totals WITHOUT re-rendering the
// summary host, so the open numpad isn't yanked (mirrors the price-modal pattern).
export function payFeeAmountInput(feeId, val) {
  const n = parseFloat(val); const amount = isFinite(n) && n > 0 ? n : 0;
  const fee = (cfg().fees || []).find(f => f.id === feeId);
  let target = _payParty().find(e => (e.fees || []).some(f => f.feeId === feeId)) || _payAnchor();
  if (!target) return;
  if (amount > 0) target.fees = (target.fees || []).some(f => f.feeId === feeId)
    ? target.fees.map(f => f.feeId === feeId ? { ...f, amount } : f)
    : [...(target.fees || []), { feeId, amount, type: fee?.type }];
  else target.fees = (target.fees || []).filter(f => f.feeId !== feeId);
  dispatch('queue.upsert', { entry: target });
  _payRecomputeBill(); _refreshPayBody(); _refreshPayBreakdown();
}

// The Confirm Payment totals block (rows only; the wrapper #sq-pay-breakdown carries the id so a
// fee edit can refresh it without re-rendering the summary host / yanking an open numpad).
function _breakdownRows() {
  const P = _payParts();
  const sm = (label, amt, neg) => `<div class="flex justify-between text-on-surface-variant"><span>${label}</span><span>${neg ? '−' : ''}$${Math.abs(amt).toFixed(2)}</span></div>`;
  const BIG = 'flex justify-between items-center font-headline font-semibold', BIGS = 'font-size:1.05rem';
  return `${P.svc > 0 ? sm('Services total', P.svc) : ''}
      ${P.items > 0 ? sm('Items total', P.items) : ''}
      ${P.fees > 0 ? sm('Fee Total', P.fees) : ''}
      ${P.discount > 0 ? sm('Discount', P.discount, true) : ''}
      <div id="sq-row-tip" class="flex justify-between text-on-surface-variant" style="display:none"><span>Tip Total</span><span id="sq-tip">$0.00</span></div>
      ${_payGiftDollars() > 0 ? sm('Gift card used', _payGiftDollars(), true) : ''}
      <div id="sq-row-cashrcv" class="flex justify-between text-on-surface-variant" style="display:none"><span>Cash received</span><span id="sq-cash-rcv">$0.00</span></div>
      <div id="sq-row-zelle" class="flex justify-between text-on-surface-variant" style="display:none"><span>Zelle received</span><span id="sq-zelle-rcv">$0.00</span></div>
      <div class="${BIG} mt-1.5" style="${BIGS}"><span class="text-on-surface">Sales Total</span><span class="text-primary">$${_payTotalDollars().toFixed(2)}</span></div>
      <div id="sq-row-change" class="${BIG}" style="${BIGS};display:none"><span class="text-on-surface">Change due</span><span class="text-primary" id="sq-change">$0.00</span></div>
      <div class="${BIG} border-t border-surface-container-high mt-2 pt-2" style="${BIGS}"><span class="text-on-surface">Card on Terminal</span><span class="text-primary" id="sq-card-due">$${_payCardDueDollars().toFixed(2)}</span></div>`;
}

// A single entry's charge is computed from its parts via ticketTotal() (utils.js) — the one
// source of truth — so a possibly-stale entry.totalCost can't make the group total wrong.
function payLine(label, amt) {
  return `<div class="flex justify-between text-sm font-body"><span class="text-on-surface-variant">${label}</span><span class="${amt < 0 ? 'text-error' : 'text-on-surface'}">${amt < 0 ? '-' : ''}$${Math.abs(amt).toFixed(2)}</span></div>`;
}
function payCustomerBlock(e) {
  const lines = [];
  (e.assignments || []).forEach(a => { const s = cfg().services.find(x => x.id === a.serviceId); lines.push(payLine(s?.label || 'Service', a.cost || 0)); });
  (e.items || []).forEach(it => { const item = cfg().items.find(x => x.id === it.itemId); lines.push(payLine(`${item?.label || 'Item'} ×${it.qty || 1}`, (it.price || 0) * (it.qty || 0))); });
  (e.fees || []).forEach(f => { const fee = cfg().fees.find(x => x.id === f.feeId); lines.push(payLine(fee?.label || 'Fee', f.amount || 0)); });
  (e.giftcardSales || []).forEach(g => lines.push(payLine(`Gift Card${g.serial ? ' #' + g.serial : ''}${g.to ? ' → ' + g.to : ''}`, +g.amount || 0)));   // sold (liability, not income) — charged here
  if (e.discount > 0) lines.push(payLine(`Discount${e.discountNote ? ' (' + e.discountNote + ')' : ''}`, -e.discount));
  if (e.tip > 0) lines.push(payLine('Tip', e.tip));   // informational only — never part of ticketTotal (the header total below)
  const blockTotal = ticketTotal(e) + (e.giftcardSales || []).reduce((a, g) => a + (+g.amount || 0), 0);
  return `<div class="bg-surface-container rounded-xl px-4 py-3">
    <div class="flex justify-between items-center mb-1.5"><span class="font-headline font-bold text-on-surface">${e.name}</span><span class="font-headline font-bold text-primary">$${blockTotal.toFixed(2)}</span></div>
    ${lines.join('') || '<div class="text-xs text-on-surface-variant italic">No charges</div>'}
  </div>`;
}

export function openSquarePOS(entryId) {
  commitNumpad();   // flush a still-open numpad (a fee/cost typed but not ✓'d) before charging
  const entry = queue().find(e => String(e.id) === String(entryId));
  if (!entry) return;
  // Group check-in → the whole party is on one ticket. To pay separately, split the
  // ticket in-app first (then each member is its own non-grouped entry).
  const party = entry.groupId ? queue().filter(e => e.groupId === entry.groupId) : [entry];
  // Checkout guard: a service marked "Done — tech will price" has no amount yet. Block payment
  // until it's priced (the tech sets it from the staff app, or the front desk enters it in the
  // Assign & Price modal, which clears the flag). Otherwise it would silently charge $0 for it.
  if (party.some(e => (e.assignments || []).some(isAwaitingPrice))) {
    showToast('A service is awaiting the tech’s price — enter it (or have the tech set it) before taking payment.');
    return;
  }
  // Snapshot each ticket's fees BEFORE the default fee is auto-applied, so backing out of
  // checkout (Cancel/X/backdrop, no payment) can restore them — otherwise the default service
  // fee, persisted just below, lingers on the Assign modal's Party Total (services $0 + $2 fee).
  const feesSnapshot = party.map(e => ({ id: String(e.id), fees: (e.fees || []).map(f => ({ ...f })) }));
  // Default-ON service fee: applied to the anchor ticket at checkout (was the Assign & Price modal).
  // Persisted with the party just below; toggle it off in the Confirm Payment modal.
  _payApplyDefaultFees(party);
  // Charge total = the bill (ticketTotal) PLUS any gift cards being sold (charged on top, but the
  // gift amount is NOT income — it posts to the Gift Cards ledger on paid). totalCost stays the bill.
  const cents = Math.round(party.reduce((s, e) => s + ticketTotal(e) + (e.giftcardSales || []).reduce((a, g) => a + (+g.amount || 0), 0), 0) * 100);
  if (cents <= 0) { showToast('No total — assign a price first.'); return; }
  // Persist each ticket to the server BEFORE charging, and recompute its total from
  // its parts (services + items + fees − discount) as we save — so the stored total
  // can never be short the fee that's charged. Fees/prices entered in the Assign &
  // Price modal are only in memory until this point (the modal defers the sync to its
  // Save button, which the Pay-in-Square flow skips).
  party.forEach(e => { e.totalCost = ticketTotal(e); dispatch('queue.upsert', { entry: e }); });
  const body = document.getElementById('square-confirm-body');
  if (body) body.innerHTML = party.map(payCustomerBlock).join('');
  const totalEl = document.getElementById('square-confirm-total');
  if (totalEl) totalEl.textContent = `$${(cents / 100).toFixed(2)}`;
  // Names for the Square note/Description. For a multi-person party, prefix with "Party of N — "
  // so a group is obvious in Square's Transactions report (the customer field there links only one
  // person — often not even the first — making groups hard to recognize/match).
  const nameList = party.map(e => e.name).filter(Boolean);
  const payNames = (party.length > 1 ? `Party of ${party.length} — ` : '') + nameList.join(', ');
  _pendingPay = { cents, ids: party.map(e => String(e.id)), names: payNames.slice(0, 120), feesSnapshot };
  // R6: tie recorded gift cards to the tapped entry; preload any already staged (e.g. Pay was
  // tapped earlier but the charge wasn't completed). Balances are only drawn down when paid.
  _payTicketId = String(entryId);
  _payGc = (entry.giftcardRedemptions || []).map(t => ({ giftcardId: t.giftcardId, serial: t.serial, who: t.who, amount: t.amount }));
  _gcPickerOpen = false; _newGcOpen = false; _payCash = 0; _payTip = 0; _payZelle = 0;
  _payTipFromDrawer = !!cfg().cash_drawer;   // default ON when a drawer is open (the common card-tip → cash-payout case)
  renderPayGc();
  // Permission-gated (markPaidDirect): reveal the "record without charging" escape hatch
  // (for a payment taken outside the app, e.g. keyed manually on the terminal). Charge mode only.
  const mpBtn = document.getElementById('sq-markpaid-btn');
  if (mpBtn) mpBtn.classList.toggle('hidden', !canDo('markPaidDirect'));
  // Manual (no-terminal) checkout: reset the tender to Cash, set the one-tap amount, wire the chips.
  // The charge-mode / manual-mode layout swap itself is CSS-driven (body.proc-manual via syncProcessorClass).
  _manualTender = 'cash';
  const amtEl = document.getElementById('sq-markpaid-amt'); if (amtEl) amtEl.textContent = `$${(cents / 100).toFixed(2)}`;
  _syncManualChips();
  const sub = document.getElementById('sq-pay-sub');
  if (sub) sub.textContent = manualMode() ? 'No card terminal set up — record how the customer paid.' : 'Review the ticket, then continue to the terminal to take payment.';
  const m = document.getElementById('square-confirm-modal');
  if (m) { m.classList.remove('hidden'); m.style.display = 'flex'; }
}

export function closeSquareConfirm(paid) {
  // Backed out without paying → restore each ticket's fees to their pre-checkout snapshot, so the
  // auto-applied default fee (persisted when the pay screen opened) doesn't cling to the still-open
  // Assign modal's Party Total. Skip when paying (paid) or mid-charge (_charging — terminal flow).
  if (!paid && !_charging && _pendingPay?.feesSnapshot) {
    _pendingPay.feesSnapshot.forEach(snap => {
      const e = queue().find(x => String(x.id) === snap.id); if (!e) return;
      if (JSON.stringify(e.fees || []) === JSON.stringify(snap.fees)) return;   // unchanged → no write
      e.fees = snap.fees.map(f => ({ ...f }));
      e.totalCost = ticketTotal(e);
      dispatch('queue.upsert', { entry: e });
    });
    window.updateGroupTotal?.();   // refresh the Assign modal total if it's still open behind this
  }
  // A cancelled Quick Sale leaves no trace — drop the transient no-service ticket. Never mid-charge
  // (_charging is set before proceedTerminalPayment closes the modal), and never once it's paid.
  if (_payTicketId && !_charging) {
    const e = queue().find(x => String(x.id) === String(_payTicketId));
    if (e && e.quickSale && e.status === 'waiting') dispatch('queue.remove', { id: String(_payTicketId) });
  }
  _pendingPay = null;
  _payGc = []; _payTicketId = null; _gcPickerOpen = false; _newGcOpen = false; _payCash = 0; _payTip = 0; _payZelle = 0; _payTipFromDrawer = false;
  const gs = document.getElementById('square-gc-section'); if (gs) gs.innerHTML = '';
  const m = document.getElementById('square-confirm-modal');
  if (m) { m.classList.add('hidden'); m.style.display = ''; }
}

// ── Admin/manager: record a payment taken OUTSIDE the app (no charge) ─────────
// Two confirmation steps (a warning, then a tender form) so it can't be a one-tap mistake. Reuses
// _finalizeTerminalPaid → a real record + commission + audit are created, with the chosen method as
// the tender and an optional external reference (e.g. the Helcim txn id) for reconcile matching.
export function markPaidNoCharge() {
  if (!_pendingPay) return;
  if (!canDo('markPaidDirect')) { showToast('Your role doesn’t have permission to mark paid without charging.'); return; }
  window.showWarnModal?.(
    'Record payment without charging?',
    'This marks the ticket PAID without charging a card. Use ONLY when the customer already paid another way (for example, the charge was keyed manually on the terminal). Nothing will be charged.',
    () => _markPaidForm(),
    'Continue');
}
function _markPaidForm(initMethod) {
  if (!_pendingPay) return;
  const amount = (_pendingPay.cents || 0) / 100;
  let method = initMethod || 'card';
  document.getElementById('_markpaid-modal')?.remove();
  const methods = [['card','Card'],['cash','Cash'],['zelle','Zelle'],['gift','Gift'],['other','Other']];
  const m = document.createElement('div');
  m.id = '_markpaid-modal';
  m.className = 'fixed inset-0 z-[90] flex items-center justify-center px-4';
  m.style.cssText = 'background:rgba(15,26,26,.5)';
  m.innerHTML = `<div class="bg-surface-container-lowest rounded-2xl p-5 w-full max-w-sm shadow-2xl fade-up" onclick="event.stopPropagation()">
    <div class="text-base font-headline font-bold text-on-surface mb-0.5">Record as already paid</div>
    <div class="text-xs font-body text-on-surface-variant mb-3">No charge will be sent — this creates the sale record with the tender below.</div>
    <label class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest block mb-1">Method</label>
    <div class="flex gap-1.5 flex-wrap mb-3" id="_mp-methods">${methods.map(([k,l]) => `<button type="button" data-m="${k}" class="flex-1 py-2 rounded-xl border-2 font-body font-semibold text-sm transition-all ${k===method?'border-primary bg-primary text-on-primary':'border-outline-variant bg-transparent text-on-surface'}">${l}</button>`).join('')}</div>
    <label class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest block mb-1">Amount</label>
    <input id="_mp-amount" type="text" inputmode="decimal" value="${amount.toFixed(2)}" class="w-full border-2 border-surface-container-high bg-transparent rounded-xl px-3 py-2 text-sm font-headline focus:border-primary outline-none mb-3">
    <label class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest block mb-1">Reference / txn id (optional)</label>
    <input id="_mp-ref" type="text" placeholder="e.g. Helcim transaction id" class="w-full border-2 border-surface-container-high bg-transparent rounded-xl px-3 py-2 text-sm font-body focus:border-primary outline-none mb-4">
    <div class="flex gap-2">
      <button id="_mp-cancel" class="flex-1 border border-outline-variant text-on-surface-variant hover:bg-surface-container py-2.5 rounded-xl font-headline font-semibold">Cancel</button>
      <button id="_mp-confirm" class="flex-1 bg-primary hover:bg-primary-dim text-on-primary py-2.5 rounded-xl font-headline font-bold">Confirm — mark paid</button>
    </div></div>`;
  m.addEventListener('click', () => m.remove());
  document.body.appendChild(m);
  m.querySelectorAll('#_mp-methods button').forEach(b => b.addEventListener('click', () => {
    method = b.dataset.m;
    m.querySelectorAll('#_mp-methods button').forEach(x => { const on = x === b; x.classList.toggle('border-primary',on); x.classList.toggle('bg-primary',on); x.classList.toggle('text-on-primary',on); x.classList.toggle('border-outline-variant',!on); x.classList.toggle('bg-transparent',!on); x.classList.toggle('text-on-surface',!on); });
  }));
  m.querySelector('#_mp-cancel').addEventListener('click', () => m.remove());
  m.querySelector('#_mp-confirm').addEventListener('click', () => {
    const amt = parseFloat(document.getElementById('_mp-amount').value) || 0;
    const ref = (document.getElementById('_mp-ref').value || '').trim();
    m.remove();
    _markPaidCommit(method, amt, ref);
  });
}
// The tender split a manual/mark-paid records. 'other'/zero → no tender line (the sale still
// records, just untracked-by-method). Pure so it can be unit-tested; reports read tenders.{cash|zelle|card}.
export function tendersFor(method, amount) {
  return (method && method !== 'other' && amount > 0) ? { [method]: amount } : {};
}
function _markPaidCommit(method, amount, ref) {
  const ids = (_pendingPay?.ids || []).slice();
  if (!ids.length) return;
  const tenders = tendersFor(method, amount);
  const refIds = ref ? [ref] : [];
  // Finalize FIRST (marks each ticket paid → a quickSale is no longer 'waiting'), THEN close the
  // confirm modal — so closeSquareConfirm's cancelled-quickSale cleanup doesn't drop a paid ticket.
  _finalizeTerminalPaid(ids, tenders, refIds, 0, []);
  closeSquareConfirm(true);
  window.logAudit?.('Manual paid', `Marked paid · ${method}${amount ? ' $' + amount.toFixed(2) : ''}${ref ? ' · ref ' + ref : ''}`);
}

// Manual (no-terminal) checkout: one tap records the full ticket total to the chosen tender chip.
// Available to every front-desk user — in manual mode it's the only checkout path, so no markPaidDirect gate.
export function markPaidManual() {
  if (!_pendingPay) return;
  _markPaidCommit(_manualTender, (_pendingPay.cents || 0) / 100, '');
}
// The tucked-away "Adjust amount / add reference" link in manual mode → the fuller form,
// pre-selected to the current tender chip (e.g. to log an external terminal's txn id or a partial).
export function markPaidAdjust() {
  if (!_pendingPay) return;
  _markPaidForm(_manualTender);
}
// Wire the manual tender chips (Cash / Zelle / Card) once; called from openSquarePOS.
let _manualChipsWired = false;
function _syncManualChips() {
  const wrap = document.getElementById('sq-tender-chips'); if (!wrap) return;
  wrap.querySelectorAll('button').forEach(b => {
    const on = b.dataset.m === _manualTender;
    b.classList.toggle('border-primary', on); b.classList.toggle('bg-primary', on); b.classList.toggle('text-on-primary', on);
    b.classList.toggle('border-outline-variant', !on); b.classList.toggle('bg-transparent', !on); b.classList.toggle('text-on-surface', !on);
  });
  if (!_manualChipsWired) {
    _manualChipsWired = true;
    wrap.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { _manualTender = b.dataset.m; _syncManualChips(); }));
  }
}

export function proceedSquarePayment() {
  if (!_pendingPay) return;
  const appId = sqConfig()?.applicationId;
  if (!appId) { showToast('Add your Square Application ID in Settings → Square first.'); return; }
  // Safety net behind the disabled-button guard: the legacy deep link cannot represent the app's
  // gift redemption (it charges the full bill), so a staged gift would double-collect. Force gift
  // sales through the Terminal flow, which nets the gift via _payCardDueDollars.
  if (_payGiftDollars() > 0.001) { showToast('A gift card is applied — use Pay on Terminal so the card is charged only the remaining balance.'); return; }
  const data = {
    // callback_url must EXACTLY match the Web Callback URL registered in the Square
    // Developer Console (Point of Sale API). Pinned to the app scope.
    amount_money: { amount: _pendingPay.cents, currency_code: 'USD' },
    callback_url: location.origin + '/turndesk/',
    client_id: appId,
    version: '1.3',
    notes: `Muse${_pendingPay.names ? ' · ' + _pendingPay.names : ''}`,
    options: { supported_tender_types: ['CREDIT_CARD', 'CASH', 'OTHER', 'SQUARE_GIFT_CARD', 'CARD_ON_FILE'] },
  };
  // Stash the party (+ names/amount) so we can mark them Paid on return. The Safari
  // return tab uses this to write turndesk_sq_paid; the installed PWA — which iOS resumes
  // WITHOUT the callback data — uses it for the confirm-on-resume prompt (see main.js).
  try { localStorage.setItem('turndesk_sq_pending', JSON.stringify({ ids: _pendingPay.ids || [], names: _pendingPay.names || '', cents: _pendingPay.cents || 0, at: Date.now() })); } catch (e) {}
  // R6: stash the recorded gift cards on the ticket so they're logged + drawn down when it's
  // marked Paid (on Square return). The full amount still goes to Square above — charge unchanged.
  if (_payTicketId) {
    const ge = queue().find(x => String(x.id) === _payTicketId);
    if (ge) { ge.giftcardRedemptions = _payGc.map(t => ({ giftcardId: t.giftcardId, serial: t.serial, who: t.who, amount: t.amount })); dispatch('queue.upsert', { entry: ge }); }
  }
  closeSquareConfirm(true);   // paying → keep the applied fee
  window.location.href = `square-commerce-v1://payment/create?data=${encodeURIComponent(JSON.stringify(data))}`;
}
export function openSquarePOSFromModal() {
  window.saveCurrentGroupTabInputs?.();
  const entryId = window.activeGroupEntryId?.();
  if (entryId) openSquarePOS(entryId);
}

// ── Square Terminal checkout (total-only, in-person) ─────────────────────────
// Charges the ticket TOTAL on the paired Square Terminal via the Terminal API (no
// itemized order), polls for the result, marks the ticket Paid, and stores the Square
// payment ids (unblocks exact refunds). Total-only by design: the customer's Square
// receipt is NOT itemized and prints from the Terminal itself; the app's Reports keep
// the full per-item breakdown. All calls go through SQUARE_PROXY (server-side token);
// polling, no webhook.
let _termCheckoutId = null, _termPollTimer = null;
// Re-entry guard for the Terminal pay flow: there's an `await squareUpsertCustomer` before the
// blocking Terminal modal shows, during which the Pay button stays live. The deterministic idem
// keys already prevent a double-charge, but a double-tap leaks the poll timer + double-toasts —
// this blocks the second invocation until the first settles.
let _charging = false;

function showTerminalModal(msg) {
  const t = document.getElementById('square-terminal-status'); if (t) t.textContent = msg;
  const m = document.getElementById('square-terminal-modal'); if (!m) return;
  m.classList.remove('hidden'); m.style.display = 'flex';
}
function hideTerminalModal() {
  clearTimeout(_termPollTimer); _termPollTimer = null; _termCheckoutId = null;
  const m = document.getElementById('square-terminal-modal'); if (m) { m.classList.add('hidden'); m.style.display = ''; }
}

export async function proceedTerminalPayment() {
  if (!_pendingPay) return;
  if (_charging) return;   // ignore double-taps while a charge is already in flight
  const sc = sqConfig();
  if (!helcimActive() && !sc?.locationId) { showToast('Add your Square Location ID in Settings → Square first.'); return; }
  const party = (_pendingPay.ids || []).map(id => queue().find(x => String(x.id) === String(id))).filter(Boolean);
  if (!party.length) { showToast('Ticket not found.'); return; }
  // Split tender: cash + gift cards reduce what's charged on the card.
  const total         = _pendingPay.cents;              // the BILL in cents (tip NOT included)
  const tipCents       = Math.round(_payTipDollars() * 100);   // tip — collected on top of the bill, recorded separately (never part of `total`)
  const giftCents      = Math.round(_payGiftDollars() * 100);
  // Amounts each tender actually COLLECTS (toward bill + tip) — what we charge/record in Square.
  const cashAppliedC   = Math.round(_payCashAppliedDollars() * 100);
  const cashReceivedC  = Math.round(_payCash * 100);
  const changeCents    = Math.round(_payChangeDollars() * 100);
  const zelleC         = Math.round(_payZelleAppliedDollars() * 100);   // Zelle collected incl. its share of the tip (no change)
  const termCharge     = Math.max(0, (total + tipCents) - giftCents - cashAppliedC - zelleC);   // card balance + any tip cash/Zelle didn't cover
  // BILL-portion of each tender (cash → Zelle → card, capped at the bill after gift) for the
  // recorded `tenders` map — so it always sums to the BILL and the tip stays a separate field.
  // Reports/reconcile add the tip on top, and every historical record uses this same shape.
  const billAfterGiftC = Math.max(0, total - giftCents);
  const cashBillC      = Math.min(cashAppliedC, billAfterGiftC);
  const zelleBillC     = Math.min(zelleC, billAfterGiftC - cashBillC);
  const cardBillC      = Math.max(0, billAfterGiftC - cashBillC - zelleBillC);
  // Cash-drawer gate: non-Admin users must open a cash drawer before taking cash, so the
  // cash lands in a reconciled shift. Admin (Manager PIN) is exempt. See features/cashdrawer.js.
  if (cashAppliedC > 0 && !getState().config.cash_drawer && getActiveUser()?.role !== 'admin') {
    showToast('Open a cash drawer before taking cash.');
    window.openCashRegister?.();
    return;
  }
  if (!helcimActive() && termCharge > 0 && !sc.terminalDeviceId) { showToast('Pair your Square Terminal in Settings → Square first.'); return; }
  // Capture BEFORE closeSquareConfirm() — it nulls _pendingPay / _payTicketId / _payCash / _payTip.
  const payNames = _pendingPay.names || '', ticketId = _payTicketId, partyIds = party.map(e => String(e.id));
  const tenders  = { cash: cashBillC / 100, card: cardBillC / 100, gift: giftCents / 100, zelle: zelleBillC / 100, cashReceived: cashReceivedC / 100, change: changeCents / 100 };
  // Drawer tip payout: the FULL tip minus the part the customer physically handed over in cash —
  // a tip collected by card, ZELLE or GIFT never reached the drawer, so handing it to the tech
  // needs a cash-out entry or the drawer reconciles short. (The old card-share-only rule missed
  // Zelle/gift-covered tips.) Logged on success when the "pay tip in cash" box is checked.
  const tipPayout = drawerTipPayoutCents(tipCents, cashAppliedC, cashBillC, _payTipFromDrawer) / 100;
  // Stash recorded gift cards on the ticket so they're drawn down when marked Paid.
  if (ticketId) {
    const ge = queue().find(x => String(x.id) === ticketId);
    if (ge) { ge.giftcardRedemptions = _payGc.map(t => ({ giftcardId: t.giftcardId, serial: t.serial, who: t.who, amount: t.amount })); dispatch('queue.upsert', { entry: ge }); }
  }
  // DETERMINISTIC idempotency keys (ticket + cents amount). A retry of the SAME charge produces
  // the SAME key, so Square dedupes it within its 24h idempotency window — no double-charge.
  // (The old keys embedded Date.now() and were regenerated after a 15-min TTL, so a retry after a
  // poll timeout minted a NEW key and could charge the card twice.)
  const idemBase = String(ticketId || ('t-' + total));
  const pend = {
    ticketId,
    checkoutKey: `chk-${idemBase}-${termCharge}`,
    cashKey:     `cash-${idemBase}-${cashAppliedC}`,
    zelleKey:    `zelle-${idemBase}-${zelleC}`,
  };
  try { localStorage.setItem('turndesk_term_pending', JSON.stringify({ ...pend, at: Date.now() })); } catch (e) {}
  // Resolve/create the Square customer for this ticket (by the primary guest's phone) so the
  // sale is ATTACHED to them in Square via customer_id — not just a free-text name note.
  // Best-effort: never blocks the charge (no phone / Square unreachable → stays unlinked).
  _charging = true;
  let customerId = null;
  try { customerId = await squareUpsertCustomer(party[0]); } catch (e) {}
  closeSquareConfirm();
  try {
    // 1) Card portion + tip on the Terminal (the uncertain step) — do it FIRST.
    let cardPaymentId = null;
    if (termCharge > 0 && helcimActive()) {
      // Helcim terminal. Deterministic invoice ref per (ticket, card amount) makes a retry after a
      // timeout idempotent — chargeOnHelcim returns the existing APPROVED charge instead of re-charging.
      // To CANCEL, press Cancel on the terminal — Helcim has no software-cancel; the terminalCancel
      // webhook then resolves this charge as cancelled (the ticket is not marked paid).
      showTerminalModal(`Charging $${(termCharge / 100).toFixed(2)} on the Terminal — finish on the device, or press Cancel on the terminal to stop.`);
      // Carry the customer's name+phone to Helcim (best-effort) so the terminal can text/email the receipt.
      let _hcCust = null; try { _hcCust = await helcimCustomerCode(party[0]?.name, party[0]?.phone); } catch (e) {}
      const res = await chargeOnHelcim(termCharge / 100, `tkt-${idemBase}-${termCharge}`, _hcCust ? { customerCode: _hcCust } : {});
      hideTerminalModal();
      if (!res.ok) {
        _unstageGift(ticketId);
        if (res.status === 'CANCELLED' || res.status === 'TIMEOUT') { try { localStorage.removeItem('turndesk_term_pending'); } catch (e) {} }
        showToast(res.error || 'Payment not completed.');
        return;
      }
      cardPaymentId = res.transactionId || null;
    } else if (termCharge > 0) {
      showTerminalModal(`Charging $${(termCharge / 100).toFixed(2)} on the Terminal — finish on the device…`);
      const coRes = await fetch(`${SQUARE_PROXY}/v2/terminals/checkouts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotency_key: pend.checkoutKey, checkout: {
          amount_money: { amount: termCharge, currency: 'USD' },   // card balance + tip — no itemized order
          device_options: { device_id: sc.terminalDeviceId },
          reference_id: String(ticketId || '').slice(0, 40),
          note: payNames.slice(0, 500),
          ...(customerId ? { customer_id: customerId } : {}),
        } }),
      });
      const coJson = await coRes.json();
      if (!coRes.ok) throw new Error(coJson.errors?.[0]?.detail || 'Could not start the Terminal checkout');
      _termCheckoutId = coJson.checkout?.id;
      const co = await _pollTerminalCheckout(_termCheckoutId);
      if (co.status === 'TIMEOUT')  { hideTerminalModal(); _unstageGift(ticketId); showToast('Terminal timed out — check the device, then try again.'); return; }
      if (co.status === 'CANCELED') { hideTerminalModal(); _unstageGift(ticketId); try { localStorage.removeItem('turndesk_term_pending'); } catch (e) {} showToast('Payment canceled on the Terminal.'); return; }
      cardPaymentId = (co.payment_ids || [])[0] || null;
    }
    // 2) Only AFTER the card succeeds, record the cash portion in Square.
    // Track which tenders failed to POST so the operator isn't told "Paid ✓" while Square's
    // totals silently miss real cash/Zelle (the recorders return null on failure, by design,
    // because the money was physically received — so we surface it instead of blocking).
    const unrecorded = [];
    let cashPaymentId = null, zellePaymentId = null;
    // Cash/Zelle are pushed to Square only when Square is the active processor (for Square's totals).
    // On Helcim they're app-only — already captured in `tenders` + the cash drawer + reports.
    if (!helcimActive()) {
      if (cashAppliedC > 0) {
        showTerminalModal('Recording cash payment…');
        cashPaymentId = await recordCashPayment(cashAppliedC, cashReceivedC, sc.locationId, pend.cashKey, customerId);
        if (!cashPaymentId) unrecorded.push('cash');
      }
      // 3) Record the Zelle portion as an EXTERNAL payment so Square's totals include it.
      if (zelleC > 0) {
        showTerminalModal('Recording Zelle payment…');
        zellePaymentId = await recordExternalPayment(zelleC, 'Zelle', sc.locationId, pend.zelleKey, customerId);
        if (!zellePaymentId) unrecorded.push('Zelle');
      }
    }
    _finalizeTerminalPaid(partyIds, tenders, [cardPaymentId, cashPaymentId, zellePaymentId].filter(Boolean), tipCents / 100, unrecorded);
    // Pay the tip to the tech in cash from the drawer (no-op if no drawer is open).
    if (tipPayout > 0) window.cdRecordCashOut?.(tipPayout, ('Tip — ' + payNames).slice(0, 80), 'tip');
  } catch (e) { hideTerminalModal(); _unstageGift(ticketId); showToast('Square: ' + (e.message || 'error')); }
  finally { _charging = false; }
}
// Pay-path P0 (v4.55): a cancelled / timed-out / errored charge must leave NO trace — the gift
// redemptions were staged on the ticket before the charge (so they'd draw down when paid); un-stage
// them so a cancelled attempt doesn't leave a dangling redemption to commit on a later pay.
function _unstageGift(ticketId) {
  if (!ticketId) return;
  const ge = queue().find(x => String(x.id) === String(ticketId));
  if (ge && (ge.giftcardRedemptions || []).length) { ge.giftcardRedemptions = []; dispatch('queue.upsert', { entry: ge }); }
}

// Reusable one-off Terminal charge (e.g. a gift-card sale) — NOT tied to a queue ticket. Shows the
// Terminal modal, starts a checkout, polls to a terminal state. Returns { ok, paymentId, error }.
export async function chargeOnTerminal(amountCents, note, idemKey) {
  const sc = sqConfig();
  if (!sc?.locationId) return { ok: false, error: 'Add your Square Location ID in Settings → Square first.' };
  if (!sc.terminalDeviceId) return { ok: false, error: 'Pair your Square Terminal in Settings → Square first.' };
  if (!(amountCents > 0)) return { ok: false, error: 'Amount must be greater than zero.' };
  try {
    showTerminalModal(`Charging $${(amountCents / 100).toFixed(2)} on the Terminal — finish on the device…`);
    const coRes = await fetch(`${SQUARE_PROXY}/v2/terminals/checkouts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotency_key: idemKey, checkout: { amount_money: { amount: amountCents, currency: 'USD' }, device_options: { device_id: sc.terminalDeviceId }, note: (note || '').slice(0, 500) } }),
    });
    const coJson = await coRes.json();
    if (!coRes.ok) { hideTerminalModal(); return { ok: false, error: coJson.errors?.[0]?.detail || 'Could not start the Terminal checkout' }; }
    const co = await _pollTerminalCheckout(coJson.checkout?.id);
    hideTerminalModal();
    if (co.status === 'TIMEOUT') return { ok: false, error: 'Terminal timed out — check the device, then try again.' };
    if (co.status === 'CANCELED') return { ok: false, error: 'Payment canceled on the Terminal.' };
    return { ok: true, paymentId: (co.payment_ids || [])[0] || null };
  } catch (e) { hideTerminalModal(); return { ok: false, error: e.message || 'Terminal error' }; }
}

// Record the cash portion as a CASH payment in Square (so Square's totals include it).
// A failure here does NOT block marking the ticket Paid — the cash was physically received.
export async function recordCashPayment(appliedCents, receivedCents, locationId, idemKey, customerId, note) {
  try {
    const r = await fetch(`${SQUARE_PROXY}/v2/payments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idempotency_key: idemKey,
        source_id: 'CASH',
        amount_money: { amount: appliedCents, currency: 'USD' },   // the sale amount paid in cash
        cash_details: { buyer_supplied_money: { amount: Math.max(receivedCents, appliedCents), currency: 'USD' } },   // cash handed over → Square computes change_back
        location_id: locationId,
        ...(customerId ? { customer_id: customerId } : {}),
        ...(note ? { note: String(note).slice(0, 500) } : {}),
      }),
    });
    const j = await r.json();
    if (!r.ok) { console.warn('[cash] Square record failed:', j.errors); return null; }
    return j.payment?.id || null;
  } catch (e) { console.warn('[cash] Square record error:', e); return null; }
}

// Record an EXTERNAL (non-card, non-cash) payment in Square — e.g. Zelle — so Square's totals
// include it. Uses source_id 'EXTERNAL' with external_details. A failure here does NOT block
// marking the ticket Paid (the money was received out-of-band); it's tracked in the app either way.
export async function recordExternalPayment(appliedCents, label, locationId, idemKey, customerId, note) {
  try {
    const r = await fetch(`${SQUARE_PROXY}/v2/payments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idempotency_key: idemKey,
        source_id: 'EXTERNAL',
        amount_money: { amount: appliedCents, currency: 'USD' },
        external_details: { type: 'BANK_TRANSFER', source: label },   // Zelle = a bank transfer
        location_id: locationId,
        ...(customerId ? { customer_id: customerId } : {}),
        ...(note ? { note: String(note).slice(0, 500) } : {}),
      }),
    });
    const j = await r.json();
    if (!r.ok) { console.warn('[external] Square record failed:', j.errors); return null; }
    return j.payment?.id || null;
  } catch (e) { console.warn('[external] Square record error:', e); return null; }
}

// Poll the Terminal checkout to a terminal state. Resolves with the checkout object on
// COMPLETED/CANCELED, or { status:'TIMEOUT' } after 5 min.
function _pollTerminalCheckout(id) {
  return new Promise(resolve => {
    const started = Date.now();
    const tick = async () => {
      if (Date.now() - started > 5 * 60 * 1000) { resolve({ status: 'TIMEOUT' }); return; }
      let co = null;
      try { const r = await fetch(`${SQUARE_PROXY}/v2/terminals/checkouts/${id}`); const j = await r.json(); co = j.checkout || null; } catch (e) {}
      if (co?.status === 'COMPLETED' || co?.status === 'CANCELED') { resolve(co); return; }
      _termPollTimer = setTimeout(tick, 2000);   // PENDING / IN_PROGRESS / CANCEL_REQUESTED → keep waiting
    };
    tick();
  });
}

function _finalizeTerminalPaid(partyIds, tenders, paymentIds, tipDollars, unrecorded) {
  hideTerminalModal();
  // The Assign & Price modal stays open during the charge (so a cancel returns to it) — but once
  // the payment lands, close it; leaving it up showed a stale, already-paid ticket.
  window.closeGroupAssignModal?.();
  partyIds.forEach((id, i) => {
    const ge = queue().find(x => String(x.id) === String(id));
    if (ge) {
      if (paymentIds.length) ge.squarePaymentIds = paymentIds;
      if (i === 0) { ge.tenders = tenders; if (tipDollars > 0) ge.tip = tipDollars; if (unrecorded?.length) ge.squareUnrecorded = unrecorded; }   // group-level split + one tip, recorded on the primary ticket
      ge.totalCost = ticketTotal(ge);   // bill only — tip is NOT folded in
      dispatch('queue.upsert', { entry: ge });
    }
    window.updateStatus?.(String(id), 'paid');   // → saveRecord (records tenders/tip/squarePaymentIds) + gift-card draw-down + audit
  });
  try { localStorage.removeItem('turndesk_term_pending'); } catch (e) {}
  _pendingPay = null; _payGc = []; _payTicketId = null; _payCash = 0; _payTip = 0; _payZelle = 0;
  // If a cash/Zelle record failed to reach Square, the ticket is still correctly Paid (money was
  // received) but Square's totals are short — tell the operator instead of a clean "Paid ✓".
  showToast(unrecorded?.length
    ? `Paid ✓ — ${unrecorded.join(' & ')} not logged to Square (will show in Reconcile)`
    : 'Paid ✓');
}

export async function cancelTerminalCheckout() {
  const id = _termCheckoutId;
  if (!id) { hideTerminalModal(); return; }
  showTerminalModal('Canceling on the device…');
  // Don't clear the poll timer here — let the poll observe CANCELED and finish cleanly.
  try { await fetch(`${SQUARE_PROXY}/v2/terminals/checkouts/${id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (e) {}
}

// Reprint a receipt for a PAST sale. Square uses the Terminal Action API (type RECEIPT).
// HELCIM has NO print API — its Payment Hardware API only does purchase/refund — so a
// receipt reprint can only be done on the terminal's own screen; for Helcim sales we show
// the operator how to do that (and the transaction number to find it by).
export async function reprintTerminalReceipt(recordId) {
  const rec = (getState().records || []).find(r => String(r.id) === String(recordId))
           || (getState().queue || []).find(r => String(r.id) === String(recordId));
  const paymentId = rec?.squarePaymentIds?.[0];   // for Helcim sales this is the Helcim transaction id

  if (helcimActive()) {
    const body = paymentId
      ? `The Helcim terminal prints its receipt at the time of sale, and Helcim doesn’t let the app trigger the terminal’s printer.\n\nTo reprint a copy, do it on the terminal: open the menu (≡) → Transactions, find this sale (transaction ${paymentId}), and tap Reprint.`
      : `This sale wasn’t charged on the card terminal, so the Helcim terminal has no receipt for it. Card receipts reprint from the terminal’s own Transactions menu.`;
    if (window.showWarnModal) window.showWarnModal('Reprint on the Helcim terminal', body, () => {}, 'Got it');
    else showToast(paymentId ? `On the terminal: Transactions → txn ${paymentId} → Reprint.` : 'Not a card sale — nothing to reprint on the terminal.');
    return;
  }

  if (!paymentId) { showToast('No Square payment on file — receipts reprint only for Square Terminal sales.'); return; }
  const deviceId = sqConfig()?.terminalDeviceId;
  if (!deviceId) { showToast('Pair your Square Terminal in Settings → Square first.'); return; }
  try {
    showToast('Sending receipt to the Terminal…');
    const res = await fetch(`${SQUARE_PROXY}/v2/terminals/actions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idempotency_key: 'rcpt-' + recordId + '-' + paymentId,   // stable per (record,payment) so a double-tap dedupes instead of printing twice
        action: { type: 'RECEIPT', device_id: deviceId, receipt_options: { payment_id: paymentId, is_duplicate: true, print_only: true } },
      }),
    });
    const j = await res.json();
    if (!res.ok) { showToast('Square: ' + (j.errors?.[0]?.detail || 'could not print the receipt')); return; }
    showToast('Receipt printing on the Terminal ✓');
  } catch (e) { showToast('Could not reach Square.'); }
}

// ── R6: gift-card "used" recorder inside the Confirm Payment modal ────────────────
// Pure bookkeeping: stage which cards were used + how much, shown under the ticket. The
// "Charge in Square" line stays the FULL ticket total; nothing here reduces it. Staged amounts
// are persisted onto the ticket on Proceed and committed to the card ledger when it's Paid.
function renderPayGc() {
  const host = document.getElementById('square-gc-section'); if (!host) return;
  // Manual (no-terminal) checkout: the split-tender inputs, gift-card picker, and the
  // "Card on Terminal" breakdown are all charge-flow UI. Hide them — the ticket block shows the
  // total and the one-tap Mark-paid button carries the amount + chosen tender.
  if (manualMode()) { host.innerHTML = ''; return; }
  const cards = getState().giftcards || [];
  const lines = _payGc.map(t => {
    const g = cards.find(x => x.id === t.giftcardId);
    const proj = g ? (_gcBal(g) - _gcStagedFor(t.giftcardId)) : 0;
    return `<div class="flex items-center justify-between bg-primary-container/15 border border-surface-container-high rounded-lg px-3 py-2 mb-1.5">
      <span class="text-sm font-body text-on-surface">Gift card #${t.serial || '—'}${t.who ? ' · ' + t.who : ''}</span>
      <span class="flex items-center gap-2"><span class="text-xs font-headline font-semibold text-on-surface-variant">$${(t.amount || 0).toFixed(2)} used · bal $${proj.toFixed(2)}</span>
      <button onclick="sqRemoveGiftcard('${t.giftcardId}')" title="Remove" class="text-outline hover:text-error flex items-center"><span class="material-symbols-outlined" style="font-size:16px">close</span></button></span>
    </div>`;
  }).join('');
  const room = _gcRoom();
  const addBtn = room > 0.001 ? `<button onclick="sqToggleGcPicker()" class="w-full border border-dashed border-primary text-primary rounded-lg py-2 text-xs font-body font-semibold hover:bg-primary/5">+ Apply gift card</button>` : '';
  // Off-registry gift card (sold before the registry existed): create it in the registry on the
  // spot + apply it. datePurchased is left blank so the sale isn't counted as income this period
  // (it came in pre-registry); only the redemption today reduces Total Money Collected — correct.
  const newGcBtn = room > 0.001 ? `<button onclick="sqToggleNewGc()" class="w-full border border-dashed border-outline-variant text-on-surface-variant rounded-lg py-2 text-xs font-body font-semibold hover:bg-surface-container mt-1.5">+ Gift card not in registry</button>` : '';
  const newGcForm = _newGcOpen ? `<div class="border border-surface-container-high rounded-lg mt-2 p-3 space-y-2 bg-surface-container/40">
      <div class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest">New gift card — adds to your registry</div>
      <div class="flex items-center gap-2">
        <input id="sq-newgc-serial" type="text" placeholder="Serial (optional)" class="flex-1 border border-surface-container-high rounded-lg px-2 py-1.5 text-sm text-on-surface bg-surface-container-lowest focus:outline-none focus:border-primary">
        <span class="text-on-surface-variant text-sm">$</span>
        <input id="sq-newgc-amt" type="text" inputmode="none" placeholder="Balance" onfocus="openNumpad(this,'Gift card balance','cost')" onclick="openNumpad(this,'Gift card balance','cost')" class="w-24 border border-surface-container-high rounded-lg px-2 py-1.5 text-sm text-right text-on-surface bg-surface-container-lowest focus:outline-none focus:border-primary">
      </div>
      <button onclick="sqAddOffRegistryGiftcard()" class="w-full bg-primary text-on-primary rounded-lg py-2 text-xs font-headline font-bold">Add &amp; apply</button>
    </div>` : '';
  const picker = _gcPickerOpen ? `<div class="border border-surface-container-high rounded-lg mt-2 overflow-hidden">
      <div class="px-3 py-2 bg-surface-container"><input id="sq-gc-search" oninput="filterGcPicker()" placeholder="Search serial / name…" class="w-full bg-transparent text-sm focus:outline-none text-on-surface"></div>
      <div id="sq-gc-rows" class="max-h-44 overflow-y-auto">${_gcPickerRows(room)}</div>
    </div>` : '';
  const cashRow = `<div class="flex items-center justify-between mb-3">
      <span class="text-sm font-body text-on-surface">Cash received</span>
      <span class="flex items-center gap-1"><span class="text-on-surface-variant text-sm">$</span>
      <input id="sq-cash-amt" type="text" inputmode="none" value="${_payCash > 0 ? _payCash.toFixed(2) : ''}" placeholder="0.00" onfocus="openNumpad(this,'Cash received','cost')" onclick="openNumpad(this,'Cash received','cost')" oninput="sqCashInput(this.value)" class="w-24 border border-surface-container-high rounded-lg px-2 py-1.5 text-sm text-right text-on-surface bg-surface-container-lowest focus:outline-none focus:border-primary"></span>
    </div>`;
  // Zelle: an exact bank transfer the customer sends; like cash it reduces what's charged on the
  // card, but there's no change. Recorded in tenders.zelle + logged in Square as an external payment.
  const zelleRow = `<div class="flex items-center justify-between mb-3">
      <span class="text-sm font-body text-on-surface">Zelle received</span>
      <span class="flex items-center gap-1"><span class="text-on-surface-variant text-sm">$</span>
      <input id="sq-zelle-amt" type="text" inputmode="none" value="${_payZelle > 0 ? _payZelle.toFixed(2) : ''}" placeholder="0.00" onfocus="openNumpad(this,'Zelle received','cost')" onclick="openNumpad(this,'Zelle received','cost')" oninput="sqZelleInput(this.value)" class="w-24 border border-surface-container-high rounded-lg px-2 py-1.5 text-sm text-right text-on-surface bg-surface-container-lowest focus:outline-none focus:border-primary"></span>
    </div>`;
  // Tip is collected ON TOP of the bill. It's NOT part of the bill/ticketTotal — it's added to
  // what must be collected, paid by whatever tender covers it (cash/Zelle absorb it first, then
  // the card takes any remainder), and tracked separately in Reports.
  const tipRow = `<div class="flex items-center justify-between mb-3">
      <span class="text-sm font-body text-on-surface">Tip <span class="text-on-surface-variant text-xs">(added to the total)</span></span>
      <span class="flex items-center gap-1"><span class="text-on-surface-variant text-sm">$</span>
      <input id="sq-tip-amt" type="text" inputmode="none" value="${_payTip > 0 ? _payTip.toFixed(2) : ''}" placeholder="0.00" onfocus="openNumpad(this,'Tip','cost')" onclick="openNumpad(this,'Tip','cost')" oninput="sqTipInput(this.value)" class="w-24 border border-surface-container-high rounded-lg px-2 py-1.5 text-sm text-right text-on-surface bg-surface-container-lowest focus:outline-none focus:border-primary"></span>
    </div>`;
  // Optional: pay the card-collected tip to the tech in cash now, logging a drawer Cash Out
  // (tagged 'tip' so it's tallied). Shown only when a drawer is open — cash tips already go
  // straight to the tech.
  const tipDrawerRow = cfg().cash_drawer ? `<label onclick="sqToggleTipDrawer()" class="flex items-center gap-2 mb-3 cursor-pointer select-none">
      <div id="sq-tipdrawer-box" style="width:20px;height:20px;border-radius:5px;flex-shrink:0;display:flex;align-items:center;justify-content:center;border:2px solid ${_payTipFromDrawer ? '#1a5252' : 'var(--outline-variant,#7a858a)'};background:${_payTipFromDrawer ? '#1a5252' : 'transparent'}">
        <span id="sq-tipdrawer-check" class="material-symbols-outlined ${_payTipFromDrawer ? '' : 'hidden'}" style="font-size:13px;color:#fff;font-variation-settings:'FILL' 1">check</span>
      </div>
      <span class="text-xs font-body text-on-surface-variant">Pay the card tip to the tech in cash now — logs a drawer Cash Out</span>
    </label>` : '';
  // Summary: small detail rows (shown only when they apply), then the three key amounts —
  // Sales Total (the bill), Change due, and Card on Terminal (last, divided off) — each ~1.2×
  // the detail rows with a teal amount. Tip Total / Cash received / Change due / Card on
  // Terminal carry ids so sqUpdatePayBreakdown can live-patch them as cash/tip are typed.
  // Fees (default-on toggles; moved here from the Assign & Price modal — v4.51). Each configured
  // fee shows a toggle + amount; off removes it from the ticket, a flat fee's amount is editable.
  const feeRowsHtml = (cfg().fees || []).map(fee => {
    const holder = _payParty().find(e => (e.fees || []).some(f => f.feeId === fee.id));
    const applied = holder ? holder.fees.find(f => f.feeId === fee.id) : null;
    const on = !!applied;
    const amt = on ? (applied.amount || 0) : _feeAmount(fee, _paySvcSubtotal());
    // Checkbox row — matches the app's other in-modal toggles (e.g. the tip-from-drawer box).
    const box = `<span style="width:20px;height:20px;border-radius:5px;flex-shrink:0;display:flex;align-items:center;justify-content:center;border:2px solid ${on ? '#1a5252' : 'var(--outline-variant,#7a858a)'};background:${on ? '#1a5252' : 'transparent'}"><span class="material-symbols-outlined ${on ? '' : 'hidden'}" style="font-size:13px;color:#fff;font-variation-settings:'FILL' 1">check</span></span>`;
    const amtField = fee.type === 'percent'
      ? `<span class="text-sm font-body font-semibold ${on ? 'text-on-surface' : 'text-on-surface-variant'} flex-shrink-0">$${amt.toFixed(2)}</span>`
      : `<span class="flex items-center gap-1 border rounded-lg px-2 py-1 flex-shrink-0 ${on ? 'border-surface-container-high' : 'border-transparent opacity-40'}"><span class="text-on-surface-variant text-sm">$</span><input type="text" inputmode="none" value="${amt > 0 ? amt.toFixed(2) : ''}" ${on ? '' : 'disabled'} onfocus="openNumpad(this,'${fee.label}','cost')" onclick="openNumpad(this,'${fee.label}','cost')" oninput="payFeeAmountInput('${fee.id}',this.value)" class="w-16 bg-transparent text-sm text-right text-on-surface focus:outline-none"></span>`;
    return `<div class="flex items-center justify-between gap-2 mb-2"><label onclick="payToggleFee('${fee.id}')" class="flex items-center gap-2.5 cursor-pointer select-none flex-1 min-w-0">${box}<span class="text-sm font-body font-semibold text-on-surface truncate">${fee.label}</span></label>${amtField}</div>`;
  }).join('');
  const feeSection = (cfg().fees || []).length ? `<div class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest mb-2 mt-1">Fees</div>${feeRowsHtml}` : '';
  const breakdown = `<div id="sq-pay-breakdown" class="mt-3 pt-2 border-t border-surface-container-high text-sm font-body space-y-1">${_breakdownRows()}</div>`;
  host.innerHTML = `${feeSection}<div class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest mb-2 mt-1">Split payment — optional</div>${cashRow}${zelleRow}${tipRow}${tipDrawerRow}<div class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest mb-1">Gift card used (recorded; keeps balances in sync)</div>${lines}${addBtn}${newGcBtn}${picker}${newGcForm}${breakdown}`;
  sqUpdatePayBreakdown();
}
export function sqCashInput(v) {
  const n = parseFloat(v);
  _payCash = isFinite(n) && n > 0 ? n : 0;
  sqUpdatePayBreakdown();
}
export function sqTipInput(v) {
  const n = parseFloat(v);
  _payTip = isFinite(n) && n > 0 ? n : 0;
  sqUpdatePayBreakdown();
}
export function sqZelleInput(v) {
  const n = parseFloat(v);
  _payZelle = isFinite(n) && n > 0 ? n : 0;
  sqUpdatePayBreakdown();
}
// Toggle "pay the card tip from the drawer in cash" — visual flip only (no re-render, so the
// numpad isn't yanked). The actual drawer Cash Out is logged on finalize in proceedTerminalPayment.
export function sqToggleTipDrawer() {
  _payTipFromDrawer = !_payTipFromDrawer;
  const box = document.getElementById('sq-tipdrawer-box'), chk = document.getElementById('sq-tipdrawer-check');
  if (box) { box.style.background = _payTipFromDrawer ? '#1a5252' : 'transparent'; box.style.borderColor = _payTipFromDrawer ? '#1a5252' : 'var(--outline-variant,#7a858a)'; }
  if (chk) chk.classList.toggle('hidden', !_payTipFromDrawer);
}
// Live-patch the breakdown numbers + the action buttons as cash/tip are typed, WITHOUT
// re-rendering the section (which would yank the numpad's target input mid-entry).
export function sqUpdatePayBreakdown() {
  const cardDue = _payCardDueDollars(), change = _payChangeDollars(), cash = _payCash, tip = _payTip, zelle = _payZelleAppliedDollars();
  const termCharge = cardDue;   // tip is already folded into cardDue (only the portion cash/Zelle didn't cover)
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = '$' + v.toFixed(2); };
  set('sq-card-due', termCharge); set('sq-cash-rcv', cash); set('sq-change', change); set('sq-tip', tip); set('sq-zelle-rcv', zelle);
  const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? 'flex' : 'none'; };
  show('sq-row-cashrcv', cash > 0); show('sq-row-change', change > 0.0001); show('sq-row-tip', tip > 0.0001); show('sq-row-zelle', zelle > 0.0001);
  const tb = document.getElementById('sq-terminal-btn');
  if (tb) tb.innerHTML = termCharge > 0
    ? `<span class="material-symbols-outlined" style="font-size:18px">contactless</span> Pay $${termCharge.toFixed(2)} on Terminal`
    : `<span class="material-symbols-outlined" style="font-size:18px">check</span> Record Payment`;
  // The legacy Square POS deep link charges the bill only (no cash split, no tip) — disable it
  // whenever a cash split or a tip is in play, since those are handled by the Terminal.
  const pb = document.getElementById('sq-pos-btn');
  // Disable the legacy POS deep link whenever cash/Zelle/tip OR a gift card is in play — the deep
  // link charges the BILL only (no gift reduction), so a gift + deep link would charge the full
  // bill to the card AND still draw the gift down on return. Those splits go through the Terminal.
  if (pb) { const off = _payCash > 0 || _payTip > 0 || _payZelle > 0 || _payGiftDollars() > 0.001; pb.disabled = off; pb.style.opacity = off ? '0.4' : ''; pb.style.pointerEvents = off ? 'none' : ''; pb.title = off ? 'Cash / Zelle / tip / gift cards are handled by the Terminal flow' : ''; }
}
function _gcPickerRows(room) {
  const q = (document.getElementById('sq-gc-search')?.value || '').toLowerCase();
  const cards = (getState().giftcards || [])
    .map(g => ({ g, avail: _gcBal(g) - _gcStagedFor(g.id) }))
    .filter(({ avail }) => avail > 0.001)
    .filter(({ g }) => !q || (g.serial || '').toLowerCase().includes(q) || (g.to || '').toLowerCase().includes(q) || (g.from || '').toLowerCase().includes(q) || (g.phone || '').includes(q))
    .sort((a, b) => b.avail - a.avail).slice(0, 12);
  if (!cards.length) return `<div class="px-3 py-3 text-xs text-on-surface-variant italic">No gift cards with an available balance.</div>`;
  return cards.map(({ g, avail }) => {
    const who = g.to || g.from || '';
    const deflt = Math.min(avail, room).toFixed(2);
    return `<div class="flex items-center gap-2 px-3 py-2 border-t border-surface-container">
      <div class="flex-1 min-w-0"><div class="text-sm font-body font-semibold text-on-surface truncate">#${g.serial || '—'}${who ? ' · ' + who : ''}</div><div class="text-[11px] text-on-surface-variant">balance $${avail.toFixed(2)}</div></div>
      <input id="sqgc-amt-${g.id}" type="text" inputmode="decimal" value="${deflt}" class="w-20 border border-surface-container-high rounded-lg px-2 py-1 text-sm text-right text-on-surface bg-surface-container-lowest focus:outline-none focus:border-primary">
      <button onclick="sqApplyGiftcard('${g.id}')" class="bg-primary text-on-primary rounded-lg px-3 py-1.5 text-xs font-headline font-bold flex-shrink-0">Record</button>
    </div>`;
  }).join('');
}
export function filterGcPicker() { const host = document.getElementById('sq-gc-rows'); if (host) host.innerHTML = _gcPickerRows(_gcRoom()); }
export function sqToggleGcPicker() { _gcPickerOpen = !_gcPickerOpen; if (_gcPickerOpen) _newGcOpen = false; renderPayGc(); }
export function sqToggleNewGc() { _newGcOpen = !_newGcOpen; if (_newGcOpen) _gcPickerOpen = false; renderPayGc(); }
// Create a gift card that predates the registry, then stage it as payment on this ticket (up to
// the remaining balance due). The card now lives in the registry — reusable next visit, and the
// Terminal charge auto-reduces by the gift amount (see _payCardDueDollars). datePurchased blank.
export function sqAddOffRegistryGiftcard() {
  commitNumpad();   // flush the balance numpad into its field first
  const serialRaw = (document.getElementById('sq-newgc-serial')?.value || '').trim();
  const serial = /^\d+$/.test(serialRaw) ? serialRaw.padStart(8, '0') : serialRaw;
  const balance = parseFloat(document.getElementById('sq-newgc-amt')?.value) || 0;
  if (!(balance > 0)) { showToast('Enter the gift card balance.'); return; }
  const card = { id: 'gc-' + Date.now(), datePurchased: '', serial, amount: +balance.toFixed(2), phone: '', from: '', to: '', redemptions: [], amountUsed: 0, dateUsed: '', notes: 'Added at checkout (pre-registry card)', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  dispatch('giftcard.save', { card });
  const amt = Math.min(balance, _gcRoom());
  if (amt > 0.001) _payGc.push({ giftcardId: card.id, serial: card.serial, who: '', amount: +amt.toFixed(2) });
  _newGcOpen = false; _gcPickerOpen = false;
  renderPayGc();
  window.logAudit?.('Gift card', `Off-registry card #${serial || '—'} added ($${balance.toFixed(2)}) · $${amt.toFixed(2)} applied`);
  showToast(`Gift card added · $${amt.toFixed(2)} applied`);
}
export function sqRemoveGiftcard(id) { _payGc = _payGc.filter(t => t.giftcardId !== id); renderPayGc(); }
export function sqApplyGiftcard(id) {
  const g = (getState().giftcards || []).find(x => x.id === id); if (!g) return;
  const want = parseFloat(document.getElementById('sqgc-amt-' + id)?.value) || 0;
  const amt = Math.min(want, _gcBal(g) - _gcStagedFor(id), _gcRoom());
  if (!(amt > 0.001)) { showToast('Nothing to record.'); return; }
  const ex = _payGc.find(t => t.giftcardId === id);
  if (ex) ex.amount = +(ex.amount + amt).toFixed(2);
  else _payGc.push({ giftcardId: id, serial: g.serial, who: g.to || g.from || '', amount: +amt.toFixed(2) });
  _gcPickerOpen = false; renderPayGc();
}
