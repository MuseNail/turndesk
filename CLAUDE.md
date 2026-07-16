# Claude — AI Coding Instructions for TurnDesk

This file contains rules and context for AI coding assistants working on this project. Read it before making any changes.

---

## ⭐ Working agreement (owner's standing rules — always apply)

These govern HOW to work, on top of everything else in this file:

1. **Explain both ways.** Always give the technical explanation AND a plain-English version for a non-technical owner.
2. **Criticize, don't comply.** Never blindly agree. Review the owner's input coldly and objectively — push back, surface tradeoffs, and go back and forth until there's a shared understanding and a genuinely good result.
3. **Quality over speed.** Always prefer the correct, root-cause solution. Never ship a band-aid unless the owner expressly asks for one.
4. **Plan before code.** For any non-trivial change, draft a written plan first; have it adversarially reviewed by subagents (grounded in the real code); rewrite it from the findings; then **get the owner's sign-off before coding.**
5. **Review before presenting.** After coding, and BEFORE showing the owner, run three review-only subagents — (a) line-by-line correctness, (b) subject-matter/necessity, (c) cosmetics/ergonomics — then a final senior-engineer pass; apply fixes between rounds; report the iterations.

Rules 4–5 are packaged as the **`rigorous-build`** skill — invoke it for any non-trivial code change or substantial task (trivial mechanical edits still get the correctness check). Rules 1–3 apply to every response, always.

---

## What This Is

**TurnDesk** is the public, **multi-tenant SaaS** version of a live single-salon app (`musedashboard`). It is a nail-salon front-desk PWA: check-in queue, a fair-rotation "turns" engine, floor plan, reports, payroll, gift cards, and **pluggable payment processors** (Square / Stripe / Helcim) — each salon connects whichever processor it already uses.

This repo was forked from `musedashboard` (a clean file copy, **no git history**) on 2026-05-28.

---

## ⚠️ Isolation from the live salon — the one unbreakable rule

The original `musedashboard` app is **live in a real salon and must never be touched** by TurnDesk work. TurnDesk is a completely separate:
- **GitHub repo** — `github.com/MuseNail/turndesk` (served at `musenail.github.io/turndesk/`)
- **Cloudflare resources** — its own Worker (`turndesk`), its own per-tenant Durable Object class (`TurnDeskDO` — a distinct storage namespace from the salon's `MuseSalonDO`), and its own R2 bucket (`turndesk-photos`). Live at `https://turndesk.musenailandspa.workers.dev`.
  - **Note (2026-05-28):** these live *inside the existing `info@musenailandspa.com` Cloudflare account*, NOT a separate account. The original plan called for a separate account, but Cloudflare requires a unique email per account. Data is still fully isolated (separate Worker + DO class + bucket); only the billing login is shared. Splitting into a dedicated account later needs a different email (e.g. an `info+turndesk@…` alias) — see open follow-ups.

### Shared-origin gotcha (already handled — keep it this way)
GitHub Pages serves both apps from the **same origin** (`musenail.github.io`), and `localStorage` / the service-worker `CacheStorage` are scoped **per-origin, not per-path**. To stop the two apps colliding in a browser, every TurnDesk browser-storage key is namespaced **`turndesk_*`** (was `muse_*`), the Google token keys are `turndesk_gcal_*`, and the SW cache is `turndesk-vX.YZ`. **Never reintroduce a `muse_*` storage key.** (This collision disappears once TurnDesk moves to its own domain, but the namespacing is correct regardless.)

---

## Architecture (inherited from musedashboard v3)

- **No build step, no frameworks.** Plain ES2020+ **native ES modules** in the browser (Tailwind CDN only). GitHub Pages serves files as-is.
- **Entry points:** `index.html` → `<script type="module" src="js/app/main.js">`; staff app → `js/app/staff.js`.
- **`window` glue:** `main.js` attaches feature-module exports to `window` so inline `onclick=` markup keeps working.
- **Backend:** a Cloudflare **Worker** (`cloudflare/worker.js`) with a **Durable Object** (`TurnDeskDO`) as the source of truth. The client syncs over WebSocket + `/state` HTTP fallback with an offline outbox via `dispatch(op, payload)`.

### Multi-tenancy (the TurnDesk evolution)
- **One Durable Object instance per salon (tenant)**, keyed by tenant id. The seam already exists in `worker.js`: `const salonId = url.searchParams.get('salon') || 'demo'`, then `env.SALON_DO.idFromName(salonId)`.
- Full multi-tenancy (real auth/accounts, signup auto-provisioning, tenant routing by account/domain rather than `?salon=`) is the **P3** stage — not yet built. The default tenant is `demo`.

### Module layout
- **Core:** `js/app/main.js`, `store.js` (in-memory state + `applyChange` reducer), `sync.js` (WebSocket/HTTP sync + `dispatch` + outbox), `session.js`, `config.js`, `utils.js`.
- **Features:** `js/app/features/*.js` — auth, photos, catalog, square-*, staff, checkin, status, queue, turns, reports, giftcards, settings, calendar, floorplan, appearance, servicetime, chat, appt-reminders, recovery, audit, **billing** (Settings → Business → Billing; hidden until the operator's `selfserveBillingEnabled` flag is on).
- **SaaS billing (Phase 1, 2026-07-16 — built, NOTHING enforced):** plans/accounts/flags live in the **registry DO** (`bplan:<planId>` versioned plans, `billing:<accountId>`, `bflags`), Worker logic in `handleBilling` (salon-scoped, owner/admin-only, appadmin denied) + `/operator/billing/*` (operator console Billing card) in `cloudflare/worker.js`. **Poll-first — no billing webhooks exist** (Helcim has no subscription events and the shared account's webhook URL points at Muse's Worker); truth = Helcim `GET subscription → payments[]`, reconciled on view via the pure idempotent `reconcileAccount`. Both flags (`selfserveBillingEnabled`, `enforcementEnabled`) default OFF; enforcement/feature-gating is Phase 2, deliberately unbuilt. Design: `docs/superpowers/specs/2026-07-15-turndesk-saas-billing-design.md` (+ §10 addendum); plan: `docs/superpowers/plans/2026-07-16-saas-billing-phase1.md`.

---

## Build sequence (P0 → P5)

- **P0 — Fork + isolate + blank twin** *(DONE — Worker deployed & verified empty 2026-05-28; remaining: enable GitHub Pages)*. Fresh repo, rebased paths, namespaced storage keys, de-branded, renamed Worker/DO/bucket. Worker live at `https://turndesk.musenailandspa.workers.dev`; `/state/snapshot` confirmed empty (`seq:0`, no records/queue) → zero contact with the live salon.
- **P1 — Payments adapter + Helcim.** Define a common adapter interface (`createCheckout / refund / handleWebhook / status`); move Square → `SquareAdapter`; build **`HelcimAdapter` FIRST** (Smart Terminal API: pair via device code, charge, refund, webhook); stub `StripeAdapter`.
- **P2 — Choose-your-processor.** Per-tenant settings to pick + connect the active processor.
- **P3 — Multi-tenancy + accounts.** Tenant id → DO routing; real auth/accounts (email/OAuth, roles, tokens — replaces PIN-only); signup auto-provisions a tenant DO + config; zero cross-tenant leakage.
- **P4 — Billing + onboarding.** Stripe subscriptions (plans/trials/dunning/lock-on-decline); self-serve onboarding + owner admin console.
- **P5 — Public polish.** Accessibility (WCAG/ADA), marketing site, docs, DR/SLA + status page, observability/support.

---

## Open follow-ups

- **Domain migration (owner-agreed sequencing, 2026-07-14):** landing page → Cloudflare Pages @ `turndesk.net`
  → per-salon path URLs, in that order, each its own effort. The old `musenail.github.io/turndesk/` link
  stays live indefinitely (Krystal Nails Lounge's current link, and the safety net during transition) — it
  is never auto-decommissioned by this work. Full plan, key finding (the cross-salon "sign in → your salon"
  login already exists and ships today — don't rebuild it), and non-goals →
  `docs/superpowers/plans/2026-07-14-turndesk-domain-migration.md`.
- **Enable GitHub Pages** — repo Settings → Pages → deploy from `main` branch, so the twin serves at `musenail.github.io/turndesk/`. (Last P0 step.)
- **VAPID Web Push keypair** — `config.js` `VAPID_PUBLIC_KEY` + `wrangler.toml` `[vars]` still hold musedashboard's public key, and no `VAPID_PRIVATE_KEY` secret is set on the turndesk Worker yet, so Web Push is inert. Generate a fresh keypair and `wrangler secret put VAPID_PRIVATE_KEY` before relying on push.
- **Google OAuth client** — `js/app/features/calendar.js` `GCAL_CLIENT_ID` is musedashboard's. Create a TurnDesk Google Cloud OAuth client before the Calendar feature is used in production.
- **Dedicated Cloudflare account (optional, later)** — currently runs in the shared `info@musenailandspa.com` account. To split billing/ownership, create a new account under a different email (e.g. `info+turndesk@…` alias) and re-deploy there.

---

## Standing working rules

- **Commit freely, but ASK before every `git push`.** Never run `wrangler deploy` or `wrangler secret put` — those are the owner's job.
- **Bump all three version files together:** `js/app/config.js` (`APP_VERSION`), `version.json`, and `sw.js` (`CACHE_NAME`). A mismatch causes reload loops; a stale `CACHE_NAME` serves stale files.
- **Verify each change** (preview / `node --test` / `node --check cloudflare/worker.js`) before committing. Keep changes staged and reviewable.
- Plain ES modules, no build step, no frameworks (Tailwind CDN) — unless we deliberately decide otherwise for the product.
- Card data must never touch the app (keep PCI scope light across all payment adapters).

---

## High-Risk Systems

- **`dispatch` / `applyChange` / DO sync** (`sync.js`, `store.js`, `cloudflare/worker.js`) — the write path for all state.
- **Records merge** (`store.js` `upsertById`) — transaction records are financial data; always merge by id.
- **`ticketTotal`** (`utils.js`) — single source of truth for a ticket's money.
- **Per-tenant DO routing** (`worker.js` `salonId`) — a bug here could leak data across salons. Treat tenant isolation as critical from P3 onward.
- **SaaS billing flags + subscribe paths** (`worker.js` `handleBilling` / `/operator/billing/*`) — flipping `selfserveBillingEnabled` or calling subscribe creates REAL recurring charges on real salons' cards/banks; the pricing page's "no card on file" promise must be rewritten before either flag turns on.
- **Version bump** — `config.js` / `version.json` / `sw.js` must stay in sync.

---

## Section Markers

Each JS section begins with `// ── Section Name ────` (Unicode U+2500 box-drawing). Follow this convention for new sections.
