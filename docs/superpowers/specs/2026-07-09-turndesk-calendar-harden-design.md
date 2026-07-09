# TurnDesk — Calendar Part 1 hardening + minors

Date: 2026-07-09
Status: draft (brainstorm) — pending owner review
Repo: `turndesk` (main-only). Branch for the work: `feat/calendar-harden`.
Prereq shipped: app-native appointments (calendar re-arch **Part 1**), live `td-v0.18`/`td-v0.19`.

## 1. Goal

Close out Part 1: (a) prove the shipped app-native calendar works end-to-end in the
browser (the owner-gated verification that was deferred at ship time), (b) clear the
deferred-minors backlog, and (c) fix a data-integrity bug the verification code-review
turned up — **without touching the dormant Google plumbing that Part 2 will re-enable**.

## 2. Phase A verification result (done 2026-07-09)

Drove the live demo salon as Manager Mia (Google disconnected) through the spec-§2
capability matrix. **App bugs found: 0.** 24 capabilities PASS, including every write path:
day/week render, now-line, color-by-staff, Unassigned column (incl. null-staff appts),
date-aware Today's-rail, date nav, column show/hide + Unassigned isolate, create (New +
empty-slot), service/tech dropdowns bound to catalog/staff (staffId FK), multi-service-
per-guest + column expansion, multi-guest group booking, edit + reschedule (time+staff),
confirm/unconfirm, no-show+undo, quick check-in (linked queue entry, pre-filled
assignments), appt-vs-checkin guard, delete, global search → app-native appts.

Full log: scratchpad `calendar-phaseA-findings.md`.

## 3. What we're fixing

### M1 — Calendar columns rebuild on `config.set` (staff add/remove) *(functional)*
`calendar.js:457` store-subscription only re-renders on `appt.upsert`/`appt.delete`/
`hydrate`. Adding or removing a staff member (a `config.set` on `staff`) does **not**
add/remove its column until the Calendar panel is re-opened.
**Fix:** when the Calendar panel is active and a `config.set` lands, rebuild columns
(`buildStaffColumns`) and re-render. Guard so it only re-renders when the staff column
set actually changed (avoid churn on unrelated config writes). Confirmed by code; a
staff added on another device is the real-world trigger.

### M2 — `restoreFromBackup` drops customers + tombstones *(DATA INTEGRITY — headline)*
`worker.js restoreFromBackup` (~1890–1913) `deleteAll()`s then rewrites config, queue,
records, giftcards, appts, and record-`deletion:` markers — but **never rewrites
`customer:` entities**, nor the `custdeletion:`/`apptdeletion:` tombstones. So a
restore-from-backup **silently wipes the entire customer directory** and both tombstone
sets. `buildSnapshot` already includes `customers`/`customerDeletions`/`apptDeletions`
in the snapshot, so the data is present — restore just ignores it.
**Fix (all in `restoreFromBackup`):**
- add `for (const c of (st.customers||[])) put('customer:'+c.id, c)` — **restore the
  customer directory** (currently missing entirely).
- add `for (const c of (st.customerDeletions||[])) put('custdeletion:'+c.id, c)` and
  `for (const a of (st.apptDeletions||[])) put('apptdeletion:'+a.id, a)` — restore
  tombstones so the reject-if-tombstoned guard survives a restore.
- expand the returned `counts` to include `customers` and `appointments`.
- **Cross-repo:** the same restore code lineage exists in **Muse** — verify and port the
  identical fix there (Muse is the live single-salon app with ~1,200 real customers).

### M7 — Delete uses a native `confirm()` → convert to in-DOM modal *(UX consistency)*
`deleteAppt` (`calendar.js:1636`) and the popover Cancel/Delete button
(`calendar.js:1057`) both gate on `confirm('Cancel this appointment?')`. Everywhere else
the app uses styled in-DOM modals (e.g. the check-in "Already booked today" dialog).
**Fix:** replace the native confirm with an in-DOM confirmation consistent with the app's
modal style; unify so `deleteAppt` owns the single confirm and the popover button simply
calls `deleteAppt(id)` (removing the double-confirm asymmetry). Reuse an existing confirm
helper/modal pattern if one exists; otherwise mirror the guard dialog's markup.

### Cleanups (no behavior change)
- **M3** — drop the redundant guarded `applyCalOrder()` before the unconditional one
  (`calendar.js:544`).
- **M4** — remove the orphaned `todayApptSource()` (`calendar.js:234`, no refs).
- **M5** — `staff.js`: normalize the dual `getState` spelling and drop the unused `force`
  param on `loadMyAppts`.
- **M6** — remove the vestigial `checkedInQueueId` field (written-null, never read;
  the "is this appt checked in" lookup already works live via `_queueForAppt`). Drop it
  from the save object (`calendar.js:1599`) and the data-model doc. No migration needed
  (always null on stored appts).

## 4. Explicitly out of scope / leave as-is

- **Dormant Google path** — the `_calTryReady`/`calSignIn`/`_fetchWorkerToken`/… block and
  its "Connect Google Calendar" status text stay untouched; §6 of the Part 1 spec reserves
  them for Part 2 (re-enable without re-adding plumbing). Do NOT clean up dead text there.
- **Reload → signed-out** (observed twice during Phase A; data survived, only the session
  dropped) — tracked as a **separate follow-up** (§13 `turndesk_session` persistence), not
  this pass. May be an artifact of interrupted navigations; owner has not seen it flagged
  as a normal-use bug.
- **Staff-app "My Appointments"** — accepted as verify-by-inspection: reads
  `getState().appointments` filtered by `staffId` (same DO source already confirmed via
  guard/search/rail).
- Pre-existing patterns left intentionally: `store.js` appt.upsert undefined-payload throw
  (mirrors `customer.upsert`), `saveAppt` extra-guest DOM-symmetry, probabilistic seed
  "Unassigned line".

## 5. Testing

- **Unit (`node --test`):**
  - Extend the worker/store restore coverage: a `restoreFromBackup`-shape test (or a pure
    helper) asserting customers + both tombstone sets are rewritten and `counts` includes
    them. If the DO method isn't unit-testable in isolation, cover the rewrite logic via a
    small extracted helper or assert via a scripted snapshot→restore round-trip.
  - Keep the existing store appt-reducer tests green.
- **Browser re-verify (demo, Google off):** M1 — add a staff in Settings, confirm the
  column appears while the Calendar panel stays open (and disappears on remove). M7 — the
  delete confirm renders as an in-DOM modal (no native dialog) and cancels/deletes
  correctly from both the popover and the edit modal.
- **M2 manual:** on the demo, take a backup → mutate → restore → confirm the customer
  directory and appointments are intact and counts report them.
- Full suite + `node --check` on changed files before ship.

## 6. Rollout

- Client (`calendar.js`, `staff.js`) + Worker (`worker.js`) both change.
- Version bump trio (`config.js` APP_VERSION + `version.json` + `sw.js` CACHE_NAME).
- **Deploy order (M2 is a Worker change):** `wrangler deploy` the Worker FIRST, then push
  the client — each owner-gated. Verify the Cloudflare target is the info@musenailandspa.com
  account (turndesk worker).
- No new secrets/bindings; no schema migration (M6 field removal is null-safe).
- Follow-up tickets (not this pass): reload→signout §13 check; port the M2 restore fix to
  Muse; optional "Checked-in ✓" appt badge (uses `_queueForAppt`).
