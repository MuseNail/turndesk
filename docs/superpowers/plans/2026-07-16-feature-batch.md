# TurnDesk feature batch — implementation plan (2026-07-16)

Four owner-requested features, grounded in a full code-exploration pass. TurnDesk is a fork of
Muse; every change is logged in `docs/MUSE-PORT-LOG.md` for a later Muse back-port. **Autopilot:
build → test → review without a sign-off stop; do NOT push/deploy without the owner's OK.**

## Key exploration outcomes that reshaped scope ("criticize, don't comply")

- **F1(b) Assign & Price dropdown already excludes deactivated techs** (`queue.js activeStaff()`); the
  only inactive name shown is a tech *currently assigned* to a live ticket (carried over + labeled
  "(inactive)" so the ticket doesn't read "Unassigned"). **No change — removing it would regress
  in-progress tickets.**
- **Notes surfaces 1 & 3 already work:** the Assign & Price modal already edits BOTH notes
  (`#assign-cust-note` + `#assign-txn-note`, index.html:2205/2212); the Customers-tab profile already
  edits the permanent note (`#edit-cust-notes`). **No rebuild** — net-new work is only Calendar +
  turn/floor cards.
- **Turn/floor cards already open the Assign & Price modal on tap** (both call `showGroupAssignModal`),
  which has both editors — so "edit notes from the card" already works via tap. The real gap is
  **visibility** (you can't tell which customers have notes). → add a note indicator, keep tap-to-edit.

## Data model / config keys touched (Muse port needs the same care)

- `config.staff[]` — add `phone, email, address, ssn4` (ssn4 = **last-4 only**, owner's decision; a
  masked last-4 is not sensitive, so no sync/backup exposure concern). Rides the existing
  `config.set key:'staff'` sync — no store.js/worker.js change.
- `config.customer_notes` — the phone-keyed PERMANENT note map (existing; read `customerNote(phone)`,
  write `dispatch('config.set',{key:'customer_notes',...})`). NOT on the customer entity.
- queue entry `txnNote` — the VISIT note (existing; write `dispatch('queue.entryPatch',{entryId,patch:{txnNote}})`;
  reducer refuses when status is paid/done).
- appt `notes` — the booking note (existing; write `dispatch('appt.upsert',{appt})`).
- `config.js` — add `CUSTOMER_COLORS` palette. `utils.js` — add `customerColor(key)` pure helper.

---

## Feature 1 — Hide deactivated staff

### 1(a) Staff-management list — collapse deactivated behind a toggle
- `js/app/features/staff.js` `renderStaffList()` (32-67): partition `[...cfg().staff].sort(byName)`
  into active vs inactive via `isStaffActive(id)` (exported, :11). Always render active rows. Render
  inactive rows only when a **device-local module boolean** `_showInactive` is true. Inject a toggle
  row at the end of the list — "Show N deactivated" / "Hide deactivated" — calling a new exported
  `toggleShowInactiveStaff()` that flips `_showInactive` and re-renders. No index.html change.
- Preserve `toggleActiveStaff`'s live DOM class-toggle: a full `renderStaffList()` re-render already
  covers it, so re-render after any toggle rather than relying on the in-place class walk.
- Pure helper to test: `partitionStaff(staff, inactiveIds)` → `{active:[], inactive:[]}`.

### 1(c) Technician weekly schedule — hide deactivated
- `js/app/features/staff.js` `renderSchedule()` (296): filter the row source
  `[...cfg().staff].sort(byName).filter(st => isStaffActive(st.id))`. Distinct empty-state string when
  all are filtered out (reuse the :331 fallback shape). Leave `copyLastWeekSchedule` as-is (copying a
  hidden tech's schedule is harmless). fd-schedule.js is front-desk users — untouched.

### 1(b) — no change (see scope note above).

---

## Feature 2 — Staff contact / payroll fields

- **Form** (`index.html` `#staff-modal`, 1963-2051): add a grouped block after Legal Name (1970-1974)
  with `#staff-phone-input`, `#staff-email-input`, `#staff-address-input` (text), and
  `#staff-ssn4-input` (`inputmode="numeric" maxlength="4" autocomplete="off"`, label "SSN (last 4)").
  Pure markup only (index.html CLAUDE rule).
- `staff.js`:
  - `showAddStaff()` (99-112): blank the four new inputs (defensive `const el=…; if(el)` style).
  - `showEditStaff(id)` (114-128): populate from `st.phone/email/address/ssn4` with `|| ''`.
  - `saveStaff()` (172-214): read + normalize; add to **BOTH** object literals (206 edit-spread, 208 add).
    - `phone/email/address`: `.trim()`.
    - `ssn4`: `String(v).replace(/\D/g,'').slice(-4)` (store only last 4).
  - Display: in `renderStaffList()` row, add a muted contact line (phone) + `maskSsn(ssn4)`
    (`ssn4 ? '•••-••-'+ssn4 : ''`). Both non-sensitive (last-4 only).
- Pure helpers to test: `normalizeSsn4(raw)` (last-4 digits), `maskSsn(ssn4)`.

---

## Feature 3 — Calendar: color appointments by customer (not tech)

- `config.js`: add `CUSTOMER_COLORS` — a 12-color palette tuned for tinted bubbles (reuse the
  STAFF_PALETTE hues, which already look right at `+'1f'` alpha).
- `utils.js`: add pure `customerColor(key)` — deterministic char-sum hash → `CUSTOMER_COLORS[idx]`;
  empty/placeholder key returns neutral gray `#9ca3af`.
- `calendar.js`:
  - Import `notePhoneKey` from `square-customers.js` (already imported from there) + `customerColor`
    from utils. Per appt, key = `notePhoneKey(g0.phone) || (g0.name||'').trim().toLowerCase()`;
    empty or a placeholder name (`''`/`'Guest'`) → gray.
  - **Day view** (679): replace the plain-upcoming `else` branch `bg=cal.color+'1f'; border=cal.color`
    with `const cc=customerColor(key); bg=cc+'1f'; border=cc`. KEEP the status-override cascade
    (673-688: paid/complete/inservice/waiting/no-show/past-day) so the operator keeps the
    checked-in/paid/no-show at-a-glance signal — only the plain-upcoming block goes per-customer.
  - **Week view** (808-836): add `const primaryPhone = g0.phone||''` (not extracted today), replace
    the base color (811/823) with `customerColor(key)`, KEEP the past-day/no-show overrides.
  - **Week "Staff" legend** (843-849): it maps block-color→staff and becomes misleading once blocks are
    per-customer → replace with a one-line "Colored by customer" caption (or remove).
  - **Keep tech-colored:** day/week COLUMN HEADERS + the two calendar-selector dots
    (renderGcalCalendarList, renderCalSelectorList) — they identify staff columns, not appts.
- Pure helper to test: `customerColor(key)` — determinism, distinct-ish keys, gray for empty/placeholder.

---

## Feature 4 — Notes editable from Calendar + visible on turn/floor cards

### Calendar appointment detail (`calendar.js` `calEventClick`, 1025-1071)
- Make the **booking note** (`a.notes`) editable (today read-only at :1061) → save via `appt.upsert`.
- Add an editable **customer permanent note** (phone-keyed): load `customerNote(g0.phone)`, save via
  `dispatch('config.set',{key:'customer_notes',…})` (import `customerNote` + a small persist from
  square-customers.js, or replicate the 3-line spread-write). If `g0.phone` is empty, show the field
  disabled with "Add a phone to save a customer note" (mirrors the Assign modal's behavior).
- Add the **visit note** only when a live queue entry exists (`queueMatch` at :1033): show + edit
  `entry.txnNote` via `dispatch('queue.entryPatch',{entryId, patch:{txnNote}})`. When not checked in,
  show a muted "Visit note available after check-in."

### Turn board + floor cards (`turns.js buildCard` 539-592, `floorplan.js stationHtml` 129-165)
- Add a small **note indicator** (a 📝 glyph/dot) on the card when the customer has a permanent note
  (`customerNote(e.phone)`) OR the entry has a visit note (`e.txnNote`). Tapping the card already
  opens the Assign & Price modal with both editors — so editing already works; this only adds the
  missing at-a-glance visibility. No new persistence.

---

## Test plan (Windows: `node --test-force-exit --test <file>` per file; globs hang)

- New `test/staff-visibility.test.js` — `partitionStaff`, `normalizeSsn4`, `maskSsn`.
- New `test/customer-color.test.js` — `customerColor` determinism + gray fallback.
- Extend where a pure seam exists; DOM-heavy render paths are verified in the browser preview, not unit-tested.
- Re-run existing suites that touch staff/calendar/queue for no regression.

## Sequencing (commit per feature)

1. F1 (staff visibility) → commit. 2. F2 (staff PII) → commit. 3. F3 (calendar color) → commit.
4. F4 (notes) → commit. Update `docs/MUSE-PORT-LOG.md` as each lands. Version bump + push only on the
owner's OK at the end.

---

## Revisions from plan review (2026-07-16) — applied before building

**F1(a) staff list:** `toggleActiveStaff` must ALWAYS `renderStaffList()` after the dispatch (drop the
in-place class-walk branch) so a deactivated row moves into the hidden group. The "Show N deactivated"
toggle row ALWAYS renders when `inactive>0` — including when zero active remain (distinct empty-active
string), so "Toggle All Active" can't dead-end. Toast "Moved to deactivated" on deactivate for feedback.

**F2 staff PII:** insert the contact block AFTER Preferred Name (keep Legal+Preferred adjacent).
Populate defensively (`const el=…; if(el) el.value = st.x||''`) so a missed wiring can't wipe a field.
Honest framing: last-4 SSN + home address ARE PII and DO ride `config.staff` to every signed-in tech's
phone + R2 backups (no client-only scoping possible — whole config broadcasts). Owner chose last-4 for
SSN knowing it syncs; addresses/phones follow the same path. Documented in MUSE-PORT-LOG; not overstated
as "not sensitive." Round-trip test: open a fully-populated staff edit, save unchanged, assert no drop.

**F3 calendar color — redesigned so it works across ALL statuses, not just upcoming:**
- Block **body fill = customer color** for every appt with a real customer key (honors "recolor by
  customer" fully). **Left border (3px) = status color** (paid/complete/in-service/waiting/no-show/
  running-late) so the operational status signal is preserved, not lost; plain-upcoming border = the
  customer color. Keep the existing status text label.
- `CUSTOMER_COLORS`: a fresh **~16-hue** const in config.js (NOT importing calendar.js's module-local
  STAFF_PALETTE — copy values, add a comment tying them); larger palette reduces same-day collisions.
- `customerColor(key)` returns gray `#9ca3af` when key is falsy OR (lowercased) `'guest'`. Caller builds
  key from `notePhoneKey(g0.phone) || (g0.name||'').trim().toLowerCase()` (raw fields, never the 'Guest'
  display fallback). Pin key derivation + gray cases in the test.
- **Week view:** keep a per-block tech cue independent of color (tech initials or a small tech-colored
  dot) so short blocks don't lose tech identity; replace the now-misleading "Staff" legend with a
  "Colored by customer" caption.

**F4 notes:**
- Calendar popup: make booking note (`a.notes`) editable (→ appt.upsert); add editable permanent note
  (phone-keyed — spread `cfg().customer_notes` AT WRITE time, debounce, reuse the staff-app no-phone
  guard copy); add the visit note ONLY when `queueMatch` exists — and when that entry is `paid`/`done`,
  render it READ-ONLY with "This ticket is paid — reopen via Assign & Price to edit" (queue.entryPatch
  silently refuses paid/done, so never show an editable field whose save is dropped).
- Cards: show the actual note (truncated one line) on turn-board rows AND queue-list rows (they have
  room + both tap through to the Assign & Price editors); on tight floor tiles use an indicator + a
  `title=` tooltip with the note text. "Visible" = readable, not just a dot. Editing stays via the
  existing tap→modal (both editors already there) — no fragile inline editor.
- No permission gating on the dashboard note editors (front-desk-always-edit is the established pattern;
  the app.*Note flags gate only the technician staff app).
