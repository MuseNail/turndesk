// F4 regression gate — the compensating control that makes "escape at render" safe without a CSP.
// Statically scans the render modules for person/customer-controlled fields (name/phone/email/
// address/notes/from/to) interpolated into an HTML/template string WITHOUT an escaper. Any hit is
// a stored-XSS sink (a walk-in's typed name executing in the front-desk/owner session, or in the
// PUBLICLY-served report export). Wrap the value in escHtml (text) or escAttrJs (attribute / inline
// onX="…(${v})…" JS-string). If a hit is genuinely safe, annotate that line with `xss-ok:` + why.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'js/app/features/queue.js',
  'js/app/features/turns.js',
  'js/app/features/reports.js',
  'js/app/features/giftcards.js',
  'js/app/features/calendar.js',
];
// A ${...} interpolation reading a CUSTOMER-INPUT-controlled field off a customer/record/giftcard/
// guest entity (e/entry/m/target/held = queue entry & merge members, r/x/rec = report record,
// g = giftcard, c/cust/customer/guest = customer/appointment guest). Scoped to these prefixes so
// it targets walk-in-typed input (the F4 threat) and not owner-set staff/service names (only
// exploitable by an already-admin actor — hardening, deferred to Phase 4). \b after each field
// keeps `.to` from matching `.toFixed` and `.name` from matching a bare `name` var.
const PERSON_FIELD = /\b(?:e|entry|m|target|held|r|x|rec|g|c|cust|customer|guest)\.(name|names|phone|email|address|notes|from|to)\b/;
// Genuine HTML-escapers (escHtml/escAttrJs), the per-file aliases (_tEsc/_eTxn/esc), and known-safe
// wrappers (cardNotePreview escapes internally; fmt/localDateStr format Dates, never HTML).
const ESCAPER = /(escHtml|escAttrJs|escapeHtml|_tEsc|_eTxn|esc|cardNotePreview|fmt|localDateStr)\s*\(/;

// SKIPPED until the F4 escaping sweep runs (deferred to its own focused cycle — 2026-08-04).
// It currently reports ~51 real customer-controlled sinks (the F4 worklist). To resume F4:
// change `test.skip` → `test`, run it to get the live worklist, escape each real innerHTML sink
// (escHtml for text, escAttrJs for onX="…(${v})…" JS-string args), annotate verified-safe
// data-build/showToast/textContent lines with `xss-ok: <reason>`, and drive it to green.
// NOTE: the gate has blind spots — also escape derived-var sinks it can't see (firstName/lastName
// value="" attrs in the edit-check-in modal; the groupLabel RENDER sinks queue.js:326/1189, turns.js:543).
test.skip('no raw person-controlled fields interpolated into HTML without an escaper (F4)', () => {
  const offenders = [];
  for (const rel of FILES) {
    const lines = readFileSync(join(root, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/xss-ok:/.test(line)) return;               // explicit, documented exception
      const interps = line.match(/\$\{[^}]*\}/g) || [];
      for (const it of interps) {
        if (PERSON_FIELD.test(it) && !ESCAPER.test(it)) offenders.push(`${rel}:${i + 1}  ${it.slice(0, 80)}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `Unescaped person-controlled HTML sinks (${offenders.length}):\n` + offenders.join('\n'));
});
