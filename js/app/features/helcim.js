// ── Helcim Smart Terminal payments (webhook-driven) ─────────────────────────
// The Worker holds the api-token and drives the terminal; the result returns via the
// /terminal/webhook receiver, which broadcasts a `helcim_result` envelope over the same
// WebSocket the app already holds (sync.js → window.onHelcimResult). chargeOnHelcim() starts
// a purchase and resolves when that broadcast lands — with a fallback poll of /helcim/result
// (covers a missed broadcast / briefly-disconnected socket) and a hard timeout.
import { getState } from '../store.js';
import { dispatch } from '../sync.js';
import { showToast, ticketTotal, localDateStr } from '../utils.js';
import { HELCIM_PROXY } from '../config.js';
import { getActiveUser } from '../session.js';
import { isPaidStatus } from './status.js';

const cfg = () => getState().config;
export function helcimDeviceCode() { return String(cfg().helcim_device_code || '').trim(); }

// Which processor the checkout charges cards on. Default 'square' until the operator flips it.
export function activeProcessor() { return cfg().payment_processor === 'helcim' ? 'helcim' : 'square'; }
export function helcimActive() { return activeProcessor() === 'helcim'; }

// Resolve a Helcim customerCode from a ticket's name+phone so the contact rides the purchase and
// the terminal can text/email the receipt. Best-effort — returns null on any failure (never blocks).
export async function helcimCustomerCode(name, phone) {
  if (!name && !phone) return null;
  try {
    const r = await fetch(`${HELCIM_PROXY}/customer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name || '', phone: phone || '' }) });
    const j = await r.json().catch(() => ({}));
    return j.customerCode || null;
  } catch { return null; }
}

// Refund a Helcim card transaction back to the card (via the Worker → Helcim refund API).
// amountDollars = the CARD portion to return (Helcim caps it at the original). opts.idempotencyKey
// MUST be deterministic for this refund intent (sale + txn + cents) so a retry can't double-refund.
// Returns { ok, transactionId, amount, error } — never throws.
export async function refundOnHelcim(originalTransactionId, amountDollars, opts = {}) {
  if (!originalTransactionId) return { ok: false, error: 'No Helcim transaction is on this sale.' };
  if (!(amountDollars > 0))   return { ok: false, error: 'Refund amount must be greater than zero.' };
  try {
    const r = await fetch(`${HELCIM_PROXY}/refund`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ originalTransactionId, amount: Number(amountDollars), idempotencyKey: opts.idempotencyKey || '' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) return { ok: false, error: j.error || `Refund failed (${r.status}).` };
    return { ok: true, transactionId: j.transactionId ? String(j.transactionId) : null, amount: j.amount };
  } catch (e) { try { window.reportError?.('helcim.refund', 'Could not reach the refund service: ' + ((e && e.message) || e), { serious: true }); } catch (x) {} return { ok: false, error: 'Could not reach the refund service.' }; }
}
export function setPaymentProcessor(p) {
  const v = p === 'helcim' ? 'helcim' : 'square';
  if (v === activeProcessor()) return;
  if (!['admin', 'manager'].includes(getActiveUser()?.role)) { showToast('Only an admin or manager can switch the card processor.'); return; }
  const ok = confirm(`Switch the card processor to ${v === 'helcim' ? 'HELCIM' : 'SQUARE'}?\n\nThis changes which terminal ALL card charges go to, on every device, immediately. Tickets already paid are not affected.`);
  if (!ok) return;
  dispatch('config.set', { key: 'payment_processor', value: v });
  showToast(v === 'helcim' ? 'Card processor set to Helcim ✓' : 'Card processor set to Square ✓');
  syncProcessorClass(); renderHelcimSettings();
}
// Toggle a body class so CSS can hide Square-only UI (the legacy POS deep-link) when Helcim is
// active. Called on boot, on every store change, and on flip — so it stays accurate cross-device.
export function syncProcessorClass() {
  try {
    document.body.classList.toggle('proc-helcim', helcimActive());
    const lbl = document.getElementById('reconcile-proc-label');
    if (lbl) lbl.textContent = helcimActive() ? 'Reconcile w/ Helcim' : 'Reconcile w/ Square';
  } catch {}
}

// invoiceNumber → { settle } resolver for an in-flight terminal charge.
const _pending = {};

function _normResult(status, transactionId, amount) {
  const s = String(status || '').toUpperCase();
  if (s === 'APPROVED') return { ok: true,  status: 'APPROVED',  transactionId: transactionId || null, amount };
  if (s === 'CANCELLED' || s === 'CANCELED') return { ok: false, status: 'CANCELLED', error: 'Cancelled on the terminal.' };
  if (s === 'DECLINED') return { ok: false, status: 'DECLINED', error: 'Card declined — try again.' };
  return null;   // unknown / still pending → ignore (keep waiting)
}

// Called by sync.js when the Worker broadcasts a terminal result.
export function onHelcimResult(msg) {
  const p = _pending[msg && msg.invoiceNumber]; if (!p) return;
  const res = _normResult(msg.status, msg.transactionId, msg.amount);
  if (res) p.settle(res);
}

// Start a terminal purchase; resolve when the result arrives. amountDollars = the FULL amount
// to charge (services + items + tip — tips are entered in-app, never on the device).
export async function chargeOnHelcim(amountDollars, invoiceNumber, opts = {}) {
  const deviceCode = helcimDeviceCode();
  if (!deviceCode)            return { ok: false, error: 'Set your terminal device code in Settings → Payments first.' };
  if (!(amountDollars > 0))   return { ok: false, error: 'Amount must be greater than zero.' };
  if (!invoiceNumber)         return { ok: false, error: 'Missing invoice reference.' };

  // Idempotency (Helcim's purchase call has no idempotency key): if a successful charge already
  // exists for this reference — e.g. a retry after a timeout where the first attempt DID go
  // through — return it instead of charging the card a second time.
  try {
    const r = await fetch(`${HELCIM_PROXY}/result?invoiceNumber=${encodeURIComponent(invoiceNumber)}`);
    const j = await r.json().catch(() => ({}));
    const prior = (j && Array.isArray(j.value)) ? j.value.find(t => String(t.status).toUpperCase() === 'APPROVED') : null;
    if (prior) return { ok: true, status: 'APPROVED', transactionId: prior.transactionId, amount: prior.amount, reused: true };
  } catch {}

  let start;
  try {
    const r = await fetch(`${HELCIM_PROXY}/purchase`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode, amount: Number(amountDollars), invoiceNumber, ...(opts.customerCode ? { customerCode: opts.customerCode } : {}) }),
    });
    start = await r.json().catch(() => ({}));
    if (r.status >= 400) return { ok: false, error: start.error || start.message || `Couldn't start the terminal (HTTP ${r.status}).` };
  } catch (e) { try { window.reportError?.('helcim.charge', 'Network error starting the terminal: ' + (e.message || e), { serious: true }); } catch (x) {} return { ok: false, error: 'Network error starting the terminal: ' + (e.message || e) }; }

  const TIMEOUT_MS = opts.timeoutMs || 180000;   // 3 min — customer is interacting with the device
  return await new Promise((resolve) => {
    let done = false, poll = null, hard = null;
    const finish = (res) => { if (done) return; done = true; clearInterval(poll); clearTimeout(hard); delete _pending[invoiceNumber]; resolve(res); };
    _pending[invoiceNumber] = { settle: (res) => res && finish(res) };
    poll = setInterval(async () => {
      try {
        const r = await fetch(`${HELCIM_PROXY}/result?invoiceNumber=${encodeURIComponent(invoiceNumber)}`);
        const j = await r.json().catch(() => ({}));
        const txn = (j && Array.isArray(j.value)) ? j.value[0] : null;
        if (txn) { const res = _normResult(txn.status, txn.transactionId, txn.amount); if (res) finish(res); }
      } catch {}
    }, 3000);
    hard = setTimeout(() => finish({ ok: false, status: 'TIMEOUT', error: 'Timed out — check the terminal and try again.' }), TIMEOUT_MS);
  });
}

// ── Settings → Payments (Helcim) panel ──────────────────────────────────────
export function renderHelcimSettings() {
  const el = document.getElementById('helcim-device-code'); if (el && document.activeElement !== el) el.value = helcimDeviceCode();
  const active = activeProcessor();
  const on  = 'flex-1 px-4 py-2 rounded-xl border font-body font-bold text-sm transition-colors bg-primary text-on-primary border-primary';
  const off = 'flex-1 px-4 py-2 rounded-xl border font-body font-bold text-sm transition-colors bg-surface-container-lowest text-on-surface border-surface-container-high';
  const sb = document.getElementById('helcim-proc-square'); if (sb) sb.className = active === 'square' ? on : off;
  const hb = document.getElementById('helcim-proc-helcim'); if (hb) hb.className = active === 'helcim' ? on : off;
  const st = document.getElementById('helcim-conn-status'); if (st && !st.dataset.touched) st.textContent = helcimDeviceCode() ? `Device ${helcimDeviceCode()} saved.` : 'No terminal device code set.';
}
export function helcimSaveDevice() {
  const v = String(document.getElementById('helcim-device-code')?.value || '').trim().toUpperCase();
  dispatch('config.set', { key: 'helcim_device_code', value: v });
  showToast(v ? `Terminal device ${v} saved ✓` : 'Device code cleared');
  const st = document.getElementById('helcim-conn-status'); if (st) { st.dataset.touched = ''; delete st.dataset.touched; st.textContent = v ? `Device ${v} saved.` : 'No terminal device code set.'; }
}
const _setStatus = (html) => { const st = document.getElementById('helcim-conn-status'); if (st) { st.dataset.touched = '1'; st.innerHTML = html; } };
export async function helcimCheckConnection() {
  _setStatus('Checking…');
  try {
    const r = await fetch(`${HELCIM_PROXY}/ping`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { _setStatus(`<span style="color:#c0392b">Connection failed (HTTP ${r.status}). Check the API token.</span>`); return; }
    const devices = Array.isArray(j) ? j : (Array.isArray(j.devices) ? j.devices : (Array.isArray(j.value) ? j.value : []));
    const codes = devices.map(d => String(d.code || d.deviceCode || d.id || '')).filter(Boolean);
    const want = helcimDeviceCode();
    const found = want && codes.some(c => c.toUpperCase() === want.toUpperCase());
    _setStatus(`<span style="color:#2a7a4f">Connected ✓</span> — terminals: ${codes.join(', ') || '(none returned)'}${want ? (found ? ` · device ${want} found ✓` : ` · <span style="color:#c0392b">device ${want} NOT in the list</span>`) : ''}`);
  } catch (e) { _setStatus(`<span style="color:#c0392b">Error: ${e.message || e}</span>`); }
}
export async function helcimRunTest() {
  if (!helcimDeviceCode()) { showToast('Set the device code first.'); return; }
  const inv = 'test-' + Date.now();
  _setStatus('Starting <b>$1.00</b> test charge — finish on the terminal…');
  showToast('Test charge started — complete it on the terminal');
  const res = await chargeOnHelcim(1, inv, { timeoutMs: 120000 });
  if (res.ok) _setStatus(`<span style="color:#2a7a4f">Test APPROVED ✓</span> — txn ${res.transactionId} ($${Number(res.amount || 1).toFixed(2)}). Refund it in your Helcim dashboard.`);
  else _setStatus(`<span style="color:#c0392b">Test not completed: ${res.error || res.status}</span>`);
}

// ── Webhook-miss safety net ──────────────────────────────────────────────────
// chargeOnHelcim stamps each purchase with invoiceNumber `tkt-<entryId>-<cents>`. If BOTH the
// result broadcast and the fallback poll miss (app closed/offline at the wrong moment), the charge
// succeeds but the ticket stays unpaid with no record — money taken, invisible. On load/focus we
// pull recent APPROVED charges and match their ticket id to a still-unpaid queue entry; a hit is
// offered for one-tap finalize. SAFE: the charge already exists, so this records it — never charges
// again. (Charges keyed manually on the terminal carry no `tkt-` invoice → handled by the admin
// "record without charging" flow instead.)
let _ucBusy = false, _ucLast = 0;
const _ucDismissed = new Set();
export async function checkUnfinalizedCharges() {
  if (!helcimActive() || !helcimDeviceCode()) return;
  if (_ucBusy || Date.now() - _ucLast < 60000) return;   // throttle: at most once a minute
  _ucBusy = true;
  try {
    const now = Date.now();
    const r = await fetch(`${HELCIM_PROXY}/transactions?dateFrom=${localDateStr(new Date(now - 2 * 86400000))}&dateTo=${localDateStr(new Date(now + 86400000))}`);
    if (!r.ok) return;
    const j = await r.json().catch(() => ({}));
    const arr = Array.isArray(j) ? j : (j.value || j.data || j.transactions || j.cardTransactions || []);
    const txns = arr.filter(t => String(t.type || '').toLowerCase().includes('purchase') && String(t.status || '').toUpperCase() === 'APPROVED');
    const q = getState().queue || [];
    const entryIdOf = inv => { const s = String(inv || ''); return s.startsWith('tkt-') ? s.slice(4).replace(/-\d+$/, '') : null; };   // strip the trailing -<cents>
    for (const t of txns) {
      const eid = entryIdOf(t.invoiceNumber); if (!eid || _ucDismissed.has(eid)) continue;
      const e = q.find(x => String(x.id) === eid);
      if (!e || isPaidStatus(e.status)) continue;                                          // already paid / gone
      if ((e.squarePaymentIds || []).map(String).includes(String(t.transactionId))) continue;   // already linked
      _promptUnfinalized(e, t);
      break;   // one prompt at a time
    }
  } catch {} finally { _ucBusy = false; _ucLast = Date.now(); }
}
function _promptUnfinalized(e, t) {
  const amt = (+t.amount || 0).toFixed(2);
  let when = ''; try { when = ' (' + new Date(t.dateCreated).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ')'; } catch {}
  window.showWarnModal?.(
    'Completed charge found — mark paid?',
    `A completed card charge of $${amt}${when} was found for ${e.name || 'this ticket'}, but the ticket isn't marked paid (the result was likely missed). Mark it paid now? This records the existing charge — it does NOT charge the card again.`,
    () => _finalizeFoundCharge(String(e.id), t),
    'Mark paid');
  // If the operator dismisses (X / Cancel), don't nag again this session for this ticket.
  _ucDismissed.add(String(e.id));
}
function _finalizeFoundCharge(entryId, t) {
  const q = getState().queue || [];
  const anchor = q.find(x => String(x.id) === String(entryId));
  if (!anchor || isPaidStatus(anchor.status)) return;
  const party = anchor.groupId ? q.filter(x => x.groupId === anchor.groupId) : [anchor];
  const billTotal = party.reduce((s, m) => s + ticketTotal(m), 0);
  party.forEach(m => {
    m.squarePaymentIds = [String(t.transactionId)];
    if (String(m.id) === String(entryId)) m.tenders = { card: billTotal };   // tender on the anchor (the bill; surcharge is Helcim-side)
    m.totalCost = ticketTotal(m);
    dispatch('queue.upsert', { entry: m });
    window.updateStatus?.(String(m.id), 'paid');   // → saveRecord: record + commission + audit
  });
  window.logAudit?.('Recovered charge', `${anchor.name || '—'} · $${(+t.amount || 0).toFixed(2)} · txn ${t.transactionId}`);
  showToast('Recorded the found charge — marked paid ✓');
}
