# TurnDesk — App-native appointments (Part 1 of the calendar re-architecture)

Date: 2026-07-07
Status: approved (brainstorm), ready for implementation planning
Scope: **Part 1 only** — make appointments a first-class app entity so the calendar works
entirely in the app with no Google. **Part 2 (optional Google sync, per-salon + per-staff)
is a separate later spec.**

## 1. Goal

Today a TurnDesk appointment has zero presence in the app: it's N Google Calendar events
(one per calendar × guest) joined by a shared `museGroupId`, with app metadata packed into
Google's `extendedProperties`, reconstructed into a logical booking at render time. Google
is 100% the source of truth.

Move appointments into the salon's Durable Object as a first-class synced entity (like
`queue`/`records`), preserving **every** current calendar capability, so the calendar is
fully functional with Google disconnected. This inherently makes Google **optional** (you
don't need it) — Part 2 later re-adds Google as an opt-in sync layer.

## 2. Capabilities to preserve (nothing may regress)

From the current `calendar.js` (1833 lines) + touchpoints, all of these must keep working,
now reading/writing the DO instead of Google:

- Day view (per-staff columns + time slots) and Week view; day/week toggle; date nav
  (prev/next/today/date-picker); the "now" red line; pinch/ctrl-wheel zoom.
- Per-staff columns + an **Unassigned** column/pool; show/hide + drag-reorder columns;
  off-duty auto-hide with per-day "peek".
- Create appointment (empty-slot click + "New Appointment"); edit; delete/cancel;
  reschedule (edit date/time/staff and re-save).
- **Multi-service per guest** (each service line has its own assigned staff) and
  **multi-guest / group bookings** ("Add another guest").
- Confirm / unconfirm; no-show / undo; per-appointment notes.
- Quick check-in from an appointment (single or party picker); the appt-vs-checkin guard
  ("already booked today → check in from the appointment").
- Today's-Appointments right-rail panel (+ upcoming-only filter); appointment-details popover.
- Turns integration (upcoming-appt strip + in-slot "next appt" note); reminder banners
  (`appt-reminders.js`); global-search appointment results; the staff-app "My Appointments".
- Push-to-newly-assigned-staff on booking; display-hours setting; color coding
  (by staff / by status).

Explicitly NOT preserved in Part 1: the Google **Tasks** side-panel (Google-only — hidden
while Google is off; not converted); any Google read/write.

## 3. Data model

One appointment = one booking. New DO entity, stored per-key like records:

```
appt:<id>  →  {
  id,                       // 'appt_<ts36>_<rand>'
  start, end,               // ISO datetime strings
  guests: [
    { name, phone,          // guest identity
      lines: [ { serviceId, staffId } ] }   // per-service staff; staffId null = Unassigned
  ],
  notes,                    // free text
  confirmed,                // bool
  noShow,                   // bool
  checkedInQueueId,         // queue entry id once checked in (null until then)
  createdAt, updatedAt,     // ms — updatedAt drives the stale-write guard
  updatedBy,                // device id
}
```

Key modeling changes vs. today:
- **One row replaces N Google events.** Guests and per-service staff live inside the row;
  the grid renderer expands `guests[].lines[].staffId` into the correct per-staff columns.
  No `museGroupId`, no `extendedProperties`, no per-calendar copies.
- **Real `staffId` foreign key** (into `config.staff[].id`) replaces the fragile
  case-insensitive name-match against Google calendar titles. `staffId === null` = the
  Unassigned pool. Renaming a staff member no longer breaks anything.
- No legacy-description parsing, no eventual-consistency ghost/pin machinery (reads are
  synchronous from the DO).

### Sync layer (mirrors records/queue)
- `state.appointments: []` added to `store.js` initial state + `emptyConfig()` sibling arrays.
- `store.js applyChange` gains:
  - `appt.upsert` → `upsertByIdGuarded(appointments, payload.appt)` (stale-write guard on
    `updatedAt`, reject-if-tombstoned, mirroring `record.save`).
  - `appt.delete` → mark deleted + push an `apptDeletions` tombstone (mirroring `record.delete`).
- `dispatch('appt.upsert', { appt })` / `dispatch('appt.delete', { id })` in `sync.js`
  stamp `updatedAt`/`updatedBy` and ride the existing optimistic-apply + offline outbox +
  WebSocket path — no new transport.
- Worker DO `applyMutation` gains `appt.upsert` (put `appt:<id>` with the stale guard) and
  `appt.delete` (mark deleted + `apptdeletion:<id>` marker), exactly like `record.save`/
  `record.delete`.
- `buildSnapshot` adds prefixes: `appt:` → `state.appointments`, `apptdeletion:` →
  `state.apptDeletions`. R2 backups + operator export therefore include appointments
  automatically.

## 4. What changes, file by file

Reuse the Explore map's function names.

- **`js/app/store.js`** — add `appointments` array + the two reducer cases + tombstones.
- **`js/app/sync.js`** — add `appt.upsert`/`appt.delete` to the `dispatch` stamping/echo
  logic (same treatment as `record.save`).
- **`cloudflare/worker.js`** — DO `applyMutation` cases + `buildSnapshot` prefixes.
- **`js/app/features/calendar.js`** — the core rewrite:
  - Column source: `_calCalendars` becomes the salon's **staff** (`config.staff`) + an
    Unassigned column, keyed by `staffId`; show/hide/reorder/auto-hide re-key from
    calendarId → staffId (`saveCalOrder`/`applyCalOrder`/`calColumnOff`/`calIsHidden` etc.).
  - Appointment source: `_calEvents`/`todayApptSource`/`apptsForTurns`/`apptsForReminders`/
    `renderTodaysAppointments`/`findTodayApptFor` read `getState().appointments` (filtered by
    date), not gapi. The grid engine, lane-clustering, color rules, now-line, zoom render
    unchanged against the native shape.
  - Write path: `saveAppt` builds ONE appointment object and calls `dispatch('appt.upsert', …)`
    (was N gapi insert/update/delete). `deleteAppt` → `dispatch('appt.delete', …)`.
    `calToggleConfirmed`/`calMarkNoShow` → upsert the row with the flag flipped (no
    per-copy fan-out, no `_eventGroupRefs`).
  - Delete: the whole `_gcalNoteDeleted`/`_gcalNoteWritten`/`_gcalApplyGuards`/`_calGhosts`/
    `_calPins` subsystem is removed. `calLoadAndRender`/`calSilentSync`/`ensureTodayApptEvents`/
    the Google token plumbing (`_fetchWorkerToken`/`ensureFreshToken`/`loadGCalScripts`/
    `calSignIn`/`calSignOut`) are no longer called in the render path — left in the file but
    dormant (never invoked in Part 1), so Part 2 can re-enable without re-adding plumbing
    (see §6). Store-subscription re-renders the grid on `appt.*` changes.
  - Booking modal: the service-line + extra-guest editing model (`_apptLines`,
    `_apptExtraGuests`) is kept; the per-line "tech" dropdown now lists `config.staff`
    (value = `staffId`, plus an Unassigned option).
- **`js/app/features/queue.js` + `checkin.js`** — check-in from an appointment sets
  `appointmentId` on the queue entry (was `calEventId`); `_buildCheckinEntry` pre-fills
  `assignments` from the appt's guest lines (serviceId + staffId). `checkinApptGuard`
  reads DO appointments. The local "isAppointment" quick-flag (a booked walk-in with no
  calendar row) is unchanged.
- **`js/app/features/turns.js`, `appt-reminders.js`, `search.js`** — unchanged logic;
  they already consume `apptsForTurns`/`apptsForReminders`/`findTodayApptFor`, which now
  return DO-sourced data. Re-point only.
- **`js/app/staff.js`** — the tech "My Appointments" reads `getState().appointments`
  filtered to the signed-in tech's `staffId`; the parallel Google REST reader
  (`_gcalGet`/`loadMyAppts`) is retired.
- **`js/app/features/reports.js`** — add `appointmentId` to the `saveRecord` field
  whitelist (fixes the Explore-flagged gap where the appointment link was dropped at
  archive time); `isAppointment` handling unchanged.
- **`index.html`** — calendar toolbar: hide the Connect-Google button + the Google Tasks
  panel while Google is off (Part-2 re-adds); the appt modal's per-line tech dropdown
  binds to `config.staff`.
- **`js/app/features/settings.js`** — the Google-connect settings leaf + the
  "which calendar is Unassigned" picker are hidden in Part 1 (Part 2 re-adds a Google
  section); display-hours + auto-hide settings unchanged.

## 5. Migration + the demo

- **Start fresh.** No import of existing Google events (TurnDesk salons are new; none have
  real appointment history). A salon that had Google appointments simply starts with an
  empty app calendar; its Google events remain in Google, untouched.
- **Demo seeding.** `tools/seed-demo.mjs` seeds a handful of sample app-native appointments
  (a few today across staff + a few upcoming days, some confirmed) via `appt.upsert`
  mutations, so the demo calendar looks alive. Re-runnable/idempotent like the rest of the
  seeder (deterministic ids `appt-<n>`).
- **localStorage.** The column show/hide/reorder keys become staffId-based
  (`turndesk_cal_staff_hidden`/`turndesk_cal_staff_order`); the old `gcal_*` keys (token,
  hidden, order) and the doubled `turndesk_turndesk_gcal_*` prefix become inert/removed.
  `turndesk_cal_hours`, `turndesk_cal_view`, reminder keys unchanged.

## 6. Google in Part 1 (dormant, not deleted)

The Worker `/gcal/*` routes + the DO `gcal:blob` are **left in place but unused** by the
client (no client calls them in Part 1). The client's Google connect/token code is guarded
behind an off-by-default path so Part 2 can re-enable it without re-adding plumbing. The
`/gcal/callback` multi-tenant routing bug the Explore flagged (salonId resolves to `''`)
is Part-2's problem to fix before Google sync ships — not touched here.

## 7. Error handling / edge cases

- Appointments ride the same stale-write guard + offline outbox + echo-suppression as
  records/queue — an offline-created appointment replays on reconnect; a stale replay can't
  clobber a newer edit; a deleted appointment can't be revived (tombstone).
- A guest line with `staffId` pointing at a since-deleted staff member renders in the
  Unassigned column (defensive: unknown staffId → Unassigned), never throws.
- Rendering guards (per-appointment try/catch + a whole-grid try/catch) so one malformed
  appointment can't blank the calendar (carry forward the existing render hardening).

## 8. Testing

- **Unit (`node --test`, mirrors `test/store.test.js`):** the `store.js` appt reducer —
  upsert, upsert-stale-write-rejected, delete + tombstone, tombstone-blocks-revive,
  unknown-staffId-falls-to-unassigned (a pure helper).
- **Preview:** seed appointments into a local/demo state and confirm the grid renders them
  in the right staff columns (day + week), the booking modal creates/edits, confirm/no-show
  toggle, and the Today panel/turns strip populate — all with Google disconnected.
- **Live (deployed demo):** create an appointment on one device → it appears on another
  (DO sync); edit/cancel propagate; check-in from an appointment creates the linked queue
  entry; the operator export includes appointments.

## 9. Out of scope (later)

- **Part 2:** optional Google sync — per-salon and per-staff opt-in, the connect UI, the
  push/pull adapter mapping the native shape to/from Google Events, and the
  `/gcal/callback` tenant-routing fix.
- App-native Google **Tasks** replacement.
- Recurring appointments (not supported today; not added).

## 10. Rollout

- No new secrets or bindings. New DO storage prefixes (`appt:`, `apptdeletion:`) — additive,
  covered by the existing snapshot/backup machinery.
- Version bump (config.js + version.json + sw.js) on ship.
- Client + Worker both change → GitHub Pages push + `wrangler deploy` (owner OK each).
