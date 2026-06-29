# TurnDesk Phase 2 — Salon provisioning + operator console

- **Date:** 2026-06-29
- **Status:** Planning (design for review; not built)
- **Builds on:** Phase 0 (multi-salon DO routing, `/auth/owner-set`, `appAuthOk`, slug guard).

## Goal
Let the operator (you) create and manage salons from a UI — provision a new tenant, set its owner login, and disable/enable it — without hand-running the seed script.

## Decisions (proposed; flag any to change)
1. **Registry lives in a reserved DO instance.** Reuse the existing `SALON_DO` binding with a reserved name `__registry__` (no new binding, no migration). It holds `salon:<slug>` → `{ slug, name, createdAt, status, ownerEmail, plan }`. Registry keys are not a `buildSnapshot` prefix, so they never reach salon clients. Salons may not use reserved slugs (`__registry__`, `admin`, `operator`, `api`, `assets`, `icons`).
2. **Operator auth = `OPERATOR_TOKEN` secret** (single operator = you, for now). All `/operator/*` routes validate it (Bearer or `?op=`); they are exempt from `appAuthOk` (self-gated) and from the missing-salon 400 guard (operator is cross-salon). A multi-operator login is a later nicety.
3. **Disabled salons are locked out** via the registry `status`. `authLogin` refuses to mint sessions for a disabled salon, and `appAuthOk` consults registry status (≈60s isolate cache, same pattern as the session cache) so existing sessions also stop working within a minute.
4. **Starter config on provision:** seed a small sensible default — a basic nail-service menu template + default `role_permissions` + empty staff/customers — so a new salon isn't blank, then the owner customizes. (Flag: blank vs template.)
5. **Operator console = a new `operator.html`** page (served at `/turndesk/operator.html`), separate from the salon app. Not linked from the salon UI.

## Architecture
- **Worker routes (new), all `OPERATOR_TOKEN`-gated, no salon required:**
  - `GET  /operator/salons` → list registry entries.
  - `POST /operator/salons` `{slug,name,ownerEmail,ownerPassword,plan}` → validate (unique, URL-safe `^[a-z0-9-]{3,32}$`, not reserved) → write `salon:<slug>` to the registry DO → seed the new salon DO's starter config (`config.set` for `services` template, `role_permissions`, etc.) → set owner credential (existing `/auth/owner-set` against that salon) → return `{ok, slug}`.
  - `POST /operator/salons/:slug/status` `{status}` → enable/disable.
  - `POST /operator/salons/:slug/owner` `{email,password}` → reset/replace owner credential (proxies `/auth/owner-set`).
- **Registry helpers in the DO:** `registryList()`, `registryGet(slug)`, `registryPut(entry)` operating on `salon:` keys of the `__registry__` instance.
- **Gating changes:** `appAuthOk` and `authLogin` gain a registry-status check (cached). Reserved-slug + format validation centralized in one helper used by provisioning (and later signup).
- **Operator console (`operator.html` + a small `js/app/operator.js`):** token prompt (stored `localStorage td_operator`, sent as `Authorization: Bearer`), salons table (name/slug/status/owner/plan/created + "open" link to `?salon=<slug>`), create-salon form, enable/disable buttons, reset-owner-password. Plain vanilla JS, app CSS classes; no framework.

## Work breakdown (for the plan)
1. Registry DO helpers + reserved-slug/format validator (+ unit tests via `node --test`).
2. `OPERATOR_TOKEN` gate + `/operator/*` routing in the Worker; exempt from `appAuthOk` and the salon guard.
3. `POST /operator/salons` provision flow (registry write + DO starter seed + owner-set) with validation + idempotency (re-provisioning an existing slug errors unless `?force`).
4. Disable/enable + registry-status enforcement in `authLogin` + `appAuthOk` (cached).
5. `operator.html` + `operator.js` console UI.
6. Verify: provision a 2nd salon, confirm it's isolated + owner can log in; disable it and confirm login + sync are refused within ~60s; reserved/duplicate/invalid slugs rejected.

## Risks / mitigations
- **Reserved-instance collision** — enforce reserved-slug list at provision AND in the salon guard so no salon can ever resolve to `__registry__`.
- **Registry-status check cost** — cache per isolate (~60s) keyed by slug, like the session cache; fail-open vs fail-closed: fail **open** on registry-unreachable (don't lock out a paying salon on a transient blip), but log it.
- **Operator token leakage** — token only in the operator's browser localStorage + over HTTPS; rotate via `wrangler secret put`. Never in the salon app bundle.
- **Provisioning partial failure** — order writes so a failure leaves no half-salon: write registry last (after DO seed + owner-set succeed), or mark `status:'provisioning'` until complete.

## Success criteria
- Operator can create a salon from the console; its owner logs in immediately; data is isolated from other salons.
- Disabling a salon blocks new logins and kills existing sessions within ~60s; re-enabling restores access.
- Invalid/duplicate/reserved slugs are rejected with clear errors.
- Salon clients never receive registry data; non-operators cannot reach `/operator/*`.

## Open decisions for the owner
- Starter config: blank vs a default nail-menu template (proposed: template).
- Plan field at creation: required now or filled in by Phase 4 billing later (proposed: optional now).
- Operator console address/name (`operator.html` vs `/admin`).
