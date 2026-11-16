# FD Schedule: Draft/Publish + Wider Views + Bounded Repeat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the FD schedule a draft→publish workflow, a 2-week admin builder with pay-period boundaries, a rolling-month staff view, and a bounded "Repeat next weeks" action that replaces the retroactive "every week" pattern.

**Architecture:** All schedule state stays in the per-salon DO `config`. Published schedule = `config.fd_schedule` (unchanged shape, the only thing staff read). New `config.fd_schedule_draft` holds edits until Publish copies it over. A new pure, node-safe helper module `js/app/fd-schedule-util.js` carries every decision worth testing (shift resolution incl. legacy-repeat fallback, forward-repeat dates, structural draft-vs-published diff, pay-period boundaries); `fd-schedule.js` (admin) and `staff.js` (staff view) are thin DOM over it.

**Tech Stack:** Plain ES2020 modules, no build step, Tailwind CDN. `node:test` for unit tests (run per-file on Windows: `node --test-force-exit --test <file>`). Sync via `dispatch('config.set', …)`.

**Spec:** `docs/superpowers/specs/2026-11-15-fd-schedule-draft-publish-design.md`

## Global Constraints

- Multi-tenant: only per-salon `config` keys; **no new global/cross-salon storage**. Draft is `config.fd_schedule_draft`.
- **Staff surfaces read `config.fd_schedule` (published) ONLY** — never `fd_schedule_draft`. (`getFdShift`, used by `staff.js`, stays pinned to published.)
- **Clearing the draft stores `fd_schedule_draft: null` — `config.set` does NOT delete keys** (verified: `store.js:171` assigns the value; `worker.js` `put`s literal `null`; the snapshot re-emits the null key). So **every emptiness check is null-safe**: `!cfg().fd_schedule_draft` (and a non-null draft still counts as empty when its structural diff is 0). **Never** test `'fd_schedule_draft' in cfg()` or `!== undefined`.
- No batch/multi-key op exists in `sync.js` (`dispatch` is single-op; `coalesceConfigSets` is only a flood-guard that keeps last-write-per-key and preserves distinct keys). Publish/Discard = sequential single-key dispatches.
- No build step; plain ES modules; match `fd-schedule.js` style + `// ── Section ── ` (U+2500) markers.
- Existing data must render **identically** after upgrade: per-date shifts, `"__none__"` blanks, and legacy `_repeats`.
- Version trio bumped together: `js/app/config.js` `APP_VERSION`, `version.json`, `sw.js` `CACHE_NAME` (next is **td-v0.84**); add `js/app/fd-schedule-util.js` to `sw.js` `PRECACHE_URLS`; add a plain-English What's-New entry in `main.js` `WHATS_NEW`.
- Commit after each task. **Do not push, do not `wrangler deploy`** (owner's call). Client-only — no Worker change.
- `SCHED_NONE = '__none__'`; week start = Sunday (`setDate(getDate()-getDay())`), matching existing code.

## Review Focus

- **Legacy `_repeats` salons render identically:** `resolveFdShift` must mirror today's `getFdShift` body exactly, incl. **`SCHED_NONE` returning `null` and NOT falling through to the legacy repeat.** → Task 1 tests (both the fallback test and the explicit no-fall-through test).
- **Edit in a non-visible week then Publish:** the badge counts the **whole** draft structurally; Publish pushes every week. → Task 1 `structuralChangeCount` whole-schedule test; Task 5.
- **Staff never see the draft:** with a pending draft, the staff view is byte-identical to published. → Task 6 reads `cfg().fd_schedule`; Task 1 proves the resolver uses the sched passed in.
- **"Repeat next 4 weeks" over a legacy pattern:** writes explicit per-date shifts; those cells must **both** count in the pill **and** highlight in the grid (structural diff drives both, so they agree). → Task 1 structural-diff test for the repeat-over-legacy case.
- **Clearing a shift in Repeat mode over a legacy-repeat date** must write `SCHED_NONE` (blank), not `delete` (which would leak the legacy pattern back). → Task 3.
- **Publish/Discard with no pending draft:** safe no-op (badge 0, buttons hidden), never clobber published; null-draft safe. → Task 1 absent/null-draft test; Task 5 guards.

---

### Task 1: Pure helper module `fd-schedule-util.js`

**Files:**
- Create: `js/app/fd-schedule-util.js`
- Test: `test/fd-schedule-util.test.js`

**Interfaces — Produces:**
- `SCHED_NONE: '__none__'`
- `resolveFdShift(sched, dateStr, fdId) -> {s,e} | 'off' | null` — mirrors `getFdShift` (fd-schedule.js:31-38) with `sched` passed in: explicit `sched[dateStr][fdId]` → if `SCHED_NONE` return `null` (**no fall-through**) → if truthy return it → else legacy `sched._repeats?.[fdId]?.[dow] || null` (dow via `new Date(dateStr+'T12:00:00').getDay()`).
- `repeatForwardDates(fromWeekStartStr, nWeeks, dows) -> string[]` — ISO `YYYY-MM-DD` for each `dow` in `dows` across `nWeeks` consecutive weeks from the Sunday `fromWeekStartStr`.
- `cellChangeKind(published, draft, dateStr, fdId) -> 'added'|'edited'|'removed'|null` — **structural** compare of the EXPLICIT entries `published[dateStr]?.[fdId]` vs `draft[dateStr]?.[fdId]` (deep-equal for `{s,e}` objects; `'off'`/`SCHED_NONE`/undefined compared by value): equal → `null`; published-undefined & draft-present → `added`; published-present & draft-undefined → `removed`; both present & differ → `edited`. Drives BOTH the grid highlight and the count, so they never disagree.
- `structuralChangeCount(published, draft) -> number` — count of `(date,fdId)` with `cellChangeKind != null` across the **union of explicit date keys of both copies**, plus count of `_repeats[fdId][dow]` entries that differ. A `null`/`undefined`/`{}` draft ⇒ 0.
- `hasUnpublishedChanges(published, draft) -> boolean` — `structuralChangeCount(...) > 0`.
- `payPeriodBoundariesInRange(periodForDate, fromStr, toStr) -> string[]` — sorted unique ISO dates of pay-period starts within `[fromStr,toStr]`, using injected `periodForDate(dateStr) -> {from:Date,to:Date}`. Pure/testable via stub.

- [ ] **Step 1: Write failing tests** in `test/fd-schedule-util.test.js` (import `./setup-globals.js` first):
  - `resolveFdShift`: explicit `{s,e}` wins; `'off'` returned; **`SCHED_NONE` → `null` even when that dow has a legacy `_repeats` entry (no fall-through)**; falls back to legacy `_repeats` when no per-date entry; `null` when nothing set; **legacy-only sched resolves the repeat for every weekday (existing-salon-unchanged proof).**
  - `repeatForwardDates('2026-11-29', 4, [1,3])` → the four Mondays + four Wednesdays, with exact ISO strings **crossing into December** (rollover).
  - `cellChangeKind`: added / removed / edited / null; **a draft cell whose explicit `{s,e}` equals a legacy-repeat-resolved value still reports `added`** (structural — the draft now owns it).
  - `structuralChangeCount`: 0 for `null` draft, `{}` draft, and a draft deep-equal to published; counts an added cell, an edited cell, a changed repeat entry; **counts an edit on a date far outside any view window**; **counts every cell a "repeat next 4 weeks" stamp writes over a legacy-pattern salon.**
  - `payPeriodBoundariesInRange` with a stub `periodForDate`: boundary inside a 14-day window; empty when none; dedupes.
- [ ] **Step 2: Run tests, verify FAIL** — `node --test-force-exit --test test/fd-schedule-util.test.js`.
- [ ] **Step 3: Implement `js/app/fd-schedule-util.js`.** Mirror `getFdShift` verbatim for `resolveFdShift`.
- [ ] **Step 4: Run tests, verify PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(fd-schedule): pure helpers for resolve/repeat/structural-diff/pay-period (td-v0.84 wip)"`

---

### Task 2: Draft layer + Publish/Discard in `fd-schedule.js`

**Files:** Modify `js/app/features/fd-schedule.js`

**Interfaces:**
- Consumes: `resolveFdShift`, `SCHED_NONE`, `structuralChangeCount`, `hasUnpublishedChanges` from `fd-schedule-util.js`.
- Produces (on `window` via the existing `main.js` glue array — `fdSchedule` is already in it): `publishFdSchedule()`, `discardFdSchedule()`, `fdSchedViewMode(mode)` (`'draft'|'published'`). Internal: `_publishedSched()` = `cfg().fd_schedule || {}`; `_draftSched()` = a non-null `cfg().fd_schedule_draft` **else a deep clone of published**; `_activeSched()` = draft when `_schedView==='draft'` else published; module state `_schedView='draft'`.

- [ ] **Step 1: Active-copy accessors + redirect the five in-builder reads.** Add `_publishedSched/_draftSched/_activeSched`. Switch these reads off published to the active/draft copy, leaving **`getFdShift` (exported) pinned to published for staff.js**:
  - `renderFdSchedule` cell read (fd-schedule.js:77) → `resolveFdShift(_activeSched(), key, u.id)`
  - the `isRepeat` dot source (fd-schedule.js:78) → read `_activeSched()`
  - `openFdShiftPicker` prefill (fd-schedule.js:96) `cur = getFdShift(...)` → `resolveFdShift(_draftSched(), date, fdId)`
  - `_applyFdShift` clone source (fd-schedule.js:167) → clone from `_draftSched()`
  - (the picker mode default at :104 is handled in Task 3)
- [ ] **Step 2: Route edits to the draft** — `_applyFdShift` final write becomes `dispatch('config.set', { key: 'fd_schedule_draft', value: sched })` (not `fd_schedule`).
- [ ] **Step 3: `publishFdSchedule()`** — guard on `hasUnpublishedChanges(_publishedSched(), cfg().fd_schedule_draft)`; confirm via `window.showWarnModal?.`; `dispatch('config.set',{key:'fd_schedule', value:_draftSched()})` **then** `dispatch('config.set',{key:'fd_schedule_draft', value:null})` (published first → interruption leaves a re-publishable draft); `showToast('Schedule published ✓')`; re-render.
- [ ] **Step 4: `discardFdSchedule()`** — confirm; `dispatch('config.set',{key:'fd_schedule_draft', value:null})`; `showToast('Draft discarded')`; `_schedView='draft'`; re-render.
- [ ] **Step 5: `fdSchedViewMode(mode)`** — set `_schedView`, re-render (toggle wired in Task 5).
- [ ] **Step 6: Verify** `node --check js/app/features/fd-schedule.js`. (No isolated UI yet — the draft write-path is exercised in the browser in Task 4; this task is logic + `node --check`.) Commit — `git commit -m "feat(fd-schedule): draft copy + null-safe publish/discard"`.

---

### Task 3: "Repeat next weeks" replaces "every week"

**Files:** Modify `js/app/features/fd-schedule.js`, `index.html` (`#fd-mode-every`, index.html:2251)

**Interfaces:** Consumes `repeatForwardDates`, `SCHED_NONE`.

- [ ] **Step 1: Relabel the mode** — `index.html:2251` `#fd-mode-every` text "Every week" → "Repeat next 4 weeks". Keep `fdSetShiftMode('every')` + the id (minimize churn) or rename to `'repeat'` consistently in both files (implementer picks one; be consistent).
- [ ] **Step 2: Rewrite the `'every'` branch of `_applyFdShift`** — compute `repeatForwardDates(_weekStart(fdPickerTarget.date → ISO), 4, [...fdSelectedDays])` and for each date set the explicit draft entry (**overwrite**): working/off → `sched[date][fdId] = value`; **clear** → mirror the week-mode logic (fd-schedule.js:180-181): write `SCHED_NONE` when a legacy `_repeats[fdId][dow]` covers that date, else `delete sched[date][fdId]` (prune empty date objects). Writes to the **draft** (Task 2).
- [ ] **Step 3: Drop the repeat-authoring path** — remove `_repeats` **writes** from `_applyFdShift`; keep `_repeats` **reads** (legacy fallback in `resolveFdShift`). In `openFdShiftPicker`, delete the "default to every-week when the day comes from a repeat" block (fd-schedule.js:102-105); default mode is always `'week'`.
- [ ] **Step 4: Verify** `node --check`; browser-confirm in Task 4 that "Repeat next 4 weeks" fills 4 weeks (incl. weeks beyond the visible 2) in the draft. Commit — `git commit -m "feat(fd-schedule): bounded Repeat next 4 weeks replaces every-week"`.

---

### Task 4: 2-week builder grid + structural diff highlight

**Files:** Modify `js/app/features/fd-schedule.js` (`renderFdSchedule`, `fdScheduleWeek`), `css/styles.css`

**Interfaces:** Consumes `resolveFdShift`, `cellChangeKind`.

- [ ] **Step 1: 2-week window** — `fdScheduleWeek` steps ±2 weeks; "Today" → the 2 weeks containing today. Render **two stacked week bands** (loop weeks 0..1), each its own 7-day header, reusing the existing row/cell builder, per mockup `sched-admin-mock.html`.
- [ ] **Step 2: Render from the active copy** — cells read `resolveFdShift(_activeSched(), key, u.id)`. In `'published'` view render `_publishedSched()` read-only (no highlights); a cell click first switches back to draft.
- [ ] **Step 3: Structural diff highlight** — in `'draft'` view, overlay `cellChangeKind(_publishedSched(), _draftSched(), key, u.id)`: **all changed states use the amber "changed" treatment** (ring; struck old published value for `edited`/`removed`). **Do NOT use a green dot** (collides with the existing teal "Repeats weekly" dot at fd-schedule.js:84 — keep that teal dot for legacy-pattern cells, distinct from amber draft-change).
- [ ] **Step 4: CSS** — add the amber changed-cell ring + struck-old classes to `css/styles.css` (follow existing tokens; include dark-mode). Keep the legacy teal repeat dot visually distinct.
- [ ] **Step 5: Browser-verify** (`preview_start name:"turndesk"`, Settings → Front Desk Users → Schedule): two weeks render; editing a cell highlights it amber; "Repeat next 4 weeks" highlights all stamped cells and they persist beyond the visible window. Commit — `git commit -m "feat(fd-schedule): 2-week grid + amber structural diff highlight"`.

---

### Task 5: Draft chrome (pill, toggle, Publish/Discard) + pay-period boundary

**Files:** Modify `index.html` (`#fdusers-schedule-view` header ~1613-1627), `js/app/features/fd-schedule.js` (`renderFdSchedule` header region), `js/app/features/reports.js` (export pay-period fns), `css/styles.css`

**Interfaces:** Consumes `structuralChangeCount`, `payPeriodBoundariesInRange`, the exported `payPeriodDates`/`nextPayPeriod`/`prevPayPeriod`.

- [ ] **Step 1: Export pay-period fns** — add `export` to `payPeriodDates`, `prevPayPeriod`, `nextPayPeriod` in `reports.js`. **Confirm no `window.*` name collision** (they ride onto `window` via the `main.js` glue; these three names are currently unused globals). Build `_periodForDate(dateStr)` wrapping `payPeriodDates(new Date(dateStr+'T12:00:00'))`.
- [ ] **Step 2: Draft chrome** in the schedule-view header: an "N unpublished changes" pill (`structuralChangeCount(_publishedSched(), cfg().fd_schedule_draft)`), a segmented **✎ Draft / What staff see** toggle (`fdSchedViewMode`), **Discard** + **Publish changes** buttons. **Hide the pill + Discard + Publish when the count is 0** (null-safe). Per mockup `sched-admin-mock.html`.
- [ ] **Step 3: Pay-period chip + markers** — chip names the period **containing today**, or, **if today is outside the visible window, the period containing the window start** (spec §7.2). Draw boundary lines at `payPeriodBoundariesInRange(_periodForDate, windowStart, windowEnd)` **only when `pay_period.type !== 'weekly'`** (weekly → chip only, no per-row line). CSS for the chip/marker.
- [ ] **Step 4: Browser-verify** the full loop: pill counts, toggle flips draft/published (published = read-only, no highlights), Publish moves draft→published and clears the pill, Discard reverts; pay-period chip/markers correct for a bi-weekly salon and suppressed for a weekly one. Commit — `git commit -m "feat(fd-schedule): draft chrome + pay-period boundary"`.

---

### Task 6: Staff rolling-month view

**Files:** Modify `js/app/staff.js` (`renderFdView`, ~253-311)

- [ ] **Step 1: Four week-cards** — replace the single-week block with weeks 0..3 from `_fdWeekStart(today + _fdSchedOffset*7)`, each a labeled card ("This week", "Next week", then "Week of <date>"), reading `getFdShift` (**PUBLISHED**). Today's row highlighted; future bands lightly tinted. Match `sched-staff-month-mock.html`.
- [ ] **Step 2: Keep ◀▶** (`fdNavSched`) stepping one week; update `schedLabel` to the 4-week span. Confirm this view touches only `cfg().fd_schedule`.
- [ ] **Step 3: Browser-verify** four weeks show; with a pending admin draft present, the staff view is unchanged (published only). Commit — `git commit -m "feat(fd-schedule): staff rolling-month (4-week) view"`.

---

### Task 7: Version bump, precache, What's-New

**Files:** Modify `js/app/config.js`, `version.json`, `sw.js`, `js/app/main.js`

- [ ] **Step 1:** Bump `APP_VERSION`/`version.json`/`CACHE_NAME` to **td-v0.84**; add `'/turndesk/js/app/fd-schedule-util.js'` to `sw.js` `PRECACHE_URLS`.
- [ ] **Step 2:** Add a plain-English `WHATS_NEW` entry (td-v0.84): publish-when-ready schedule, staff see the next month, "Repeat next 4 weeks", pay-period lines.
- [ ] **Step 3:** Run the FULL suite per-file (all green, report count); `node --check` the changed JS. Commit — `git commit -m "chore: td-v0.84 — FD schedule draft/publish + wider views"`.

---

## Post-build (outside the task loop)
- rigorous-build pre-presentation review (correctness / subject-matter / cosmetics) + senior pass; fix; report.
- Owner reviews; **push + any deploy stay the owner's call** (client-only, so no Worker deploy).
