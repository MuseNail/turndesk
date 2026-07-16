# TurnDesk SaaS Billing — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the billing infrastructure (plans, accounts, payment capture, Helcim subscriptions, reconcile, operator controls, flag-gated salon UI) with **zero enforcement and zero salon-visible change** until the owner flips flags.

**Architecture:** Billing state lives in the registry DO (`__registry__` instance of `TurnDeskDO`) under new key prefixes (`bflags`, `bplan:<planId>`, `billing:<accountId>`), reached only via `registryStub(env)` — same pattern as `salon:<slug>`. Worker-side logic follows the `handleOperator` split (logic in Worker, DO stores). Helcim recurring state is **poll-reconciled** (on operator view + salon Billing view + manual sync), NOT webhook-driven — see Research Addendum below. Money is integer **cents** in our storage, converted to dollars only at the Helcim API edge.

**Tech Stack:** Cloudflare Worker + Durable Object (no framework), vanilla ES-module client, `node:test` with mock storage/fetch.

## Global Constraints (from spec `docs/superpowers/specs/2026-07-15-turndesk-saas-billing-design.md`)

- Both flags (`enforcementEnabled`, `selfserveBillingEnabled`) default **false**; stored in registry DO, operator-toggleable live, NOT wrangler secrets.
- No enforcement gate in the request path in Phase 1 — flags are stored + surfaced only.
- Plan edits create a **new version**; subscribers pin `{planId, planVersion}` at assign/subscribe time.
- Tier matrix (seeded v1): Free $0 / Starter $34 / Pro $79 / Multi (visible:false, custom price). SMS cap Starter=100/mo, operator-editable. Caps: Free+Starter maxStaff 5; Starter maxCalendars 5; Pro/Multi unlimited (null).
- Salon Billing UI: owner (`kind==='owner'`) or `role==='admin'`, **excluding** `kind==='appadmin'`; hidden entirely while `selfserveBillingEnabled` is false.
- ACH enrollment requires an explicit authorization acceptance recorded with timestamp before bank verify (NACHA).
- `canceled` and `comped` statuses are sticky — reconcile never auto-changes them.
- TurnDesk is **main-only**; commit freely, no push without owner OK. No version bump until ship.

## Research Addendum (2026-07-16 — supersedes spec §4's webhook bullet)

1. Helcim emits only `cardTransaction {id,type}` + `terminalCancel` webhooks — **no subscription events, no customerCode in the payload** ([webhooks doc](https://devdocs.helcim.com/docs/webhooks)).
2. The shared Helcim account's single account-level webhook URL points at **Muse's Worker**, not TurnDesk's — TurnDesk cannot receive these webhooks at all without touching Muse (out of scope).
3. Therefore Phase 1 has **no `/billing/webhook` route and no `whevt:` dedup**. Subscription truth = `GET /v2/subscriptions/{id}` `payments[]` sub-array (statuses `approved|declined|failed|waiting`), reconciled on view/demand. Idempotency is structural: history entries are keyed by Helcim payment id and merged, never appended blindly.
4. HelcimPay.js `verify` + `setAsDefaultPaymentMethod:1` confirmed for both card and ACH (bankToken). Proration is opt-in per plan — we never enable it. Helcim has built-in configurable auto-retry for failed recurring payments (Phase 2 leans on it).
5. Subscriptions carry their own `recurringAmount` — we use **one umbrella Helcim payment plan** ("TurnDesk SaaS", monthly) and set the real price per subscription. Our `bplan:` docs are the source of truth for features/price; Helcim just moves money. (Fallback if a sandbox test shows per-subscription amounts don't override: create one Helcim plan per (planId,version) lazily — isolated inside `helcimSubscribe`.)

## File Structure

- Modify: `cloudflare/worker.js` —
  (a) DO: `/bdo/*` storage routes next to the `/registry/*` block (~line 1302);
  (b) Worker: billing helpers + `handleBilling` (salon-scoped) + operator billing routes inside `handleOperator`;
  (c) Worker top-level dispatch: `/billing/*` → `handleBilling`, explicit 404 for `/bdo/*`.
- Create: `js/app/features/billing.js` — salon Settings → Billing panel (flag-gated).
- Modify: `js/app/features/settings.js` + `js/app/main.js` — mount the panel.
- Modify: `operator.html` — new "Billing" stacked card (flags, plans table, accounts table).
- Create: `test/billing-plans.test.js`, `test/billing-accounts.test.js`, `test/billing-reconcile.test.js`, `test/billing-routes.test.js`, `test/billing-client.test.js`.
- Modify: spec doc — dated addendum pointing here.

---

### Task 1: Spec addendum + plan commit

**Files:** Modify `docs/superpowers/specs/2026-07-15-turndesk-saas-billing-design.md` (append addendum §10); Create this plan file.

- [ ] **Step 1:** Append "§10 Implementation addendum (2026-07-16)" to the spec: webhook reality (points 1–3 above), umbrella-plan decision (point 5), pre-billing `status:'trialing', trialEndsAt:null` convention (below).
- [ ] **Step 2:** Commit both docs: `git commit -m "docs(billing): research addendum — poll-first (no TurnDesk webhooks), umbrella Helcim plan; Phase 1 implementation plan"`

### Task 2: Registry-DO billing storage (`/bdo/*`)

**Files:** Modify `cloudflare/worker.js` (DO fetch, after `/registry/index-owner`); Test `test/billing-plans.test.js`.

**Interfaces produced (DO-internal, called only via `registryStub`):**
- `GET /bdo/flags-get` → `{flags:{enforcementEnabled,selfserveBillingEnabled}}`
- `POST /bdo/flags-put {enforcementEnabled?,selfserveBillingEnabled?}` → `{ok,flags}`
- `GET /bdo/plans-get` → `{plans:[...]}` · `POST /bdo/plan-put {plan}` → `{ok}`
- `GET /bdo/accounts-get` → `{accounts:[...]}` · `GET /bdo/account-get?id=` → `{account|null}` · `POST /bdo/account-put {account}` → `{ok}`

**Plan doc shape** (`bplan:<planId>`): `{ planId, name, visible, versions:[{version, priceCents, capacity:{maxStaffAccounts,maxCalendars}, features:{turnBoardFull,checkin,reports,merchantProcessing,receiptPrinting,cashdrawer,floorplan,giftcards,timeclock,chat,apptReminders,quicksale,backofficeSync,sms:{included,monthlyLimit}}, createdAt}] }` — current version = last element.

**Account doc shape** (`billing:<accountId>`, accountId = primary salon slug): `{ accountId, salonSlugs:[slug], planId, planVersion, status:'trialing'|'active'|'comped'|'canceled'|'past_due', trialEndsAt, compUntil, currentPeriodEnd, paymentMethodType, helcimCustomerId, helcimCustomerCode, helcimSubscriptionId, pastDueSince, lastFailureReason, achAuthorization:{acceptedAt,textVersion,byUser}|null, history:[{event,at,amountCents,invoiceId,failureReason,note,helcimPaymentId}] }`. Convention: `status:'trialing'` with `trialEndsAt:null` = "set up, not billing, no trial clock" (pre-billing default; harmless while nothing enforces).

- [ ] **Step 1:** Write failing tests — DO storage roundtrips via `d.fetch(new Request('https://do/bdo/...'))` using the `makeStorage()` harness from `test/worker-patch-guards.test.js` (copy the helper; it's the repo convention).
- [ ] **Step 2:** Run: `node --test-force-exit --test test/billing-plans.test.js` → FAIL (404s).
- [ ] **Step 3:** Implement the six `/bdo/` handlers in the DO (mirror `/registry/put` style: parse, validate key field, `storage.put`, `_authJson`). `plan-put` requires `plan.planId`; `account-put` requires `account.accountId`.
- [ ] **Step 4:** Re-run → PASS. **Step 5:** Commit `feat(billing): registry-DO storage routes for plans/accounts/flags`.

### Task 3: Plan versioning + bootstrap seed (Worker helpers)

**Files:** Modify `cloudflare/worker.js` (module scope, near `registryGet`); Test `test/billing-plans.test.js` (extend).

**Interfaces produced:**
- `async billingFlags(env)` → flags (defaults false/false)
- `async billingPlansEnsureSeed(env)` → plans[] — seeds Free/Starter/Pro/Multi v1 exactly once (idempotent: seeds only when zero `bplan:` keys exist)
- `savePlanEdit(existingPlan, {name?,visible?,priceCents?,capacity?,features?})` → pure function returning the plan with a **new version appended** when priceCents/capacity/features changed, or only name/visible touched in place otherwise
- `currentVersion(plan)` → last element of `plan.versions`

Seed values (cents): free `0` (turnBoardFull:false, everything else false, maxStaff 5, maxCalendars 0, sms {false,0}); starter `3400` (turnBoardFull, checkin, reports, merchantProcessing, receiptPrinting, cashdrawer true; sms {true,100}; maxStaff 5, maxCalendars 5; rest false); pro `7900` (all true, sms {true,null}, caps null); multi (visible:false, priceCents:null, all true, caps null).

- [ ] **Step 1:** Failing tests: seed idempotence (two calls → still 4 plans, 1 version each); `savePlanEdit` price change appends v2 and v1 is untouched; name-only edit does NOT bump version; visible:false plan excluded by a `visiblePlans(plans)` filter.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS → **Step 5:** Commit `feat(billing): plan versioning + Free/Starter/Pro/Multi bootstrap seed`.

### Task 4: Helcim recurring helpers + reconcile

**Files:** Modify `cloudflare/worker.js`; Test `test/billing-reconcile.test.js` (mock `globalThis.fetch` for `api.helcim.com`).

**Interfaces produced:**
- `async helcimEnsureBillingCustomer(env, account, salonName)` → account with `helcimCustomerId/helcimCustomerCode` set (create customer `contactName: 'TurnDesk — <salonName>'`, try `customerCode:'td-<slug>'`, accept Helcim's generated code on rejection)
- `async helcimEnsureUmbrellaPlan(env)` → helcimPlanId (create once, cache id on the `bflags` doc as `helcimPlanId`)
- `async helcimSubscribe(env, account, priceCents)` → `{subscriptionId}` (POST `/v2/subscriptions`, `recurringAmount: priceCents/100`, `paymentMethod: account.paymentMethodType==='ach'?'bank':'card'`, `dateActivated` today UTC)
- `async helcimCancelSubscription(env, subscriptionId)` → best-effort PATCH status cancelled; tolerate 4xx
- `reconcileAccount(account, helcimSubscription)` → **pure function** returning updated account: merge `payments[]` into `history` keyed by `helcimPaymentId` (no dupes on re-run); latest payment `approved` → `status:'active'`, clear `pastDueSince`/`lastFailureReason`, set `currentPeriodEnd` from subscription `dateBilling`; any un-superseded `declined|failed` → `status:'past_due'`, set `pastDueSince` only if empty, set `lastFailureReason`; `canceled`/`comped` never change status; `waiting` payments recorded but drive no transition.
- `async syncAccountFromHelcim(env, account)` → fetch subscription (skip when no `helcimSubscriptionId`), run `reconcileAccount`, **Helcim fetch happens BEFORE the account-put read-modify-write** (spec §8 concurrency rule), persist via `/bdo/account-put`.

- [ ] **Step 1:** Failing tests for `reconcileAccount` (pure — no fetch mock needed): idempotent double-run; declined→past_due sets pastDueSince once; approved-after-declined→active clears it; canceled stays canceled; comped stays comped; history dedupe by payment id.
- [ ] **Step 2:** FAIL → **Step 3:** implement (pure fn + thin fetch wrappers) → **Step 4:** PASS → **Step 5:** Commit `feat(billing): Helcim recurring helpers + pure idempotent reconcile`.

### Task 5: Operator billing routes

**Files:** Modify `cloudflare/worker.js` (`handleOperator`); Test `test/billing-accounts.test.js` (mock env: `{OPERATOR_TOKEN:'t', SALON_DO:{idFromName:n=>n, get:id=>wrapDO(id)}}` where `wrapDO` returns a real `TurnDeskDO` with mock storage per id — the registry instance is just id `__registry__`).

**Interfaces produced (all `OPERATOR_TOKEN`-gated):**
- `GET /operator/billing/overview` → `{flags, plans, accounts}` (runs `billingPlansEnsureSeed`; joins each account's salon name from registry entries)
- `POST /operator/billing/flags {enforcementEnabled?,selfserveBillingEnabled?}`
- `POST /operator/billing/plans {planId, name?, visible?, priceCents?, capacity?, features?}` → create when new planId, else `savePlanEdit`
- `POST /operator/billing/assign {slug, planId}` → upsert account (create `{accountId:slug, salonSlugs:[slug], status:'trialing', trialEndsAt:null, history:[]}` when absent), pin `planVersion` = current, stamp `entry.billingAccountId` on the salon registry entry, history event `assign`
- `POST /operator/billing/trial {slug, days}` → days must be 14 or 30; `status:'trialing'`, `trialEndsAt: now+days`, history event
- `POST /operator/billing/comp {slug, months}` → months 1–3 (reject >3); `status:'comped'`, `compUntil`, history event
- `POST /operator/billing/cancel {slug}` → `status:'canceled'` + best-effort `helcimCancelSubscription`, history event
- `POST /operator/billing/subscribe {slug}` → the deliberate operator test path: requires account with payment method captured; ensure customer → umbrella plan → `helcimSubscribe` at pinned version's price → `status:'active'`, history event
- `GET /operator/billing/sync?slug=` → `syncAccountFromHelcim` on demand

- [ ] **Step 1:** Failing tests: assign creates+pins version (then a plan price edit does NOT change the pinned account); trial rejects days=7; comp rejects months=4; cancel is sticky (a later `reconcileAccount` with an approved payment leaves it canceled); overview seeds plans; every route 401s without the operator token.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS → **Step 5:** Commit `feat(billing): operator billing routes (flags, plan CRUD, assign/trial/comp/cancel/subscribe/sync)`.

### Task 6: Salon-scoped `/billing/*` routes

**Files:** Modify `cloudflare/worker.js` (new `handleBilling` + dispatch line after the helcim block; explicit `if (path.startsWith('/bdo/')) return json({error:'not found'},404)` guard at Worker level); Test `test/billing-routes.test.js`.

**Interfaces produced (salon-scoped, behind the existing `appAuthOk`):**
- `billingAdminOk(request, env, salonId)` → calls salon DO `/auth/check` with the bearer token; allow `user.kind==='owner' || user.role==='admin'`, **deny `kind==='appadmin'`**
- `GET /billing/status` → `{flags:{selfserveBillingEnabled}, account, plans}` — plans filtered to `visible`, each reduced to its current version; account = this salon's only (`billing:<salonId>`); `?sync=1` runs `syncAccountFromHelcim` first; requires `billingAdminOk`
- `POST /billing/portal-token {ach?:bool}` → requires `billingAdminOk` + `selfserveBillingEnabled`; when `ach` requires prior `achAuthorization` on the account (else 428); proxies Helcim `POST /v2/helcim-pay/initialize {paymentType:'verify', amount:0, currency:'USD', customerCode}` after `helcimEnsureBillingCustomer`; stores `bpay:<checkoutToken> = {secretToken, slug, ts}` in registry DO (add `/bdo/pay-put`+`/bdo/pay-take` single-use take-and-delete route); returns `{checkoutToken}`
- `POST /billing/ach-authorize {textVersion}` → requires `billingAdminOk`; stamps `achAuthorization:{acceptedAt:Date.now(),textVersion,byUser:user.name}` on the account (creates skeleton account if absent)
- `POST /billing/verify-complete {checkoutToken, rawDataResponse, hash}` → takes `bpay:` record (single-use), verifies `hash === SHA-256(rawDataResponse + secretToken)` per Helcim's validate scheme, extracts `customerCode`/card-vs-bank from the response, sets `paymentMethodType` + customer ids on the account (skeleton-create if absent), history event `payment-method`
- `POST /billing/subscribe {planId}` → requires `billingAdminOk` + `selfserveBillingEnabled` + captured payment method; pins current version; ensure customer → umbrella plan → `helcimSubscribe`; `status:'active'`; plan **changes** on an already-subscribed account only update `planId/planVersion` pins + history event `plan-change` (Helcim PATCH of recurringAmount at next cycle is Phase 2 — record intent, don't touch the live subscription yet; the operator can cancel+resubscribe for a mid-beta change)

- [ ] **Step 1:** Failing tests: `/billing/status` 401s for a tech session and for `appadmin`, works for owner; returns only this salon's account (isolation: seed two accounts, assert the other never appears); `/billing/subscribe` 403 while `selfserveBillingEnabled=false`; flag flip → subscribe path reaches the (mocked) Helcim call and pins the version; `/bdo/anything` from the public Worker surface → 404; verify-complete rejects a wrong hash and is single-use.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS → **Step 5:** Commit `feat(billing): salon-scoped billing routes (status/portal-token/ach-authorize/verify-complete/subscribe)`.

### Task 7: Operator console UI

**Files:** Modify `operator.html` (new "Billing" card between "Create a salon" and "Pending requests"; reuse the existing flat-card + `api()` + `prompt()` conventions — no modal infra).

Contents: (a) two flag checkboxes with live save + a red "enforcement" warning label; (b) plans table (name, price, visible, staff/cal caps, sms cap, version) with Edit via `prompt()`-chain → `POST /operator/billing/plans`; (c) accounts table (salon, plan@version, status, trial/comp dates, last failure) with per-row buttons: Assign plan · 14d · 30d · Comp… · Cancel · Subscribe (confirm dialog: "creates a REAL Helcim subscription") · Sync.

- [ ] **Step 1:** Implement (static HTML + JS functions `refreshBilling()`, `onBillingAction(e)` mirroring `renderSalons`/`onAction`).
- [ ] **Step 2:** Manual check: open `operator.html` served locally, stub `api()` — verify render with mock data (no live worker needed).
- [ ] **Step 3:** Commit `feat(billing): operator console Billing card`.

### Task 8: Salon Settings → Billing panel (flag-gated)

**Files:** Create `js/app/features/billing.js`; Modify `js/app/features/settings.js` (mount point), `js/app/main.js` (window glue — follow the existing `Object.assign(window, ns)` pattern); Test `test/billing-client.test.js`.

**Interfaces produced:**
- `canSeeBilling(session, flags)` → pure: `flags.selfserveBillingEnabled && session && session.kind !== 'appadmin' && (session.kind === 'owner' || session.role === 'admin')`
- `renderBillingCard()` → fetches `/billing/status`; hidden (returns null) unless `canSeeBilling`; shows plan cards (from visible plans), current status/history table, "Add card" / "Add bank account" buttons → `/billing/portal-token` → lazy-load `https://secure.helcim.app/helcim-pay/services/start.js` → `appendHelcimPayIframe(checkoutToken)` → postMessage result → `/billing/verify-complete`; ACH button first shows the authorization text + checkbox → `/billing/ach-authorize`, then opens the iframe; "Choose this plan" → `/billing/subscribe`.

- [ ] **Step 1:** Failing test: `canSeeBilling` matrix (owner ✓, fd-admin ✓, appadmin ✗, tech ✗, flag-off ✗) — pure import, use `test/setup-globals.js` conventions.
- [ ] **Step 2:** FAIL → **Step 3:** implement module → **Step 4:** PASS.
- [ ] **Step 5:** Wire into settings.js behind the same check (section simply absent when hidden — no dead button). Commit `feat(billing): salon Settings→Billing panel behind selfserve flag`.

### Task 9: Full test sweep + docs

- [ ] **Step 1:** Run every billing test file individually (Windows: globs hang): `node --test-force-exit --test test/billing-plans.test.js` … repeat per file; then the pre-existing worker suites (`worker-auth-hardening`, `salon-isolation`, `worker-patch-guards`) to prove no regression.
- [ ] **Step 2:** Update repo `CLAUDE.md` "Where to Make Changes" table + `PRIORITIES.md` (billing Phase 1 built; Phase 2 = enforcement/feature-gating/pricing-page rewrite; E1/E2 isolation fix still open).
- [ ] **Step 3:** Commit `docs(billing): Phase 1 built — pointers + pipeline update`. **No push, no deploy, no version bump** (ship skill + owner OK later).

## Self-review

- Spec coverage: §2 flags/overrides→Tasks 3,5; §3 tiers→Task 3 seed; §4 storage/routes/operator→Tasks 2,5,6,7; §5 gating→explicitly Phase 2 (none built); §6 flows A/B/C→Tasks 5,6,8; §7 data model→Task 2 (+`lastFailureReason`, `achAuthorization`, `helcimCustomerCode` additions carried from §8); §8 NACHA→Task 6 `ach-authorize`; §8 concurrency→Task 4 fetch-before-RMW rule; §8 restore-resync→covered by reconcile-on-view (any restore is corrected on next view — note in addendum); webhook items→superseded per addendum.
- Placeholders: none — every handler named with request/response shapes; seed numbers explicit.
- Type consistency: `priceCents` everywhere internal; dollars only inside `helcimSubscribe`; `status` enum identical across Tasks 2/4/5/6.
