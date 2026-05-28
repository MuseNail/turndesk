# Claude — AI Coding Instructions for TurnDesk

This file contains rules and context for AI coding assistants working on this project. Read it before making any changes.

---

## What This Is

**TurnDesk** is the public, **multi-tenant SaaS** version of a live single-salon app (`musedashboard`). It is a nail-salon front-desk PWA: check-in queue, a fair-rotation "turns" engine, floor plan, reports, payroll, gift cards, and **pluggable payment processors** (Square / Stripe / Helcim) — each salon connects whichever processor it already uses.

This repo was forked from `musedashboard` (a clean file copy, **no git history**) on 2026-05-28.

---

## ⚠️ Isolation from the live salon — the one unbreakable rule

The original `musedashboard` app is **live in a real salon and must never be touched** by TurnDesk work. TurnDesk is a completely separate:
- **GitHub repo** — `github.com/MuseNail/turndesk` (served at `musenail.github.io/turndesk/`)
- **Cloudflare account** — separate account under the same email login; its own Worker, per-tenant Durable Object, R2 bucket (`turndesk-photos`), KV, and secrets.

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
- **Features:** `js/app/features/*.js` — auth, photos, catalog, square-*, staff, checkin, status, queue, turns, reports, giftcards, settings, calendar, floorplan, appearance, servicetime, chat, appt-reminders, recovery, audit.

---

## Build sequence (P0 → P5)

- **P0 — Fork + isolate + blank twin** *(IN PROGRESS)*. Fresh repo, rebase paths `/musedashboard/` → `/turndesk/`, namespace storage keys, de-brand, rename Worker/DO/bucket. New Cloudflare account + Worker + per-tenant DO + R2/KV + secrets. Deploy an empty working twin and verify zero contact with the live salon.
- **P1 — Payments adapter + Helcim.** Define a common adapter interface (`createCheckout / refund / handleWebhook / status`); move Square → `SquareAdapter`; build **`HelcimAdapter` FIRST** (Smart Terminal API: pair via device code, charge, refund, webhook); stub `StripeAdapter`.
- **P2 — Choose-your-processor.** Per-tenant settings to pick + connect the active processor.
- **P3 — Multi-tenancy + accounts.** Tenant id → DO routing; real auth/accounts (email/OAuth, roles, tokens — replaces PIN-only); signup auto-provisions a tenant DO + config; zero cross-tenant leakage.
- **P4 — Billing + onboarding.** Stripe subscriptions (plans/trials/dunning/lock-on-decline); self-serve onboarding + owner admin console.
- **P5 — Public polish.** Accessibility (WCAG/ADA), marketing site, docs, DR/SLA + status page, observability/support.

---

## Open P0 follow-ups (placeholders to fill)

- **Worker URL** — `js/app/config.js` (`ORIGIN`) and `js/app/sync.js` (`PROD_ORIGIN`) contain `https://turndesk.REPLACE-ME.workers.dev`. Replace `REPLACE-ME` with the new Cloudflare account's `workers.dev` subdomain after the first deploy.
- **VAPID Web Push keypair** — `config.js` `VAPID_PUBLIC_KEY` + `wrangler.toml` `[vars]` still hold musedashboard's public key. Generate a fresh keypair for the new account and set `VAPID_PRIVATE_KEY` as a secret in the new Worker.
- **Google OAuth client** — `js/app/features/calendar.js` `GCAL_CLIENT_ID` is musedashboard's. Create a TurnDesk Google Cloud OAuth client before the Calendar feature is used in production.

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
- **Version bump** — `config.js` / `version.json` / `sw.js` must stay in sync.

---

## Section Markers

Each JS section begins with `// ── Section Name ────` (Unicode U+2500 box-drawing). Follow this convention for new sections.
