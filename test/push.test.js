import test from 'node:test';
import assert from 'node:assert/strict';
import { b64urlFromStr, b64urlFromBytes, vapidJwtUnsigned, encryptPushPayload } from '../cloudflare/worker.js';

const decode = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Buffer.from(s, 'base64').toString('utf8'); };

test('b64urlFromStr is URL-safe and unpadded', () => {
  assert.equal(b64urlFromStr('hello'), 'aGVsbG8');
  const enc = b64urlFromStr('any string with / + = chars?');
  assert.ok(!/[+/=]/.test(enc));
});

test('b64urlFromBytes round-trips', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
  const enc = b64urlFromBytes(bytes);
  assert.ok(!/[+/=]/.test(enc));
  assert.deepEqual([...Buffer.from(enc.replace(/-/g, '+').replace(/_/g, '/'), 'base64')], [...bytes]);
});

// RFC 8291 round-trip: encrypt with the Worker's code, then decrypt exactly the way a
// browser push service consumer (the UA) does. If any HKDF info string, salt placement,
// or header byte is wrong, decryption fails — so this pins the whole construction.
test('encryptPushPayload produces a valid aes128gcm body the subscriber can decrypt', async () => {
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPub = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  const b64url = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const sub = { endpoint: 'https://push.example.com/x', keys: { p256dh: b64url(uaPub), auth: b64url(authSecret) } };

  const payload = JSON.stringify({ title: 'New appointment 📅', body: 'Jessica Tran — Thu Jun 11, 2:30 PM', tag: 'muse-appt' });
  const body = new Uint8Array(await encryptPushPayload(sub, payload));

  // Header: salt(16) ‖ rs(4) ‖ idlen(1)=65 ‖ as_public(65)
  const salt = body.slice(0, 16);
  assert.equal(new DataView(body.buffer).getUint32(16), 4096);
  assert.equal(body[20], 65);
  const asPub = body.slice(21, 86);
  const cipher = body.slice(86);

  // UA-side key derivation (RFC 8291 §3.3–3.4)
  const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
  const enc = new TextEncoder();
  const hkdf = async (s, ikm, info, len) => {
    const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, k, len * 8));
  };
  const keyInfo = new Uint8Array([...enc.encode('WebPush: info\0'), ...uaPub, ...asPub]);
  const ikm = await hkdf(authSecret, ecdh, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aesKey, cipher));

  assert.equal(plain[plain.length - 1], 2);   // final-record delimiter
  const decoded = new TextDecoder().decode(plain.slice(0, -1));
  assert.equal(decoded, payload);
  assert.deepEqual(JSON.parse(decoded).tag, 'muse-appt');
});

test('vapidJwtUnsigned builds an ES256 header + aud/exp/sub payload (2 segments)', () => {
  const jwt = vapidJwtUnsigned('https://push.example.com', 'mailto:info@muse.com', 1893456000);
  const parts = jwt.split('.');
  assert.equal(parts.length, 2);   // unsigned — signature appended separately
  assert.deepEqual(JSON.parse(decode(parts[0])), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(decode(parts[1])), { aud: 'https://push.example.com', exp: 1893456000, sub: 'mailto:info@muse.com' });
});
