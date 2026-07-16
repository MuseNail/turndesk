# TurnDesk SaaS Subscription Billing (via Helcim) — Design

**Date:** 2026-07-15 (rewritten 2026-07-16 after round-1 adversarial review + tier/pricing brainstorm; fixed 2026-07-16 after round-2 senior review)
**Status:** Two rounds of adversarial plan review complete, fixes applied. Pending owner sign-off before implementation planning.
**Author:** Claude (brainstorm + rigorous-build plan review with owner)

---

## 1. Purpose

TurnDesk currently onboards salons as a **free beta** with manual checkout (`config.payment_processor = 'none'`) — there is no automated billing of the salons themselves. This design adds **recurring monthly SaaS billing infrastructure**: TurnDesk salons pay TurnDesk a subscription fee, automatically, via card or bank account (ACH) — **built and ready, but not enforced**, until the owner flips a switch (see §6 Phase 2).

**This is unrelated to card-present payment processing** (how a salon charges *its own* customers). This design is about TurnDesk-the-vendor charging TurnDesk-the-salon-customer for software access.

- *Plain English:* This adds the ability to actually charge salons a monthly software fee, automatically, using the same Helcim account already used for Muse. We're building the whole machine now, but leaving it in "off" mode — no salon gets locked out of anything until the owner deliberately turns billing enforcement on, with advance warning.

## 2. Decisions made

| Question | Decision |
|---|---|
| Shared vs. separate Helcim account | **Keep the shared account** (same one as Muse) for now. **Fixing the per-tenant isolation gap (E1/E2 — any salon can currently read another salon's card transactions on the shared account) is a prioritized, separate workstream**, not folded into this build, but tracked as a prerequisite before broadly enforcing billing on a shared account. |
| Enforcement timing | **Built but OFF by default.** A global `enforcement_enabled` flag stays false. No salon is auto-locked or auto-trial-expired in this build. When the owner is ready (~30 days out, ending the beta), flipping the flag triggers an in-app push notification **and** an email to every salon first. |
| Per-salon trial/comp overrides | Operator can manually assign a **14- or 30-day trial**, or a **comp exemption of up to 3 months**, per salon — independent of any default. |
| Pricing model | **Tiered**, based on both capacity (stations/staff/calendars) and feature set — see §5. |
| Tier definition | **Generic/configurable** — plans are data (operator-editable), not hardcoded. A tier's included features/caps can change without a deploy. Existing subscribers keep the plan **version** they signed up for (see §4) — editing a plan going forward doesn't silently reprice or refeature someone already on it. |
| Who assigns tiers | **Hybrid** — salon self-serves standard upgrade/downgrade (once enforcement is live); operator console can override any salon's plan (comps, custom deals) at any time. |
| Existing beta salons | Same trial/comp override tools apply — **no separate migration script**, since nothing is enforced until the owner flips the switch (see Phase 2, §6). |
| Self-serve billing entry point during the beta | **Held behind its own `selfserve_billing_enabled` flag, separate from `enforcement_enabled`.** The live pricing page currently promises "no card on file to charge" — Phase 1 builds the full subscribe/payment-capture engine and lets the *operator* create/test a real subscription for any salon, but the salon-facing Settings → Billing entry point (and therefore any path to a real charge without the owner's direct involvement) stays off until the owner both flips this flag **and** updates the pricing-page copy. Decoupled from `enforcement_enabled` because the owner may want self-serve entry live before turning on lockouts, or vice versa. |
| Payment methods | Card **or** ACH bank account, captured via HelcimPay.js "verify" mode. SMS caps and similar numeric feature limits are **operator-editable per plan**, not hardcoded (e.g. Starter's texting cap starts at 100/mo but can change without a deploy). |
| Plan changes | Take effect at the **next billing cycle** — no proration in v1 (pending confirmation this matches Helcim's actual API behavior — see §9). |
| Where salon manages billing | **Settings → Billing** inside TurnDesk — view plan, upgrade/downgrade, update payment method, invoice history. Access rule: the account's true owner or a `role==='admin'` session, **excluding** the platform operator's own master login (`kind==='appadmin'`) — consistent with how other sensitive actions already exclude that session. |

## 3. Tiers (finalized)

Public pricing shows **3 tiers**; **Multi exists as a real, buildable plan definition but is not shown on the public pricing page yet** (mechanism and price undecided — see §5.1).

| | Free | Starter — $34/mo | Pro — $79/mo |
|---|---|---|---|
| Turn board | ✅ display-only (no check-in tracking) | ✅ full | ✅ full |
| Check-in / Queue + pricing | ❌ | ✅ | ✅ |
| Reports, payroll, refunds | ❌ | ✅ | ✅ |
| Calendar | ❌ | up to 5 | unlimited |
| Staff/techs | up to 5 | up to 5 | unlimited |
| Merchant card processing | ❌ | ✅ | ✅ |
| Receipt printing (+ review QR) | ❌ | ✅ | ✅ |
| Cash drawer | ❌ | ✅ | ✅ |
| SMS texting | ❌ | ✅, capped at 100/mo (operator-editable) | ✅ uncapped |
| Floor plan | ❌ | ❌ | ✅ |
| Gift cards | ❌ | ❌ | ✅ |
| Front-desk time clock + weekly schedule | ❌ | ❌ | ✅ |
| Team chat | ❌ | ❌ | ✅ |
| Appointment reminders | ❌ | ❌ | ✅ |
| Quick Sale (no-service checkout) | ❌ | ❌ | ✅ |
| Back Office sync | ❌ | ❌ | ✅ |
| Locations | 1 | 1 | 1 |

Core infrastructure — login, basic settings, photos/logo, appearance, the services/items/fees catalog, customer directory, global search, audit trail, data recovery, service-duration estimates, the in-app help guide, and error diagnostics — is available at every paid tier; it isn't a sellable lever.

### 3.1 Multi (internal only, not yet marketed)

"Full access for multiple salons." Two possible technical shapes, deliberately not decided yet:
- **(A)** bundle of separate salon instances (each its own slug/DO, today's architecture) under one subscription/owner
- **(B)** true single-app multi-location (shared staff/reports/calendar across locations in one screen) — real new product work, not built today

**To keep both paths open without a future billing rework**, the subscription is anchored one level above a single salon (see §4's `billingAccount`), so neither path requires changing the billing data model later — only the product decision of "what does a location mean" gets made when Multi actually ships.

## 4. Architecture

Same webhook-driven pattern as Muse's live Helcim Terminal integration, adapted for Helcim's **Recurring API**, and corrected against three round-1 findings that the original draft got wrong (webhook salon-routing, idempotency, and duplicating the app's existing enforcement source of truth).

- **Same Helcim merchant account** as Muse (§2). TurnDesk subscribers get a distinct namespace in Helcim's Customer API (`customerCode: td-<salonSlug>`).
- **Billing anchor — account level, not salon level:** `billingAccount:<accountId>` lives in the **registry DO** (the one DO instance that already spans multiple salons — matching its existing `salon:<slug>` convention, not inventing a new `bizId` concept this codebase doesn't have). It holds `{ planId, planVersion, status, salonSlugs: [...] }`. For every Free/Starter/Pro salon today, `salonSlugs` has exactly one entry — it behaves exactly like a per-salon system until Multi (§3.1) ever needs more than one.
- **Registry entry stays the single enforcement source of truth.** Each salon's existing registry entry (`salon:<slug> → {slug, name, status, ownerEmail, plan, ...}`) gets a `billingAccountId` pointer instead of a second, parallel `status`/`plan`. `appAuthOk`'s existing cached `registryGet()` lookup — which already gates every route — is what eventually reads billing state, once enforcement (Phase 2) is live. No second, unsynced "is this salon blocked" flag.
- **Webhook salon-routing:** Helcim recurring-billing webhooks arrive with no inherent salon context (this is a shared, account-level webhook URL, not a per-salon one). Resolve the salon via the `customerCode` (`td-<salonSlug>`) carried in the event payload. **Before implementation, confirm directly against Helcim's Recurring API docs/sandbox that `customerCode` is actually present on every relevant webhook event type** — if it isn't, this resolution step needs a different design (e.g. a `helcimCustomerId → salonSlug` index built at subscribe-time).
- **Webhook idempotency is new work, not reused from the existing Terminal webhook** (that handler broadcasts a transient envelope and has no event-dedup — a client-side trick unrelated to persisted-state mutation). Store a `whevt:<eventId>` marker before applying any billing state change, checked/set atomically the same way the existing `mut:<mutationId>` client-op dedup works.
- **New Worker routes:**
  - `GET /billing/plans` — list available plans
  - `POST /billing/subscribe` — create/change a salon's Helcim subscription
  - `POST /billing/webhook` — HMAC-verified, receives Helcim recurring-billing events
  - `POST /billing/portal-token` — issues a HelcimPay.js "verify" session (card or ACH capture)
  - Operator-side (`OPERATOR_TOKEN`-gated, mirroring `handleOperator`): plan CRUD, assign/override a salon's plan, set a manual trial (14/30 day) or comp (up to 3 months), view billing status, force unlock (once Phase 2 exists)
- **Enforcement middleware (built now, gated off by `enforcement_enabled`):** designed so that when eventually turned on, it does **not** reuse the existing hard `appAuthOk` / `isSalonDisabled` 401-everywhere mechanism as-is — that would also block a locked salon from fixing its own payment method or even loading the app. Enforcement needs its own, narrower gate with an explicit exemption list (at minimum: the sync/state route so the app can render, `/billing/*` so the salon can cure a lock, `/auth/login|logout`). **This gate's real behavior (degraded vs. hard lock, reminder cadence, what "locked" blocks vs. allows) is Phase 2 scope — see §6 — not built in this pass.**
- **Both `enforcement_enabled` and `selfserve_billing_enabled` are registry-DO-stored values the operator console can flip live** — not a `wrangler secret` requiring a redeploy (unlike the existing `AUTH_ENFORCED` pattern). This matches the rest of this design's operator-console-first control philosophy: the owner gets a button, not a deploy, at the moment they've agreed to notify salons and go live.
- **Scale note:** every billing write (subscribe, portal-token issuance, every recurring-billing webhook event, for every salon) funnels through the single reserved `__registry__` Durable Object instance — the same one that already handles provisioning/signup/status-toggle traffic today. Fine at the current 1-2 beta salons; monthly billing-cycle webhook bursts are a different order of ongoing traffic than occasional provisioning events, so this is an accepted tradeoff to revisit if/when salon count grows meaningfully, not a v1 blocker.
- **Operator console:** `operator.html` today is a flat page of stacked cards with no tab system — this adds a **new stacked section** (not literally a "tab"), holding: Payment Plan CRUD, a bootstrap step that seeds the Free/Starter/Pro plans on first deploy (nothing exists to assign otherwise), and per-salon billing controls (assign plan, set trial/comp, view status) surfaced via a per-salon **modal** (opened from a new "Billing" link in the existing Salons table row) rather than more inline buttons — that row already holds six actions (open, copy link, export data, enable/disable toggle, reset password, manager PIN) and can't take more without becoming unreadable. **The existing hardcoded `plan` free-text dropdown/field on the salon registry (Starter/Pro/Multi strings, currently disconnected from any real billing entity) gets replaced by a reference to the real `planId`**, not left to drift as a second, cosmetic "plan" value.

## 5. Feature-gating impact (separate, Phase-2-scoped work)

Enforcing tier capacity/feature limits (staff/calendar caps; gating check-in/queue+pricing, reports, merchant card processing, floor plan, gift cards, SMS, time clock, chat, appointment reminders, Quick Sale, Back Office sync for tiers that don't include them) touches many existing feature modules (`checkin.js`, `queue.js`, `reports.js`, `helcim.js`/`square-pos.js`, `floorplan.js`, `staff.js`, `calendar.js`, `giftcards.js`, `sms.js`, `timeclock.js`, `chat.js`, `appt-reminders.js`, `quicksale.js`, `backoffice-sync.js`, `settings.js`). **This is real, cross-cutting app work, scoped to Phase 2** (the same moment enforcement itself goes live) — not part of this build. This design's Phase 1 only builds the billing plumbing (plans, subscriptions, payment capture, webhooks, operator controls); no existing user sees any behavior change until Phase 2 ships both enforcement and feature-gating together.

## 6. Key flows

### Phase 1 (this build) — infrastructure only, nothing enforced, no live customer money movement
**A) Operator creates Payment Plans** (Free/Starter/Pro seeded at bootstrap) and can assign any salon to a plan, a manual trial (14/30 day), or a comp exemption (up to 3 months) at any time, from the new operator-console section. The operator can also manually create/test a real Helcim subscription for a specific salon (e.g. to verify the whole pipeline works) — this is an intentional, deliberate action by the owner, not something a salon can trigger on its own.
**B) The salon-facing Settings → Billing entry point is built but stays behind `selfserve_billing_enabled` (off by default — §2).** Once the owner turns it on (alongside updating the pricing-page copy), a salon can enter payment info via HelcimPay.js "verify" mode (card or ACH) and pick a plan — this creates a real Helcim subscription and starts real recurring charges, **but nothing in the app gates access on payment or plan status yet.**
**C) Charges succeed or fail via Helcim's real webhooks**, recorded into `billingAccount` history (with amount, invoice id, and failure reason where applicable) — visible to the operator, but not yet acted on by the app.

### Phase 2 (later, ~30 days out — owner-triggered, not built in this pass)
**D) Owner flips `enforcement_enabled`** (and, if not already on, `selfserve_billing_enabled`) → in-app push notification + email sent to every salon first, with real advance notice, timed alongside a pricing-page rewrite (§9) so the site's promises and the app's actual behavior change together, not the app silently getting ahead of the site.
**E) From here forward:** trial/grace reminders, degraded-then-hard lock behavior for failed payments, tier capacity/feature gating (§5), and the exact reminder cadence and lock-screen UX get designed and built as their own pass — deliberately deferred, not guessed at now.

## 7. Data model

**Payment Plan** (versioned — editing a plan going forward creates a new version; existing subscribers stay on the version they subscribed under, so a price/feature edit never silently changes what someone already pays). Fields match §3's tier table exactly — every ✅/❌ in that table has a corresponding field here, and `visible` is what keeps Multi (§3.1) out of the public `GET /billing/plans` listing without needing a separate code path:
```
{
  planId, version, name, visible: bool,   // visible:false for Multi and any future operator-only/custom plan
  price, billingFrequency: "monthly",
  capacity: { maxStaffAccounts, maxCalendars },   // maxCalendars: null = unlimited (Pro); station count isn't a tier lever today — floor plan (Pro-only) has no separate per-tier station cap
  features: {
    checkin: bool, reports: bool, merchantProcessing: bool, receiptPrinting: bool,
    floorplan: bool, giftcards: bool, cashdrawer: bool,
    timeclock: bool, chat: bool, apptReminders: bool, quicksale: bool, backofficeSync: bool,
    sms: { included: bool, monthlyLimit: number|null }   // null = uncapped; operator-editable
  }
}
```

**Billing account** (`billingAccount:<accountId>`, in the registry DO). `status` values are decided now so Phase 1's subscribe/webhook/operator-override code has something concrete to read and write — only the **enforcement meaning** of each value (what gets blocked, grace length, lock UX) is deferred to Phase 2:
```
{
  accountId, salonSlugs: [...],           // one slug today for every salon; >1 only if Multi (§3.1) ships as "bundle"
  planId, planVersion,
  status: "trialing" | "active" | "comped" | "canceled" | "past_due",
  trialEndsAt, compUntil,                 // manual overrides (§2)
  currentPeriodEnd,
  paymentMethodType: "card" | "ach",
  helcimCustomerId, helcimSubscriptionId,
  pastDueSince,
  history: [ { event, at, amount, invoiceId, failureReason, note } ]
}
```

Each salon's registry entry (`salon:<slug>`) gets a `billingAccountId` pointer to the above, replacing the old free-text `plan` field.

## 8. Error handling & edge cases

- **Webhook idempotency:** `whevt:<eventId>` dedup, applied before any state mutation (§4) — this is new work, explicitly not analogous to the existing (non-idempotent) Terminal webhook.
- **Late ACH returns:** a bank payment can settle, then bounce days later. Treated identically to a failed charge; `pastDueSince` is set to the **return webhook's receipt time** (a fresh window), not back-dated to the original charge — so a salon isn't retroactively out of grace period the moment the return arrives.
- **ACH settlement lag on initial conversion:** a new ACH subscription optimistically shows `active` immediately; if it later bounces, it's handled via the late-return path above, not a separate pending state.
- **NACHA ACH authorization:** HelcimPay.js tokenizing bank details is not, by itself, the legally-required authorization. Add an explicit authorization step/copy (clear recurring-debit language, amount, frequency, right to revoke) captured with a timestamp at ACH enrollment, retained per NACHA's record-keeping window, independent of whatever Helcim's widget itself captures.
- **Cancellation** is a distinct `status` from any future "locked" state, so a canceled account can't be reactivated by a stray retry.
- **Refunds/disputes on the SaaS fee itself:** operator-console-only for v1, recorded in `billingAccount.history`; a chargeback against TurnDesk is a manual-review case, not auto-locked.
- **Restore/backup interaction:** this repo has a known, unfixed restore-data-loss bug (wipes owner login/calendar token/audit trail on restore). `billingAccount` state should not trust a restored snapshot blindly — resync status from Helcim's live subscription record after any restore, rather than reintroducing this as a new instance of the same class of bug.
- **Data retention for canceled accounts:** reuse the existing `/operator/export` full-salon-data download as the offboarding step, rather than building a new one.
- **Isolation:** every `/billing/*` route stays scoped to the requesting salon/account and membership-gated, matching the multi-tenant isolation already enforced elsewhere (independent of, and not a substitute for, the separately-tracked E1/E2 fix in §2).
- **Concurrent writers on the same `billingAccount`:** a webhook, an operator override, and a self-serve plan change can all race to read-modify-write the same record — the existing registry `status`/`plan` mutation pattern has this same hazard today for lower-stakes fields, but billing state is financial data with several legitimate concurrent writers. Any handler that needs to call out to Helcim's API first should do so **before** its read-modify-write of the DO-stored `billingAccount` (not between the read and the write, which reopens the DO's non-interleaving guarantee to a race) — or add an explicit per-field version/`updatedAt` guard, matching Muse's existing stale-write-guard pattern.

## 9. Open items for the implementation plan

- Confirm Helcim's Recurring API webhook payloads actually carry `customerCode` (or another reliable salon-resolution key) on every relevant event type (§4) — architecture-blocking if not.
- Confirm whether Helcim's update-subscription endpoint supports non-prorated, next-cycle-effective plan changes directly, or needs extra reconciliation logic (§2).
- Confirm whether HelcimPay.js "verify" mode tokenizes ACH the same way it tokenizes cards, or needs a separate flow.
- Confirm Helcim's actual recurring-billing dunning/retry cadence, to inform whatever grace-period length Phase 2 eventually uses.
- The E1/E2 shared-account tenant-isolation fix (§2) needs its own scoping/plan — tracked as a prerequisite for broad enforcement, not designed here.
- Phase 2's exact enforcement mechanics (lock granularity, reminder cadence, trial-expired-with-no-payment-method state, invoice-history UI fields) are intentionally deferred to a follow-on design pass, not this one.
- State/sales tax obligations on the SaaS fee across states — flag for the owner at scale, immaterial at 1-2 beta salons today.
- Wire Phase 1's plan-assignment into the existing self-serve-signup/provisioning flow (`/provision/seed`) once self-serve billing signup is actually built, rather than assuming a "new salon signs up" event that doesn't exist yet in that flow's current form.
- **Pricing-page rewrite (`site/pricing.html`) is a hard prerequisite for turning on `selfserve_billing_enabled`**, not just `enforcement_enabled` (§2) — the live copy's "no card on file to charge" promise is broken the moment a real charge can happen, regardless of whether anyone is ever locked out for non-payment. The site's own `BUILD-NOTES.md` already earmarks this rewrite for launch; treat both flags as gated on it, not just the enforcement one.

## 10. Implementation addendum (2026-07-16) — research answers that supersede §4/§9 where they conflict

- **No billing webhooks in Phase 1 — poll-first is the only option, not a preference.** Helcim emits only `cardTransaction {id,type}` and `terminalCancel` webhook events — there are no subscription/recurring event types and no `customerCode` in the cardTransaction payload. Additionally, the shared Helcim account's single account-level webhook URL points at **Muse's Worker**, so TurnDesk's Worker would never receive these events without touching Muse (out of scope). §4's `/billing/webhook` route and `whevt:` dedup are therefore **dropped**; subscription truth is Helcim's `GET subscription → payments[]` sub-array (`approved|declined|failed|waiting`), reconciled on operator view / salon Billing view / manual sync. Idempotency is structural: history entries merge keyed by Helcim payment id.
- **HelcimPay.js verify mode confirmed for both card and ACH** (`setAsDefaultPaymentMethod:1`, bankToken) — one capture flow, as §2 hoped.
- **Proration is opt-in per Helcim plan; we never enable it** — §2's "no proration" holds by construction.
- **Helcim has built-in configurable auto-retry** for failed recurring payments (cards 3/5/7 or 7/14/21 days; ACH 7 or 14; custom) — Phase 2's grace design leans on it rather than building a dunning engine.
- **One umbrella Helcim payment plan** ("TurnDesk SaaS", monthly) with per-subscription `recurringAmount` — our plan docs stay the source of truth for features/price; Helcim just moves money. Fallback (if per-subscription amounts don't override in practice): lazily create one Helcim plan per (planId, version).
- **Pre-billing account convention:** `status:'trialing'` with `trialEndsAt:null` = "account set up, no trial clock, nothing billing" — the default for operator-assigned plans before any trial/comp/subscription; harmless while nothing enforces.
- **Restore-safety (§8) in practice:** because billing state reconciles from Helcim on every view, a stale restored snapshot self-corrects on the next operator/salon Billing view — no restore-specific handler needed in Phase 1.

Implementation plan: `docs/superpowers/plans/2026-07-16-saas-billing-phase1.md`.
