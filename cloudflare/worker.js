// ── Cloudflare Worker — TurnDesk ──────────────────────────────────────────────
//
// Routes
//   GET/POST/PUT /square/*  — CORS proxy → Square API
//   PUT      /photos/{key}  — Upload binary to R2, returns { url }
//   GET      /photos/{key}  — Serve object from R2 (used as <img src>)
//   DELETE   /photos/{key}  — Delete object from R2
//   POST     /backup/run    — Manually trigger the daily Sheets backup (token-gated; for testing)
//   /ws, /state/*           — Durable Object sync (source of truth)
//
// Google Sheets is now a WRITE-ONLY daily backup target only (the app never reads
// from it). The nightly cron exports yesterday's turns/queue/transactions to a
// fresh Apps Script via SHEETS_URL. The old /sheets config proxy + KV cache are gone.
//
// Required secrets (set via: wrangler secret put <NAME>)
//   SHEETS_URL           Google Apps Script web-app /exec URL (daily backup intake)
//   SQUARE_TOKEN         Square access token
//   RESTORE_TOKEN        (optional) gates /state/restore, /state/reset, and /backup/run
//   ORIGIN_GATE_ENABLED  (optional) "true" turns on the Origin allow-list gate (default off)
//   ALLOWED_ORIGINS      (optional) extra comma-separated origins to allow (prod origin is built in)
//
// Optional environment variables (wrangler.toml [vars])
//   SQUARE_BASE_URL Defaults to https://connect.squareup.com
//
// Required R2 binding (wrangler.toml)
//   [[r2_buckets]]
//   binding     = "PHOTOS_BUCKET"
//   bucket_name = "turndesk-photos"

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

// ── Web Push (VAPID) helpers ────────────────────────────────────────────────────
// Payload-less push: only a VAPID JWT (ES256) is needed — no aes128gcm body
// encryption. (Pure helpers exported for unit tests.)
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

// ── Daily one-way backup → Google Sheets ────────────────────────────────────
// Runs from the Cron Trigger (10:30 UTC = 2:30 AM PST / 3:30 AM PDT — always
// BEFORE the client's 4 AM day-reset, so the queue is still intact). Reads the
// just-finished business day (yesterday, Pacific) from the DO and POSTs a
// detailed, one-way backup to the fresh write-only Apps Script. The app never
// reads this sheet. Records are the financial truth; turns are derived from
// them; the queue is the pre-reset snapshot. Failure is logged, not fatal.
const PACIFIC = 'America/Los_Angeles';
const pacificDate = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: PACIFIC });

async function _runDailyBackup(env, dateOverride) {
  const sheetsUrl = (env.SHEETS_URL || '').trim();
  if (!sheetsUrl) { console.warn('[Backup] SHEETS_URL not set — skipped'); return { skipped: true }; }
  // Shift back 6h so the small-hours run lands on the previous Pacific evening,
  // then take that calendar date — the just-finished business day.
  const targetDate = dateOverride || pacificDate(Date.now() - 6 * 3600 * 1000);
  try {
    const stub    = env.SALON_DO.get(env.SALON_DO.idFromName('demo'));
    const snapRes = await stub.fetch('https://do/state/snapshot');
    const snap    = await snapRes.json();
    const payload = buildDailyBackup(snap.state || {}, targetDate);
    const res = await fetch(sheetsUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ action: 'dailyBackup', ...payload }),
    });
    console.log('[Backup]', targetDate, 'HTTP', res.status,
      `tx=${payload.transactions.rows.length} turns=${payload.turns.rows.length} queue=${payload.queue.rows.length}`);
    return { ok: res.ok, date: targetDate, status: res.status };
  } catch (e) {
    console.error('[Backup] failed:', e && e.message || e);
    return { ok: false, error: String(e) };
  }
}

// Build the one-day backup payload from a DO snapshot. Mirrors the client's
// buildCombinedRecords (merge live `done` queue entries with stored records,
// dedupe by id, drop deleted) so the backup matches what Reports/Transactions
// show — no double-counting.
function buildDailyBackup(state, dateStr) {
  const config    = state.config    || {};
  const queue     = state.queue     || [];
  const records   = state.records   || [];
  const deletions = state.deletions || [];

  const svcById = {}; (config.services || []).forEach(s => { svcById[s.id] = s.label || s.abbr || s.id; });
  const staffById = {}; (config.staff || []).forEach(s => { staffById[s.id] = s.name; });

  const deletedIds = new Set(deletions.map(d => String(d.id)));
  records.filter(r => r.status === 'deleted').forEach(r => deletedIds.add(String(r.id)));

  const liveDone = queue.filter(e => e.status === 'done' && !deletedIds.has(String(e.id)));
  const liveIds  = new Set(liveDone.map(e => String(e.id)));
  const combined = [
    ...liveDone,
    ...records.filter(r => !liveIds.has(String(r.id)) && r.status !== 'deleted' && !deletedIds.has(String(r.id))),
  ];

  const onDay = iso => { try { return iso && pacificDate(new Date(iso).getTime()) === dateStr; } catch { return false; } };
  const svcList   = ids => (ids || []).map(id => svcById[id] || id).join(', ');
  const techList  = a   => [...new Set((a || []).filter(x => x.techId).map(x => staffById[x.techId] || x.techId))].join(', ');
  const fmtTime   = iso => { try { return new Date(iso).toLocaleString('en-US', { timeZone: PACIFIC }); } catch { return iso || ''; } };
  const itemsTot  = r   => (r.items || []).reduce((s, x) => s + (x.price || 0) * (x.qty || 0), 0);
  const feesTot   = r   => (r.fees  || []).reduce((s, x) => s + (x.amount || 0), 0);

  // Transactions (done + refund), matching Reports.
  const txnRows = combined
    .filter(r => onDay(r.checkinTime) && (r.status === 'done' || r.status === 'refund'))
    .sort((a, b) => new Date(a.checkinTime) - new Date(b.checkinTime))
    .map(r => [
      fmtTime(r.checkinTime), r.name || '', r.phone || '', svcList(r.services),
      techList(r.assignments), +itemsTot(r).toFixed(2), +feesTot(r).toFixed(2),
      +(r.discount || 0).toFixed(2), +(r.totalCost || 0).toFixed(2),
      r.status, r.isAppointment ? 'Appointment' : 'Walk-In', r.loggedBy || '',
    ]);

  // Per-tech turns tally (done only), ordered by the rotation.
  const tally = {};
  combined.filter(r => onDay(r.checkinTime) && r.status === 'done').forEach(r => {
    (r.assignments || []).forEach(a => {
      if (!a.techId) return;
      (tally[a.techId] = tally[a.techId] || { count: 0, billed: 0 });
      tally[a.techId].count++; tally[a.techId].billed += a.cost || 0;
    });
  });
  const order = config.turns_order || [];
  const turnRows = Object.keys(tally)
    .sort((a, b) => {
      const ra = order.indexOf(a) === -1 ? Infinity : order.indexOf(a);
      const rb = order.indexOf(b) === -1 ? Infinity : order.indexOf(b);
      return ra - rb;
    })
    .map(id => [staffById[id] || id, tally[id].count, +tally[id].billed.toFixed(2)]);

  // Queue snapshot for the day (all statuses).
  const queueRows = queue
    .filter(e => onDay(e.checkinTime))
    .sort((a, b) => new Date(a.checkinTime) - new Date(b.checkinTime))
    .map(e => [
      fmtTime(e.checkinTime), e.name || '', e.phone || '', svcList(e.services),
      techList(e.assignments), e.status || '', +(e.totalCost || 0).toFixed(2),
      e.isAppointment ? 'Appointment' : 'Walk-In',
    ]);

  const revenue   = txnRows.filter(r => r[9] === 'done').reduce((s, r) => s + (r[8] || 0), 0);
  const customers = txnRows.filter(r => r[9] === 'done').length;

  return {
    date: dateStr,
    summary: { customers, revenue: +revenue.toFixed(2) },
    transactions: { columns: ['Time', 'Name', 'Phone', 'Services', 'Technician(s)', 'Items $', 'Fees $', 'Discount $', 'Total $', 'Status', 'Type', 'Logged By'], rows: txnRows },
    turns:        { columns: ['Technician', 'Customers', 'Billed $'], rows: turnRows },
    queue:        { columns: ['Time', 'Name', 'Phone', 'Services', 'Technician(s)', 'Status', 'Total $', 'Type'], rows: queueRows },
  };
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
    // Multi-salon: each location gets its own DO instance. Defaults to 'demo'
    // so existing clients (which send no ?salon=) are unaffected.
    const salonId = url.searchParams.get('salon') || 'demo';

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Origin gate (no-op unless ORIGIN_GATE_ENABLED = "true"). Covers /ws, /state,
    // /square, /photos, /backup — all share the same allow-list.
    if (!originAllowed(request, env)) return json({ error: 'forbidden origin' }, 403);

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

    // ── Web Push (TurnDesk Staff notifications) ──────────────────────────────────────
    // POST /push/subscribe | /push/unsubscribe — register a tech's push subscription.
    // Forwarded to the DO (same pattern as /state), re-wrapped with CORS.
    if (path.startsWith('/push/')) {
      const stub  = env.SALON_DO.get(env.SALON_DO.idFromName(salonId));
      const doRes = await stub.fetch(request);
      const body  = await doRes.text();
      return new Response(body, { status: doRes.status, headers: corsHeaders({ 'Content-Type': 'application/json' }) });
    }

    // ── Manual backup trigger (testing) ─────────────────────────────────────────
    // POST /backup/run[?date=YYYY-MM-DD] — runs the daily Sheets backup on demand.
    // Token-gated by RESTORE_TOKEN when set (open in dev when unset).
    if (path === '/backup/run' && method === 'POST') {
      let body = {}; try { body = await request.json(); } catch {}
      if (env.RESTORE_TOKEN && body.token !== env.RESTORE_TOKEN) return json({ error: 'unauthorized' }, 403);
      const result = await _runDailyBackup(env, url.searchParams.get('date') || body.date);
      return json(result);
    }

    // ── AI analytics (Google Gemini) ────────────────────────────────────────────
    // POST /ai/ask { question, data } → Gemini generateContent. The API key is held
    // server-side as a secret (GEMINI_API_KEY) so it never ships in the public PWA.
    // Owner setup: `wrangler secret put GEMINI_API_KEY` (free-tier key from aistudio.google.com).
    if (path === '/ai/ask' && method === 'POST') {
      if (!env.GEMINI_API_KEY) return json({ error: 'AI not configured' }, 503);
      let body = {}; try { body = await request.json(); } catch {}
      const question = String(body.question || '').slice(0, 2000);
      const data     = String(body.data || '').slice(0, 24000);
      if (!question) return json({ error: 'No question' }, 400);
      const model = env.GEMINI_MODEL || 'gemini-2.0-flash';
      const prompt = `You are a concise analytics assistant for a nail salon. Answer the owner's question using ONLY the data below. Give specific numbers, be brief, and say if the data can't answer it.\n\nDATA:\n${data}\n\nQUESTION: ${question}`;
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

  async scheduled(event, env, ctx) {
    ctx.waitUntil(_runDailyBackup(env));
  },
};

// ── Durable Object — Single Source of Truth ─────────────────────────────────────
// One instance per salon/tenant (keyed by idFromName(salonId), default 'demo'). Holds canonical app state
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

    return new Response('Expected WebSocket upgrade or /state/*', { status: 426 });
  }

  // Send a payload-less push to every device subscribed for this tech; prune dead subs.
  async sendPushToTech(techId) {
    if (!this.env.VAPID_PRIVATE_KEY) return;
    const subs = await this.state.storage.list({ prefix: 'push:' + techId + ':' });
    if (subs.size === 0) return;
    const subject = this.env.VAPID_SUBJECT || 'mailto:admin@turndesk.app';
    const pub = this.env.VAPID_PUBLIC_KEY || '';
    await Promise.all([...subs.entries()].map(async ([key, sub]) => {
      try {
        if (!sub || !sub.endpoint) { await this.state.storage.delete(key); return; }
        const jwt = await vapidJwt(this.env.VAPID_PRIVATE_KEY, new URL(sub.endpoint).origin, subject);
        const res = await fetch(sub.endpoint, { method: 'POST', headers: { Authorization: `vapid t=${jwt}, k=${pub}`, TTL: '2592000' } });
        if (res.status === 404 || res.status === 410) await this.state.storage.delete(key);   // subscription gone
        else if (!res.ok) console.warn('[push]', res.status, 'tech', techId);
      } catch (e) { console.error('[push] send failed:', (e && e.message) || String(e)); }
    }));
  }

  // On a queue.upsert, notify any tech whose techId is NEWLY assigned (present now,
  // absent before) — so a price/status edit doesn't re-ping. Best-effort, non-blocking.
  _notifyNewAssignments(prev, entry) {
    try {
      if (entry.status === 'paid' || entry.status === 'done') return;
      const techSet = e => new Set(((e && e.assignments) || []).map(a => a.techId).filter(Boolean));
      const before = techSet(prev), after = techSet(entry);
      for (const t of after) if (!before.has(t)) this.sendPushToTech(t).catch(() => {});
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

    try {
      switch (op) {
        case 'config.set':
          await this.state.storage.put('config:' + payload.key, payload.value);
          break;
        case 'queue.upsert': {
          const qKey = 'queue:' + payload.entry.id;
          const prevEntry = await this.state.storage.get(qKey);
          await this.state.storage.put(qKey, payload.entry);
          this._notifyNewAssignments(prevEntry, payload.entry);   // push to newly-assigned techs (best-effort)
          break;
        }
        case 'queue.remove':
          await this.state.storage.delete('queue:' + payload.id);
          break;
        case 'record.save':
          await this.state.storage.put('record:' + payload.record.id, payload.record);
          break;
        case 'record.delete': {
          const existing = await this.state.storage.get('record:' + payload.id);
          if (existing) await this.state.storage.put('record:' + payload.id, { ...existing, status: 'deleted' });
          await this.state.storage.put('deletion:' + payload.id, {
            id: payload.id, reason: payload.reason || '', by: payload.by || '', at: new Date().toISOString(),
          });
          break;
        }
        case 'giftcard.save':
          await this.state.storage.put('giftcard:' + payload.card.id, payload.card);
          break;
        case 'giftcard.delete':
          await this.state.storage.delete('giftcard:' + payload.id);
          break;
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
        default:
          console.warn('[mutate] unknown op:', op);
          return { error: 'unknown op: ' + op };
      }
    } catch (e) {
      console.error('[mutate]', op, 'failed:', (e && e.message) || String(e));
      return { error: 'apply failed: ' + (e && e.message || String(e)) };
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

  // Assemble the full state from storage (prefix scans skip mut:/meta: keys).
  async buildSnapshot() {
    const state = { config: {}, queue: [], records: [], giftcards: [], deletions: [], audit: [] };
    const cfg = await this.state.storage.list({ prefix: 'config:' });
    for (const [k, v] of cfg) state.config[k.slice('config:'.length)] = v;
    const q = await this.state.storage.list({ prefix: 'queue:' });
    for (const [, v] of q) state.queue.push(v);
    const r = await this.state.storage.list({ prefix: 'record:' });
    for (const [, v] of r) state.records.push(v);
    const g = await this.state.storage.list({ prefix: 'giftcard:' });
    for (const [, v] of g) state.giftcards.push(v);
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
