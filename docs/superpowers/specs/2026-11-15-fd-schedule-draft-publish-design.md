# Front-desk schedule: draft/publish + wider views + bounded "repeat"

**Status:** design, pending owner sign-off → then plan → build (rigorous-build).
**Date:** 2026-11-15. **Scope:** TurnDesk front-desk (FD) staff schedule only (NOT the tech schedule).
**Nature:** client-only (no Worker change). Touches persisted per-salon state (`config.fd_schedule`) → treat
as high-risk; TDD on the pure helpers + review required.

---

## 1. Intent & why

Three real problems with today's FD schedule, from the owner:

1. **Staff can't see ahead in time.** The staff app's "My schedule" shows **one** week, defaulting to *this*
   week. Late in the week a staffer doesn't know if they work next week without thinking to tap ▶ — and
   whatever the manager is mid-typing is already showing.
2. **No control over when changes go live.** Every edit publishes **instantly** to the staff app. The manager
   wants to work on a tentative schedule, see it clearly as tentative, and push it live only when finalized —
   with the ability to throw the draft away.
3. **"Every week" rewrites the past.** The standing repeating pattern has no start date, so changing it
   retroactively rewrites every past week. **Decision: remove the standing "every week" pattern entirely** and
   replace it with a bounded **"Repeat next weeks"** action — which makes the retroactive-rewrite bug
   impossible (there's no longer any standing pattern to edit) and is simpler to reason about.

The manager also wants to **see two weeks at once** while building, with the **pay-period boundary** drawn in.

## 2. Current state (what exists)

- **Data:** `config.fd_schedule = { "YYYY-MM-DD": { <fdId>: {s,e}|"off"|"__none__" }, _repeats: { <fdId>: { 0..6: {s,e}|"off"|null } } }`.
  Per-date overrides win; otherwise the weekly `_repeats[dow]` default applies with **no date floor** (bug #3).
  Synced via `dispatch('config.set', {key:'fd_schedule', value})`.
- **Admin builder** (`js/app/features/fd-schedule.js`, reached from Settings → Front Desk Users → "Schedule"
  toggle): one week at a time, people-down-the-side × 7-days grid, instant publish. Shift picker
  (`openFdShiftPicker`) with "this week" vs "every week" mode + day chips.
- **Staff app** (`js/app/staff.js` `renderFdView`): a one-week "My schedule" list (`_fdSchedOffset`), plus a
  pay-period hours card and clock punches (both unchanged by this work).
- **Pay periods** already exist (`config.pay_period`: weekly/biweekly/bimonthly + startDate). `reports.js` has
  `payPeriodDates(now)` / `nextPayPeriod` / `prevPayPeriod` returning `{from,to}` — **not currently exported.**

## 3. Goals

1. **Draft/publish.** The manager edits a **draft** copy; staff see only the **published** copy. **Publish**
   promotes the *entire* draft to published in one action. **Discard** throws the draft away (revert to
   published). The builder makes "you're editing a tentative draft" and "N unpublished changes" unmistakable
   and highlights which cells differ from published.
2. **Admin builder shows 2 weeks** at once (two stacked week bands), with the **pay-period boundary** drawn in,
   and a toggle to preview "what staff currently see" (the published copy).
3. **Staff see a rolling month** — **this week + the next 3 weeks**, four stacked week-cards, published only.
4. **Replace "every week" with "Repeat next weeks"** — a bounded action that copies a shift forward over the
   next 4 weeks (this week + next 3), so the month staff see fills in one tap, with no standing pattern and no
   retroactive rewrites.

## 4. Non-goals

- No per-staff or per-week partial publish — **Publish is all-or-nothing, the whole schedule** (owner decision).
- **No standing/recurring weekly pattern going forward.** The "every week" concept is intentionally removed;
  forward-filling is the bounded "Repeat next weeks" action. (Existing legacy patterns still *render* — §7.4.)
- No publish notification / push to staff, no approval workflow — staff see the new published copy on next sync.
- No change to the **time clock**, paid-hours, or pay math — the schedule is the *plan*, not pay.
- No change to the **tech** schedule.
- No UI to browse past drafts / schedule history.

## 5. Anti-goals (failure even if it "works")

- **Staff ever seeing a tentative/unpublished shift.** Publish is the only thing that moves the needle for staff.
- **Any existing shift lost or silently changed on upgrade.** Existing schedules — per-date shifts *and* legacy
  `_repeats` patterns — must render **identically** on first load after this ships.
- **Ambiguity about live vs tentative** — if the manager can't instantly tell which they're looking at, it failed.
- Any **cross-salon** bleed (data is per-salon `config`; keep it that way — no new global keys).

## 6. Constraints

- Multi-tenant: everything lives in the per-salon DO `config` (`getState().config`), already salon-scoped. The
  draft is a new config key — still per-salon. **No new cross-salon/global storage.**
- No build step; plain ES modules; Tailwind CDN. Match `fd-schedule.js` style + `// ── Section ──` markers.
- Synced writes go through `dispatch('config.set', …)`. Draft, Publish, Discard are all `config.set` ops.
- **Version trio** (`config.js` APP_VERSION, `version.json`, `sw.js` CACHE_NAME) bumped together; add any new
  client file to `sw.js` PRECACHE; add a plain-English What's-New entry.
- High-risk persisted-state change → **TDD on the pure helpers** + rigorous-build review before owner sees it.

## 7. The design (decided)

### 7.1 Draft/publish data model
- Keep `config.fd_schedule` as the **published** copy — the **only** thing the staff app and the "what staff
  see" preview read. Shape unchanged.
- Add `config.fd_schedule_draft` — the **draft** copy, same shape, present **only while there are unpublished
  edits**. Synced (two managers collaborate; survives device switch) but **no staff surface ever reads it**.
- **"Has unpublished changes"** is *derived*, not a stored flag: a pure structural diff of draft vs published is
  non-empty. **Clearing the draft stores `fd_schedule_draft: null` (the key is NOT deleted** — `config.set`
  cannot delete a key), so emptiness is `!cfg().fd_schedule_draft || changeCount === 0` — **never** an
  `in` / `!== undefined` existence test.
- **Editing:** every edit writes the draft. On the first edit when no draft exists, seed the draft as a deep
  copy of published, then apply the edit.
- **Publish:** set `fd_schedule ← fd_schedule_draft`, then clear `fd_schedule_draft`. Order published-write
  first, then clear draft, so an interruption leaves a re-publishable draft (never lose work). If `sync.js`
  offers a batch/multi-key op, prefer it; otherwise two sequenced `config.set`s.
- **Discard:** clear `fd_schedule_draft` (falls back to = published). Confirm first.
- **No migration needed for the draft:** absent draft = no unpublished changes; staff keep reading `fd_schedule`.

### 7.2 Admin builder — 2-week view (mockup `sched-admin-mock.html`)
- Two **stacked week bands** (week 1 top, week 2 below), each the existing people × 7-days grid. Free,
  Sun-anchored rolling window; navigate ±2 weeks; "Jump to current" = the 2 weeks containing today. **Does not
  snap to pay periods.**
- **Draft chrome:** an "N unpublished changes" pill (**counts the whole schedule, not just the visible window**
  — so an edit weeks out can't hide while Publish still pushes it); a segmented **✎ Draft / What staff see**
  toggle; **Discard** (ghost) + **Publish changes** (primary); a one-line "staff won't see changes until you
  publish" reminder. "What staff see" renders the **published** copy read-only; interacting switches back to Draft.
- **Diff highlighting** (draft vs published, within the visible window): **edited** = amber ring + old value
  struck; **added** = green dot; **removed** = old value struck grey. Driven by the pure diff helper (§8). The
  pill's count is structural (per-date cells + any legacy-pattern overrides), never "resolved day-cells."
- **Pay-period boundary:** a chip naming the pay period **containing today** (or, if today is out of window, the
  period containing the window start); boundary markers drawn where a **bi-weekly / bi-monthly** period
  starts/ends inside the window. **Weekly** salons show the chip but **no per-week marker** (every row would be
  a boundary — noise). Reuse the pay-period helpers (§8).

### 7.3 Staff app — rolling month (mockup `sched-staff-month-mock.html`)
- "My schedule" shows **four labeled week-cards: "This week", "Next week", and the two after** — i.e. this week
  + the next 3 weeks (a rolling month), all rendered by default. Today's row highlighted; the three future
  bands lightly tinted. Reads **published only**.
- Keep ◀▶ to shift the window and look even further out (step one week). The hours card + clock punches are
  unchanged.

### 7.4 "Repeat next weeks" (replaces "every week") + legacy patterns
- The shift picker keeps **"this week"** (stamp the selected day(s) on the viewed week only) and replaces
  **"every week"** with **"Repeat next weeks"**: stamp the selected day(s)'s shift on the clicked person for
  **this week + the next 3 weeks (4 weeks total), forward from the clicked cell's week**, **overwriting** those
  weeks. This writes **explicit per-date shifts** (no standing pattern). It fills the month staff see in one tap.
- **Legacy `_repeats` (existing salons):** keep resolving them as a **read-only fallback in `getFdShift`,
  unchanged**, so existing schedules render identically and nothing goes blank. There is **no editor** for them
  anymore (so bug #3 is impossible) and **no migration/rewrite**. "Repeat next weeks" writes explicit per-date
  shifts that override the legacy fallback for the weeks it touches; far-future weeks a salon never fills keep
  showing their legacy pattern (or blank if none).

## 8. What's left to the builder

- **New pure, node-safe helper module** `js/app/fd-schedule-util.js` (mirrors `notif-util.js`/`rebook-util.js`),
  unit-tested (`test/fd-schedule-util.test.js`):
  - `resolveFdShift(sched, dateStr, fdId)` — pure version of today's `getFdShift`: per-date override →
    `"__none__"` blank → **legacy `_repeats` read-only fallback**. The migration-safe read for existing data.
  - `repeatForwardDates(fromWeekStartStr, nWeeks, dowSet)` — the set of `YYYY-MM-DD` dates a "Repeat next weeks"
    stamp writes (this week + next nWeeks-1, for the selected days-of-week). nWeeks = 4.
  - `scheduleDiff(draft, published, fromDate, toDate, fdIds)` — changed cells with kind `added|edited|removed`
    for highlighting (windowed).
  - `hasUnpublishedChanges(cfg)` / `unpublishedChangeCount(cfg)` — **whole-schedule** structural diff for the pill.
  - `payPeriodBoundariesInRange(cfg, fromDate, toDate)` + chip-label logic — needs `payPeriodDates` /
    `nextPayPeriod` / `prevPayPeriod` **exported** from `reports.js` (or lifted into a shared util). Unit-test.
- **`fd-schedule.js`:** all edit paths write the draft; render 2 stacked weeks from the active copy (draft, or
  the published preview); diff highlights + pay-period markers; wire Publish / Discard / the Draft–Published
  toggle; shift picker's second mode becomes "Repeat next weeks" writing explicit dates via `repeatForwardDates`.
- **`staff.js` `renderFdView`:** render four week-cards (this + next 3) from published; keep ◀▶.
- **Exact DOM/CSS** to match the two mockups; reuse existing cell colors + Tailwind tokens.
- **Version trio** bump + `sw.js` PRECACHE (+ the new util file) + What's-New entry.
- **Tests:** all pure helpers (resolve incl. legacy-fallback, repeat-forward dates, diff, pay-period window).
  A test must prove existing schedules (legacy `_repeats` + per-date overrides) resolve **identically** before
  vs after this change.

## 9. Decisions resolved (was "open questions")

- **"Repeat next weeks":** overwrites the next weeks (not fill-empty-only); reach = **4 weeks total** (this +
  next 3); per the clicked person; anchored at the clicked cell's week, forward. *(owner, 2026-11-15)*
- **Staff view:** **rolling 4 weeks** (this + next 3), not the calendar month. *(owner)*
- **Admin builder stays 2 weeks** (navigate + "Repeat next weeks" fills ahead), not a month view. *(owner)*
- **Legacy repeating patterns:** keep rendering read-only, no migration/rewrite. *(owner — not vetoed)*
- **Unpublished-changes count:** whole-schedule, structural; windowed diff only drives highlighting. *(builder call)*
- **Pay-period chip/markers:** chip = period containing today; markers for bi-weekly/bi-monthly only; weekly =
  label, no per-week marker. *(builder call)*
- **Publish key sequencing:** published-write first, then clear draft; prefer a batch op if `sync.js` has one.
  *(builder call)*
