// ── Service waiver (check-in acknowledgment) ─────────────────────────────────
// Gates check-in behind a required liability/informed-consent acceptance and stores each
// acceptance as a durable, non-broadcast legal record (waiver.save → DO key waiver:<id>).
// Shared by the check-in entry points via window.waiverGate(entries, onCleared).
import { getState } from '../store.js';
import { dispatch, DEVICE_ID } from '../sync.js';
import { STATE_PROXY, PHOTOS_PROXY } from '../config.js';
import { showToast, escHtml } from '../utils.js';
import { salonSlug } from '../apptoken.js';   // R2 keys are per-salon namespaced (the /photos guard rejects a bare key)
import { canDo } from '../session.js';
import { notePhoneKey } from './square-customers.js';
import { waiverActive, buildWaiverRecord, newWaiverId, textHash } from '../waiver-util.js';

const cfg = () => getState().config || {};

// Generic starter waiver shipped as the "TurnDesk Template" — NOT auto-applied. An admin loads it
// into the editor, reviews/edits it for their salon + jurisdiction, and Saves (which activates +
// versions it). Uses "The Salon" as a stand-in for the business name. Replace this with reviewed,
// salon-appropriate wording before relying on it — it is a starting point, not legal advice.
const TURNDESK_WAIVER_TEMPLATE = `THE SALON — SERVICE WAIVER & INFORMED CONSENT

Please read this waiver carefully before your service. By checking the acknowledgment box at check-in you agree to the following.

1. Informed consent. I am requesting cosmetic salon services (which may include manicures, pedicures, gel or enhancement products, waxing, and related services) from The Salon and its technicians. I understand the general nature of these services.

2. Health disclosure. I confirm that I have disclosed any medical conditions, allergies, sensitivities, infections, injuries, or open wounds that could affect my service or be affected by it. I will tell my technician if I experience discomfort at any time.

3. Assumption of risk. I understand that salon services carry inherent risks, including but not limited to irritation, allergic reaction, infection, or minor injury, even when reasonable care is taken. I voluntarily assume these risks.

4. Release. To the fullest extent permitted by law, I release The Salon, its owners, and its staff from liability for ordinary risks associated with the services I have requested. This does not waive any right I cannot waive by law.

5. Photos / marketing (optional). Separate from this waiver, The Salon may ask for my permission to use photos of my service for marketing. That is optional and I may decline.

6. Truthful information. The information I provided at check-in is accurate to the best of my knowledge.

Checking the acknowledgment box is my electronic signature, using the name I provide at check-in, and legally binds me to the same extent as my full legal name even if it is not my full legal name.`;

const primaryDisplay = entry => { const p = String((entry && entry.name) || '').trim().split(/\s+/); return p[1] ? `${p[0]} ${p[1][0]}.` : (p[0] || ''); };
function primaryFields(entry) {
  const parts = String((entry && entry.name) || '').trim().split(/\s+/);
  const phone = (entry && entry.phone) || '';
  const pk = notePhoneKey(phone);
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' '), phone, phoneKey: pk, customerId: pk ? 'cust-' + pk : null };
}

// Build + persist ONE acceptance for the party (signed by the primary). Called on EVERY
// check-in — every visit requires acceptance. Returns { id, version, at }.
function saveWaiverRecord(entries, opts = {}) {
  const c = cfg();
  const now = Date.now();
  // opts.id lets the handoff pass a deterministic id (wv-<nonce>) so a re-Confirm/replay
  // overwrites the SAME waiver key instead of minting a duplicate (idempotency).
  const id = opts.id || newWaiverId(now, Math.random().toString(36).slice(2, 10));
  const rec = buildWaiverRecord({
    id, now, primary: primaryFields(entries[0] || {}),
    guests: (entries || []).map(e => ({ name: e.name, phoneKey: notePhoneKey(e.phone) || null })),
    waiverVersion: c.waiver_version,
    source: c.waiver_source || 'text', text: c.waiver_text,
    pdfUrl: c.waiver_pdf_url, pdfHash: c.waiver_pdf_hash, pdfName: c.waiver_pdf_name,
    method: opts.method || 'self-kiosk', deviceId: DEVICE_ID, byUser: opts.byUser || null,
    optIns: opts.optIns || {}, bypassed: !!opts.bypassed,
  });
  dispatch('waiver.save', { waiver: rec });
  const nGuests = (entries || []).length;
  if (opts.bypassed) window.logAudit?.('Waiver bypassed', `${rec.signerDisplay} — ${rec.method} by ${opts.byUser || 'staff'}${nGuests > 1 ? ` (${nGuests} guests)` : ''}`);
  else window.logAudit?.('Waiver accepted', `${rec.signerDisplay} accepted v${c.waiver_version}${nGuests > 1 ? ` for ${nGuests} guests` : ''}`);
  return { id, version: c.waiver_version, at: now };
}

// Exported save→stamp for the front-desk → kiosk handoff (and its bypass/take-over paths).
// waiver.js stays the sole owner of the save+stamp+audit sequence; callers pass opts:
//   { method, byUser, id, bypassed }. Mutates entries in place with the waiver link, then the
//   caller dispatches queue.upsert. Returns { id, version, at }. (Unused until port #6.)
export function acceptWaiverForHandoff(entries, opts = {}) {
  const s = saveWaiverRecord(entries, opts);
  stampEntriesWaiver(entries, s.id, s.version, s.at);
  return s;
}

// Stamp the per-visit waiver link onto each queue entry (mutates in place) so the visit is
// provably signed — surfaced in the customer directory + visit history.
export function stampEntriesWaiver(entries, waiverId, version, at) {
  for (const e of (entries || [])) { e.waiverId = waiverId; e.waiverVersion = version; e.waiverAt = at; }
}

// ── The gate (modal — appointment + front-desk paths keep this) ────────────────
// Every visit requires acceptance when active. On accept it stamps the passed-in entries
// (mutated in place) and calls onCleared() — the caller re-dispatches those stamped entries.
export function waiverGate(entries, onCleared, opts = {}) {
  if (!waiverActive(cfg())) return false;
  showWaiverModal(entries, onCleared, opts);
  return true;
}

// Designated-kiosk check — mirrors the time-clock device lock. (Used by port #6.)
export function isKioskDevice() {
  const id = (cfg().kiosk_device_id || '').trim();
  return !!id && id === DEVICE_ID;
}

// ── Inline acknowledgment (kiosk check-in screen) ──────────────────────────────
// The checkbox lives inline on the check-in screen (always visible when active), with the
// Read-the-full-waiver link. Check In stays disabled until it's checked (see checkin.js).
export function renderCheckinWaiver() {
  const host = document.getElementById('checkin-waiver-inline');
  if (!host) return;
  if (!waiverActive(cfg())) { host.innerHTML = ''; return; }
  host.innerHTML = `
    <div style="background:var(--surface-container-lowest,#fff);border:1px solid var(--outline,#d4d7e0);border-radius:12px;padding:9px 12px;margin-bottom:10px">
      <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer">
        <input type="checkbox" id="ci-waiver-accept" onchange="updateCheckinSubmitState()" style="width:20px;height:20px;flex-shrink:0;margin-top:1px;accent-color:var(--primary,#1a5252)">
        <span style="font-size:11.5px;line-height:1.45;color:var(--on-surface,#1a1d27)">I have read and agree to the <a href="#" onclick="showWaiverDoc();return false" style="color:var(--primary,#1a5252);font-weight:700;text-decoration:underline">service waiver</a>. Checking this box is my electronic signature; the name I provide represents me and binds me even if it is not my full legal name.</span>
      </label>
    </div>`;
}
export function checkinWaiverAccepted() {
  return !waiverActive(cfg()) || !!document.getElementById('ci-waiver-accept')?.checked;
}
// Kiosk submit calls this: persist the acceptance + stamp the entries. Returns false only if
// the box isn't checked (submitCheckin already gates the button, so this is a safety net).
export function acceptWaiverInline(entries, opts = {}) {
  if (!waiverActive(cfg())) return true;
  if (!document.getElementById('ci-waiver-accept')?.checked) return false;
  const s = saveWaiverRecord(entries, { method: 'self-kiosk', ...opts });
  stampEntriesWaiver(entries, s.id, s.version, s.at);
  return true;
}
// Show the CURRENT active waiver (what a customer reads before signing) — PDF or text.
export function showWaiverDoc() {
  const c = cfg();
  if ((c.waiver_source || 'text') === 'pdf' && c.waiver_pdf_url) showWaiverPdf(c.waiver_pdf_url, c.waiver_pdf_name);
  else showWaiverText(c.waiver_text);
}

// Open a specific SIGNED waiver by id (from a visit-history badge) — reproduces exactly what
// that person signed. Gated by the viewWaivers permission (the server also 403s the endpoint).
export async function openSignedWaiver(id) {
  if (!canDo('viewWaivers')) { showToast('You don’t have permission to view signed waivers.'); return; }
  showWaiverText('Loading the signed waiver…');
  try {
    const r = await fetch(STATE_PROXY + '/waivers', { method: 'GET' });
    if (r.status === 403) { document.getElementById('waiver-text-modal')?.remove(); showToast('You don’t have permission to view signed waivers.'); return; }
    const list = (await r.json()).waivers || [];
    const w = list.find(x => x.id === id);
    document.getElementById('waiver-text-modal')?.remove();
    if (!w) { showToast('That signed waiver was not found.'); return; }
    if (w.source === 'pdf' && w.pdfUrl) { showWaiverPdf(w.pdfUrl, w.pdfName); return; }
    const header = `Signed by ${w.signerDisplay || w.signerFullName || ''} · v${w.waiverVersion || ''} · ${(() => { try { return new Date(w.acceptedAt).toLocaleString(); } catch { return ''; } })()}\n${'─'.repeat(28)}\n\n`;
    showWaiverText(header + (w.text || '(no text stored on this record)'));
  } catch (e) {
    document.getElementById('waiver-text-modal')?.remove();
    showToast('Couldn’t load the signed waiver — check the connection.');
  }
}

function showWaiverPdf(url, name) {
  document.getElementById('waiver-text-modal')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'waiver-text-modal';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483450;display:flex;align-items:center;justify-content:center;background:rgba(20,22,30,.6);padding:16px';
  overlay.innerHTML = `
    <div style="background:var(--surface,#fff);border-radius:16px;max-width:760px;width:100%;height:88vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.32)">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--outline,#e5e7eb)">
        <span style="font-size:15px;font-weight:800;color:var(--on-surface,#1a1d27)">Service waiver${name ? ' · ' + escHtml(name) : ''}</span>
        <button id="wvt-close" aria-label="Close" style="width:32px;height:32px;border:0;border-radius:50%;background:var(--surface-container,#f1f0f4);cursor:pointer;font-size:18px">✕</button>
      </div>
      <iframe src="${escHtml(url)}#toolbar=1" style="flex:1;width:100%;border:0" title="Service waiver PDF"></iframe>
      <div style="padding:10px 16px;border-top:1px solid var(--outline,#e5e7eb);display:flex;gap:8px;align-items:center;justify-content:space-between">
        <a href="${escHtml(url)}" target="_blank" rel="noopener" style="font-size:13px;color:var(--primary,#1a5252);font-weight:600">Open in a new tab</a>
        <button id="wvt-done" style="padding:10px 18px;border:0;border-radius:11px;background:var(--primary,#1a5252);color:#fff;font-size:15px;font-weight:700;cursor:pointer">Close</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#wvt-close').addEventListener('click', close);
  overlay.querySelector('#wvt-done').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
}

// ── Modal ────────────────────────────────────────────────────────────────────
function showWaiverModal(entries, onCleared, opts) {
  closeWaiverModal();
  const display = primaryDisplay(entries[0]);
  const partyLine = entries.length > 1 ? `<div style="font-size:13px;color:var(--on-surface-variant,#5b606e);margin-bottom:10px">This applies to all guests in this check-in: ${escHtml(entries.map(e => e.name).join(', '))}.</div>` : '';

  const overlay = document.createElement('div');
  overlay.id = 'waiver-modal';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483400;display:flex;align-items:center;justify-content:center;background:rgba(20,22,30,.55);padding:16px';
  overlay.innerHTML = `
    <div style="background:var(--surface,#fff);border-radius:18px;max-width:460px;width:100%;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.32)">
      <div style="padding:20px 22px 6px">
        <div style="font-size:21px;font-weight:800;color:var(--on-surface,#1a1d27)">One last step</div>
        <div style="font-size:14px;color:var(--on-surface-variant,#5b606e);margin-top:2px">Please review and accept our service waiver to finish checking in.</div>
      </div>
      <div style="padding:8px 22px 0">
        <button id="wv-read" style="width:100%;display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border:1px solid var(--outline,#d4d7e0);border-radius:12px;background:transparent;color:var(--primary,#1a5252);font-size:15px;font-weight:700;cursor:pointer">
          <span>Read the full waiver</span><span aria-hidden="true">›</span>
        </button>
      </div>
      <div style="padding:16px 22px 4px;overflow-y:auto">
        ${partyLine}
        <label id="wv-accept-row" style="display:flex;gap:12px;align-items:flex-start;padding:14px;border:2px solid var(--primary,#1a5252);border-radius:14px;background:var(--primary-container,#e1f5ee);cursor:pointer">
          <input type="checkbox" id="wv-accept" style="width:22px;height:22px;flex-shrink:0;margin-top:1px;accent-color:var(--primary,#1a5252)">
          <span style="font-size:13.5px;line-height:1.5;color:var(--on-primary-container,#0a2e2e)">I have read and agree to the entire waiver. Checking this box is my electronic signature, using the name I provided at check-in, which represents me and legally binds me to the same extent as my full legal name even if it is not my full legal name.
            <span style="display:block;margin-top:6px;font-weight:700;color:var(--on-primary-container,#0a2e2e)">Signing as: ${escHtml(display)}</span>
          </span>
        </label>
      </div>
      <div style="padding:14px 22px 18px">
        <button id="wv-complete" disabled style="width:100%;padding:15px;border:0;border-radius:13px;background:var(--primary,#1a5252);color:#fff;font-size:16px;font-weight:800;cursor:not-allowed;opacity:.45">Complete check-in</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const accept = overlay.querySelector('#wv-accept');
  const complete = overlay.querySelector('#wv-complete');
  accept.addEventListener('change', () => { complete.disabled = !accept.checked; complete.style.opacity = accept.checked ? '1' : '.45'; complete.style.cursor = accept.checked ? 'pointer' : 'not-allowed'; });
  overlay.querySelector('#wv-read').addEventListener('click', () => showWaiverDoc());
  complete.addEventListener('click', () => {
    if (!accept.checked) return;
    const s = saveWaiverRecord(entries, opts);
    stampEntriesWaiver(entries, s.id, s.version, s.at);
    closeWaiverModal();
    if (typeof onCleared === 'function') onCleared();
  });
}

export function closeWaiverModal() { document.getElementById('waiver-modal')?.remove(); }

function showWaiverText(text) {
  if (document.getElementById('waiver-text-modal')) return;
  const overlay = document.createElement('div');
  overlay.id = 'waiver-text-modal';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483450;display:flex;align-items:center;justify-content:center;background:rgba(20,22,30,.55);padding:16px';
  overlay.innerHTML = `
    <div style="background:var(--surface,#fff);border-radius:16px;max-width:520px;width:100%;max-height:88vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.32)">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--outline,#e5e7eb)">
        <span style="font-size:16px;font-weight:800;color:var(--on-surface,#1a1d27)">Service waiver</span>
        <button id="wvt-close" aria-label="Close" style="width:32px;height:32px;border:0;border-radius:50%;background:var(--surface-container,#f1f0f4);cursor:pointer;font-size:18px">✕</button>
      </div>
      <div style="padding:16px 18px;overflow-y:auto;white-space:pre-wrap;font-size:13px;line-height:1.6;color:var(--on-surface,#1a1d27)">${escHtml(text || '')}</div>
      <div style="padding:12px 18px;border-top:1px solid var(--outline,#e5e7eb)">
        <button id="wvt-done" style="width:100%;padding:12px;border:0;border-radius:11px;background:var(--primary,#1a5252);color:#fff;font-size:15px;font-weight:700;cursor:pointer">Close and continue</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#wvt-close').addEventListener('click', close);
  overlay.querySelector('#wvt-done').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
}

// ── Settings (admin) ─────────────────────────────────────────────────────────
export function renderWaiverSettings() {
  const host = document.getElementById('waiver-section');
  if (!host) return;
  const c = cfg();
  const src = c.waiver_source || 'text';
  const active = waiverActive(c);
  const warn = c.waiver_enabled && !active
    ? `<div style="margin:10px 0;padding:10px 12px;border-radius:10px;background:#fdecec;color:#a12626;font-size:13px">Waiver is ON but no ${src === 'pdf' ? 'PDF is uploaded' : 'text is entered'} — check-in will proceed without it until you add the ${src === 'pdf' ? 'PDF' : 'text'} below.</div>` : '';
  host.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0 12px;border-bottom:1px solid var(--outline,#e5e7eb)">
      <div><div style="font-weight:700;color:var(--on-surface,#1a1d27)">Require waiver at check-in</div>
        <div style="font-size:13px;color:var(--on-surface-variant,#5b606e)">${c.waiver_enabled ? 'On' : 'Off'}${c.waiver_version ? ' · Version ' + escHtml(c.waiver_version) : ''}</div></div>
      <label class="mswitch" style="cursor:pointer"><input type="checkbox" id="wv-enable" ${c.waiver_enabled ? 'checked' : ''} onchange="saveWaiverEnabled(this.checked)"></label>
    </div>
    ${warn}
    <div style="margin-top:14px">
      <label style="font-size:13px;font-weight:700;color:var(--on-surface,#1a1d27)">Waiver source</label>
      <div style="display:inline-flex;margin-top:6px;border:1px solid var(--outline,#d4d7e0);border-radius:10px;overflow:hidden">
        ${['text', 'pdf'].map(s => `<button onclick="setWaiverSource('${s}')" style="padding:8px 16px;border:0;cursor:pointer;font-weight:700;font-size:13px;background:${src === s ? 'var(--primary,#1a5252)' : 'transparent'};color:${src === s ? '#fff' : 'var(--on-surface,#1a1d27)'}">${s === 'pdf' ? 'Uploaded PDF' : 'Custom text'}</button>`).join('')}
      </div>
    </div>
    ${src === 'pdf' ? `
    <div style="margin-top:14px">
      ${c.waiver_pdf_url
        ? `<div style="font-size:13px;color:var(--on-surface,#1a1d27)">Current: <a href="#" onclick="showWaiverDoc();return false" style="color:var(--primary,#1a5252);font-weight:700;text-decoration:underline">${escHtml(c.waiver_pdf_name || 'waiver.pdf')}</a> · v${escHtml(c.waiver_version || '')}</div>`
        : `<div style="font-size:13px;color:var(--on-surface-variant,#5b606e)">No PDF uploaded yet.</div>`}
      <label style="display:inline-block;margin-top:8px;padding:10px 16px;border:0;border-radius:10px;background:var(--primary,#1a5252);color:#fff;font-weight:700;cursor:pointer">
        ${c.waiver_pdf_url ? 'Replace PDF' : 'Upload PDF'}<input type="file" accept="application/pdf" onchange="uploadWaiverPdf(this)" style="display:none">
      </label>
      <div style="font-size:12px;color:var(--on-surface-variant,#5b606e);margin-top:6px">Uploading bumps the version; past signatures stay tied to the exact PDF that was signed (older versions are kept).</div>
    </div>` : `
    <div style="margin-top:14px">
      <label style="font-size:13px;font-weight:700;color:var(--on-surface,#1a1d27)">Waiver text</label>
      <textarea id="wv-text" rows="10" style="width:100%;margin-top:6px;padding:10px;border:1px solid var(--outline,#d4d7e0);border-radius:10px;font-size:12.5px;line-height:1.5;font-family:inherit;color:var(--on-surface,#1a1d27);background:var(--surface,#fff)">${escHtml(c.waiver_text || '')}</textarea>
      <div style="font-size:12px;color:var(--on-surface-variant,#5b606e);margin-top:4px">The waiver is acknowledged at every check-in. Saving changed text bumps the version, so past signatures stay tied to the exact text that was signed.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <button onclick="saveWaiverText()" style="padding:10px 16px;border:0;border-radius:10px;background:var(--primary,#1a5252);color:#fff;font-weight:700;cursor:pointer">Save waiver text</button>
        <button onclick="loadWaiverTemplate()" style="padding:10px 16px;border:1px solid var(--outline,#d4d7e0);border-radius:10px;background:transparent;color:var(--on-surface,#1a1d27);font-weight:600;cursor:pointer">Load TurnDesk template</button>
      </div>
      <div style="font-size:12px;color:var(--on-surface-variant,#5b606e);margin-top:6px">“Load TurnDesk template” fills the box with a generic starter you should review and edit for your salon before saving. It does not save on its own.</div>
    </div>`}
    <div style="margin-top:18px;display:flex;gap:8px;flex-wrap:wrap">
      <button onclick="viewSignedWaivers()" style="padding:10px 16px;border:1px solid var(--outline,#d4d7e0);border-radius:10px;background:transparent;color:var(--on-surface,#1a1d27);font-weight:600;cursor:pointer">View signed waivers</button>
      <button onclick="exportWaivers()" style="padding:10px 16px;border:1px solid var(--outline,#d4d7e0);border-radius:10px;background:transparent;color:var(--on-surface,#1a1d27);font-weight:600;cursor:pointer">Export all (download)</button>
    </div>
    <div id="wv-signed-list" style="margin-top:14px"></div>`;
}

// Fill the editor with the generic starter — NOT saved until the admin reviews + clicks Save.
export function loadWaiverTemplate() {
  const ta = document.getElementById('wv-text');
  if (!ta) return;
  if (ta.value.trim() && !confirm('Replace the current waiver text with the TurnDesk template? Your current text will be overwritten in the editor (not saved until you click Save).')) return;
  ta.value = TURNDESK_WAIVER_TEMPLATE;
  showToast('Template loaded — review and edit it, then Save.');
}

export function saveWaiverEnabled(on) {
  dispatch('config.set', { key: 'waiver_enabled', value: !!on });
  // First time turning it on with content present but no version → seed version 01.
  const c = cfg();
  const src = c.waiver_source || 'text';
  const hasContent = src === 'pdf' ? !!c.waiver_pdf_url : !!String(c.waiver_text || '').trim();
  if (on && hasContent && !c.waiver_version) bumpWaiverVersion(currentContent());
  setTimeout(renderWaiverSettings, 50);
}
export function setWaiverSource(src) {
  dispatch('config.set', { key: 'waiver_source', value: src === 'pdf' ? 'pdf' : 'text' });
  // Re-version to the now-active content so the version number can never describe a different
  // source than what's live (a legal-record integrity guard). No-op when the target source is
  // still empty — waiverActive stays false until content is added.
  const content = currentContent();
  const has = content.source === 'pdf' ? !!content.pdfUrl : !!String(content.text || '').trim();
  if (has) bumpWaiverVersion(content);
  setTimeout(renderWaiverSettings, 50);
}

// The active-source content descriptor used for versioning.
function currentContent() {
  const c = cfg();
  return (c.waiver_source || 'text') === 'pdf'
    ? { source: 'pdf', pdfUrl: c.waiver_pdf_url, pdfHash: c.waiver_pdf_hash, pdfName: c.waiver_pdf_name }
    : { source: 'text', text: c.waiver_text };
}
function bumpWaiverVersion(content) {
  const c = cfg();
  const cur = Number(c.waiver_version || 0);
  const next = String(cur + 1).padStart(2, '0');
  const versions = { ...(c.waiver_versions || {}) };
  versions[next] = content.source === 'pdf'
    ? { source: 'pdf', pdfUrl: content.pdfUrl, pdfHash: content.pdfHash, pdfName: content.pdfName, effectiveAt: Date.now() }
    : { source: 'text', text: content.text, hash: textHash(content.text), effectiveAt: Date.now() };
  dispatch('config.set', { key: 'waiver_version', value: next });
  dispatch('config.set', { key: 'waiver_versions', value: versions });
  return next;
}
export function saveWaiverText() {
  const text = (document.getElementById('wv-text')?.value || '').trim();
  if (!text) { showToast('Enter the waiver text first.'); return; }
  const c = cfg();
  dispatch('config.set', { key: 'waiver_text', value: text });
  if (text !== (c.waiver_text || '') || !c.waiver_version || (c.waiver_source || 'text') !== 'text') {
    const v = bumpWaiverVersion({ source: 'text', text });
    showToast(`Saved — now version ${v}. Clients acknowledge it at check-in.`);
  } else showToast('Saved.');
  setTimeout(renderWaiverSettings, 50);
}

// Upload a PDF to R2 under a version-stamped, never-overwritten, PER-SALON key so every signed
// version stays reproducible. Uploading bumps the version.
export async function uploadWaiverPdf(input) {
  const file = input?.files?.[0];
  if (!file) return;
  if (file.type !== 'application/pdf') { showToast('Please choose a PDF file.'); input.value = ''; return; }
  if (file.size > 15 * 1024 * 1024) { showToast('That PDF is too large (max 15 MB).'); input.value = ''; return; }
  showToast('Uploading…');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
    const pdfHash = [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    const next = String(Number(cfg().waiver_version || 0) + 1).padStart(2, '0');
    const key = `${salonSlug()}/waiver-v${next}-${pdfHash}.pdf`;   // per-salon + versioned + fingerprinted → never overwritten, passes the /photos salon guard
    const res = await fetch(`${PHOTOS_PROXY}/${key}`, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/pdf' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const url = (await res.json()).url;
    dispatch('config.set', { key: 'waiver_source', value: 'pdf' });
    dispatch('config.set', { key: 'waiver_pdf_url', value: url });
    dispatch('config.set', { key: 'waiver_pdf_name', value: file.name });
    dispatch('config.set', { key: 'waiver_pdf_hash', value: pdfHash });
    const v = bumpWaiverVersion({ source: 'pdf', pdfUrl: url, pdfHash, pdfName: file.name });
    showToast(`PDF uploaded — now version ${v}.`);
  } catch (e) { showToast('Upload failed — check the connection.'); }
  input.value = '';
  setTimeout(renderWaiverSettings, 50);
}

async function fetchWaivers() {
  const r = await fetch(STATE_PROXY + '/waivers', { method: 'GET' });
  if (r.status === 403) throw new Error('not permitted');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return (await r.json()).waivers || [];
}
export async function viewSignedWaivers() {
  const host = document.getElementById('wv-signed-list'); if (host) host.innerHTML = '<div style="font-size:13px;color:var(--on-surface-variant,#5b606e)">Loading…</div>';
  try {
    const list = await fetchWaivers();
    if (!list.length) { if (host) host.innerHTML = '<div style="font-size:13px;color:var(--on-surface-variant,#5b606e)">No signed waivers yet.</div>'; return; }
    if (host) host.innerHTML = `<div style="font-size:13px;font-weight:700;margin-bottom:6px">${list.length} signed waiver${list.length === 1 ? '' : 's'}</div>` + list.slice(0, 200).map(w => {
      const when = (() => { try { return new Date(w.acceptedAt).toLocaleString(); } catch { return ''; } })();
      return `<div style="padding:9px 11px;border:1px solid var(--outline,#e5e7eb);border-radius:9px;margin-bottom:6px;font-size:13px;color:var(--on-surface,#1a1d27)">
        <b>${escHtml(w.signerDisplay || w.signerFullName || '')}</b> · v${escHtml(w.waiverVersion || '')} · ${escHtml(when)}
        <div style="font-size:12px;color:var(--on-surface-variant,#5b606e)">${escHtml(w.signerPhone || '')}${w.guests && w.guests.length > 1 ? ' · ' + w.guests.length + ' guests' : ''}${w.bypassed ? ' · bypassed' : ''}</div>
      </div>`;
    }).join('');
  } catch (e) { if (host) host.innerHTML = `<div style="font-size:13px;color:#a12626">Couldn’t load waivers (${escHtml(String(e.message || e))}).</div>`; }
}
export async function exportWaivers() {
  try {
    const list = await fetchWaivers();
    const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `waivers-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`Exported ${list.length} waiver${list.length === 1 ? '' : 's'}.`);
  } catch (e) { showToast('Export failed — check the connection.'); }
}
