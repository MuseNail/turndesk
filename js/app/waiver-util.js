// Pure helpers for the check-in service waiver. No browser/Cloudflare APIs →
// unit-testable in node AND served to the browser (client-consumed: the client builds
// the acceptance record, the Worker just persists it as its own DO key `waiver:<id>`,
// never in buildSnapshot, never broadcast). This module owns the record shape, the text
// hash, and the re-sign rule.

// 'front-desk-kiosk' = customer e-signed on the pushed kiosk window; 'front-desk-bypass' =
// deliberately skipped at the desk (no kiosk / skip button / bypass mode); 'front-desk-takeover'
// = desk reclaimed a pending kiosk handoff and finished it without a customer signature. The
// last two carry bypassed:true — the method must survive so the legal record isn't mislabeled.
export const WAIVER_METHODS = ['self-kiosk', 'front-desk-kiosk', 'front-desk-bypass', 'front-desk-takeover'];
export const WAIVER_MAX_TEXT = 200000;   // generous cap on the stored agreement text

// Deterministic 32-bit FNV-1a → hex. Not cryptographic — a checksum to detect drift/
// tampering; exact reproduction relies on the full text stored inline on the record.
export function textHash(text) {
  const s = String(text == null ? '' : text);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// id generated ONCE before dispatch (stable across an offline-outbox replay → the
// mutationId dedup keeps replays from creating duplicate waiver rows).
export function newWaiverId(now, rand) { return 'wv-' + now + '-' + rand; }

// On-screen e-signature acknowledgment sentences (a legal record) — one source, so the wording
// can't drift between the kiosk paths. The caller prefixes "I have read and agree to the <link>."
// WAIVER_ACK_SINGLE matches the waiver modal's wording verbatim; WAIVER_ACK_MULTI covers a group
// (the primary signs on behalf of everyone in the check-in).
export const WAIVER_ACK_SINGLE = 'Checking this box is my electronic signature, using the name I provided at check-in, which represents me and legally binds me to the same extent as my full legal name even if it is not my full legal name.';
export const WAIVER_ACK_MULTI = 'Checking this box is our electronic signature on behalf of everyone in this check-in (named above), using the names provided, and legally binds each of us to the same extent as our full legal names.';

export function signerDisplayName(firstName, lastName) {
  const f = String(firstName || '').trim();
  const l = String(lastName || '').trim();
  return l ? (f + ' ' + l[0] + '.').trim() : f;
}

// The feature is active only when enabled, a version exists, AND the active source has
// content (text OR an uploaded PDF) — otherwise check-in proceeds (never hard-block behind
// empty terms). `waiver_source` is 'text' (default) or 'pdf'.
export function waiverActive(config) {
  const c = config || {};
  if (!c.waiver_enabled) return false;
  if (!c.waiver_version) return false;
  if ((c.waiver_source || 'text') === 'pdf') return !!String(c.waiver_pdf_url || '').trim();
  return !!String(c.waiver_text || '').trim();
}

export function buildWaiverRecord({
  id, now, primary, guests, waiverVersion, source, text, pdfUrl, pdfHash, pdfName, method, deviceId, byUser, optIns, arbitrationOptOut, bypassed, ip,
}) {
  const p = primary || {};
  const src = source === 'pdf' ? 'pdf' : 'text';
  return {
    id,
    customerId: p.customerId || null,
    phoneKey: p.phoneKey || '',
    signerFullName: [String(p.firstName || '').trim(), String(p.lastName || '').trim()].filter(Boolean).join(' '),
    signerDisplay: signerDisplayName(p.firstName, p.lastName),
    signerPhone: p.phone || '',
    guests: (guests || []).map(g => ({ name: g.name || '', phoneKey: g.phoneKey || null })),
    waiverVersion: String(waiverVersion || ''),
    source: src,
    // Reproduction: text mode pins the full text inline (system of record); PDF mode pins the
    // versioned, immutable R2 url + fingerprint (the PDF object itself is never overwritten).
    text: src === 'text' ? String(text == null ? '' : text).slice(0, WAIVER_MAX_TEXT) : '',
    textHash: src === 'text' ? textHash(text) : null,
    pdfUrl: src === 'pdf' ? (pdfUrl || '') : null,
    pdfHash: src === 'pdf' ? (pdfHash || '') : null,
    pdfName: src === 'pdf' ? (pdfName || '') : null,
    acceptedAt: now,
    method: WAIVER_METHODS.includes(method) ? method : 'self-kiosk',
    deviceId: deviceId || '',
    byUser: byUser || null,
    optIns: { marketing: !!(optIns && optIns.marketing), media: !!(optIns && optIns.media) },
    arbitrationOptOut: !!arbitrationOptOut,
    bypassed: !!bypassed,
    ip: ip || null,
  };
}
