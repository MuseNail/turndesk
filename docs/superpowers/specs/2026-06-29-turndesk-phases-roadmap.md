# TurnDesk productization — phases 2–6 roadmap

- **Date:** 2026-06-29
- **Status:** Planning (owner asked to plan the next phases; **no building yet**)
- **Repo/Worker:** `turndesk` (account info@musenailandspa.com `7e47…fb62`), main-only pre-release
- **Builds on:** Phase 0 (LIVE) — current-Muse overlay, one-DO-per-salon, slug routing (`?salon=`/`X-Salon`), staff PIN + owner email/password login, seeded demo salon. See `2026-06-28-turndesk-phase0-foundation-design.md`.

## Owner decisions captured (2026-06-29)
- **Plan only for now** — write specs/plans; owner reviews before any build.
- **Processor adapter is near-term**, not deferred (elevated to Phase 3).
- **Billing via Helcim** (not Stripe). Confirmed capable: Helcim has a Recurring/Subscription API, card-on-file vault (HelcimPay.js `verify`), customer portal for card updates, expiry notices, and failed-payment retry. Tradeoff: less turnkey than Stripe Billing (build more plan-management UX; US/CA only).
- **Deploy posture when building:** additive changes may deploy as we go (new routes shouldn't disturb the demo); never touch demo data mid-test.

## Two distinct money flows (keep separate — they cause the most confusion)
1. **Salon → its customers** (in-salon card payments at checkout). Per-tenant processor. Owned by **Phase 3 (adapter)**.
2. **TurnDesk → the salons** (monthly SaaS subscription). Owned by **Phase 4 (billing)**. Per the owner, this also runs on Helcim (TurnDesk's own Helcim account vaults each salon-owner's card and charges a recurring plan).

## Phase order, scope, dependencies

### Phase 2 — Provisioning + operator console  *(next; fully unblocked)*
Let the operator (you) create and manage salons without hand-running the seed script.
- **Salon registry:** a dedicated registry DO (`REGISTRY_DO.idFromName('_registry')`) holding `salon:<slug>` → `{ slug, name, createdAt, status:'active'|'disabled', ownerEmail, plan }`. Separate from per-salon DOs; the only cross-salon index.
- **Operator auth:** a distinct operator credential (not a salon login) — an `OPERATOR_TOKEN` secret to start (single operator = you), validated on all `/operator/*` routes. (A multi-operator login is a later nicety.)
- **Provision a salon:** `POST /operator/salons` → validate slug is unique + URL-safe, create the registry entry, seed the new salon's DO with starter config (empty menu/staff or a template), set the owner credential (reuse `/auth/owner-set`). Disable/enable toggles `status`; a disabled salon's logins + sync are refused by `appAuthOk`.
- **Operator console UI:** a new `operator.html` (or `/turndesk/admin`) — list salons, create-salon form, disable/enable, "open this salon" link, reset-owner-password. Operator-token gated.
- **Detailed spec:** `2026-06-29-turndesk-phase2-provisioning-design.md`.

### Phase 3 — Processor adapter  *(elevated per owner)*
Make the payment processor per-tenant and pluggable so each salon uses what it already has.
- **Adapter interface** (one shape, several implementations): `createCharge`, `refund`, `status`, `handleWebhook`, `capabilities`. Implementations: `HelcimAdapter` (migrate today's in-repo Helcim code into it), `SquareAdapter` (migrate the legacy Square path), `StripeAdapter` (stub/later).
- **Per-tenant selection:** `config.payment_processor` already exists per salon; the adapter layer reads it and routes the card step. Each salon stores its own processor credentials/device pairing in its DO (never cross-tenant).
- **Webhooks:** the Helcim `/terminal/webhook` must carry the salon (today it's effectively single-salon) — include `?salon=` in the per-tenant webhook URL each salon registers, and verify HMAC per-tenant.
- **Detailed spec:** `2026-06-29-turndesk-phase3-processor-adapter-design.md`.
- **Open decisions:** which processors at launch (Helcim + Square confirmed present; Stripe stub?); per-tenant Helcim API token storage + rotation; how a salon connects/pairs its own Helcim device through the UI.

### Phase 4 — Billing via Helcim  *(SaaS subscriptions from salons)*
Collect TurnDesk's monthly fee from each salon.
- **Plans:** per-location tiers from the productization plan — Starter $39–49 / Pro $79–99 / Multi $149+ (confirm exact prices). Stored in the registry entry (`plan`, `billingStatus`, `currentPeriodEnd`).
- **Card capture:** HelcimPay.js initialized with `paymentType:'verify'` to vault the owner's card (no PAN touches TurnDesk). Store the Helcim customer/card token in the registry (not the salon DO).
- **Recurring:** create a Helcim payment plan per tier; subscribe the salon via the Recurring API; store the subscription id.
- **Lifecycle:** webhook/poll for payment success/failure; on repeated failure → `status:'past_due'` then `disabled` (gates the app via `appAuthOk` + registry status). Card-update via Helcim's customer portal link.
- **Open decisions:** exact prices + trial length; grace period before disable; annual option; how taxes are handled; dunning copy.

### Phase 5 — Public self-serve signup + onboarding  *(ties Phase 2 + Phase 4)*
Let an owner register a salon themselves.
- **Signup:** public page → choose slug + plan → owner email/password → Phase 4 card capture → Phase 2 provision (registry + DO seed + owner credential) → land in an onboarding wizard (business name/logo, menu template, add staff, connect processor via Phase 3).
- **Open decisions:** open self-serve vs invite/approval; free trial vs card-required-upfront; abuse/slug-squatting guardrails; email verification (no email infra yet).

### Phase 6 — White-label / subdomains
- Per-salon branding (logo/name/colors/review URL — mostly already config-driven) and nicer addresses: `app.turndesk.app/<slug>` path routing first; true `<salon>.turndesk.app` subdomains need a wildcard custom domain + edge routing on the Worker. Custom domains per salon are a premium add-on.
- **Open decisions:** buy `turndesk.app`?; path vs subdomain; per-salon custom domains.

## Cross-cutting / tech debt to address during these phases
- **DO WebSocket Hibernation** (from [[incident-do-free-tier-offline]]): `TurnDeskDO` holds a WS open per client without the Hibernation API → bills DO duration continuously. At DO-per-tenant scale this is a cost/limit risk. Rewrite WS handling to `state.acceptWebSocket()` + hibernation handlers **before real multi-tenant traffic** (do it alongside Phase 3 or as its own small phase).
- **VAPID / Google OAuth** are still shared/!per-tenant where relevant — revisit for push + calendar per-salon when those features matter to tenants.
- **Inherited hanging tests** (`reports`/`staff`) — fix task already spawned.

## Build sequence summary
Phase 2 (provision/operator) → Phase 3 (adapter) + WS-hibernation → Phase 4 (Helcim billing) → Phase 5 (signup/onboarding) → Phase 6 (white-label). Each gets its own plan + review before building.
