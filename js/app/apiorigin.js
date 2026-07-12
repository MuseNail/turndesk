// ── Worker API origin (single source of truth) ───────────────────────────────
// Which Cloudflare Worker the client talks to. Imported by config.js (HTTP proxies),
// sync.js (WebSocket + /state) and apptoken.js (/auth/* + the bearer-fetch allow-list),
// so all three agree and there is ONE place to point at staging.
//
// Resolution order:
//   1. no browser (SSR/tests)                → production
//   2. a localhost / 127.0.0.1 page          → local `wrangler dev` on :8787
//   3. an ALLOWED ?api= override (sticky)     → that origin (staging or localhost)
//   4. otherwise                             → production
//
// SECURITY: the override is an EXACT-match allow-list — never a wildcard. A wildcard like
// `turndesk-staging.*.workers.dev` would let anyone who registers a same-named worker on THEIR
// account hand a real salon a `?api=` link that repoints its client at an attacker origin
// (session/data exfil). Only the two exact origins below are ever honored, and a disallowed
// value is neither used nor persisted.

export const PROD_ORIGIN    = 'https://turndesk.musenailandspa.workers.dev';
export const LOCAL_ORIGIN   = 'http://localhost:8787';
export const STAGING_ORIGIN = 'https://turndesk-staging.musenailandspa.workers.dev';

const OVERRIDE_ALLOWED = new Set([STAGING_ORIGIN, LOCAL_ORIGIN]);

export function apiOrigin() {
  if (typeof location === 'undefined') return PROD_ORIGIN;
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return LOCAL_ORIGIN;
  try {
    const q = new URLSearchParams(location.search).get('api');
    if (q && OVERRIDE_ALLOWED.has(q)) localStorage.setItem('td_api_origin', q);   // persist ONLY an allowed value
    const o = localStorage.getItem('td_api_origin') || '';
    if (OVERRIDE_ALLOWED.has(o)) return o;
  } catch {}
  return PROD_ORIGIN;
}

// Origins the §13 bearer-token fetch wrapper (apptoken.js) attaches Authorization to.
export const WORKER_ORIGINS = [PROD_ORIGIN, STAGING_ORIGIN, LOCAL_ORIGIN, 'http://127.0.0.1:8787'];
