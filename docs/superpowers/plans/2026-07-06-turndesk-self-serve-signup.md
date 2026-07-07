# TurnDesk Self-serve Signup + Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a salon owner request their own TurnDesk salon from a public page; the platform owner approves it in the operator console and the salon self-provisions — plus a master admin PIN into any salon and per-salon data export.

**Architecture:** Public approval-gated request → the reserved `__registry__` Durable Object stores a pending `signup:<id>` (password hashed on arrival). The operator console lists pending requests and, on approve, runs the existing provisioning (seed starter menu → set owner credential from the stored hash → registry entry) then marks the request approved. A master `APP_ADMIN_PIN` Worker secret is checked in the salon DO login. Data export streams a salon's snapshot as a download.

**Tech Stack:** Vanilla ES-module PWA (no build step) served by GitHub Pages; Cloudflare Worker + Durable Object (`TurnDeskDO`, bundled by wrangler); Web Crypto PBKDF2 (existing `hashPassword`); `node --test` for pure logic.

## Global Constraints

- No frontend build step; vanilla ES modules; no frameworks. Tailwind CDN utility classes in markup are the norm; app CSS lives in `css/styles.css` (do not add `<style>`/inline CSS to `index.html` beyond the existing Tailwind config block). `operator.html`/`signup.html` are standalone pages and may carry their own `<style>`.
- Client storage keys are namespaced `turndesk_` (shared origin with the live Muse app). Never introduce a `muse_` key.
- Owner-facing copy: sentence case, plain English, no exclamation marks on system text.
- Version bump touches all three together: `js/app/config.js` `APP_VERSION`, `version.json`, `sw.js` `CACHE_NAME`.
- Worker deploy target: account `info@musenailandspa.com`, worker `turndesk`. Confirm with `npx wrangler whoami` before any `wrangler deploy`. Both `git push` and `wrangler deploy` require the owner's explicit OK each time.
- New Worker secret this feature introduces: `APP_ADMIN_PIN` (6 digits). Existing secrets reused: `OPERATOR_TOKEN`, `RESTORE_TOKEN`.
- Verification approach (this repo has no Worker/DO/browser test harness): pure logic gets real `node --test` unit tests under `test/`; Worker/DO/UI is verified with `node --check` + live-API round-trips (PIN-login token for salon routes, `?op=<OPERATOR_TOKEN>` for operator routes) + the `turndesk` preview (launch config `turndesk`, port 5050). The live demo salon slug is `demo`.
- Reuse, do not reimplement: `validateSlug`, `RESERVED_SLUGS`, `registryStub`/`registryGet`, `hashPassword`/`verifyPassword`, `corsHeaders`, the salon DO `/provision/seed` + `/state/snapshot`, the operator console `api()` helper, and the business sign-in screen `screen-signin`.

---

### Task 1: Pure signup helpers (`slugify`, `validateSignupRequest`) — unit tested

**Files:**
- Create: `cloudflare/signup-util.js`
- Test: `test/signup-util.test.js`

**Interfaces:**
- Produces: `slugify(name: string) -> string` (lowercase, hyphenated, 3–32 chars matching `validateSlug`'s regex, falls back to `'salon'`); `validateSignupRequest(body: object) -> { ok: true, value: {business, ownerName, email, password, phone, note} } | { ok: false, error: string }` (all strings trimmed, email lowercased).

- [ ] **Step 1: Write the failing test**

Create `test/signup-util.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, validateSignupRequest } from '../cloudflare/signup-util.js';

test('slugify basics', () => {
  assert.equal(slugify('Lush Nails & Spa'), 'lush-nails-spa');
  assert.equal(slugify('  GlamX  Nails!! '), 'glamx-nails');
  assert.equal(slugify('AB'), 'salon');              // too short → fallback
  assert.equal(slugify(''), 'salon');
  assert.match(slugify('x'.repeat(80)), /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/); // clamped, valid
  assert.equal(slugify('café déjà'), 'cafe-deja');   // unicode folded
});

test('validateSignupRequest accepts a good request', () => {
  const r = validateSignupRequest({ business: ' Lush Nails ', ownerName: 'Mia', email: 'MIA@Lush.com', password: 'secret1', phone: '(909) 555-1212', note: 'hi' });
  assert.equal(r.ok, true);
  assert.equal(r.value.business, 'Lush Nails');
  assert.equal(r.value.email, 'mia@lush.com');
});

test('validateSignupRequest rejects bad input', () => {
  assert.equal(validateSignupRequest({ business: '', ownerName: 'A', email: 'a@b.co', password: 'secret1' }).ok, false);
  assert.equal(validateSignupRequest({ business: 'B', ownerName: '', email: 'a@b.co', password: 'secret1' }).ok, false);
  assert.equal(validateSignupRequest({ business: 'B', ownerName: 'A', email: 'nope', password: 'secret1' }).ok, false);
  assert.equal(validateSignupRequest({ business: 'B', ownerName: 'A', email: 'a@b.co', password: '123' }).ok, false);
  assert.equal(validateSignupRequest({ business: 'B', ownerName: 'A', email: 'a@b.co', password: 'secret1', note: 'x'.repeat(600) }).ok, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /c/Users/cpach/Documents/GitHub/turndesk && node --test test/signup-util.test.js`
Expected: FAIL — `Cannot find module '../cloudflare/signup-util.js'`.

- [ ] **Step 3: Write the implementation**

Create `cloudflare/signup-util.js`:

```js
// Pure helpers for self-serve signup (no Cloudflare APIs → unit-testable + wrangler-bundled into worker.js).
export function slugify(name) {
  let s = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')  // strip accents
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  s = s.slice(0, 32).replace(/-+$/g, '');
  if (s.length < 3) s = 'salon';
  return s;
}

export function validateSignupRequest(body) {
  const b = body || {};
  const business  = String(b.business || '').trim();
  const ownerName = String(b.ownerName || '').trim();
  const email     = String(b.email || '').trim().toLowerCase();
  const password  = String(b.password || '');
  const phone     = String(b.phone || '').trim();
  const note      = String(b.note || '').trim();
  if (business.length < 1 || business.length > 80)   return { ok: false, error: 'Enter your business name.' };
  if (ownerName.length < 1 || ownerName.length > 60) return { ok: false, error: 'Enter your name.' };
  if (email.length > 120 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'Enter a valid email.' };
  if (password.length < 6 || password.length > 200)  return { ok: false, error: 'Password must be at least 6 characters.' };
  if (phone.length > 40)  return { ok: false, error: 'Phone number is too long.' };
  if (note.length > 500)  return { ok: false, error: 'Note is too long.' };
  return { ok: true, value: { business, ownerName, email, password, phone, note } };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/signup-util.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add cloudflare/signup-util.js test/signup-util.test.js
git commit -m "feat(signup): pure slugify + request validation helpers (unit tested)"
```

---

### Task 2: Master admin PIN (`APP_ADMIN_PIN`) in the salon DO login

**Files:**
- Modify: `cloudflare/worker.js` (the `authLogin` method — insert after the owner-email/password block, before `if (!/^\d{4,8}$/.test(pin)) return reject();`)

**Interfaces:**
- Consumes: `this.env.APP_ADMIN_PIN` (secret), `this.state.storage`, `this._authJson`, the `failKey` + `body` already in scope in `authLogin`.
- Produces: a session for `{ kind:'appadmin', id:'appadmin', name:'App Admin', role:'admin' }` when the entered PIN equals the secret, on any salon.

- [ ] **Step 1: Add the admin-PIN check**

In `cloudflare/worker.js`, find in `authLogin` the end of the owner sign-in block (the `if (email || body.password != null) { ... }` that returns `token2`) and the line `if (!/^\d{4,8}$/.test(pin)) return reject();`. Insert between them:

```js
    // Master app-admin code: one secret PIN (APP_ADMIN_PIN) that signs in as admin on
    // ANY salon. Checked before the salon's own users + the fresh-system 1234 fallback,
    // so it works whether or not the salon has any staff configured. Shares the per-IP
    // slow-down above. The session name "App Admin" makes it visible in the audit log.
    if (this.env.APP_ADMIN_PIN && pin && pin === this.env.APP_ADMIN_PIN) {
      await this.state.storage.delete(failKey);
      const au = { kind: 'appadmin', id: 'appadmin', name: 'App Admin', role: 'admin' };
      const tok = crypto.randomUUID() + '-' + Math.random().toString(36).slice(2, 10);
      const exp = Date.now() + 30 * 24 * 3600 * 1000;
      await this.state.storage.put('sess:' + tok, { ...au, created: Date.now(), expires: exp, device: String(body.device || '').slice(0, 40) });
      return this._authJson({ token: tok, expires: exp, user: au });
    }
```

- [ ] **Step 2: Syntax check**

Run: `node --check cloudflare/worker.js`
Expected: no output (valid).

- [ ] **Step 3: Commit**

```bash
git add cloudflare/worker.js
git commit -m "feat(auth): master APP_ADMIN_PIN — admin sign-in on any salon"
```

- [ ] **Step 4: Deploy + live-verify (needs owner OK)**

Set the secret and deploy (confirm account first):
```bash
cd cloudflare && npx wrangler whoami           # must show info@musenailandspa.com
npx wrangler secret put APP_ADMIN_PIN          # owner types a 6-digit code
npx wrangler deploy
```
Verify with a throwaway code the owner sets (do NOT hardcode a real one). Using a shell where `$PIN` holds the code the owner set:
```bash
# admin PIN signs into the demo salon
curl -s -X POST "https://turndesk.musenailandspa.workers.dev/auth/login?salon=demo" \
  -H 'Content-Type: application/json' -d "{\"pin\":\"$PIN\"}" | grep -o '"role":"admin"' && echo "admin OK on demo"
# and into a different salon (isolation → same master key works everywhere)
curl -s -X POST "https://turndesk.musenailandspa.workers.dev/auth/login?salon=glamx-demo" \
  -H 'Content-Type: application/json' -d "{\"pin\":\"$PIN\"}" | grep -o '"name":"App Admin"' && echo "admin OK on glamx-demo"
```
Expected: both print the success line.

---

### Task 3: Public signup request endpoint (Worker edge + registry DO handler)

**Files:**
- Modify: `cloudflare/worker.js` — (a) add `import { slugify, validateSignupRequest } from './signup-util.js';` at the top of the file (with the other module-level code; worker.js is an ES module and wrangler bundles the import); (b) add `POST /signup/request` to `appAuthOk` exemptions and to the salon-guard exemption; (c) add the Worker route that forwards to the registry DO; (d) add the registry DO handler `/signup/request`.

**Interfaces:**
- Consumes: `slugify`, `validateSignupRequest` (Task 1), `hashPassword` (existing), `RESERVED_SLUGS`, `registryStub`, `this.state.storage`.
- Produces: stored `signup:<id>` entries `{ id, status:'pending', business, ownerName, email, phone, note, ownerRecord:{email,name,role,salt,hash,iters}, proposedSlug, finalSlug:'', createdAt, decidedAt:0 }`; public `POST /signup/request` → `{ ok:true }` | `400` | `429` | `503`.

- [ ] **Step 1: Import the helpers**

At the top of `cloudflare/worker.js`, add after the file's opening comment/first `const` block:
```js
import { slugify, validateSignupRequest } from './signup-util.js';
```

- [ ] **Step 2: Exempt `POST /signup/request` from auth + the salon guard**

In `appAuthOk`, next to the other exemptions (after the `/report` POST exemption), add:
```js
  if (path === '/signup/request' && request.method.toUpperCase() === 'POST') return true;  // public: pre-salon, no session yet
```
In `_handle`, the salon-guard line currently reads:
```js
    if (!salonId && path !== '/terminal/webhook' && path !== '/gcal/callback') {
      return json({ error: 'missing salon' }, 400);
    }
```
Change the condition to also allow `/signup/request` (it is salon-agnostic):
```js
    if (!salonId && path !== '/terminal/webhook' && path !== '/gcal/callback' && path !== '/signup/request') {
      return json({ error: 'missing salon' }, 400);
    }
```

- [ ] **Step 3: Add the Worker forward route**

In `_handle`, right after the `/report` forward block, add:
```js
    // ── Public self-serve signup request (approval-gated; nothing provisioned yet) ──
    // Forwarded to the reserved __registry__ DO, which validates + rate-limits + stores
    // the pending request. Forwarding the original request preserves CF-Connecting-IP.
    if (path === '/signup/request' && method === 'POST') {
      const r = await registryStub(env).fetch(request);
      const body = await r.text();
      return new Response(body, { status: r.status, headers: corsHeaders({ 'Content-Type': 'application/json' }) });
    }
```

- [ ] **Step 4: Add the registry DO handler**

In the `TurnDeskDO` `fetch` method (near the other `/registry/*` routes), add:
```js
    if (url.pathname === '/signup/request' && request.method === 'POST') {
      let b = {}; try { b = await request.json(); } catch {}
      const v = validateSignupRequest(b);
      if (!v.ok) return new Response(JSON.stringify({ error: v.error }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const ip = request.headers.get('CF-Connecting-IP') || 'local';
      const rlKey = 'sreqrl:' + ip, now = Date.now();
      const rl = (await this.state.storage.get(rlKey)) || { since: now, n: 0 };
      if (now - rl.since > 3600000) { rl.since = now; rl.n = 0; }
      if (rl.n >= 5) return new Response(JSON.stringify({ error: 'Too many requests — please try again later.' }), { status: 429, headers: { 'Content-Type': 'application/json' } });
      let pending = 0;
      const existing = await this.state.storage.list({ prefix: 'signup:' });
      for (const [, x] of existing) if (x && x.status === 'pending') pending++;
      if (pending >= 200) return new Response(JSON.stringify({ error: 'The request queue is full — please try again later.' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      rl.n++; await this.state.storage.put(rlKey, rl);
      const val = v.value;
      const cred = await hashPassword(val.password);
      const ownerRecord = { email: val.email, name: val.ownerName, role: 'owner', ...cred };
      let base = slugify(val.business), cand = base, n = 2;
      while (RESERVED_SLUGS.has(cand) || (await this.state.storage.get('salon:' + cand))) cand = base + '-' + n++;
      const id = crypto.randomUUID();
      await this.state.storage.put('signup:' + id, {
        id, status: 'pending', business: val.business, ownerName: val.ownerName, email: val.email,
        phone: val.phone, note: val.note, ownerRecord, proposedSlug: cand, finalSlug: '', createdAt: now, decidedAt: 0,
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
```

- [ ] **Step 5: Syntax check**

Run: `node --check cloudflare/worker.js && node --check cloudflare/signup-util.js`
Expected: no output.

- [ ] **Step 6: Commit + deploy (needs owner OK)**

```bash
git add cloudflare/worker.js
git commit -m "feat(signup): public POST /signup/request → registry DO (validate, rate-limit, hash, store)"
cd cloudflare && npx wrangler whoami && npx wrangler deploy
```

- [ ] **Step 7: Live-verify the endpoint**

```bash
W=https://turndesk.musenailandspa.workers.dev
# valid → ok
curl -s -X POST "$W/signup/request" -H 'Content-Type: application/json' \
  -d '{"business":"Plan Test Salon","ownerName":"Test Owner","email":"plantest@example.com","password":"testpass"}'
echo   # expect {"ok":true}
# invalid email → 400
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$W/signup/request" -H 'Content-Type: application/json' \
  -d '{"business":"X","ownerName":"Y","email":"nope","password":"testpass"}'   # expect 400
# no salon slug still accepted (salon-agnostic) — the 200 above already proves it
```
Expected: `{"ok":true}` then `400`. (The stored record is verified end-to-end in Task 4.)

---

### Task 4: Approve/reject provisioning (salon `/provision/owner` + registry list/decide + operator routes)

**Files:**
- Modify: `cloudflare/worker.js` — (a) salon DO `/provision/owner`; (b) registry DO `/registry/signups`, `/registry/signup-get`, `/signup/decide`; (c) operator routes `GET /operator/requests` + `POST /operator/requests/decide` in `handleOperator`.

**Interfaces:**
- Consumes: `validateSlug`, `registryStub`, `registryGet`, the salon `/provision/seed`, Task 3's `signup:<id>` records.
- Produces: `GET /operator/requests` → `{ requests: [...] }` (credential stripped); `POST /operator/requests/decide {id, action, slug?, reason?}` → `{ ok, status }` (reject) or `{ ok, slug }` (approve, salon provisioned); salon DO `/provision/owner {record}` writes `owner:<email>`.

- [ ] **Step 1: Salon DO `/provision/owner`**

In the `TurnDeskDO` `fetch` method, next to `/provision/seed`, add:
```js
    if (url.pathname === '/provision/owner' && request.method === 'POST') {
      let b = {}; try { b = await request.json(); } catch {}
      if (!b.record || !b.record.email || !b.record.hash) return new Response('{"error":"bad record"}', { status: 400, headers: { 'Content-Type': 'application/json' } });
      await this.state.storage.put('owner:' + String(b.record.email).toLowerCase(), b.record);
      return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
```

- [ ] **Step 2: Registry DO list + get + decide**

In the `TurnDeskDO` `fetch` method (near `/registry/list`), add:
```js
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
```

- [ ] **Step 3: Operator routes**

In `handleOperator` (after the existing `/operator/salons` routes, before the final fall-through), add:
```js
  if (path === '/operator/requests' && method === 'GET') {
    const r = await registryStub(env).fetch(new Request('https://do/registry/signups'));
    return json(await r.json().catch(() => ({ requests: [] })));
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
    await salonStub.fetch(new Request('https://do/provision/seed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: rec.business, template: true }) }));
    await salonStub.fetch(new Request('https://do/provision/owner', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ record: rec.ownerRecord }) }));
    const entry = { slug, name: rec.business, status: 'active', ownerEmail: rec.email, plan: '', createdAt: new Date().toISOString() };
    await registryStub(env).fetch(new Request('https://do/registry/put', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entry }) }));
    await registryStub(env).fetch(new Request('https://do/signup/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: rec.id, status: 'approved', finalSlug: slug }) }));
    return json({ ok: true, slug });
  }
```

- [ ] **Step 4: Syntax check**

Run: `node --check cloudflare/worker.js`
Expected: no output.

- [ ] **Step 5: Commit + deploy (needs owner OK)**

```bash
git add cloudflare/worker.js
git commit -m "feat(signup): operator approve/reject → provision salon from a pending request"
cd cloudflare && npx wrangler whoami && npx wrangler deploy
```

- [ ] **Step 6: Live end-to-end verify (submit → list → approve → login → cleanup)**

```bash
W=https://turndesk.musenailandspa.workers.dev; OP=<OPERATOR_TOKEN>
# submit a request
curl -s -X POST "$W/signup/request" -H 'Content-Type: application/json' \
  -d '{"business":"E2E Plan Salon","ownerName":"E2E Owner","email":"e2e-plan@example.com","password":"e2epass1"}' ; echo
# find it in the operator list + grab its id
ID=$(curl -s "$W/operator/requests?op=$OP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).requests.find(x=>x.email==="e2e-plan@example.com");console.log(r&&r.id||"")})')
echo "id=$ID"
# approve (auto slug from "e2e-plan-salon")
curl -s -X POST "$W/operator/requests/decide?op=$OP" -H 'Content-Type: application/json' -d "{\"id\":\"$ID\",\"action\":\"approve\"}" ; echo
# the new owner can sign in with the password they chose
curl -s -X POST "$W/auth/login?salon=e2e-plan-salon" -H 'Content-Type: application/json' \
  -d '{"email":"e2e-plan@example.com","password":"e2epass1"}' | grep -o '"role":"admin"' && echo "owner login OK"
# cleanup: disable the test salon so it doesn't linger in the registry
curl -s -X POST "$W/operator/salons/e2e-plan-salon/status?op=$OP" -H 'Content-Type: application/json' -d '{"status":"disabled"}' ; echo
```
Expected: `{"ok":true}` → an id → `{"ok":true,"slug":"e2e-plan-salon"}` → `owner login OK`.

---

### Task 5: Operator per-salon data export

**Files:**
- Modify: `cloudflare/worker.js` (`handleOperator` — add `GET /operator/export`)

**Interfaces:**
- Consumes: `validateSlug`, the salon DO `/state/snapshot`, `corsHeaders`.
- Produces: `GET /operator/export?slug=<slug>&op=<token>` → the salon's full snapshot JSON as a file download.

- [ ] **Step 1: Add the export route**

In `handleOperator`, add near the other routes:
```js
  if (path === '/operator/export' && method === 'GET') {
    const v = validateSlug(url.searchParams.get('slug'));
    if (!v.ok) return json({ error: v.error }, 400);
    const salonStub = env.SALON_DO.get(env.SALON_DO.idFromName(v.slug));
    const r = await salonStub.fetch(new Request('https://do/state/snapshot'));
    const body = await r.text();
    return new Response(body, { status: r.status, headers: corsHeaders({ 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="turndesk-${v.slug}.json"` }) });
  }
```

- [ ] **Step 2: Syntax check + commit + deploy (needs owner OK)**

```bash
node --check cloudflare/worker.js
git add cloudflare/worker.js
git commit -m "feat(operator): per-salon data export (snapshot download)"
cd cloudflare && npx wrangler whoami && npx wrangler deploy
```

- [ ] **Step 3: Live-verify**

```bash
W=https://turndesk.musenailandspa.workers.dev; OP=<OPERATOR_TOKEN>
curl -s "$W/operator/export?slug=demo&op=$OP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("records",(j.state.records||[]).length,"customers",(j.state.customers||[]).length)})'
```
Expected: prints record + customer counts for the demo salon (proves the full snapshot came back).

---

### Task 6: Public signup page (`signup.html` + `js/app/signup.js`)

**Files:**
- Create: `signup.html`, `js/app/signup.js`

**Interfaces:**
- Consumes: `POST /signup/request` (Task 3).
- Produces: a public request form; `window.submitSignup()` posts it and swaps to a confirmation panel.

- [ ] **Step 1: Create `js/app/signup.js`**

```js
// Public self-serve signup — pre-salon, standalone. Plain fetch (no session/app modules).
const ORIGIN = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? 'http://localhost:8787' : 'https://turndesk.musenailandspa.workers.dev';
const $ = id => document.getElementById(id);
function showErr(m) { const e = $('signup-error'); e.textContent = m; e.classList.remove('hidden'); }

export async function submitSignup() {
  const btn = $('signup-submit');
  $('signup-error').classList.add('hidden');
  const body = {
    business: $('su-business').value, ownerName: $('su-name').value, email: $('su-email').value,
    password: $('su-password').value, phone: $('su-phone').value, note: $('su-note').value,
  };
  if (!body.business.trim() || !body.ownerName.trim() || !body.email.trim() || !body.password) { showErr('Please fill in your business, name, email, and password.'); return; }
  if (body.password.length < 6) { showErr('Password must be at least 6 characters.'); return; }
  if (body.password !== $('su-password2').value) { showErr('Passwords don’t match.'); return; }
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const r = await fetch(ORIGIN + '/signup/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) { $('signup-form').classList.add('hidden'); $('signup-done').classList.remove('hidden'); return; }
    showErr(j.error || 'Something went wrong — please try again.');
  } catch (e) { showErr('Couldn’t reach the server — check your connection and try again.'); }
  finally { btn.disabled = false; btn.textContent = 'Request access'; }
}
window.submitSignup = submitSignup;
```

- [ ] **Step 2: Create `signup.html`**

Copy the `<head>` of `index.html` verbatim (the `<meta>`, Google Fonts links, Tailwind CDN `<script>` + the `tailwind.config` block, and `<link rel="stylesheet" href="css/styles.css">`) so the theme tokens (`bg-surface`, `text-on-surface`, `bg-primary`, fonts) resolve identically, then use this `<body>`:

```html
<body class="bg-surface min-h-screen flex items-center justify-center px-6 py-10">
  <div class="w-full max-w-md">
    <div class="text-center mb-6">
      <h1 class="text-2xl font-headline font-bold text-on-surface">Start your salon on TurnDesk</h1>
      <p class="text-xs font-body text-on-surface-variant mt-1">Request access — we’ll review it and send your salon link.</p>
    </div>

    <div id="signup-form" class="bg-surface-container-lowest rounded-2xl border border-surface-container-high p-6 shadow-sm text-left">
      <label class="text-[11px] font-body font-semibold text-on-surface-variant uppercase tracking-widest">Business name</label>
      <input id="su-business" class="w-full mt-1 mb-3 px-4 h-12 rounded-xl bg-surface-container text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary" placeholder="Lush Nails & Spa">
      <label class="text-[11px] font-body font-semibold text-on-surface-variant uppercase tracking-widest">Your name</label>
      <input id="su-name" class="w-full mt-1 mb-3 px-4 h-12 rounded-xl bg-surface-container text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary" placeholder="Mia">
      <label class="text-[11px] font-body font-semibold text-on-surface-variant uppercase tracking-widest">Email</label>
      <input id="su-email" type="email" autocomplete="email" class="w-full mt-1 mb-3 px-4 h-12 rounded-xl bg-surface-container text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary" placeholder="you@yoursalon.com">
      <label class="text-[11px] font-body font-semibold text-on-surface-variant uppercase tracking-widest">Password</label>
      <input id="su-password" type="password" autocomplete="new-password" class="w-full mt-1 mb-3 px-4 h-12 rounded-xl bg-surface-container text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary" placeholder="At least 6 characters">
      <label class="text-[11px] font-body font-semibold text-on-surface-variant uppercase tracking-widest">Confirm password</label>
      <input id="su-password2" type="password" autocomplete="new-password" class="w-full mt-1 mb-3 px-4 h-12 rounded-xl bg-surface-container text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary" placeholder="Re-enter password">
      <label class="text-[11px] font-body font-semibold text-on-surface-variant uppercase tracking-widest">Phone (optional)</label>
      <input id="su-phone" class="w-full mt-1 mb-3 px-4 h-12 rounded-xl bg-surface-container text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary" placeholder="(909) 555-1212">
      <label class="text-[11px] font-body font-semibold text-on-surface-variant uppercase tracking-widest">Anything you’d like us to know (optional)</label>
      <textarea id="su-note" rows="2" class="w-full mt-1 mb-4 px-4 py-2 rounded-xl bg-surface-container text-sm text-on-surface outline-none focus:ring-2 focus:ring-primary" placeholder="How many techs, when you’d like to start, etc."></textarea>
      <button id="signup-submit" onclick="submitSignup()" class="w-full h-12 rounded-xl bg-primary text-on-primary text-base font-headline font-semibold hover:opacity-90 transition-opacity">Request access</button>
      <p id="signup-error" class="text-xs text-error text-center font-body hidden mt-3"></p>
    </div>

    <div id="signup-done" class="hidden bg-surface-container-lowest rounded-2xl border border-surface-container-high p-8 text-center">
      <span class="material-symbols-outlined text-primary" style="font-size:44px">mark_email_read</span>
      <h2 class="text-lg font-headline font-bold text-on-surface mt-2">Thanks — request received</h2>
      <p class="text-sm font-body text-on-surface-variant mt-1">We’ll review it and send your salon link once you’re approved. You’ll sign in with the email and password you just chose.</p>
    </div>
  </div>
  <script type="module" src="js/app/signup.js"></script>
</body>
```

- [ ] **Step 3: Verify in the preview**

Run: `node --check js/app/signup.js`, then start the `turndesk` preview (port 5050) and load `http://localhost:5050/signup.html`. Confirm (via screenshot / snapshot) the form renders in the app theme; check the browser console has no errors. (A real submit from localhost hits `localhost:8787` which isn't running — that's expected; the live submit is verified in Task 3.)

- [ ] **Step 4: Commit**

```bash
git add signup.html js/app/signup.js
git commit -m "feat(signup): public request form (signup.html + signup.js)"
```

---

### Task 7: Operator console "Pending requests" panel + per-salon export button

**Files:**
- Modify: `operator.html`

**Interfaces:**
- Consumes: `GET /operator/requests`, `POST /operator/requests/decide`, `GET /operator/export` (with `?op=<token>`), and the file's existing `api()`, `msg()`, `esc()`, `token`, `ORIGIN`, `connect()`/`refresh()` helpers.
- Produces: a rendered pending-requests list with Approve (editable slug) / Reject; an Export link per salon.

- [ ] **Step 1: Read `operator.html`** to confirm the exact markup for `#salons`, the `api()` signature, and where `connect()`/`refresh()` render, so the new panel matches the file's style.

- [ ] **Step 2: Add a requests container** — in the `#app` section, above the existing salons list block, add:
```html
      <h2 style="margin-top:24px">Pending requests</h2>
      <div id="requests">Loading…</div>
```

- [ ] **Step 3: Render + wire requests** — add to the `<script>`:
```js
async function refreshRequests() {
  const r = await api('/operator/requests');
  if (r.ok) renderRequests(r.body.requests || []);
}
function renderRequests(reqs) {
  const pend = reqs.filter(x => x.status === 'pending');
  if (!pend.length) { document.getElementById('requests').innerHTML = '<p class="muted">No pending requests.</p>'; return; }
  document.getElementById('requests').innerHTML = pend.map(x => `
    <div class="card" style="margin-bottom:10px">
      <div><strong>${esc(x.business)}</strong> — ${esc(x.ownerName)} · ${esc(x.email)}${x.phone ? ' · ' + esc(x.phone) : ''}</div>
      ${x.note ? `<div class="muted" style="margin-top:4px">${esc(x.note)}</div>` : ''}
      <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
        <input data-slug-for="${esc(x.id)}" value="${esc(x.proposedSlug)}" style="width:180px">
        <button class="btn-primary" data-approve="${esc(x.id)}">Approve</button>
        <button data-reject="${esc(x.id)}">Reject</button>
        <span data-link-for="${esc(x.id)}" class="muted"></span>
      </div>
    </div>`).join('');
}
document.getElementById('requests').addEventListener('click', async (e) => {
  const ap = e.target.closest('[data-approve]'), rj = e.target.closest('[data-reject]');
  if (ap) {
    const id = ap.getAttribute('data-approve');
    const slug = (document.querySelector(`[data-slug-for="${id}"]`) || {}).value || '';
    const r = await api('/operator/requests/decide', { method: 'POST', body: JSON.stringify({ id, action: 'approve', slug }) });
    if (r.ok) { const link = location.origin.includes('github.io') ? `https://musenail.github.io/turndesk/?salon=${r.body.slug}` : `?salon=${r.body.slug}`;
      document.querySelector(`[data-link-for="${id}"]`).innerHTML = 'Approved → <code>' + esc(link) + '</code>'; refreshRequests(); refresh(); }
    else alert(r.body.error || 'Approve failed');
  } else if (rj) {
    const id = rj.getAttribute('data-reject');
    if (!confirm('Reject this request?')) return;
    const r = await api('/operator/requests/decide', { method: 'POST', body: JSON.stringify({ id, action: 'reject' }) });
    if (r.ok) refreshRequests(); else alert(r.body.error || 'Reject failed');
  }
});
```
Then call `refreshRequests()` inside `connect()` right after the salons render.

- [ ] **Step 4: Add an Export link per salon** — in `renderSalons()`, add to each salon row (following the existing action-button markup):
```js
`<a href="${ORIGIN}/operator/export?slug=${encodeURIComponent(s.slug)}&op=${encodeURIComponent(token)}" download>Export data</a>`
```

- [ ] **Step 5: Verify in preview + commit**

Load `http://localhost:5050/operator.html` in the `turndesk` preview, connect with the operator token, confirm the "Pending requests" panel renders (the Task 4 e2e left one, or submit a fresh one), and that an approve shows the link + the salon appears in the list with an "Export data" link. Then:
```bash
git add operator.html
git commit -m "feat(operator): pending-requests approve/reject panel + per-salon export link"
```

---

### Task 8: First-run welcome banner + "request a salon" link on sign-in

**Files:**
- Modify: `index.html` (add a banner element + a link on `screen-signin`), `js/app/main.js` (show/dismiss logic)

**Interfaces:**
- Consumes: synced `getState().config.onboarding_done`, `dispatch('config.set', ...)`.
- Produces: `window.dismissWelcome()`; a banner shown on the dashboard while `onboarding_done` is falsy.

- [ ] **Step 1: Add the banner markup** — in `index.html`, at the top of the dashboard screen (`#screen-desk`, just inside it), add:
```html
      <div id="welcome-banner" class="hidden bg-primary-container text-on-primary-container rounded-xl px-4 py-3 mb-3 flex items-center justify-between gap-3">
        <div class="text-sm font-body">Welcome to TurnDesk — add your services, staff, prices, and logo in <span class="font-semibold">Settings</span> (top bar).</div>
        <button onclick="dismissWelcome()" class="text-on-primary-container/80 hover:text-on-primary-container"><span class="material-symbols-outlined">close</span></button>
      </div>
```

- [ ] **Step 2: Add show/dismiss logic** — in `js/app/main.js`, add near the other window-glue assignments:
```js
window.dismissWelcome = () => { try { sync.dispatch('config.set', { key: 'onboarding_done', value: true }); } catch (e) {} document.getElementById('welcome-banner')?.classList.add('hidden'); };
export function refreshWelcomeBanner() {
  const b = document.getElementById('welcome-banner'); if (!b) return;
  b.classList.toggle('hidden', !!store.getState().config.onboarding_done || !session.getActiveUser());
}
```
Call `refreshWelcomeBanner()` inside the existing `onStateChange` handler and once in `_finishPinLogin`'s success path (via `window.refreshWelcomeBanner?.()` in `auth.js` after `goTo('screen-desk')`), and add `refreshWelcomeBanner` to the `Object.assign(window, {...})` glue in `main.js`.

- [ ] **Step 3: Add the "request a salon" link on `screen-signin`** — in `index.html`, inside `screen-signin` under the kiosk link, add:
```html
    <div class="text-center mt-2"><a href="signup.html" class="text-xs font-body text-on-surface-variant hover:text-primary underline">New here? Request a salon</a></div>
```

- [ ] **Step 4: Verify in preview + commit**

In the `turndesk` preview, sign in to a fresh salon (or eval `dispatch('config.set',{key:'onboarding_done',value:false})` then re-render) and confirm the banner shows and dismiss hides it + persists (re-render stays hidden). Then:
```bash
node --check js/app/main.js
git add index.html js/app/main.js
git commit -m "feat(onboarding): first-run welcome banner + request-a-salon link"
```

---

### Task 9: Version bump, service-worker precache, rollout notes

**Files:**
- Modify: `js/app/config.js`, `version.json`, `sw.js`, `docs/superpowers/specs/2026-07-06-turndesk-self-serve-signup-design.md` (mark shipped)

- [ ] **Step 1: Bump the version trio** — `js/app/config.js` `APP_VERSION = 'td-v0.16'`; `version.json` `{ "version": "td-v0.16" }`; `sw.js` `const CACHE_NAME = 'turndesk-v0.16';`.

- [ ] **Step 2: Precache `signup.html`** — in `sw.js` `PRECACHE_URLS`, add `'/turndesk/signup.html'` and `'/turndesk/js/app/signup.js'` (next to the other page/module entries).

- [ ] **Step 3: Full sweep** — `for f in cloudflare/worker.js cloudflare/signup-util.js js/app/*.js js/app/features/*.js; do node --check "$f"; done` and `node --test test/signup-util.test.js` — all clean/green.

- [ ] **Step 4: Commit + ship (needs owner OK)**

```bash
git add js/app/config.js version.json sw.js docs/superpowers/specs/2026-07-06-turndesk-self-serve-signup-design.md
git commit -m "chore(signup): td-v0.16 — version bump + precache signup.html"
git push origin main                      # GitHub Pages (client)
# Worker already deployed across Tasks 2–5; if any worker change is unshipped: cd cloudflare && npx wrangler deploy
```

- [ ] **Step 5: Post-ship live smoke test** — poll GitHub Pages for `td-v0.16`; open `https://musenail.github.io/turndesk/signup.html`, submit a real request, approve it in the operator console, open the returned salon link, sign in with the chosen credentials, confirm the welcome banner, and export the salon from the operator console. Disable/clean up the smoke-test salon.

---

## Rollout summary

- **Secrets:** `wrangler secret put APP_ADMIN_PIN` (Task 2). No new bindings.
- **Deploys:** Worker (`wrangler deploy`) after Tasks 2–5; client (`git push`) after Tasks 6–9. Both need owner OK; confirm `wrangler whoami` = info@musenailandspa.com first.
- **Out of scope (unchanged):** transactional email/auto-notify, password reset, guided wizard, marketing page, billing, CAPTCHA.
