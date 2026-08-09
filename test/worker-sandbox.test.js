// F6 — the public 'demo' salon is a "sandbox": it may use its OWN durable object freely
// (product tour), but must NEVER reach the SHARED platform accounts (one Helcim/Square
// merchant + SMS number + AI key + platform billing). Otherwise an anonymous demo login
// (public admin PIN) reads/charges/refunds/texts/drains across ALL tenants. (Security
// review 2026-08-03, finding F6 + Chain A.)  See cloudflare/worker.js isSandboxSalon +
// the sandbox gate right after appAuthOk.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { isSandboxSalon } from '../cloudflare/worker.js';

// AUTH_ENFORCED unset → appAuthOk returns true before any DO call, so the SANDBOX gate
// (not the session) is what we exercise. No env keys → shared-account handlers early-return
// (e.g. /ai/ask → 503 "not configured") WITHOUT a network call.
const ENV = {};
const hit = (path, salon, method = 'POST') =>
  worker.fetch(new Request(`https://w${path}?salon=${salon}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined }), ENV);

// ── isSandboxSalon (unit) ────────────────────────────────────────────────────────
test('isSandboxSalon: demo is a sandbox (case/whitespace-insensitive); real salons are not', () => {
  assert.equal(isSandboxSalon('demo'), true);
  assert.equal(isSandboxSalon('Demo'), true, 'case-insensitive (matches validateSlug canonicalization)');
  assert.equal(isSandboxSalon('  demo '), true, 'trimmed');
  assert.equal(isSandboxSalon('krystal-nails'), false);
  assert.equal(isSandboxSalon('demo-reserved'), false, 'a different, reserved slug — not the sandbox');
  assert.equal(isSandboxSalon(''), false);
  assert.equal(isSandboxSalon(null), false);
});

// ── the gate: sandbox salon → 403 on EVERY shared-account route ───────────────────
for (const path of ['/helcim/ping', '/helcim/purchase', '/helcim/result', '/helcim/transactions', '/helcim/customer', '/helcim/refund', '/square/customers', '/square.attacker.example/', '/sms/send', '/ai/ask', '/billing/subscribe', '/billing/portal-token']) {
  test(`sandbox 'demo' is BLOCKED (403) from shared-account route ${path}`, async () => {
    const r = await hit(path, 'demo');
    assert.equal(r.status, 403, `${path} must 403 for the demo sandbox`);
  });
}

// ── future-proofing: the /ai family is gated by PREFIX, not just the exact /ai/ask ─
// The gate's comment promises "a shared-account route added later can't be forgotten." A future
// shared-key AI route (e.g. /ai/summarize, /ai/insights — same account-wide ANTHROPIC/GEMINI key)
// must also be sandboxed, or the demo foothold silently regains the F23 AI-budget-drain leg of
// Chain A with no failing test. (3-lens review of the F6 build, 2026-08-09.)
test("sandbox 'demo' is BLOCKED (403) from a hypothetical future /ai/* route (prefix, not exact-match)", async () => {
  const r = await hit('/ai/summarize', 'demo');
  assert.equal(r.status, 403, 'the /ai/ family must be gated by prefix so future shared-key AI routes are covered');
});

// ── scoping: a REAL salon is NOT blocked by the sandbox gate ──────────────────────
test("a real salon is NOT sandbox-blocked — /ai/ask reaches the handler (503 'not configured'), not 403", async () => {
  // Hermetic proof the gate is scoped to sandbox salons only: a real salon passes the gate and
  // reaches the /ai/ask handler, which early-returns 503 (no AI key) WITHOUT a network call.
  const r = await hit('/ai/ask', 'krystal-nails');
  assert.notEqual(r.status, 403, 'real salon must pass the sandbox gate');
  assert.equal(r.status, 503, 'reaches the /ai/ask handler which early-returns 503 when no AI key is set');
});
