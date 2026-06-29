// ── SMS (httpSMS Android-phone gateway) ──────────────────────────────────────
// Texts are sent through the shop's Android phone (running the httpSMS app) via the
// Worker's /sms proxy, which holds the httpSMS API key + "from" number as secrets
// (HTTPSMS_API_KEY / HTTPSMS_FROM). The PWA never sees the key.
//
// Phase 1 (this file): sendSms() + the Settings "Text Messaging" test panel.
// Phase 2 will add appointment-confirmation texts; Phase 3 a two-way inbox.
import { SMS_PROXY } from '../config.js';
import { showToast } from '../utils.js';

// Low-level send. Resolves { ok, sent, to, id, error, status } — never throws (callers branch
// on .ok). NB: ok only means httpSMS ACCEPTED the message (queued to the phone); the phone can
// still fail to actually send it afterwards — use getSmsStatus(id) to learn the real outcome.
export async function sendSms(to, content) {
  try {
    const res = await fetch(`${SMS_PROXY}/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, content }),
    });
    const j = await res.json().catch(() => ({}));
    return { ok: res.ok && !!j.sent, status: res.status, ...j };
  } catch (e) {
    return { ok: false, status: 0, error: 'Could not reach the Worker' };
  }
}

// Real phone-side delivery status for a message id from sendSms(). Resolves
// { ok, status, failureReason }. status ∈ pending|scheduled|sending|sent|delivered|failed|expired.
export async function getSmsStatus(id) {
  try {
    const res = await fetch(`${SMS_PROXY}/message/${encodeURIComponent(id)}`, { cache: 'no-store' });
    const j = await res.json().catch(() => ({}));
    return { ok: res.ok, ...j };
  } catch (e) {
    return { ok: false, error: 'Could not reach the Worker' };
  }
}

// ── Settings → Integrations → Text Messaging ─────────────────────────────────
export async function renderSmsSettings() {
  const st = document.getElementById('sms-status'); if (!st) return;
  st.textContent = 'Checking…'; st.style.color = '';
  const res = document.getElementById('sms-test-result'); if (res) res.textContent = '';
  try {
    const r = await fetch(`${SMS_PROXY}/status`, { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (j.configured) { st.textContent = `✓ Connected — sending from ${j.from || 'the shop phone'}`; st.style.color = '#2a7a4f'; }
    else { st.textContent = 'Not set up yet — add HTTPSMS_API_KEY + HTTPSMS_FROM as Worker secrets, then deploy.'; st.style.color = '#c53030'; }
  } catch (e) { st.textContent = 'Could not reach the Worker to check status.'; st.style.color = '#c53030'; }
}

// Terminal httpSMS states — once reached, stop polling.
const _SMS_TERMINAL = { delivered: 1, sent: 1, failed: 1, expired: 1 };
function _smsStatusView(status, failureReason, to) {
  switch (status) {
    case 'delivered': return { txt: `✓ Delivered to ${to}`, color: '#2a7a4f' };
    case 'sent':      return { txt: `✓ The phone sent it to ${to} (handed to the carrier)`, color: '#2a7a4f' };
    case 'failed':    return { txt: `✗ The phone failed to send it: ${failureReason || 'generic failure'}`, color: '#c53030' };
    case 'expired':   return { txt: `✗ Expired — the phone never sent it`, color: '#c53030' };
    case 'sending':   return { txt: 'Phone is sending…', color: '' };
    case 'scheduled':
    case 'pending':   return { txt: 'Queued on the phone…', color: '' };
    default:          return { txt: `Status: ${status || 'unknown'}`, color: '' };
  }
}
// Poll the real phone-side outcome for ~20s, updating the result line live. This is what
// surfaces "generic failure" (or delivery) right in the dashboard.
async function _pollTestSmsStatus(id, to, out) {
  let everRead = false, lastStatus = '';
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, i === 0 ? 1500 : 2500));
    const s = await getSmsStatus(id);
    if (!s.ok || !s.status) continue;
    everRead = true; lastStatus = s.status;
    const view = _smsStatusView(s.status, s.failureReason, to);
    if (out) { out.textContent = view.txt; out.style.color = view.color; }
    if (_SMS_TERMINAL[s.status]) {
      window.logAudit?.('SMS', `Test text to ${to}: ${s.status}${s.failureReason ? ' (' + s.failureReason + ')' : ''}`);
      if (s.status === 'failed') showToast('Phone failed to send: ' + (s.failureReason || 'generic failure'));
      else if (s.status === 'expired') showToast('SMS expired — the phone never sent it');
      return;
    }
  }
  // Never got a readable status → the lookup endpoint isn't answering (most likely the Worker
  // hasn't been redeployed with /sms/message). Don't blame the phone for a missing endpoint.
  if (out) {
    if (!everRead) { out.textContent = "Sent to httpSMS, but couldn't read the delivery status — the Worker needs `wrangler deploy` for the status check. (The text may still have gone through; check the httpSMS app.)"; out.style.color = '#9a6a00'; }
    else { out.textContent = `Handed to httpSMS — still "${lastStatus}" after 20s; the phone hasn't completed it. Check the httpSMS app for the final status.`; out.style.color = '#9a6a00'; }
  }
}

export async function sendTestSms() {
  const to = document.getElementById('sms-test-to')?.value || '';
  const content = (document.getElementById('sms-test-msg')?.value || '').trim();
  const out = document.getElementById('sms-test-result');
  if (!to.replace(/\D/g, '')) { showToast('Enter a phone number to text'); return; }
  if (!content) { showToast('Enter a message'); return; }
  if (out) { out.textContent = 'Sending…'; out.style.color = ''; }
  const btn = document.getElementById('sms-test-btn'); if (btn) btn.disabled = true;
  const r = await sendSms(to, content);
  if (r.ok) {
    if (out) { out.textContent = 'Accepted by httpSMS — checking the phone…'; out.style.color = ''; }
    window.logAudit?.('SMS', `Test text queued to ${r.to || to}`);
    if (r.id) await _pollTestSmsStatus(r.id, r.to || to, out);
    else if (out) { out.textContent = `✓ Handed to httpSMS (couldn't track delivery) — check the phone`; out.style.color = '#2a7a4f'; }
  } else {
    const msg = r.error || (r.status === 503 ? 'Not configured (set Worker secrets + deploy)' : 'Send failed');
    if (out) { out.textContent = '✗ ' + msg; out.style.color = '#c53030'; }
    showToast('SMS: ' + msg);
  }
  if (btn) btn.disabled = false;
}
