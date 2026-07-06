// ── diagnostics.js — Settings → Diagnostics (error log + bug-alert opt-in) ────
// The viewing end of the reporter (js/app/reporter.js): shows the errors the server
// captured (deduped, newest first) so the owner can see what failed even when they
// didn't notice it live, and lets a device opt in to a push the moment something breaks.
import { REPORT_PROXY, PUSH_PROXY, VAPID_PUBLIC_KEY } from '../config.js';
import { showToast } from '../utils.js';

const _esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const _ago = ms => {
  if (!ms) return '—';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
};

function urlB64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const base = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const _alertsOn = () => { try { return localStorage.getItem('turndesk_error_alerts') === '1'; } catch (e) { return false; } };

// ── Bug-alert push opt-in (this device) ───────────────────────────────────────
// Registers the device's push subscription under the shared 'errors' id, which the
// Worker's /report handler pushes to on a new/serious error. Uses the same push
// machinery as chat/assignments; unsubscribing only drops the 'errors' link.
export async function enableBugAlerts() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { showToast('This device can’t receive push notifications'); return; }
    if (Notification.permission === 'denied') { showToast('Notifications are blocked — turn them on in the browser/site settings, then try again'); return; }
    let perm = Notification.permission;
    if (perm !== 'granted') { try { perm = await Notification.requestPermission(); } catch (e) {} }
    if (perm !== 'granted') { showToast('Notifications not turned on'); return; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(VAPID_PUBLIC_KEY) });
    const r = await fetch(PUSH_PROXY + '/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ techId: 'errors', subscription: sub.toJSON() }) });
    if (r.ok) { try { localStorage.setItem('turndesk_error_alerts', '1'); } catch (e) {} showToast('Bug alerts on for this device ✓'); renderDiagnostics(); }
    else showToast('Allowed, but couldn’t reach the server — try again');
  } catch (e) { showToast('Couldn’t turn on bug alerts — try again'); }
}
export async function disableBugAlerts() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await fetch(PUSH_PROXY + '/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ techId: 'errors', endpoint: sub.endpoint }) });
  } catch (e) {}
  try { localStorage.removeItem('turndesk_error_alerts'); } catch (e) {}
  showToast('Bug alerts off for this device'); renderDiagnostics();
}

export async function clearDiagnostics() {
  if (!window.confirm('Clear the whole error log? This only clears the saved reports — it does not affect any data.')) return;
  try {
    const r = await fetch(REPORT_PROXY + '/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    showToast(r.ok ? 'Error log cleared' : 'Couldn’t clear — try again');
  } catch (e) { showToast('Couldn’t clear — try again'); }
  renderDiagnostics();
}

export function toggleDiagStack(fp) {
  try { const d = document.getElementById('diagstack-' + fp); if (d) d.classList.toggle('hidden'); } catch (e) {}
}

// ── Render ────────────────────────────────────────────────────────────────────
export async function renderDiagnostics() {
  const el = document.getElementById('diagnostics-content');
  if (!el) return;
  el.innerHTML = '<div class="text-sm font-body text-on-surface-variant py-3 opacity-70">Loading…</div>';

  let errors = [];
  try {
    const r = await fetch(REPORT_PROXY, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(String(r.status));
    errors = (await r.json()).errors || [];
  } catch (e) {
    el.innerHTML = '<div class="text-sm font-body text-error py-3">Couldn’t load the error log (offline, or the server is unreachable). Try again in a moment.</div>';
    return;
  }

  const on = _alertsOn();
  const alertCard = `<div class="bg-surface-container rounded-xl px-4 py-3 mb-4 border border-surface-container-high flex items-center justify-between gap-3">
    <div class="min-w-0">
      <div class="font-headline font-semibold text-on-surface text-sm">Bug alerts on this device</div>
      <div class="text-[11px] font-body text-on-surface-variant mt-0.5">${on ? 'On — you’ll get a push here when something new or serious fails.' : 'Get a push notification the moment something fails (deduped so one bug can’t spam you).'}</div>
    </div>
    ${on
      ? `<button onclick="disableBugAlerts()" class="flex-shrink-0 px-3 py-1.5 rounded-lg border border-surface-container-high text-on-surface-variant text-xs font-body font-semibold">Turn off</button>`
      : `<button onclick="enableBugAlerts()" class="flex-shrink-0 px-3 py-1.5 rounded-lg bg-primary text-on-primary text-xs font-body font-semibold flex items-center gap-1"><span class="material-symbols-outlined" style="font-size:15px">notifications_active</span> Turn on</button>`}
  </div>`;

  const header = `<div class="flex items-center justify-between gap-2 mb-3">
    <div class="text-[11px] font-body font-semibold text-outline uppercase tracking-widest">Recent failures ${errors.length ? `· ${errors.length}` : ''}</div>
    <div class="flex gap-2">
      <button onclick="renderDiagnostics()" class="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-body font-semibold"><span class="material-symbols-outlined" style="font-size:15px">refresh</span> Refresh</button>
      ${errors.length ? `<button onclick="clearDiagnostics()" class="px-3 py-1.5 rounded-lg border border-surface-container-high text-on-surface-variant text-xs font-body font-semibold">Clear</button>` : ''}
    </div>
  </div>`;

  if (!errors.length) {
    el.innerHTML = alertCard + header + '<div class="text-sm font-body text-on-surface-variant py-3 opacity-70">No errors logged. 🎉 If something misbehaves, it will show up here (and push you if alerts are on).</div>';
    return;
  }

  const list = errors.map(e => {
    const fp = _esc(e.fingerprint || Math.random().toString(36).slice(2));
    const times = e.count > 1 ? `${e.count}×` : '1×';
    const border = e.serious ? 'border-error/50' : 'border-surface-container-high';
    const crumbs = (e.breadcrumbs || []).length ? `<div class="text-[10px] font-mono text-on-surface-variant mt-2 whitespace-pre-wrap opacity-80">${_esc((e.breadcrumbs || []).join('\n'))}</div>` : '';
    return `<div class="bg-surface-container rounded-xl px-4 py-3 mb-1.5 border ${border}">
      <div class="flex items-center justify-between gap-2 mb-1">
        <div class="min-w-0"><span class="font-headline font-semibold text-on-surface text-sm break-words">${e.serious ? '⚠️ ' : ''}${_esc(e.context || 'error')}</span></div>
        <span class="text-[11px] text-outline flex-shrink-0 whitespace-nowrap">${times} · ${_ago(e.lastAt)}</span>
      </div>
      <div class="text-xs font-body text-on-surface mb-1 break-words">${_esc(e.message || '')}</div>
      <div class="text-[11px] font-body text-on-surface-variant">${_esc(e.version || '')}${e.view ? ' · ' + _esc(e.view) : ''}${e.user ? ' · ' + _esc(e.user) : ''}${e.online === false ? ' · offline' : ''}</div>
      ${(e.stack || crumbs) ? `<button onclick="toggleDiagStack('${fp}')" class="text-[11px] font-body text-primary font-semibold mt-1.5">Details ▾</button>
      <div id="diagstack-${fp}" class="hidden mt-1">
        ${e.stack ? `<pre class="text-[10px] font-mono text-on-surface-variant whitespace-pre-wrap break-words max-h-48 overflow-auto bg-surface-container-lowest rounded-lg p-2 border border-surface-container-high">${_esc(e.stack)}</pre>` : ''}
        ${crumbs}
        <div class="text-[10px] font-body text-outline mt-1">${_esc(e.device || '')}${e.ua ? ' · ' + _esc(e.ua) : ''}</div>
      </div>` : ''}
    </div>`;
  }).join('');

  el.innerHTML = alertCard + header + list;
}
