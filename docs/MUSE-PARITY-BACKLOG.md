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
