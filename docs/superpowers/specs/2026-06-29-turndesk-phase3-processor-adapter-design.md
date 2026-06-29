# TurnDesk Phase 3 — Per-tenant processor adapter

- **Date:** 2026-06-29
- **Status:** Planning (design for review; not built). Elevated to near-term per owner.
- **Builds on:** Phase 0 (per-salon DO), Phase 2 (provisioning). Today Muse/TurnDesk is single-processor Helcim with a Square legacy path selected by `config.payment_processor`; `features/square-pos.js` routes the card step and `features/helcim.js` does the Helcim charge — so seams already exist.

## Goal
Make the card processor **per-salon and pluggable** so each tenant uses what it already has (Helcim now; Square legacy; Stripe later), behind one interface — without per-processor branching scattered through the checkout/refund/reports code.

## Decisions (proposed; flag any to change)
1. **One adapter interface, several implementations.** A small module per processor exposing the same shape; the checkout/refund code calls the interface, never a processor directly.
2. **Selection is per-tenant config** (`config.payment_processor` already exists per salon). The adapter registry maps that value → implementation.
3. **Each salon stores its own processor credentials/pairing in its own DO** (never cross-tenant): e.g. `config.helcim_device_code`, a per-tenant Helcim API token (server-side secret-per-tenant — see open decisions), Square token, etc.
4. **Webhooks become per-tenant:** the Helcim `/terminal/webhook` (today effectively single-salon) must identify the salon — each salon registers a webhook URL carrying `?salon=<slug>`, and the Worker verifies that salon's HMAC secret. Same for any Stripe/Square webhooks.
5. **Ship Helcim + Square (migrate existing); Stripe = stub** until a real need (flag).

## Adapter interface (proposed)
A processor module exports:
- `capabilities()` → `{ terminal:bool, online:bool, refund:bool, partialRefund:bool, ... }`
- `createCharge({ salon, ticketId, amountCents, idempotencyKey, ... })` → `{ status, processorTxnId, raw }`
- `refund({ salon, originalTxnId, amountCents, idempotencyKey })` → `{ status, refundId, raw }`
- `status({ salon, processorTxnId })` → normalized status
- `handleWebhook({ salon, request })` → verify signature, normalize, return the event to broadcast
- (capture details where relevant, e.g. HelcimPay.js `verify` for card-on-file — shared with Phase 4 billing)

Client + Worker both have a thin registry: `getAdapter(salon.config.payment_processor)`.

## Migration plan (incremental, behavior-preserving)
1. Define the interface + a `HelcimAdapter` that **wraps today's `helcim.js`** exactly (no behavior change); route the existing card step through it. Verify the demo + a live Helcim charge still work.
2. Wrap the legacy Square path as `SquareAdapter` behind the same interface; keep `payment_processor` selection.
3. Move the refund path (`reports.js confirmRefund`) to call `adapter.refund` instead of branching on processor.
4. Per-tenant webhook routing + HMAC (`?salon=` on the webhook URL; per-salon secret).
5. `StripeAdapter` stub (interface only) for later.

## Cross-cutting (do alongside this phase)
- **DO WebSocket Hibernation** rewrite (`state.acceptWebSocket()` + hibernation handlers) — required before real multi-tenant traffic to avoid continuous DO-duration billing at DO-per-tenant scale. Natural to tackle in the same payments-touching phase. (See [[incident-do-free-tier-offline]].)

## Open decisions for the owner
- **Per-tenant Helcim API token storage:** Worker secrets are global, not per-tenant. Options: store each salon's Helcim API token in its DO (encrypted-at-rest by DO storage; acceptable?) vs a single TurnDesk-platform Helcim token with per-merchant sub-accounts (depends on Helcim's multi-merchant model — needs research). **This is the key unknown** and should be resolved before building.
- How a salon **connects/pairs its own Helcim** through the onboarding UI (device code entry + token).
- Which processors at launch (Helcim + Square confirmed; Stripe stub now or skip?).
- Whether in-salon payments and the Phase-4 SaaS billing share one Helcim integration path or stay separate modules.

## Success criteria
- Checkout/refund code calls the adapter interface only; no processor-specific branching outside the adapter modules.
- A salon set to Helcim and a salon set to Square each take/refund a payment correctly, fully isolated, using their own credentials.
- Per-tenant webhooks verify and route to the right salon.
- Demo salon + existing Helcim behavior unchanged after the Helcim migration step.

## Note
This phase touches a high-risk system (real money). Each migration step must be verified against a live test charge before the next, exactly as the Phase 0 auth work was verified. The per-tenant Helcim token model (open decision above) is the gating unknown — resolve it first.
