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
async function appAuthOk(request, url, env, salonId) {
  if (String(env.AUTH_ENFORCED || '').toLowerCase() !== 'true') return true;   // migration mode
  const path = url.pathname;
  if (path === '/auth/login' || path === '/auth/logout') return true;          // the way IN
  if (path === '/auth/owner-set') return true;                  // setup/seed route — self-gated by RESTORE_TOKEN
  if (path === '/terminal/webhook') return true;                // Helcim → HMAC-verified instead
  if (path === '/r')                return true;                // public review-QR redirect (customers scan it)
  if (path === '/gcal/callback')    return true;                // Google redirect → state-nonce checked
  if (path.startsWith('/photos/') && request.method.toUpperCase() === 'GET') return true; // <img> src loads
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

    // Require an explicit salon slug on every route except the two inherently
    // salon-agnostic public callbacks. Replaces the old silent 'muse' default so
    // a forgotten slug fails loudly instead of cross-wiring to another salon.
    if (!salonId && path !== '/terminal/webhook' && path !== '/gcal/callback') {
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
      if (doRes.status >= 500) console.error('[state]', method, path, '->', doRes.status);
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
        const state = crypto.randomUUID();
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
        const code = url.searchParams.get('code'), state = url.searchParams.get('state');
        const blob = await readBlob(), pending = blob.pending;
        const okState = pending && pending.state && pending.state === state && (Date.now() - pending.ts) < 10 * 60 * 1000;
        if (!code || !okState) return htmlMsg('Calendar connect failed (expired or invalid). Close this and tap Connect again.', 400);
        const r = await fetch(GOOGLE_TOKEN_URI, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ code, client_id: clientId, client_secret: env.GCAL_CLIENT_SECRET, redirect_uri: redirect, grant_type: 'authorization_code' }).toString() });
        const tok = await r.json().catch(() => ({}));
        if (!r.ok || !tok.refresh_token) { console.warn('[gcal] code exchange failed', r.status, tok.error); return htmlMsg('Calendar connect failed (' + (tok.error || r.status) + '). Close this and tap Connect again — be sure to tap "Allow".', 400); }
        const ret = pending.return;
        await writeBlob({ refresh: tok.refresh_token, access: { token: tok.access_token, expires: Date.now() + (tok.expires_in || 3600) * 1000 } });
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
      if (r.status >= 400) console.error('[helcim purchase]', r.status, body.slice(0, 300));
      return new Response(body, { status: r.status, headers: corsHeaders({ 'Content-Type': 'application/json' }) });
    }
    if (path === '/helcim/result' && method === 'GET') {
      const inv = url.searchParams.get('invoiceNumber') || '';
      if (!inv) return json({ error: 'invoiceNumber required' }, 400);
      const r = await fetch(`https://api.helcim.com/v2/card-transactions?invoiceNumber=${encodeURIComponent(inv)}`, { headers: { 'api-token': env.HELCIM_API_TOKEN, 'accept': 'application/json' } });
      const body = await r.text();
      if (r.status >= 400) console.error('[helcim result]', r.status, body.slice(0, 200));
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
        console.error('[helcim refund]', r.status, text.slice(0, 400));
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
async function verifyPassword(password, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const { hash } = await hashPassword(password, rec.salt, rec.iters || PBKDF2_ITERS);
  if (hash.length !== rec.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ rec.hash.charCodeAt(i);
  return diff === 0;
}

export class TurnDeskDO {
  constructor(state, env) {
    this.state = state;
    this.env   = env;
    this.sockets = new Set();
    this.SCHEMA_VERSION = 1;
    this.BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
  }

  async fetch(request) {
    const url     = new URL(request.url);
    const upgrade = request.headers.get('Upgrade');

    if (upgrade && upgrade.toLowerCase() === 'websocket') {
      const pair             = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.handleSession(server);
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

    if (url.pathname === '/state/backups') {
      return new Response(JSON.stringify(await this.listBackups()), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/state/backup-now' && request.method === 'POST') {
      return new Response(JSON.stringify(await this.backupNow()), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/state/restore' && request.method === 'POST') {
      let body = {}; try { body = await request.json(); } catch {}
      if (!body.confirm) return new Response(JSON.stringify({ error: 'restore requires { confirm: true }' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      if (this.env.RESTORE_TOKEN && body.token !== this.env.RESTORE_TOKEN) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      const res = await this.restoreFromBackup(body.key);
      return new Response(JSON.stringify(res), { status: res.error ? 400 : 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Factory reset: wipe ALL state to an empty system. Token-gated + requires
    // { confirm:true }. Takes a safety snapshot to R2 first (recoverable via /state/restore).
    if (url.pathname === '/state/reset' && request.method === 'POST') {
      let body = {}; try { body = await request.json(); } catch {}
      if (!body.confirm) return new Response(JSON.stringify({ error: 'reset requires { confirm: true }' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      if (this.env.RESTORE_TOKEN && body.token !== this.env.RESTORE_TOKEN) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      const res = await this.factoryReset();
      return new Response(JSON.stringify(res), { status: res.error ? 400 : 200, headers: { 'Content-Type': 'application/json' } });
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
        for (const socket of this.sockets) { if (socket.readyState === 1) { try { socket.send(msg); } catch {} } }
      }
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

  handleSession(ws) {
    ws.accept();
    this.sockets.add(ws);

    ws.addEventListener('message', async ({ data }) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

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

      // Legacy relay — current production client ({type:'queue'|'config'}).
      // Broadcast verbatim to all OTHER clients. Remove after cutover.
      for (const socket of this.sockets) {
        if (socket !== ws && socket.readyState === 1) {
          try { socket.send(data); } catch {}
        }
      }
    });

    ws.addEventListener('close', () => this.sockets.delete(ws));
    ws.addEventListener('error', () => this.sockets.delete(ws));
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
          e.assignments[idx] = payload.assignment;
          _deriveEntryStatus(e);
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
    for (const socket of this.sockets) {
      if (socket !== fromWs && socket.readyState === 1) {
        try { socket.send(change); } catch {}
      }
    }

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
    // Fresh-system fallback (mirrors the client's Manager fallback, config.js
    // STAFF_PIN): accepted ONLY while no front-desk users exist at all.
    if (!user && !fdUsers.length && pin === '1234') user = { kind: 'fd', id: 'fallback', name: 'Manager', role: 'admin' };
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
    if (this.env.RESTORE_TOKEN && body.token !== this.env.RESTORE_TOKEN) return this._authJson({ error: 'unauthorized' }, 403);
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

  async authCheck(request) {
    let body = {}; try { body = await request.json(); } catch {}
    const token = String(body.token || '');
    const sess  = token ? await this.state.storage.get('sess:' + token) : null;
    if (!sess) return this._authJson({ ok: false });
    if (sess.expires < Date.now()) { await this.state.storage.delete('sess:' + token); return this._authJson({ ok: false }); }
    // Removing a front-desk user / removing-or-deactivating a tech revokes their
    // sessions automatically (within the Worker's ~60s cache) — no extra UI needed.
    if (sess.id !== 'fallback') {
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

  // Assemble the full state from storage (prefix scans skip mut:/meta: keys).
  async buildSnapshot() {
    const state = { config: {}, configMeta: {}, queue: [], records: [], giftcards: [], customers: [], deletions: [], customerDeletions: [], audit: [] };
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

  async ensureBackupScheduled() {
    const cur = await this.state.storage.getAlarm();
    if (cur === null) await this.state.storage.setAlarm(Date.now() + this.BACKUP_INTERVAL_MS);
  }

  // Periodic backup of the full snapshot to R2 + idempotency-marker pruning.
  async alarm() {
    try {
      const snap = await this.buildSnapshot();
      const ts   = new Date().toISOString().replace(/[:.]/g, '-');
      if (this.env.PHOTOS_BUCKET) {
        await this.env.PHOTOS_BUCKET.put('backups/state-' + ts + '.json', JSON.stringify(snap), {
          httpMetadata: { contentType: 'application/json' },
        });
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

  // List the timestamped snapshots in R2 (newest first).
  async listBackups() {
    if (!this.env.PHOTOS_BUCKET) return { backups: [], count: 0 };
    const listed = await this.env.PHOTOS_BUCKET.list({ prefix: 'backups/' });
    const backups = (listed.objects || [])
      .map(o => ({ key: o.key, uploaded: o.uploaded, size: o.size }))
      .sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
    return { backups, count: backups.length };
  }

  // Force a snapshot to R2 right now (used for testing + before a restore).
  async backupNow() {
    const snap = await this.buildSnapshot();
    const key  = 'backups/state-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    if (this.env.PHOTOS_BUCKET) await this.env.PHOTOS_BUCKET.put(key, JSON.stringify(snap), { httpMetadata: { contentType: 'application/json' } });
    return { backedUp: true, key, seq: snap.seq };
  }

  // Disaster recovery: replace ALL state with a backup snapshot from R2.
  // Takes a safety snapshot of current state first, then broadcasts the
  // restored state to every connected client.
  async restoreFromBackup(key) {
    if (!this.env.PHOTOS_BUCKET) return { error: 'no backup storage configured' };
    let useKey = key;
    if (!useKey) { const l = await this.listBackups(); useKey = l.backups[0]?.key; }
    if (!useKey) return { error: 'no backup found' };
    const obj = await this.env.PHOTOS_BUCKET.get(useKey);
    if (!obj) return { error: 'backup not found: ' + useKey };
    let snap; try { snap = JSON.parse(await obj.text()); } catch { return { error: 'backup is not valid JSON' }; }
    const st = snap.state || {};
    await this.backupNow();                           // safety snapshot before wiping
    await this.state.storage.deleteAll();
    for (const [k, v] of Object.entries(st.config || {})) await this.state.storage.put('config:' + k, v);
    for (const e of (st.queue || []))     await this.state.storage.put('queue:' + String(e.id), e);
    for (const r of (st.records || []))   await this.state.storage.put('record:' + String(r.id), r);
    for (const g of (st.giftcards || [])) await this.state.storage.put('giftcard:' + String(g.id), g);
    for (const d of (st.deletions || [])) await this.state.storage.put('deletion:' + String(d.id), d);
    await this.state.storage.put('meta:seq', (snap.seq || 0) + 1);
    await this.ensureBackupScheduled();
    const fresh = await this.buildSnapshot();
    const payload = JSON.stringify({ type: 'snapshot', state: fresh.state, seq: fresh.seq, schemaVersion: fresh.schemaVersion });
    for (const socket of this.sockets) { if (socket.readyState === 1) { try { socket.send(payload); } catch {} } }
    return { restored: true, key: useKey, counts: { config: Object.keys(st.config||{}).length, queue: (st.queue||[]).length, records: (st.records||[]).length, giftcards: (st.giftcards||[]).length } };
  }

  // Factory reset: wipe ALL state to an empty system, after a safety snapshot to
  // R2 (recoverable via /state/restore). Broadcasts the empty snapshot so any
  // connected client clears immediately.
  async factoryReset() {
    const safety = await this.backupNow();            // recovery point before wiping
    await this.state.storage.deleteAll();
    await this.state.storage.put('meta:seq', 1);
    await this.ensureBackupScheduled();
    const fresh = await this.buildSnapshot();
    const payload = JSON.stringify({ type: 'snapshot', state: fresh.state, seq: fresh.seq, schemaVersion: fresh.schemaVersion });
    for (const socket of this.sockets) { if (socket.readyState === 1) { try { socket.send(payload); } catch {} } }
    return { reset: true, seq: fresh.seq, safetyBackup: safety.key };
  }
}
