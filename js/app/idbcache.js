// ── IndexedDB-backed device cache (per-salon) ────────────────────────────────
// The offline state mirror outgrew the ~5 MB localStorage cap, so the big blob moves
// to IndexedDB (hundreds of MB–GB). One store; everything async. Callers fall back to
// localStorage when IDB is unavailable (private mode / old engine).
//
// Writes are COALESCED behind a single in-flight transaction (latest value wins), so a
// burst of applyChange() produces ~one write and an older payload can NEVER land after a
// newer one — the out-of-order/stale-commit hazard of naive async writes.
//
// Multi-tenant note: store.js keys every call with scopedKey(CACHE_KEY) = "…:<salon-slug>",
// so each salon has its own row in the shared DB. The coalescer holds ONE key per session,
// which is safe because a salon switch RELOADS the page (fresh module state, auth.js) — there
// is never more than one active salon key per page load.
const DB_NAME = 'turndesk_cache', STORE = 'kv', VERSION = 1;
let _dbPromise = null;

function _open() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    let req;
    try { req = indexedDB.open(DB_NAME, VERSION); } catch (e) { done(reject, e); return; }
    req.onupgradeneeded = () => { try { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); } catch (e) {} };
    req.onsuccess = () => done(resolve, req.result);
    req.onerror = () => done(reject, req.error);
    req.onblocked = () => done(reject, new Error('idb blocked'));
    // iOS Safari can leave open() firing NEITHER success nor error (indefinite hang, e.g. after
    // bfcache restore). Time out so a wedged IDB rejects → callers fall back to localStorage and
    // the boot can NEVER hang on IndexedDB.
    setTimeout(() => done(reject, new Error('idb open timeout')), 3000);
  });
  _dbPromise.catch(() => { _dbPromise = null; });   // don't cache a rejected/timed-out open — allow a later retry
  return _dbPromise;
}

export function idbAvailable() { try { return typeof indexedDB !== 'undefined' && !!indexedDB; } catch (e) { return false; } }

export async function idbGet(key) {
  const db = await _open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const r = tx.objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result === undefined ? null : r.result);
    r.onerror = () => reject(r.error);
  });
}

// Coalesced single-writer — one scoped key per session by design (see the multi-tenant note).
// Overlapping calls collapse to the LATEST value, and EVERY caller (including a coalesced one)
// returns the SAME drain promise, so a caller whose write was coalesced still observes an eventual
// failure and can fall back to localStorage — no silently-lost final write, no out-of-order commit.
let _pending = null, _drainPromise = null;
export function idbSet(key, value) {
  _pending = { key, value };
  if (!_drainPromise) {
    _drainPromise = (async () => {
      try {
        while (_pending) {
          const { key: k, value: v } = _pending; _pending = null;
          const db = await _open();
          await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(v, k);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
          });
        }
      } finally { _drainPromise = null; }
    })();
  }
  return _drainPromise;
}

export async function idbDel(key) {
  const db = await _open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Best-effort: ask the browser to make storage persistent (not evictable under pressure /
// Safari ITP). Fire-and-forget; the grant is surfaced in Settings → Diagnostics.
export async function requestPersistence() {
  try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) return await navigator.storage.persist(); } catch (e) {}
  return false;
}
