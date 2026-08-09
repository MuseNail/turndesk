// CSP drift guard (security review F4/F5). Every HTML entry point must carry the SAME connect-src CSP —
// they all talk to the same endpoints, and a <meta> CSP can't be Report-Only, so a drift either silently
// drops the exfil protection on one page or breaks its sync. The policy is connect-src-ONLY on purpose:
// with no default-src it can't break scripts/styles/the Tailwind CDN/inline onX= handlers, it only bounds
// where fetch/XHR/WebSocket may connect (blocking token exfil from an injected script — the F4 amplifier).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['index.html', 'staff.html', 'reports.html', 'signup.html', 'demo.html', 'operator.html'];
const cspOf = html => {
  const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/i);
  return m ? m[1] : null;
};

test('every HTML page carries an identical connect-src CSP', () => {
  const policies = PAGES.map(p => ({ p, csp: cspOf(readFileSync(join(root, p), 'utf8')) }));
  for (const { p, csp } of policies) assert.ok(csp, `${p} is missing the Content-Security-Policy <meta>`);
  const ref = policies[0];
  for (const { p, csp } of policies) assert.equal(csp, ref.csp, `${p} CSP differs from ${ref.p} — keep them identical`);
});

test('the CSP is connect-src-only and allowlists every real endpoint', () => {
  const csp = cspOf(readFileSync(join(root, 'index.html'), 'utf8'));
  assert.match(csp, /^connect-src /, 'must start with connect-src');
  // connect-src-only: no default/script/style-src, so it can never break inline handlers or the CDN.
  assert.doesNotMatch(csp, /\b(default|script|style)-src\b/, 'must be connect-src-only');
  // Every endpoint the client actually reaches — a missing one breaks sync/calendar/billing.
  for (const host of [
    "'self'",
    'https://turndesk.musenailandspa.workers.dev', 'wss://turndesk.musenailandspa.workers.dev',
    'https://turndesk-staging.musenailandspa.workers.dev', 'wss://turndesk-staging.musenailandspa.workers.dev',
    'http://localhost:8787', 'ws://localhost:8787',
    'https://*.googleapis.com', 'https://apis.google.com', 'https://secure.helcim.app',
  ]) assert.ok(csp.includes(host), `CSP must allow ${host} (or that feature breaks)`);
});
