// ── App session (§13 backend auth — PIN sign-in) ─────────────────────────────
// The Worker requires a session token on every route once its AUTH_ENFORCED
// secret is "true". A session is minted by POST /auth/login with a staff PIN —
// the same PIN people already type on the lock screens — so any device, any
// browser works with no provisioning. The session (token + who signed in +
// expiry, ~30 days) lives in localStorage per browser.
//
// Importing this module installs a fetch wrapper that adds
// `Authorization: Bearer <token>` to every request bound for the Worker, so
// feature code keeps calling fetch() plainly. Contexts that can't send headers
// (the WebSocket, the /gcal/connect navigation) append the token with withAuth().
// Import it FIRST in every entry point (main.js, staff.js, reports-app.js).

const KEY = 'turndesk_session';

// Same origin rule as sync.js: localhost page → local `wrangler dev`, else prod.
const PROD_ORIGIN = 'https://turndesk.musenailandspa.workers.dev';
const AUTH_ORIGIN = (typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname))
  ? 'http://localhost:8787'
  : PROD_ORIGIN;

function readSession() {
  try { return JSON.parse(localStorage.getItem(scopedKey(KEY)) || 'null'); } catch { return null; }
}

export function getAppToken() {
  const s = readSession();
  return (s && s.token) || '';
}
export function getSessionUser() {
  const s = readSession();
  return (s && s.user) || null;
}
export function clearSession() {
  try { localStorage.removeItem(scopedKey(KEY)); } catch {}
}

// ── Salon (tenant) slug ───────────────────────────────────────────────────────
// TurnDesk hosts many salons; each has its own Durable Object keyed by this slug.
// The slug arrives via the per-salon link (?salon=<slug>), is remembered per
// device, and rides on every Worker request: ?salon= on the WebSocket, the
// X-Salon header on HTTP. The Worker rejects any app request with no slug — there
// is no silent default, so a forgotten slug can never cross-wire to another salon.
const SALON_KEY = 'td_salon';
export function salonSlug() {
  try {
    const q = new URLSearchParams(location.search).get('salon');
    if (q) { try { localStorage.setItem(SALON_KEY, q); } catch {} return q; }
  } catch {}
  try { return localStorage.getItem(SALON_KEY) || ''; } catch { return ''; }
}

// The salon slug FROM THE URL ONLY (?salon=), ignoring the cached td_salon. The bare
// link (…/turndesk/ with no ?salon=) is the public front door: the sign-in screen uses
// THIS — not salonSlug() — to decide PIN-first vs "find your salon", so a device that once
// visited a salon link doesn't turn the front door into that salon's staff PIN pad.
export function urlSalonSlug() {
  try { return new URLSearchParams(location.search).get('salon') || ''; } catch { return ''; }
}

// ── Per-salon storage isolation ───────────────────────────────────────────────
// TurnDesk runs many salons on one origin, so the browser's localStorage is shared
// across all of them. Everything that holds a salon's DATA or LOGIN must be keyed by
// the salon slug, or a device used for one salon shows another's cached data + login
// on its link (the cross-salon bleed bug). scopedKey() is the one place that builds
// those keys. `:none` when no salon is known — a bucket that never collides with the
// old unscoped key, so migration can tell legacy data apart.
export function scopedKey(base) {
  return base + ':' + (salonSlug() || 'none');
}

// One-time migration off the old single (unscoped) keys. Runs at module load (before
// anything reads the scoped keys) and is idempotent — it removes the legacy keys, so a
// second run is a no-op. Data-safety rules: (1) the cached state + session are DELETED,
// never copied to the current salon's key — copying is exactly how one salon's data/token
// would bleed into another. No data lost: the server re-sends the snapshot and the user
// re-enters their PIN once. (2) Legacy pending outbox writes predate the salon stamp, so
// we can't prove which salon they belong to — they are NEVER auto-replayed (that could
// write one salon's change into another). They're preserved in that salon's Data Recovery
// for a deliberate look. (3) This waits until a salon is known so those items land in a
// bucket the owner will actually see; on a bare no-salon load it defers (the legacy keys
// are never auto-replayed anyway — loadOutbox reads the scoped key).
export function migrateLegacySalonStorage() {
  try {
    localStorage.removeItem('turndesk_state_cache');   // safe to drop — server re-syncs
    localStorage.removeItem('turndesk_session');        // safe to drop — re-PIN once
    // Device-local keys that became per-salon scoped (v0.30): a customer-directory PII cache, the
    // device turns-history snapshot, and the staff/reports "who's signed in here" ids. All are
    // caches/prefs the app rebuilds or re-asks for — drop the old UNSCOPED copies so one salon's
    // customers/history/identity can't linger under another salon's link. NEVER copy them into a
    // salon bucket (that is exactly how the cross-salon bleed happens). Safe to drop anytime, so
    // this runs unconditionally (no salon needed) — unlike the pending outbox below.
    localStorage.removeItem('turndesk_customers');       // customer directory PII cache (rebuilt from the synced store)
    localStorage.removeItem('turndesk_turns_history');   // device turns-history snapshot (synced turns state is authoritative)
    localStorage.removeItem('turndesk_staff_id');        // staff app: which tech signed in here
    localStorage.removeItem('turndesk_staff_fd_id');     // staff app: which front-desk user signed in here
    localStorage.removeItem('turndesk_reports_uid');     // reports app: which user signed in here
    if (!salonSlug()) return;                           // no salon yet → defer outbox/dead-letter
    let legacyFailed = [], legacyOutbox = [];
    try { legacyFailed = JSON.parse(localStorage.getItem('turndesk_failed_ops') || '[]'); } catch {}
    try { legacyOutbox = JSON.parse(localStorage.getItem('turndesk_outbox') || '[]'); } catch {}
    // audit.log ops are non-critical activity breadcrumbs (append-only, capped) with no recovery
    // value — dropping a few is explicitly fine. Never quarantine them, so a brand-new salon's
    // one-time upgrade across the scoping change doesn't show a scary "N failed" for pure log noise.
    const worthKeeping = m => m && m.op !== 'audit.log';
    legacyFailed = (Array.isArray(legacyFailed) ? legacyFailed : []).filter(worthKeeping);
    legacyOutbox = (Array.isArray(legacyOutbox) ? legacyOutbox : []).filter(worthKeeping);
    if ((legacyFailed.length || legacyOutbox.length)) {
      const quarantined = legacyOutbox.map(m => ({
        at: new Date().toISOString(),
        error: 'unattributed pre-scoping write — verify the salon before recovering',
        op: m && m.op, payload: m && m.payload, mutationId: m && m.mutationId, device: m && m.device,
      }));
      const k = scopedKey('turndesk_failed_ops');
      let cur = []; try { cur = JSON.parse(localStorage.getItem(k) || '[]'); } catch {}
      // No cap here: a one-time preserve must not drop a real un-synced write.
      localStorage.setItem(k, JSON.stringify([...cur, ...legacyFailed, ...quarantined]));
    }
    localStorage.removeItem('turndesk_failed_ops');
    localStorage.removeItem('turndesk_outbox');
  } catch {}
}
try { migrateLegacySalonStorage(); } catch {}

// ── Cross-salon login (no salon known yet — bare/general link) ────────────────
// The email/password could belong to any salon; the Worker's registry DO looks up
// which one and mints a session scoped to it. NEVER sends ?salon= — not knowing
// the salon is the whole reason this exists. On success this claims the slug for
// this device (same effect as visiting a ?salon= link) and stores the session
// exactly like serverLogin() does, so every existing session-reading code path —
// getAppToken(), the fetch wrapper, withAuth() — just works once the caller
// routes the device into that salon.
export async function serverFindLogin({ email, password } = {}) {
  try {
    const r = await fetch(AUTH_ORIGIN + '/auth/find-login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) return { ok: false, error: j.error || 'bad_credentials', retryInSec: j.retryInSec };
    try {
      localStorage.setItem(SALON_KEY, j.slug);   // claim the salon FIRST so scopedKey below buckets the session under it
      localStorage.setItem(scopedKey(KEY), JSON.stringify({ token: j.token, user: j.user, expires: j.expires }));
    } catch {}
    return { ok: true, slug: j.slug, user: j.user };
  } catch {
    return { ok: false, error: 'offline' };
  }
}

// PIN → server session. Returns { ok, user } on success; on failure
// { ok:false, error:'bad_pin'|'slow_down'|'offline', retryInSec? }. A 'bad_pin'
// with retryInSec means the next try has to wait (escalating slow-down).
// Staff sign in with a PIN; owners/managers with email + password. Either way the
// request is scoped to this device's salon slug. Returns { ok, user } on success.
export async function serverLogin({ pin, email, password, userId, kind, device } = {}) {
  const slug = salonSlug();
  if (!slug) return { ok: false, error: 'no_salon' };
  try {
    const body = {
      slug,
      ...(pin != null ? { pin } : {}),
      ...(email ? { email } : {}),
      ...(password != null ? { password } : {}),
      ...(userId ? { userId } : {}), ...(kind ? { kind } : {}), ...(device ? { device } : {}),
    };
    const r = await fetch(AUTH_ORIGIN + '/auth/login?salon=' + encodeURIComponent(slug), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: j.error || 'bad_pin', retryInSec: j.retryInSec };
    try { localStorage.setItem(scopedKey(KEY), JSON.stringify({ token: j.token, user: j.user, expires: j.expires })); } catch {}
    return { ok: true, user: j.user };
  } catch {
    return { ok: false, error: 'offline' };
  }
}

// ── Fetch wrapper: attach the session token to Worker-bound requests ──────────
// Covers prod and the local `wrangler dev` origin. Anything else passes through
// untouched. Defensive on purpose: a wrapper bug must never break fetch itself.
const WORKER_ORIGINS = [
  PROD_ORIGIN,
  'http://localhost:8787',
  'http://127.0.0.1:8787',
];

// Appends the token (?auth=) and salon (?salon=) for contexts that can't send
// headers — the WebSocket URL and the /gcal/connect navigation.
export function withAuth(url) {
  let out = url;
  const t = getAppToken();
  if (t) out += (out.includes('?') ? '&' : '?') + 'auth=' + encodeURIComponent(t);
  const slug = salonSlug();
  if (slug) out += (out.includes('?') ? '&' : '?') + 'salon=' + encodeURIComponent(slug);
  return out;
}

(function installFetchWrapper() {
  if (typeof window === 'undefined' || !window.fetch || window.fetch._museAuth) return;
  const origFetch = window.fetch.bind(window);
  const wrapped = (input, init) => {
    try {
      const u = typeof input === 'string' ? input : (input && input.url) || '';
      if (WORKER_ORIGINS.some(o => u.startsWith(o))) {
        init = { ...(init || {}) };
        const headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined));
        const token = getAppToken();
        if (token && !headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + token);
        const slug = salonSlug();
        if (slug && !headers.has('X-Salon')) headers.set('X-Salon', slug);
        init.headers = headers;
      }
    } catch {}
    return origFetch(input, init);
  };
  wrapped._museAuth = true;
  window.fetch = wrapped;
})();
