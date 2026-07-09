# TurnDesk — Manual checkout mode (no-terminal beta) + easy Mark-paid

Date: 2026-07-09
Status: design approved (mockup + Q&A) — pending owner spec review, then build
Repo: `turndesk` (main-only). For: the free, no-card-processing beta.

## 1. Goal

Make **marking a ticket paid manually** the primary, one-tap checkout for beta salons that
have **no in-app card terminal** — and, as a safety guardrail, stop those salons from
accidentally firing a card charge on the platform's **shared** `HELCIM_API_TOKEN`/`SQUARE_TOKEN`
(every salon currently shares one token; per-salon payments is deferred Phase 3).

## 2. Approved decisions

- **Direction: Option 1 — a per-salon "manual / no card terminal" checkout mode.**
- **New processor value `'none'`** (label "None (cash / manual)") added to the payment-processor
  picker in Settings. **Default for new/beta salons = `'none'`.** Migrate the demo + existing
  beta salons to `'none'`.
- **When `payment_processor === 'none'`, the Confirm Payment screen reshapes:**
  - Hide "Pay on terminal" + "Square POS".
  - Subtitle → "No card terminal set up — record how the customer paid."
  - Tender chooser chips **Cash / Zelle / Card** (default **Cash**).
  - One primary button: **"Mark paid · $<total>"** — one tap, records the full ticket total to
    the chosen tender. Available to **every front-desk user** (the `markPaidDirect` manager
    gate does NOT apply in manual mode — it's the only checkout path).
  - A small tucked-away **"Adjust amount / add reference"** link for the rare case (e.g. logging
    an external terminal's txn id, or splitting/partial) — not shown by default.
  - Reworded throughout (drop "without charging" / "keyed on the terminal" language).
- **"Card" chip = the salon's own outside terminal.** Recorded as a card tender so reports
  count it as card income.

## 3. Reuse what already exists (minimal new logic)

The manual-paid path already does the hard part — **do not rebuild it**:
- `square-pos.js` `_markPaidCommit(method, amount, ref)` → `_finalizeTerminalPaid(ids, {[method]:amount}, …)`
  already creates the real paid record + commission + audit with the chosen tender.
- **Reports already split by tender** (`reports.js` `computeMetrics`: `cardMix`/`cashMix`/`zelleMix`
  with per-tender ticket counts). A manual "card" already lands in the Card total. **No reporting
  changes.**

So the build is mostly: a config value + a Settings option + a **conditional footer render**
in the Confirm Payment modal that, in `'none'` mode, shows the tender chips + Mark-paid button
wired straight to `_markPaidCommit` (skipping the two-step warn/escape-hatch framing).

## 4. Changes, file by file

- **`js/app/features/helcim.js`** — `activeProcessor()` returns `'none'` when `payment_processor === 'none'`
  (today it collapses everything to helcim/square); the processor toggle/selector accepts `'none'`.
- **`js/app/features/square-pos.js`** — `openSquarePOS`: when manual mode, render the manual
  footer (tender chips + one-tap Mark paid) instead of revealing the hidden escape-hatch link;
  a small `markPaidManual(method)` that calls the existing `_markPaidCommit(method, total, '')`.
  Keep `_markPaidForm` (amount/ref) reachable via the tucked-away "Adjust / add reference" link.
- **`index.html`** — Confirm Payment modal footer: a manual-mode block (chips + Mark-paid button)
  shown/hidden by `openSquarePOS`; the terminal/Square buttons hidden in manual mode.
- **`js/app/features/settings.js`** — the processor picker gains "None (cash / manual)".
- **Provisioning default** (`cloudflare/worker.js` starter config / `provisionSeed`) — new salons
  seed `config.payment_processor = 'none'`.
- **Migration** — set `payment_processor = 'none'` on the demo + existing beta salons (one-off
  `config.set` via the authed mutate path, per the seeder technique).

## 5. Out of scope

- Per-salon card processing (Phase 3) — unchanged, deferred.
- A hard Worker-level charge block for manual-mode salons — owner chose the default-to-manual
  guardrail (soft: the button is gone); the hard server guard stays a Phase-3 safety item.
- Change-making / cash-received math beyond one-tap-at-total (the "Adjust amount" link covers
  the edge; full change UX is a later nicety).

## 6. Testing + rollout

- **Unit:** the tender→record mapping already has coverage via existing pay tests; add a small
  test that manual mode's `markPaidManual('card')` produces a record with `tenders.card = total`
  (pure-ish; assert the payload handed to finalize).
- **Browser (ship-then-verify-live, as with M1 — the driving browser can't reach localhost):**
  a manual-mode salon's Confirm Payment shows chips + Mark paid (no terminal button); paying via
  each tender records the sale and it shows in the right report bucket; a processor-set salon is
  unchanged.
- **Version bump trio** (`config.js`/`version.json`/`sw.js`) + push (Pages) + the migration
  `config.set`, owner-gated.
</content>
