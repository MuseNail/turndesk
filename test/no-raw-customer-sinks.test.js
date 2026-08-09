// F4 regression gate — the compensating control (with the connect-src CSP) that makes "escape at
// render" safe. Statically scans the render modules for person/customer-controlled fields interpolated
// into an HTML/template string WITHOUT an escaper. Any hit is a stored-XSS sink (a walk-in's typed
// name/phone/visit-note executing in the front-desk/owner session, or in the report export). Wrap the
// value in escHtml (text / double-quoted attr) or escAttrJs (inline onX="…('${v}')…" JS-string arg). If
// a hit is genuinely safe, annotate that line with `xss-ok:` + why.
//
// HONEST LIMITS — this is a heuristic line-regex TRIPWIRE, not a static analyzer. It CANNOT see:
//   (a) helper params named anything other than the ones in BARE_VAR (caller→helper data flow is
//       invisible — e.g. _drillRow(r.customer,…) passes a raw arg the scan never reads). We guard the
//       known choke-point helpers with explicit def-invariant assertions below instead.
//   (b) computed member access — entry['name'] / e[fld] (the regex needs a literal `.name`).
//   (c) .join()/.map() name lists whose element prefix isn't allow-listed.
// The real defense-in-depth control is the connect-src CSP (blocks token exfil even if a sink slips) +
// the live browser XSS proof. Keep this gate as a fast tripwire, not a proof of safety.
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
  'js/app/features/audit.js',    // guards the logAudit compensating control (detail escaped at its render)
  'js/app/features/checkin.js',  // the public input surface — confirm it renders customer input only safely
];
// A ${...} interpolation reading a CUSTOMER-INPUT-controlled field off a customer/record/giftcard/guest/
// row entity (e/entry/m/target/held = queue entry & merge members, r/x/rec/row = report/drill record,
// g = giftcard, c/cust/customer/guest = customer/appointment guest). \b after each field keeps `.to` from
// matching `.toFixed` and `.note` from matching `.notes`… (both are in the list anyway). Scoped to these
// prefixes/fields so it targets walk-in-typed input (the F4 threat), not owner-set staff/service names.
const PERSON_FIELD = /\b(?:e|entry|m|target|held|r|x|rec|row|g|c|cust|customer|guest)\??\.(name|names|phone|email|address|notes|note|from|to|customer|groupLabel)\b/;
// Bare local vars that hold customer-derived text at render sites (found in the F4 sweep — the gate can't
// infer their provenance, so they're named explicitly). `grp` is a generated letter-BADGE (xss-ok), not
// customer text, but it's listed so a future coder must consciously annotate it rather than silently skip.
const BARE_VAR = /\$\{\s*(?:note|primary|customer|firstName|lastName|groupLabel|grp)\b/;
// Genuine HTML-escapers: utils escHtml/escAttrJs (& < > " [+ \ ']), calendar _escHtml/_escAttrJs, the
// per-file &<>-only aliases (_tEsc/_eTxn/esc/_esc — safe ONLY in text contexts), and known-safe wrappers
// (cardNotePreview escapes internally; fmt/localDateStr format Dates, never HTML).
const ESCAPER = /(escHtml|escAttrJs|escapeHtml|_tEsc|_eTxn|_esc|esc|cardNotePreview|fmt|localDateStr)\s*\(/;

test('no raw person-controlled fields interpolated into HTML without an escaper (F4)', () => {
  const offenders = [];
  for (const rel of FILES) {
    const lines = readFileSync(join(root, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/xss-ok:/.test(line)) return;               // explicit, documented exception
      const interps = line.match(/\$\{[^}]*\}/g) || [];
      for (const it of interps) {
        if ((PERSON_FIELD.test(it) || BARE_VAR.test(it)) && !ESCAPER.test(it)) {
          offenders.push(`${rel}:${i + 1}  ${it.slice(0, 80)}`);
        }
      }
    });
  }
  assert.deepEqual(offenders, [], `Unescaped person-controlled HTML sinks (${offenders.length}):\n` + offenders.join('\n'));
});

// ── def-invariant assertions — the choke-point render helpers the line scan can't reach (caller→helper) ─
// _drillRow (reports.js) is the single render helper behind 6 Reports/Reconcile drill-downs; its callers
// pass a raw customer name as a plain arg, invisible to the scan. Assert the helper escapes BOTH its
// customer and sub interpolations directly, so removing either fails the build.
test('_drillRow escapes its customer + sub interpolations (F4 def-invariant)', () => {
  const src = readFileSync(join(root, 'js/app/features/reports.js'), 'utf8');
  const m = src.match(/const _drillRow *=.*/);
  assert.ok(m, '_drillRow helper not found — did it move/rename? re-anchor this invariant');
  assert.match(m[0], /escHtml\(\s*customer\s*\)/, '_drillRow must escHtml(customer)');
  assert.match(m[0], /escHtml\(\s*sub\s*\)/, '_drillRow must escHtml(sub)');
});
