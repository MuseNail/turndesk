# Muse port log — TurnDesk features to back-port to musedashboard

TurnDesk is a fork of Muse (same architecture: vanilla ES modules, `dispatch`/`applyChange`
DO sync, config-as-synced-state). Features built here that the owner wants in Muse later are
logged below with enough detail to replay the port. **Muse is the live single-salon app —
port deliberately, re-test against Muse's own code (file paths match, but Muse may have
diverged).**

---

## Batch 2026-07-16 — staff visibility, staff PII, calendar customer-coloring, notes-everywhere

Status: **built + committed on TurnDesk main (NOT pushed/deployed), not yet ported to Muse.**
Commits after the billing batch; plan `docs/superpowers/plans/2026-07-16-feature-batch.md`.
Shared pure helpers unit-tested in `test/feature-batch-helpers.test.js`.

### 1. Hide deactivated staff
- `js/app/utils.js` — new pure `partitionStaff(staff, inactiveIds)` → `{active, inactive}`.
- `js/app/features/staff.js`:
  - `renderStaffList()` refactored — extracted `_staffRowHtml(st)`; partitions active/inactive;
    deactivated hidden behind a `_showInactive` module boolean + a "Show N deactivated" toggle
    row (`toggleShowInactiveStaff()`) that ALWAYS renders when any inactive exist (no
    all-deactivated dead-end).
  - `toggleActiveStaff(id)` — dropped the `btn` in-place class-walk; always `renderStaffList()`
    + toast on deactivate. (Muse's row onclick passes `this` — drop that arg there too.)
  - `renderSchedule()` — line ~296 tech rows now `.filter(st => isStaffActive(st.id))`; distinct
    empty-active string. `fd-schedule.js` (front-desk users) untouched.
- **No change** to the Assign & Price tech dropdowns (already exclude inactive via `activeStaff()`;
  the carried-over currently-assigned inactive tech is intentional).

### 2. Staff contact / payroll fields
- New staff fields: `phone, email, address, ssn4` on `config.staff[]` (rides the existing
  `config.set key:'staff'` sync — no store.js/worker.js change).
- **SSN stored as LAST-4 ONLY** (owner decision, after being shown that `config.staff` syncs to
  every tech's phone + R2 backups — a masked last-4 avoids the exposure; full SSN is NOT stored).
  ⚠️ Muse note: phone/email/**home address** also ride config.staff to every device + backups —
  same (lesser) PII exposure; acceptable per owner but document it. No per-field sync scoping
  exists (whole config broadcasts).
- `js/app/utils.js` — `normalizeSsn4(raw)` (last-4 digits), `maskSsn(ssn4)` (`•••-••-####`).
- `staff.js` — `_setStaffContactFields(st)` (defensive populate), `saveStaff()` reads+adds the 4
  fields to BOTH object literals; `renderStaffList` shows a compact contact line.
- `index.html` `#staff-modal` — 4 inputs after Preferred Name (phone/email in a 2-col grid,
  address, `#staff-ssn4-input` maxlength=4 inputmode=numeric).

### 3. Calendar: color appointments by CUSTOMER (not tech)
- `js/app/config.js` — new `CUSTOMER_COLORS` (16 distinct dark hues; separate from calendar's
  module-local STAFF_PALETTE on purpose).
- `js/app/utils.js` — pure `customerColor(key)` (rolling char-hash → CUSTOMER_COLORS; gray
  `#9ca3af` for falsy/`'guest'`).
- `js/app/features/calendar.js`:
  - `apptCustomerColor(g0)` = `customerColor(notePhoneKey(g0.phone) || name.toLowerCase())`.
  - Day view + week view: block **body fill = customer color** for every appt with a real key;
    **status stays** via the left border + badge (no-show keeps its red fill; a plain-upcoming
    block's border becomes the customer color). Week view adds a small **per-tech dot** (columns
    there are days) and replaces the per-staff legend with a "colored by customer" caption. Day
    per-tech column headers unchanged.

### 4. Notes editable everywhere
- Two note types (both pre-existing): PERMANENT = phone-keyed `config.customer_notes`
  (`customerNote(phone)` read; `dispatch('config.set',{key:'customer_notes',…})` write); VISIT =
  queue entry `txnNote` (`dispatch('queue.entryPatch',{entryId,patch:{txnNote}})`; reducer refuses
  paid/done).
- **Already worked (left as-is):** Assign & Price modal edits both; Customers-tab profile edits the
  permanent note.
- `js/app/features/calendar.js` `calEventClick` — added editors for the permanent note (write-time
  spread; hint when no phone) + the visit note (only when a queue entry exists; READ-ONLY with an
  explanation when paid/done). Save handlers `calSaveCustNote` / `calSaveVisitNote`.
- `js/app/features/square-customers.js` — shared `cardNotePreview(phone, txnNote, opts)`.
- Note previews added to turn cards (`turns.js buildCard`), floor tiles (`floorplan.js stationHtml`,
  icon+tooltip), and queue rows (`queue.js buildQueueRow`). Editing stays via the existing tap→modal.

### Review outcomes (2026-07-16) — for the Muse port
- 3-lens + senior review passed (senior verdict: ship-with-followups; no correctness/data-safety
  issues). Fixes folded in: day-view past-completed keeps its blue status border; a "Late" badge
  was added for the day-view running-late state (customer fill made the amber-only signal quieter);
  CUSTOMER_COLORS avoids status hues; week-view tech identity is an initial-in-a-colored-circle;
  floor-tile 📝 shows for the visit note only.
- ⚠️ **Bundled, NOT part of these 4 features:** the F4 commit's `turns.js` also carries a
  PRE-EXISTING uncommitted recolor — `buildCard` now uses `effectiveEntryStatus(e)` for the avatar
  + border/tint, adding a violet "Awaiting price" state for a complete-but-unpriced ticket (the
  td-v0.47 "match the floor plan" turns-color direction). Correct + tests pass; kept. When porting
  to Muse, port this deliberately (or confirm Muse already has it).
- Non-blocking follow-ups the owner may want: eyeball the calendar coloring in the live app;
  decide whether staff email/address should show anywhere beyond the edit form (currently the list
  row shows phone + masked SSN only).
