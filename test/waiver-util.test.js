import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WAIVER_METHODS, textHash, newWaiverId, waiverActive,
  buildWaiverRecord, signerDisplayName,
} from '../js/app/waiver-util.js';

// ── textHash ─────────────────────────────────────────────────
test('textHash is stable and sensitive', () => {
  assert.equal(textHash('hello'), textHash('hello'));
  assert.notEqual(textHash('hello'), textHash('hello.'));
  assert.match(textHash('anything'), /^[0-9a-f]+$/);
});

// ── newWaiverId ──────────────────────────────────────────────
test('newWaiverId is prefixed + unique-ish', () => {
  assert.match(newWaiverId(1000, 'abc'), /^wv-1000-abc$/);
  assert.notEqual(newWaiverId(1, 'a'), newWaiverId(1, 'b'));
});

// ── signerDisplayName (first + last initial) ─────────────────
test('signerDisplayName is first name + last initial', () => {
  assert.equal(signerDisplayName('Sarah', 'Miller'), 'Sarah M.');
  assert.equal(signerDisplayName('Sarah', ''), 'Sarah');
  assert.equal(signerDisplayName(' Ann ', ' Lee '), 'Ann L.');
});

// ── waiverActive (empty-text guard) ──────────────────────────
test('waiverActive requires enabled + version + non-empty text', () => {
  assert.equal(waiverActive({ waiver_enabled: true, waiver_version: '02', waiver_text: 'terms…' }), true);
  assert.equal(waiverActive({ waiver_enabled: false, waiver_version: '02', waiver_text: 'x' }), false);
  assert.equal(waiverActive({ waiver_enabled: true, waiver_version: '02', waiver_text: '   ' }), false);
  assert.equal(waiverActive({ waiver_enabled: true, waiver_version: '', waiver_text: 'x' }), false);
  assert.equal(waiverActive({}), false);
  // PDF source: active needs a pdf url (not text)
  assert.equal(waiverActive({ waiver_enabled: true, waiver_version: '02', waiver_source: 'pdf', waiver_pdf_url: 'https://x/w.pdf' }), true);
  assert.equal(waiverActive({ waiver_enabled: true, waiver_version: '02', waiver_source: 'pdf', waiver_pdf_url: '', waiver_text: 'has text' }), false);
});


// ── buildWaiverRecord ────────────────────────────────────────
test('buildWaiverRecord stores full text inline + hash + attribution', () => {
  const rec = buildWaiverRecord({
    id: 'wv-1', now: 5000,
    primary: { firstName: 'Sarah', lastName: 'Miller', phone: '(909) 123-4567', phoneKey: '9091234567', customerId: 'cust-9091234567' },
    guests: [{ name: 'Sarah Miller', phoneKey: '9091234567' }, { name: 'Ann', phoneKey: null }],
    waiverVersion: '02', text: 'FULL WAIVER TEXT', method: 'self-kiosk', deviceId: 'devA',
    optIns: { marketing: true, media: false }, arbitrationOptOut: false, bypassed: false,
  });
  assert.equal(rec.id, 'wv-1');
  assert.equal(rec.customerId, 'cust-9091234567');
  assert.equal(rec.phoneKey, '9091234567');
  assert.equal(rec.signerFullName, 'Sarah Miller');
  assert.equal(rec.signerDisplay, 'Sarah M.');
  assert.equal(rec.signerPhone, '(909) 123-4567');
  assert.equal(rec.waiverVersion, '02');
  assert.equal(rec.text, 'FULL WAIVER TEXT');       // full text inline (system of record)
  assert.equal(rec.textHash, textHash('FULL WAIVER TEXT'));
  assert.equal(rec.acceptedAt, 5000);
  assert.equal(rec.method, 'self-kiosk');
  assert.equal(rec.deviceId, 'devA');
  assert.deepEqual(rec.optIns, { marketing: true, media: false });
  assert.equal(rec.arbitrationOptOut, false);
  assert.equal(rec.bypassed, false);
  assert.equal(rec.guests.length, 2);
  assert.equal(rec.source, 'text');
  assert.equal(rec.pdfUrl, null);
});

test('buildWaiverRecord PDF mode pins the versioned pdf ref, no inline text', () => {
  const rec = buildWaiverRecord({
    id: 'wv-pdf', now: 9, primary: { firstName: 'Sarah', lastName: 'Miller', phoneKey: 'pk' }, guests: [],
    waiverVersion: '03', source: 'pdf', pdfUrl: 'https://x/waiver-v03-abc.pdf', pdfHash: 'abc123', pdfName: 'waiver.pdf',
    text: 'IGNORED', method: 'self-kiosk',
  });
  assert.equal(rec.source, 'pdf');
  assert.equal(rec.pdfUrl, 'https://x/waiver-v03-abc.pdf');
  assert.equal(rec.pdfHash, 'abc123');
  assert.equal(rec.pdfName, 'waiver.pdf');
  assert.equal(rec.text, '');          // no inline text in pdf mode
  assert.equal(rec.textHash, null);
});

test('buildWaiverRecord defaults optIns/bypass safely', () => {
  const rec = buildWaiverRecord({ id: 'wv-2', now: 1, primary: { firstName: 'Bo', lastName: 'K', phoneKey: 'pk' }, guests: [], waiverVersion: '02', text: 't', method: 'front-desk-kiosk' });
  assert.deepEqual(rec.optIns, { marketing: false, media: false });
  assert.equal(rec.arbitrationOptOut, false);
  assert.equal(rec.bypassed, false);
});

test('WAIVER_METHODS is the closed set', () => {
  assert.deepEqual(WAIVER_METHODS, ['self-kiosk', 'front-desk-kiosk', 'front-desk-bypass', 'front-desk-takeover']);
});

// ── waiverMethodLabel + signerLines (Wave 2 #12 — the signer/attestation block) ──
import { waiverMethodLabel, signerLines } from '../js/app/waiver-util.js';

test('waiverMethodLabel is human-readable + flags a bypass', () => {
  assert.equal(waiverMethodLabel('self-kiosk', false), 'Signed at the kiosk');
  assert.equal(waiverMethodLabel('front-desk-kiosk', false), 'Signed at the kiosk (sent from the front desk)');
  assert.match(waiverMethodLabel('front-desk-bypass', true), /bypass/i);
  assert.match(waiverMethodLabel('front-desk-takeover', true), /front desk|staff/i);
  assert.equal(typeof waiverMethodLabel('weird', false), 'string');   // never empty
});

test('signerLines surfaces the legal facts and skips empties', () => {
  const w = {
    signerDisplay: 'Jane D.', signerFullName: 'Jane Doe', signerPhone: '(555) 111-2222',
    acceptedAt: Date.parse('2026-06-12T17:30:00Z'), waiverVersion: '3',
    method: 'self-kiosk', deviceId: 'ipad-1', byUser: null, bypassed: false,
    guests: [{ name: 'Jane Doe' }, { name: 'Mia Doe' }],
  };
  const rows = signerLines(w);
  const label = l => rows.find(r => r.label === l)?.value;
  assert.ok(rows.length >= 4);
  assert.match(label('Signed by') || '', /Jane D\./);
  assert.equal(label('Waiver version'), 'v3');
  assert.match(label('Method') || '', /kiosk/i);
  assert.match(label('Guests') || '', /Mia Doe/);   // party is listed
  assert.equal(rows.find(r => r.label === 'Checked in by'), undefined);   // byUser null → row skipped
});

test('signerLines marks a bypassed record (no customer signature)', () => {
  const rows = signerLines({ signerDisplay: 'Al', acceptedAt: 1, waiverVersion: '1', method: 'front-desk-bypass', bypassed: true, byUser: 'Dana' });
  assert.match(rows.find(r => r.label === 'Status')?.value || '', /bypass/i);
  assert.equal(rows.find(r => r.label === 'Checked in by')?.value, 'Dana');
});

import { waiverAttestation, WAIVER_ATTESTATION } from '../js/app/waiver-util.js';
test('waiverAttestation never asserts a signature on a bypassed record', () => {
  const byp = waiverAttestation({ bypassed: true, byUser: 'Dana' });
  assert.doesNotMatch(byp, /electronic signature/i);   // no false attestation
  assert.match(byp, /no customer signature/i);
  assert.match(byp, /Dana/);
});
test('waiverAttestation on a genuine single signer = the e-sig sentence', () => {
  assert.equal(waiverAttestation({ bypassed: false, guests: [{ name: 'A' }] }), WAIVER_ATTESTATION);
});
test('waiverAttestation notes the party on a multi-guest signature', () => {
  const s = waiverAttestation({ bypassed: false, guests: [{ name: 'A' }, { name: 'B' }] });
  assert.match(s, /on behalf of everyone/i);
});
test('signerLines uses neutral labels on a bypassed record (not "Signed by")', () => {
  const rows = signerLines({ signerDisplay: 'Al', acceptedAt: 1, method: 'front-desk-bypass', bypassed: true });
  assert.ok(rows.find(r => r.label === 'Customer'));
  assert.equal(rows.find(r => r.label === 'Signed by'), undefined);
  assert.ok(rows.find(r => r.label === 'Recorded on'));
});
