# TurnDesk SaaS Subscription Billing (via Helcim) — Design

**Date:** 2026-07-15
**Status:** Approved by owner (brainstorm), pending written-spec review
**Author:** Claude (brainstorm session with owner)

---

## 1. Purpose

TurnDesk currently onboards salons as a **free beta** with manual checkout (`config.payment_processor = 'none'`) — there is no automated billing of the salons themselves. This design adds **recurring monthly SaaS billing**: TurnDesk salons pay TurnDesk a subscription fee, automatically, via card or bank account (ACH).

**This is unrelated to card-present payment processing** (how a salon charges *its own* customers — Helcim Terminal for Muse, or the separate Chase-for-Krystal-Nails question in `CHASE-PAYMENT-FEASIBILITY-2026-07-15.md`). This design is about TurnDesk-the-vendor charging TurnDesk-the-salon-customer for software access.

- *Plain English:* Right now, salons use TurnDesk for free. This adds the ability to actually charge them a monthly software fee, automatically, using the same Helcim account already used for Muse — the salon enters their card or bank info once, and it gets billed every month without anyone touching it manually.

## 2. Decisions made (from brainstorm)

| Question | Decision |
|---|---|
| Pricing model | **Tiered**, based on both capacity (stations/staff) and feature set |
| Tier definition | **Generic/configurable** (Option A) — plans defined via data (operator console), not hardcoded in code. New tier or price change = no deploy. |
| Who assigns tiers | **Hybrid** — salon self-serves standard upgrade/downgrade; operator console can override any salon's plan (comps, custom deals) |
| Existing beta salons | **14-day grace period** from migration date, same trial flow as new signups |
| New signups | **14-day free trial**, full access, payment info requested near the end |
| Failed payment handling | **3-day grace period** (retry + warning banner) then the app locks (read-only/blocked) until resolved |
| Payment methods | Card **or** ACH bank account, captured via HelcimPay.js "verify" mode (Helcim-hosted, TurnDesk never sees raw numbers) |
| Plan changes | Take effect at the **next billing cycle** — no proration in v1 (explicit simplification) |
| Where salon manages billing | New **Settings → Billing** section inside TurnDesk (view plan, upgrade/downgrade, update payment method, invoice history) — salon owner/admin role only |

## 3. Architecture

Reuses the same pattern as Muse's live Helcim Terminal integration (`js/app/features/helcim.js` + `cloudflare/worker.js` `/helcim/*`, `/terminal/webhook`): **proxy → HMAC-verified webhook → Durable Object state → broadcast**. Here it's driven by Helcim's **Recurring API** instead of the Smart Terminal.

- **Same Helcim merchant account** as Muse. TurnDesk subscribers get a distinct namespace in Helcim's Customer API (`customerCode: td-<salon-slug>`) so they never collide with Muse's own POS customer records.
- **Payment Plans**: created/edited via the operator console (not hardcoded), each with `price`, `billingFrequency`, `capacity` limits, `features` flags, `trialDays`.
- **Subscription state**: new DO entity per salon, `billing:<bizId>`, mirrors Helcim's subscription/customer for fast in-app gating and the Billing UI. Helcim remains the source of truth for the actual charge.
- **New Worker routes:**
  - `GET /billing/plans` — list available plans
  - `POST /billing/subscribe` — create/change a salon's Helcim subscription
  - `POST /billing/webhook` — HMAC-verified, receives Helcim recurring-billing events
  - `POST /billing/portal-token` — issues a HelcimPay.js "verify" session for capturing/updating card or ACH details
- **Enforcement middleware**: alongside the existing `appAuthOk` gate, checks `billing:<bizId>.status` and blocks/read-only-locks salons past their grace window.
- **Operator console (`operator.html`) additions**: Billing tab — per-salon status/plan, extend trial, force plan change, mark comped (permanent free, exempt from enforcement), force unlock, and Payment Plan CRUD.

## 4. Data model

**Payment Plan** (Helcim + mirrored in DO for display):
```
{
  planId, name,
  price, billingFrequency: "monthly",
  capacity: { maxStations, maxStaffAccounts },
  features: { calendar: bool, sms: bool, reports: "basic"|"advanced", ... },
  trialDays: 14
}
```

**Salon subscription record** (`billing:<bizId>` in the DO):
```
{
  bizId, planId,
  status: "trialing" | "active" | "past_due" | "locked" | "canceled" | "comped",
  trialEndsAt, currentPeriodEnd,
  paymentMethodType: "card" | "ach",
  helcimCustomerId, helcimSubscriptionId,
  pastDueSince,                 // set on first failed charge; drives the 3-day grace clock
  history: [ {event, at, note} ] // plan changes, failures, overrides — feeds the operator console
}
```

Feature flags and capacity limits are read from the salon's *current plan* at runtime, not hardcoded per tier name.

## 5. Key flows

**A) New salon signs up** — DO creates `billing:<bizId>` with `status: "trialing"`, `trialEndsAt = now + 14d`. Full access during trial, no `helcimCustomerId` yet.

**B) Trial nears its end** — App prompts payment info via HelcimPay.js "verify" mode (card or bank, tokenized, set as Helcim default payment method) and plan selection/confirmation.

**C) Trial ends, first charge** — TurnDesk calls Helcim's Create Subscription endpoint. Helcim auto-charges on schedule from here forward. `status → "active"`.

**D) A charge fails** — Helcim webhook → `status: "past_due"`, `pastDueSince = now`, in-app banner. Unresolved after 3 days → `status: "locked"`. Salon fixes payment method → next retry succeeds → `status: "active"`, unlocked.

**E) Upgrade/downgrade** — Salon changes plan in Settings → Billing → Helcim subscription updated to new plan, effective next billing cycle (no proration). Operator console can force a plan change for any salon, bypassing self-serve.

**F) Existing beta salons** — One-time migration script sets every currently-live salon to `status: "trialing"`, `trialEndsAt = migrationDate + 14d` — same trial flow as (B)/(C) from there.

## 6. Error handling & edge cases

- **Webhook idempotency**: Helcim can redeliver events; dedupe by event ID before mutating `billing:<bizId>` (same discipline as the existing Terminal webhook handler).
- **Late ACH returns**: ACH payments can settle, then bounce days later (insufficient funds, closed account). A late "returned" webhook must be handled identically to a failed charge even if `status` currently shows `"active"`.
- **Cancellation**: `status: "canceled"` is distinct from `"locked"` so a canceled salon can't be accidentally reactivated by a stray retry.
- **Isolation**: every `/billing/*` route is scoped to `bizId` and membership-gated (same multi-tenant isolation pattern already enforced elsewhere in the Worker) — one salon can never see or touch another's billing.

## 7. Explicit non-goals for v1

- No proration on mid-cycle plan changes.
- No annual billing option.
- No self-serve cancellation flow beyond what's described (can be added later without redesign).
- No multi-currency support (matches Muse's current single-currency assumption).

## 8. Open items for the implementation plan

- Exact Helcim Recurring API endpoint names/payloads for create/update subscription and set-default-payment-method (needs a focused docs read during planning, not brainstorming).
- Whether ACH is already toggled on in the shared Helcim account's Settings → Payments, or needs enabling.
- Exact wording/UX of the 3-day past-due banner and the lock screen.
- Migration script mechanics for existing beta salons (which salons, what migration date).
