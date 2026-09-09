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
