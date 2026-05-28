import test from 'node:test';
import assert from 'node:assert/strict';
import { b64urlFromStr, b64urlFromBytes, vapidJwtUnsigned } from '../cloudflare/worker.js';

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

test('vapidJwtUnsigned builds an ES256 header + aud/exp/sub payload (2 segments)', () => {
  const jwt = vapidJwtUnsigned('https://push.example.com', 'mailto:info@muse.com', 1893456000);
  const parts = jwt.split('.');
  assert.equal(parts.length, 2);   // unsigned — signature appended separately
  assert.deepEqual(JSON.parse(decode(parts[0])), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(decode(parts[1])), { aud: 'https://push.example.com', exp: 1893456000, sub: 'mailto:info@muse.com' });
});
