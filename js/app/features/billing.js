// ── Billing — the salon's TurnDesk subscription (Settings → Business → Billing) ──
// Phase 1: built but hidden behind the operator-controlled selfserveBillingEnabled
// flag — while it's off (the beta default) this section does not exist anywhere in
// the UI, honoring the live pricing-page promise ("no card on file to charge").
// Server routes are stricter than the general app gate: owner/admin session required
// unconditionally, the platform operator's master login (appadmin) denied.
// Payment capture is HelcimPay.js "verify" mode — card or bank details go straight
// to Helcim's iframe; this app never sees or stores raw numbers.
import { BILLING_PROXY } from '../config.js';
import { getSessionUser } from '../apptoken.js';
import { showToast, escHtml } from '../utils.js';

let _flags = null;          // last-fetched { selfserveBillingEnabled } — null until known
let _status = null;         // last-fetched { account, plans, achAuthText }

// Pure visibility rule (unit-tested): the section exists only when the operator flag
// is on AND the signed-in session is the owner or an admin — never the appadmin.
export function canSeeBilling(session, flags) {
  if (!flags || flags.selfserveBillingEnabled !== true) return false;
  if (!session || session.kind === 'appadmin') return false;
  return session.kind === 'owner' || session.role === 'admin';
}

export function billingVisible() {
  return canSeeBilling(getSessionUser(), _flags);
}

// Fire-and-forget flag refresh (called when Settings opens). A 401 (non-admin
// session) or network failure just leaves the section hidden — never an error.
export async function refreshBillingFlags() {
  try {
    const r = await fetch(BILLING_PROXY + '/status');
    if (!r.ok) { _flags = { selfserveBillingEnabled: false }; return; }
    const b = await r.json();
    _flags = b.flags || { selfserveBillingEnabled: false };
    _status = b;
  } catch { /* stay hidden on failure */ }
}

const money = c => c == null ? '—' : '$' + (c / 100).toFixed(2);
const histLine = h => {
  const when = typeof h.at === 'number' ? new Date(h.at).toLocaleDateString() : (h.at || '');
  if (h.event === 'payment') return `${when} — payment ${money(h.amountCents)}${h.failureReason ? ' · <span class="text-red-700">' + escHtml(h.failureReason) + '</span>' : ''}`;
  return `${when} — ${escHtml(h.event)}${h.note ? ' · ' + escHtml(h.note) : ''}`;
};

export async function renderBillingSettings() {
  const el = document.getElementById('billing-section');
  if (!el) return;
  el.innerHTML = '<p class="text-sm font-body text-on-surface-variant">Loading…</p>';
  let b = null;
  try {
    const r = await fetch(BILLING_PROXY + '/status?sync=1');
    if (r.ok) b = await r.json();
  } catch {}
  if (!b) { el.innerHTML = '<p class="text-sm font-body text-on-surface-variant">Billing isn’t available for this sign-in.</p>'; return; }
  _flags = b.flags; _status = b;
  const a = b.account;
  const planCards = (b.plans || []).map(p => `
    <div class="rounded-xl border ${a && a.planId === p.planId ? 'border-primary bg-primary/5' : 'border-surface-container-high bg-surface-container-lowest'} p-4 flex flex-col gap-1">
      <div class="flex items-baseline justify-between"><span class="font-headline font-bold">${escHtml(p.name)}</span><span class="font-headline font-extrabold">${p.priceCents === 0 ? '$0' : money(p.priceCents) + '/mo'}</span></div>
      <div class="text-xs font-body text-on-surface-variant">${p.capacity && p.capacity.maxStaffAccounts != null ? 'Up to ' + p.capacity.maxStaffAccounts + ' techs' : 'Unlimited techs'}${p.features && p.features.sms && p.features.sms.included ? ' · texting ' + (p.features.sms.monthlyLimit == null ? 'unlimited' : p.features.sms.monthlyLimit + '/mo') : ''}</div>
      ${a && a.planId === p.planId ? '<div class="text-xs font-body font-semibold text-primary mt-1">Current plan</div>'
        : `<button onclick="billingChoosePlan('${escHtml(p.planId)}')" class="mt-2 text-sm font-headline font-semibold text-primary border border-primary rounded-lg px-3 py-1.5 self-start">Choose ${escHtml(p.name)}</button>`}
    </div>`).join('');
  const statusLine = !a ? 'No billing set up yet — pick a plan below to get started.'
    : a.status === 'trialing' && !a.trialEndsAt ? 'Set up — nothing is billing yet.'
    : a.status === 'trialing' ? 'Free trial until ' + new Date(a.trialEndsAt).toLocaleDateString()
    : a.status === 'comped' ? 'Complimentary until ' + (a.compUntil ? new Date(a.compUntil).toLocaleDateString() : '—')
    : a.status === 'active' ? 'Active' + (a.currentPeriodEnd ? ' — next bill ' + escHtml(String(a.currentPeriodEnd)) : '')
    : a.status === 'past_due' ? 'Payment problem' + (a.lastFailureReason ? ' — ' + escHtml(a.lastFailureReason) : '')
    : escHtml(a.status);
  el.innerHTML = `
    <div class="space-y-4">
      <div class="rounded-xl border border-surface-container-high bg-surface-container-lowest p-4">
        <div class="font-headline font-bold mb-1">Subscription</div>
        <div class="text-sm font-body">${statusLine}</div>
        <div class="text-xs font-body text-on-surface-variant mt-1">Payment method: ${a && a.paymentMethodType ? (a.paymentMethodType === 'ach' ? 'bank account' : 'card') + ' on file' : 'none yet'}</div>
        <div class="flex gap-2 mt-3 flex-wrap">
          <button onclick="billingAddPayment(false)" class="text-sm font-headline font-semibold text-on-primary bg-primary rounded-lg px-3 py-1.5">${a && a.paymentMethodType ? 'Update card' : 'Add card'}</button>
          <button onclick="billingAddPayment(true)" class="text-sm font-headline font-semibold text-primary border border-primary rounded-lg px-3 py-1.5">${a && a.paymentMethodType === 'ach' ? 'Update bank account' : 'Use bank account (ACH)'}</button>
        </div>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">${planCards}</div>
      ${a && (a.history || []).length ? `<div class="rounded-xl border border-surface-container-high bg-surface-container-lowest p-4">
        <div class="font-headline font-bold mb-2">History</div>
        <div class="text-xs font-body text-on-surface-variant space-y-1">${a.history.slice(-12).reverse().map(h => '<div>' + histLine(h) + '</div>').join('')}</div>
      </div>` : ''}
    </div>`;
}

export async function billingChoosePlan(planId) {
  const plan = (_status && _status.plans || []).find(p => p.planId === planId);
  if (!plan) return;
  const already = _status && _status.account && _status.account.helcimSubscriptionId;
  const msg = already
    ? `Switch to ${plan.name} (${money(plan.priceCents)}/mo)? The change takes effect at your next billing date.`
    : `Subscribe to ${plan.name} at ${money(plan.priceCents)}/mo? Your saved payment method will be billed monthly.`;
  if (!confirm(msg)) return;
  try {
    const r = await fetch(BILLING_PROXY + '/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planId }) });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) { showToast(b.error || 'Could not subscribe'); return; }
    showToast(already ? 'Plan change saved' : 'Subscribed');
    renderBillingSettings();
  } catch { showToast('Could not subscribe'); }
}

// Card/bank capture via HelcimPay.js verify mode. For ACH, the NACHA recurring-debit
// authorization is shown and must be accepted (recorded server-side with a timestamp
// and wording version) BEFORE the bank form opens.
export async function billingAddPayment(ach) {
  if (ach) {
    const text = (_status && _status.achAuthText && _status.achAuthText.text) || '';
    if (!confirm('Bank (ACH) authorization:\n\n' + text + '\n\nDo you agree?')) return;
    const r = await fetch(BILLING_PROXY + '/ach-authorize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ textVersion: _status && _status.achAuthText && _status.achAuthText.version }) });
    if (!r.ok) { showToast('Could not record the authorization'); return; }
  }
  let tokenResp = null;
  try {
    const r = await fetch(BILLING_PROXY + '/portal-token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ach: !!ach }) });
    tokenResp = r.ok ? await r.json() : null;
    if (!tokenResp) { const b = await r.json().catch(() => ({})); showToast(b.error || 'Could not start the secure form'); return; }
  } catch { showToast('Could not start the secure form'); return; }
  const checkoutToken = tokenResp.checkoutToken;
  try { await _loadHelcimPay(); } catch { showToast('Could not load the secure payment form'); return; }
  window.appendHelcimPayIframe(checkoutToken);
  const key = 'helcim-pay-js-' + checkoutToken;
  const onMsg = async (event) => {
    if (!event.data || event.data.eventName !== key) return;
    if (event.data.eventStatus === 'ABORTED') { window.removeEventListener('message', onMsg); return; }
    if (event.data.eventStatus !== 'SUCCESS') return;
    window.removeEventListener('message', onMsg);
    const m = event.data.eventMessage || {};
    const raw = typeof m.data === 'string' ? m.data : JSON.stringify(m.data ?? m);
    try {
      const r = await fetch(BILLING_PROXY + '/verify-complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checkoutToken, rawDataResponse: raw, hash: m.hash || (m.data && m.data.hash) || '' }) });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) { showToast(b.error || 'Payment method could not be verified'); return; }
      showToast(ach ? 'Bank account saved' : 'Card saved');
      renderBillingSettings();
    } catch { showToast('Payment method could not be verified'); }
  };
  window.addEventListener('message', onMsg);
}

let _helcimPayLoading = null;
function _loadHelcimPay() {
  if (window.appendHelcimPayIframe) return Promise.resolve();
  if (_helcimPayLoading) return _helcimPayLoading;
  _helcimPayLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://secure.helcim.app/helcim-pay/services/start.js';
    s.onload = resolve; s.onerror = () => { _helcimPayLoading = null; reject(new Error('load failed')); };
    document.head.appendChild(s);
  });
  return _helcimPayLoading;
}
