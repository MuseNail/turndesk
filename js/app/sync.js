// ── Durable Object Sync Client ──────────────────────────────────────────────
// The client's only link to the source of truth (MuseSalonDO). Connects over a
// WebSocket, hydrates the store from a snapshot, applies remote `change`
// broadcasts, and sends local mutations. Writes are optimistic + queued in a
// persistent outbox, so the front desk keeps working through wifi drops; the
// outbox replays on reconnect and the DO dedupes by mutationId.

import { hydrate, applyChange, setConnection, loadCache } from './store.js';
import { withAuth } from './apptoken.js';

const PROD_ORIGIN = 'https://musedashboard.musenailandspa.workers.dev';
// When served from localhost (a static server in front of `wrangler dev`), talk to
// the local Worker on :8787; otherwise the production Worker.
const ORIGIN = (typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname))
  ? 'http://localhost:8787'
  : PROD_ORIGIN;
const WS_URL     = ORIGIN.replace(/^http/, 'ws') + '/ws';
const STATE      = ORIGIN + '/state';
const OUTBOX_KEY = 'muse_outbox';
const FAILED_KEY = 'muse_failed_ops';   // dead-letter: writes the server rejected (never silently dropped)

export const DEVICE_ID = (() => {
  let id = localStorage.getItem('muse_device_id');
  if (!id) { id = 'dev-' + Math.random().toString(36).slice(2, 8); localStorage.setItem('muse_device_id', id); }
  return id;
})();

let _ws = null, _connected = false, _reconnect = null, _ping = null, _mutCounter = 0;
let _lastRecv = 0, _resyncTimer = null;   // heartbeat watchdog + resync throttle
let _outbox = loadOutbox();

function loadOutbox() {
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); } catch { return []; }
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
    try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(arr)); } catch {}
  }
  return arr;
}
function saveOutbox() {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(_outbox)); } catch {}
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
    const log = JSON.parse(localStorage.getItem(FAILED_KEY) || '[]');
    log.push({ at: new Date().toISOString(), error: String(error || 'rejected'), op: msg?.op, payload: msg?.payload, mutationId: id, device: DEVICE_ID });
    localStorage.setItem(FAILED_KEY, JSON.stringify(log.slice(-200)));   // keep the last 200
  } catch {}
  if (i >= 0) { _outbox.splice(i, 1); saveOutbox(); }
  // Make a rejected write VISIBLE — it's recoverable in Settings → Data Recovery, not silently dropped.
  try { window.showToast?.('A change could not be saved — open Settings → Data Recovery.'); } catch (e) {}
}
export function failedOps() { try { return JSON.parse(localStorage.getItem(FAILED_KEY) || '[]'); } catch { return []; } }
export function outboxPending() { return _outbox.slice(); }
export function clearFailedOp(mutationId) {
  try {
    const log = JSON.parse(localStorage.getItem(FAILED_KEY) || '[]').filter(x => x.mutationId !== mutationId);
    localStorage.setItem(FAILED_KEY, JSON.stringify(log));
  } catch {}
}

// ── Lifecycle ───────────────────────────────────────────────────────────────
export function start() {
  loadCache();                                   // instant render from last snapshot
  connect();
  setTimeout(() => { if (!_connected) httpSnapshot(); }, 2500); // WS slow/blocked → HTTP hydrate
  // Re-establish + catch up the moment the device wakes or the network returns. An iPad that
  // slept or had a wifi blip otherwise keeps a dead socket and stops seeing other devices'
  // changes until a manual refresh — this is what makes updates appear without one.
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (!document.hidden) resync(); });
  if (typeof window !== 'undefined') { window.addEventListener('online', resync); window.addEventListener('focus', resync); }
}

// Force the connection healthy and pull a fresh snapshot to catch any broadcasts missed while
// the socket was dead/asleep. Throttled so visibility+focus firing together don't double-fetch.
export function resync() {
  if (_resyncTimer) return;
  _resyncTimer = setTimeout(() => { _resyncTimer = null; }, 1500);
  // On wake/focus, trust ONLY a genuinely OPEN socket. Anything else — including a zombie stuck
  // in CONNECTING from a frozen background tab — won't heal on its own, so tear it down and
  // reconnect now rather than waiting on a throttled reconnect timer (this was the "stays
  // disconnected until I refresh" bug after tabbing back in on desktop).
  if (!_ws || _ws.readyState !== WebSocket.OPEN) {
    if (_reconnect) { clearTimeout(_reconnect); _reconnect = null; }
    const old = _ws; _ws = null;                       // drop our ref first so old's late onclose no-ops
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
    setConnection(true, _outbox.length);
    send({ type: 'hello' });
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
  if (msg.type === 'snapshot') { hydrate({ state: msg.state, seq: msg.seq }); reapplyOutbox(); replayOutbox(); return; }
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

function replayOutbox() { for (const msg of _outbox) send(msg); } // DO dedupes by mutationId
// A fresh snapshot REPLACES local state — which would drop any optimistic write that the
// server hasn't confirmed yet (e.g. a just-now check-in), making it look like the customer
// vanished. Re-apply the still-pending outbox ops on top of the snapshot so in-flight writes
// survive; the server will dedupe them by mutationId when replayOutbox re-sends.
function reapplyOutbox() { for (const msg of _outbox) { try { applyChange(msg.op, msg.payload); } catch {} } }

// ── Public: dispatch a mutation (optimistic local apply + queued send) ──────────
// op: 'config.set' | 'queue.upsert' | 'queue.assignmentPatch' | 'queue.remove' | 'record.save'
//   | 'record.delete' | 'giftcard.save' | 'giftcard.delete' | 'audit.log' | 'chat.append'
//   | 'customer.upsert' | 'customer.delete' | 'customer.bulkUpsert' | 'customer.bulkDelete'
export function dispatch(op, payload) {
  const mutationId = DEVICE_ID + '-' + Date.now() + '-' + (++_mutCounter);
  // Stamp queue + record writes with a wall-clock version so the stale-write guard (store.js
  // applyChange + the DO) can reject a write that's OLDER than what's already saved — this is
  // what stops a lingering stale device copy from clobbering a good record (e.g. dropping a fee).
  if (op === 'queue.upsert' && payload && payload.entry)  { payload.entry.updatedAt  = Date.now(); payload.entry.updatedBy  = DEVICE_ID; }
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
  applyChange(op, payload);                                  // optimistic
  const msg = { type: 'mutate', op, payload, mutationId, device: DEVICE_ID };
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
  if (Date.now() - _lastAuthToast < 60000) return;
  _lastAuthToast = Date.now();
  try { window.showToast?.('Sign in needed — enter your PIN to reconnect this device.'); } catch {}
}

async function httpSnapshot() {
  try {
    const res = await fetch(STATE + '/snapshot', { cache: 'no-store' });
    if (res.status === 401) { notifyUnauthorized(); return; }
    if (!res.ok) return;
    hydrate(await res.json());
    reapplyOutbox();
    replayOutbox();
  } catch (e) { /* offline — the localStorage cache already rendered */ }
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
