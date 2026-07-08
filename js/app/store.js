// ── Single State Store ──────────────────────────────────────────────────────
// The one in-memory home for all app state. Hydrated from the Durable Object,
// mutated only via applyChange() (called by the optimistic local path AND by
// remote `change` broadcasts), and observed by feature modules via subscribe().
//
// No global mutable scope: feature modules import { getState, subscribe } and
// dispatch writes through sync.js (which calls applyChange + sends the mutation).

const CACHE_KEY = 'turndesk_state_cache';

// Canonical config field names (clean slate — not the old turndesk_* Sheets keys).
function emptyConfig() {
  return {
    staff: [], services: [], items: [], fees: [], fd_users: [],
    schedule: {}, turn_config: {}, bonus_services: [],
    hidden_services: [], hidden_dash_services: [], inactive_staff: [],
    logo: null, turns_order: [], turns_break: [], turns_off: [], turns_skips: [],
    role_permissions: {}, photos: {}, square_config: null, station_layout: {}, stations: [], station_categories: [], customer_notes: {},
    unassigned_cal_id: '', pay_period: { type: 'weekly', startDate: '' }, payroll_checks: {},
    chat_log: [],   // staff chat messages [{id,uid,name,text,ts}] (capped); rides config sync
    appt_reminder_leads: [30],   // minutes-before to show appointment reminder banners
    cal_autohide_offduty: false, // opt-in: hide off-duty staff calendars by default each day
    svc_time_reset: {},  // per-tech service-time benchmark cutoff { [techId]: ms } — ignore visits before this
    cash_drawer: null,         // the current OPEN cash-drawer shift (or null); see features/cashdrawer.js
    cash_drawer_history: [],   // closed drawer shifts (rolling cap), each with its reconciliation
    edit_locks: {},            // cross-device Assign&Price hard lock { [lockKey]: {device,name,at} }; see queue.js
    last_rollover_date: '',    // SHARED day-rollover marker (localDateStr). Gates the once-per-day housekeeping globally so a device first opened mid-day can't re-clear the roster — see main.js runDayRolloverIfNeeded
  };
}

const state = {
  config:    emptyConfig(),
  configMeta: {},  // per-key write stamp { [key]: { updatedAt, updatedBy } } — drives the config.set stale-write guard (mirrors records/queue)
  queue:     [],
  records:   [],
  giftcards: [],
  customers: [],   // synced customer directory entities ({id,firstName,lastName,phone,email,...}); per-record DO keys (customer:<id>), NOT a config blob
  deletions: [],   // array of deleted record ids (strings)
  customerDeletions: [],   // array of deleted customer ids (strings) — tombstones so a stale offline upsert can't revive a deleted customer
  appointments: [],   // synced app-native appointments (per-record DO keys appt:<id>); one row per booking, guests + per-service staffId inside
  apptDeletions: [],  // array of deleted appointment ids (strings) — tombstones so a stale offline upsert can't revive a cancelled appt
  audit:     [],   // universal activity log (newest first, capped) — synced via the DO
  seq:       0,
  rev:       0,    // monotonic data-revision counter (bumped on hydrate + each applied change); lets consumers cheaply cache derived results and invalidate when state actually changes (records are mutated in place, so the array ref is not a reliable signal)
  // connection / sync status (set by sync.js, observed by the UI indicator)
  connected:    false,
  pendingCount: 0, // outbox length
};

const subscribers = new Set();

export function getState() { return state; }

// Subscribe to any state change. fn(state, changedOp). Returns an unsubscribe fn.
export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function notify(changed) {
  for (const fn of subscribers) {
    try { fn(state, changed); } catch (e) { console.error('[store] subscriber error', e); }
  }
}

// ── id helpers ────────────────────────────────────────────────────────────────
function upsertById(arr, item) {
  const i = arr.findIndex(x => String(x.id) === String(item.id));
  if (i >= 0) arr[i] = item; else arr.push(item);
}
// Stale-write guard: an incoming write is REJECTED only when the copy we already hold is
// strictly NEWER (by updatedAt). This stops a lingering stale device copy (e.g. an old outbox
// op from before a fee was added) from clobbering a good record. Writes without a timestamp on
// either side always apply (legacy data isn't guarded). Returns true if applied.
export function isStaleWrite(prev, next) {
  return !!(prev && next && typeof prev.updatedAt === 'number' && typeof next.updatedAt === 'number' && prev.updatedAt > next.updatedAt);
}
function upsertByIdGuarded(arr, item) {
  const i = arr.findIndex(x => String(x.id) === String(item.id));
  if (i < 0) { arr.push(item); return true; }
  if (isStaleWrite(arr[i], item)) return false;   // keep the newer copy
  arr[i] = item;
  return true;
}
function removeById(arr, id) {
  const i = arr.findIndex(x => String(x.id) === String(id));
  if (i >= 0) arr.splice(i, 1);
}
// Recompute entry.status from its assignments + stamp statusSince on change. Mirrors
// status.js deriveEntryStatus/applyEntryStatus (inlined to avoid a store↔status import cycle).
// Used after a per-assignment merge/patch so entry.status stays consistent with its assignments.
function deriveEntryStatusFields(entry) {
  const ss = (entry.assignments || []).map(a => a.status || 'waiting');
  let next;
  if (!ss.length) next = entry.status || 'waiting';
  else if (ss.some(s => s === 'inservice')) next = 'inservice';
  else if (ss.every(s => s === 'paid' || s === 'done')) next = 'paid';
  else if (ss.every(s => s === 'complete' || s === 'paid' || s === 'done')) next = 'complete';
  else next = 'waiting';
  if (next !== entry.status) { entry.prevStatusSince = entry.statusSince; entry.statusSince = Date.now(); }
  entry.status = next;
}
// Per-assignment field-merge for a whole-entry write: keep a STORED assignment whose own
// updatedAt is NEWER than the incoming one, so a front-desk whole-entry save can't revert a
// tech's concurrent per-assignment change (and vice-versa). Keep the stored one when it is
// stamped AND the incoming one is EITHER older OR unstamped — a forgotten front-desk modal
// re-saves the whole entry with the assignment's cost reverted to its stale form value, so an
// unstamped incoming assignment must never beat a stamped stored one. Both-unstamped → incoming
// (legacy back-compat). Per-assignment updatedAt is owned by applyAssignmentStatus (status.js)
// and the modal's changed-field save; dispatch('queue.upsert') stamps only the entry level.
// Returns true if any stored assignment was preserved.
function mergeNewerAssignments(incoming, stored) {
  if (!stored || !Array.isArray(incoming.assignments) || !Array.isArray(stored.assignments)) return false;
  let merged = false;
  incoming.assignments = incoming.assignments.map(ia => {
    const sa = stored.assignments.find(x => x.serviceId === ia.serviceId && x.techId === ia.techId);
    if (sa && typeof sa.updatedAt === 'number' && (typeof ia.updatedAt !== 'number' || sa.updatedAt > ia.updatedAt)) { merged = true; return sa; }
    return ia;
  });
  return merged;
}

// ── Hydrate from a full DO snapshot ─────────────────────────────────────────────
export function hydrate(snap) {
  const incoming = (snap && snap.state) || {};
  const cfg = incoming.config || {};
  // Start from defaults, then overlay EVERY incoming config key — including dynamically-named
  // ones that aren't declared in emptyConfig(): the front-desk time-clock punches (fd_clock_<id>),
  // fd_schedule, and timeclock_device_id. Iterating emptyConfig()'s static keys here (the old bug)
  // silently dropped those on every hydrate/resync, so clock-ins + manual punches vanished a few
  // minutes after they synced (the server still held them — only the client lost them).
  const merged = emptyConfig();
  for (const k of Object.keys(cfg)) {
    if (cfg[k] !== undefined && cfg[k] !== null) merged[k] = cfg[k];
  }
  state.config    = merged;
  state.configMeta = (incoming.configMeta && typeof incoming.configMeta === 'object') ? incoming.configMeta : {};
  state.queue     = Array.isArray(incoming.queue)     ? incoming.queue     : [];
  state.records   = Array.isArray(incoming.records)   ? incoming.records   : [];
  state.giftcards = Array.isArray(incoming.giftcards) ? incoming.giftcards : [];
  state.customers = Array.isArray(incoming.customers) ? incoming.customers : [];
  state.deletions = Array.isArray(incoming.deletions) ? incoming.deletions.map(d => String(d.id ?? d)) : [];
  state.customerDeletions = Array.isArray(incoming.customerDeletions) ? incoming.customerDeletions.map(d => String(d.id ?? d)) : [];
  state.appointments = Array.isArray(incoming.appointments) ? incoming.appointments : [];
  state.apptDeletions = Array.isArray(incoming.apptDeletions) ? incoming.apptDeletions.map(d => String(d.id ?? d)) : [];
  state.audit     = Array.isArray(incoming.audit) ? incoming.audit : [];
  state.seq       = snap && snap.seq ? snap.seq : 0;
  state.rev++;
  saveCache();
  notify('hydrate');
}

// ── Apply a single change ────────────────────────────────────────────────────
// Used by both the optimistic local dispatch and remote `change` broadcasts.
// Pure state mutation + notify; never performs I/O.
export function applyChange(op, payload, seq) {
  switch (op) {
    case 'config.set': {
      // Stale-write guard for config (mirrors records/queue): reject a write strictly OLDER than
      // the value we already hold for this key, so a stale offline-outbox replay or a clobbering
      // concurrent edit can't silently revert the catalog / turns roster / settings. Unstamped or
      // equal writes always apply (legacy data + last-writer-wins on a tie).
      const ts = (payload && typeof payload.updatedAt === 'number') ? payload.updatedAt : null;
      const prev = state.configMeta[payload.key];
      if (ts != null && prev && typeof prev.updatedAt === 'number' && ts < prev.updatedAt) return;   // older → keep the newer value
      state.config[payload.key] = payload.value;
      if (ts != null) state.configMeta[payload.key] = { updatedAt: ts, updatedBy: payload.updatedBy || null };
      break;
    }
    case 'queue.upsert': {
      const inc = payload.entry;
      const cur = state.queue.find(x => String(x.id) === String(inc.id));
      if (cur && isStaleWrite(cur, inc)) return;                       // whole-entry stale guard (keep newer)
      if (mergeNewerAssignments(inc, cur)) deriveEntryStatusFields(inc);   // 3c: protect a concurrent per-assignment change
      upsertById(state.queue, inc);
      break;
    }
    case 'queue.assignmentPatch': {
      // 3c: a tech's per-assignment change (staff app) merged into the CURRENT entry, so it can't
      // clobber a concurrent front-desk fee/item/discount edit on the same ticket.
      const e = state.queue.find(x => String(x.id) === String(payload.entryId));
      if (!e || !Array.isArray(e.assignments)) return;
      if (e.status === 'paid' || e.status === 'done') return;           // never let a stale device un-pay
      const idx = e.assignments.findIndex(x => x.serviceId === payload.serviceId && x.techId === payload.techId);
      if (idx < 0) return;                                              // assignment reassigned away — drop
      e.assignments[idx] = payload.assignment;
      deriveEntryStatusFields(e);
      break;
    }
    case 'queue.entryPatch': {
      // Entry-level field merge (e.g. the staff app's visit note): apply ONLY the provided
      // fields onto the CURRENT stored entry, so it can't clobber a concurrent front-desk
      // fees/items/discount edit the way a whole-entry queue.upsert would. Sibling of
      // assignmentPatch, for entry-level fields.
      const e = state.queue.find(x => String(x.id) === String(payload.entryId));
      if (!e) return;
      if (e.status === 'paid' || e.status === 'done') return;   // don't let a stale device touch a closed ticket
      const patch = payload.patch || {};
      for (const k of Object.keys(patch)) e[k] = patch[k];
      break;
    }
    case 'queue.remove':  removeById(state.queue, payload.id); break;
    case 'record.save':
      // Never revive a deleted transaction: a stale paid queue copy on another device can re-fire
      // saveRecord with a fresh updatedAt that would pass the stale-write guard and un-delete the
      // record at the storage layer (invisible in the dashboard, but a backup restore brings it back).
      if (state.deletions.includes(String(payload.record && payload.record.id))) return;
      if (!upsertByIdGuarded(state.records, payload.record)) return;   // stale → ignore (keep newer)
      break;
    case 'record.delete': {
      const r = state.records.find(x => String(x.id) === String(payload.id));
      if (r) r.status = 'deleted';
      if (!state.deletions.includes(String(payload.id))) state.deletions.push(String(payload.id));
      break;
    }
    case 'giftcard.save':   if (!upsertByIdGuarded(state.giftcards, payload.card)) return; break;   // stale card copy → keep the newer balance
    case 'giftcard.delete': removeById(state.giftcards, payload.id); break;
    case 'customer.upsert':
      // Don't revive a deleted customer (mirrors record.save's deletion guard).
      if (state.customerDeletions.includes(String(payload.customer && payload.customer.id))) return;
      if (!upsertByIdGuarded(state.customers, payload.customer)) return;   // stale → keep the newer copy
      break;
    case 'customer.bulkUpsert': {
      // One-shot import of many customers — applied in a single pass (one saveCache + notify),
      // so a large Square import can't freeze the tab by re-rendering per customer.
      const list = Array.isArray(payload.customers) ? payload.customers : [];
      for (const cust of list) {
        if (!cust || cust.id == null) continue;
        if (state.customerDeletions.includes(String(cust.id))) continue;
        upsertByIdGuarded(state.customers, cust);
      }
      break;
    }
    case 'customer.delete':
      removeById(state.customers, payload.id);
      if (!state.customerDeletions.includes(String(payload.id))) state.customerDeletions.push(String(payload.id));
      break;
    case 'customer.bulkDelete': {
      const ids = Array.isArray(payload.ids) ? payload.ids : [];
      for (const id of ids) {
        removeById(state.customers, id);
        if (!state.customerDeletions.includes(String(id))) state.customerDeletions.push(String(id));
      }
      break;
    }
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
    case 'audit.log':       if (payload && payload.event) { state.audit.unshift(payload.event); if (state.audit.length > 500) state.audit.length = 500; } break;
    case 'chat.append': {
      // Append a single staff-chat message (mirrors the DO's atomic append). Idempotent by
      // id so the optimistic local apply + a broadcast echo / outbox replay never double-add.
      const m = payload && payload.message;
      if (!m || !m.id) break;
      const log = Array.isArray(state.config.chat_log) ? state.config.chat_log : (state.config.chat_log = []);
      if (log.some(x => x && x.id === m.id)) break;
      log.push(m);
      if (log.length > 300) log.splice(0, log.length - 300);
      break;
    }
    default: console.warn('[store] unknown op', op); return;
  }
  if (typeof seq === 'number' && seq > state.seq) state.seq = seq;
  state.rev++;
  saveCache();
  notify(op);
}

// ── Connection status (set by sync.js) ──────────────────────────────────────────
export function setConnection(connected, pendingCount) {
  state.connected = connected;
  if (typeof pendingCount === 'number') state.pendingCount = pendingCount;
  notify('connection');
}
// Distinguish "no valid sign-in session" (the Worker returned 401) from a plain
// network outage — otherwise a device that just needs a PIN reads as "Offline" and
// sends people chasing wifi. Set by sync.js on 401, cleared on a good connection.
export function setAuthNeeded(v) {
  const nv = !!v;
  if (state.authNeeded === nv) return;
  state.authNeeded = nv;
  notify('connection');
}

// ── Offline cache (instant render on reload before the DO snapshot arrives) ─────
function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      config: state.config, configMeta: state.configMeta, queue: state.queue, records: state.records,
      giftcards: state.giftcards, customers: state.customers, deletions: state.deletions,
      customerDeletions: state.customerDeletions,
      appointments: state.appointments, apptDeletions: state.apptDeletions,
      seq: state.seq,
    }));
  } catch (e) { /* quota / unavailable — non-fatal */ }
}

export function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return false;
    hydrate({ state: JSON.parse(raw), seq: JSON.parse(raw).seq });
    return true;
  } catch (e) { return false; }
}
