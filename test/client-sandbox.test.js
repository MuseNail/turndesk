// F6 (client mirror) — the client hides shared-account features (Ask-AI, etc.) for a sandbox
// salon (the public 'demo'), matching the Worker's server-side sandbox gate. isSandboxSalon must
// mirror cloudflare/worker.js SANDBOX_SLUGS exactly (same slug, same case/trim normalization).
import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSandboxSalon } from '../js/app/config.js';

test('client isSandboxSalon: demo is a sandbox (case/whitespace-insensitive); real salons are not', () => {
  assert.equal(isSandboxSalon('demo'), true);
  assert.equal(isSandboxSalon('Demo'), true, 'case-insensitive');
  assert.equal(isSandboxSalon(' demo '), true, 'trimmed');
  assert.equal(isSandboxSalon('krystal-nails'), false);
  assert.equal(isSandboxSalon('demo-reserved'), false);
  assert.equal(isSandboxSalon(''), false);
  assert.equal(isSandboxSalon(undefined), false);
});
