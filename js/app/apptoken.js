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

const KEY = 'muse_session';

// Same origin rule as sync.js: localhost page → local `wrangler dev`, else prod.
const PROD_ORIGIN = 'https://turndesk.musenailandspa.workers.dev';
const AUTH_ORIGIN = (typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname))
  ? 'http://localhost:8787'
  : PROD_ORIGIN;

function readSession() {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
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
  try { localStorage.removeItem(KEY); } catch {}
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
    try { localStorage.setItem(KEY, JSON.stringify({ token: j.token, user: j.user, expires: j.expires })); } catch {}
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
