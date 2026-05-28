// ── Square POS deep link, orders, appointments, bookings ────────────────────
import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { showToast, commitNumpad, ticketTotal } from '../utils.js';
import { SQUARE_PROXY } from '../config.js';
import { customerDirectory } from './square-customers.js';

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
let _payGc = [], _payTicketId = null, _gcPickerOpen = false;
const _gcBal = g => (g.amount || 0) - (window.gcTotalUsed ? window.gcTotalUsed(g) : 0);
const _gcRoom = () => Math.max(0, (_pendingPay?.cents || 0) / 100 - _payGc.reduce((s, t) => s + (t.amount || 0), 0));
const _gcStagedFor = id => _payGc.filter(t => t.giftcardId === id).reduce((s, t) => s + (t.amount || 0), 0);

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
  if (e.discount > 0) lines.push(payLine(`Discount${e.discountNote ? ' (' + e.discountNote + ')' : ''}`, -e.discount));
  return `<div class="bg-surface-container rounded-xl px-4 py-3">
    <div class="flex justify-between items-center mb-1.5"><span class="font-headline font-bold text-on-surface">${e.name}</span><span class="font-headline font-bold text-primary">$${ticketTotal(e).toFixed(2)}</span></div>
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
  const cents = Math.round(party.reduce((s, e) => s + ticketTotal(e), 0) * 100);
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
  _pendingPay = { cents, ids: party.map(e => String(e.id)), names: party.map(e => e.name).filter(Boolean).join(', ').slice(0, 120) };
  // R6: tie recorded gift cards to the tapped entry; preload any already staged (e.g. Pay was
  // tapped earlier but the charge wasn't completed). Balances are only drawn down when paid.
  _payTicketId = String(entryId);
  _payGc = (entry.giftcardRedemptions || []).map(t => ({ giftcardId: t.giftcardId, serial: t.serial, who: t.who, amount: t.amount }));
  _gcPickerOpen = false;
  renderPayGc();
  const m = document.getElementById('square-confirm-modal');
  if (m) { m.classList.remove('hidden'); m.style.display = 'flex'; }
}

export function closeSquareConfirm() {
  _pendingPay = null;
  _payGc = []; _payTicketId = null; _gcPickerOpen = false;
  const gs = document.getElementById('square-gc-section'); if (gs) gs.innerHTML = '';
  const m = document.getElementById('square-confirm-modal');
  if (m) { m.classList.add('hidden'); m.style.display = ''; }
}

export function proceedSquarePayment() {
  if (!_pendingPay) return;
  const appId = sqConfig()?.applicationId;
  if (!appId) { showToast('Add your Square Application ID in Settings → Square first.'); return; }
  const data = {
    // callback_url must EXACTLY match the Web Callback URL registered in the Square
    // Developer Console (Point of Sale API). Pinned to the app scope.
    amount_money: { amount: _pendingPay.cents, currency_code: 'USD' },
    callback_url: location.origin + '/turndesk/',
    client_id: appId,
    version: '1.3',
    notes: `TurnDesk${_pendingPay.names ? ' · ' + _pendingPay.names : ''}`,
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
  closeSquareConfirm();
  window.location.href = `square-commerce-v1://payment/create?data=${encodeURIComponent(JSON.stringify(data))}`;
}
export function openSquarePOSFromModal() {
  window.saveCurrentGroupTabInputs?.();
  const entryId = window.activeGroupEntryId?.();
  if (entryId) openSquarePOS(entryId);
}

// ── R6: gift-card "used" recorder inside the Confirm Payment modal ────────────────
// Pure bookkeeping: stage which cards were used + how much, shown under the ticket. The
// "Charge in Square" line stays the FULL ticket total; nothing here reduces it. Staged amounts
// are persisted onto the ticket on Proceed and committed to the card ledger when it's Paid.
function renderPayGc() {
  const host = document.getElementById('square-gc-section'); if (!host) return;
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
  const picker = _gcPickerOpen ? `<div class="border border-surface-container-high rounded-lg mt-2 overflow-hidden">
      <div class="px-3 py-2 bg-surface-container"><input id="sq-gc-search" oninput="filterGcPicker()" placeholder="Search serial / name…" class="w-full bg-transparent text-sm focus:outline-none text-on-surface"></div>
      <div id="sq-gc-rows" class="max-h-44 overflow-y-auto">${_gcPickerRows(room)}</div>
    </div>` : '';
  host.innerHTML = `<div class="text-[10px] font-body font-semibold text-outline uppercase tracking-widest mb-2 mt-1">Gift card used — optional (recorded; keeps balances in sync)</div>${lines}${addBtn}${picker}${_payGc.length ? `<div class="text-[11px] font-body text-on-surface-variant mt-2">The full total still goes to Square — Square applies the gift card to the charge. This only records the redemption.</div>` : ''}`;
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
export function sqToggleGcPicker() { _gcPickerOpen = !_gcPickerOpen; renderPayGc(); }
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

// ── Appointments → queue ──────────────────────────
export async function syncSquareAppointments() {
  if (!sqConfig()) { showToast('Square not configured.'); return; }
  showToast('Loading appointments…');
  try {
    const today = new Date();
    const start = new Date(today.setHours(0,0,0,0)).toISOString();
    const end   = new Date(today.setHours(23,59,59,999)).toISOString();
    const res   = await fetch(`${SQUARE_PROXY}/v2/bookings?location_id=${sqConfig().locationId}&start_at_min=${start}&start_at_max=${end}&limit=100`);
    const data  = await res.json();
    if (!data.bookings || data.bookings.length === 0) { showToast('No appointments today from Square.'); return; }
    let added = 0;
    for (const b of data.bookings) {
      if (b.status !== 'ACCEPTED' && b.status !== 'PENDING') continue;
      const entryId = 'appt-' + b.id;
      if (queue().find(e => String(e.id) === entryId)) continue;
      const variationId = b.appointment_segments?.[0]?.service_variation_id;
      const svc = cfg().services.find(s => s.squareVariationId === variationId) || cfg().services.find(s => s.squareItemId === variationId) || cfg().services[0];
      const custDir = b.customer_id ? customerDirectory.find(c => c.squareId === b.customer_id) : null;
      const name = custDir ? [custDir.firstName, custDir.lastName].filter(Boolean).join(' ') : (b.customer_note || 'Appointment');
      dispatch('queue.upsert', { entry: {
        id: entryId, name, phone: custDir?.phone || '', services: svc ? [svc.id] : [],
        status: 'waiting', isAppointment: true, checkinTime: new Date(b.start_at).toISOString(), assignments: [], groupId: null,
      } });
      added++;
    }
    window.renderQueue?.(); window.renderTurns?.();
    showToast(added > 0 ? `${added} appointment(s) added to queue ✓` : 'No new appointments to add.');
  } catch (e) { showToast('Appointments sync failed: ' + e.message); }
}

// ── Push a calendar appointment to Square Bookings (SMS reminders) ──────────────
export async function squarePushBooking(calId, eventId) {
  if (!sqConfig()) { showToast('Square not configured.'); return; }
  if (!sqConfig().bookingTeamMemberId) { showToast('Set a booking team member in Square settings first.'); showSquareModalGlue(); return; }

  const ev = (window.calEventsFor?.(calId) || []).find(x => x.id === eventId);
  if (!ev) { showToast('Event not found.'); return; }

  const startDt = new Date(ev.start.dateTime || ev.start.date);
  const endDt   = new Date(ev.end?.dateTime || ev.end?.date || startDt.getTime() + 3600000);
  const durMins = Math.round((endDt - startDt) / 60000);

  const svc = cfg().services.find(s => (ev.summary||'').toLowerCase().includes(s.label.toLowerCase()) || (ev.description||'').toLowerCase().includes(s.label.toLowerCase()));
  if (!svc?.squareVariationId) { showToast(svc ? `Push "${svc.label}" to Square catalog first (Settings → Services).` : 'No matching service found — check service names match your catalog.'); return; }

  let variationVersion;
  try {
    const objRes = await fetch(`${SQUARE_PROXY}/v2/catalog/object/${svc.squareVariationId}`);
    if (!objRes.ok) { showToast('Could not fetch service version from Square.'); return; }
    variationVersion = (await objRes.json()).object?.version;
    if (!variationVersion) { showToast('Could not read service version from Square.'); return; }
  } catch (e) { showToast('Square catalog fetch failed: ' + e.message); return; }

  const phoneMatch = (ev.description || '').match(/(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/);
  const rawPhone = phoneMatch ? phoneMatch[1].replace(/\D/g, '') : '';
  const custDir = rawPhone ? customerDirectory.find(c => { const cp = (c.phone||'').replace(/\D/g,'').replace(/^1(\d{10})$/,'$1'); return cp && (cp === rawPhone || cp === rawPhone.replace(/^1/,'')); }) : null;

  showToast('Creating Square booking…');
  try {
    const bookingBody = { idempotency_key: `turndesk-booking-${eventId}-${Date.now()}`, booking: {
      start_at: startDt.toISOString(), location_id: sqConfig().locationId, customer_note: ev.summary || '',
      ...(custDir?.squareId ? { customer_id: custDir.squareId } : {}),
      appointment_segments: [{ duration_minutes: durMins, service_variation_id: svc.squareVariationId, service_variation_version: variationVersion, team_member_id: sqConfig().bookingTeamMemberId }],
    } };
    const res = await fetch(`${SQUARE_PROXY}/v2/bookings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bookingBody) });
    const data = await res.json();
    if (res.ok && data.booking?.id) showToast('Square booking created — SMS reminder will send ✓');
    else showToast('Square booking failed: ' + (data.errors?.[0]?.detail || data.errors?.[0]?.code || 'unknown'));
  } catch (e) { showToast('Could not reach Square. Check proxy.'); }
}

function showSquareModalGlue() { window.showSquareModal?.(); }
