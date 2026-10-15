// ── Durable Object Sync Client ──────────────────────────────────────────────
// The client's only link to the source of truth (MuseSalonDO). Connects over a
// WebSocket, hydrates the store from a snapshot, applies remote `change`
// broadcasts, and sends local mutations. Writes are optimistic + queued in a
// persistent outbox, so the front desk keeps working through wifi drops; the
// outbox replays on reconnect and the DO dedupes by mutationId.

import { hydrate, applyChange, setConnection, setAuthNeeded, loadCache, flushCache, markServerHydrated } from './store.js';
import { requestPersistence } from './idbcache.js';
import { withAuth, salonSlug, scopedKey } from './apptoken.js';
import { apiOrigin } from './apiorigin.js';

// Origin (prod / local wrangler dev / allowed ?api= staging override) is shared with
// config.js + apptoken.js so all three agree — see apiorigin.js.
const ORIGIN = apiOrigin();
const WS_URL     = ORIGIN.replace(/^http/, 'ws') + '/ws';
const STATE      = ORIGIN + '/state';
const OUTBOX_KEY = 'turndesk_outbox';
const FAILED_KEY = 'turndesk_failed_ops';   // dead-letter: writes the server rejected (never silently dropped)

export const DEVICE_ID = (() => {
  let id = localStorage.getItem('turndesk_device_id');
  if (!id) { id = 'dev-' + Math.random().toString(36).slice(2, 8); localStorage.setItem('turndesk_device_id', id); }
  return id;
})();

let _ws = null, _connected = false, _reconnect = null, _ping = null, _mutCounter = 0;
let _lastRecv = 0, _resyncTimer = null;   // heartbeat watchdog + resync throttle
let _authNeeded = false, _snapshotInFlight = false;   // mirror the auth gate for the watchdog; serialize snapshots
let _outbox = loadOutbox();

// ── Wake / liveness ──────────────────────────────────────────────────────────
// A socket that hasn't delivered anything in STALE_MS is treated as dead even when
// the browser still reports it OPEN — iOS leaves a "zombie-OPEN" socket after the
// phone sleeps, which is why the board went stale until a manual refresh. 30s sits
// comfortably above the 20s ping cadence (a live socket is never that quiet) and
// under the 40s heartbeat backstop. TODO(revisit ~late-2026): retune STALE_MS once
// we've watched it run on the techs' phones — see PRIORITIES.md. Note: any value below
// ~40s means a single dropped pong on an otherwise-idle socket forces a (clean) reconnect
// rather than just an HTTP refresh; that's the main thing to weigh when retuning.
const STALE_MS = 30000;

// Reconnect the WS on a wake? No socket / non-OPEN → yes (as before); an OPEN socket
// silent past STALE_MS is a zombie → yes. A live, recently-heard-from socket → no.
export function _shouldReconnect(now, lastRecv, isOpen) {
  return !isOpen || (now - lastRecv > STALE_MS);
}
// Should the visible-only watchdog / touch handler fire a resync now? Only while the
// page is visible, the session is valid (no 401 loop), the socket has ever connected,
// and we've genuinely gone quiet past STALE_MS.
export function _shouldResync(now, lastRecv, visible, authNeeded) {
  return visible && !authNeeded && lastRecv > 0 && (now - lastRecv > STALE_MS);
}
// Keep the store indicator and the watchdog's local gate in lockstep — _shouldResync reads
// _authNeeded, not the store, so every auth flip must go through here or the two can drift.
function markAuthNeeded(v) { setAuthNeeded(v); _authNeeded = v; }

// ── Outbox ───────────────────────────────────────────────────────────────────
function loadOutbox() {
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem(scopedKey(OUTBOX_KEY)) || '[]'); } catch { return []; }
  // Self-heal a flooded outbox: a pre-v4.26 bulk customer import enqueued one customer.upsert per
  // customer, which freezes the tab when replayed one-by-one (each replay = a full-state cache write
  // + re-render). Coalesce a large run of them into chunked customer.bulkUpsert messages (latest per
  // id wins) so replay is O(chunks), not O(customers). Deterministic mutationIds → the DO dedupes
  // if this runs again.
  const custCount = arr.reduce((n, m) => n + (m && m.op === 'customer.upsert' ? 1 : 0), 0);
  if (custCount > 30) {
    const others = arr.filter(m => !(m && m.op === 'customer.upsert' && m.payload && m.payload.customer));
    const byId = new Map();
    arr.forEach(m => { if (m && m.op === 'customer.upsert' && m.payload && m.payload.customer) byId.set(String(m.payload.customer.id), m.payload.customer); });
    const list = [...byId.values()];
    const bulk = [];
    for (let i = 0; i < list.length; i += 200) {
      bulk.push({ type: 'mutate', op: 'customer.bulkUpsert', payload: { customers: list.slice(i, i + 200) }, mutationId: DEVICE_ID + '-coalesce-' + list.length + '-' + i, device: DEVICE_ID });
    }
    arr = [...others, ...bulk];
    try { localStorage.setItem(scopedKey(OUTBOX_KEY), JSON.stringify(arr)); } catch {}
  }
  // Self-heal a flooded config.set outbox (boot OOM guard): a frozen tab can enqueue thousands of
  // config.set for the SAME key faster than the WS can ack+drain them, leaving a giant outbox that
  // then freezes/OOMs the tab on every reload as reapplyOutbox + replayOutbox walk it. config.set is
  // last-writer-wins per key, so all but the last write to a key are superseded — collapse them here,
  // before either walk runs. (Ported from Muse v5.58.)
  const coalesced = coalesceConfigSets(arr);
  if (coalesced.length !== arr.length) { arr = coalesced; try { localStorage.setItem(scopedKey(OUTBOX_KEY), JSON.stringify(arr)); } catch {} }
  return arr;
}
// Drop superseded config.set ops (keep only the LAST write per key, order preserved) once the
// outbox is pathologically full of them. Pure + exported for tests. Only kicks in past a flood
// threshold so a normal outbox is untouched; even then it only drops same-key duplicates, never a
// distinct key or a non-config op, so no pending write is ever lost.
export function coalesceConfigSets(arr) {
  const cfgCount = arr.reduce((n, m) => n + (m && m.op === 'config.set' ? 1 : 0), 0);
  if (cfgCount <= 50) return arr;
  const lastIdx = new Map();
  arr.forEach((m, i) => { if (m && m.op === 'config.set' && m.payload && m.payload.key != null) lastIdx.set(m.payload.key, i); });
  const keep = new Set(lastIdx.values());
  return arr.filter((m, i) => !(m && m.op === 'config.set' && m.payload && m.payload.key != null) || keep.has(i));
}
function saveOutbox() {
  try { localStorage.setItem(scopedKey(OUTBOX_KEY), JSON.stringify(_outbox)); } catch {}
  setConnection(_connected, _outbox.length);
}
function enqueue(msg)        { _outbox.push(msg); saveOutbox(); }
function ackOutbox(id)       { const i = _outbox.findIndex(m => m.mutationId === id); if (i >= 0) { _outbox.splice(i, 1); saveOutbox(); } }
// A server-REJECTED write must never just vanish (the old code acked it like a success,
// silently dropping the data) and must not retry forever. Move it to a dead-letter log so
// it's recoverable + surfaced in the glitch report, then clear it from the outbox.
function deadLetter(id, error) {
  const i = _outbox.findIndex(m => m.mutationId === id);
  const msg = i >= 0 ? _outbox[i] : null;
  try {
    const fk = scopedKey(FAILED_KEY);
    const log = JSON.parse(localStorage.getItem(fk) || '[]');
    log.push({ at: new Date().toISOString(), error: String(error || 'rejected'), op: msg?.op, payload: msg?.payload, mutationId: id, device: DEVICE_ID });
    localStorage.setItem(fk, JSON.stringify(log.slice(-200)));   // keep the last 200
  } catch {}
  if (i >= 0) { _outbox.splice(i, 1); saveOutbox(); }
  // Make a rejected write VISIBLE — it's recoverable in Settings → Data Recovery, not silently dropped.
  try { window.showToast?.('A change could not be saved — open Settings → Data Recovery.'); } catch (e) {}
  // …and log it to Diagnostics + alert the owner: a rejected write is data-loss-adjacent.
  try { window.reportError?.('sync.rejected-write', (msg?.op || 'write') + ' rejected: ' + String(error || 'rejected'), { serious: true }); } catch (e) {}
}
export function failedOps() { try { return JSON.parse(localStorage.getItem(scopedKey(FAILED_KEY)) || '[]'); } catch { return []; } }
export function outboxPending() { return _outbox.slice(); }
export function clearFailedOp(mutationId) {
  try {
    const fk = scopedKey(FAILED_KEY);
    const log = JSON.parse(localStorage.getItem(fk) || '[]').filter(x => x.mutationId !== mutationId);
    localStorage.setItem(fk, JSON.stringify(log));
  } catch {}
}

// A queued write carries the salon it was made for (dispatch stamps `salon`). It must
// NEVER be sent to a different salon than the one it belongs to — that would be a
// cross-salon corruption. Un-stamped items (pre-stamp; only ever in their own salon's
// scoped bucket) pass through. This is the belt on top of the per-salon outbox buckets.
export function isForeignWrite(msg, currentSalon) {
  return !!(msg && msg.salon && msg.salon !== currentSalon);
}

// ── Lifecycle ───────────────────────────────────────────────────────────────
export async function start() {
  connect();                                     // start the DO connection IMMEDIATELY — never gated on the local cache read
  setTimeout(() => { if (!_connected) httpSnapshot(); }, 2500); // WS slow/blocked → HTTP hydrate
  requestPersistence();                          // best-effort: make the IDB cache non-evictable (fire-and-forget)
  // Hydrate from the local cache for boot's first render. Bounded — idbcache._open() times out, so a
  // wedged IndexedDB (iOS Safari) can never hang the boot; the DO snapshot hydrates regardless, and
  // the seq-guard + _serverHydrated in loadCache stop a stale cache from clobbering a fresher snapshot.
  await loadCache();
  // Re-establish + catch up the moment the device wakes or the network returns. An iPad that
  // slept or had a wifi blip otherwise keeps a dead socket and stops seeing other devices'
  // changes until a manual refresh — this is what makes updates appear without one. flushCache on
  // hide/pagehide so the last optimistic write isn't lost in the async-commit window.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => { if (document.hidden) flushCache(); else resync(); });
    document.addEventListener('resume', resync);   // Page Lifecycle thaw — Chromium/Android PWAs; iOS doesn't fire it (the watchdog covers iPhones), kept for the broader fleet
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', resync);
    window.addEventListener('focus', resync);
    window.addEventListener('pagehide', flushCache);
    // bfcache restore. persisted-gated: an unrestored (cold) load is already handled by
    // connect() above, and resyncing then would needlessly tear down the CONNECTING boot socket.
    window.addEventListener('pageshow', (e) => { if (e && e.persisted) resync(); });
    // First tap after a quiet spell catches up instantly. passive so it can't affect scroll/drag.
    window.addEventListener('touchstart', wakeCheck, { passive: true });
  }
  // Visible-only freshness watchdog. Timers freeze while the page is backgrounded, so this runs
  // only while a tech is actually looking at the screen — and it catches the iOS wakes that fire
  // NO event at all (the "board stays stale until a manual refresh" case), within ~5s.
  setInterval(wakeCheck, 5000);
}

// Fire a wake resync iff we're visible, signed in, and genuinely stale (shared by the watchdog
// interval and the touchstart handler).
function wakeCheck() {
  const visible = !(typeof document !== 'undefined' && document.hidden);
  if (_shouldResync(Date.now(), _lastRecv, visible, _authNeeded)) resync();
}

// Force the connection healthy and pull a fresh snapshot to catch any broadcasts missed while
// the socket was dead/asleep. Throttled so visibility+focus firing together don't double-fetch.
export function resync() {
  if (_resyncTimer) return;
  _resyncTimer = setTimeout(() => { _resyncTimer = null; }, 1500);
  // Don't trust readyState alone: a socket silent past STALE_MS is dead even when it still reports
  // OPEN (iOS zombie-OPEN after sleep) — _shouldReconnect tears that down too, not just a non-OPEN
  // socket. But leave a socket still CONNECTING alone: a fresh connect is already in flight (the
  // 10s openTimer recycles a CONNECTING zombie), so killing it every watchdog tick would stop a
  // slow connection from ever completing.
  const rs = _ws ? _ws.readyState : null;
  if (rs !== WebSocket.CONNECTING && _shouldReconnect(Date.now(), _lastRecv, rs === WebSocket.OPEN)) {
    if (_reconnect) { clearTimeout(_reconnect); _reconnect = null; }
    const old = _ws; _ws = null;                       // drop our ref first so old's late onclose no-ops
    clearInterval(_ping); _ping = null;                // ...which means old's onclose won't clear its heartbeat — do it here so the interval doesn't leak
    if (old) { try { old.close(); } catch {} }
    connect();
  }
  httpSnapshot();   // idempotent: hydrate replaces state, reapplyOutbox preserves pending writes
}

function connect() {
  if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return;
  let ws;
  // withAuth at connect time (not module load) so a token entered in Settings
  // applies on the next reconnect without a reload. Headers are impossible on a
  // browser WebSocket — the token rides as ?auth= and the Worker checks it there.
  try { ws = new WebSocket(withAuth(WS_URL)); } catch { scheduleReconnect(); return; }
  _ws = ws;
  // A socket stuck in CONNECTING — e.g. created while a desktop tab was frozen/backgrounded —
  // is a zombie: it never fires open OR close, so it would block every future reconnect (resync
  // sees "CONNECTING" and leaves it alone). Time it out and force-close so onclose reconnects.
  // The heartbeat watchdog below only covers an already-OPEN socket.
  const openTimer = setTimeout(() => { if (ws.readyState === WebSocket.CONNECTING) { try { ws.close(); } catch {} } }, 10000);

  ws.onopen = () => {
    clearTimeout(openTimer);
    if (_ws !== ws) { try { ws.close(); } catch {} return; }   // superseded by a newer socket
    _connected = true;
    _lastRecv = Date.now();
    markAuthNeeded(false);   // the WS upgrade only succeeds with a valid session
    setConnection(true, _outbox.length);
    send({ type: 'hello' });
    clearInterval(_ping);   // defensive: never stack a second heartbeat if a prior socket's onclose didn't clear it
    _ping = setInterval(() => {
      // Heartbeat watchdog: if nothing (not even a pong) has arrived in ~40s the socket is a
      // zombie — device slept / wifi blipped with no close event — so it silently stops
      // receiving other devices' changes. Force-close it; onclose schedules a reconnect, which
      // re-hellos and pulls a fresh snapshot. (Was the "have to refresh to see updates" bug.)
      if (Date.now() - _lastRecv > 40000) { try { _ws && _ws.close(); } catch {} return; }
      send({ type: 'ping' });
    }, 20000);
  };
  ws.onmessage = ({ data }) => { if (_ws !== ws) return; _lastRecv = Date.now(); let msg; try { msg = JSON.parse(data); } catch { return; } handle(msg); };
  ws.onclose = ws.onerror = () => {
    clearTimeout(openTimer);
    if (_ws !== ws) return;   // a stale/abandoned socket firing late — must not clobber the live one
    _connected = false;
    setConnection(false, _outbox.length);
    clearInterval(_ping); _ping = null;
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (_reconnect) return;
  _reconnect = setTimeout(() => { _reconnect = null; connect(); }, 3000);
}

function send(obj) {
  try { if (_ws && _ws.readyState === WebSocket.OPEN) { _ws.send(JSON.stringify(obj)); return true; } } catch {}
  return false;
}

function handle(msg) {
  if (msg.type === 'pong') return;
  if (msg.type === 'snapshot') { hydrate({ state: msg.state, seq: msg.seq }); markServerHydrated(); reapplyOutbox(); replayOutbox(); return; }
  if (msg.type === 'applied') {
    if (msg.error) { console.warn('[sync] mutation rejected:', msg.error, msg.mutationId); deadLetter(msg.mutationId, msg.error); return; }
    ackOutbox(msg.mutationId);
    return;
  }
  if (msg.type === 'change') {
    if (msg.device && msg.device === DEVICE_ID) return; // our own echo (already applied optimistically)
    applyChange(msg.op, msg.payload, msg.seq);
    return;
  }
  // Helcim terminal result pushed by the Worker webhook (transient — not a state mutation).
  // Routed to the payments module (attached to window by main.js) to settle a waiting charge.
  if (msg.type === 'helcim_result') { try { window.onHelcimResult?.(msg); } catch {} return; }
}

function replayOutbox() {                                    // DO dedupes by mutationId
  const cur = salonSlug();
  for (const msg of _outbox.slice()) {                       // copy: deadLetter mutates _outbox
    if (isForeignWrite(msg, cur)) { deadLetter(msg.mutationId, 'blocked cross-salon write (belongs to ' + msg.salon + ', device is on ' + (cur || 'none') + ')'); continue; }
    send(msg);
  }
}
// A fresh snapshot REPLACES local state — which would drop any optimistic write that the
// server hasn't confirmed yet (e.g. a just-now check-in), making it look like the customer
// vanished. Re-apply the still-pending outbox ops on top of the snapshot so in-flight writes
// survive; the server will dedupe them by mutationId when replayOutbox re-sends.
function reapplyOutbox() { const cur = salonSlug(); for (const msg of _outbox) { if (isForeignWrite(msg, cur)) continue; try { applyChange(msg.op, msg.payload); } catch {} } }

// ── Public: dispatch a mutation (optimistic local apply + queued send) ──────────
// op: 'config.set' | 'queue.upsert' | 'queue.assignmentPatch' | 'queue.remove' | 'record.save'
//   | 'record.delete' | 'giftcard.save' | 'giftcard.delete' | 'audit.log' | 'chat.append'
//   | 'customer.upsert' | 'customer.delete' | 'customer.bulkUpsert' | 'customer.bulkDelete'
//   | 'appt.upsert' | 'appt.delete'
export function dispatch(op, payload) {
  const mutationId = DEVICE_ID + '-' + Date.now() + '-' + (++_mutCounter);
  // Stamp queue + record writes with a wall-clock version so the stale-write guard (store.js
  // applyChange + the DO) can reject a write that's OLDER than what's already saved — this is
  // what stops a lingering stale device copy from clobbering a good record (e.g. dropping a fee).
  if (op === 'queue.upsert' && payload && payload.entry)  { payload.entry.updatedAt  = Date.now(); payload.entry.updatedBy  = DEVICE_ID; }
  // Per-patch DEVICE stamp so the DO's device-scoped guards reject a stale SAME-DEVICE replay
  // (offline outbox) without ever dropping a cross-device action. assignmentPatch already carries
  // assignment.updatedAt (status.js applyAssignmentStatus); entryPatch is stamped below.
  if (op === 'queue.assignmentPatch' && payload && payload.assignment) { payload.assignment.updatedAt = payload.assignment.updatedAt || Date.now(); payload.assignment.updatedBy = DEVICE_ID; }
  if (op === 'record.save'  && payload && payload.record) { payload.record.updatedAt = Date.now(); payload.record.updatedBy = DEVICE_ID; }
  // Stamp config writes too (per-key version) so a stale offline replay or a clobbering concurrent
  // edit of the catalog / turns roster / settings is rejected by the guard instead of last-writer-wins.
  if (op === 'config.set'   && payload)                   { payload.updatedAt = Date.now(); payload.updatedBy = DEVICE_ID; }
  // Gift cards are stored-value money — stamp them so a stale card copy can't clobber a newer balance.
  if (op === 'giftcard.save' && payload && payload.card)  { payload.card.updatedAt = Date.now(); payload.card.updatedBy = DEVICE_ID; }
  // Customer directory entities — stamp so a stale offline copy can't clobber a newer edit.
  if (op === 'customer.upsert' && payload && payload.customer) { payload.customer.updatedAt = Date.now(); payload.customer.updatedBy = DEVICE_ID; }
  // Bulk customer import — stamp every customer in the batch (one apply, not one-per-customer).
  if (op === 'customer.bulkUpsert' && payload && Array.isArray(payload.customers)) { const ts = Date.now(); payload.customers.forEach(c => { c.updatedAt = ts; c.updatedBy = DEVICE_ID; }); }
  // Appointments — stamp so a stale offline copy can't clobber a newer edit (mirrors record.save).
  if (op === 'appt.upsert' && payload && payload.appt) { payload.appt.updatedAt = Date.now(); payload.appt.updatedBy = DEVICE_ID; }
  // Entry-level patches (e.g. the staff visit note) — stamp at the payload level (a patch has no
  // full entry to stamp) so the DO can reject a stale replay that would revert a newer patch.
  if (op === 'queue.entryPatch' && payload) { payload.updatedAt = Date.now(); payload.updatedBy = DEVICE_ID; }
  applyChange(op, payload);                                  // optimistic
  // Stamp the salon this write belongs to, so a replay can never send it to another salon
  // (isForeignWrite guard) — the per-write half of the cross-salon isolation.
  const msg = { type: 'mutate', op, payload, mutationId, device: DEVICE_ID, salon: salonSlug() };
  enqueue(msg);
  if (!send(msg)) httpMutate(msg);                           // WS down → HTTP fallback (idempotent)
}

// ── HTTP fallbacks (used when the WebSocket is unavailable) ─────────────────────
// A 401 means the Worker is enforcing §13 auth and this browser has no valid
// session (never signed in here, expired, or the user was removed). Without
// this signal the device just looks "offline" forever — surface it so whoever's
// holding it knows to enter their PIN, not chase the wifi. Throttled: resync
// fires on every focus/visibility change.
let _lastAuthToast = 0;
function notifyUnauthorized() {
  console.warn('[sync] 401 — no valid sign-in session on this browser');
  markAuthNeeded(true);   // flips the indicator to "Sign in needed" (not a plain "Offline"); also stops the watchdog polling a 401 every 5s
  if (Date.now() - _lastAuthToast < 60000) return;
  _lastAuthToast = Date.now();
  try { window.showToast?.('Sign in needed — enter your PIN to reconnect this device.'); } catch {}
}

async function httpSnapshot() {
  if (_snapshotInFlight) return;   // serialize: a second snapshot mid-fetch could hydrate() out of order and clobber newer state
  _snapshotInFlight = true;
  // Abort after 10s (matches the WS openTimer). Without it a fetch over a dead radio / captive
  // portal can hang forever, never settle, and leave _snapshotInFlight stuck true — which would
  // silently disable every future HTTP catch-up for the session.
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const killer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch {} }, 10000) : null;
  try {
    const res = await fetch(STATE + '/snapshot', { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    if (res.status === 401) { notifyUnauthorized(); return; }
    if (!res.ok) return;
    markAuthNeeded(false);   // a 200 means the session is valid again
    hydrate(await res.json());
    markServerHydrated();
    reapplyOutbox();
    replayOutbox();
  } catch (e) { /* offline / aborted — the IndexedDB/localStorage cache already rendered */ }
  finally { if (killer) clearTimeout(killer); _snapshotInFlight = false; }
}

async function httpMutate(msg) {
  try {
    const res = await fetch(STATE + '/mutate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg),
    });
    if (res.status === 401) { notifyUnauthorized(); return; }   // not a data rejection — stays queued
    if (res.ok) { const d = await res.json(); if (d.applied) ackOutbox(msg.mutationId); }
  } catch (e) { /* stays in outbox for WebSocket replay on reconnect */ }
}
