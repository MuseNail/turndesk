// ── Book-next-appointment (rebook) at checkout ───────────────────────────────
// After a sale is paid, offer to book the customer's next visit. "Book next appointment"
// jumps to the Calendar and shows a banner; clicking a slot opens the New Appointment form
// autofilled with the customer's name + phone (handled in calendar.js). Device-local only —
// `_pending` is NEVER synced, and maybeOfferRebook runs ONLY from the local finalize path.
import { getState } from '../store.js';
import { escHtml } from '../utils.js';
import { splitName, shouldOfferRebook } from '../rebook-util.js';

const cfg = () => getState().config;

// The customer to book next: { name, phone }. Null = no rebook in progress. Device-local.
let _pending = null;
// The candidate shown on the success card (before the operator taps Book). Separate from
// _pending so a card the operator ignores never enters rebook mode.
let _cardCandidate = null;

export function rebookPending() { return _pending; }

// ── Offer the prompt (checkout device only) ──────────────────────────────────
// GUARDRAIL: call this ONLY from the local _finalizeTerminalPaid. NEVER from updateStatus,
// store.applyChange, onStateChange, or any sync/webhook handler — a synced "paid" transition
// on another device must not pop this card (it would fire on every device for every sale).
export function maybeOfferRebook(entry) {
  // Clear any stale offer from a PREVIOUS sale first — so a later non-service sale (gift card /
  // Quick Sale) doesn't leave the old customer's card up, where "Book" would rebook the wrong person.
  document.getElementById('rebook-card')?.remove();
  document.removeEventListener('keydown', _onCardKey);
  _cardCandidate = null;
  if (!shouldOfferRebook(entry, cfg())) return;
  _cardCandidate = { name: entry.name, phone: entry.phone || '' };
  _showCard(_cardCandidate);
}

function _onCardKey(e) { if (e.key === 'Escape') rebookDismiss(); }

function _showCard({ name }) {
  document.getElementById('rebook-card')?.remove();   // a new sale replaces any lingering card
  const first = splitName(name).first || 'this customer';
  const card = document.createElement('div');
  card.id = 'rebook-card';
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', 'Book next appointment');
  card.setAttribute('aria-live', 'polite');
  // Non-blocking: fixed, no full-screen backdrop — never blocks starting the next checkout.
  // Sits ABOVE the bottom-6 "Paid ✓" toast so the two don't overlap.
  card.className = 'fixed left-1/2 -translate-x-1/2 bottom-24 z-[70] w-80 max-w-[calc(100vw-24px)] bg-surface-container-lowest rounded-2xl shadow-2xl border border-surface-container-high p-4';
  card.innerHTML = `
    <div class="flex items-center gap-2 mb-1">
      <span class="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center"><span class="material-symbols-outlined text-primary" style="font-size:18px" aria-hidden="true">event_upcoming</span></span>
      <span class="font-headline font-bold text-on-surface text-base">Book next visit?</span>
      <button onclick="rebookDismiss()" aria-label="Dismiss" class="ml-auto w-7 h-7 flex items-center justify-center rounded-lg text-on-surface-variant hover:bg-surface-container transition-colors"><span class="material-symbols-outlined" style="font-size:18px" aria-hidden="true">close</span></button>
    </div>
    <div class="text-sm font-body text-on-surface-variant mb-3">${escHtml(first)} is all set — book their next appointment while they're here?</div>
    <button onclick="rebookBookNow()" class="w-full bg-primary hover:bg-primary-dim text-on-primary py-2.5 rounded-xl font-headline font-bold text-sm flex items-center justify-center gap-2"><span class="material-symbols-outlined" style="font-size:18px" aria-hidden="true">event_upcoming</span>Book next appointment</button>
    <button onclick="rebookDismiss()" class="w-full mt-1.5 py-2 rounded-xl text-on-surface-variant font-headline font-semibold text-sm hover:bg-surface-container transition-colors">Not now</button>`;
  document.body.appendChild(card);
  document.addEventListener('keydown', _onCardKey);
}

export function rebookDismiss() {
  document.getElementById('rebook-card')?.remove();
  document.removeEventListener('keydown', _onCardKey);
  _cardCandidate = null;
}

export function rebookBookNow() {
  const c = _cardCandidate;
  rebookDismiss();
  if (c) startRebook(c);
}

// ── Rebook mode: banner + navigate ───────────────────────────────────────────
export function startRebook({ name, phone }) {
  _pending = { name, phone: phone || '' };
  window.showDashPanel?.('calendar');
  renderRebookBanner();
}

export function cancelRebook() { _pending = null; renderRebookBanner(); }

// Clear rebook mode after a NEW appointment is saved (calendar.js gates on _apptEditId == null).
export function finishRebook() { if (_pending) { _pending = null; renderRebookBanner(); } }

// Show/hide the calendar banner from _pending. Called on every calendar render so it survives
// tab re-entry and live re-renders.
export function renderRebookBanner() {
  const banner = document.getElementById('rebook-banner');
  if (!banner) return;
  const nameEl = document.getElementById('rebook-banner-name');
  if (_pending) {
    if (nameEl) nameEl.textContent = _pending.name || 'this customer';
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}
