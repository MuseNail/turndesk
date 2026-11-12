# Muse → TurnDesk parity backlog

TurnDesk is a fork of Muse. This tracks features that exist in the live Muse app
(`musedashboard`) and need bringing into TurnDesk, plus what has already been ported.
The reverse direction (TurnDesk features to bring into Muse) lives in `MUSE-PORT-LOG.md`.

Source: a full feature-parity audit of both repos on **2026-09-24**.

---

## Ported into TurnDesk (2026-09-24 round)

- **Calendar mid-day "Completed"** — a booked guest who already checked in and PAID earlier
  the same day now resolves to blue "Completed" in the today-list / day grid / week grid,
  instead of the amber "running late / Not in". No-show is still only flagged once the day is
  fully over. (`features/calendar.js`; ported from Muse's `doneRec` / `_pastRecordMatch` logic.)
- **Outbox OOM self-heal** (`coalesceConfigSets`) — collapses a flooded `config.set` outbox
  (last-writer-wins per key) so a pathological backlog can't OOM the tab on boot. (`sync.js`,
  from Muse v5.58; + `test/outbox-coalesce.test.js`.)
- **Calendar UX tidy** — the app-native calendar now renders by DEFAULT; Google is a quiet
  opt-in. Previously the calendar was gated behind connecting Google (a salon that never
  connected couldn't see its own app-native calendar). (`features/calendar.js`.)

## Ported into TurnDesk (2026-10-14 round) — td-v0.53

Three reviewed/shipped Muse features transplanted faithfully (Muse was the source of truth;
each was already rigorous-build-reviewed + live on Muse). All 51 TD test files pass.

- **Tech price entry decoupled from completion** (Muse v5.60, commits `6691f8b`+`4d6ca7a`) —
  the tech app is one morphing button (Start → Save price → Complete → Reopen); saving a price
  NEVER changes status, so a tech who prices early isn't shown Available while still working. New
  `assignment.techPriced` provenance flag (tech-set, FD-cleared) → "Price in ✓" cue on the staff
  app + queue (+ compact ✓ on turns; floor excluded). `staff.js` (`staffServiceAction`/
  `saveDisabled`/`completeGateOk`), `status.js` (`isTechPriced`), `turns.js`, `queue.js`,
  `store.js` (the **device-scoped** `queue.assignmentPatch` stale-guard — same-device replay only;
  do NOT make it cross-device). Tests: staff/status/store. ⚠️ Muse's **v5.61** one-tap-calculator
  follow-on is deliberately Muse-ONLY and was NOT ported.
- **Heal stale board on phone wake** (Muse v5.62, commit `ff4a32e`) — `sync.js` rebuilds a
  zombie-OPEN WebSocket on wake (`_shouldReconnect`/`_shouldResync` + `pageshow`/`resume`/
  `touchstart` + a 5s visible-only watchdog; `_lastRecv` stays WS-liveness-only; `_ping` leak fix;
  `httpSnapshot` in-flight guard + 10s AbortController). TD multi-tenant specifics (`scopedKey`
  outbox, plain hello, IDB cache) preserved. Test: `wake-resync.test.js`.
- **Payroll "All techs" Total column** (Muse v5.63, commit `f8836bc`) — read-only column pinned
  far-left on the tech payroll table, sums every row across techs (override- + lock-snapshot-aware,
  compare-to-last, light-blue, whole-dollar). `payrollColumnTotals` + `.ptot` sticky CSS. TD's
  `.sticky-col` is 120px so `PL=120` ported unchanged. Test: `payroll-total.test.js`.

Open for TD: eyeball the payroll frozen column on a real iPad (compare on, 3+ techs) + the wake
fix on a phone, same as Muse. NOTE: for very large multi-location totals, `PW=72` (fits ~$999,999)
may want bumping.

## Ported into TurnDesk (2026-11-11 round) — td-v0.83

Two reviewed/shipped Muse features transplanted, adapted to TD's diverged multi-tenant code. Client-only
(no Worker change, no `wrangler deploy`). Version trio bumped once together. 643 tests pass (76 files).
Built via `rigorous-build`: TDD on the pure helpers → 3-lens + guardrail subagent review → fixes.

- **Unified notification bell (Muse v6.18, `2f1daf8`)** — ONE header bell aggregating everything pending,
  each row tappable straight to its source. New `js/app/notif-util.js` (pure, unit-tested) + `features/
  notifications.js` (DOM, strictly READ-ONLY on state; one debounced `refreshNotifBell()` in `onStateChange`
  + a 60s heartbeat). **TD-adapted sources:** failed/dead-lettered writes (admin+manager), replies to your
  help tickets (all), unread chat (all), the actionable clock station-warning (admin), app updates (all).
  **Omitted vs Muse (deliberate):** `supportNew` (TD's salon app has no operator inbox — new-ticket triage
  is the operator console's job) and overdue `tasks` (TD tasks are Google-Tasks-backed, not synced state).
  Every source is already per-salon → no cross-tenant leak (verified). Retired the now-redundant Settings-nav
  support dot + the iPad avatar combined-unread badge (`#acct-unread-badge`) + `#menu-support-badge`; moved
  nothing (desktop already reaches Help via Settings → Help & Feedback). **Data Recovery is now manager-visible**
  (was admin-only) so the manager's "a sale didn't save" alert leads somewhere. Tests: `test/notifications.test.js`.
- **Book next appointment at checkout (Muse v6.19, `b7a8240`)** — after a paid SERVICE sale, a non-blocking
  card offers to book the next visit → Calendar banner → clicking a slot opens New Appointment autofilled
  with name+phone. New `js/app/rebook-util.js` (pure, unit-tested) + `features/rebook.js` (device-local
  `_pending`, never synced). Hooked at the top of `square-pos._finalizeTerminalPaid` — TD's single LOCAL
  checkout chokepoint (cash/Zelle/gift/card + record-as-paid + manual checkout all funnel here; the synced
  `updateStatus(...,'paid')` path never calls it), capturing a name/phone/services snapshot before the
  paid-flip → card fires on the checkout device only, never salon-wide (verified). Service-visit gate excludes
  gift-card/retail/Quick Sale. Synced `config.rebook_prompt` (default ON) + a Settings → Workflow → Checkout
  Rebooking toggle (manager/admin). Tests: `test/rebook.test.js`.

## Deferred (documented, not built)

- **#1 — Helcim refund safety hardening.** Muse (v4.97) hardened its card-refund path:
  processor-truth check against the actual gateway before refunding, over-refund block,
  unrecorded-refund detection + reconcile-stamp, SHA-256 idempotency key, fail-closed
  verification. TurnDesk's `confirmRefund` still uses a naive idempotency key
  (`id-txn-cents-priorRefundCount`) with none of those guards.
  - **Why deferred:** TurnDesk is not processing cards yet (beta salons run manual checkout;
    card processing is behind the billing-launch gate). So the naive path is DORMANT — nothing
    refunds cards today. This is a hard prerequisite to fix **before enabling card processing.**
  - **To port:** `helcim.js` `fetchHelcimRefunds` + the truth-check inside `confirmRefund`;
    `reports.js` `_refundIdemKey` / `_priorCardRefunds` / `_matchUnrecordedTxn` /
    `_unrecordedHelcimRefunds`. Re-test against TurnDesk's own code (multi-tenant scoping,
    per-salon Helcim credentials).
  - **Gate:** add to the billing-launch checklist (with F1/F2/F3/F6/F9 + F24–F30). Do NOT turn
    on card processing until this lands.

- **#3 — Timezone panel (`salon_tz`).** In Muse this only feeds the Phase-3 archive
  month-bucketing, which TurnDesk does not have. Porting just the panel would be an inert
  setting. Revisit together with a TurnDesk archive / storage-scaling system.

- **#4 — Fleet "Devices" diagnostics card.** Muse's Diagnostics shows a per-device build table
  (which device runs which version, "behind"/stale flags), fed by a Worker `/state/fleet` route +
  DO `stampFleet`/`listFleet`, with `fleet:` keys carried through restore + factory-reset.
  - **Why deferred (owner, 2026-09-24):** low-value diagnostics vs. high risk — it adds a Worker
    route + DO telemetry and touches the restore/factory-reset data-integrity paths, plus a Worker
    deploy. Not worth that surface right now.
  - **To port:** worker.js `/state/fleet` + DO `stampFleet` (on the connect "hello") + `listFleet`
    + add `fleet:` to TurnDesk's restore + factoryReset preserve-sets; client `sync.js`
    `appKindFromPath` + the connect hello carrying `{device, v, app}`; `diagnostics.js` Devices card.

## Declined for Muse (multi-tenant-only / redundant — no action)

- **#10 — Manual / no-terminal checkout INTO Muse.** Owner decision (2026-09-24): SKIP. Muse's
  checkout already covers the terminal-outage / paid-outside case — cash & Zelle tenders (the card
  only charges the remainder, so full cash/Zelle → $0 card) plus "mark paid without charging"
  (`markPaidNoCharge`, with an external-reference field for reconcile). TurnDesk's `'none'` mode is
  for beta salons with NO terminal at all; Muse always runs Helcim live, so it's redundant.

- **#11 — Editable Business Profile on receipts.** Owner decision (2026-09-24): SKIP. It's a
  multi-tenant feature; Muse is always "Muse Nails & Spa," hardcoded across 5+ live surfaces
  (receipts, reports, payroll, exports, PDFs). Rewiring all of them for a name that never changes
  isn't worth the regression risk. TurnDesk keeps its own editable Business Profile.

## Not gaps (deliberate divergence / SaaS-only — no action)

- TurnDesk-only by design: signup landing, subscription billing, help-desk/support, owner
  sign-in, `manageCalendar` / `viewWaivers` role gates, editable Business Profile on receipts.
- Calendar backing: Muse removed Google entirely (clean break); TurnDesk keeps app-native +
  optional Google (owner decision 2026-09-24 — keep hybrid, app-native default).
