# TurnDesk Phase 0 — Foundation refresh, multi-salon base, demo salon

- **Date:** 2026-06-28
- **Status:** Approved design (brainstorm complete; build authorized on autopilot)
- **Repo:** `turndesk` (MuseNail/turndesk), main-only (pre-release)
- **Worker:** `turndesk` (Cloudflare account `7e47fe5134a4b77582cf7746bff3fb62` — info@musenailandspa.com). Always `wrangler whoami` to confirm the account before any deploy.

## Background & decision

Muse (`musedashboard`) is the live single-salon PWA, now **v5.35**. TurnDesk was forked from Muse at **v3.67** (2026-05), paused, and previously marked "superseded." **Decision (2026-06-28): revive TurnDesk as the productization vehicle, rebuilt from the current Muse codebase, in phases.** This spec covers **Phase 0 only**.

## Goal

TurnDesk becomes an up-to-date copy of Muse that can host **multiple salons, each fully isolated**, with **hardened salon-scoped sign-in**, plus a **richly-seeded demo salon** ("Lush Nails & Spa") for sales demos.

## Key architecture findings (already in the codebase)

- The Worker **already routes per-salon**: `salonId = url.searchParams.get('salon') || <default>` then `env.SALON_DO.idFromName(salonId)` — one Durable Object instance per salon.
- §13 auth: a PIN login mints a `sess:` token **inside that salon's DO**; `appAuthOk(request, url, env, salonId)` validates against that same DO. **Tokens are per-salon** — a token minted for salon A cannot authenticate against salon B. Cross-tenant isolation is therefore **already enforced** by the auth + DO model.
- The client today **never sends `?salon=`** and hardcodes `ORIGIN`, so in practice it is single-tenant.

## Decisions (locked)

1. Build on the **existing** turndesk repo + Worker + provisioned DO/R2/KV. No re-provisioning.
2. **Isolation:** one Durable Object per salon (`idFromName(slug)`). Already the mechanism.
3. **Tenant resolution — token-bound.** DO name = salon slug. Login = slug + credential; the minted token is bound to the slug. The client sends `?salon=<slug>` on every request (WebSocket + HTTP); the Worker routes by it; the token only validates against that salon's DO.
4. **Sign-in hardening:**
   - **Per-salon link** pre-fills the slug (`…?salon=demo`). Staff enter only their PIN; no salon-picker is exposed to outsiders.
   - **Staff → PIN** (existing). **Owner/Manager → email + password (NEW)**, stored hashed in that salon's DO.
   - Owner login happens **on the salon's own page** (slug already known from the link). **No global owner directory** in this phase.
   - Keep §13 **per-IP escalating slow-down** for both PIN and password attempts.
5. **Remove the silent salon default** in the Worker → a missing/unknown slug returns an explicit error (no accidental cross-wiring).
6. **Demo salon "Lush Nails & Spa", slug `demo`:**
   - ~35 days of history ending today; 6–8 techs, 3–4 front-desk, a few hundred customers, 15–25 sales/day (weekend-heavier), a realistic generic nail menu, tips ~15–20%, ~60% card / ~35% cash / occasional gift card; daily turns history; a few gift cards; daily cash-drawer shifts.
   - Owner account: **owner@demo.turndesk.app** + a generated starter password (handed to the owner, changeable in-app).
   - Appointment book intentionally **empty** (Google-calendar-backed; deferred).
   - Built by a **re-runnable generator** so it can be refreshed/re-dated later.
7. Product shell stays branded **TurnDesk**; only the *salon's* business name is the demo brand.

## Out of scope (later phases, each its own spec)

Operator screen to create salons; public signup/onboarding + global owner directory; billing/subscriptions; per-salon processor choice (adapter layer); subdomain / white-label.

## Work breakdown

### A. Foundation overlay
- Copy current Muse app code (`js/`, `css/`, `*.html`, `sw.js`, `icons/`) onto turndesk.
- **Reconcile the DO class name:** the turndesk binding declares class `TurnDeskDO` (migration tag `v1`, `new_sqlite_classes=["TurnDeskDO"]`); Muse's worker exports its own DO class name. Since turndesk has **no data**, align the overlaid worker's exported DO class to `TurnDeskDO` so the binding + migration stay valid. Verify the migration tag still matches after the overlay.
- **Re-apply identity:** keep turndesk `wrangler.toml`; `config.js` `ORIGIN` → turndesk worker; `manifest.json` name/short_name/icons = TurnDesk; bump the TurnDesk version line + `sw.js` `CACHE_NAME` together.
- Carry-forward check: the v3.67 "multi-line appt notes" tweak — verify against v5.35 and carry only if missing (likely already present or moot post-overlay).

### B. Client tenant plumbing
- Persist the salon slug per device (`localStorage` `td_salon`), seeded from `?salon=` on first load (the per-salon link).
- Extend the `apptoken.js` fetch wrapper + the `sync.js` WebSocket URL builder to append `?salon=<slug>` wherever `?auth=` is already added — one central change.
- `serverLogin` sends the slug.

### C. Salon-scoped login + owner email/password
- **Worker `authLogin`:** accept either `{slug, pin}` (staff) or `{slug, email, password}` (owner). Resolve the DO by slug. Validate the PIN against the existing `fd_users`/`staff` path, **or** the email+password against a new owner credential store in the DO. Mint a `sess:` token bound to the slug. Keep the slow-down.
- **DO owner credential store:** email + hashed password (WebCrypto PBKDF2 + per-user salt), role owner/manager. Set/verify helpers. Never store or return plaintext.
- **Login UI** (`auth.js` + `index.html`/`staff.html` as needed): show the salon name (from slug), PIN entry by default, plus an "Owner sign-in" toggle → email + password fields. `serverLogin` variants.
- **Remove silent default:** the Worker returns an explicit 400/404 when the slug is missing/unknown.

### D. Demo salon generator
- A **re-runnable** generator (Node script, or a Worker route guarded by `RESTORE_TOKEN`) that writes into the `demo` DO via the dispatch ops / `/state/mutate` path: config (salon name, service menu, fees, staff, `fd_users`, `turns_order`, owner credential), customers (`customer.bulkUpsert`), sales records across ~35 days, turns history, gift cards, cash-drawer shifts.
- Realistic distributions, varied per day/tech; dates relative to "today" at run time.

### E. Deploy + verify
- `wrangler whoami` → confirm the **info@musenailandspa.com** account, then `wrangler deploy` the turndesk worker. Set any needed secrets (`wrangler secret put`).
- Run the generator against `demo`.
- Verify: load TurnDesk `?salon=demo`; sign in as owner (email/password) and as a staff PIN; confirm Reports / Payroll / Customers / Turns are populated; confirm a different slug (e.g. `?salon=other`) is empty/isolated and that a `demo` token is rejected there.

## Risks & mitigations
- **DO class-name mismatch on overlay** → align the exported class to `TurnDeskDO`; no data, so safe; verify the migration tag.
- **`AUTH_ENFORCED` gating the seed** → seed via a `RESTORE_TOKEN`-gated route, or seed before enabling enforcement and enable after.
- **Password hashing in Workers** → WebCrypto PBKDF2 (no external deps; preserves the no-build-step rule).
- **Date staleness** → generator is re-runnable to refresh.
- **Wrong Cloudflare account** → always `wrangler whoami` first (owner's explicit instruction).

## Success criteria
- TurnDesk runs current-Muse features under slug `demo`.
- Owner email+password and staff PIN both work, scoped to `demo`.
- Reports show ~a month of activity; Payroll, Customers, Turns are populated.
- A different slug is empty and isolated; a `demo` token is rejected there.
- A duplicate PIN across two slugs grants no cross access.
