# TurnDesk App-Native Appointments (Part 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move TurnDesk appointments out of Google Calendar and into the salon's Durable Object as a first-class synced entity (`appt:<id>`, like `records`/`queue`), so the calendar is fully functional with Google disconnected — preserving every current capability.

**Architecture:** One appointment = one DO row (`appt:<id>`) holding all guests and their per-service staff. It rides the existing `dispatch → applyChange → DO applyMutation → broadcast → buildSnapshot` sync path with the same stale-write guard + tombstone + offline-outbox machinery as records. `calendar.js` re-points from Google (gapi + `_calEvents` grouped by `museGroupId`) to `getState().appointments`; calendar columns become `config.staff` keyed by a real `staffId` foreign key (replacing the fragile calendar-name→staff-name match). All Google plumbing stays in the file but goes **dormant** (never invoked in Part 1) so Part 2 can re-enable it.

**Tech Stack:** Vanilla ES2020 modules (no build step, no framework), Cloudflare Worker + Durable Object, `node --test` for unit tests, GitHub Pages for the static client.

## Global Constraints

*(Every task's requirements implicitly include this section. Values are copied verbatim from the spec and the current code.)*

- **No build step / no framework / no new dependencies.** Plain ES modules loaded directly by the browser. Do not add libraries.
- **Additive DO storage.** New key prefixes `appt:` and `apptdeletion:` only. Never rename/remove existing keys. No data migration — TurnDesk salons start with an empty app calendar (existing Google events stay in Google, untouched).
- **Google is dormant, not deleted.** Leave every `/gcal/*` Worker route, the DO `gcal:blob`, and the client's `_gcal*`/`loadGCalScripts`/`calSignIn`/`calSignOut`/`ensureFreshToken`/`_fetchWorkerToken` functions **in the file**. In Part 1 the client simply never calls them. Do **not** touch the `/gcal/callback` tenant-routing bug (Part 2).
- **Canonical appointment shape** (store this exact structure; `staffId === '' | null` means the Unassigned column; `serviceId` references `config.services[].id`; `staffId` references `config.staff[].id`):
  ```js
  appt:<id>  →  {
    id,                 // 'appt_' + Date.now().toString(36) + '_' + <5-char rand>
    start, end,         // ISO datetime strings
    guests: [ { name, phone, lines: [ { serviceId, staffId } ] } ],
    notes,              // free text
    confirmed,          // bool
    noShow,             // bool
    checkedInQueueId,   // queue entry id once checked in (null until then)
    createdAt,          // ms
    updatedAt,          // ms — drives the stale-write guard (stamped by dispatch)
    updatedBy,          // device id (stamped by dispatch)
  }
  ```
- **Ops:** `appt.upsert` (payload `{ appt }`) and `appt.delete` (payload `{ id }`). State arrays: `state.appointments`, `state.apptDeletions`.
- **Queue/record ↔ appointment link field is `appointmentId`** (renamed from `calEventId`; `calEventId` referenced only inside `calendar.js` today, plus one write in `_buildCheckinEntry`).
- **Column identity = `staffId`.** `_calCalendars` entries are `{ id, name, color }` where `id` is the `staffId`; the Unassigned column uses `id = ''`. `unassignedCalId()` returns `''`.
- **localStorage re-key:** `turndesk_cal_staff_hidden` and `turndesk_cal_staff_order` replace the (doubled-prefix) `turndesk_turndesk_gcal_hidden` / `turndesk_turndesk_gcal_order`. Keep `turndesk_cal_hours`, `turndesk_cal_view`, `turndesk_cal_upcoming` unchanged.
- **Version bump on ship:** `js/app/config.js` `APP_VERSION = 'td-v0.18'`, `version.json` `"td-v0.18"`, `sw.js` `CACHE_NAME = 'turndesk-v0.18'` — all three together (current: `td-v0.17` / `turndesk-v0.17`).
- **Test commands:** `npm test` (`node --test "test/**/*.test.js"`), `npm run check` (`node --check cloudflare/worker.js`). Run from repo root `C:/Users/cpach/Documents/GitHub/turndesk`.
- **Deploy is owner-gated.** `git push` and `wrangler deploy` require the owner's explicit OK each time. This plan ends at "ready to ship."

---

## File Structure

| File | Responsibility in this change |
|---|---|
| `js/app/store.js` | Add `appointments`/`apptDeletions` state arrays; `appt.upsert`/`appt.delete` reducer cases; hydrate/cache wiring. |
| `js/app/sync.js` | Stamp `appt.upsert` writes with `updatedAt`/`updatedBy`; extend the op doc comment. |
| `cloudflare/worker.js` | DO `applyMutation` `appt.upsert`/`appt.delete` cases; `buildSnapshot` `appt:`/`apptdeletion:` prefixes; `restoreFromBackup` appointment restore. |
| `test/store.test.js` | Unit tests for the appt reducer (upsert, stale-reject, delete+tombstone, revive-blocked, unknown-staff-defensive). |
| `js/app/features/calendar.js` | The core re-point: staff columns, native accessors, day+week grid, write path, modal, check-in, guard. (~1833 lines; edited throughout.) |
| `js/app/features/reports.js` | Add `appointmentId` to the `saveRecord` field whitelist; `_pastRecordMatch` (in calendar.js) reads `record.appointmentId`. |
| `js/app/staff.js` | Tech "My Appointments" reads `getState().appointments` filtered to the signed-in tech; retire `_gcalGet`. |
| `index.html` | Hide the Connect-Google button + Google Tasks panel. (The per-line dropdown's *options* become staff via `_buildTechOptions` in Task 4; the static "Services & Technicians" label at line 2862 stays accurate — no HTML label edit.) |
| `js/app/features/settings.js` | Hide the Google-connect Integrations leaf in Part 1 (keep display-hours + auto-hide). |
| `tools/seed-demo.mjs` | Seed a handful of app-native demo appointments via `appt.upsert`. |
| `js/app/config.js`, `version.json`, `sw.js` | Version bump trio. |

---

## Task 1: Store reducer + unit tests

**Files:**
- Modify: `js/app/store.js` (initial state ~31-46, `hydrate` ~136-142, `applyChange` add cases after ~213, `saveCache` ~281-285)
- Test: `test/store.test.js` (append tests)

**Interfaces:**
- Produces: `state.appointments: Array<Appt>`, `state.apptDeletions: Array<string>`; `applyChange('appt.upsert', { appt })` and `applyChange('appt.delete', { id })` reduce with the same stale-write guard + tombstone semantics as `record.save`/`customer.delete`. `hydrate` reads `incoming.appointments` / `incoming.apptDeletions`; `saveCache` persists both.
- Consumes: existing `upsertByIdGuarded`, `isStaleWrite`, `removeById` (already in `store.js`).

- [ ] **Step 1: Write the failing tests**

Append to `test/store.test.js`:

```js
// ── App-native appointments (appt.upsert / appt.delete) ──────────────────────
// Mirrors the record.save/customer.delete guards: an older appt can't clobber a newer
// one; a deleted appt can't be revived by a late offline replay (tombstone).

test('appt.upsert: brand-new appt applies; older update is rejected; newer applies', () => {
  hydrate({ state: { appointments: [], apptDeletions: [] }, seq: 1 });
  applyChange('appt.upsert', { appt: { id: 'a1', start: '2026-07-07T14:00:00.000Z', confirmed: false, updatedAt: 100 } });
  assert.equal(getState().appointments.find(x => x.id === 'a1').start, '2026-07-07T14:00:00.000Z');
  // stale (older) update — rejected, confirmed stays false
  applyChange('appt.upsert', { appt: { id: 'a1', start: '2026-07-07T14:00:00.000Z', confirmed: true, updatedAt: 50 } });
  assert.equal(getState().appointments.find(x => x.id === 'a1').confirmed, false);
  // newer update — applies
  applyChange('appt.upsert', { appt: { id: 'a1', start: '2026-07-07T15:00:00.000Z', confirmed: true, updatedAt: 200 } });
  const a = getState().appointments.find(x => x.id === 'a1');
  assert.equal(a.confirmed, true);
  assert.equal(a.start, '2026-07-07T15:00:00.000Z');
});

test('appt.delete: removes the appt and writes a tombstone that blocks revival', () => {
  hydrate({ state: { appointments: [{ id: 'a2', start: '2026-07-07T14:00:00.000Z', updatedAt: 100 }], apptDeletions: [] }, seq: 1 });
  applyChange('appt.delete', { id: 'a2' });
  assert.equal(getState().appointments.find(x => x.id === 'a2'), undefined);
  assert.ok(getState().apptDeletions.includes('a2'));
  // a stale offline replay tries to re-create it with a fresh stamp — the tombstone blocks it
  applyChange('appt.upsert', { appt: { id: 'a2', start: '2026-07-07T14:00:00.000Z', updatedAt: 999 } });
  assert.equal(getState().appointments.find(x => x.id === 'a2'), undefined);
});

test('appt.upsert: unstamped legacy write still applies (guard never blocks untimestamped)', () => {
  hydrate({ state: { appointments: [{ id: 'a3', notes: 'x' }], apptDeletions: [] }, seq: 1 });
  applyChange('appt.upsert', { appt: { id: 'a3', notes: 'y' } });   // no updatedAt either side
  assert.equal(getState().appointments.find(x => x.id === 'a3').notes, 'y');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — the three new tests error (e.g. `getState().appointments` is `undefined`, so `.find` throws) or assertions fail, because `state.appointments`/`apptDeletions` and the two reducer cases don't exist yet.

- [ ] **Step 3: Add the state arrays**

In `js/app/store.js`, in the `const state = { … }` object, add the two arrays right after the `customerDeletions` line (currently ~line 39):

```js
  customerDeletions: [],   // array of deleted customer ids (strings) — tombstones so a stale offline upsert can't revive a deleted customer
  appointments: [],   // synced app-native appointments (per-record DO keys appt:<id>); one row per booking, guests + per-service staffId inside
  apptDeletions: [],  // array of deleted appointment ids (strings) — tombstones so a stale offline upsert can't revive a cancelled appt
```

- [ ] **Step 4: Hydrate + cache the new arrays**

In `hydrate` (in `store.js`), add these two lines immediately after the `state.customerDeletions = …` line (currently ~line 141):

```js
  state.appointments = Array.isArray(incoming.appointments) ? incoming.appointments : [];
  state.apptDeletions = Array.isArray(incoming.apptDeletions) ? incoming.apptDeletions.map(d => String(d.id ?? d)) : [];
```

In `saveCache` (in `store.js`), add `appointments` and `apptDeletions` to the persisted object (extend the existing `localStorage.setItem(CACHE_KEY, JSON.stringify({ … }))`), so the offline cache restores them:

```js
      giftcards: state.giftcards, customers: state.customers, deletions: state.deletions,
      customerDeletions: state.customerDeletions,
      appointments: state.appointments, apptDeletions: state.apptDeletions,
      seq: state.seq,
```

- [ ] **Step 5: Add the reducer cases**

In `applyChange` (in `store.js`), add these two cases immediately after the `case 'customer.bulkDelete': { … }` block (currently ends ~line 241), before `case 'audit.log':`:

```js
    case 'appt.upsert':
      // Don't revive a cancelled appointment (mirrors record.save's deletion guard), and
      // reject a stale offline copy so it can't clobber a newer edit (mirrors record.save).
      if (state.apptDeletions.includes(String(payload.appt && payload.appt.id))) return;
      if (!upsertByIdGuarded(state.appointments, payload.appt)) return;   // stale → keep the newer copy
      break;
    case 'appt.delete':
      // Remove + tombstone (mirrors customer.delete — appointments carry no status field).
      removeById(state.appointments, payload.id);
      if (!state.apptDeletions.includes(String(payload.id))) state.apptDeletions.push(String(payload.id));
      break;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all existing tests plus the three new appt tests are green.

- [ ] **Step 7: Commit**

```bash
git add js/app/store.js test/store.test.js
git commit -m "feat(store): app-native appointment reducer (appt.upsert/appt.delete) + guards"
```

---

## Task 2: Client dispatch stamping + Worker DO persistence

**Files:**
- Modify: `js/app/sync.js` (`dispatch` stamping ~203-213, op doc comment ~195-197)
- Modify: `cloudflare/worker.js` (`applyMutation` cases after ~1541; `buildSnapshot` ~1788-1804; `restoreFromBackup` ~1883-1886)

**Interfaces:**
- Consumes: `applyChange('appt.upsert'|'appt.delete', …)` from Task 1; the Worker helper `_isStaleWrite` (already in `worker.js`, used by `record.save`).
- Produces: `dispatch('appt.upsert', { appt })` stamps `appt.updatedAt`/`appt.updatedBy` then optimistically applies + enqueues + sends. DO persists `appt:<id>` / `apptdeletion:<id>`, broadcasts the change, and `buildSnapshot` returns `state.appointments` / `state.apptDeletions`.

- [ ] **Step 1: Stamp appt writes in `dispatch`**

In `js/app/sync.js`, in `dispatch`, add this line immediately after the `customer.bulkUpsert` stamping line (currently ~line 213):

```js
  // Appointments — stamp so a stale offline copy can't clobber a newer edit (mirrors record.save).
  if (op === 'appt.upsert' && payload && payload.appt) { payload.appt.updatedAt = Date.now(); payload.appt.updatedBy = DEVICE_ID; }
```

Update the op-list doc comment just above `export function dispatch` (currently ~line 195-197) to include the new ops (append to the list):

```js
//   | 'customer.upsert' | 'customer.delete' | 'customer.bulkUpsert' | 'customer.bulkDelete'
//   | 'appt.upsert' | 'appt.delete'
```

- [ ] **Step 2: Add the DO `applyMutation` cases**

In `cloudflare/worker.js`, in `applyMutation`'s `switch (op)`, add these two cases immediately after the `case 'customer.bulkDelete': { … }` block (currently ends ~line 1578), before `case 'audit.log':`:

```js
        case 'appt.upsert': {
          // App-native appointment (per-record key, mirrors records). Don't revive a cancelled
          // appointment, and reject a stale offline copy so it can't clobber a newer edit.
          const aKey = 'appt:' + payload.appt.id;
          if (await this.state.storage.get('apptdeletion:' + payload.appt.id)) { stale = true; break; }
          const prevAppt = await this.state.storage.get(aKey);
          if (_isStaleWrite(prevAppt, payload.appt)) { stale = true; break; }
          await this.state.storage.put(aKey, payload.appt);
          break;
        }
        case 'appt.delete': {
          await this.state.storage.delete('appt:' + payload.id);
          await this.state.storage.put('apptdeletion:' + payload.id, { id: payload.id, at: new Date().toISOString() });
          break;
        }
```

- [ ] **Step 3: Add the `buildSnapshot` prefixes**

In `cloudflare/worker.js`, in `buildSnapshot`:

First, add `appointments`/`apptDeletions` to the initial `state` object (currently line 1788):

```js
    const state = { config: {}, configMeta: {}, queue: [], records: [], giftcards: [], customers: [], deletions: [], customerDeletions: [], audit: [], appointments: [], apptDeletions: [] };
```

Then add these two list-loops immediately after the `custdeletion:` block (currently ~line 1801-1802), before the `deletion:` block:

```js
    const ap = await this.state.storage.list({ prefix: 'appt:' });
    for (const [, v] of ap) state.appointments.push(v);
    const apd = await this.state.storage.list({ prefix: 'apptdeletion:' });
    for (const [, v] of apd) state.apptDeletions.push(v);
```

*(Note: the `appt:` prefix does not match `apptdeletion:` — position 5 is `:` vs `d` — so the two lists never overlap, exactly like `customer:` vs `custdeletion:`.)*

- [ ] **Step 4: Restore appointments on backup restore**

In `cloudflare/worker.js`, in `restoreFromBackup`, add this line immediately after the `st.giftcards` restore line (currently ~line 1885):

```js
      for (const a of (st.appointments || [])) await this.state.storage.put('appt:' + String(a.id), a);
```

- [ ] **Step 5: Verify the Worker parses and tests still pass**

Run: `npm run check`
Expected: no output, exit 0 (`node --check cloudflare/worker.js` — the file parses).

Run: `npm test`
Expected: PASS — no regression (Task 1's tests still green; `sync.js` change is import-time-safe under `setup-globals.js`).

- [ ] **Step 6: Commit**

```bash
git add js/app/sync.js cloudflare/worker.js
git commit -m "feat(sync): appt.* dispatch stamping + DO persistence, snapshot, restore"
```

---

## Task 3: Calendar read side — staff columns + native accessors + day/week render

This task makes the calendar **display** app-native appointments with Google disconnected. Write path (create/edit/delete/check-in) is Task 4. After this task, seeding appointments into local state renders them correctly; nothing is created/edited yet.

**Files:**
- Modify: `js/app/features/calendar.js` (imports ~2; module state ~59-60; `calColumnOff` ~108-118; `calIsHidden` ~123-127; `getCalEvents` ~153; new source helpers; `todayApptSource` ~177-182; `apptsForReminders` ~186-212; `apptsForTurns` ~224-258; `unassignedCalId` ~264-269; `calDisplayName` ~273-278; `renderTodaysAppointments` ~305-363; `calLoadAndRender` ~521-548; `calRenderGrid` field reads ~597-702; `calRenderWeekGrid` field reads ~754-838; `saveCalOrder` ~958; `calSelectorSave` ~990; store subscription)

**Interfaces:**
- Consumes: `getState().appointments` (Task 1); `subscribe` from `store.js`; `config.staff`, `config.inactive_staff`, `config.schedule`.
- Produces (names/signatures unchanged so consumers in turns.js/appt-reminders.js/search.js/main.js need no edits): `apptsForTurns()`, `apptsForReminders()`, `findTodayApptFor(phone,name)`, `getCalEvents(colId)` (via `window.calEventsFor`). New internal helpers: `buildStaffColumns()`, `calApptsByColumn(fromDate, toDate)`, `linesForColumn(appt, colId)`, `newApptId()`.

- [ ] **Step 1: Import `subscribe` and add the staff-color palette**

In `js/app/features/calendar.js`, change the store import (line 2):

```js
import { getState, subscribe } from '../store.js';
```

Add a palette constant just after the `const cfg = …/queue = …/records = …` block (after line 18):

```js
// config.staff has no color field — assign a stable per-staff column color by roster index
// so "color coding by staff" is preserved (mirrors queue.js CATEGORY_PALETTE).
const STAFF_PALETTE = ['#1a5252','#7b1fa2','#0277bd','#00695c','#e65100','#5c3d8f','#2a7a4f','#7a2a1a','#785a1a','#7a1a5c','#1a5c7a','#455a64'];
```

- [ ] **Step 2: Re-key the column show/hide/order localStorage**

In `js/app/features/calendar.js`, replace the two `_calHidden`/`_calOrder` init lines (currently 59-60):

```js
let _calHidden = new Set(JSON.parse(localStorage.getItem('turndesk_cal_staff_hidden') || '[]'));
let _calOrder = JSON.parse(localStorage.getItem('turndesk_cal_staff_order') || 'null');
```

Replace `saveCalOrder` (currently line 958):

```js
function saveCalOrder() { _calOrder = _calCalendars.map(c => c.id); localStorage.setItem('turndesk_cal_staff_order', JSON.stringify(_calOrder)); }
```

In `calSelectorSave`, replace the persist line (currently line 990):

```js
  localStorage.setItem('turndesk_cal_staff_hidden', JSON.stringify([..._calHidden]));
```

- [ ] **Step 3: Build columns from staff; simplify unassigned + off-duty**

In `js/app/features/calendar.js`, add `buildStaffColumns` next to the other column helpers (place it just above `calColumnOff`, ~line 107):

```js
// The calendar's columns are the salon's active staff + a trailing "Unassigned" column.
// Column id === staffId (a real config.staff[].id); the Unassigned column id === ''.
// Colors come from STAFF_PALETTE by roster index so each tech keeps a stable color.
function buildStaffColumns() {
  const inactive = new Set(cfg().inactive_staff || []);
  const cols = (cfg().staff || [])
    .filter(s => s && s.id && !inactive.has(s.id))
    .map((s, i) => ({ id: s.id, name: s.name || 'Staff', color: STAFF_PALETTE[i % STAFF_PALETTE.length] }));
  cols.push({ id: '', name: 'Unassigned', color: '#9ca3af' });
  return cols;
}
```

Replace `calColumnOff` (currently 108-118) — the column is now a staff row, so match by id, not name:

```js
// A column's staff is off on the viewed date? Reads the in-app schedule only (off/sick/
// vacation for _calDate). The Unassigned column (id '') and any unknown id are never "off".
function calColumnOff(cal) {
  if (!cal || !cal.id) return false;
  const st = (cfg().staff || []).find(s => s.id === cal.id);
  if (!st) return false;
  const dstr = localDateStr(_calDate), sc = cfg().schedule || {};
  const explicit = sc[dstr]?.[st.id];
  const status = explicit === '__none__' ? null
    : (explicit || sc._repeats?.[st.id]?.[new Date(dstr + 'T12:00:00').getDay()] || null);
  return status === 'off' || status === 'sick' || status === 'vacation';
}
```

Replace `unassignedCalId` (currently 264-269) and `calDisplayName` (currently 273-278):

```js
// The Unassigned column id is the empty string (a line with staffId null/'' → no tech yet).
export function unassignedCalId() { return ''; }
function calDisplayName(idOrCal) {
  const id = (idOrCal && typeof idOrCal === 'object') ? idOrCal.id : idOrCal;
  if (id === '' || id == null) return 'Unassigned';
  if (idOrCal && typeof idOrCal === 'object' && idOrCal.name) return idOrCal.name;
  return _calCalendars.find(c => c.id === id)?.name || 'Unassigned';
}
```

*(`calIsHidden` at 123-127 needs no change — it already keys on `cal.id` + `calColumnOff`, which now work on staffId. `_calPrimaryId` becomes irrelevant but leave it — it's read only by dormant Google code.)*

- [ ] **Step 4: Add the native appointment source helpers**

In `js/app/features/calendar.js`, add these helpers just above `getCalEvents` (~line 152). They replace the Google `_calEvents`/`museGroupId` grouping with a direct native expansion — one appt row appears under each staff column its guest lines touch, and under `''` (Unassigned) for any line with no staff or an unknown staff:

```js
// Every appointment whose start day falls within [fromDate..toDate], indexed by the staff
// column(s) it touches. The SAME appt object appears under multiple column ids when its
// guests span techs. Defensive: a line with an unknown/deleted staffId falls to Unassigned.
function calApptsByColumn(fromDate, toDate) {
  const from = new Date(fromDate); from.setHours(0, 0, 0, 0);
  const to = new Date(toDate || fromDate); to.setHours(23, 59, 59, 999);
  const known = new Set(_calCalendars.map(c => c.id));   // valid column ids (incl. '')
  const map = {}; _calCalendars.forEach(c => { map[c.id] = []; });
  (getState().appointments || []).forEach(a => {
    if (!a || !a.start) return;
    const s = new Date(a.start);
    if (isNaN(s) || s < from || s > to) return;
    const cols = new Set();
    (a.guests || []).forEach(g => (g.lines || []).forEach(l => {
      const sid = (l && l.staffId) || '';
      cols.add(known.has(sid) ? sid : '');   // unknown staff → Unassigned
    }));
    if (!cols.size) cols.add('');            // a bare appt with no service lines → Unassigned
    cols.forEach(sid => { if (map[sid]) map[sid].push(a); });
  });
  return map;
}
// The (guestName, serviceId, label) rows belonging to ONE column for a booking bubble.
// Tech column: lines whose staffId === colId. Unassigned column: lines with no/unknown staff.
function linesForColumn(appt, colId) {
  const known = new Set(_calCalendars.map(c => c.id));
  const rows = [];
  (appt.guests || []).forEach(g => {
    const fn = ((g.name || '').split(' ')[0] || g.name || '').trim();
    (g.lines || []).forEach(l => {
      const sid = (l && l.staffId) || '';
      const inCol = colId === '' ? !known.has(sid) || sid === '' : sid === colId;
      if (!inCol) return;
      const label = cfg().services.find(x => x.id === l.serviceId)?.label || l.serviceId || '';
      rows.push({ fn, svcId: l.serviceId || '', label });
    });
  });
  return rows;
}
// Appt-scoped id (client mint). Deterministic ids (appt-<n>) are used only by the seeder.
function newApptId() { return 'appt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7); }
// The queue entry (if any) that checked THIS appointment in.
function _queueForAppt(apptId) { return apptId ? queue().find(x => String(x.appointmentId) === String(apptId)) || null : null; }
```

- [ ] **Step 5: Re-point the "today source" + Turns/reminder accessors**

In `js/app/features/calendar.js`, replace `todayApptSource` (currently 177-182) — no Google fetch, just today's native appts by column:

```js
function todayApptSource() { const t = new Date(); return calApptsByColumn(t, t); }
```

Replace `apptsForReminders` (currently 186-212) — read native appts, one entry per booking:

```js
export function apptsForReminders() {
  const t = new Date(); const dstr = localDateStr(t);
  const out = [];
  (getState().appointments || []).forEach(a => {
    if (!a || !a.start || a.noShow) return;
    const start = new Date(a.start);
    if (isNaN(start) || localDateStr(start) !== dstr) return;
    if (_queueForAppt(a.id)) return;   // already checked in
    const g0 = (a.guests || [])[0] || {};
    const lines = (a.guests || []).flatMap(g => g.lines || []);
    const svc = [...new Set(lines.map(l => cfg().services.find(s => s.id === l.serviceId)?.label).filter(Boolean))].join(', ');
    const techName = [...new Set(lines.map(l => (cfg().staff || []).find(s => s.id === l.staffId)?.name).filter(Boolean))].join(', ');
    out.push({ id: a.id, name: g0.name || 'Guest', startMs: start.getTime(), svc, techName });
  });
  return out;
}
```

Replace `apptsForTurns` (currently 224-258) — one entry per (booking × assigned tech), same output shape (consumers unchanged), sourced natively:

```js
export function apptsForTurns() {
  const now = Date.now(), dstr = localDateStr(new Date());
  const out = [];
  (getState().appointments || []).forEach(a => {
    if (!a || !a.start || a.noShow) return;
    const start = new Date(a.start);
    if (isNaN(start) || localDateStr(start) !== dstr) return;
    const startMs = start.getTime();
    const late = startMs < now, minsLate = late ? Math.round((now - startMs) / 60000) : 0;
    if (minsLate > STALE_APPT_DROP_MIN) return;      // very late & never checked in → drop (computed live)
    if (_queueForAppt(a.id)) return;                 // already checked in
    const g0 = (a.guests || [])[0] || {};
    const name = g0.name || 'Guest';
    const lines = (a.guests || []).flatMap(g => g.lines || []);
    const svc = [...new Set(lines.map(l => cfg().services.find(s => s.id === l.serviceId)?.label).filter(Boolean))].join(', ') || 'Appointment';
    const techs = new Map();   // staffId -> name, distinct assigned techs
    lines.forEach(l => { const st = (cfg().staff || []).find(s => s.id === l.staffId); if (st) techs.set(st.id, st.name); });
    const notes = a.notes || '';
    if (techs.size === 0) out.push({ startMs, late, minsLate, name, svc, techStaffId: '', techName: 'Unassigned', apptId: a.id, notes });
    else techs.forEach((tn, id) => out.push({ startMs, late, minsLate, name, svc, techStaffId: id, techName: tn, apptId: a.id, notes }));
  });
  out.sort((x, y) => x.startMs - y.startMs);
  return out;
}
```

*(Note: `apptsForTurns` output previously carried `calId`/`eventId`; it now carries `apptId`. Verify no consumer reads `.calId`/`.eventId` off a turns row — `turns.js` uses `renderTurnsApptStrip` which renders name/svc/tech/time and calls `calQuickCheckin`. In Task 4, `renderTurnsApptStrip`'s check-in call becomes `calQuickCheckin(row.apptId)`. If `turns.js` references `.calId`/`.eventId`, update it there — see Task 4 Step 7.)*

- [ ] **Step 6: Re-point `findTodayApptFor` (used by the check-in guard + search)**

In `js/app/features/calendar.js`, replace `findTodayApptFor` (currently 1366-1389). It returns `{ apptId, name, startMs, summary }` (was `{ calId, eventId, … }`):

```js
export function findTodayApptFor(phone, name) {
  const p = String(phone || '').replace(/\D/g, '');
  const nm = String(name || '').trim().toLowerCase();
  if (!p && !nm) return null;
  const dstr = localDateStr(new Date());
  let hit = null;
  (getState().appointments || []).forEach(a => {
    if (hit || !a || !a.start || a.noShow) return;
    const start = new Date(a.start);
    if (isNaN(start) || localDateStr(start) !== dstr) return;
    const match = (a.guests || []).some(g => {
      const gPhone = String(g.phone || '').replace(/\D/g, '');
      const gName = (g.name || '').trim().toLowerCase();
      return (p && gPhone && gPhone === p) || (nm && gName && gName === nm);
    });
    if (!match) return;
    if (_queueForAppt(a.id)) return;   // already checked in
    const lines = (a.guests || []).flatMap(g => g.lines || []).map(l => {
      const svc = cfg().services.find(s => s.id === l.serviceId)?.label || '';
      if (!svc) return '';
      const tech = (cfg().staff || []).find(s => s.id === l.staffId)?.name || '';
      return svc + (tech ? ` with ${tech}` : '');
    }).filter(Boolean);
    const g0 = (a.guests || [])[0] || {};
    hit = { apptId: a.id, name: g0.name || name, startMs: start.getTime(), summary: lines.join(', ') };
  });
  return hit;
}
```

- [ ] **Step 7: Re-point `renderTodaysAppointments` (right-rail panel)**

In `js/app/features/calendar.js`, replace the body of `renderTodaysAppointments` (currently 305-363) with a native version — one row per booking for the VIEWED day, preserving the confirmed/status/upcoming-filter behavior:

```js
export function renderTodaysAppointments() {
  const listEl = document.getElementById('cal-appts-list'); if (!listEl) return;
  const titleEl = document.getElementById('cal-appts-title'), countEl = document.getElementById('cal-appts-count');
  const isToday = new Date().toDateString() === _calDate.toDateString();
  if (titleEl) titleEl.textContent = isToday ? "Today's Appointments" : _calDate.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
  const dstr = localDateStr(_calDate);
  const rows = [];
  (getState().appointments || []).forEach(a => {
    if (!a || !a.start) return;
    const startDt = new Date(a.start);
    if (isNaN(startDt) || localDateStr(startDt) !== dstr) return;
    const g0 = (a.guests || [])[0] || {};
    const qm = _queueForAppt(a.id);
    rows.push({ startMin: startDt.getHours()*60 + startDt.getMinutes(), startDt, appt: a, name: g0.name || 'Guest', confirmed: !!a.confirmed, noShow: !!a.noShow, qm });
  });
  rows.sort((a,b) => a.startMin - b.startMin);
  const _now = new Date();
  const shown = _apptsUpcomingOnly
    ? rows.filter(r => r.startDt >= _now && !r.noShow && !['complete','paid','done'].includes(r.qm?.status))
    : rows;
  const fbtn = document.getElementById('cal-appts-filter-btn');
  if (fbtn) {
    fbtn.classList.toggle('text-primary', _apptsUpcomingOnly);
    fbtn.classList.toggle('bg-primary/10', _apptsUpcomingOnly);
    fbtn.classList.toggle('text-on-surface-variant', !_apptsUpcomingOnly);
    fbtn.title = _apptsUpcomingOnly ? 'Showing upcoming only — tap to show all' : 'Show upcoming only';
  }
  if (countEl) countEl.textContent = shown.length ? String(shown.length) : '';
  if (!shown.length) { listEl.innerHTML = `<div class="text-xs text-on-surface-variant text-center py-6 opacity-60">${_apptsUpcomingOnly ? 'No upcoming appointments' : 'No appointments'}</div>`; return; }
  const _e = s => (s||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'");
  const escHtml = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  listEl.innerHTML = shown.map(r => {
    const timeStr = r.startDt.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
    const qs = r.qm?.status;
    const stat = r.noShow ? ['#dc2626','No Show'] : qs==='inservice' ? ['#16a34a','In Service'] : qs==='complete' ? ['#0284c7','Complete'] : (qs==='paid'||qs==='done') ? ['#9ca3af','Paid'] : qs==='waiting' ? ['#2563eb','Checked In'] : r.confirmed ? ['#16a34a','Confirmed'] : (isToday && r.startDt < new Date() ? ['#ea580c','Not in'] : ['#9ca3af', isToday ? 'Unconfirmed' : '']);
    const svcLines = [];
    (r.appt.guests || []).forEach(g => { const fn = ((g.name||'').split(' ')[0]||g.name||'').trim(); (g.lines||[]).forEach(l => { const s = cfg().services.find(x=>x.id===l.serviceId); const tech = (cfg().staff||[]).find(x=>x.id===l.staffId)?.name || 'Unassigned'; svcLines.push(`${escHtml(s?.label||l.serviceId||'service')} · ${escHtml(fn)}${tech?` · <span style="opacity:0.8">${escHtml(tech)}</span>`:''}`); }); });
    const svcHtml = svcLines.slice(0,8).map(t => `<div style="font-size:10px;color:var(--on-surface-variant, #41484d);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${t}</div>`).join('');
    return `<div onclick="calEventClick(event,'${_e(r.appt.id)}')" class="rounded-lg border border-surface-container-high hover:bg-surface-container cursor-pointer px-2.5 py-2 transition-colors" style="background:var(--surface-container-lowest, #f5f7f8)">
      <div class="flex items-center gap-1.5" style="line-height:1.2">
        <span style="font-size:11px;font-weight:700;color:#1a5252;flex-shrink:0">${timeStr}</span>
        ${r.confirmed?'<span title="Confirmed" style="color:#16a34a;font-weight:800;font-size:11px;flex-shrink:0">✓</span>':''}
        <span style="font-size:12px;font-weight:700;color:var(--on-surface, #0e1a1a);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0">${escHtml(r.name)}</span>
        ${stat[1]?`<span style="font-size:9px;font-weight:700;color:${stat[0]};flex-shrink:0">${stat[1]}</span>`:''}
      </div>
      ${svcHtml}
    </div>`;
  }).join('');
}
```

*(`calEventClick` becomes a single-`apptId` handler in Task 4 — the `onclick="calEventClick(event,'<apptId>')"` above matches that new signature.)*

- [ ] **Step 8: Make `calLoadAndRender` synchronous (DO, not Google)**

In `js/app/features/calendar.js`, replace `calLoadAndRender` (currently 521-548). It now builds staff columns + the native per-column source, then renders — no gapi, no async fetch:

```js
export function calLoadAndRender(silent) {
  try {
    _calCalendars = buildStaffColumns();
    if (_calCalendars.length <= 1) { applyCalOrder(); }   // only the Unassigned column exists yet
    applyCalOrder();
    // Day view = the viewed day; week view = Sun–Sat of the viewed week. Same _calEvents shape
    // ({ [colId]: [appt,...] }) the grid engine already consumes.
    const from = calIsWeek() ? calWeekStart(_calDate) : _calDate;
    const to = calIsWeek() ? (() => { const e = calWeekStart(_calDate); e.setDate(e.getDate() + 6); return e; })() : _calDate;
    const gbBefore = document.getElementById('cal-scroll'); const savedScroll = gbBefore ? gbBefore.scrollTop : null;
    _calEvents = calApptsByColumn(from, to);
    calRenderGrid();
    if (savedScroll !== null) requestAnimationFrame(() => { const gb = document.getElementById('cal-scroll'); if (gb) gb.scrollTop = savedScroll; });
    renderCalSelectorList(); calUpdateDateInput(); renderTodaysAppointments();
  } catch (err) {
    console.warn('[calendar] render failed:', err);
    calSetStatus('Error rendering calendar: ' + (err?.message || 'Unknown error'));
  }
}
```

*(Removed: the Google `calendarList.list`, `events.list`, the `renderGcalCalendarList()` call (a Google-settings helper — dormant in Part 1), and the 401 reconnect branch. `calLoadAndRender` is still `async` in signature is fine — callers `await` it; keep the `export async function` keyword to avoid touching call sites, or drop `async` and the `await`s still resolve. Keep `async` for minimal blast radius.)*

Keep the `export async function calLoadAndRender(silent) {` declaration line (don't remove `async`).

**Also re-point the boot entry** (critical — `main.js:446` calls `calendar.initCalendar()` when the Calendar panel opens; today `initCalendar` calls `loadGCalScripts()`, which with Google dormant would fail and leave the calendar stuck on "Connect Google" instead of rendering). Replace `initCalendar` (currently line 443):

```js
export function initCalendar() { _calDate = new Date(); calUpdateDateLabel(); calLoadAndRender(); }
```

- [ ] **Step 9: Subscribe to the store so remote appt changes re-render**

In `js/app/features/calendar.js`, add a store subscription. Place it near the bottom module scope (e.g. just after `initCalendar` at ~line 443, or at end of file). It re-renders the grid + rails whenever appointments change AND the calendar panel is visible:

```js
// Re-render the calendar when appointments change on ANY device (the DO broadcast lands via
// sync.js → applyChange → notify). Only touch the DOM when the Calendar panel is showing;
// the Turns strip re-renders itself off apptsForTurns.
subscribe((state, op) => {
  if (op !== 'appt.upsert' && op !== 'appt.delete' && op !== 'hydrate') return;
  if (document.getElementById('panel-calendar')?.classList.contains('active')) {
    try { _calEvents = calApptsByColumn(calIsWeek() ? calWeekStart(_calDate) : _calDate, calIsWeek() ? (() => { const e = calWeekStart(_calDate); e.setDate(e.getDate()+6); return e; })() : _calDate); calRenderGridPreserveScroll(); renderTodaysAppointments(); } catch {}
  }
  if (document.getElementById('panel-turns')?.classList.contains('active')) { try { window.renderTurnsApptStrip?.(); } catch {} }
});
```

- [ ] **Step 10: Re-point the day-grid field reads (`calRenderGrid`)**

The grid's layout math (slots, lanes, clustering, now-line, zoom, past-day resolution) is unchanged. Only the per-column data-shaping changes: one appt = one booking (no `museGroupId`), and field reads come off the native appt. Apply these targeted edits inside `calRenderGrid`:

**(a)** Replace the `groupCals` block (currently 597-599) — native appts carry no cross-calendar link, so drop the "same appointment on another calendar" indicator source:

```js
  const groupCals = {};   // (native) no cross-calendar copies — link indicator is disabled
  const calName = cid => calDisplayName(cid);
```

**(b)** Replace the per-column `events` + `bookings` grouping (currently 601, 610-611). Each appt is exactly one booking, keyed by its id:

```js
    const events = _calEvents[cal.id] || [], isLast = colIdx === visible.length-1, isFirst = colIdx === 0;
```
and
```js
    const bookings = new Map();
    events.forEach(a => { if (!a.start) return; bookings.set(a.id, [a]); });   // one appt = one booking
```

**(c)** Replace the booking start/end derivation (currently 619-620) so it reads ISO `start`/`end` off the appt:

```js
      const first = evs[0];
      const startDt = new Date(first.start), endDt = new Date(first.end || (startDt.getTime()+3600000));
```

**(d)** Replace the bubble field reads (currently 634-645) with native reads:

```js
      const gid = '';                       // native: no group link
      const linkedCals = [];
      const linked = false;
      const innerW = Math.min(COL_W - 8, maxBubbleW), gap = laneCount > 1 ? 3 : 0;
      const laneW = (innerW - gap*(laneCount-1)) / laneCount;
      const bLeft = 4 + lane*(laneW + gap);
      const g0 = (first.guests || [])[0] || {};
      const primaryName = g0.name || 'Guest';
      const primaryPhone = g0.phone || '';
      const notes = first.notes || '', confirmed = !!first.confirmed, isPast = startDt < now;
      const noShow = !!first.noShow;
```

**(e)** Replace the appointment-ness + queue-match block (currently 650-655) — a native appt is always an appointment; match the queue by `appointmentId` then phone:

```js
      let isAppt = true, qm = _queueForAppt(first.id);
      if (!qm) qm = _phoneQueueMatch((primaryPhone || '').replace(/\D/g,''), startDt.getTime());
```

**(f)** Replace the `svcRows` builder (currently 657-669) with the native per-column lines:

```js
      const svcRows = linesForColumn(first, cal.id);
```

**(g)** Replace the past-day record match (currently 682-687) — match by `appointmentId`:

```js
      if (isPastDay && isAppt && !noShow) {
        const rawP = (primaryPhone || '').replace(/\D/g, '');
        const rec = _pastRecordMatch([first.id], rawP, startDt.getTime());
        if (rec) { bg='#e0f2fe'; border='#0284c7'; tc='#0c4a6e'; pastStatus='Completed'; }
        else if (rawP) { bg='#fee2e2'; border='#dc2626'; tc='#991b1b'; pastStatus='No Show'; }
      }
```

**(h)** Replace the bubble's onclick (currently the `body += ` line at 696) — single `apptId` handler:

```js
      body += `<div onclick="calEventClick(event,'${_e(first.id)}')" style="position:absolute;left:${bLeft}px;width:${laneW}px;top:${top}px;height:${Math.max(ht,26)}px;background:${bg};border-left:3px solid ${border};border-radius:6px;padding:3px 6px;cursor:pointer;overflow:hidden;z-index:1;box-shadow:0 1px 3px rgba(0,0,0,0.12)">`
```

**(i)** Fix the "Unassigned only" filter for the empty-string column id. The Unassigned column id is now `''` (falsy), so the current guard `_unassignedOnly && uCal && …` (line ~558) short-circuits to falsy and the toggle silently shows all columns. Replace the `visible` computation (currently 558-560) — drop the `&& uCal` truthiness term (the `.some(...)` already validates the column exists):

```js
  const visible = (_unassignedOnly && _calCalendars.some(c => c.id === uCal))
    ? _calCalendars.filter(c => c.id === uCal)
    : _calCalendars.filter(c => !calIsHidden(c));
```

*(`_pastRecordMatch` signature stays `(eventIds, rawPhone, apptStartMs)`; it now receives `[apptId]` and matches `record.appointmentId` — updated in Task 4 Step 6. `_phoneQueueMatch` is unchanged.)*

- [ ] **Step 11: Re-point the week-grid field reads (`calRenderWeekGrid`)**

Apply these targeted edits inside `calRenderWeekGrid` (layout unchanged):

**(a)** Replace the dedup/bucket source (currently 757-765) — dedup by appt id; owning column = first real staff the appt touches (for color), else Unassigned:

```js
  const seen = new Map();   // apptId -> { evs:[appt], calId (owning col for color) }
  visible.forEach(cal => (_calEvents[cal.id] || []).forEach(a => {
    if (!a.start) return;
    let b = seen.get(a.id);
    if (!b) { b = { evs: [a], calId: cal.id }; seen.set(a.id, b); }
    if (b.calId === '' && cal.id !== '') b.calId = cal.id;   // prefer a real staff column for color
  }));
```

**(b)** Replace the `seen.forEach(({ evs, calId, ownEv }) => {` destructure + start/end (currently 768-771):

```js
  seen.forEach(({ evs, calId }) => {
    const first = evs[0];
    const startDt = new Date(first.start);
    const endDt = new Date(first.end || (startDt.getTime() + 3600000));
```
and update the `byDay[di].push({ … })` (currently 777) to drop `ownEv`:
```js
    byDay[di].push({ evs, calId, first, startDt, startMin: sMin, endMin: sMin + durMin, top: (topMin / SLOT_MINS) * SLOT_H, ht: (durMin / SLOT_MINS) * SLOT_H });
```

**(c)** Replace the block-render destructure + field reads (currently 807-822):

```js
    layout.forEach(({ evs, calId, first, startDt, top, ht, lane = 0, laneCount = 1 }) => {
      try {
      const cal = _calCalendars.find(x => x.id === calId);
      const color = (calId === '' || !cal) ? '#9ca3af' : cal.color;
      const timeStr = startDt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const g0 = (first.guests || [])[0] || {};
      const primaryName = g0.name || 'Guest';
      const notes = first.notes || '';
      const confirmed = !!first.confirmed;
      const noShow = !!first.noShow;
      const guests = Math.max(0, (first.guests || []).length - 1);
      let isAppt = true;
```

**(d)** Replace the past-day match (currently 828-833):

```js
      if (isPastDay && isAppt && !noShow) {
        const rawP = ((first.guests || [])[0]?.phone || '').replace(/\D/g, '');
        const rec = _pastRecordMatch([first.id], rawP, startDt.getTime());
        if (rec) { bg='#e0f2fe'; border='#0284c7'; tc='#0c4a6e'; }
        else if (rawP) { bg='#fee2e2'; border='#dc2626'; tc='#991b1b'; }
      }
```

**(e)** Replace the block onclick (currently 835) — single `apptId`:

```js
      body += `<div onclick="event.stopPropagation();calEventClick(event,'${_e(first.id)}')" style="position:absolute;left:${bLeft}px;width:${laneW}px;top:${top}px;height:${Math.max(ht,24)}px;background:${bg};border-left:3px solid ${border};border-radius:6px;padding:2px 5px;cursor:pointer;overflow:hidden;z-index:1;box-shadow:0 1px 3px rgba(0,0,0,0.12)">`
```

**(f)** Fix the "Unassigned only" filter (same empty-string-id issue as the day grid). Replace the week `visible` computation (currently 730-732):

```js
  const visible = (_unassignedOnly && _calCalendars.some(c => c.id === uCal))
    ? _calCalendars.filter(c => c.id === uCal)
    : _calCalendars.filter(c => !_calHidden.has(c.id));
```

*(The week `uCal` var (line 729) equals `''` via `unassignedCalId()`, so the `calId === uCal` color checks keep working once the `visible` guard above no longer relies on `uCal` being truthy.)*

- [ ] **Step 12: Verify the read side in the preview**

Start the TurnDesk static server pointed at `wrangler dev` (or the deployed Worker) and open the demo salon with the Calendar tab active. Inject one appointment directly through the store module and re-render (a disconnected preview's `dispatch` stays local, so use `applyChange` for an isolated render check):

Run via `preview_eval`:
```js
import('/js/app/store.js').then(m => {
  const n = new Date(), st = m.getState().config;
  const iso = (h) => new Date(n.getFullYear(), n.getMonth(), n.getDate(), h, 0).toISOString();
  m.applyChange('appt.upsert', { appt: {
    id: 'appt_test1', start: iso(13), end: iso(14),
    guests: [{ name: 'Test Guest', phone: '(909) 555-0001', lines: [{ serviceId: (st.services[0]||{}).id, staffId: (st.staff[0]||{}).id }] }],
    notes: 'hello', confirmed: false, noShow: false,
  }});
  window.calLoadAndRender && window.calLoadAndRender();
  return 'seeded appt_test1 for ' + (st.staff[0]||{}).name;
});
```

Confirm with `preview_snapshot` / `preview_screenshot`:
- The appt bubble appears in the first staff's column at 1 PM (day view), labelled "Test Guest", with its service line.
- Switch to Week view (`setCalView('week')`) — the block appears on today's column tinted by the staff color; the Staff legend lists the staff + Unassigned.
- The "Unassigned only" toggle isolates the Unassigned column (verifies the empty-id guard fix).
- The right-rail "Today's Appointments" lists the booking.
- In the console, `apptsForTurns()` returns one row with `techStaffId` = `st.staff[0].id`.

Fix any render errors (read `preview_console_logs`), then re-verify.

- [ ] **Step 13: Commit**

```bash
git add js/app/features/calendar.js
git commit -m "feat(calendar): render app-native appointments from the DO (staff columns, day+week, rails)"
```

---

## Task 4: Calendar write side — create/edit/cancel/confirm/no-show + check-in + guard

Makes the calendar **write** app-native appointments (one `dispatch('appt.upsert')` replaces the N-event Google fan-out) and check in from them. Depends on Tasks 1–3.

**Files:**
- Modify: `js/app/features/calendar.js` (`_buildTechOptions` ~1505-1512; modal line model `renderApptServiceLines`/`addApptServiceLine`/`updateApptLine` ~1542-1548; `apptGuest*` line model ~1459-1463; `_guestLinesHtml` ~1474; `showNewApptModal` ~1570-1588; `showConvertToApptModal`/`showEditApptModal` ~1589-1643; `saveAppt` ~1661-1750; `deleteAppt` ~1774-1794; `calToggleConfirmed` ~1170-1183; `calMarkNoShow` ~1189-1208; `_buildCheckinEntry` ~1260-1276; `_gatherParty`/`_doCalCheckin`/`calQuickCheckin` ~1280-1326; `_showQuickCheckinPicker`/`confirmQuickCheckin` ~1328-1365; `calEventClick` ~1029-1079; `calSlotClick` ~1028; `apptGuardUseAppt` ~1419-1433)
- Modify: `js/app/features/turns.js` (`renderTurnsApptStrip` — the `seen` map fields + card `onclick`)
- Modify: `js/app/features/search.js` (`gsGo` appt-jump — the `calEventClick` call)

**Interfaces:**
- Consumes: `dispatch('appt.upsert'|'appt.delete', …)` (Tasks 1-2); `newApptId`, `linesForColumn`, `_queueForAppt`, `buildStaffColumns` (Task 3).
- Produces: `saveAppt()`, `deleteAppt(apptId?)`, `calToggleConfirmed(apptId)`, `calMarkNoShow(apptId)`, `calQuickCheckin(apptId)`, `calEventClick(e, apptId)`, `calSlotClick(colId, hour, minute)`. Queue entries created via check-in carry `appointmentId`.
- **No change needed in `checkin.js`/`queue.js`:** the appt-vs-checkin guard callers (`checkin.js:227` `submitCheckin`, `queue.js:615` `submitManualAdd`) call `window.checkinApptGuard(guests, proceed)` with `[{name, phone}]` — `checkinApptGuard` keeps that exact signature (only its internals re-point to the DO), so those call sites are untouched. `_buildCheckinEntry` and `checkinApptGuard` themselves live in `calendar.js` (this task), not in queue/checkin.

- [ ] **Step 1: The per-line "tech" dropdown lists staff (not calendars)**

In `js/app/features/calendar.js`, replace `_buildTechOptions` (currently 1505-1512):

```js
function _buildTechOptions(sel) {
  const isU = !sel;   // '' / null → Unassigned (the default)
  return `<option value="" ${isU ? 'selected' : ''}>Unassigned</option>`
    + buildStaffColumns().filter(c => c.id !== '').map(c => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${c.name}</option>`).join('');
}
```

- [ ] **Step 2: Switch the modal line model from `calId` to `staffId`**

In `js/app/features/calendar.js`, the primary-guest lines (`_apptLines`) and extra-guest lines each currently use `{ svcId, calId }`. Change them to `{ svcId, staffId }`.

Replace `renderApptServiceLines` (currently 1542-1545) — the second `<select>` writes `staff`:

```js
export function renderApptServiceLines() {
  const container = document.getElementById('appt-service-lines'); if (!container) return;
  container.innerHTML = _apptLines.map((line,i) => `<div class="flex items-center gap-2" data-line="${i}"><select onchange="updateApptLine(${i},'svc',this.value)" class="flex-1 border-2 border-surface-container-high bg-transparent rounded-xl px-3 py-2 text-sm font-body focus:border-primary outline-none">${_buildSvcOptions(line.svcId)}</select><select onchange="updateApptLine(${i},'staff',this.value)" class="flex-1 border-2 border-surface-container-high bg-transparent rounded-xl px-3 py-2 text-sm font-body focus:border-primary outline-none">${_buildTechOptions(line.staffId)}</select><button type="button" onclick="removeApptLine(${i})" class="w-8 h-8 rounded-xl text-outline hover:text-error hover:bg-error/10 flex items-center justify-center transition-colors flex-shrink-0"><span class="material-symbols-outlined" style="font-size:18px">remove</span></button></div>`).join('');
}
export function addApptServiceLine(svcId, staffId) { _apptLines.push({ svcId: svcId || '', staffId: staffId || '' }); renderApptServiceLines(); }
export function removeApptLine(i) { _apptLines.splice(i,1); if (_apptLines.length === 0) addApptServiceLine(); else renderApptServiceLines(); }
export function updateApptLine(i, field, val) { if (field === 'svc') _apptLines[i].svcId = val; else _apptLines[i].staffId = val; }
```

Replace the extra-guest line helpers (currently 1459-1463):

```js
export function apptAddGuest() { _syncApptGuestsFromDom(); _apptExtraGuests.push({ first:'', last:'', phone:'', lines:[{ svcId:'', staffId:'' }] }); renderApptExtraGuests(); }
export function apptRemoveGuest(idx) { _syncApptGuestsFromDom(); _apptExtraGuests.splice(idx,1); renderApptExtraGuests(); }
export function apptGuestAddLine(gi) { _syncApptGuestsFromDom(); if (!_apptExtraGuests[gi]) return; (_apptExtraGuests[gi].lines = _apptExtraGuests[gi].lines || []).push({ svcId:'', staffId:'' }); renderApptExtraGuests(); }
export function apptGuestRemoveLine(gi, li) { _syncApptGuestsFromDom(); _apptExtraGuests[gi]?.lines?.splice(li,1); renderApptExtraGuests(); }
export function apptGuestUpdateLine(gi, li, field, val) { const l = _apptExtraGuests[gi]?.lines?.[li]; if (!l) return; if (field === 'svc') l.svcId = val; else l.staffId = val; }
```

In `_guestLinesHtml` (currently 1474-1483) the extra-guest line's second `<select>` calls `apptGuestUpdateLine(gi,li,'cal',…)` and `_buildTechOptions(l.calId)`. Change both to `staff`/`l.staffId`:

Read `_guestLinesHtml` and replace the two occurrences: `apptGuestUpdateLine(${gi},${li},'cal',this.value)` → `apptGuestUpdateLine(${gi},${li},'staff',this.value)` and `_buildTechOptions(l.calId)` → `_buildTechOptions(l.staffId)`.

In `_syncApptGuestsFromDom` (currently 1467-1473), the DOM read maps the second select into `.calId`. Read it and change the assignment `lines[k].calId = sels[1]?.value` → `lines[k].staffId = sels[1]?.value` (keep the `.svcId` line as-is).

- [ ] **Step 3: `showNewApptModal` — default the line to the clicked staff column**

In `js/app/features/calendar.js`, replace the tail of `showNewApptModal` (the `matchedCal`/`startCal` block, currently 1580-1585) — `calId` is now the clicked column's staffId (`''` for Unassigned):

```js
  // Default the line to the clicked column's staff (calId is now a staffId; '' = Unassigned).
  const startStaff = (calId && buildStaffColumns().some(c => c.id === calId)) ? calId : '';
  addApptServiceLine('', startStaff);
```

Also in `showNewApptModal`, the hidden `appt-cal-id` field is still set from `calId` (line 1575) — that's fine (it now holds a staffId or ''); it's read only for the notify path which we simplify in Step 4.

- [ ] **Step 4: Rewrite `saveAppt` to build ONE appointment and dispatch it**

In `js/app/features/calendar.js`, replace `saveAppt` (currently 1661-1750) and drop the `_apptEventBody`/`_notifyApptTechs` Google helpers' use (leave `_apptEventBody` defined but unused, or delete it — deleting is cleaner; `_notifyApptTechs` is replaced by a native push below):

```js
export async function saveAppt() {
  if (_apptSaving) return;
  const first = document.getElementById('appt-first')?.value.trim() || '', last = document.getElementById('appt-last')?.value.trim() || '';
  const name = [first,last].filter(Boolean).join(' ') || document.getElementById('appt-name')?.value.trim() || '';
  const phone = document.getElementById('appt-phone').value.trim(), dateVal = document.getElementById('appt-date').value, timeVal = document.getElementById('appt-time').value;
  const durMins = parseInt(document.getElementById('appt-duration').value) || 60, notes = document.getElementById('appt-notes').value.trim();
  if (!name) { showToast('Enter a customer name'); return; }
  if (!dateVal) { showToast('Select a date'); return; }
  // Sync the primary lines from the DOM selects (svc + staff), then the extra guests.
  document.querySelectorAll('#appt-service-lines [data-line]').forEach((row,i) => { const sels = row.querySelectorAll('select'); if (_apptLines[i]) { _apptLines[i].svcId = sels[0]?.value || ''; _apptLines[i].staffId = sels[1]?.value || ''; } });
  _syncApptGuestsFromDom();
  const anyService = _apptLines.some(l => l.svcId) || _apptExtraGuests.some(g => (g.lines||[]).some(l => l.svcId));
  if (!anyService) { showToast('Add at least one service'); return; }
  const startDt = new Date(`${dateVal}T${timeVal || '09:00'}`), endDt = new Date(startDt.getTime() + durMins*60000);

  // Build the guests array: primary + each named extra guest, each with their own lines.
  const guests = [{ name, phone, lines: _apptLines.filter(l => l.svcId || l.staffId).map(l => ({ serviceId: l.svcId || '', staffId: l.staffId || '' })) }];
  _apptExtraGuests.forEach(g => {
    const gName = [g.first, g.last].filter(Boolean).join(' ').trim();
    if (!gName) return;
    guests.push({ name: gName, phone: (g.phone||'').trim(), lines: (g.lines||[]).filter(l => l.svcId || l.staffId).map(l => ({ serviceId: l.svcId || '', staffId: l.staffId || '' })) });
  });

  const existing = _apptEditId ? (getState().appointments || []).find(a => a.id === _apptEditId) : null;
  const appt = {
    id: _apptEditId || newApptId(),
    start: startDt.toISOString(), end: endDt.toISOString(),
    guests, notes,
    confirmed: existing ? !!existing.confirmed : false,
    noShow: existing ? !!existing.noShow : false,
    checkedInQueueId: existing ? (existing.checkedInQueueId || null) : null,
    createdAt: existing ? (existing.createdAt || Date.now()) : Date.now(),
  };
  const prevStaff = new Set(existing ? (existing.guests||[]).flatMap(g => (g.lines||[]).map(l => l.staffId).filter(Boolean)) : []);

  _apptSaving = true;
  const saveBtn = document.querySelector('#appt-modal button[onclick="saveAppt()"]'); if (saveBtn) saveBtn.disabled = true;
  try {
    dispatch('appt.upsert', { appt });
    guests.forEach(g => { if (g.phone) squareUpsertCustomer({ name: g.name, phone: g.phone }); });   // keep the directory current
    try { _notifyApptTechs(appt, prevStaff); } catch {}
    closeApptModal();
    showToast(guests.length > 1 ? `Appointment saved for ${guests.length} guests ✓` : 'Appointment saved ✓');
    // The store subscription re-renders when the optimistic apply notifies; force one for safety.
    if (document.getElementById('panel-calendar')?.classList.contains('active')) calLoadAndRender(true);
  } catch (err) { console.warn('[calendar] saveAppt failed:', err); showToast('Could not save the appointment'); }
  finally { _apptSaving = false; if (saveBtn) saveBtn.disabled = false; }
}
```

Replace `_notifyApptTechs` (currently 1755-1772) with the native version — push to each newly-assigned tech (staff the booking didn't already have):

```js
// Push each tech newly assigned by this save (best-effort, fire-and-forget). Newly-assigned =
// a staffId on the appt now that wasn't there before (prevStaff), skipping Unassigned.
function _notifyApptTechs(appt, prevStaff) {
  const nowStaff = new Set((appt.guests||[]).flatMap(g => (g.lines||[]).map(l => l.staffId).filter(Boolean)));
  const techIds = [...nowStaff].filter(id => id && !prevStaff.has(id));
  if (!techIds.length) return;
  const startDt = new Date(appt.start);
  const when = startDt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    + ', ' + startDt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const custName = (appt.guests||[])[0]?.name || 'Guest';
  fetch(PUSH_PROXY + '/notify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ techIds, title: 'New appointment 📅', body: `${custName} — ${when}`, tag: 'muse-appt' }),
  }).catch(() => {});
}
```

- [ ] **Step 5: Rewrite `showEditApptModal` (and retire `showConvertToApptModal`)**

In `js/app/features/calendar.js`, replace `showEditApptModal` (currently 1607-1643) to load a native appt:

```js
export function showEditApptModal(apptId) {
  const a = (getState().appointments || []).find(x => x.id === apptId); if (!a) return;
  _apptEditId = apptId; _apptExtraGuests = []; _apptEditGroupId = '';
  const startDt = new Date(a.start), endDt = new Date(a.end || startDt.getTime()+3600000);
  const durMins = Math.max(15, Math.round((endDt-startDt)/60000));
  document.getElementById('appt-modal-title').textContent = 'Edit Appointment';
  document.getElementById('appt-event-id').value = apptId; document.getElementById('appt-cal-id').value = '';
  const g0 = (a.guests || [])[0] || {};
  const parts = (g0.name || '').split(' ');
  document.getElementById('appt-first').value = parts[0] || ''; document.getElementById('appt-last').value = parts.slice(1).join(' ') || '';
  document.getElementById('appt-name').value = g0.name || '';
  document.getElementById('appt-notes').value = a.notes || '';
  document.getElementById('appt-phone').value = g0.phone || '';
  document.getElementById('appt-date').value = localDateStr(startDt);
  setApptTimeFields(startDt.getHours(), startDt.getMinutes());
  document.getElementById('appt-delete-btn').classList.remove('hidden');
  const durSel = document.getElementById('appt-duration'); durSel.value = [...durSel.options].reduce((x,y)=>Math.abs(parseInt(y.value)-durMins)<Math.abs(parseInt(x.value)-durMins)?y:x).value;
  _apptLines = (g0.lines || []).map(l => ({ svcId: l.serviceId || '', staffId: l.staffId || '' }));
  if (_apptLines.length === 0) _apptLines.push({ svcId:'', staffId:'' });
  _apptExtraGuests = (a.guests || []).slice(1).map(g => { const gp = (g.name||'').split(' '); return { first: gp[0]||'', last: gp.slice(1).join(' ')||'', phone: g.phone||'', lines: (g.lines||[]).map(l => ({ svcId: l.serviceId||'', staffId: l.staffId||'' })) }; });
  renderApptServiceLines(); renderApptExtraGuests();
  const m = document.getElementById('appt-modal'); m.classList.remove('hidden'); m.style.display = 'flex';
}
```

Replace `showConvertToApptModal` (currently 1589-1606) with a stub that forwards to the edit modal (Google-only "convert a plain event" has no meaning natively; keep the export so `window` glue + any caller don't break):

```js
export function showConvertToApptModal(apptId) { showEditApptModal(apptId); }   // native: no plain-event conversion
```

- [ ] **Step 6: `deleteAppt`, `calToggleConfirmed`, `calMarkNoShow` → dispatch**

In `js/app/features/calendar.js`, replace `deleteAppt` (currently 1774-1794):

```js
export async function deleteAppt(apptIdParam) {
  const apptId = apptIdParam || document.getElementById('appt-event-id')?.value;
  if (!apptId) return;
  if (!apptIdParam && !confirm('Cancel this appointment?')) return;
  try {
    dispatch('appt.delete', { id: apptId });
    if (!apptIdParam) closeApptModal();
    showToast('Appointment cancelled');
    if (document.getElementById('panel-calendar')?.classList.contains('active')) calLoadAndRender(true);
  } catch (err) { console.warn('[calendar] deleteAppt failed:', err); showToast('Could not cancel the appointment'); }
}
```

Replace `calToggleConfirmed` (currently 1170-1183):

```js
export async function calToggleConfirmed(apptId) {
  const a = (getState().appointments || []).find(x => x.id === apptId); if (!a) return;
  const appt = { ...a, confirmed: !a.confirmed };
  dispatch('appt.upsert', { appt });
  showToast(a.confirmed ? 'Marked unconfirmed' : 'Appointment confirmed ✓');
  if (document.getElementById('panel-calendar')?.classList.contains('active')) calLoadAndRender(true);
}
```

Replace `calMarkNoShow` (currently 1189-1208):

```js
export async function calMarkNoShow(apptId) {
  const a = (getState().appointments || []).find(x => x.id === apptId); if (!a) return;
  const wasNoShow = !!a.noShow;
  dispatch('appt.upsert', { appt: { ...a, noShow: !wasNoShow } });
  showToast(wasNoShow ? 'No-show cleared' : 'Marked No Show');
  if (document.getElementById('panel-calendar')?.classList.contains('active')) calLoadAndRender(true);
  if (wasNoShow) return;
  // Open the matched customer's account to notate the no-show (phone match, last 10 digits).
  const raw = ((a.guests||[])[0]?.phone || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
  const cust = raw ? customerDirectory.find(c => (c.phone || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1') === raw) : null;
  if (cust) showEditCustomer(cust.squareId);
}
```

In `js/app/features/reports.js`, add `appointmentId` to the `saveRecord` field whitelist. In `saveRecord`, add this line to the conditional-spread block (right after the `isAppointment` line at ~line 39, or among the `...(entry.x ? {x} : {})` spreads):

```js
    ...(entry.appointmentId ? { appointmentId: entry.appointmentId } : {}),
```

In `js/app/features/calendar.js`, update `_pastRecordMatch` (currently ~1109-1130) so it matches a record by `appointmentId`. Read the function; the current line 1111 is `const linked = recs.find(r => r.calEventId && eventIds.has(String(r.calEventId)));`. Replace with:

```js
  const linked = recs.find(r => r.appointmentId && eventIds.has(String(r.appointmentId)));
```

*(The `eventIds` arg is now `[apptId]`, passed by the grid edits in Task 3 Steps 10g/11d.)*

- [ ] **Step 7: Check-in from an appointment sets `appointmentId`**

In `js/app/features/calendar.js`, replace the check-in cluster (`_buildCheckinEntry` 1260-1276, `_gatherParty` 1280-1297, `_doCalCheckin` 1301-1318, `calQuickCheckin` 1319-1326). Natively, a party IS the appt's `guests`; each guest becomes one queue entry pre-filled from its lines:

```js
// One queue entry for one appointment guest (null if that guest is already checked in).
function _buildCheckinEntry(appt, guest, queueGroupId) {
  const title = guest.name || 'Guest';
  const already = queue().find(x => x.isAppointment && x.name === title && x.status !== 'paid' && x.status !== 'done' && String(x.appointmentId) === String(appt.id))
    || queue().find(x => x.isAppointment && x.name === title && x.status !== 'paid' && x.status !== 'done');
  if (already) return null;
  const rawP = (guest.phone || '').replace(/\D/g,'');
  const phone = rawP ? rawP.replace(/^1?(\d{3})(\d{3})(\d{4})$/,'($1) $2-$3') : '';
  const lines = (guest.lines || []).filter(l => l.serviceId);
  const svcs = lines.map(l => l.serviceId);
  const now = Date.now();
  const assignments = lines.map(l => ({ serviceId: l.serviceId, techId: l.staffId || '', station: '', status: 'waiting', cost: 0, assignedAt: now }));
  return { id: newEntryId(), name: title, phone, services: svcs.length ? svcs : (cfg().services.length ? [cfg().services[0].id] : []), status: 'waiting', checkinTime: new Date().toISOString(), isAppointment: true, isNew: true, skipSquare: false, groupId: queueGroupId, appointmentId: appt.id, assignments };
}
// The appt's guests, each tagged `already` if that person is already in today's queue.
function _gatherParty(apptId) {
  const a = (getState().appointments || []).find(x => x.id === apptId);
  if (!a) return [];
  return (a.guests || []).map(g => ({ appt: a, guest: g, name: g.name || 'Guest',
    already: !!queue().find(x => x.isAppointment && x.name === (g.name||'Guest') && x.status !== 'paid' && x.status !== 'done') }));
}
function _doCalCheckin(members, appt, partySize) {
  if (!members.length) { showToast('Already checked in'); return; }
  const queueGroupId = (partySize > 1 && appt) ? ('apptq_' + appt.id) : null;
  let added = 0, firstName = '';
  members.forEach(({ guest }) => {
    const entry = _buildCheckinEntry(appt, guest, queueGroupId);
    if (!entry) return;
    dispatch('queue.upsert', { entry }); squareUpsertCustomer(entry);
    added++; if (!firstName) firstName = entry.name;
  });
  if (added === 0) { showToast('Already checked in'); return; }
  const onTurns = document.getElementById('panel-turns')?.classList.contains('active');
  window.renderQueue?.(); window.updateStats?.(); window.renderTurns?.();
  if (!onTurns) window.showDashPanel?.('queue');
  showToast(added > 1 ? `${added} guests added to queue from calendar ✓` : `${firstName} added to queue from calendar ✓`);
}
export function calQuickCheckin(apptId) {
  const party = _gatherParty(apptId);
  if (party.length === 0) return;
  const appt = party[0].appt;
  if (party.length === 1) { _doCalCheckin(party.filter(p => !p.already), appt, 1); return; }
  _showQuickCheckinPicker(party, appt);
}
```

Update `_showQuickCheckinPicker` (currently 1328-1352) and `confirmQuickCheckin` (currently 1354-1365) to the new party shape. Read both; make these changes:
- `_showQuickCheckinPicker(party)` → `_showQuickCheckinPicker(party, appt)`; store `_quickAppt = appt` (add a module var `let _quickAppt = null;` near `_quickParty`); the per-row service text becomes `(p.guest.lines||[]).map(l => cfg().services.find(s=>s.id===l.serviceId)?.label).filter(Boolean).join(', ')`.
- `confirmQuickCheckin` reads the checked boxes → builds `members` from `_quickParty` → calls `_doCalCheckin(members, _quickAppt, _quickParty.length)`.

Read the two functions and apply those substitutions (the modal HTML + checkbox-reading logic are otherwise unchanged).

- [ ] **Step 8: Rewrite `calEventClick` (popover) + `calSlotClick` for the single-id model**

In `js/app/features/calendar.js`, replace `calSlotClick` (currently 1028) — `calId` is a staffId column:

```js
export function calSlotClick(colId, hour, minute) { showNewApptModal(colId, hour, minute, _calCalendars.find(c => c.id === colId)?.name); }
```

Replace `calEventClick` (currently 1029-1079) — take a single `apptId`:

```js
export function calEventClick(e, apptId) {
  e.stopPropagation();
  const a = (getState().appointments || []).find(x => x.id === apptId);
  if (!a) return;
  const startDt = new Date(a.start);
  const g0 = (a.guests || [])[0] || {};
  const title = g0.name || 'Guest', phone = g0.phone || '', notes = a.notes || '';
  const confirmed = !!a.confirmed, noShow = !!a.noShow;
  const queueMatch = _queueForAppt(a.id) || _phoneQueueMatch((phone||'').replace(/\D/g,''), startDt.getTime());
  const svcSummaryHtml = (() => {
    const blocks = (a.guests || []).map(g => ({
      name: g.name || 'Guest',
      lines: (g.lines || []).map(l => {
        const svc = cfg().services.find(s => s.id === l.serviceId)?.label || '';
        if (!svc) return '';
        const tech = (cfg().staff || []).find(s => s.id === l.staffId)?.name || 'Unassigned';
        return `${svc} — ${tech}`;
      }).filter(Boolean),
    })).filter(b => b.lines.length);
    if (!blocks.length) return '';
    const multi = blocks.length > 1;
    return `<div class="mt-2 rounded-xl bg-surface-container px-3 py-2"><div class="text-[10px] font-body font-bold uppercase tracking-widest text-outline mb-1">Services &amp; Staff</div>${blocks.map(b => `${multi ? `<div class="text-xs font-body font-bold text-on-surface mt-1.5">${_escHtml(b.name)}</div>` : ''}${b.lines.map(l => `<div class="text-xs font-body text-on-surface mt-0.5">${_escHtml(l)}</div>`).join('')}`).join('')}</div>`;
  })();
  const modal = document.createElement('div');
  modal.className = 'fixed inset-0 z-[85] flex items-center justify-center bg-on-surface/40 px-4';
  modal.onclick = ev => { if (ev.target === modal) modal.remove(); };
  let statusBadge = '';
  if (['complete','paid','done'].includes(queueMatch?.status)) statusBadge = '<span style="color:#6b7280;font-size:11px;font-weight:700">✓ Completed</span>';
  else if (queueMatch?.status === 'inservice') statusBadge = '<span style="color:#16a34a;font-size:11px;font-weight:700">● In Service</span>';
  else if (queueMatch?.status === 'waiting') statusBadge = '<span style="color:#2563eb;font-size:11px;font-weight:700">● Checked In</span>';
  else if (startDt < new Date()) statusBadge = '<span style="color:#ea580c;font-size:11px;font-weight:700">⚠ Not Checked In</span>';
  if (noShow) statusBadge = '<span style="color:#dc2626;font-size:11px;font-weight:700">⊘ No Show</span>';
  const confirmBadge = confirmed ? '<span style="color:#16a34a;font-size:11px;font-weight:700">✓ Confirmed</span>' : '';
  const when = startDt.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}) + ' · ' + startDt.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
  modal.innerHTML = `<div class="bg-surface-container-lowest rounded-2xl p-6 w-full max-w-sm shadow-2xl">
    <div class="flex items-center justify-between mb-3"><h3 class="font-headline font-bold text-on-surface text-lg">${_escHtml(title)}</h3><button onclick="this.closest('.fixed').remove()" class="w-8 h-8 rounded-full hover:bg-surface-container flex items-center justify-center"><span class="material-symbols-outlined text-on-surface-variant" style="font-size:18px">close</span></button></div>
    <div class="space-y-1 text-sm font-body text-on-surface-variant mb-4"><p><span class="font-semibold text-on-surface">${_escHtml(when)}</span></p>${phone?`<p>📞 ${_escHtml(phone)}</p>`:''}${notes?`<p class="text-xs opacity-75">${notes.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>')}</p>`:''}${svcSummaryHtml}${(statusBadge||confirmBadge)?`<div class="mt-1 flex items-center gap-2 flex-wrap">${statusBadge}${confirmBadge}</div>`:''}</div>
    <div class="space-y-2">
      <button onclick="calQuickCheckin('${_escAttrJs(apptId)}'); this.closest('.fixed').remove()" class="w-full bg-primary text-on-primary py-2.5 rounded-xl font-headline font-bold text-sm hover:bg-primary-dim transition-colors flex items-center justify-center gap-2"><span class="material-symbols-outlined" style="font-size:16px">how_to_reg</span> Quick Check-In</button>
      ${queueMatch?`<button onclick="this.closest('.fixed').remove(); showGroupAssignModal('${queueMatch.id}')" class="w-full bg-primary text-on-primary py-2.5 rounded-xl font-headline font-bold text-sm hover:bg-primary-dim transition-colors flex items-center justify-center gap-2"><span class="material-symbols-outlined" style="font-size:16px">assignment_ind</span> Assign & Price</button>`:''}
      <button onclick="calToggleConfirmed('${_escAttrJs(apptId)}'); this.closest('.fixed').remove()" class="w-full ${confirmed?'bg-secondary-container text-on-secondary-container':'border-2 border-primary text-primary hover:bg-primary/10'} py-2.5 rounded-xl font-headline font-bold text-sm transition-colors flex items-center justify-center gap-2"><span class="material-symbols-outlined" style="font-size:16px">${confirmed?'event_available':'check_circle'}</span> ${confirmed?'Confirmed — tap to undo':'Mark Confirmed'}</button>
      <button onclick="calMarkNoShow('${_escAttrJs(apptId)}'); this.closest('.fixed').remove()" class="w-full ${noShow?'bg-error/15 text-error':'border-2 border-outline-variant text-on-surface hover:bg-surface-container'} py-2.5 rounded-xl font-headline font-semibold text-sm transition-colors flex items-center justify-center gap-2"><span class="material-symbols-outlined" style="font-size:16px">person_off</span> ${noShow?'No Show — tap to undo':'Mark No Show'}</button>
      <button onclick="this.closest('.fixed').remove(); showEditApptModal('${_escAttrJs(apptId)}')" class="w-full border-2 border-outline-variant text-on-surface py-2.5 rounded-xl font-headline font-semibold text-sm hover:bg-surface-container transition-colors">Edit Appointment</button>
      <button onclick="if(confirm('Cancel this appointment?')) { deleteAppt('${_escAttrJs(apptId)}'); this.closest('.fixed').remove(); }" class="w-full text-error py-2 rounded-xl font-headline font-semibold text-sm hover:bg-error/10 transition-colors">Cancel / Delete</button>
    </div></div>`;
  document.body.appendChild(modal);
}
```

- [ ] **Step 9: `apptGuardUseAppt` uses the single id**

In `js/app/features/calendar.js`, in `apptGuardUseAppt` (currently 1419-1433), replace the check-in call (currently `calQuickCheckin(m.calId, m.eventId);` at line 1423):

```js
  calQuickCheckin(m.apptId);
```

- [ ] **Step 10: Update the two consumers of the changed accessor return shapes (`turns.js`, `search.js`)**

`apptsForTurns()` rows now carry `apptId` (was `calId`/`eventId`), and `calEventClick` + `findTodayApptFor` changed signature/return. Two call sites read the old keys:

In `js/app/features/turns.js`, `renderTurnsApptStrip` (~316, 331): the `seen.set(k, {…})` object stores `calId: a.calId, eventId: a.eventId` and the card `onclick` calls `calEventClick(event,'…calId…','…eventId…',…)`. Replace both:

- Line ~316 — in the `seen.set` object, replace `calId: a.calId, eventId: a.eventId` with `apptId: a.apptId`.
- Line ~331 — replace `onclick="calEventClick(event,'${_tJs(a.calId)}','${_tJs(a.eventId)}','${_tJs(a.name)}','${_tJs(a.notes || '')}',true)"` with `onclick="calEventClick(event,'${_tJs(a.apptId)}')"`.

*(`turnsDueNoteCard` and `turnsUpcomingAppts` read only `a.startMs`/`a.name`/`a.svc`/`a.techName` — all still present — so no other turns.js edit is needed. The strip opens the popover on tap; check-in happens from the popover, not from the strip.)*

In `js/app/features/search.js`, `gsGo` (~130): replace the appt-jump line
```js
    if (hit) window.calEventClick?.({ stopPropagation() {} }, hit.calId, hit.eventId, hit.name, '', true);
```
with the single-id form:
```js
    if (hit) window.calEventClick?.({ stopPropagation() {} }, hit.apptId);
```
*(`search.js:84` reads only `a.name` off `apptsForReminders()` rows — unchanged.)*

- [ ] **Step 11: Verify the write side in the preview**

With the calendar tab open in the preview (connected to the demo salon / `wrangler dev`):
- Click an empty slot in a staff column → the New Appointment modal opens with that staff pre-selected in the line's second dropdown (which now lists **staff**, not calendars). Enter a name + phone, pick a service, Save.
- Confirm (via `preview_snapshot`/`preview_screenshot`): the bubble appears in that staff's column; the right-rail lists it; `getState().appointments` has one row with the correct `guests[].lines[].staffId`.
- Open the bubble → Mark Confirmed (✓ appears), Mark No Show (red), undo each.
- Edit the appointment (change time/staff) → it moves columns/time.
- Quick Check-In → a queue entry appears with `appointmentId` set and assignments pre-filled from the lines (check `getState().queue`).
- Add a second guest with a different staff → the booking shows in both columns; check-in offers the party picker.
- Cancel/Delete → the bubble disappears and a tombstone is written (`getState().apptDeletions`).
- On a second browser/device pointed at the same salon, confirm the create/edit/cancel propagate (DO sync).

Read `preview_console_logs` for errors after each action; fix and re-verify.

- [ ] **Step 12: Commit**

```bash
git add js/app/features/calendar.js js/app/features/reports.js js/app/features/turns.js
git commit -m "feat(calendar): app-native appointment write path, check-in, guard (dispatch appt.*)"
```

---

## Task 5: Staff app "My Appointments" reads the DO

**Files:**
- Modify: `js/app/staff.js` (`loadMyAppts` ~460-508; remove `_gcalGet` ~455-459; keep `renderApptsHtml` shape)

**Interfaces:**
- Consumes: `getState().appointments`; `me()` (the signed-in staff member); `svc()` (service lookup) — all already in `staff.js`.
- Produces: `_appts` in the SAME shape `renderApptsHtml` already consumes: `[{ startMs, endMs, name, guests, services, notes, confirmed, noShow }]`, filtered to the signed-in tech's `staffId`, next 7 days.

- [ ] **Step 1: Rewrite `loadMyAppts` to read native appointments**

In `js/app/staff.js`, replace `loadMyAppts` (currently 460-508) and delete `_gcalGet` (455-459). The new version is synchronous over `getState().appointments`:

```js
function loadMyAppts(force) {
  const meStaff = me();
  if (!meStaff) { _appts = []; _apptsErr = ''; _apptsAt = Date.now(); return; }
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + APPTS_DAYS + 1);
  const myId = meStaff.id;
  const out = [];
  (getState().appointments || []).forEach(a => {
    if (!a || !a.start || a.noShow) return;
    const s = new Date(a.start);
    if (isNaN(s) || s < start || s >= end) return;
    // Only bookings that include a line assigned to ME.
    const myLines = (a.guests || []).flatMap(g => g.lines || []).filter(l => l.staffId === myId && l.serviceId);
    if (!myLines.length) return;
    const g0 = (a.guests || [])[0] || {};
    const services = [...new Set(myLines.map(l => svc(l.serviceId)?.label).filter(Boolean))];
    out.push({
      startMs: s.getTime(), endMs: new Date(a.end || (s.getTime() + 3600000)).getTime(),
      name: g0.name || 'Guest', guests: Math.max(0, (a.guests || []).length - 1), services,
      notes: (a.notes || '').trim(), confirmed: !!a.confirmed, noShow: !!a.noShow,
    });
  });
  out.sort((x, y) => x.startMs - y.startMs);
  _appts = out; _apptsErr = ''; _apptsAt = Date.now();
  if (_view === 'appts' && !priceInputFocused()) render();
}
```

Confirm `getState` is imported in `staff.js` (it uses `getState()` widely — verify at the top of the file; if not, add `getState` to the store import).

- [ ] **Step 2: Simplify `renderApptsHtml`'s connection notes (optional but clean)**

In `js/app/staff.js`, `renderApptsHtml` shows a "Google Calendar isn't connected" note when `_apptsErr === 'not_connected'`/`'nocal'`. Those error states no longer occur (native read never errors that way), so they're dead but harmless. Leave the render body as-is except confirm `loadMyAppts()` is still called at the top (it is, ~line 512) — now synchronous, so the first render already has data. No functional change required; do not add new copy.

- [ ] **Step 3: Verify in the preview (staff app)**

Open `staff.html` for the demo salon, sign in as a tech who has an appointment (from Task 8's seed or a manually created one assigned to that tech). Open "My Appointments":
- Confirm (via `preview_snapshot`) the tech's upcoming bookings list, one row per booking, with the service names + guest count, sorted by time.
- Confirm a booking assigned to a DIFFERENT tech does NOT appear.
- Sign in as a front-desk (fd) user → the FD schedule view still renders (unchanged; `renderFdView` untouched).

- [ ] **Step 4: Commit**

```bash
git add js/app/staff.js
git commit -m "feat(staff): My Appointments reads app-native appointments (retire Google REST reader)"
```

---

## Task 6: Hide Google UI (toolbar, Tasks panel, settings leaf)

**Files:**
- Modify: `index.html` (Connect-Google button `cal-signin-btn` ~873-875 + ~1148-1156; Tasks panel `cal-tasks-panel` ~914; appt-modal dropdown label if present)
- Modify: `js/app/features/settings.js` (Integrations `gcal-section` leaf ~270-273; keep display-hours + auto-hide)

**Interfaces:**
- Consumes: nothing new. Produces: a Part-1 UI with no Google entry points (dormant code stays; it's just not reachable from the UI).

- [ ] **Step 1: Hide the calendar toolbar Connect-Google button + the empty-state Connect card**

In `index.html`, add `style="display:none"` to the toolbar Connect button (currently ~873, `id="cal-signin-btn"`) and to the calendar empty-state Connect block (~1148-1156, the "Connect Google Calendar to view and create appointments" card + its button). Do not delete them — they're Part-2 UI. Example for the toolbar button:

```html
<button onclick="calSignIn()" id="cal-signin-btn" style="display:none" class="hidden btn-primary">
```

*(It already has the `hidden` class; adding an inline `display:none` guarantees it stays hidden even if dormant code toggles the class. Since Part-1 code never un-hides it, the class alone suffices — but the inline style is belt-and-suspenders.)*

- [ ] **Step 2: Hide the Google Tasks panel**

In `index.html`, add `style="display:none"` to the Tasks panel container (currently ~914, `id="cal-tasks-panel"` — it already has `hidden flex-col`). This removes the Google-only Tasks side panel in Part 1 (spec §2 "explicitly NOT preserved"). The right-rail "Today's Appointments" panel above it is untouched.

```html
<div id="cal-tasks-panel" style="display:none" class="hidden flex-col rounded-xl border overflow-hidden" ...>
```

- [ ] **Step 3: Hide the Google-connect Integrations leaf in Settings**

In `js/app/features/settings.js`, the Integrations section (~270-273) lists a `{ label:'Google Calendar', … content:'gcal-section', render:'renderGcalSettings', … }` item. Remove that one item from the `items:[…]` array (leave the Square item). This drops the Google-connect + "which calendar is Unassigned" leaf. The display-hours setting and the off-duty auto-hide toggle (`renderCalAutoHideSetting`, rendered into `#cal-autohide-setting`) live elsewhere and are unchanged.

Read lines ~268-276 and delete only the Google Calendar item object.

- [ ] **Step 4: Verify in the preview**

Reload the dashboard:
- Calendar tab: no "Connect Google Calendar" button in the toolbar or empty state; no Tasks panel; the grid + Today's-Appointments rail + Calendars filter + Day/Week toggle all present.
- Settings → Integrations: Square present, Google Calendar leaf gone. Settings → (display) still has the calendar display-hours + off-duty auto-hide toggle, and toggling auto-hide still greys off-duty staff columns.

Confirm via `preview_snapshot`. Read `preview_console_logs` for errors.

- [ ] **Step 5: Commit**

```bash
git add index.html js/app/features/settings.js
git commit -m "chore(calendar): hide Google entry points in Part 1 (dormant, re-added in Part 2)"
```

---

## Task 7: Seed app-native demo appointments

**Files:**
- Modify: `tools/seed-demo.mjs` (add `buildAppointments` + an `appt.upsert` seeding step)

**Interfaces:**
- Consumes: the existing `mutate(op, payload)` helper (POSTs `/state/mutate?salon=demo`), `STAFF` (ids `staff-1..staff-8`), `SERVICES` (ids `svc-*`), the deterministic PRNG (`rnd`/`ri`/`pick`/`chance`).
- Produces: deterministic `appt-<n>` appointments (a few today across staff + a few upcoming days, some confirmed), idempotent on re-run (overwrite by id).

- [ ] **Step 1: Add `buildAppointments`**

In `tools/seed-demo.mjs`, add this function next to `buildGiftcards` (~line 138). It creates ~14 appointments: several today (spread across staff, mixed confirmed) + a handful over the next 3 days, plus one multi-guest party:

```js
// A dozen-ish believable app-native appointments: some today (spread across staff, some
// confirmed), some over the next 3 days, one 2-guest party. Deterministic ids appt-1..N.
function buildAppointments() {
  const out = [];
  const at = (dayOffset, hour, min) => { const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() + dayOffset); d.setHours(hour, min, 0, 0); return d; };
  const mk = (startD, mins, guests, confirmed) => {
    const start = startD.toISOString(), end = new Date(startD.getTime() + mins*60000).toISOString();
    out.push({ id: `appt-${out.length + 1}`, start, end, guests, notes: '', confirmed: !!confirmed, noShow: false, checkedInQueueId: null, createdAt: Date.now() });
  };
  const cust = () => { const gn = pick(FIRST), fn = pick(LAST); const area = pick(['909','714','951']); return { name: `${gn} ${fn}`, phone: `(${area}) ${ri(200,999)}-${String(ri(0,9999)).padStart(4,'0')}` }; };
  const svcId = () => pick(SERVICES).id;
  const staffId = (i) => STAFF[i % STAFF.length].id;
  // Today — one per several staff, a couple confirmed, one upcoming this afternoon.
  [ [10,0,0], [11,30,1], [13,0,2], [14,30,3], [16,0,4], [17,15,5] ].forEach(([h,m,si], k) => {
    const c = cust(); mk(at(0,h,m), pick([45,60,60,90]), [{ name: c.name, phone: c.phone, lines: [{ serviceId: svcId(), staffId: staffId(si) }] }], k % 2 === 0);
  });
  // A 2-guest party today, two different techs.
  { const a = cust(), b = cust(); mk(at(0,15,0), 60, [
      { name: a.name, phone: a.phone, lines: [{ serviceId: svcId(), staffId: staffId(1) }] },
      { name: b.name, phone: b.phone, lines: [{ serviceId: svcId(), staffId: staffId(2) }] },
    ], true); }
  // Next 3 days — a few each, some Unassigned (staffId '').
  for (let d = 1; d <= 3; d++) {
    const n = ri(2, 4);
    for (let k = 0; k < n; k++) { const c = cust(); const sid = chance(0.3) ? '' : staffId(d + k); mk(at(d, ri(9,17), pick([0,15,30,45])), pick([45,60,90]), [{ name: c.name, phone: c.phone, lines: [{ serviceId: svcId(), staffId: sid }] }], chance(0.5)); }
  }
  return out;
}
```

- [ ] **Step 2: Seed the appointments**

In `tools/seed-demo.mjs`, in `main()`, add a step after the gift-cards step (after ~line 262, before the cash-drawer step). Use the same `pool` concurrency helper:

```js
  // 4b) Appointments (app-native) — a few today + upcoming, one party.
  const appointments = buildAppointments();
  await pool(appointments, (a) => mutate('appt.upsert', { appt: a }), CONC);
  console.log(`  appointments ✓ (${appointments.length})`);
```

- [ ] **Step 3: Run the seeder against the demo salon**

Run (PowerShell): `node tools/seed-demo.mjs`
Expected: the console log includes `appointments ✓ (14)` (or similar), with no errors.

Verify the DO received them:
Run: `curl -s "https://turndesk.musenailandspa.workers.dev/state/snapshot?salon=demo" -H "Authorization: Bearer $TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('appointments:',(j.state||j).appointments?.length)})"`
(where `$TOKEN` is a demo session token minted via `/auth/login?salon=demo` with SEED_PIN — or simply confirm in the app by opening the demo calendar and seeing the seeded bookings).
Expected: `appointments: 14` (non-zero).

- [ ] **Step 4: Commit**

```bash
git add tools/seed-demo.mjs
git commit -m "chore(seed): seed app-native demo appointments (appt.upsert)"
```

---

## Task 8: Version bump + full-suite verification (ready to ship)

**Files:**
- Modify: `js/app/config.js` (`APP_VERSION`), `version.json`, `sw.js` (`CACHE_NAME`)

- [ ] **Step 1: Bump the version trio together**

`js/app/config.js` line 2:
```js
export const APP_VERSION = 'td-v0.18';
```
`version.json`:
```json
{ "version": "td-v0.18" }
```
`sw.js` line 4:
```js
const CACHE_NAME = 'turndesk-v0.18';
```

- [ ] **Step 2: Run the full test suite + Worker check**

Run: `npm test`
Expected: PASS — all tests green (Task 1's appt tests + all pre-existing).

Run: `npm run check`
Expected: exit 0 — `cloudflare/worker.js` parses.

- [ ] **Step 3: Final end-to-end preview pass (Google fully disconnected)**

With no Google connection, confirm the full loop against the demo salon:
- Day + Week views render seeded appointments in the right staff columns; the now-line + pinch/ctrl-wheel zoom work; the Calendars filter shows/hides/reorders staff columns and off-duty auto-hide greys/peeks.
- Create, edit, reschedule (change time+staff), confirm/unconfirm, no-show/undo, cancel — all persist and re-render.
- Quick check-in (single + party) creates linked queue entries (`appointmentId`), and the appt-vs-checkin guard fires from the kiosk + manual-add.
- Turns "upcoming appts" strip + appointment-reminder banners + global-search appointment results populate.
- Staff app "My Appointments" shows the signed-in tech's bookings.
- A second device sees create/edit/cancel propagate.

Capture a `preview_screenshot` of the populated day view as proof.

- [ ] **Step 4: Commit the version bump**

```bash
git add js/app/config.js version.json sw.js
git commit -m "chore: td-v0.18 — app-native appointments (calendar re-arch Part 1)"
```

- [ ] **Step 5: Ship (owner-gated)**

Do NOT run these without the owner's explicit OK each time:
- `git push` (GitHub Pages auto-deploys the client on push to `main`).
- `wrangler deploy` from `cloudflare/` (the Worker changed — appt.* mutation + snapshot). Verify the Cloudflare account = info@musenailandspa.com before deploying.
- After deploy: on the demo salon confirm cross-device sync of a freshly created appointment, and that the operator export/snapshot includes `appointments`.

Consider using the `ship` skill for the release flow (bump/changelog/commit/push-with-OK/optional wrangler-deploy).

---

## Notes carried from the spec (do not lose)

- **Dormant Google, not deleted:** `loadGCalScripts`, `calSignIn`, `calSignOut`, `_fetchWorkerToken`, `ensureFreshToken`, `_tokenFresh`, `scheduleCalTokenRefresh`, `_gcalNoteDeleted`, `_gcalNoteWritten`, `_gcalApplyGuards`, `_calGhosts`, `_calPins`, `ensureTodayApptEvents`, `calSilentSync`, `startCalSync`, `calForceSync`, `loadTaskLists`/`loadTasksForList`/`renderTasks`/`toggleTasksPanel`/`toggleTask`/`deleteTask`/`showAddTaskModal`, `renderGcalCalendarList`, `setUnassignedCal`, `clearPastNoShowFlags`, `_apptEventBody`, `_bookingEventIds`/`_personEventIds`/`_queueEntryForEventIds`/`_eventGroupRefs`, `_apptPhone`/`_apptNotes`/`_parseApptLines` — leave defined; Part 1 never calls them from the render/write path. (`initCalendar` no longer needs to call `loadGCalScripts`; point `initCalendar` at `calLoadAndRender` instead — see below.)
- **`initCalendar`:** re-pointed to `calLoadAndRender()` in **Task 3 Step 8** (drops the `loadGCalScripts()` boot call — the one dormant-Google call that was in the render path).
- **`/gcal/callback` tenant bug** (salonId `''`) is **Part 2's** problem — do not touch.
- **Recurring appointments** are out of scope (not supported today, not added).
- **Part 2** (separate spec): optional Google sync (per-salon + per-staff opt-in), the connect UI re-enable, the push/pull adapter mapping the native shape ↔ Google Events, the `/gcal/callback` fix, and an app-native Tasks replacement.
