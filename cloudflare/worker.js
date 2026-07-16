import { slugify, validateSignupRequest } from './signup-util.js';
import { validateDemoRequest } from './demo-util.js';
// ── Cloudflare Worker — musedashboard ─────────────────────────────────────────
//
// Routes
//   GET/POST/PUT /square/*  — CORS proxy → Square API
//   PUT      /photos/{key}  — Upload binary to R2, returns { url }
//   GET      /photos/{key}  — Serve object from R2 (used as <img src>)
//   DELETE   /photos/{key}  — Delete object from R2
//   /ws, /state/*           — Durable Object sync (source of truth)
//
// Backups: the Durable Object periodically snapshots full state to R2 (see alarm()).
//
// Required secrets (set via: wrangler secret put <NAME>)
//   SQUARE_TOKEN         Square access token
//   AUTH_ENFORCED        (§13 app auth) "true" = every route requires a session token from
//                        POST /auth/login (staff PIN → 30-day browser session; the SAME
//                        fd_users/staff PINs the app already uses — no provisioning).
//                        UNSET/other = auth off (migration mode; /auth/login still works so
//                        browsers collect sessions before the flip). Exempt when enforcing:
//                        OPTIONS, /auth/login|logout, /terminal/webhook (HMAC-verified),
//                        /gcal/callback (state-nonce checked), GET /photos/* (<img> loads
//                        can't send headers; photo writes ARE gated). Wrong-PIN attempts get
//                        escalating per-IP slow-downs (never a hard lockout). Rollback =
//                        delete the secret — instant, no redeploy.
//   RESTORE_TOKEN        (optional) gates /state/restore and /state/reset
//   ORIGIN_GATE_ENABLED  (optional) "true" turns on the Origin allow-list gate (default off)
//   ALLOWED_ORIGINS      (optional) extra comma-separated origins to allow (prod origin is built in)
//
// Optional environment variables (wrangler.toml [vars])
//   SQUARE_BASE_URL Defaults to https://connect.squareup.com
//
// Required R2 binding (wrangler.toml)
//   [[r2_buckets]]
//   binding     = "PHOTOS_BUCKET"
//   bucket_name = "musedashboard-photos"

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Salon',
  // Authorization on every request makes them non-simple → a CORS preflight each;
  // cache the preflight a day so the app isn't paying 2 round-trips per call.
  'Access-Control-Max-Age':       '86400',
};

function corsHeaders(extra = {}) {
  return new Headers({ ...CORS_HEADERS, ...extra });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json' }),
  });
}

// ── Helcim terminal webhook signature (Svix HMAC-SHA256) ────────────────────
// Verify by signing "<webhook-id>.<webhook-timestamp>.<rawBody>" with the base64-decoded
// verifier token; the base64 result must match one of the space-delimited "v1,<sig>" values
// in the webhook-signature header. (Helcim's webhooks use the Svix signing scheme.)
function _hcSafeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function verifyHelcimWebhook(request, rawBody, verifierToken) {
  if (!verifierToken) return false;
  const id = request.headers.get('webhook-id');
  const ts = request.headers.get('webhook-timestamp');
  const sigHeader = request.headers.get('webhook-signature') || '';
  if (!id || !ts || !sigHeader) return false;
  const secretB64 = verifierToken.startsWith('whsec_') ? verifierToken.slice(6) : verifierToken;
  let keyBytes;
  try { keyBytes = Uint8Array.from(atob(secretB64), c => c.charCodeAt(0)); } catch { return false; }
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${rawBody}`));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return sigHeader.split(' ').map(p => (p.includes(',') ? p.split(',')[1] : p)).some(p => _hcSafeEq(p, expected));
}

// Stale-write guard: true when the stored copy is strictly NEWER (by updatedAt) than an
// incoming write — so a lingering stale device copy can't clobber a good queue entry / record
// (the fee-drop root cause). Writes missing a timestamp on either side are never treated as stale.
function _isStaleWrite(prev, next) {
  return !!(prev && next && typeof prev.updatedAt === 'number' && typeof next.updatedAt === 'number' && prev.updatedAt > next.updatedAt);
}
// Recompute entry.status from its assignments + stamp statusSince on change (mirrors client
// status.js deriveEntryStatus/applyEntryStatus). Used after a per-assignment merge/patch.
function _deriveEntryStatus(entry) {
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
// Per-assignment field-merge for a whole-entry write: keep a STORED assignment whose own updatedAt
// is NEWER than the incoming one (so a whole-entry save can't revert a concurrent per-assignment
// change). Keep the stored one when it is stamped AND the incoming one is EITHER older OR unstamped:
// a forgotten front-desk modal re-saves the whole entry with the assignment's cost reverted to its
// stale form value and (before the field-diff fix) no fresh per-assignment updatedAt, so an
// unstamped incoming assignment must never beat a stamped stored one. Both-unstamped → incoming
// (legacy back-compat). Returns true if it merged.
function _mergeNewerAssignments(incoming, stored) {
  if (!stored || !Array.isArray(incoming.assignments) || !Array.isArray(stored.assignments)) return false;
  let merged = false;
  incoming.assignments = incoming.assignments.map(ia => {
    const sa = stored.assignments.find(x => x.serviceId === ia.serviceId && x.techId === ia.techId);
    if (sa && typeof sa.updatedAt === 'number' && (typeof ia.updatedAt !== 'number' || sa.updatedAt > ia.updatedAt)) { merged = true; return sa; }
    return ia;
  });
  return merged;
}

// Normalize a US phone to E.164 (+1XXXXXXXXXX) for httpSMS. Returns null if it isn't a
// usable 10/11-digit US number (so we never send to a malformed recipient).
function toE164(raw) {
  const s = String(raw || '').trim();
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  if (s.startsWith('+') && d.length >= 11 && d.length <= 15) return '+' + d;
  return null;
}

// ── Web Push (VAPID) helpers ────────────────────────────────────────────────────
// A VAPID JWT (ES256) authenticates every push. Pushes WITHOUT a payload show the
// service worker's generic text; pushes WITH a payload ({title, body, tag}) are
// aes128gcm-encrypted per RFC 8291 (encryptPushPayload below) so the staff app can
// show a specific message (e.g. "New appointment"). (Pure helpers exported for unit tests.)
export function b64urlFromBytes(bytes) {
  const b = new Uint8Array(bytes); let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlFromStr(str) { return b64urlFromBytes(new TextEncoder().encode(str)); }
export function vapidJwtUnsigned(aud, sub, expSec) {
  return b64urlFromStr(JSON.stringify({ typ: 'JWT', alg: 'ES256' })) + '.' +
         b64urlFromStr(JSON.stringify({ aud, exp: expSec, sub }));
}
async function vapidJwt(privJwkStr, aud, sub) {
  const key = await crypto.subtle.importKey('jwk', JSON.parse(privJwkStr), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const unsigned = vapidJwtUnsigned(aud, sub, Math.floor(Date.now() / 1000) + 12 * 3600);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  return unsigned + '.' + b64urlFromBytes(sig);   // WebCrypto ECDSA = raw r‖s, exactly what ES256 wants
}
async function pushKeyHash(endpoint) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(buf)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}
// RFC 8291 Web Push payload encryption (aes128gcm), WebCrypto only. `sub` is the stored
// PushSubscription JSON (endpoint + keys.p256dh/auth); returns the full encrypted body
// (header ‖ ciphertext) ready to POST with Content-Encoding: aes128gcm.
function b64urlToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
export async function encryptPushPayload(sub, payloadStr) {
  const enc = new TextEncoder();
  const uaPub = b64urlToBytes(sub.keys.p256dh);          // subscriber's P-256 point (65B uncompressed)
  const authSecret = b64urlToBytes(sub.keys.auth);       // subscriber's 16B auth secret
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));
  const hkdf = async (salt, ikmBytes, info, len) => {
    const key = await crypto.subtle.importKey('raw', ikmBytes, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
  };
  const keyInfo = new Uint8Array([...enc.encode('WebPush: info\0'), ...uaPub, ...asPub]);
  const ikm = await hkdf(authSecret, ecdh, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plain = new Uint8Array([...enc.encode(payloadStr), 2]);   // 0x02 = final-record delimiter
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plain));
  const header = new Uint8Array(16 + 4 + 1 + 65);                 // salt ‖ rs ‖ idlen ‖ as_public
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = 65;
  header.set(asPub, 21);
  const body = new Uint8Array(header.length + cipher.length);
  body.set(header, 0);
  body.set(cipher, header.length);
  return body;
}

// ── Origin gate (OFF by default; flip on live via the ORIGIN_GATE_ENABLED secret) ──
// When enabled, browser requests from a non-allowed Origin get 403. Requests with
// NO Origin header (server-to-server, <img> loads, curl, the cron) always pass —
// origin-gating only deters other websites, not non-browser clients (real fix =
// token auth, T2.12). Safe rollout: deploy with the gate OFF (this is a no-op),
// then `wrangler secret put ORIGIN_GATE_ENABLED` = "true" and immediately verify
// the app still syncs. Set it back to "false" (or delete it) to disable instantly
// — live, no redeploy — if anything can't connect.
function originAllowed(request, env) {
  if (String(env.ORIGIN_GATE_ENABLED || '').toLowerCase() !== 'true') return true; // gate off
  const origin = request.headers.get('Origin');
  if (!origin) return true; // non-browser / same-origin / image / cron
  const allow = new Set(
    ['https://musenail.github.io',
     ...String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)]
      .map(s => s.toLowerCase())
  );
  return allow.has(origin.toLowerCase());
}

// ── App auth (§13): PIN sign-in sessions, enforcing while AUTH_ENFORCED="true" ──
// Staff sign in from ANY device/browser with their existing PIN; POST /auth/login
// (handled by the DO) mints a 30-day session token the client then sends as
// `Authorization: Bearer <t>` (fetch wrapper in js/app/apptoken.js) or `?auth=<t>`
// where headers are impossible (the WebSocket, the /gcal/connect navigation).
// Validation round-trips to the DO's /auth/check with a short per-isolate cache —
// so deactivating/removing a user kills their sessions within ~a minute.
const _sessCache = new Map();   // token → { ok, exp }
const _regCache  = new Map();   // salonId → { disabled, exp }
// A salon explicitly marked status:'disabled' in the registry is locked out of
// EVERY route (incl. login). A salon with no registry entry (e.g. the demo, seeded
// directly) is treated as active. Cached ~60s; fails OPEN on a registry blip so a
// transient error never locks out a paying salon.
async function isSalonDisabled(env, salonId) {
  const hit = _regCache.get(salonId);
  if (hit && hit.exp > Date.now()) return hit.disabled;
  let disabled = false;
  try { const entry = await registryGet(env, salonId); disabled = !!(entry && entry.status === 'disabled'); }
  catch { disabled = false; }
  _regCache.set(salonId, { disabled, exp: Date.now() + 60000 });
  if (_regCache.size > 2000) _regCache.clear();
  return disabled;
}
let _authOffWarned = false;
async function appAuthOk(request, url, env, salonId) {
  if (String(env.AUTH_ENFORCED || '').toLowerCase() !== 'true') {
    // Loud once-per-isolate: auth-off means EVERY route is open with no session — the exact state
    // that exposed a customer directory when this flag was never set. Never a silent default.
    if (!_authOffWarned) { _authOffWarned = true; console.warn('[auth] SECURITY: AUTH_ENFORCED is not "true" — all routes are OPEN (no sign-in required). Set AUTH_ENFORCED="true" in production.'); }
    return true;
  }
  if (salonId && await isSalonDisabled(env, salonId)) return false;            // disabled salon → locked out everywhere
  const path = url.pathname;
  if (path === '/auth/login' || path === '/auth/logout') return true;          // the way IN
  if (path === '/auth/owner-set') return true;                  // setup/seed route — self-gated by RESTORE_TOKEN
  if (path === '/terminal/webhook') return true;                // Helcim → HMAC-verified instead
  if (path === '/r')                return true;                // public review-QR redirect (customers scan it)
  if (path === '/gcal/callback')    return true;                // Google redirect → state-nonce checked
  if (path.startsWith('/photos/') && request.method.toUpperCase() === 'GET') return true; // <img> src loads
  if (path === '/report' && request.method.toUpperCase() === 'POST') return true;         // client error reports must reach us even if auth itself is what broke (GET /report stays gated)
  if (path === '/signup/request' && request.method.toUpperCase() === 'POST') return true;  // public: pre-salon, no session yet
  if (path === '/demo/request' && request.method.toUpperCase() === 'POST') return true;  // public: demo lead form, pre-salon, no session yet
  if (path === '/auth/find-login' && request.method.toUpperCase() === 'POST') return true;  // public: cross-salon lookup, pre-salon
  const h = request.headers.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : (url.searchParams.get('auth') || '');
  if (!token) return false;
  // Cache key MUST include the salon: a token is only valid in the DO that minted
  // it, so a token validated for salon A must NOT short-circuit to "ok" for salon
  // B. Keying by token alone would leak cross-tenant within the cache window.
  const cacheKey = salonId + ' ' + token;
  const hit = _sessCache.get(cacheKey);
  if (hit && hit.exp > Date.now()) return hit.ok;
  let ok = false;
  try {
    const stub = env.SALON_DO.get(env.SALON_DO.idFromName(salonId));
    const r = await stub.fetch(new Request('https://do/auth/check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
    }));
    ok = r.ok && (await r.json()).ok === true;
  } catch { ok = false; }   // DO unreachable → fail closed; the client retries
  _sessCache.set(cacheKey, { ok, exp: Date.now() + (ok ? 60000 : 10000) });
  if (_sessCache.size > 2000) _sessCache.clear();
  return ok;
}

export default {
  async fetch(request, env) {
    // Top-level guard: any unhandled throw is logged (visible in Workers Logs /
    // `wrangler tail`) and returned as a clean CORS 500 instead of an opaque crash.
    try {
      return await this._handle(request, env);
    } catch (e) {
      let p = '?'; try { p = new URL(request.url).pathname; } catch {}
      console.error('[fetch] unhandled', request.method, p, '-', (e && e.message) || String(e));
      return json({ error: 'internal error' }, 500);
    }
  },

  async _handle(request, env) {
    const url     = new URL(request.url);
    const path    = url.pathname;
    const method  = request.method.toUpperCase();
    // Multi-salon: each salon gets its own DO instance, keyed by slug. The slug
    // rides on ?salon= (WebSocket) or the X-Salon header (HTTP). No default — a
    // missing slug is rejected below, so a client can never silently land in the
    // wrong (or an empty) salon.
    const salonId = (url.searchParams.get('salon') || request.headers.get('X-Salon') || '').trim();

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Origin gate (no-op unless ORIGIN_GATE_ENABLED = "true"). Covers /ws, /state,
    // /square, /photos, /backup — all share the same allow-list.
    if (!originAllowed(request, env)) return json({ error: 'forbidden origin' }, 403);

    // ── Operator console (cross-salon; self-gated by OPERATOR_TOKEN) ────────────
    // Provisioning + salon management. Not tied to any one salon, and exempt from
    // the salon guard + §13 app-auth below (it carries its own operator token).
    if (path.startsWith('/operator/')) return handleOperator(request, env, url, method, path);

    // Reserved slugs (incl. the '__registry__' DO) are never real salons — they're
    // blocked at salon creation — so a CLIENT request must never be allowed to
    // address one. Without this, X-Salon:'__registry__' would route ordinary routes
    // (login, backup-now, …) at the cross-salon registry DO, where the fresh-system
    // 1234 fallback (its config:fd_users is empty) could mint a registry admin
    // session and write into any salon's backup namespace. Operator routes are
    // handled above (their own token), so they're unaffected.
    if (salonId && RESERVED_SLUGS.has(salonId)) return json({ error: 'not found' }, 404);

    // Require an explicit salon slug on every route except the two inherently
    // salon-agnostic public callbacks. Replaces the old silent 'muse' default so
    // a forgotten slug fails loudly instead of cross-wiring to another salon.
    // GET /photos/* is exempt: an <img> loads it with no X-Salon header, so the
    // key itself carries the salon (photos are namespaced per salon client-side,
    // and are non-sensitive public branding). PUT/DELETE still require the slug.
    const _isPhotoGet = method === 'GET' && path.startsWith('/photos/');
    const _isFindLogin = path === '/auth/find-login' && method === 'POST';
    if (!salonId && !_isPhotoGet && !_isFindLogin && path !== '/terminal/webhook' && path !== '/gcal/callback' && path !== '/signup/request' && path !== '/demo/request') {
      return json({ error: 'missing salon' }, 400);
    }

    // App auth (§13): every route needs a PIN-login session once AUTH_ENFORCED is
    // "true" (exemptions documented on appAuthOk). Sits before all routing so a new
    // route added later is gated by default.
    if (!(await appAuthOk(request, url, env, salonId))) return json({ error: 'unauthorized' }, 401);

    // ── Review-QR redirect (public) ───────────────────────────────────────────
    // The printed receipt QR encodes …/r forever; this looks up the current
    // destination (config.review_url, editable in Settings) and 302-redirects.
    // Re-routable any time without reprinting — even already-printed receipts follow.
    if (path === '/r') {
      let dest = '';
      try {
        const stub = env.SALON_DO.get(env.SALON_DO.idFromName(salonId));
        const res  = await stub.fetch(new Request('https://do/review-target'));
        if (res.ok) dest = (await res.json()).url || '';
      } catch {}
      if (!dest) return new Response('This review link isn’t set up yet.', { status: 404, headers: { 'Content-Type': 'text/plain' } });
      if (!/^https?:\/\//i.test(dest)) dest = 'https://' + dest;   // tolerate a bare host pasted in Settings
      return Response.redirect(dest, 302);
    }

    // ── PIN sign-in (§13 sessions) — forwarded to the DO, which owns the PINs ──
    // Only login/logout are public; /auth/check is internal (the gate calls the
    // DO stub directly and it never appears here).
    if (path === '/auth/login' || path === '/auth/logout' || path === '/auth/owner-set') {
      if (method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const stub  = env.SALON_DO.get(env.SALON_DO.idFromName(salonId));
      const doRes = await stub.fetch(request);
      const body  = await doRes.text();
      return new Response(body, { status: doRes.status, headers: corsHeaders({ 'Content-Type': 'application/json' }) });
    }

    // ── R2 Photo Routes ───────────────────────────────────────────────────────
    if (path.startsWith('/photos/')) {
      const key = path.slice('/photos/'.length);
      if (!key) return json({ error: 'Missing photo key' }, 400);
      // This route shares ONE R2 bucket with the per-salon backups (backups/<slug>/...). GET /photos
      // is auth-exempt, so a readable backups/ key would leak a salon's FULL state — refuse the
      // backup namespace outright on every method (read, write, delete).
      if (key === 'backups' || key.startsWith('backups/')) return json({ error: 'not found' }, 404);
      // Writes/deletes are bound to the caller's authenticated salon. The client namespaces keys as
      // `<slug>/<name>` (features/photos.js _pkey), and salonId is guaranteed present for non-GET
      // /photos (the missing-salon guard above), so a write can only ever land under the caller's own
      // prefix. Without this, an authenticated user of salon A could overwrite/delete salon B's images.
      if ((method === 'PUT' || method === 'DELETE') && !key.startsWith(salonId + '/')) {
        return json({ error: 'forbidden' }, 403);
      }

      if (method === 'PUT') {
        const contentType = request.headers.get('Content-Type') || 'application/octet-stream';
        const body        = await request.arrayBuffer();
        await env.PHOTOS_BUCKET.put(key, body, {
          httpMetadata: { contentType },
        });
        const photoUrl = `${url.origin}/photos/${key}`;
        return json({ success: true, url: photoUrl });
      }

      if (method === 'GET') {
        const object = await env.PHOTOS_BUCKET.get(key);
        if (!object) return new Response('Not found', { status: 404, headers: corsHeaders() });
        const headers = corsHeaders({
          'Cache-Control': 'public, max-age=31536000, immutable',
          'ETag':          object.etag,
        });
        object.writeHttpMetadata(headers);
        return new Response(object.body, { headers });
      }

      if (method === 'DELETE') {
        await env.PHOTOS_BUCKET.delete(key);
        return json({ success: true });
      }

      return json({ error: 'Method not allowed' }, 405);
    }

    // ── WebSocket / Durable Object Route ─────────────────────────────────────
    if (path === '/ws') {
      const id   = env.SALON_DO.idFromName(salonId);
      const stub = env.SALON_DO.get(id);
      return stub.fetch(request);
    }

    // ── App State (Durable Object source of truth) ───────────────────────────
    // GET  /state/snapshot  → full state snapshot { state, seq, schemaVersion }
    // POST /state/mutate    → apply a mutation { op, payload, mutationId } → { applied, seq }
    // HTTP fallback for the new client; the DO also serves these over /ws.
    if (path.startsWith('/state/')) {
      const id    = env.SALON_DO.idFromName(salonId);
      const stub  = env.SALON_DO.get(id);
      const doRes = await stub.fetch(request);
      if (doRes.status >= 500) console.error('[state]', salonId, method, path, '->', doRes.status);
      // Re-wrap with CORS so cross-origin clients (GitHub Pages, local dev) are allowed.
      const body  = await doRes.text();
      return new Response(body, {
        status:  doRes.status,
        headers: corsHeaders({ 'Content-Type': 'application/json' }),
      });
    }

    // ── Web Push (Muse Staff notifications) ──────────────────────────────────────
    // POST /push/subscribe | /push/unsubscribe — register a tech's push subscription.
    // Forwarded to the DO (same pattern as /state), re-wrapped with CORS.
    if (path.startsWith('/push/')) {
      const stub  = env.SALON_DO.get(env.SALON_DO.idFromName(salonId));
      const doRes = await stub.fetch(request);
      const body  = await doRes.text();
      return new Response(body, { status: doRes.status, headers: corsHeaders({ 'Content-Type': 'application/json' }) });
    }

    // ── Automatic error reports (client crash/failure telemetry) ────────────────
    // POST /report submits an error (auth-exempt above, so a broken auth path can still
    // report); GET /report reads the log for the Diagnostics panel (auth-gated);
    // POST /report/clear empties it. Forwarded to the salon's DO like /state and /push.
    if (path === '/report' || path === '/report/clear') {
      const stub  = env.SALON_DO.get(env.SALON_DO.idFromName(salonId));
      const doRes = await stub.fetch(request);
      const body  = await doRes.text();
      return new Response(body, { status: doRes.status, headers: corsHeaders({ 'Content-Type': 'application/json' }) });
    }

    // ── Public self-serve signup request (approval-gated; nothing provisioned yet) ──
    // Forwarded to the reserved __registry__ DO, which validates + rate-limits + stores
    // the pending request. The forward is REBUILT clean (no X-Salon header, no ?salon=
    // query) so the registry DO's fetch() can't be tricked into _rememberSlug()-ing an
    // attacker-supplied slug into the registry's own meta:slug. CF-Connecting-IP is
    // carried through for the DO's per-IP rate limit.
    if (path === '/signup/request' && method === 'POST') {
      const r = await registryStub(env).fetch(await cleanRegistryRequest(request, '/signup/request'));
      const body = await r.text();
      return new Response(body, { status: r.status, headers: corsHeaders({ 'Content-Type': 'application/json' }) });
    }

    // ── Demo lead request (public, pre-salon) ───────────────────────────────────
    // Same clean-forward pattern as /signup/request: rebuild to IP-only, no salon
    // header, into the reserved registry DO. A demo request is a lead (no account),
    // stored as demo:<id> for the operator to follow up on personally.
    if (path === '/demo/request' && method === 'POST') {
      const r = await registryStub(env).fetch(await cleanRegistryRequest(request, '/demo/request'));
      const body = await r.text();
      return new Response(body, { status: r.status, headers: corsHeaders({ 'Content-Type': 'application/json' }) });
    }

    // ── Cross-salon email login (adaptive sign-in, Part B) ──────────────────────
    // Salon-agnostic: the ONE login route that doesn't require ?salon=/X-Salon.
    // Forwarded (rebuilt clean, same reasoning as /signup/request) to the reserved
    // registry DO, which looks up the owner's salon(s) by email and tries the
    // password against each salon's own PBKDF2 hash.
    if (path === '/auth/find-login' && method === 'POST') {
      const r = await registryStub(env).fetch(await cleanRegistryRequest(request, '/auth/find-login'));
      const body = await r.text();
      return new Response(body, { status: r.status, headers: corsHeaders({ 'Content-Type': 'application/json' }) });
    }

    // ── AI analytics (Anthropic Claude, or Google Gemini fallback) ──────────────
    // POST /ai/ask { question, data } → an LLM. Keys are held server-side as secrets
    // so they never ship in the public PWA. Prefers Claude when ANTHROPIC_API_KEY is
    // set, else falls back to Gemini.
    //   Owner setup (Claude):  `wrangler secret put ANTHROPIC_API_KEY`  (console.anthropic.com)
    //   Owner setup (Gemini):  `wrangler secret put GEMINI_API_KEY`     (aistudio.google.com)
    if (path === '/ai/ask' && method === 'POST') {
      if (!env.ANTHROPIC_API_KEY && !env.GEMINI_API_KEY) return json({ error: 'AI not configured' }, 503);
      let body = {}; try { body = await request.json(); } catch {}
      const question = String(body.question || '').slice(0, 2000);
      const data     = String(body.data || '').slice(0, 24000);
      if (!question) return json({ error: 'No question' }, 400);
      const sys = `You are a concise analytics assistant for a nail salon. Answer the owner's question using ONLY the data provided. Give specific numbers, be brief, and say if the data can't answer it.`;
      if (env.ANTHROPIC_API_KEY) {
        const model = env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
        try {
          const aRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model, max_tokens: 1024, system: sys, messages: [{ role: 'user', content: `DATA:\n${data}\n\nQUESTION: ${question}` }] }),
          });
          const aJson = await aRes.json();
          if (!aRes.ok) { console.warn('[ai]', aRes.status); return json({ error: aJson.error?.message || 'AI request failed' }, aRes.status); }
          const answer = (aJson.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
          return json({ answer: answer || 'No answer returned.' });
        } catch (e) { return json({ error: 'AI service unreachable' }, 502); }
      }
      const model = env.GEMINI_MODEL || 'gemini-2.0-flash';
      const prompt = `${sys}\n\nDATA:\n${data}\n\nQUESTION: ${question}`;
      try {
        const gRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        });
        const gJson = await gRes.json();
        if (!gRes.ok) { console.warn('[ai]', gRes.status); return json({ error: gJson.error?.message || 'AI request failed' }, gRes.status); }
        const answer = (gJson.candidates?.[0]?.content?.parts || []).map(p => p.text).join('').trim();
        return json({ answer: answer || 'No answer returned.' });
      } catch (e) { return json({ error: 'AI service unreachable' }, 502); }
    }

    // ── SMS via httpSMS (Android phone gateway) ─────────────────────────────────
    // The shop's Android phone runs the httpSMS app; texts are sent through it via the
    // httpSMS cloud API. Secrets (owner: `wrangler secret put …`, never shipped in the PWA):
    //   HTTPSMS_API_KEY  — from httpsms.com/settings
    //   HTTPSMS_FROM     — the phone's number, +1XXXXXXXXXX (the "from" on every text)
    if (path === '/sms/status' && method === 'GET') {
      return json({ configured: !!(env.HTTPSMS_API_KEY && env.HTTPSMS_FROM), from: env.HTTPSMS_FROM || null });
    }
    if (path === '/sms/send' && method === 'POST') {
      if (!env.HTTPSMS_API_KEY || !env.HTTPSMS_FROM) return json({ error: 'SMS not configured' }, 503);
      let body = {}; try { body = await request.json(); } catch {}
      const to = toE164(body.to);
      const content = String(body.content || '').replace(/\s+$/,'').slice(0, 1000).trim();
      if (!to) return json({ error: 'Invalid recipient number' }, 400);
      if (!content) return json({ error: 'Empty message' }, 400);
      try {
        const r = await fetch('https://api.httpsms.com/v1/messages/send', {
          method: 'POST',
          headers: { 'x-api-key': env.HTTPSMS_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: env.HTTPSMS_FROM, to, content }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { console.warn('[sms]', r.status, j?.message || ''); return json({ error: j?.message || 'Send failed', status: r.status }, r.status); }
        return json({ sent: true, to, id: j?.data?.id || null });
      } catch (e) { return json({ error: 'SMS service unreachable' }, 502); }
    }
    // Delivery status for a sent message. httpSMS ACCEPTS a message immediately (the /send
    // response only means "queued to the phone"); the actual SMS can still FAIL on the phone
    // afterwards (e.g. Samsung "generic failure"). This lets the dashboard show the real
    // phone-side outcome (status + failure reason) instead of guessing it succeeded.
    if (path.startsWith('/sms/message/') && method === 'GET') {
      if (!env.HTTPSMS_API_KEY) return json({ error: 'SMS not configured' }, 503);
      const id = decodeURIComponent(path.slice('/sms/message/'.length));
      if (!id) return json({ error: 'Missing message id' }, 400);
      try {
        const r = await fetch('https://api.httpsms.com/v1/messages/' + encodeURIComponent(id), {
          headers: { 'x-api-key': env.HTTPSMS_API_KEY },
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: j?.message || 'Lookup failed', status: r.status }, r.status);
        const d = j?.data || {};
        return json({ id: d.id || id, status: d.status || 'unknown', failureReason: d.failure_reason || d.failed_reason || null, sendAttemptCount: d.send_attempt_count ?? null });
      } catch (e) { return json({ error: 'SMS service unreachable' }, 502); }
    }

    // ── Google Calendar OAuth (server-side refresh-token flow) ──────────────────
    // Fixes "calendar loses sync on iPad": the browser GIS token flow can't silently
    // renew under Safari ITP / a standalone PWA / the pay-deep-link bounce into Chrome.
    // Here the Worker holds the salon's Google REFRESH token (DO storage key 'gcal:blob',
    // NOT part of buildSnapshot → never sent to clients) and mints short-lived access
    // tokens on demand, so any browser context just calls /gcal/token. Owner setup:
    //   wrangler secret put GCAL_CLIENT_SECRET   (the OAuth client's secret)
    //   + add  <worker>/gcal/callback  as an Authorized redirect URI on that OAuth client.
    // GCAL_CLIENT_ID is a [vars] entry (defaults below). Auth: rides the same origin gate
    // as everything else (proper token auth comes with the §13 backend-auth pass).
    if (path.startsWith('/gcal/')) {
      const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
      const clientId = env.GCAL_CLIENT_ID || '174518644579-5vgt7vvllm2ekpk0gb8l4sa4f3va9r9l.apps.googleusercontent.com';
      const scopes   = env.GCAL_SCOPES || 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/tasks';
      const redirect = url.origin + '/gcal/callback';
      const stub = env.SALON_DO.get(env.SALON_DO.idFromName(salonId));
      const readBlob  = async () => { try { const r = await stub.fetch('https://do/gcal/blob'); return r.ok ? await r.json() : {}; } catch { return {}; } };
      const writeBlob = async (b) => { await stub.fetch('https://do/gcal/blob', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); };
      const htmlMsg = (m, status = 200) => new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;padding:2rem;text-align:center;color:#0f3d3d">${m}</body>`, { status, headers: { 'Content-Type': 'text/html' } });

      // One-time consent (authorization-code flow, offline access → refresh token).
      if (path === '/gcal/connect') {
        if (!env.GCAL_CLIENT_SECRET) return json({ error: 'GCAL_CLIENT_SECRET not set on the Worker' }, 503);
        const state = salonId + ':' + crypto.randomUUID();   // carry the salon through OAuth (the fixed callback URI has no ?salon=)
        const blob = await readBlob();
        blob.pending = { state, return: url.searchParams.get('return') || '', ts: Date.now() };
        await writeBlob(blob);
        const auth = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
          client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: scopes,
          access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
        }).toString();
        return Response.redirect(auth, 302);
      }

      // Google redirects back with ?code&state — exchange for tokens, store the refresh token.
      if (path === '/gcal/callback') {
        const code = url.searchParams.get('code'), state = url.searchParams.get('state') || '';
        // The callback carries no ?salon= (Google redirects to a fixed URI), so recover the salon from
        // the state minted in /gcal/connect (`<salon>:<nonce>`) and read/write THAT salon's blob — not
        // the empty-slug DO the top-level salonId ('') would otherwise resolve to. (Was: connect always failed.)
        const cbSalon = state.split(':')[0];
        const cbStub = cbSalon ? env.SALON_DO.get(env.SALON_DO.idFromName(cbSalon)) : stub;
        const cbRead  = async () => { try { const r = await cbStub.fetch('https://do/gcal/blob'); return r.ok ? await r.json() : {}; } catch { return {}; } };
        const cbWrite = async (b) => { await cbStub.fetch('https://do/gcal/blob', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); };
        const blob = await cbRead(), pending = blob.pending;
        const okState = pending && pending.state && pending.state === state && (Date.now() - pending.ts) < 10 * 60 * 1000;
        if (!code || !okState) return htmlMsg('Calendar connect failed (expired or invalid). Close this and tap Connect again.', 400);
        const r = await fetch(GOOGLE_TOKEN_URI, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ code, client_id: clientId, client_secret: env.GCAL_CLIENT_SECRET, redirect_uri: redirect, grant_type: 'authorization_code' }).toString() });
        const tok = await r.json().catch(() => ({}));
        if (!r.ok || !tok.refresh_token) { console.warn('[gcal] code exchange failed', r.status, tok.error); return htmlMsg('Calendar connect failed (' + (tok.error || r.status) + '). Close this and tap Connect again — be sure to tap "Allow".', 400); }
        const ret = pending.return;
        await cbWrite({ refresh: tok.refresh_token, access: { token: tok.access_token, expires: Date.now() + (tok.expires_in || 3600) * 1000 } });
        if (ret) return Response.redirect(ret + (ret.includes('?') ? '&' : '?') + 'gcal=connected', 302);
        return htmlMsg('✓ Google Calendar connected. You can close this window.<script>try{window.opener&&window.opener.postMessage("gcal-connected","*")}catch(e){};setTimeout(function(){window.close&&window.close()},800)<\/script>');
      }

      // Mint/return a fresh access token from the stored refresh token (cached until ~5 min before expiry).
      if (path === '/gcal/token') {
        const blob = await readBlob();
        if (blob.access?.token && Date.now() < blob.access.expires - 5 * 60 * 1000) return json({ access_token: blob.access.token, expires: blob.access.expires });
        if (!blob.refresh) return json({ error: 'not_connected' }, 401);
        if (!env.GCAL_CLIENT_SECRET) return json({ error: 'GCAL_CLIENT_SECRET not set on the Worker' }, 503);
        const r = await fetch(GOOGLE_TOKEN_URI, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ refresh_token: blob.refresh, client_id: clientId, client_secret: env.GCAL_CLIENT_SECRET, grant_type: 'refresh_token' }).toString() });
        const tok = await r.json().catch(() => ({}));
        if (!r.ok || !tok.access_token) {
          console.warn('[gcal] refresh failed', r.status, tok.error);
          if (tok.error === 'invalid_grant') { await writeBlob({}); return json({ error: 'reauth_required' }, 401); }   // refresh revoked/expired → reconnect needed
          return json({ error: tok.error || 'refresh_failed' }, 502);
        }
        const access = { token: tok.access_token, expires: Date.now() + (tok.expires_in || 3600) * 1000 };
        await writeBlob({ refresh: blob.refresh, access });
        return json({ access_token: access.token, expires: access.expires });
      }

      // Has a refresh token been stored? (no token returned)
      if (path === '/gcal/status') { const blob = await readBlob(); return json({ connected: !!blob.refresh }); }

      // Disconnect: revoke at Google + clear the stored tokens.
      if (path === '/gcal/disconnect' && method === 'POST') {
        const blob = await readBlob();
        if (blob.refresh) { try { await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(blob.refresh), { method: 'POST' }); } catch {} }
        await writeBlob({});
        return json({ ok: true });
      }

      return json({ error: 'Not found' }, 404);
    }

    // ── SaaS billing (Phase 1) ───────────────────────────────────────────────────
    // /bdo/* are the registry DO's INTERNAL billing-storage routes — never public.
    // (A client addressing its own salon DO there would only write keys the Worker
    // never reads from a salon instance, but 404 them outright anyway.)
    if (path.startsWith('/bdo/')) return json({ error: 'not found' }, 404);
    // Salon-facing billing (Settings → Billing). Self-gated stricter than appAuthOk:
    // owner/admin session required unconditionally; appadmin denied. Nothing here
    // enforces access — flags default off and only the operator can flip them.
    if (path.startsWith('/billing/')) return handleBilling(request, env, url, method, path, salonId);

    // ── Helcim (Payment Hardware API — Smart Terminal) ───────────────────────────
    // The api-token stays server-side (HELCIM_API_TOKEN secret), same as the Square proxy.
    // /helcim/ping       GET  → list paired terminals (confirm token + device code)
    // /helcim/purchase   POST → start a card purchase on the terminal { deviceCode, amount(dollars), invoiceNumber }
    // /helcim/result     GET  → ?invoiceNumber= → look up the card transaction(s) (poll / reconcile / fallback)
    // /terminal/webhook  POST → Helcim pushes the result here (HMAC-verified; NOT origin-gated — Helcim isn't a browser)
    if (path === '/helcim/ping' && method === 'GET') {
      const r = await fetch('https://api.helcim.com/v2/devices/?limit=25', { headers: { 'api-token': env.HELCIM_API_TOKEN, 'accept': 'application/json' } });
      const body = await r.text();
      if (r.status >= 400) console.error('[helcim ping]', r.status, body.slice(0, 200));
      return new Response(body, { status: r.status, headers: corsHeaders({ 'Content-Type': 'application/json' }) });
    }
    if (path === '/helcim/purchase' && method === 'POST') {
      let b = {}; try { b = await request.json(); } catch {}
      const deviceCode    = String(b.deviceCode || '').trim();
      const amount        = Number(b.amount);                 // DOLLARS — Helcim expects dollars, not cents
      const invoiceNumber = String(b.invoiceNumber || '').trim();
      if (!deviceCode)        return json({ error: 'deviceCode required' }, 400);
      if (!(amount > 0))      return json({ error: 'amount (dollars) must be > 0' }, 400);
      if (!invoiceNumber)     return json({ error: 'invoiceNumber required' }, 400);
      const r = await fetch(`https://api.helcim.com/v2/devices/${encodeURIComponent(deviceCode)}/payment/purchase`, {
        method:  'POST',
        headers: { 'api-token': env.HELCIM_API_TOKEN, 'Content-Type': 'application/json', 'accept': 'application/json' },
        body:    JSON.stringify({ currency: 'USD', transactionAmount: amount, invoiceNumber, ...(b.customerCode ? { customerCode: String(b.customerCode) } : {}) }),
      });
      const body = await r.text();
      if (r.status >= 400) console.error('[helcim purchase]', salonId, r.status, body.slice(0, 300));
      return new Response(body, { status: r.status, headers: corsHeaders({ 'Content-Type': 'application/json' }) });
    }
    if (path === '/helcim/result' && method === 'GET') {
      const inv = url.searchParams.get('invoiceNumber') || '';
      if (!inv) return json({ error: 'invoiceNumber required' }, 400);
      const r = await fetch(`https://api.helcim.com/v2/card-transactions?invoiceNumber=${encodeURIComponent(inv)}`, { headers: { 'api-token': env.HELCIM_API_TOKEN, 'accept': 'application/json' } });
      const body = await r.text();
      if (r.status >= 400) console.error('[helcim result]', salonId, r.status, body.slice(0, 200));
      return new Response(body, { status: r.status, headers: corsHeaders({ 'Content-Type': 'application/json' }) });
    }
    // Reconcile: list card transactions for a date range (Mountain Time per Helcim). Match to records.
    if (path === '/helcim/transactions' && method === 'GET') {
      const qs = new URLSearchParams({ limit: '1000' });
      if (url.searchParams.get('dateFrom')) qs.set('dateFrom', url.searchParams.get('dateFrom'));
      if (url.searchParams.get('dateTo'))   qs.set('dateTo',   url.searchParams.get('dateTo'));
      const r = await fetch(`https://api.helcim.com/v2/card-transactions?${qs}`, { headers: { 'api-token': env.HELCIM_API_TOKEN, 'accept': 'application/json' } });
      const body = await r.text();
      if (r.status >= 400) console.error('[helcim transactions]', r.status, body.slice(0, 200));
      return new Response(body, { status: r.status, headers: corsHeaders({ 'Content-Type': 'application/json' }) });
    }
    // Upsert a Helcim customer (by phone) so its contact rides the next purchase → the terminal can
    // text/email the receipt. Returns { customerCode }. Best-effort; the client never blocks a charge on it.
    if (path === '/helcim/customer' && method === 'POST') {
      let b = {}; try { b = await request.json(); } catch {}
      const name = String(b.name || '').trim(), digits = String(b.phone || '').replace(/\D/g, '');
      if (!name && !digits) return json({ error: 'name or phone required' }, 400);
      // Helcim's field is cellPhone (capital P) and their search does PARTIAL STRING matching on the
      // stored phone — so always store and search the same dashed XXX-XXX-XXXX format. (v4.72 sent
      // lowercase `cellphone`, which Helcim ignored: no phone on the customer, search never matched,
      // and every charge minted a duplicate customer.)
      const phone = digits.length === 10 ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` : digits;
      const hh = { 'api-token': env.HELCIM_API_TOKEN, 'accept': 'application/json' };
      let customerCode = null;
      try {
        if (phone) {
          const sr = await fetch(`https://api.helcim.com/v2/customers?search=${encodeURIComponent(phone)}&limit=25`, { headers: hh });
          const sj = await sr.json().catch(() => ({}));
          const list = Array.isArray(sj) ? sj : (Array.isArray(sj.customers) ? sj.customers : (Array.isArray(sj.data) ? sj.data : []));
          const match = list.find(c => String(c.cellPhone || c.cellphone || c.phone || '').replace(/\D/g, '') === digits);
          if (match) {
            customerCode = match.customerCode || null;
            // The terminal's text-receipt prefill reads cellPhone specifically. An older contact may
            // carry the number only in `phone` (or an unset cellPhone) — backfill it so the next charge
            // prefills the SMS field. Best-effort PUT (keep contactName so a replace-style update can't
            // wipe the name); never blocks the charge. Verify against a live terminal.
            const matchCell = String(match.cellPhone || '').replace(/\D/g, '');
            if (phone && matchCell !== digits && match.id != null) {
              try {
                await fetch(`https://api.helcim.com/v2/customers/${encodeURIComponent(match.id)}`, {
                  method: 'PUT', headers: { ...hh, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ contactName: match.contactName || name || phone, cellPhone: phone }),
                });
              } catch {}
            }
          }
        }
      } catch {}
      if (!customerCode) {
        const cr = await fetch('https://api.helcim.com/v2/customers', { method: 'POST', headers: { ...hh, 'Content-Type': 'application/json' }, body: JSON.stringify({ contactName: name || phone, ...(phone ? { cellPhone: phone } : {}) }) });
        const cj = await cr.json().catch(() => ({}));
        customerCode = cj.customerCode || (cj.customer && cj.customer.customerCode) || null;
        if (!customerCode) console.error('[helcim customer]', cr.status, JSON.stringify(cj).slice(0, 200));
      }
      return json({ customerCode });
    }
    // Refund a Helcim card sale back to the card. Verified API (HELCIM-MIGRATION.md):
    //   POST /v2/payment/refund { originalTransactionId, amount(DOLLARS), ipAddress } + an
    //   `idempotency-key` header (required, 25–36 chars). Partial refunds are supported.
    // originalTransactionId = the Helcim transactionId stored on the record (squarePaymentIds[0]).
    // The client sends a DETERMINISTIC idempotencyKey tied to (sale, txn, cents) so a retry after a
    // timeout returns the SAME refund instead of issuing a second one — the core double-refund guard.
    if (path === '/helcim/refund' && method === 'POST') {
      let b = {}; try { b = await request.json(); } catch {}
      const originalTransactionId = parseInt(b.originalTransactionId, 10);
      const amount = Number(b.amount);                       // DOLLARS, like the purchase endpoint
      if (!Number.isInteger(originalTransactionId) || originalTransactionId <= 0) return json({ error: 'originalTransactionId required' }, 400);
      if (!(amount > 0)) return json({ error: 'amount (dollars) must be > 0' }, 400);
      const ip = request.headers.get('CF-Connecting-IP') || '127.0.0.1';   // ipAddress is required by Helcim
      const safe = String(b.idempotencyKey || (originalTransactionId + '-' + Math.round(amount * 100))).replace(/[^a-zA-Z0-9_-]/g, '');
      const idem = ('rf-' + safe + '-0000000000000000000000000000000000').slice(0, 32);   // normalize to Helcim's 25–36 char window
      const r = await fetch('https://api.helcim.com/v2/payment/refund', {
        method:  'POST',
        headers: { 'api-token': env.HELCIM_API_TOKEN, 'accept': 'application/json', 'Content-Type': 'application/json', 'idempotency-key': idem },
        body:    JSON.stringify({ originalTransactionId, amount, ipAddress: ip }),
      });
      const text = await r.text();
      let j = {}; try { j = JSON.parse(text); } catch {}
      if (r.status >= 400) {
        console.error('[helcim refund]', salonId, r.status, text.slice(0, 400));
        const msg = (j.errors ? JSON.stringify(j.errors) : (j.message || j.error)) || `Helcim refund error ${r.status}`;
        return json({ error: String(msg).slice(0, 300) }, r.status >= 500 ? 502 : 400);
      }
      return json({ ok: true, transactionId: j.transactionId || null, status: j.status || '', amount: (j.amount ?? amount) });
    }
    if (path === '/terminal/webhook' && method === 'POST') {
      const raw = await request.text();
      const ok  = await verifyHelcimWebhook(request, raw, env.HELCIM_WEBHOOK_VERIFIER);
      if (!ok) { console.error('[terminal webhook] signature verify FAILED'); return new Response('bad signature', { status: 401 }); }
      let evt = {}; try { evt = JSON.parse(raw); } catch {}
      console.log('[terminal webhook] verified:', JSON.stringify(evt).slice(0, 400));
      // The cardTransaction payload is just { id, type } — fetch the full txn to get the
      // invoiceNumber/status/amount, then push the result to the connected app(s) via the DO
      // (broadcast over the same WebSocket the app already holds). terminalCancel carries the
      // invoiceNumber directly (customer cancelled on the device → un-stage the charge).
      try {
        let fin = null;
        if (evt.type === 'cardTransaction' && evt.id != null) {
          const tr = await fetch(`https://api.helcim.com/v2/card-transactions/${encodeURIComponent(evt.id)}`, { headers: { 'api-token': env.HELCIM_API_TOKEN, 'accept': 'application/json' } });
          let txn = null; try { txn = JSON.parse(await tr.text()); } catch {}
          if (txn && Array.isArray(txn.value)) txn = txn.value[0];
          if (txn) fin = { invoiceNumber: txn.invoiceNumber || '', status: txn.status || '', transactionId: txn.transactionId || evt.id, amount: (txn.amount ?? null), type: 'cardTransaction' };
        } else if (evt.type === 'terminalCancel') {
          const d = evt.data || {};
          fin = { invoiceNumber: d.invoiceNumber || '', status: 'CANCELLED', transactionId: null, amount: (d.transactionAmount ?? null), type: 'terminalCancel' };
        }
        if (fin && fin.invoiceNumber) {
          const stub = env.SALON_DO.get(env.SALON_DO.idFromName(salonId));
          await stub.fetch(new Request('https://do/helcim/finalize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fin) }));
        } else {
          console.warn('[terminal webhook] no invoiceNumber to finalize', evt.type);
        }
      } catch (e) { console.error('[terminal webhook] finalize error', (e && e.message) || String(e)); }
      return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // ── Square Proxy ──────────────────────────────────────────────────────────
    if (path.startsWith('/square')) {
      const squareBase = env.SQUARE_BASE_URL || 'https://connect.squareup.com';
      const squarePath = path.replace(/^\/square/, '') || '/';
      const squareUrl  = squareBase + squarePath + (url.search || '');

      const headers = new Headers(request.headers);
      headers.set('Authorization',  `Bearer ${env.SQUARE_TOKEN}`);
      headers.set('Square-Version', '2024-11-20');
      headers.set('Content-Type',   'application/json');
      // Strip browser-context headers so Square sees a clean server-to-server call.
      // Forwarding Origin/Referer causes Square to reject certain endpoints (e.g. catalog)
      // with "invalid cross-origin request".
      headers.delete('host');
      headers.delete('origin');
      headers.delete('referer');

      const hasBody = method !== 'GET' && method !== 'HEAD';
      const upstream = await fetch(squareUrl, {
        method,
        headers,
        body: hasBody ? await request.arrayBuffer() : undefined,
      });

      // Log non-2xx Square responses by status + path only (never bodies/headers —
      // they carry tokens + customer PII) so API failures are diagnosable.
      if (upstream.status >= 400) console.warn('[square]', method, squarePath, '->', upstream.status);
      const body = await upstream.arrayBuffer();
      return new Response(body, {
        status:  upstream.status,
        headers: corsHeaders({
          'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
        }),
      });
    }

    return json({ error: 'Not found' }, 404);
  },
};

// ── Durable Object — Single Source of Truth ─────────────────────────────────────
// One instance per salon (keyed by idFromName(salonId), default 'muse'). Holds canonical app state
// in SQLite-backed DO storage (state.storage.*). Single writer ⇒ atomic per-key
// writes, no blob overwrite, no conflict guards. Clients hydrate via `snapshot`
// and mutate via typed `mutate` messages; changes broadcast to all peers.
//
// Storage key layout:
//   config:<field>   one key per config field (staff, services, turns_order, …)
//   queue:<id>       live queue entries
//   record:<id>      transaction records
//   giftcard:<id>    gift cards
//   deletion:<id>    soft-delete markers
//   mut:<mutationId> idempotency markers (value = seq); pruned in alarm()
//   meta:seq         monotonic change counter
//
// Wire protocol (over /ws, JSON):
//   client→DO: {type:'hello'} | {type:'mutate',op,payload,mutationId,device} | {type:'ping'}
//   DO→client: {type:'snapshot',state,seq} | {type:'applied',mutationId,seq}
//              | {type:'change',op,payload,seq,device} | {type:'pong'}
// HTTP fallback: GET /state/snapshot, POST /state/mutate.
//
// During the v2.00 transition the DO ALSO relays any legacy message verbatim
// (the current production client sends {type:'queue'|'config'}), so the live app
// keeps working until the new client cuts over. Remove the legacy relay after cutover.

// ── Password hashing (owner/manager sign-in) — PBKDF2-SHA256 via WebCrypto ─────
// No deps, no build step. Stored as { salt, hash, iters } (base64); plaintext is
// never persisted or returned. Failed-login slow-down lives in authLogin.
const PBKDF2_ITERS = 100000;
function _b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function _unb64(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
async function hashPassword(password, saltB64, iters = PBKDF2_ITERS) {
  const salt = saltB64 ? _unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key  = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' }, key, 256);
  return { salt: _b64(salt), hash: _b64(bits), iters };
}
// Constant-time string compare — no early exit on the first differing char, so a secret check
// can't leak the secret's contents through response timing. Used for the operator/admin/restore
// secret checks and the PBKDF2 hash compare below. (Length equality is not itself sensitive here.)
export function safeEqual(a, b) {
  a = String(a == null ? '' : a); b = String(b == null ? '' : b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function verifyPassword(password, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const { hash } = await hashPassword(password, rec.salt, rec.iters || PBKDF2_ITERS);
  return safeEqual(hash, rec.hash);
}
// A fixed, never-matching credential used ONLY to normalize find-login timing when an
// email maps to no salon (see TurnDeskDO.findLogin). The salt is valid base64 so the
// PBKDF2 path runs the same work as a real verify; the result is always discarded.
const _TIMING_DUMMY = { salt: 'AAAAAAAAAAAAAAAAAAAAAA==', hash: 'A'.repeat(44), iters: PBKDF2_ITERS };

// ── Salon registry + operator console ──────────────────────────────────────────
// The registry is a single reserved DO instance ('__registry__') holding one
// `salon:<slug>` key per salon. It's the only cross-salon index; salon clients
// never see it (registry keys aren't a buildSnapshot prefix, and the instance is
// reached only by operator routes). Reserved slugs can never be real salons.
const REGISTRY_NAME = '__registry__';
const RESERVED_SLUGS = new Set([REGISTRY_NAME, 'admin', 'operator', 'api', 'assets', 'icons', 'www', 'app', 'static', 'demo-reserved']);
// Default nail-salon menu a new salon starts with (owner edits in Settings).
const STARTER_SERVICES = [
  { id: 'svc-mani',  label: 'Classic Manicure', abbr: 'MANI', baseCost: 25 },
  { id: 'svc-gel',   label: 'Gel Manicure',     abbr: 'GEL',  baseCost: 38 },
  { id: 'svc-pedi',  label: 'Classic Pedicure', abbr: 'PEDI', baseCost: 35 },
  { id: 'svc-gpedi', label: 'Gel Pedicure',     abbr: 'GPED', baseCost: 50 },
  { id: 'svc-dip',   label: 'Dip Powder',       abbr: 'DIP',  baseCost: 45 },
  { id: 'svc-acrf',  label: 'Acrylic Full Set', abbr: 'ACRF', baseCost: 55 },
  { id: 'svc-acrl',  label: 'Acrylic Fill',     abbr: 'FILL', baseCost: 40 },
  { id: 'svc-pol',   label: 'Polish Change',    abbr: 'POL',  baseCost: 15 },
];
const STARTER_ITEMS = [
  { id: 'item-oil',   label: 'Cuticle Oil', abbr: 'OIL',   price: 12 },
  { id: 'item-cream', label: 'Hand Cream',  abbr: 'CREAM', price: 15 },
];
function validateSlug(slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/.test(s)) return { ok: false, error: 'slug must be 3–32 chars, lowercase letters/digits/hyphens, no leading/trailing hyphen' };
  if (RESERVED_SLUGS.has(s)) return { ok: false, error: 'that slug is reserved' };
  return { ok: true, slug: s };
}
function registryStub(env) { return env.SALON_DO.get(env.SALON_DO.idFromName(REGISTRY_NAME)); }
// Rebuild a public request into a clean POST to the registry DO carrying ONLY the
// body + CF-Connecting-IP — no X-Salon header and no ?salon= query. This prevents
// the registry DO's fetch() from reading an attacker-supplied slug and persisting
// it via _rememberSlug (which would corrupt the registry's own meta:slug and, in
// turn, the backup namespace it hands to alarm()). The path is fixed by the caller.
async function cleanRegistryRequest(request, path) {
  const ip   = request.headers.get('CF-Connecting-IP') || '';
  const body = await request.text();
  const headers = { 'Content-Type': 'application/json' };
  if (ip) headers['CF-Connecting-IP'] = ip;
  return new Request('https://do' + path, { method: 'POST', headers, body });
}
async function registryGet(env, slug) {
  try {
    const r = await registryStub(env).fetch(new Request('https://do/registry/get?slug=' + encodeURIComponent(slug)));
    if (!r.ok) return null;
    return (await r.json()).entry || null;
  } catch { return null; }
}

// ── SaaS billing (Phase 1 — infrastructure only, nothing enforced) ─────────────
// Billing state lives in the registry DO (bflags / bplan:<planId> / billing:<accountId>),
// reached only via registryStub — same pattern as salon:<slug>. Money is integer CENTS
// everywhere internal; dollars only at the Helcim API edge. Design + research record:
// docs/superpowers/specs/2026-07-15-turndesk-saas-billing-design.md (§10 addendum).
async function bdoGet(env, path) {
  const r = await registryStub(env).fetch(new Request('https://do' + path));
  return r.json().catch(() => ({}));
}
async function bdoPost(env, path, body) {
  const r = await registryStub(env).fetch(new Request('https://do' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  return r.json().catch(() => ({}));
}
export async function billingFlags(env) {
  return (await bdoGet(env, '/bdo/flags-get')).flags || { enforcementEnabled: false, selfserveBillingEnabled: false };
}
// The finalized tier matrix (spec §3). Seeded once, then operator-editable — these
// literals are the BOOTSTRAP values, not the runtime source of truth.
export const SEED_PLANS = [
  { planId: 'free', name: 'Free', visible: true, versions: [{ version: 1, priceCents: 0,
    capacity: { maxStaffAccounts: 5, maxCalendars: 0 },
    features: { turnBoardFull: false, checkin: false, reports: false, merchantProcessing: false, receiptPrinting: false, cashdrawer: false, floorplan: false, giftcards: false, timeclock: false, chat: false, apptReminders: false, quicksale: false, backofficeSync: false, sms: { included: false, monthlyLimit: 0 } }, createdAt: 0 }] },
  { planId: 'starter', name: 'Starter', visible: true, versions: [{ version: 1, priceCents: 3400,
    capacity: { maxStaffAccounts: 5, maxCalendars: 5 },
    features: { turnBoardFull: true, checkin: true, reports: true, merchantProcessing: true, receiptPrinting: true, cashdrawer: true, floorplan: false, giftcards: false, timeclock: false, chat: false, apptReminders: false, quicksale: false, backofficeSync: false, sms: { included: true, monthlyLimit: 100 } }, createdAt: 0 }] },
  { planId: 'pro', name: 'Pro', visible: true, versions: [{ version: 1, priceCents: 7900,
    capacity: { maxStaffAccounts: null, maxCalendars: null },
    features: { turnBoardFull: true, checkin: true, reports: true, merchantProcessing: true, receiptPrinting: true, cashdrawer: true, floorplan: true, giftcards: true, timeclock: true, chat: true, apptReminders: true, quicksale: true, backofficeSync: true, sms: { included: true, monthlyLimit: null } }, createdAt: 0 }] },
  // Multi exists as a real plan but is NOT publicly listed (spec §3.1) — price is per-deal.
  { planId: 'multi', name: 'Multi', visible: false, versions: [{ version: 1, priceCents: null,
    capacity: { maxStaffAccounts: null, maxCalendars: null },
    features: { turnBoardFull: true, checkin: true, reports: true, merchantProcessing: true, receiptPrinting: true, cashdrawer: true, floorplan: true, giftcards: true, timeclock: true, chat: true, apptReminders: true, quicksale: true, backofficeSync: true, sms: { included: true, monthlyLimit: null } }, createdAt: 0 }] },
];
export const currentVersion = plan => plan.versions[plan.versions.length - 1];
export const visiblePlans = plans => plans.filter(p => p && p.visible);
// Editing price/capacity/features appends a NEW version (subscribers stay pinned to the
// version they signed up under — an operator edit never silently reprices anyone).
// name/visible are plan-level cosmetics and change in place.
export function savePlanEdit(plan, edit) {
  const p = { ...plan, versions: [...plan.versions] };
  if (edit.name !== undefined) p.name = String(edit.name);
  if (edit.visible !== undefined) p.visible = !!edit.visible;
  const cur = currentVersion(p);
  const wants = k => edit[k] !== undefined && JSON.stringify(edit[k]) !== JSON.stringify(cur[k]);
  if (wants('priceCents') || wants('capacity') || wants('features')) {
    p.versions.push({
      version: cur.version + 1,
      priceCents: edit.priceCents !== undefined ? edit.priceCents : cur.priceCents,
      capacity: edit.capacity !== undefined ? edit.capacity : cur.capacity,
      features: edit.features !== undefined ? edit.features : cur.features,
      createdAt: Date.now(),
    });
  }
  return p;
}
export async function billingPlansEnsureSeed(env) {
  let plans = (await bdoGet(env, '/bdo/plans-get')).plans || [];
  if (plans.length === 0) {
    for (const plan of SEED_PLANS) await bdoPost(env, '/bdo/plan-put', { plan: { ...plan, versions: [{ ...plan.versions[0], createdAt: Date.now() }] } });
    plans = (await bdoGet(env, '/bdo/plans-get')).plans || [];
  }
  return plans;
}

// Merge Helcim subscription truth into a billing account. PURE + IDEMPOTENT: history
// merges keyed by helcimPaymentId, status derives from the payments array, and
// canceled/comped are STICKY — an operator decision outranks anything Helcim reports
// (the money movement is still recorded). Helcim amounts are dollars → stored as cents.
export function reconcileAccount(account, subscription) {
  if (!subscription) return account;
  const a = { ...account, history: [...(account.history || [])] };
  const seen = new Set(a.history.map(h => h.helcimPaymentId).filter(id => id != null));
  const payments = Array.isArray(subscription.payments) ? subscription.payments : [];
  for (const p of payments) {
    if (p.id != null && seen.has(p.id)) continue;
    a.history.push({
      event: 'payment', at: p.date || '', amountCents: Math.round(Number(p.amount || 0) * 100),
      invoiceId: p.invoiceNumber || String(p.id ?? ''), failureReason: (p.status === 'declined' || p.status === 'failed') ? (p.errorMessage || p.status) : null,
      note: 'helcim:' + (p.status || ''), helcimPaymentId: p.id ?? null,
    });
    if (p.id != null) seen.add(p.id);
  }
  if (subscription.dateBilling) a.currentPeriodEnd = subscription.dateBilling;
  const sticky = a.status === 'canceled' || a.status === 'comped';
  // Chronology = array order (Helcim appends); the LAST settled (non-waiting) payment decides.
  const settled = payments.filter(p => p.status === 'approved' || p.status === 'declined' || p.status === 'failed');
  const last = settled[settled.length - 1];
  if (last) {
    if (last.status === 'approved') {
      if (!sticky) a.status = 'active';
      a.pastDueSince = null; a.lastFailureReason = null;
    } else {
      if (!sticky) a.status = 'past_due';
      if (!a.pastDueSince) a.pastDueSince = Date.now();
      a.lastFailureReason = last.errorMessage || last.status;
    }
  }
  return a;
}

const HELCIM_BASE = 'https://api.helcim.com/v2';
const helcimHeaders = env => ({ 'api-token': env.HELCIM_API_TOKEN, 'accept': 'application/json', 'Content-Type': 'application/json' });
// Ensure the account has a Helcim customer to vault payment details against. Tries the
// namespaced customerCode 'td-<slug>' (spec §4); accepts Helcim's generated code if the
// API rejects a caller-supplied one. Returns the account (mutated copy) — NOT persisted.
export async function helcimEnsureBillingCustomer(env, account, salonName) {
  if (account.helcimCustomerId) return account;
  const body = { contactName: 'TurnDesk — ' + (salonName || account.accountId), customerCode: 'td-' + account.accountId };
  let r = await fetch(HELCIM_BASE + '/customers', { method: 'POST', headers: helcimHeaders(env), body: JSON.stringify(body) });
  let j = await r.json().catch(() => ({}));
  if (!r.ok) {   // customerCode not accepted → let Helcim generate one
    r = await fetch(HELCIM_BASE + '/customers', { method: 'POST', headers: helcimHeaders(env), body: JSON.stringify({ contactName: body.contactName }) });
    j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('helcim customer create failed (' + r.status + ')');
  }
  const c = j.customer || j;
  return { ...account, helcimCustomerId: c.id ?? null, helcimCustomerCode: c.customerCode || null };
}
// One umbrella Helcim payment plan ("TurnDesk SaaS", monthly, forever); every subscription
// sets its own recurringAmount, so OUR bplan docs stay the price/feature source of truth
// (spec §10). The Helcim plan id is cached on the bflags doc.
export async function helcimEnsureUmbrellaPlan(env) {
  const flags = (await bdoGet(env, '/bdo/flags-get')).flags || {};
  if (flags.helcimPlanId) return flags.helcimPlanId;
  const r = await fetch(HELCIM_BASE + '/payment-plans', { method: 'POST', headers: helcimHeaders(env), body: JSON.stringify({
    paymentPlans: [{ name: 'TurnDesk SaaS', description: 'TurnDesk monthly software subscription', recurringAmount: 1,
      billingPeriod: 'monthly', billingPeriodIncrements: 1, termType: 'forever', taxType: 'no_tax' }] }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('helcim plan create failed (' + r.status + ')');
  const created = (Array.isArray(j) ? j[0] : (Array.isArray(j.paymentPlans) ? j.paymentPlans[0] : j)) || {};
  const id = created.id ?? null;
  if (!id) throw new Error('helcim plan create returned no id');
  await bdoPost(env, '/bdo/flags-put', { helcimPlanId: id });
  return id;
}
export async function helcimSubscribe(env, account, priceCents) {
  const planId = await helcimEnsureUmbrellaPlan(env);
  const today = new Date().toISOString().slice(0, 10);
  const r = await fetch(HELCIM_BASE + '/subscriptions', { method: 'POST', headers: helcimHeaders(env), body: JSON.stringify({
    subscriptions: [{ customerId: account.helcimCustomerId, paymentPlanId: planId, recurringAmount: priceCents / 100,
      dateActivated: today, paymentMethod: account.paymentMethodType === 'ach' ? 'bank' : 'card' }] }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('helcim subscribe failed (' + r.status + '): ' + JSON.stringify(j).slice(0, 200));
  const created = (Array.isArray(j) ? j[0] : (Array.isArray(j.subscriptions) ? j.subscriptions[0] : j)) || {};
  if (created.id == null) throw new Error('helcim subscribe returned no id');
  return { subscriptionId: created.id };
}
export async function helcimGetSubscription(env, subscriptionId) {
  const r = await fetch(HELCIM_BASE + '/subscriptions/' + encodeURIComponent(subscriptionId), { headers: helcimHeaders(env) });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j && (j.subscription || j);
}
export async function helcimCancelSubscription(env, subscriptionId) {
  try {
    await fetch(HELCIM_BASE + '/subscriptions/' + encodeURIComponent(subscriptionId), {
      method: 'PATCH', headers: helcimHeaders(env), body: JSON.stringify({ status: 'cancelled' }) });
  } catch {}   // best-effort — the sticky 'canceled' status is ours regardless
}
// Fetch-then-RMW ordering (spec §8): the external Helcim call completes BEFORE the
// account read+write, so the DO's non-interleaving window stays closed.
export async function syncAccountFromHelcim(env, account) {
  if (!account || !account.helcimSubscriptionId) return account;
  const sub = await helcimGetSubscription(env, account.helcimSubscriptionId);
  if (!sub) return account;
  const fresh = (await bdoGet(env, '/bdo/account-get?id=' + encodeURIComponent(account.accountId))).account || account;
  const merged = reconcileAccount(fresh, sub);
  await bdoPost(env, '/bdo/account-put', { account: merged });
  return merged;
}

// Operator routes: gated by the OPERATOR_TOKEN secret (Bearer or ?op=). All are
// cross-salon. Returns a Response.
// Add/refresh the registry owneremail→slug index so the salon-agnostic
// /auth/find-login (bare link) can route an owner to their salon. Best-effort —
// a miss only means the owner must use the salon-specific link. Email→slug only,
// no secret.
async function indexOwnerEmail(env, email, slug) {
  email = String(email || '').trim().toLowerCase(); slug = String(slug || '').trim();
  if (!email || !slug) return;
  try {
    await registryStub(env).fetch(new Request('https://do/registry/index-owner', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, slug }),
    }));
  } catch {}
}

export async function handleOperator(request, env, url, method, path) {
  const auth = request.headers.get('Authorization') || '';
  const tok  = auth.startsWith('Bearer ') ? auth.slice(7).trim() : (url.searchParams.get('op') || '');
  if (!env.OPERATOR_TOKEN || !safeEqual(tok, env.OPERATOR_TOKEN)) return json({ error: 'unauthorized' }, 401);

  // GET /operator/salons → list
  if (path === '/operator/salons' && method === 'GET') {
    const r = await registryStub(env).fetch(new Request('https://do/registry/list'));
    return json(await r.json().catch(() => ({ salons: [] })));
  }
  // POST /operator/salons → provision { slug, name, ownerEmail, ownerPassword, plan }
  if (path === '/operator/salons' && method === 'POST') {
    let b = {}; try { b = await request.json(); } catch {}
    const v = validateSlug(b.slug);
    if (!v.ok) return json({ error: v.error }, 400);
    const slug = v.slug;
    const existing = await registryGet(env, slug);
    if (existing && !b.force) return json({ error: 'slug already exists' }, 409);
    if (!b.ownerEmail || !String(b.ownerEmail).includes('@') || String(b.ownerPassword || '').length < 6) {
      return json({ error: 'ownerEmail + ownerPassword (≥6 chars) required' }, 400);
    }
    const salonStub = env.SALON_DO.get(env.SALON_DO.idFromName(slug));
    // 1) seed starter config, 2) set owner credential, 3) registry entry LAST — but only after
    // 1+2 actually succeeded. Checking the sub-responses stops a transient failure from leaving a
    // salon in the registry with NO owner credential (owner locked out) or reporting { ok:true }
    // for a half-provisioned salon. (Seeded config from a stopped-short provision is a harmless
    // orphan with no registry entry; re-running the same slug re-seeds only absent keys + retries.)
    let seedRes, ownerRes;
    try {
      seedRes = await salonStub.fetch(new Request('https://do/provision/seed', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, name: b.name || slug, template: b.template !== false }),
      }));
      ownerRes = await salonStub.fetch(new Request('https://do/auth/owner-set', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: env.RESTORE_TOKEN, email: b.ownerEmail, password: b.ownerPassword, name: b.name ? b.name + ' Owner' : 'Owner', role: 'owner' }),
      }));
    } catch (e) {
      return json({ error: 'provision failed: ' + ((e && e.message) || String(e)) }, 502);
    }
    if (!seedRes.ok)  return json({ error: 'provision seed failed (' + seedRes.status + ') — salon NOT registered' }, 502);
    if (!ownerRes.ok) return json({ error: 'owner credential setup failed (' + ownerRes.status + ') — salon NOT registered' }, 502);
    const entry = { slug, name: b.name || slug, status: 'active', ownerEmail: String(b.ownerEmail).toLowerCase(), plan: b.plan || '', createdAt: new Date().toISOString() };
    await registryStub(env).fetch(new Request('https://do/registry/put', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entry }) }));
    await indexOwnerEmail(env, entry.ownerEmail, slug);
    return json({ ok: true, slug, entry });
  }
  // POST /operator/salons/<slug>/register { name, ownerEmail, plan } → add an
  // EXISTING (externally-seeded) salon to the registry without seeding or touching
  // its owner credential. For adopting salons created outside the console (e.g. demo).
  let mr = path.match(/^\/operator\/salons\/([a-z0-9-]+)\/register$/);
  if (mr && method === 'POST') {
    const v = validateSlug(mr[1]);
    if (!v.ok) return json({ error: v.error }, 400);
    let b = {}; try { b = await request.json(); } catch {}
    const existing = await registryGet(env, v.slug);
    const entry = { slug: v.slug, name: b.name || (existing && existing.name) || v.slug, status: 'active', ownerEmail: (b.ownerEmail || (existing && existing.ownerEmail) || '').toLowerCase(), plan: b.plan || (existing && existing.plan) || '', createdAt: (existing && existing.createdAt) || new Date().toISOString() };
    await registryStub(env).fetch(new Request('https://do/registry/put', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entry }) }));
    await indexOwnerEmail(env, entry.ownerEmail, entry.slug);
    return json({ ok: true, entry });
  }
  // POST /operator/salons/<slug>/status { status } → enable/disable
  let m = path.match(/^\/operator\/salons\/([a-z0-9-]+)\/status$/);
  if (m && method === 'POST') {
    let b = {}; try { b = await request.json(); } catch {}
    const entry = await registryGet(env, m[1]);
    if (!entry) return json({ error: 'no such salon' }, 404);
    entry.status = b.status === 'disabled' ? 'disabled' : 'active';
    await registryStub(env).fetch(new Request('https://do/registry/put', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entry }) }));
    return json({ ok: true, entry });
  }
  // POST /operator/salons/<slug>/owner { email, password } → reset owner credential
  m = path.match(/^\/operator\/salons\/([a-z0-9-]+)\/owner$/);
  if (m && method === 'POST') {
    let b = {}; try { b = await request.json(); } catch {}
    if (!b.email || String(b.password || '').length < 6) return json({ error: 'email + password (≥6) required' }, 400);
    const salonStub = env.SALON_DO.get(env.SALON_DO.idFromName(m[1]));
    const r = await salonStub.fetch(new Request('https://do/auth/owner-set', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: env.RESTORE_TOKEN, email: b.email, password: b.password, name: b.name || 'Owner', role: b.role === 'manager' ? 'manager' : 'owner' }),
    }));
    if (r.ok) await indexOwnerEmail(env, b.email, m[1]);
    return json(await r.json().catch(() => ({ ok: r.ok })), r.status);
  }
  // POST /operator/reindex-owners → one-time backfill of the owneremail→slug index
  // from every registry salon's ownerEmail (for salons created before the index existed).
  if (path === '/operator/reindex-owners' && method === 'POST') {
    const lr = await registryStub(env).fetch(new Request('https://do/registry/list'));
    const salons = (await lr.json().catch(() => ({ salons: [] }))).salons || [];
    let n = 0;
    for (const s of salons) { if (s && s.ownerEmail && s.slug) { await indexOwnerEmail(env, s.ownerEmail, s.slug); n++; } }
    return json({ ok: true, indexed: n });
  }
  if (path === '/operator/requests' && method === 'GET') {
    const r = await registryStub(env).fetch(new Request('https://do/registry/signups'));
    return json(await r.json().catch(() => ({ requests: [] })));
  }
  // Demo leads: list + mark contacted/dismissed (no account provisioning — just a lead).
  if (path === '/operator/demo-requests' && method === 'GET') {
    const r = await registryStub(env).fetch(new Request('https://do/registry/demo-requests'));
    return json(await r.json().catch(() => ({ requests: [] })));
  }
  if (path === '/operator/demo-requests/decide' && method === 'POST') {
    let b = {}; try { b = await request.json(); } catch {}
    const r = await registryStub(env).fetch(new Request('https://do/demo/decide', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: b.id, status: b.status }),
    }));
    return json(await r.json().catch(() => ({})), r.status);
  }
  if (path === '/operator/requests/decide' && method === 'POST') {
    let b = {}; try { b = await request.json(); } catch {}
    const g = await registryStub(env).fetch(new Request('https://do/registry/signup-get?id=' + encodeURIComponent(b.id || '')));
    const rec = (await g.json().catch(() => ({}))).entry;
    if (!rec) return json({ error: 'request not found' }, 404);
    if (rec.status !== 'pending') return json({ error: 'already ' + rec.status }, 409);
    if (b.action === 'reject') {
      await registryStub(env).fetch(new Request('https://do/signup/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: rec.id, status: 'rejected', reason: b.reason || '' }) }));
      return json({ ok: true, status: 'rejected' });
    }
    const v = validateSlug(b.slug || rec.proposedSlug);
    if (!v.ok) return json({ error: v.error }, 400);
    let slug = v.slug, n = 2;
    while (await registryGet(env, slug)) slug = v.slug + '-' + n++;   // uniquify at approval time
    const salonStub = env.SALON_DO.get(env.SALON_DO.idFromName(slug));
    await salonStub.fetch(new Request('https://do/provision/seed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug, name: rec.business, template: true }) }));
    await salonStub.fetch(new Request('https://do/provision/owner', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ record: rec.ownerRecord }) }));
    const entry = { slug, name: rec.business, status: 'active', ownerEmail: rec.email, plan: '', createdAt: new Date().toISOString() };
    await registryStub(env).fetch(new Request('https://do/registry/put', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entry }) }));
    await registryStub(env).fetch(new Request('https://do/signup/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: rec.id, status: 'approved', finalSlug: slug }) }));
    await indexOwnerEmail(env, rec.email, slug);
    return json({ ok: true, slug });
  }
  if (path === '/operator/export' && method === 'GET') {
    const v = validateSlug(url.searchParams.get('slug'));
    if (!v.ok) return json({ error: v.error }, 400);
    const salonStub = env.SALON_DO.get(env.SALON_DO.idFromName(v.slug));
    const r = await salonStub.fetch(new Request('https://do/state/snapshot'));
    const body = await r.text();
    return new Response(body, { status: r.status, headers: corsHeaders({ 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="turndesk-${v.slug}.json"` }) });
  }
  // GET|POST /operator/salons/<slug>/managerpin → see or set the front-desk MANAGER PIN.
  // Front-desk PINs live in plaintext config (they're shared-iPad unlock codes, not hashed
  // secrets), so the operator can both view and change them. The manager is the fd_user
  // id 'fd-manager' (created by the salon's first-run prompt); setting one here also
  // retires the temporary 1234 fallback (which only works while a salon has no fd_users).
  let mpm = path.match(/^\/operator\/salons\/([a-z0-9-]+)\/managerpin$/);
  if (mpm) {
    const v = validateSlug(mpm[1]);
    if (!v.ok) return json({ error: v.error }, 400);
    const salonStub = env.SALON_DO.get(env.SALON_DO.idFromName(v.slug));
    if (method === 'GET') {
      const snap = await (await salonStub.fetch(new Request('https://do/state/snapshot'))).json().catch(() => ({}));
      const fd = (snap.state && snap.state.config && snap.state.config.fd_users) || [];
      const mgr = fd.find(u => u.id === 'fd-manager') || fd.find(u => (u.role || '') === 'admin') || fd[0] || null;
      return json({ pin: mgr ? String(mgr.pin || '') : null, name: mgr ? mgr.name : 'Manager', staffCount: fd.length });
    }
    if (method === 'POST') {
      let b = {}; try { b = await request.json(); } catch {}
      const pin = String(b.pin || '').trim();
      if (!/^\d{4,8}$/.test(pin)) return json({ error: 'PIN must be 4–8 digits' }, 400);
      // Delegate the read-modify-write to the DO so it's atomic + stale-write-guarded.
      const r = await salonStub.fetch(new Request('https://do/provision/managerpin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) }));
      return json(await r.json().catch(() => ({ ok: r.ok })), r.status);
    }
  }

  // ── SaaS billing (Phase 1 — operator controls; nothing here enforces anything) ──
  const getAccount = async slug => (await bdoGet(env, '/bdo/account-get?id=' + encodeURIComponent(slug))).account || null;
  const putAccount = async account => bdoPost(env, '/bdo/account-put', { account });
  const hist = (account, event, note) => ({ ...account, history: [...(account.history || []), { event, at: Date.now(), amountCents: null, invoiceId: null, failureReason: null, note: note || '', helcimPaymentId: null }] });

  if (path === '/operator/billing/overview' && method === 'GET') {
    const plans = await billingPlansEnsureSeed(env);
    const flags = await billingFlags(env);
    const accounts = (await bdoGet(env, '/bdo/accounts-get')).accounts || [];
    const lr = await registryStub(env).fetch(new Request('https://do/registry/list'));
    const salons = (await lr.json().catch(() => ({ salons: [] }))).salons || [];
    const names = Object.fromEntries(salons.map(s => [s.slug, s.name]));
    return json({ flags: { enforcementEnabled: flags.enforcementEnabled === true, selfserveBillingEnabled: flags.selfserveBillingEnabled === true }, plans, accounts: accounts.map(a => ({ ...a, salonName: names[a.accountId] || a.accountId })) });
  }
  if (path === '/operator/billing/flags' && method === 'POST') {
    let b = {}; try { b = await request.json(); } catch {}
    const r = await bdoPost(env, '/bdo/flags-put', { enforcementEnabled: b.enforcementEnabled, selfserveBillingEnabled: b.selfserveBillingEnabled });
    return json(r);
  }
  // Create a plan (unknown planId) or edit one (price/capacity/features edits append a
  // NEW version — savePlanEdit — so pinned subscribers never silently reprice).
  if (path === '/operator/billing/plans' && method === 'POST') {
    let b = {}; try { b = await request.json(); } catch {}
    const planId = String(b.planId || '').trim().toLowerCase();
    if (!/^[a-z0-9-]{2,32}$/.test(planId)) return json({ error: 'planId must be 2–32 chars, lowercase/digits/hyphens' }, 400);
    const plans = await billingPlansEnsureSeed(env);
    let plan = plans.find(p => p.planId === planId);
    if (!plan) {
      plan = { planId, name: String(b.name || planId), visible: b.visible !== false, versions: [{ version: 1,
        priceCents: b.priceCents ?? null, capacity: b.capacity || { maxStaffAccounts: null, maxCalendars: null },
        features: b.features || {}, createdAt: Date.now() }] };
    } else {
      plan = savePlanEdit(plan, b);
    }
    await bdoPost(env, '/bdo/plan-put', { plan });
    return json({ ok: true, plan });
  }
  if (path === '/operator/billing/assign' && method === 'POST') {
    let b = {}; try { b = await request.json(); } catch {}
    const v = validateSlug(b.slug);
    if (!v.ok) return json({ error: v.error }, 400);
    const plans = await billingPlansEnsureSeed(env);
    const plan = plans.find(p => p.planId === b.planId);
    if (!plan) return json({ error: 'no such plan' }, 404);
    const entry = await registryGet(env, v.slug);
    if (!entry) return json({ error: 'no such salon' }, 404);
    let account = await getAccount(v.slug);
    if (!account) account = { accountId: v.slug, salonSlugs: [v.slug], status: 'trialing', trialEndsAt: null, compUntil: null, currentPeriodEnd: null, paymentMethodType: null, helcimCustomerId: null, helcimCustomerCode: null, helcimSubscriptionId: null, pastDueSince: null, lastFailureReason: null, achAuthorization: null, history: [] };
    account.planId = plan.planId;
    account.planVersion = currentVersion(plan).version;
    account = hist(account, 'assign', plan.planId + ' v' + account.planVersion);
    await putAccount(account);
    entry.billingAccountId = account.accountId;
    await registryStub(env).fetch(new Request('https://do/registry/put', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entry }) }));
    return json({ ok: true, account });
  }
  if (path === '/operator/billing/trial' && method === 'POST') {
    let b = {}; try { b = await request.json(); } catch {}
    const days = Number(b.days);
    if (days !== 14 && days !== 30) return json({ error: 'trial is 14 or 30 days' }, 400);
    let account = await getAccount(String(b.slug || ''));
    if (!account) return json({ error: 'no billing account — assign a plan first' }, 404);
    account.status = 'trialing';
    account.trialEndsAt = Date.now() + days * 86400000;
    account = hist(account, 'trial', days + 'd');
    await putAccount(account);
    return json({ ok: true, account });
  }
  if (path === '/operator/billing/comp' && method === 'POST') {
    let b = {}; try { b = await request.json(); } catch {}
    const months = Number(b.months);
    if (!(months >= 1 && months <= 3)) return json({ error: 'comp is 1–3 months' }, 400);
    let account = await getAccount(String(b.slug || ''));
    if (!account) return json({ error: 'no billing account — assign a plan first' }, 404);
    account.status = 'comped';
    account.compUntil = Date.now() + Math.round(months * 30.44 * 86400000);
    account = hist(account, 'comp', months + 'mo');
    await putAccount(account);
    return json({ ok: true, account });
  }
  if (path === '/operator/billing/cancel' && method === 'POST') {
    let b = {}; try { b = await request.json(); } catch {}
    let account = await getAccount(String(b.slug || ''));
    if (!account) return json({ error: 'no billing account' }, 404);
    if (account.helcimSubscriptionId) await helcimCancelSubscription(env, account.helcimSubscriptionId);
    account.status = 'canceled';
    account = hist(account, 'cancel', '');
    await putAccount(account);
    return json({ ok: true, account });
  }
  // The deliberate operator test path (spec §6 flow A): a REAL Helcim subscription for one
  // salon, by the owner's explicit action — the salon-facing path stays flag-gated.
  if (path === '/operator/billing/subscribe' && method === 'POST') {
    let b = {}; try { b = await request.json(); } catch {}
    let account = await getAccount(String(b.slug || ''));
    if (!account) return json({ error: 'no billing account — assign a plan first' }, 404);
    if (!account.paymentMethodType) return json({ error: 'no payment method on file — capture card/bank first' }, 409);
    const plans = await billingPlansEnsureSeed(env);
    const plan = plans.find(p => p.planId === account.planId);
    const ver = plan && plan.versions.find(x => x.version === account.planVersion);
    if (!ver || !(ver.priceCents > 0)) return json({ error: 'assigned plan version has no billable price' }, 409);
    try {
      account = await helcimEnsureBillingCustomer(env, account, (await registryGet(env, account.accountId))?.name);
      const { subscriptionId } = await helcimSubscribe(env, account, ver.priceCents);
      account.helcimSubscriptionId = subscriptionId;
      account.status = 'active';
      account = hist(account, 'subscribe', '$' + (ver.priceCents / 100).toFixed(2) + '/mo');
      await putAccount(account);
      return json({ ok: true, account });
    } catch (e) {
      console.error('[billing subscribe]', account.accountId, (e && e.message) || String(e));
      return json({ error: String((e && e.message) || e).slice(0, 300) }, 502);
    }
  }
  if (path === '/operator/billing/sync' && method === 'GET') {
    const account = await getAccount(url.searchParams.get('slug') || '');
    if (!account) return json({ error: 'no billing account' }, 404);
    const merged = await syncAccountFromHelcim(env, account);
    return json({ ok: true, account: merged });
  }

  return json({ error: 'not found' }, 404);
}

// ── SaaS billing: salon-facing routes ──────────────────────────────────────────
// Stricter than appAuthOk: these touch payment data, so a valid owner-or-admin
// session is required UNCONDITIONALLY (even where general AUTH_ENFORCED is off),
// and the platform operator's own master login (kind 'appadmin') is denied —
// consistent with auth.js's existing "never the master app-admin" exclusions.
async function billingAdminUser(request, url, env, salonId) {
  const h = request.headers.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : (url.searchParams.get('auth') || '');
  if (!token || !salonId) return null;
  try {
    const stub = env.SALON_DO.get(env.SALON_DO.idFromName(salonId));
    const r = await stub.fetch(new Request('https://do/auth/check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
    }));
    const b = await r.json().catch(() => ({}));
    const u = b.ok === true ? b.user : null;
    if (!u || u.kind === 'appadmin') return null;
    if (u.kind !== 'owner' && u.role !== 'admin') return null;
    return u;
  } catch { return null; }
}
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
// The recurring-debit authorization text shown at ACH enrollment. Versioned so the
// exact accepted wording is provable later (NACHA record-keeping) — bump the id when
// the wording changes, never edit an existing version's meaning.
export const ACH_AUTH_TEXT = {
  version: 'ach-auth-v1',
  text: 'I authorize TurnDesk to debit my bank account each month for the subscription amount of my selected plan, until I cancel this authorization. I can revoke it any time from Settings → Billing or by contacting TurnDesk. Debits occur on my billing date; if one is returned, it may be retried per my bank’s rules.',
};
const emptyAccount = slug => ({ accountId: slug, salonSlugs: [slug], planId: null, planVersion: null, status: 'trialing', trialEndsAt: null, compUntil: null, currentPeriodEnd: null, paymentMethodType: null, helcimCustomerId: null, helcimCustomerCode: null, helcimSubscriptionId: null, pastDueSince: null, lastFailureReason: null, achAuthorization: null, history: [] });

export async function handleBilling(request, env, url, method, path, salonId) {
  const user = await billingAdminUser(request, url, env, salonId);
  if (!user) return json({ error: 'unauthorized' }, 401);
  const getAccount = async () => (await bdoGet(env, '/bdo/account-get?id=' + encodeURIComponent(salonId))).account || null;
  const putAccount = async account => bdoPost(env, '/bdo/account-put', { account });
  const histEvent = (account, event, note) => ({ ...account, history: [...(account.history || []), { event, at: Date.now(), amountCents: null, invoiceId: null, failureReason: null, note: note || '', helcimPaymentId: null }] });

  // GET /billing/status → this salon's account + visible plans (flattened to their
  // current version) + the selfserve flag. ?sync=1 reconciles from Helcim first.
  if (path === '/billing/status' && method === 'GET') {
    const flags = await billingFlags(env);
    const plans = await billingPlansEnsureSeed(env);
    let account = await getAccount();
    if (account && url.searchParams.get('sync') === '1') account = await syncAccountFromHelcim(env, account);
    const publicPlans = visiblePlans(plans).map(p => { const v = currentVersion(p); return { planId: p.planId, name: p.name, priceCents: v.priceCents, capacity: v.capacity, features: v.features, version: v.version }; });
    return json({ flags: { selfserveBillingEnabled: flags.selfserveBillingEnabled === true }, account, plans: publicPlans, achAuthText: ACH_AUTH_TEXT });
  }
  // POST /billing/ach-authorize { textVersion } → record the NACHA authorization
  // acceptance (timestamp + wording version + who) BEFORE any bank capture.
  if (path === '/billing/ach-authorize' && method === 'POST') {
    let b = {}; try { b = await request.json(); } catch {}
    let account = (await getAccount()) || emptyAccount(salonId);
    account.achAuthorization = { acceptedAt: Date.now(), textVersion: String(b.textVersion || ACH_AUTH_TEXT.version), byUser: user.name || user.id };
    account = histEvent(account, 'ach-authorize', account.achAuthorization.textVersion);
    await putAccount(account);
    return json({ ok: true, account });
  }
  // POST /billing/portal-token { ach? } → HelcimPay.js verify session for capturing a
  // card or bank account. The secretToken never reaches the client — it's held in the
  // registry DO (single-use) for verify-complete's hash check.
  if (path === '/billing/portal-token' && method === 'POST') {
    const flags = await billingFlags(env);
    if (flags.selfserveBillingEnabled !== true) return json({ error: 'self-serve billing is not enabled' }, 403);
    let b = {}; try { b = await request.json(); } catch {}
    let account = (await getAccount()) || emptyAccount(salonId);
    if (b.ach && !account.achAuthorization) return json({ error: 'ACH requires the recurring-debit authorization first', achAuthText: ACH_AUTH_TEXT }, 428);
    try {
      account = await helcimEnsureBillingCustomer(env, account, salonId);
      await putAccount(account);
      const r = await fetch(HELCIM_BASE + '/helcim-pay/initialize', { method: 'POST', headers: helcimHeaders(env), body: JSON.stringify({
        paymentType: 'verify', amount: 0, currency: 'USD', customerCode: account.helcimCustomerCode }) });
      const jj = await r.json().catch(() => ({}));
      if (!r.ok || !jj.checkoutToken) return json({ error: 'HelcimPay initialize failed (' + r.status + ')' }, 502);
      await bdoPost(env, '/bdo/pay-put', { token: jj.checkoutToken, record: { secretToken: jj.secretToken, slug: salonId, ts: Date.now() } });
      return json({ checkoutToken: jj.checkoutToken });
    } catch (e) {
      console.error('[billing portal-token]', salonId, (e && e.message) || String(e));
      return json({ error: String((e && e.message) || e).slice(0, 300) }, 502);
    }
  }
  // POST /billing/verify-complete { checkoutToken, rawDataResponse, hash } → validate
  // Helcim's response hash (SHA-256 of raw+secretToken, per their validate scheme;
  // single-use token) and store the captured payment method on the account.
  if (path === '/billing/verify-complete' && method === 'POST') {
    let b = {}; try { b = await request.json(); } catch {}
    const rec = (await bdoPost(env, '/bdo/pay-take', { token: String(b.checkoutToken || '') })).record;
    if (!rec || rec.slug !== salonId) return json({ error: 'unknown or expired checkout token' }, 400);
    const raw = String(b.rawDataResponse || '');
    const expect = await sha256Hex(raw + rec.secretToken);
    if (!b.hash || String(b.hash).toLowerCase() !== expect) return json({ error: 'response hash mismatch' }, 400);
    let parsed = {}; try { parsed = JSON.parse(raw); } catch {}
    const data = parsed.data || parsed;
    let account = (await getAccount()) || emptyAccount(salonId);
    account.paymentMethodType = data.bankToken ? 'ach' : 'card';
    if (data.customerCode) account.helcimCustomerCode = data.customerCode;
    account = histEvent(account, 'payment-method', account.paymentMethodType);
    await putAccount(account);
    return json({ ok: true, account });
  }
  // POST /billing/subscribe { planId } → first subscribe creates the REAL Helcim
  // subscription at the plan's current version; on an already-subscribed account a
  // plan change only re-pins + records intent (the live Helcim subscription is
  // untouched in Phase 1 — next-cycle amount changes are Phase 2).
  if (path === '/billing/subscribe' && method === 'POST') {
    const flags = await billingFlags(env);
    if (flags.selfserveBillingEnabled !== true) return json({ error: 'self-serve billing is not enabled' }, 403);
    let b = {}; try { b = await request.json(); } catch {}
    const plans = await billingPlansEnsureSeed(env);
    const plan = visiblePlans(plans).find(p => p.planId === String(b.planId || ''));
    if (!plan) return json({ error: 'no such plan' }, 404);
    const ver = currentVersion(plan);
    let account = await getAccount();
    if (!account || !account.paymentMethodType) return json({ error: 'add a payment method first' }, 409);
    if (account.helcimSubscriptionId) {
      account.planId = plan.planId;
      account.planVersion = ver.version;
      account = histEvent(account, 'plan-change', plan.planId + ' v' + ver.version + ' (next cycle)');
      await putAccount(account);
      return json({ ok: true, account });
    }
    if (!(ver.priceCents > 0)) return json({ error: 'that plan has no billable price' }, 409);
    try {
      account = await helcimEnsureBillingCustomer(env, account, salonId);
      const { subscriptionId } = await helcimSubscribe(env, account, ver.priceCents);
      account.planId = plan.planId;
      account.planVersion = ver.version;
      account.helcimSubscriptionId = subscriptionId;
      account.status = 'active';
      account = histEvent(account, 'subscribe', '$' + (ver.priceCents / 100).toFixed(2) + '/mo');
      await putAccount(account);
      return json({ ok: true, account });
    } catch (e) {
      console.error('[billing subscribe]', salonId, (e && e.message) || String(e));
      return json({ error: String((e && e.message) || e).slice(0, 300) }, 502);
    }
  }
  return json({ error: 'not found' }, 404);
}

// ── Backup retention (Phase 1) ───────────────────────────────────────────────
// Tiered (grandfather-father-son) keep-set for the timestamped R2 snapshots: every
// 6h point for 1 week, the newest-per-day for 1 month, newest-per-month for 1 year,
// newest-per-year for 7 years — plus a hard floor (always keep the newest few) and an
// exemption for DR "safety" snapshots (…/safety-*). Pure + stateless: recomputed from
// scratch each run so a missed run self-corrects. Buckets by R2 `uploaded` time (never
// by parsing the mangled key). Operates on the already-per-salon list from listBackups.
// Returns { keep:Set, del:string[] }.
export function computeBackupKeepSet(backups, nowMs) {
  const DAY = 86400000;
  const items = (backups || [])
    .map(b => ({ key: b && b.key, t: +new Date(b && b.uploaded), safety: /^safety-/.test((((b && b.key) || '').split('/').pop()) || '') }))
    .filter(x => x.key && Number.isFinite(x.t))
    .sort((a, b) => b.t - a.t);   // newest first → first-seen-per-bucket is the end-of-period one
  const keep = new Set();
  for (const x of items) if (x.t >= nowMs - 7 * DAY) keep.add(x.key);            // 6h points, last week
  const bucketNewest = (windowMs, periodKey) => {
    const seen = new Set();
    for (const x of items) {
      if (x.t < nowMs - windowMs) continue;
      const pk = periodKey(x.t);
      if (!seen.has(pk)) { seen.add(pk); keep.add(x.key); }
    }
  };
  bucketNewest(30 * DAY,      t => new Date(t).toISOString().slice(0, 10));      // daily, last month
  bucketNewest(365 * DAY,     t => new Date(t).toISOString().slice(0, 7));       // monthly, last year
  bucketNewest(7 * 365 * DAY, t => new Date(t).toISOString().slice(0, 4));       // yearly, last 7 years
  for (let i = 0; i < Math.min(8, items.length); i++) keep.add(items[i].key);    // hard floor: newest few, always
  let safe = 0;                                                                  // DR safety snapshots: newest few, always
  for (const x of items) { if (x.safety && safe < 5) { keep.add(x.key); safe++; } }
  const del = items.filter(x => !keep.has(x.key)).map(x => x.key);
  return { keep, del };
}

export class TurnDeskDO {
  constructor(state, env) {
    this.state = state;
    this.env   = env;
    this.SCHEMA_VERSION = 1;
    this.BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
    this.slug = '';   // this salon's tenant slug; learned from requests, persisted to meta:slug
    // WebSocket Hibernation: answer the client's 20s keepalive ping at the edge so the heartbeat
    // never wakes (or bills) the DO. Sockets live in the runtime (state.getWebSockets), not an
    // in-memory Set a hibernation eviction would drop. Guarded so unit tests (no WS runtime) build.
    try {
      if (typeof WebSocketRequestResponsePair !== 'undefined' && this.state.setWebSocketAutoResponse) {
        this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(JSON.stringify({ type: 'ping' }), JSON.stringify({ type: 'pong' })));
      }
    } catch {}
  }

  async fetch(request) {
    const url     = new URL(request.url);
    const upgrade = request.headers.get('Upgrade');

    // Learn this salon's slug from the request (WS carries ?salon=, HTTP carries
    // X-Salon). Runs before the WS upgrade return so socket connects stamp it too.
    const _slug = (url.searchParams.get('salon') || request.headers.get('X-Salon') || '').trim();
    if (_slug) await this._rememberSlug(_slug);

    if (upgrade && upgrade.toLowerCase() === 'websocket') {
      const pair             = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);   // hibernatable: the runtime holds the socket, not the isolate
      return new Response(null, { status: 101, webSocket: client });
    }

    // ── PIN sign-in sessions (§13) ────────────────────────────────────────────
    // sess:<token> and authfail:<ip> keys are NOT buildSnapshot prefixes, so they
    // never reach clients. Login checks the SAME fd_users/staff PINs the app
    // already uses — one source of truth, nothing to provision or migrate.
    if (url.pathname === '/auth/login'  && request.method === 'POST') return this.authLogin(request);
    if (url.pathname === '/auth/logout' && request.method === 'POST') return this.authLogout(request);
    if (url.pathname === '/auth/check'  && request.method === 'POST') return this.authCheck(request);
    if (url.pathname === '/auth/owner-set' && request.method === 'POST') return this.authOwnerSet(request);
    // Cross-salon email login (adaptive sign-in): the Worker forwards this only to
    // the reserved '__registry__' instance, so it's only ever reached there.
    if (url.pathname === '/auth/find-login' && request.method === 'POST') return this.findLogin(request);

    // ── Salon registry (only the reserved '__registry__' instance uses these) ───
    // Internal routes called by the Worker's operator handler. Keys are `salon:<slug>`.
    if (url.pathname === '/registry/get') {
      const slug = url.searchParams.get('slug') || '';
      return this._authJson({ entry: (await this.state.storage.get('salon:' + slug)) || null });
    }
    if (url.pathname === '/registry/list') {
      const map = await this.state.storage.list({ prefix: 'salon:' });
      return this._authJson({ salons: [...map.values()] });
    }
    if (url.pathname === '/registry/signups' && request.method === 'GET') {
      const all = await this.state.storage.list({ prefix: 'signup:' });
      const arr = []; for (const [, x] of all) arr.push(x);
      arr.sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.createdAt - a.createdAt);
      const requests = arr.slice(0, 200).map(({ ownerRecord, ...rest }) => rest);   // never ship the credential hash
      return new Response(JSON.stringify({ requests }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/registry/signup-get' && request.method === 'GET') {
      const rec = await this.state.storage.get('signup:' + (url.searchParams.get('id') || ''));
      return new Response(JSON.stringify({ entry: rec || null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    // Demo leads — list for the operator (newest pending first). No credential to strip.
    if (url.pathname === '/registry/demo-requests' && request.method === 'GET') {
      const all = await this.state.storage.list({ prefix: 'demo:' });
      const arr = []; for (const [, x] of all) arr.push(x);
      arr.sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.createdAt - a.createdAt);
      return new Response(JSON.stringify({ requests: arr.slice(0, 200) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/demo/decide' && request.method === 'POST') {
      let b = {}; try { b = await request.json(); } catch {}
      const rec = await this.state.storage.get('demo:' + (b.id || ''));
      if (!rec) return new Response('{"error":"not found"}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      rec.status = b.status === 'contacted' ? 'contacted' : 'dismissed';
      rec.decidedAt = Date.now();
      await this.state.storage.put('demo:' + rec.id, rec);
      return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/signup/decide' && request.method === 'POST') {
      let b = {}; try { b = await request.json(); } catch {}
      const rec = await this.state.storage.get('signup:' + (b.id || ''));
      if (!rec) return new Response('{"error":"not found"}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      rec.status = b.status === 'approved' ? 'approved' : 'rejected';
      rec.decidedAt = Date.now();
      if (b.finalSlug) rec.finalSlug = b.finalSlug;
      if (b.reason) rec.rejectReason = String(b.reason).slice(0, 200);
      await this.state.storage.put('signup:' + rec.id, rec);
      return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/registry/put' && request.method === 'POST') {
      let b = {}; try { b = await request.json(); } catch {}
      if (!b.entry || !b.entry.slug) return this._authJson({ error: 'bad entry' }, 400);
      await this.state.storage.put('salon:' + b.entry.slug, b.entry);
      return this._authJson({ ok: true });
    }
    // Email→salon index for cross-salon login (adaptive sign-in, Part B). Holds
    // ONLY email→slug — no password/hash — so a leak of this key reveals which
    // salon an email maps to, but a login there still requires the password.
    // Called after every owner-credential set (operator create/reset, signup
    // approve); appends + dedupes so one email can map to several salons.
    if (url.pathname === '/registry/index-owner' && request.method === 'POST') {
      let b = {}; try { b = await request.json(); } catch {}
      const email = String(b.email || '').trim().toLowerCase();
      const slug  = String(b.slug || '').trim();
      if (!email || !slug) return this._authJson({ error: 'bad request' }, 400);
      const key = 'owneremail:' + email;
      const rec = (await this.state.storage.get(key)) || { slugs: [] };
      if (!rec.slugs.includes(slug)) rec.slugs.push(slug);
      await this.state.storage.put(key, rec);
      return this._authJson({ ok: true });
    }
    // ── SaaS billing storage (registry instance only — reached solely via registryStub;
    // the Worker 404s /bdo/* on its public surface, and a client addressing its OWN salon
    // DO here writes only harmless keys the Worker never reads from a salon instance) ──
    if (url.pathname === '/bdo/flags-get') {
      const f = (await this.state.storage.get('bflags')) || {};
      return this._authJson({ flags: { enforcementEnabled: f.enforcementEnabled === true, selfserveBillingEnabled: f.selfserveBillingEnabled === true, ...(f.helcimPlanId ? { helcimPlanId: f.helcimPlanId } : {}) } });
    }
    if (url.pathname === '/bdo/flags-put' && request.method === 'POST') {
      let b = {}; try { b = await request.json(); } catch {}
      const f = (await this.state.storage.get('bflags')) || { enforcementEnabled: false, selfserveBillingEnabled: false };
      if (typeof b.enforcementEnabled === 'boolean') f.enforcementEnabled = b.enforcementEnabled;
      if (typeof b.selfserveBillingEnabled === 'boolean') f.selfserveBillingEnabled = b.selfserveBillingEnabled;
      if (typeof b.helcimPlanId === 'number' || typeof b.helcimPlanId === 'string') f.helcimPlanId = b.helcimPlanId;
      await this.state.storage.put('bflags', f);
      return this._authJson({ ok: true, flags: { enforcementEnabled: f.enforcementEnabled === true, selfserveBillingEnabled: f.selfserveBillingEnabled === true } });
    }
    if (url.pathname === '/bdo/plans-get') {
      const map = await this.state.storage.list({ prefix: 'bplan:' });
      return this._authJson({ plans: [...map.values()] });
    }
    if (url.pathname === '/bdo/plan-put' && request.method === 'POST') {
      let b = {}; try { b = await request.json(); } catch {}
      if (!b.plan || !b.plan.planId) return this._authJson({ error: 'bad plan' }, 400);
      await this.state.storage.put('bplan:' + b.plan.planId, b.plan);
      return this._authJson({ ok: true });
    }
    if (url.pathname === '/bdo/accounts-get') {
      const map = await this.state.storage.list({ prefix: 'billing:' });
      return this._authJson({ accounts: [...map.values()] });
    }
    if (url.pathname === '/bdo/account-get') {
      const id = url.searchParams.get('id') || '';
      return this._authJson({ account: (await this.state.storage.get('billing:' + id)) || null });
    }
    if (url.pathname === '/bdo/account-put' && request.method === 'POST') {
      let b = {}; try { b = await request.json(); } catch {}
      if (!b.account || !b.account.accountId) return this._authJson({ error: 'bad account' }, 400);
      await this.state.storage.put('billing:' + b.account.accountId, b.account);
      return this._authJson({ ok: true });
    }
    // HelcimPay verify sessions: pay-put stores {secretToken, slug, ts} keyed by checkoutToken;
    // pay-take is take-AND-delete so a checkout token can only ever validate once.
    if (url.pathname === '/bdo/pay-put' && request.method === 'POST') {
      let b = {}; try { b = await request.json(); } catch {}
      if (!b.token || !b.record) return this._authJson({ error: 'bad request' }, 400);
      await this.state.storage.put('bpay:' + b.token, b.record);
      return this._authJson({ ok: true });
    }
    if (url.pathname === '/bdo/pay-take' && request.method === 'POST') {
      let b = {}; try { b = await request.json(); } catch {}
      const key = 'bpay:' + (b.token || '');
      const rec = (await this.state.storage.get(key)) || null;
      if (rec) await this.state.storage.delete(key);
      return this._authJson({ record: rec });
    }
    // Demo lead intake — mirrors /signup/request's rate-limit + queue-cap shape, but
    // with its OWN rl prefix (dreqrl:) so demo spam can't throttle real signups or vice
    // versa. No password/slug/ownerRecord — it's a lead, not an account.
    if (url.pathname === '/demo/request' && request.method === 'POST') {
      let b = {}; try { b = await request.json(); } catch {}
      const v = validateDemoRequest(b);
      if (!v.ok) return new Response(JSON.stringify({ error: v.error }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const ip = request.headers.get('CF-Connecting-IP') || 'local';
      const rlKey = 'dreqrl:' + ip, now = Date.now();
      const rl = (await this.state.storage.get(rlKey)) || { since: now, n: 0 };
      if (now - rl.since > 3600000) { rl.since = now; rl.n = 0; }
      if (rl.n >= 5) return new Response(JSON.stringify({ error: 'Too many requests — please try again later.' }), { status: 429, headers: { 'Content-Type': 'application/json' } });
      let pending = 0;
      const existing = await this.state.storage.list({ prefix: 'demo:' });
      for (const [, x] of existing) if (x && x.status === 'pending') pending++;
      if (pending >= 200) return new Response(JSON.stringify({ error: 'The request queue is full — please try again later.' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      rl.n++; await this.state.storage.put(rlKey, rl);
      const val = v.value;
      const id = crypto.randomUUID();
      await this.state.storage.put('demo:' + id, {
        id, status: 'pending', name: val.name, email: val.email, phone: val.phone,
        lookingFor: val.lookingFor, createdAt: now, decidedAt: 0, ip,
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/signup/request' && request.method === 'POST') {
      let b = {}; try { b = await request.json(); } catch {}
      const v = validateSignupRequest(b);
      if (!v.ok) return new Response(JSON.stringify({ error: v.error }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const ip = request.headers.get('CF-Connecting-IP') || 'local';
      const rlKey = 'sreqrl:' + ip, now = Date.now();
      const rl = (await this.state.storage.get(rlKey)) || { since: now, n: 0 };
      if (now - rl.since > 3600000) { rl.since = now; rl.n = 0; }
      if (rl.n >= 5) return new Response(JSON.stringify({ error: 'Too many requests — please try again later.' }), { status: 429, headers: { 'Content-Type': 'application/json' } });
      let pending = 0, perEmail = 0;
      const existing = await this.state.storage.list({ prefix: 'signup:' });
      for (const [, x] of existing) if (x && x.status === 'pending') { pending++; if (x.email && x.email === v.value.email) perEmail++; }
      if (pending >= 200) return new Response(JSON.stringify({ error: 'The request queue is full — please try again later.' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      // Per-email pending cap: one owner can't pile up open requests (blunts duplicate-signup spam
      // without penalizing unrelated salons behind the same shared IP). Broad rotation abuse still
      // needs the operator to clear the queue — a known limitation. (`ip` is stored for operator triage.)
      if (perEmail >= 3) return new Response(JSON.stringify({ error: 'You already have requests pending — please wait for a reply.' }), { status: 429, headers: { 'Content-Type': 'application/json' } });
      rl.n++; await this.state.storage.put(rlKey, rl);
      const val = v.value;
      const cred = await hashPassword(val.password);
      const ownerRecord = { email: val.email, name: val.ownerName, role: 'owner', ...cred };
      let base = slugify(val.business), cand = base, n = 2;
      while (RESERVED_SLUGS.has(cand) || (await this.state.storage.get('salon:' + cand))) cand = base + '-' + n++;
      const id = crypto.randomUUID();
      await this.state.storage.put('signup:' + id, {
        id, status: 'pending', business: val.business, ownerName: val.ownerName, email: val.email,
        phone: val.phone, note: val.note, ownerRecord, proposedSlug: cand, finalSlug: '', createdAt: now, decidedAt: 0, ip,
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    // ── Provision: seed a brand-new salon's starter config ──────────────────────
    if (url.pathname === '/provision/seed' && request.method === 'POST') {
      let b = {}; try { b = await request.json(); } catch {}
      return this.provisionSeed(b);
    }
    if (url.pathname === '/provision/owner' && request.method === 'POST') {
      let b = {}; try { b = await request.json(); } catch {}
      if (!b.record || !b.record.email || !b.record.hash) return new Response('{"error":"bad record"}', { status: 400, headers: { 'Content-Type': 'application/json' } });
      await this.state.storage.put('owner:' + String(b.record.email).toLowerCase(), b.record);
      return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Current destination for the public review-QR redirect (the Worker's /r route
    // calls this). Single config key, written by Settings via the normal config.set op.
    if (url.pathname === '/review-target') {
      const v = await this.state.storage.get('config:review_url');
      return new Response(JSON.stringify({ url: typeof v === 'string' ? v : '' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }

    // HTTP fallback API (used by the client when the WebSocket is unavailable)
    if (url.pathname === '/state/snapshot') {
      const snap = await this.buildSnapshot();
      return new Response(JSON.stringify(snap), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.pathname === '/state/mutate' && request.method === 'POST') {
      let msg;
      try { msg = await request.json(); } catch { return new Response(JSON.stringify({ error: 'bad json' }), { status: 400 }); }
      const res = await this.applyMutation(msg, null);
      return new Response(JSON.stringify(res), {
        status: res.error ? 400 : 200, headers: { 'Content-Type': 'application/json' },
      });
    }

    // Atomic manager-PIN set (operator console). The read + merge + write all happen inside
    // this single-threaded DO handler, so unlike a worker-side snapshot-then-mutate there is
    // no read-modify-write gap for a concurrent fd_users edit to be clobbered. Stamped, so it
    // goes through the normal config stale-write guard + broadcast in applyMutation.
    if (url.pathname === '/provision/managerpin' && request.method === 'POST') {
      let b = {}; try { b = await request.json(); } catch {}
      const pin = String(b.pin || '').trim();
      if (!/^\d{4,8}$/.test(pin)) return new Response('{"error":"bad pin"}', { status: 400, headers: { 'Content-Type': 'application/json' } });
      const fd = (await this.state.storage.get('config:fd_users')) || [];
      const next = fd.some(u => u.id === 'fd-manager')
        ? fd.map(u => u.id === 'fd-manager' ? { ...u, pin, role: u.role || 'admin' } : u)
        : [{ id: 'fd-manager', name: 'Manager', pin, role: 'admin' }, ...fd];
      await this.applyMutation({ op: 'config.set', payload: { key: 'fd_users', value: next, updatedAt: Date.now(), updatedBy: 'operator' } }, null);
      return new Response(JSON.stringify({ ok: true, pin }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/state/backups') {
      return new Response(JSON.stringify(await this.listBackups()), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/state/backup-now' && request.method === 'POST') {
      return new Response(JSON.stringify(await this.backupNow()), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/state/restore' && request.method === 'POST') {
      let body = {}; try { body = await request.json(); } catch {}
      if (!body.confirm) return new Response(JSON.stringify({ error: 'restore requires { confirm: true }' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      if (!this.env.RESTORE_TOKEN || !safeEqual(body.token, this.env.RESTORE_TOKEN)) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      const res = await this.restoreFromBackup(body.key);
      return new Response(JSON.stringify(res), { status: res.error ? 400 : 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Factory reset: wipe ALL state to an empty system. Token-gated + requires
    // { confirm:true }. Takes a safety snapshot to R2 first (recoverable via /state/restore).
    if (url.pathname === '/state/reset' && request.method === 'POST') {
      let body = {}; try { body = await request.json(); } catch {}
      if (!body.confirm) return new Response(JSON.stringify({ error: 'reset requires { confirm: true }' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      if (!this.env.RESTORE_TOKEN || !safeEqual(body.token, this.env.RESTORE_TOKEN)) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      const res = await this.factoryReset();
      return new Response(JSON.stringify(res), { status: res.error ? 400 : 200, headers: { 'Content-Type': 'application/json' } });
    }

    // One-time cleanup of legacy un-prefixed backups. Reached via the worker /state/
    // forward (so §13 app-auth applies) and additionally RESTORE_TOKEN-gated, like
    // /state/restore and /state/reset. Bucket-wide; run once from any salon.
    if (url.pathname === '/state/prune-legacy' && request.method === 'POST') {
      let body = {}; try { body = await request.json(); } catch {}
      if (!this.env.RESTORE_TOKEN || !safeEqual(body.token, this.env.RESTORE_TOKEN)) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      const res = await this.pruneLegacyBackups();
      return new Response(JSON.stringify(res), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // ── Google Calendar token store (server-only) ───────────────────────────────
    // Single blob { refresh, access, pending }. Only the Worker's /gcal/* handlers call
    // this (via the stub). 'gcal:blob' is NOT a buildSnapshot prefix, so the refresh
    // token never reaches clients.
    if (url.pathname === '/gcal/blob') {
      if (request.method === 'PUT') { let b = {}; try { b = await request.json(); } catch {} await this.state.storage.put('gcal:blob', b); return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } }); }
      const b = (await this.state.storage.get('gcal:blob')) || {};
      return new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } });
    }

    // ── Web Push subscriptions (per tech) ───────────────────────────────────────
    if (url.pathname === '/push/subscribe' && request.method === 'POST') {
      let body = {}; try { body = await request.json(); } catch {}
      const { techId, subscription } = body;
      if (!techId || !subscription || !subscription.endpoint) return new Response(JSON.stringify({ error: 'techId + subscription required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const hash = await pushKeyHash(subscription.endpoint);
      await this.state.storage.put('push:' + techId + ':' + hash, subscription);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/push/unsubscribe' && request.method === 'POST') {
      let body = {}; try { body = await request.json(); } catch {}
      if (body.techId && body.endpoint) await this.state.storage.delete('push:' + body.techId + ':' + (await pushKeyHash(body.endpoint)));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    // POST /push/notify { techIds|techId, title, body, tag } — app-triggered notification
    // (e.g. the dashboard booked a new appointment for a tech). Lengths capped; best-effort.
    if (url.pathname === '/push/notify' && request.method === 'POST') {
      let body = {}; try { body = await request.json(); } catch {}
      const techIds = [...new Set([...(Array.isArray(body.techIds) ? body.techIds : []), ...(body.techId ? [body.techId] : [])])]
        .map(String).filter(Boolean).slice(0, 20);
      if (techIds.length === 0) return new Response(JSON.stringify({ error: 'techIds required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const payload = {
        title: String(body.title || 'Muse Staff').slice(0, 80),
        body:  String(body.body || '').slice(0, 200),
        tag:   String(body.tag || 'muse-assign').slice(0, 40),
      };
      await Promise.all(techIds.map(t => this.sendPushToTech(t, payload).catch(() => {})));
      return new Response(JSON.stringify({ ok: true, sent: techIds.length }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // ── Helcim terminal result fan-out ──────────────────────────────────────────
    // Called server-side by the /terminal/webhook receiver. Pushes the terminal result to
    // every connected app over the existing WebSocket so the waiting Pay screen finalizes
    // instantly (no polling). NOT a state mutation — it broadcasts a transient envelope.
    if (url.pathname === '/helcim/finalize' && request.method === 'POST') {
      let b = {}; try { b = await request.json(); } catch {}
      if (b && b.invoiceNumber) {
        const msg = JSON.stringify({ type: 'helcim_result', invoiceNumber: b.invoiceNumber, status: b.status || '', transactionId: b.transactionId || null, amount: (b.amount ?? null) });
        this._broadcast(msg);
      }
      return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // ── Automatic error reports (capped, deduped ring buffer + throttled owner push) ──
    // Clients POST uncaught errors / explicit reportError() calls here. Stored as ONE
    // capped array under 'report:errors' (NOT a buildSnapshot prefix → never shipped to
    // clients, so customer data in a stack never leaks to other devices). Deduped by
    // fingerprint (repeats bump a count instead of piling up). A NEW fingerprint or a
    // SERIOUS error pushes the owner at most once/hour per fingerprint — to the 'errors'
    // push id (devices opt in from Settings → Diagnostics). Never fails the client.
    if (url.pathname === '/report' && request.method === 'POST') {
      let body = {}; try { body = await request.json(); } catch {}
      // per-IP throttle: cap reports/minute so a runaway client can't flood the log
      const ip = request.headers.get('CF-Connecting-IP') || 'local';
      const minute = Math.floor(Date.now() / 60000);
      const rlKey = 'reprl:' + ip;
      const rl = (await this.state.storage.get(rlKey)) || { min: 0, n: 0 };
      if (rl.min === minute && rl.n >= 40) return new Response('{"ok":true,"throttled":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      await this.state.storage.put(rlKey, { min: minute, n: rl.min === minute ? rl.n + 1 : 1 });

      const now = Date.now();
      const fp = String(body.fingerprint || body.message || 'unknown').slice(0, 200);
      const serious = !!body.serious;
      const stored = await this.state.storage.get('report:errors');
      const arr = Array.isArray(stored) ? stored : [];
      let entry = arr.find(e => e && e.fingerprint === fp);
      const isNew = !entry;
      if (entry) {
        entry.count = (entry.count || 1) + 1;
        entry.lastAt = now;
        if (serious) entry.serious = true;
      } else {
        entry = {
          fingerprint: fp,
          app:     String(body.app || 'turndesk').slice(0, 20),
          context: String(body.context || '').slice(0, 120),
          message: String(body.message || '').slice(0, 500),
          stack:   String(body.stack || '').slice(0, 4000),
          version: String(body.version || '').slice(0, 20),
          view:    String(body.view || '').slice(0, 80),
          user:    String(body.user || '').slice(0, 60),
          device:  String(body.device || '').slice(0, 60),
          ua:      String(body.ua || '').slice(0, 200),
          online:  body.online !== false,
          breadcrumbs: Array.isArray(body.breadcrumbs) ? body.breadcrumbs.slice(-20).map(b => String(b).slice(0, 140)) : [],
          serious, count: 1, firstAt: now, lastAt: now,
        };
        arr.push(entry);
        if (arr.length > 200) arr.splice(0, arr.length - 200);   // cap — newest kept
      }
      await this.state.storage.put('report:errors', arr);

      // Throttled owner alert: new fingerprint OR serious, at most once/hour per fingerprint.
      try {
        if (isNew || serious) {
          const pk = 'reppush:' + fp;
          const last = (await this.state.storage.get(pk)) || 0;
          if (now - last > 3600000) {
            await this.state.storage.put(pk, now);
            await this.sendPushToTech('errors', {
              title: serious ? '⚠️ TurnDesk — a failure was logged' : 'TurnDesk — a problem was logged',
              body:  (String(body.context ? body.context + ': ' : '') + String(body.message || 'Unknown error')).slice(0, 180),
              tag:   'turndesk-error',
            }).catch(() => {});
          }
        }
      } catch {}
      return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/report' && request.method === 'GET') {
      const stored = await this.state.storage.get('report:errors');
      const arr = Array.isArray(stored) ? stored : [];
      return new Response(JSON.stringify({ errors: arr.slice().reverse() }), { status: 200, headers: { 'Content-Type': 'application/json' } });   // newest first
    }
    if (url.pathname === '/report/clear' && request.method === 'POST') {
      await this.state.storage.put('report:errors', []);
      return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('Expected WebSocket upgrade or /state/*', { status: 426 });
  }

  // Push to every device subscribed for this tech; prune dead subs. With `payload`
  // ({title, body, tag}) the body is aes128gcm-encrypted so the SW shows that message;
  // without it (or if encryption fails) a payload-less ping falls back to the SW's
  // generic assignment text.
  async sendPushToTech(techId, payload) {
    if (!this.env.VAPID_PRIVATE_KEY) return;
    const subs = await this.state.storage.list({ prefix: 'push:' + techId + ':' });
    if (subs.size === 0) return;
    const subject = this.env.VAPID_SUBJECT || 'mailto:admin@musenailandspa.com';
    const pub = this.env.VAPID_PUBLIC_KEY || '';
    const payloadStr = payload ? JSON.stringify(payload) : null;
    await Promise.all([...subs.entries()].map(async ([key, sub]) => {
      try {
        if (!sub || !sub.endpoint) { await this.state.storage.delete(key); return; }
        const jwt = await vapidJwt(this.env.VAPID_PRIVATE_KEY, new URL(sub.endpoint).origin, subject);
        const headers = { Authorization: `vapid t=${jwt}, k=${pub}`, TTL: '2592000' };
        let body;
        if (payloadStr && sub.keys && sub.keys.p256dh && sub.keys.auth) {
          try {
            body = await encryptPushPayload(sub, payloadStr);
            headers['Content-Encoding'] = 'aes128gcm';
            headers['Content-Type'] = 'application/octet-stream';
          } catch { body = undefined; }
        }
        const res = await fetch(sub.endpoint, { method: 'POST', headers, body });
        if (res.status === 404 || res.status === 410) await this.state.storage.delete(key);   // subscription gone
        else if (!res.ok) console.warn('[push]', res.status, 'tech', techId);
      } catch (e) { console.error('[push] send failed:', (e && e.message) || String(e)); }
    }));
  }

  // On a queue.upsert, notify any tech whose techId is NEWLY assigned (present now,
  // absent before) — so a price/status edit doesn't re-ping. Best-effort, non-blocking.
  async _notifyNewAssignments(prev, entry) {
    try {
      if (entry.status === 'paid' || entry.status === 'done') return;
      const techSet = e => new Set(((e && e.assignments) || []).map(a => a.techId).filter(Boolean));
      const before = techSet(prev), after = techSet(entry);
      const newly = [...after].filter(t => !before.has(t));
      if (newly.length === 0) return;
      // Enrich the push with the customer, service(s) and STATION so the tech sees where to go.
      // Labels come from the DO config keys; any read failure degrades to a payload-less ping.
      let stations = [], services = [];
      try { stations = (await this.state.storage.get('config:stations')) || []; } catch {}
      try { services = (await this.state.storage.get('config:services')) || []; } catch {}
      const stnLabel = id => { const d = stations.find(s => s.id === id); return d ? (d.label || d.id) : (id || ''); };
      const svcLabel = id => { const s = services.find(x => x.id === id); return s ? s.label : 'Service'; };
      const first = String(entry.name || 'Guest').split(' ')[0];
      for (const t of newly) {
        const mine = (entry.assignments || []).filter(a => a.techId === t);
        const stn  = stnLabel((mine.find(a => a.station) || {}).station);
        const svcs = [...new Set(mine.map(a => svcLabel(a.serviceId)))].join(', ');
        const text = `${first}${svcs ? ' · ' + svcs : ''}${stn ? ' @ ' + stn : ''}`.slice(0, 200);
        this.sendPushToTech(t, { title: 'New assignment', body: text, tag: 'muse-assign' }).catch(() => {});
      }
    } catch {}
  }

  // On a queue.upsert, notify a tech when the front desk just marked one of their services
  // "Done — tech will price" (newly complete + awaitingPrice). Diffs prev vs new per
  // (techId, serviceId) so a resync / unrelated edit doesn't re-ping. Best-effort, non-blocking.
  async _notifyAwaitingPrice(prev, entry) {
    try {
      if (entry.status === 'paid' || entry.status === 'done') return;
      const awaitingKeys = e => new Set(((e && e.assignments) || [])
        .filter(a => a.techId && a.status === 'complete' && a.awaitingPrice)
        .map(a => a.techId + ' ' + a.serviceId));
      const before = awaitingKeys(prev), after = awaitingKeys(entry);
      const newly = [...after].filter(k => !before.has(k));
      if (newly.length === 0) return;
      let services = [];
      try { services = (await this.state.storage.get('config:services')) || []; } catch {}
      const svcLabel = id => { const s = services.find(x => x.id === id); return s ? s.label : 'Service'; };
      const first = String(entry.name || 'Guest').split(' ')[0];
      const byTech = new Map();
      for (const k of newly) { const [t, sid] = k.split(' '); if (!byTech.has(t)) byTech.set(t, []); byTech.get(t).push(svcLabel(sid)); }
      for (const [t, svcs] of byTech) {
        const text = `${first} · ${[...new Set(svcs)].join(', ')} — add the price`.slice(0, 200);
        this.sendPushToTech(t, { title: 'Price needed', body: text, tag: 'muse-price' }).catch(() => {});
      }
    } catch {}
  }

  // Hibernation message handler: the runtime invokes this when a frame arrives, waking the DO
  // only for real work (hello / mutate). The 20s keepalive ping is auto-responded at the edge
  // (see constructor) and normally never reaches here — the ping branch stays as a correct
  // fallback if a client ever sends one raw. `data` is a string (or ArrayBuffer for binary).
  async webSocketMessage(ws, data) {
    let msg;
    try { msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)); } catch { return; }

    if (msg.type === 'ping') {
      try { ws.send(JSON.stringify({ type: 'pong' })); } catch {}
      return;
    }

    // New protocol: hydrate
    if (msg.type === 'hello') {
      const snap = await this.buildSnapshot();
      try { ws.send(JSON.stringify({ type: 'snapshot', state: snap.state, seq: snap.seq, schemaVersion: snap.schemaVersion })); } catch {}
      return;
    }

    // New protocol: mutate (apply → ack sender → broadcast change to peers)
    if (msg.type === 'mutate') {
      const res = await this.applyMutation(msg, ws);
      try { ws.send(JSON.stringify({ type: 'applied', mutationId: msg.mutationId, seq: res.seq, error: res.error })); } catch {}
      return;
    }
    // Unknown message type: ignore. (The current client only ever sends hello / ping / mutate.)
  }

  // Hibernation close: getWebSockets() drops closed sockets automatically, so there's no Set to
  // maintain — just cleanly close the server end.
  async webSocketClose(ws) { try { ws.close(); } catch {} }

  // Send one frame to every connected client, optionally excluding one socket (the sender of a
  // mutation, so it isn't echoed its own change). Enumerates via getWebSockets() — the
  // hibernation-safe source of truth that survives DO eviction. (Guarded for unit tests.)
  _broadcast(payload, exclude) {
    const peers = this.state.getWebSockets ? this.state.getWebSockets() : [];
    for (const ws of peers) {
      if (ws !== exclude && ws.readyState === 1) { try { ws.send(payload); } catch {} }
    }
  }

  async nextSeq() {
    const cur  = (await this.state.storage.get('meta:seq')) || 0;
    const next = cur + 1;
    await this.state.storage.put('meta:seq', next);
    return next;
  }

  // Apply a mutation to storage, stamp a seq, dedupe by mutationId, broadcast.
  async applyMutation(msg, fromWs) {
    const { op, payload, mutationId } = msg || {};
    if (!op || !payload) return { error: 'missing op or payload' };

    // Idempotency: a replayed mutation (offline outbox) returns the original seq.
    if (mutationId) {
      const seen = await this.state.storage.get('mut:' + mutationId);
      if (seen) return { applied: true, seq: seen, dedup: true };
    }

    let stale = false;
    try {
      switch (op) {
        case 'config.set': {
          // Stale-write guard for config (mirrors queue/record): reject a write strictly OLDER than
          // the stored value for this key, so a stale offline-outbox replay can't revert the catalog /
          // turns roster / settings and re-broadcast the regression. Unstamped/equal writes apply.
          const cts = (typeof payload.updatedAt === 'number') ? payload.updatedAt : null;
          if (cts != null) {
            const prevMeta = await this.state.storage.get('cfgmeta:' + payload.key);
            if (prevMeta && typeof prevMeta.updatedAt === 'number' && cts < prevMeta.updatedAt) { stale = true; break; }
          }
          await this.state.storage.put('config:' + payload.key, payload.value);
          if (cts != null) await this.state.storage.put('cfgmeta:' + payload.key, { updatedAt: cts, updatedBy: payload.updatedBy || null });
          break;
        }
        case 'queue.upsert': {
          const qKey = 'queue:' + payload.entry.id;
          const prevEntry = await this.state.storage.get(qKey);
          if (_isStaleWrite(prevEntry, payload.entry)) { stale = true; break; }   // older copy — don't clobber a newer one
          if (_mergeNewerAssignments(payload.entry, prevEntry)) _deriveEntryStatus(payload.entry);   // 3c: protect a concurrent per-assignment change
          // Preserve the entryPatch guard marker across a whole-entry write (the client entry doesn't
          // carry it) so a later stale entryPatch replay is still rejected (not silently disarmed).
          if (prevEntry && typeof prevEntry._patchedAt === 'number' && typeof payload.entry._patchedAt !== 'number') { payload.entry._patchedAt = prevEntry._patchedAt; payload.entry._patchedBy = prevEntry._patchedBy; }
          await this.state.storage.put(qKey, payload.entry);
          this._notifyNewAssignments(prevEntry, payload.entry);   // push to newly-assigned techs (best-effort)
          this._notifyAwaitingPrice(prevEntry, payload.entry);    // push when a service is newly "awaiting price"
          break;
        }
        case 'queue.assignmentPatch': {
          // 3c: a tech's per-assignment change merged into the CURRENT stored entry, so it can't
          // clobber a concurrent front-desk fee/item/discount edit on the same ticket.
          const e = await this.state.storage.get('queue:' + payload.entryId);
          if (!e || !Array.isArray(e.assignments)) break;
          if (e.status === 'paid' || e.status === 'done') break;   // never let a stale device un-pay
          const idx = e.assignments.findIndex(x => x.serviceId === payload.serviceId && x.techId === payload.techId);
          if (idx < 0) break;                                      // assignment reassigned away — ignore
          // Device-scoped stale-patch guard: reject ONLY a stale replay from the SAME device
          // (updatedBy match) — never a cross-device action, so clock skew between the front desk
          // and a tech phone can't silently drop a genuine Start/Complete/price. Rejecting a
          // same-device older replay keeps the value that device already shows → no divergence.
          const storedAsg = e.assignments[idx];
          if (typeof payload.assignment.updatedAt === 'number' && typeof storedAsg.updatedAt === 'number' &&
              payload.assignment.updatedBy && payload.assignment.updatedBy === storedAsg.updatedBy &&
              payload.assignment.updatedAt < storedAsg.updatedAt) { stale = true; break; }
          e.assignments[idx] = payload.assignment;
          _deriveEntryStatus(e);
          await this.state.storage.put('queue:' + payload.entryId, e);
          break;
        }
        case 'queue.entryPatch': {
          // Entry-level field merge (e.g. the staff app's visit note): apply ONLY the provided
          // fields onto the CURRENT stored entry, so it can't clobber a concurrent front-desk
          // fees/items/discount edit the way a whole-entry queue.upsert would. (Muse v5.36 resync.)
          const e = await this.state.storage.get('queue:' + payload.entryId);
          if (!e) break;
          if (e.status === 'paid' || e.status === 'done') break;   // don't touch a closed ticket
          // Device-scoped stale-patch guard (same rule as assignmentPatch): reject only a
          // same-device older replay; a cross-device edit always applies. Unstamped patches apply.
          // Version lives on _patchedAt/_patchedBy — NOT the entry's own updatedAt/updatedBy (the
          // whole-entry queue.upsert version); reusing those keys would collide with that guard.
          if (typeof payload.updatedAt === 'number' && typeof e._patchedAt === 'number' &&
              payload.updatedBy && payload.updatedBy === e._patchedBy &&
              payload.updatedAt < e._patchedAt) { stale = true; break; }
          const patch = payload.patch || {};
          for (const k of Object.keys(patch)) e[k] = patch[k];
          if (typeof payload.updatedAt === 'number') { e._patchedAt = payload.updatedAt; e._patchedBy = payload.updatedBy || null; }
          await this.state.storage.put('queue:' + payload.entryId, e);
          break;
        }
        case 'queue.remove':
          await this.state.storage.delete('queue:' + payload.id);
          break;
        case 'record.save': {
          const rKey = 'record:' + payload.record.id;
          // Never revive a deleted transaction: a stale paid queue copy on another device can
          // re-fire saveRecord with a fresh updatedAt that passes the stale-write guard. Reject if
          // a deletion marker exists, so a restore from R2 can't bring the deleted sale back.
          if (await this.state.storage.get('deletion:' + payload.record.id)) { stale = true; break; }
          const prevRec = await this.state.storage.get(rKey);
          if (_isStaleWrite(prevRec, payload.record)) { stale = true; break; }   // older copy — keep the newer record (prevents fee-drop)
          await this.state.storage.put(rKey, payload.record);
          break;
        }
        case 'record.delete': {
          const existing = await this.state.storage.get('record:' + payload.id);
          if (existing) await this.state.storage.put('record:' + payload.id, { ...existing, status: 'deleted' });
          await this.state.storage.put('deletion:' + payload.id, {
            id: payload.id, reason: payload.reason || '', by: payload.by || '', at: new Date().toISOString(),
          });
          break;
        }
        case 'giftcard.save': {
          // Stored-value money — guard like records/queue: reject a stale card copy so an offline
          // replay can't clobber a newer balance and re-broadcast the regression.
          const gKey = 'giftcard:' + payload.card.id;
          const prevCard = await this.state.storage.get(gKey);
          if (_isStaleWrite(prevCard, payload.card)) { stale = true; break; }
          await this.state.storage.put(gKey, payload.card);
          break;
        }
        case 'giftcard.delete':
          await this.state.storage.delete('giftcard:' + payload.id);
          break;
        case 'customer.upsert': {
          // Customer directory entity (per-record key, mirrors records). Don't revive a deleted
          // customer, and reject a stale offline copy so it can't clobber a newer edit.
          const cKey = 'customer:' + payload.customer.id;
          if (await this.state.storage.get('custdeletion:' + payload.customer.id)) { stale = true; break; }
          const prevCust = await this.state.storage.get(cKey);
          if (_isStaleWrite(prevCust, payload.customer)) { stale = true; break; }
          await this.state.storage.put(cKey, payload.customer);
          break;
        }
        case 'customer.delete': {
          await this.state.storage.delete('customer:' + payload.id);
          await this.state.storage.put('custdeletion:' + payload.id, { id: payload.id, at: new Date().toISOString() });
          break;
        }
        case 'customer.bulkUpsert': {
          // One-shot import of a batch of customers (the Square import sends ~200 per message).
          // Per-customer guards mirror customer.upsert; one broadcast for the whole batch.
          const list = Array.isArray(payload.customers) ? payload.customers : [];
          for (const cust of list) {
            if (!cust || cust.id == null) continue;
            if (await this.state.storage.get('custdeletion:' + cust.id)) continue;   // don't revive a deleted customer
            const prev = await this.state.storage.get('customer:' + cust.id);
            if (_isStaleWrite(prev, cust)) continue;
            await this.state.storage.put('customer:' + cust.id, cust);
          }
          break;
        }
        case 'customer.bulkDelete': {
          const ids = Array.isArray(payload.ids) ? payload.ids : [];
          for (const id of ids) {
            if (id == null) continue;
            await this.state.storage.delete('customer:' + id);
            await this.state.storage.put('custdeletion:' + id, { id, at: new Date().toISOString() });
          }
          break;
        }
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
        case 'audit.log': {
          // Append-only activity log (who/when/device/action). Each event is its own key
          // so concurrent writes never clobber. Probabilistically prune to the last ~1000.
          if (payload && payload.event && payload.event.id) {
            await this.state.storage.put('audit:' + payload.event.id, payload.event);
            if (Math.random() < 0.1) {
              const keys = [...(await this.state.storage.list({ prefix: 'audit:' })).keys()].sort();
              if (keys.length > 1000) for (const k of keys.slice(0, keys.length - 1000)) await this.state.storage.delete(k);
            }
          }
          break;
        }
        case 'chat.append': {
          // Server-side APPEND for staff chat — the DO serializes its writes, so two
          // people sending at the same instant each append to the current stored array
          // (no last-write-wins clobber, unlike a whole-array config.set). Idempotent by
          // message id (replay/echo-safe); capped by count. Day-freshness is a client
          // display filter (local 4 AM), so no timezone math here.
          const m = payload && payload.message;
          if (!m || !m.id) break;
          const stored = await this.state.storage.get('config:chat_log');
          const arr = Array.isArray(stored) ? stored : [];
          if (arr.some(x => x && x.id === m.id)) break;   // already have it
          arr.push(m);
          if (arr.length > 300) arr.splice(0, arr.length - 300);
          await this.state.storage.put('config:chat_log', arr);
          break;
        }
        default:
          console.warn('[mutate] unknown op:', op);
          return { error: 'unknown op: ' + op };
      }
    } catch (e) {
      console.error('[mutate]', op, 'failed:', (e && e.message) || String(e));
      return { error: 'apply failed: ' + (e && e.message || String(e)) };
    }

    if (stale) {
      // Older-than-stored write: don't persist or broadcast it (peers keep the newer value).
      // Still ack the sender (record the mutationId) so it doesn't retry the stale op forever.
      const seq = await this.nextSeq();
      if (mutationId) await this.state.storage.put('mut:' + mutationId, seq);
      return { applied: true, seq, stale: true };
    }

    const seq = await this.nextSeq();
    if (mutationId) await this.state.storage.put('mut:' + mutationId, seq);

    // Broadcast the change to every OTHER connected client.
    const change = JSON.stringify({ type: 'change', op, payload, seq, device: msg.device || null });
    this._broadcast(change, fromWs);

    await this.ensureBackupScheduled();
    return { applied: true, seq };
  }

  // ── §13 PIN sign-in sessions ───────────────────────────────────────────────
  // Escalating per-IP slow-down (never a hard lockout — the front desk must not
  // be able to lock itself out mid-rush): 3 free misses, then 5s·2^(n−3) capped
  // at 60s between tries. A human who fat-fingers twice never notices; a robot
  // grinding a 10,000-PIN space needs days, and every salvo is visible in logs.
  _authDelayMs(n) { return Math.min(5000 * 2 ** (n - 3), 60000); }
  _authJson(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  }

  async authLogin(request) {
    let body = {}; try { body = await request.json(); } catch {}
    const pin = String(body.pin || '').trim();
    const ip  = request.headers.get('CF-Connecting-IP') || 'local';
    const failKey = 'authfail:' + ip;
    const fail = (await this.state.storage.get(failKey)) || { n: 0, last: 0 };
    if (fail.n >= 3) {
      const wait = this._authDelayMs(fail.n) - (Date.now() - fail.last);
      if (wait > 0) return this._authJson({ error: 'slow_down', retryInSec: Math.ceil(wait / 1000) }, 429);
    }
    const reject = async () => {
      await this.state.storage.put(failKey, { n: fail.n + 1, last: Date.now() });
      const waitSec = fail.n + 1 >= 3 ? Math.ceil(this._authDelayMs(fail.n + 1) / 1000) : 0;
      return this._authJson({ error: 'bad_pin', ...(waitSec ? { retryInSec: waitSec } : {}) }, 401);
    };
    // Owner / manager sign-in: email + password (PBKDF2-hashed, stored in THIS
    // salon's DO). Checked only here, so identical PINs/emails across salons never
    // collide. Shares the per-IP slow-down above.
    const email = String(body.email || '').trim().toLowerCase();
    if (email || body.password != null) {
      const password = String(body.password || '');
      if (!email || !password) return reject();
      const rec = await this.state.storage.get('owner:' + email);
      if (!rec || !(await verifyPassword(password, rec))) return reject();
      await this.state.storage.delete(failKey);
      // Map to the app's existing role vocabulary: owner -> full 'admin' access,
      // manager -> 'manager'. (The owner: record keeps its own owner/manager label.)
      const role2   = rec.role === 'manager' ? 'manager' : 'admin';
      const user2   = { kind: 'owner', id: rec.id || email, name: rec.name || 'Owner', role: role2, email };
      const token2  = crypto.randomUUID() + '-' + Math.random().toString(36).slice(2, 10);
      const expires2 = Date.now() + 30 * 24 * 3600 * 1000;
      await this.state.storage.put('sess:' + token2, { ...user2, created: Date.now(), expires: expires2, device: String(body.device || '').slice(0, 40) });
      return this._authJson({ token: token2, expires: expires2, user: user2 });
    }

    // Master app-admin code: one secret PIN (APP_ADMIN_PIN) that signs in as admin on
    // ANY salon. Checked before the salon's own users + the fresh-system 1234 fallback,
    // so it works whether or not the salon has any staff configured. Shares the per-IP
    // slow-down above. The session name "App Admin" makes it visible in the audit log.
    if (this.env.APP_ADMIN_PIN && pin && safeEqual(pin, this.env.APP_ADMIN_PIN)) {
      await this.state.storage.delete(failKey);
      const au = { kind: 'appadmin', id: 'appadmin', name: 'App Admin', role: 'admin' };
      const tok = crypto.randomUUID() + '-' + Math.random().toString(36).slice(2, 10);
      const exp = Date.now() + 30 * 24 * 3600 * 1000;
      await this.state.storage.put('sess:' + tok, { ...au, created: Date.now(), expires: exp, device: String(body.device || '').slice(0, 40) });
      return this._authJson({ token: tok, expires: exp, user: au });
    }

    if (!/^\d{4,8}$/.test(pin)) return reject();

    const fdUsers  = (await this.state.storage.get('config:fd_users')) || [];
    const staff    = (await this.state.storage.get('config:staff')) || [];
    const inactive = new Set((await this.state.storage.get('config:inactive_staff')) || []);
    const wantId   = body.userId ? String(body.userId) : null;
    let user = null;
    const fd = fdUsers.find(u => String(u.pin) === pin && (!wantId || u.id === wantId));
    if (fd) user = { kind: 'fd', id: fd.id, name: fd.name, role: fd.role || 'frontdesk' };
    if (!user) {
      const t = staff.find(s => s.pin && String(s.pin) === pin && !inactive.has(s.id) && (!wantId || s.id === wantId));
      if (t) user = { kind: 'tech', id: t.id, name: t.name, role: 'tech' };
    }
    // No fresh-system PIN fallback: a brand-new salon has an owner credential (set at
    // provisioning), so it bootstraps via owner email/password, then the first-run prompt
    // sets a real manager PIN. Accepting a fixed "1234" here would be an admin backdoor on
    // any salon whose (public) slug is known — see STRESS-TEST-2026-07-11.md H1.
    if (!user) return reject();

    await this.state.storage.delete(failKey);
    const token   = crypto.randomUUID() + '-' + Math.random().toString(36).slice(2, 10);
    const expires = Date.now() + 30 * 24 * 3600 * 1000;
    await this.state.storage.put('sess:' + token, {
      ...user, created: Date.now(), expires, device: String(body.device || '').slice(0, 40),
    });
    return this._authJson({ token, expires, user });
  }

  async authLogout(request) {
    let body = {}; try { body = await request.json(); } catch {}
    if (body.token) await this.state.storage.delete('sess:' + String(body.token));
    return this._authJson({ ok: true });
  }

  // Set/replace an owner-or-manager credential (email + PBKDF2-hashed password).
  // Setup/seed-only: gated by RESTORE_TOKEN. Never broadcasts (owner: keys are not
  // a snapshot prefix, so they never reach clients), never echoes the password.
  async authOwnerSet(request) {
    let body = {}; try { body = await request.json(); } catch {}
    if (!this.env.RESTORE_TOKEN || !safeEqual(body.token, this.env.RESTORE_TOKEN)) return this._authJson({ error: 'unauthorized' }, 403);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!email || !email.includes('@') || password.length < 6) return this._authJson({ error: 'bad_request' }, 400);
    const cred = await hashPassword(password);
    await this.state.storage.put('owner:' + email, {
      email, name: String(body.name || 'Owner'), role: body.role === 'manager' ? 'manager' : 'owner',
      ...cred, updated: Date.now(),
    });
    return this._authJson({ ok: true });
  }

  // Seed a brand-new salon's starter config. Never overwrites existing config (so a
  // re-provision can't wipe a live salon's menu); only fills keys that are absent.
  async provisionSeed(opts) {
    if (opts && opts.slug) await this._rememberSlug(opts.slug);   // brand-new salon: label its very first backup
    if (opts && opts.template !== false) {
      if ((await this.state.storage.get('config:services')) == null) await this.state.storage.put('config:services', STARTER_SERVICES);
      if ((await this.state.storage.get('config:items'))    == null) await this.state.storage.put('config:items', STARTER_ITEMS);
      if ((await this.state.storage.get('config:fees'))     == null) await this.state.storage.put('config:fees', []);
    }
    // Beta default: no in-app card terminal → cash / manual checkout, so a new salon can never
    // accidentally charge the platform's shared card token. Owner flips to Square/Helcim in Settings.
    if ((await this.state.storage.get('config:payment_processor')) == null) await this.state.storage.put('config:payment_processor', 'none');
    return this._authJson({ ok: true });
  }

  async authCheck(request) {
    let body = {}; try { body = await request.json(); } catch {}
    const token = String(body.token || '');
    const sess  = token ? await this.state.storage.get('sess:' + token) : null;
    if (!sess) return this._authJson({ ok: false });
    if (sess.expires < Date.now()) { await this.state.storage.delete('sess:' + token); return this._authJson({ ok: false }); }
    // Removing a front-desk user / removing-or-deactivating a tech revokes their
    // sessions automatically (within the Worker's ~60s cache) — no extra UI needed.
    // The master 'appadmin' (APP_ADMIN_PIN) session has no staff/user row to revoke
    // against — it's gated by the secret at mint time — so it skips this per-user check
    // (it still expires, and unsetting the secret stops new ones). Without this, an
    // appadmin session is deleted on its first /auth/check. Any lingering legacy
    // 'fallback' session (from the retired 1234 path) now correctly fails this check.
    if (sess.kind !== 'appadmin') {
      if (sess.kind === 'owner') {
        const rec = sess.email ? await this.state.storage.get('owner:' + sess.email) : null;
        if (!rec) { await this.state.storage.delete('sess:' + token); return this._authJson({ ok: false }); }
      } else if (sess.kind === 'fd') {
        const fd = (await this.state.storage.get('config:fd_users')) || [];
        if (!fd.some(u => u.id === sess.id)) { await this.state.storage.delete('sess:' + token); return this._authJson({ ok: false }); }
      } else {
        const staff    = (await this.state.storage.get('config:staff')) || [];
        const inactive = new Set((await this.state.storage.get('config:inactive_staff')) || []);
        if (!staff.some(s => s.id === sess.id) || inactive.has(sess.id)) { await this.state.storage.delete('sess:' + token); return this._authJson({ ok: false }); }
      }
    }
    return this._authJson({ ok: true, user: { kind: sess.kind, id: sess.id, name: sess.name, role: sess.role } });
  }

  // Cross-salon email login (adaptive sign-in, Part B). Only the reserved
  // '__registry__' instance ever receives this (the Worker forwards
  // /auth/find-login there exclusively). Rate-limited per IP (mirrors
  // /signup/request's sreqrl:/rl.n pattern). Looks up owneremail:<email> for
  // candidate slugs and tries the password against each salon's OWN /auth/login
  // in turn — the salon DO validates the PBKDF2 hash and mints a session scoped
  // to itself, so a token returned here is only ever valid on the matched salon.
  // Every failure path (unknown email, no mapping, wrong password on every
  // candidate) returns the SAME generic { ok:false } with status 200 — no
  // enumeration signal in the body or status code.
  async findLogin(request) {
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    const rlKey = 'findrl:' + ip, now = Date.now();
    const rl = (await this.state.storage.get(rlKey)) || { since: now, n: 0 };
    if (now - rl.since > 3600000) { rl.since = now; rl.n = 0; }
    if (rl.n >= 5) {
      // Mirror authLogin's throttle shape ({ error:'slow_down', retryInSec }) so the
      // client's existing slow_down handler shows a wait message instead of falling
      // through to a misleading "incorrect email or password". The limiter is a fixed
      // 1-hour window, so retryInSec can be minutes — the client formats it.
      const retryInSec = Math.max(1, Math.ceil((3600000 - (now - rl.since)) / 1000));
      return this._authJson({ error: 'slow_down', retryInSec }, 429);
    }
    rl.n++; await this.state.storage.put(rlKey, rl);

    let body = {}; try { body = await request.json(); } catch {}
    const email    = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!email || !password) return this._authJson({ ok: false });

    const rec   = await this.state.storage.get('owneremail:' + email);
    const slugs = Array.isArray(rec && rec.slugs) ? rec.slugs : [];
    // Forward the REAL client IP to each salon's /auth/login so its own
    // authfail:<ip> brute-force counter buckets the guess by the attacker's IP —
    // not by 'local', which would let cross-salon guesses dodge the per-IP
    // slow-down entirely. (authLogin reads CF-Connecting-IP for that key.)
    const loginHeaders = { 'Content-Type': 'application/json' };
    if (ip && ip !== 'local') loginHeaders['CF-Connecting-IP'] = ip;
    for (const slug of slugs) {
      try {
        const stub = this.env.SALON_DO.get(this.env.SALON_DO.idFromName(slug));
        const r = await stub.fetch(new Request('https://do/auth/login', {
          method: 'POST', headers: loginHeaders,
          body: JSON.stringify({ email, password }),
        }));
        const j = await r.json().catch(() => ({}));
        if (j && j.token) {
          // Correct password. If the operator has DISABLED this salon, don't hand back a
          // token the disabled-salon guard (appAuthOk) would only 401 on — tell the now-
          // authenticated owner plainly instead of a dead reload. Safe: this branch is
          // reached ONLY after a password match, so a guesser never learns the disabled
          // state. No registry entry (e.g. the directly-seeded demo) counts as active.
          const entry = await this.state.storage.get('salon:' + slug);
          if (entry && entry.status === 'disabled') return this._authJson({ ok: false, error: 'disabled' });
          return this._authJson({ ok: true, slug, token: j.token, expires: j.expires, user: j.user });
        }
      } catch {}   // an unreachable/misbehaving salon DO must never abort the loop — try the rest
    }
    // Timing normalization: an email that maps to NO salon otherwise returns without any
    // PBKDF2 work, making "is this a registered owner?" measurable. Burn one throwaway
    // verify so a miss costs about the same as a hit (defense-in-depth atop the per-IP
    // rate limit; the salon-count timing difference is accepted).
    if (!slugs.length) { try { await verifyPassword(password, _TIMING_DUMMY); } catch {} }
    return this._authJson({ ok: false });
  }

  // Assemble the full state from storage (prefix scans skip mut:/meta: keys).
  async buildSnapshot() {
    const state = { config: {}, configMeta: {}, queue: [], records: [], giftcards: [], customers: [], deletions: [], customerDeletions: [], audit: [], appointments: [], apptDeletions: [] };
    const cfg = await this.state.storage.list({ prefix: 'config:' });
    for (const [k, v] of cfg) state.config[k.slice('config:'.length)] = v;
    const cm = await this.state.storage.list({ prefix: 'cfgmeta:' });
    for (const [k, v] of cm) state.configMeta[k.slice('cfgmeta:'.length)] = v;
    const q = await this.state.storage.list({ prefix: 'queue:' });
    for (const [, v] of q) state.queue.push(v);
    const r = await this.state.storage.list({ prefix: 'record:' });
    for (const [, v] of r) state.records.push(v);
    const g = await this.state.storage.list({ prefix: 'giftcard:' });
    for (const [, v] of g) state.giftcards.push(v);
    const cu = await this.state.storage.list({ prefix: 'customer:' });
    for (const [, v] of cu) state.customers.push(v);
    const cd = await this.state.storage.list({ prefix: 'custdeletion:' });
    for (const [, v] of cd) state.customerDeletions.push(v);
    const ap = await this.state.storage.list({ prefix: 'appt:' });
    for (const [, v] of ap) state.appointments.push(v);
    const apd = await this.state.storage.list({ prefix: 'apptdeletion:' });
    for (const [, v] of apd) state.apptDeletions.push(v);
    const d = await this.state.storage.list({ prefix: 'deletion:' });
    for (const [, v] of d) state.deletions.push(v);
    const al = await this.state.storage.list({ prefix: 'audit:' });
    for (const [, v] of al) state.audit.push(v);
    // Newest first, capped so the snapshot payload stays lean (full history lives in the DO).
    state.audit.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));
    state.audit = state.audit.slice(0, 500);
    const seq = (await this.state.storage.get('meta:seq')) || 0;
    return { state, seq, schemaVersion: this.SCHEMA_VERSION };
  }

  // The DO is addressed by idFromName(slug) but isn't told its slug. Learn it from
  // request traffic and PERSIST it (meta:slug) so the timer-driven alarm() — which
  // runs with no request, possibly on a cold-started instance — can read it back.
  // meta:slug is not a buildSnapshot prefix, so it never reaches clients or backups.
  async _rememberSlug(slug) {
    slug = (slug || '').trim();
    if (!slug || slug === this.slug) return;
    this.slug = slug;
    try { await this.state.storage.put('meta:slug', slug); } catch {}
  }

  // Read the persisted slug. alarm() runs with no request and possibly a cold
  // instance (this.slug empty), so it must fall back to durable storage.
  async _getSlug() {
    if (this.slug) return this.slug;
    const s = await this.state.storage.get('meta:slug');
    this.slug = (typeof s === 'string' && s) ? s : '';
    return this.slug;
  }

  // backups/<slug>/ per salon; legacy backups/ only when the slug is unknown
  // (unreachable for a real backing-up salon — any DO that backs up has taken a
  // slug-bearing request first — but a safe no-regression floor).
  _backupPrefix(slug) { return slug ? 'backups/' + slug + '/' : 'backups/'; }

  async ensureBackupScheduled() {
    const cur = await this.state.storage.getAlarm();
    if (cur === null) await this.state.storage.setAlarm(Date.now() + this.BACKUP_INTERVAL_MS);
  }

  // Periodic backup of the full snapshot to R2 + idempotency-marker pruning.
  async alarm() {
    try {
      const snap = await this.buildSnapshot();
      const ts   = new Date().toISOString().replace(/[:.]/g, '-');
      const slug = await this._getSlug();
      if (this.env.PHOTOS_BUCKET) {
        await this.env.PHOTOS_BUCKET.put(this._backupPrefix(slug) + 'state-' + ts + '.json', JSON.stringify(snap), {
          httpMetadata: { contentType: 'application/json' },
        });
        try { await this.pruneBackups(); } catch (e) { console.error('[retention] prune failed:', (e && e.message) || String(e)); }   // tiered retention (own try — never blocks the backup)
      }
      // Bound the idempotency markers: keep the newest ~2000 by seq.
      const muts = await this.state.storage.list({ prefix: 'mut:' });
      if (muts.size > 4000) {
        const sorted   = [...muts.entries()].sort((a, b) => a[1] - b[1]); // oldest seq first
        const toDelete = sorted.slice(0, sorted.length - 2000).map(e => e[0]);
        for (let i = 0; i < toDelete.length; i += 128) {
          await this.state.storage.delete(toDelete.slice(i, i + 128));
        }
      }
      // §13 housekeeping: drop expired sessions + stale wrong-PIN counters.
      const now = Date.now();
      const sessKeys = await this.state.storage.list({ prefix: 'sess:' });
      const deadSess = [...sessKeys.entries()].filter(([, v]) => !v || v.expires < now).map(([k]) => k);
      for (let i = 0; i < deadSess.length; i += 128) await this.state.storage.delete(deadSess.slice(i, i + 128));
      const failKeys = await this.state.storage.list({ prefix: 'authfail:' });
      const deadFail = [...failKeys.entries()].filter(([, v]) => !v || now - v.last > 3600000).map(([k]) => k);
      for (let i = 0; i < deadFail.length; i += 128) await this.state.storage.delete(deadFail.slice(i, i + 128));
    } catch (e) { console.error('[alarm] backup failed:', (e && e.message) || String(e)); }   // best-effort; re-armed below
    await this.state.storage.setAlarm(Date.now() + this.BACKUP_INTERVAL_MS);
  }

  // List the timestamped snapshots in R2 (newest first). Pages the R2 cursor: a single
  // list() returns at most 1000 objects in ascending key order, so without paging a salon
  // with >1000 snapshots would surface only the OLDEST 1000 and "restore latest" would pick
  // a stale one (STRESS-TEST-2026-07-11.md H2).
  async listBackups() {
    if (!this.env.PHOTOS_BUCKET) return { backups: [], count: 0 };
    const prefix = this._backupPrefix(await this._getSlug());
    const objects = [];
    let cursor;
    do {
      const listed = await this.env.PHOTOS_BUCKET.list({ prefix, cursor });
      for (const o of (listed.objects || [])) objects.push(o);
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    const backups = objects
      .map(o => ({ key: o.key, uploaded: o.uploaded, size: o.size }))
      .sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
    return { backups, count: backups.length };
  }

  // Tiered retention prune (Phase 1) — the grandfather-father-son keep-set from
  // computeBackupKeepSet, replacing the old keep-newest-120. GATED: only deletes when
  // BACKUP_RETENTION === 'on' (otherwise logs what it WOULD delete — safe by default).
  // Only ever deletes within THIS salon's own backups/<slug>/ prefix; the keep-set's hard
  // floor + safety exemption mean the newest points and recovery snapshots are never removed.
  async pruneBackups() {
    const live = this.env.BACKUP_RETENTION === 'on' || this.env.BACKUP_RETENTION === 'true';   // accept either (rest of codebase uses 'true')
    if (!this.env.PHOTOS_BUCKET) return { total: 0, keep: 0, pruned: 0, wouldPrune: 0, live };
    const slug = await this._getSlug();
    if (!slug) return { total: 0, keep: 0, pruned: 0, wouldPrune: 0, live, skipped: 'no-slug' };   // NEVER let a slug-less DO prune the shared backups/ root (cross-tenant safety)
    const { backups } = await this.listBackups();
    const { keep, del } = computeBackupKeepSet(backups, Date.now());
    const prefix = this._backupPrefix(slug);
    const safeDel = del.filter(k => typeof k === 'string' && k.startsWith(prefix));   // only THIS salon's own prefix, never another's
    const batch = safeDel.slice(0, 1000);   // R2 array-delete cap; steady state ~0-1, one-time cleanup ~470
    console.log(`[retention] salon=${prefix} total=${backups.length} keep=${keep.size} prune=${safeDel.length}${batch.length < safeDel.length ? ` (capped ${batch.length}/run)` : ''} mode=${live ? 'LIVE' : 'log-only'}`);
    if (live && batch.length) await this.env.PHOTOS_BUCKET.delete(batch);
    return { total: backups.length, keep: keep.size, pruned: live ? batch.length : 0, wouldPrune: safeDel.length, live };
  }

  // Force a snapshot to R2 right now (used for testing + before a restore).
  async backupNow(opts = {}) {
    const snap = await this.buildSnapshot();
    // 'safety' = a pre-restore/reset recovery point; tagged so retention pruning never deletes it.
    const kind = opts.safety ? 'safety' : 'state';
    const key  = this._backupPrefix(await this._getSlug()) + kind + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    if (this.env.PHOTOS_BUCKET) await this.env.PHOTOS_BUCKET.put(key, JSON.stringify(snap), { httpMetadata: { contentType: 'application/json' } });
    return { backedUp: true, key, seq: snap.seq };
  }

  // One-time cleanup of the pre-namespacing backups (backups/state-*.json), which
  // no per-salon list surfaces anymore. Deletes ONLY keys directly under backups/
  // (no second slash) — never a labeled backups/<slug>/... key. Idempotent; on a
  // very large legacy set, re-run until it returns pruned:0 (single R2 list page).
  async pruneLegacyBackups() {
    if (!this.env.PHOTOS_BUCKET) return { pruned: 0, keys: [] };
    const listed = await this.env.PHOTOS_BUCKET.list({ prefix: 'backups/' });
    const legacy = (listed.objects || [])
      .map(o => o.key)
      .filter(k => k.startsWith('backups/') && !k.slice('backups/'.length).includes('/'));
    for (const k of legacy) await this.env.PHOTOS_BUCKET.delete(k);
    return { pruned: legacy.length, keys: legacy.slice(0, 50) };
  }

  // Disaster recovery: replace ALL state with a backup snapshot from R2.
  // Takes a safety snapshot of current state first, then broadcasts the
  // restored state to every connected client.
  async restoreFromBackup(key) {
    if (!this.env.PHOTOS_BUCKET) return { error: 'no backup storage configured' };
    const slug = await this._getSlug();
    let useKey = key;
    if (!useKey) { const l = await this.listBackups(); useKey = l.backups[0]?.key; }
    if (!useKey) return { error: 'no backup found' };
    // A caller-supplied key must live under THIS salon's own backup prefix — never restore
    // another salon's snapshot into this DO. (Skipped when the DO hasn't learned its slug —
    // a single-tenant/legacy instance with no other tenant to cross into.)
    if (slug && !useKey.startsWith(this._backupPrefix(slug))) return { error: 'backup key is outside this salon' };
    const obj = await this.env.PHOTOS_BUCKET.get(useKey);
    if (!obj) return { error: 'backup not found: ' + useKey };
    let snap; try { snap = JSON.parse(await obj.text()); } catch { return { error: 'backup is not valid JSON' }; }
    const st = snap.state || {};
    await this.backupNow({ safety: true });           // safety snapshot before wiping (retention-exempt)
    // Preserve the durable keys that are intentionally NOT in the snapshot (a password hash / OAuth
    // token must never ride the broadcast channel to clients) — deleteAll() would otherwise erase
    // them for good: owner/manager LOGIN credentials (else the owner is locked out of their own salon
    // after a restore), the Google Calendar refresh token, and staff push subscriptions.
    const preserved = new Map();
    for (const prefix of ['owner:', 'push:']) {
      for (const [k, v] of await this.state.storage.list({ prefix })) preserved.set(k, v);
    }
    const gcalBlob = await this.state.storage.get('gcal:blob');
    if (gcalBlob !== undefined) preserved.set('gcal:blob', gcalBlob);
    await this.state.storage.deleteAll();
    if (slug) await this.state.storage.put('meta:slug', slug);   // deleteAll wiped it; keep our identity
    for (const [k, v] of preserved) await this.state.storage.put(k, v);   // owner login + gcal token + push subs survive the restore
    for (const [k, v] of Object.entries(st.config || {})) await this.state.storage.put('config:' + k, v);
    for (const [k, v] of Object.entries(st.configMeta || {})) await this.state.storage.put('cfgmeta:' + k, v);   // restore the stale-write baseline (else a stale device can clobber restored settings)
    for (const e of (st.queue || []))     await this.state.storage.put('queue:' + String(e.id), e);
    for (const r of (st.records || []))   await this.state.storage.put('record:' + String(r.id), r);
    for (const g of (st.giftcards || [])) await this.state.storage.put('giftcard:' + String(g.id), g);
    for (const c of (st.customers || [])) await this.state.storage.put('customer:' + String(c.id), c);
    for (const a of (st.appointments || [])) await this.state.storage.put('appt:' + String(a.id), a);
    for (const d of (st.deletions || [])) await this.state.storage.put('deletion:' + String(d.id), d);
    for (const c of (st.customerDeletions || [])) await this.state.storage.put('custdeletion:' + String(c.id), c);
    for (const a of (st.apptDeletions || [])) await this.state.storage.put('apptdeletion:' + String(a.id), a);
    for (const ev of (st.audit || [])) { if (ev && ev.id) await this.state.storage.put('audit:' + String(ev.id), ev); }   // restore the audit trail
    await this.state.storage.put('meta:seq', (snap.seq || 0) + 1);
    await this.ensureBackupScheduled();
    const fresh = await this.buildSnapshot();
    const payload = JSON.stringify({ type: 'snapshot', state: fresh.state, seq: fresh.seq, schemaVersion: fresh.schemaVersion });
    this._broadcast(payload);
    return { restored: true, key: useKey, counts: { config: Object.keys(st.config||{}).length, queue: (st.queue||[]).length, records: (st.records||[]).length, giftcards: (st.giftcards||[]).length, customers: (st.customers||[]).length, appointments: (st.appointments||[]).length } };
  }

  // Factory reset: wipe ALL state to an empty system, after a safety snapshot to
  // R2 (recoverable via /state/restore). Broadcasts the empty snapshot so any
  // connected client clears immediately.
  async factoryReset() {
    const slug = await this._getSlug();
    const safety = await this.backupNow({ safety: true });   // recovery point before wiping (retention-exempt)
    await this.state.storage.deleteAll();
    if (slug) await this.state.storage.put('meta:slug', slug);   // deleteAll wiped it; keep our identity
    await this.state.storage.put('meta:seq', 1);
    await this.ensureBackupScheduled();
    const fresh = await this.buildSnapshot();
    const payload = JSON.stringify({ type: 'snapshot', state: fresh.state, seq: fresh.seq, schemaVersion: fresh.schemaVersion });
    this._broadcast(payload);
    return { reset: true, seq: fresh.seq, safetyBackup: safety.key };
  }
}
