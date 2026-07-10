# TurnDesk — R2 Backups Per Salon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Namespace every salon's R2 backups by slug so backups can't collide and "restore latest" can never load another salon's data.

**Architecture:** The per-salon Durable Object learns its slug from `?salon=`/`X-Salon` on any request and persists it to a durable `meta:slug` key (so the timer-driven `alarm()` on a cold-started DO can read it). All backup write/list/restore paths then use `backups/<slug>/…` instead of the shared `backups/…`. A one-time, `RESTORE_TOKEN`-gated route deletes the pre-namespacing legacy files.

**Tech Stack:** Cloudflare Worker + Durable Object (`cloudflare/worker.js`), R2 bucket `turndesk-photos`, Node's built-in test runner (`node:test`).

**Spec:** `docs/superpowers/specs/2026-07-09-turndesk-r2-backups-per-salon-design.md`

## Global Constraints

- **Worker-only change.** Every edit is in `cloudflare/worker.js` (+ a new test file). No client files, no `version.json` / `sw.js` / `config.js` bump. Deploy is `wrangler deploy`.
- **Run tests with** `node --test --test-force-exit` (the inherited reports/staff suites leave open handles that hang plain `node --test` on Windows).
- **Keep `test/worker-restore.test.js` green** — it sets no slug, so it exercises the legacy/unknown fallback and must continue to pass unchanged.
- **The prune must never delete a labeled key.** Only keys directly under `backups/` with no second `/` (i.e. `backups/state-*.json`) are legacy.
- **`meta:slug` is NOT a `buildSnapshot()` prefix** — do not add it to any snapshot scan; it is DO-identity metadata, never tenant data.
- Repo `turndesk`, branch `fix/r2-backups-per-salon` (already created). Account `info@musenailandspa.com` (`7e47…fb62`) for any deploy.
- **Windows shell note:** the Bash tool resets cwd to the musedashboard repo after each call. Prefix every command with `cd "C:/Users/cpach/Documents/GitHub/turndesk" &&`.

---

### Task 1: DO learns + persists its slug (per request)

**Files:**
- Modify: `cloudflare/worker.js` — constructor (~:1015), top of `async fetch(request)` (~:1023)
- Test: `test/worker-backup-namespace.test.js` (create)

**Interfaces:**
- Produces: `this.slug` (string field, `''` default); `async _rememberSlug(slug)` — trims, no-ops on empty or unchanged, else sets `this.slug` and persists `meta:slug`.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing test**

Create `test/worker-backup-namespace.test.js`:

```js
// Backups are namespaced per salon so a shared R2 bucket can't cross-wire tenants.
// The DO learns its slug from the request and persists it (meta:slug), so the
// timer-driven alarm() can read it on a cold start. See worker.js TurnDeskDO.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnDeskDO } from '../cloudflare/worker.js';

function makeStorage() {
  const m = new Map();
  return {
    _m: m,
    async get(k) { return m.has(k) ? m.get(k) : undefined; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { if (Array.isArray(k)) k.forEach(x => m.delete(x)); else m.delete(k); },
    async deleteAll() { m.clear(); },
    async list({ prefix } = {}) {
      const r = new Map();
      for (const [k, v] of m) if (!prefix || k.startsWith(prefix)) r.set(k, v);
      return r;
    },
    async getAlarm() { return null; },
    async setAlarm() {},
  };
}

// Bucket mock: each put stamps a strictly-increasing `uploaded` so "newest" is
// deterministic; supports delete(key|keys) for the prune test.
function makeBucket() {
  const store = new Map(); let seq = 0;
  return {
    _store: store,
    async put(k, body) { store.set(k, { body, uploaded: new Date(2026, 0, 1, 0, 0, ++seq).toISOString() }); },
    async get(k) { return store.has(k) ? { text: async () => store.get(k).body } : null; },
    async delete(k) { if (Array.isArray(k)) k.forEach(x => store.delete(x)); else store.delete(k); },
    async list({ prefix } = {}) {
      return { objects: [...store.entries()].filter(([k]) => !prefix || k.startsWith(prefix)).map(([k, v]) => ({ key: k, uploaded: v.uploaded, size: v.body.length })) };
    },
  };
}

test('DO learns + persists its slug from the request (?salon= and X-Salon)', async () => {
  const s1 = makeStorage();
  const do1 = new TurnDeskDO({ storage: s1 }, { PHOTOS_BUCKET: makeBucket() });
  await do1.fetch(new Request('https://do/state/snapshot?salon=lush'));
  assert.equal(await s1.get('meta:slug'), 'lush', 'query-param salon must be persisted');

  const s2 = makeStorage();
  const do2 = new TurnDeskDO({ storage: s2 }, { PHOTOS_BUCKET: makeBucket() });
  await do2.fetch(new Request('https://do/state/snapshot', { headers: { 'X-Salon': 'glam' } }));
  assert.equal(await s2.get('meta:slug'), 'glam', 'X-Salon header must be persisted');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "C:/Users/cpach/Documents/GitHub/turndesk" && node --test --test-force-exit test/worker-backup-namespace.test.js`
Expected: FAIL — `meta:slug` is `undefined` (the DO doesn't learn its slug yet).

- [ ] **Step 3: Add the `this.slug` field to the constructor**

In `cloudflare/worker.js`, the constructor (~:1015) currently ends:

```js
    this.SCHEMA_VERSION = 1;
    this.BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
  }
```

Change to:

```js
    this.SCHEMA_VERSION = 1;
    this.BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
    this.slug = '';   // this salon's tenant slug; learned from requests, persisted to meta:slug
  }
```

- [ ] **Step 4: Add the `_rememberSlug` helper**

Add this method inside the class, immediately before `async ensureBackupScheduled()` (~:1836):

```js
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
```

- [ ] **Step 5: Stamp the slug at the top of `fetch`**

The `fetch` method (~:1023) starts:

```js
  async fetch(request) {
    const url     = new URL(request.url);
    const upgrade = request.headers.get('Upgrade');

    if (upgrade && upgrade.toLowerCase() === 'websocket') {
```

Insert the stamp between the `upgrade` line and the `if (upgrade …)` check:

```js
  async fetch(request) {
    const url     = new URL(request.url);
    const upgrade = request.headers.get('Upgrade');

    // Learn this salon's slug from the request (WS carries ?salon=, HTTP carries
    // X-Salon). Runs before the WS upgrade return so socket connects stamp it too.
    const _slug = (url.searchParams.get('salon') || request.headers.get('X-Salon') || '').trim();
    if (_slug) await this._rememberSlug(_slug);

    if (upgrade && upgrade.toLowerCase() === 'websocket') {
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd "C:/Users/cpach/Documents/GitHub/turndesk" && node --test --test-force-exit test/worker-backup-namespace.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd "C:/Users/cpach/Documents/GitHub/turndesk" && git add cloudflare/worker.js test/worker-backup-namespace.test.js && git commit -m "feat(worker): DO learns + persists its salon slug (meta:slug)"
```

---

### Task 2: Namespace backup write/list/restore by slug

**Files:**
- Modify: `cloudflare/worker.js` — `alarm()` (~:1847), `listBackups()` (~:1875), `backupNow()` (~:1885), `restoreFromBackup()` (~:1903 `deleteAll`), `factoryReset()` (~:1926 `deleteAll`); add `_getSlug` + `_backupPrefix` helpers (~:1836)
- Test: `test/worker-backup-namespace.test.js` (add tests)

**Interfaces:**
- Consumes: `this.slug`, `_rememberSlug` (Task 1).
- Produces: `async _getSlug()` → returns `this.slug` or reads `meta:slug` from storage; `_backupPrefix(slug)` → `'backups/' + slug + '/'` when slug set, else `'backups/'`.

- [ ] **Step 1: Write the failing tests**

Append to `test/worker-backup-namespace.test.js`:

```js
test('backups are written under backups/<slug>/', async () => {
  const bucket = makeBucket();
  const s1 = makeStorage(); await s1.put('meta:slug', 'lush');
  const lush = new TurnDeskDO({ storage: s1 }, { PHOTOS_BUCKET: bucket });
  const r1 = await lush.backupNow();
  assert.ok(r1.key.startsWith('backups/lush/state-'), `lush key was ${r1.key}`);

  const s2 = makeStorage(); await s2.put('meta:slug', 'glam');
  const glam = new TurnDeskDO({ storage: s2 }, { PHOTOS_BUCKET: bucket });
  const r2 = await glam.backupNow();
  assert.ok(r2.key.startsWith('backups/glam/state-'), `glam key was ${r2.key}`);
});

test('listBackups is scoped to this salon only', async () => {
  const bucket = makeBucket();
  await bucket.put('backups/lush/state-a.json', '{}');
  await bucket.put('backups/glam/state-b.json', '{}');
  const s1 = makeStorage(); await s1.put('meta:slug', 'lush');
  const lush = new TurnDeskDO({ storage: s1 }, { PHOTOS_BUCKET: bucket });
  const { backups, count } = await lush.listBackups();
  assert.equal(count, 1);
  assert.ok(backups.every(b => b.key.startsWith('backups/lush/')), 'must not list other salons');
});

test('restore(null) loads THIS salon, never a newer other-salon backup', async () => {
  const bucket = makeBucket();
  // lush's backup written FIRST, glam's written SECOND (globally newest).
  const lushSnap = { state: { config: {}, queue: [], records: [{ id: 'l1' }], giftcards: [], customers: [], deletions: [], customerDeletions: [], audit: [], appointments: [], apptDeletions: [] }, seq: 3 };
  const glamSnap = { state: { config: {}, queue: [], records: [{ id: 'g1' }], giftcards: [], customers: [], deletions: [], customerDeletions: [], audit: [], appointments: [], apptDeletions: [] }, seq: 9 };
  await bucket.put('backups/lush/state-2026-07-09T19-00-00-000Z.json', JSON.stringify(lushSnap));
  await bucket.put('backups/glam/state-2026-07-09T20-00-00-000Z.json', JSON.stringify(glamSnap));

  const storage = makeStorage(); await storage.put('meta:slug', 'lush');
  const lush = new TurnDeskDO({ storage }, { PHOTOS_BUCKET: bucket });
  const res = await lush.restoreFromBackup();   // no key → newest of THIS salon
  assert.equal(res.restored, true);
  assert.ok(await storage.get('record:l1'), 'lush data must be restored');
  assert.equal(await storage.get('record:g1'), undefined, 'glam data must NOT leak in');
  assert.equal(await storage.get('meta:slug'), 'lush', 'meta:slug survives deleteAll');
});

test('slug-unknown falls back to the legacy un-prefixed key (no double slash)', async () => {
  const bucket = makeBucket();
  const storage = makeStorage();   // no meta:slug
  const doInst = new TurnDeskDO({ storage }, { PHOTOS_BUCKET: bucket });
  const r = await doInst.backupNow();
  assert.ok(r.key.startsWith('backups/state-'), `expected legacy key, got ${r.key}`);
  assert.ok(!r.key.includes('backups//'), 'must not produce a double slash');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "C:/Users/cpach/Documents/GitHub/turndesk" && node --test --test-force-exit test/worker-backup-namespace.test.js`
Expected: FAIL — keys are `backups/state-…` (not `backups/lush/…`), `listBackups` returns both salons, and `restore(null)` picks glam.

- [ ] **Step 3: Add `_getSlug` + `_backupPrefix` helpers**

Add both methods immediately after `_rememberSlug` (from Task 1), before `ensureBackupScheduled`:

```js
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
```

- [ ] **Step 4: Namespace `alarm()`**

In `alarm()` (~:1847) the write is:

```js
      if (this.env.PHOTOS_BUCKET) {
        await this.env.PHOTOS_BUCKET.put('backups/state-' + ts + '.json', JSON.stringify(snap), {
          httpMetadata: { contentType: 'application/json' },
        });
      }
```

Change to (add the slug read just above, after the `ts` line):

```js
      const slug = await this._getSlug();
      if (this.env.PHOTOS_BUCKET) {
        await this.env.PHOTOS_BUCKET.put(this._backupPrefix(slug) + 'state-' + ts + '.json', JSON.stringify(snap), {
          httpMetadata: { contentType: 'application/json' },
        });
      }
```

- [ ] **Step 5: Namespace `listBackups()`**

`listBackups()` (~:1875):

```js
    const listed = await this.env.PHOTOS_BUCKET.list({ prefix: 'backups/' });
```

Change to:

```js
    const listed = await this.env.PHOTOS_BUCKET.list({ prefix: this._backupPrefix(await this._getSlug()) });
```

- [ ] **Step 6: Namespace `backupNow()`**

`backupNow()` (~:1885):

```js
    const key  = 'backups/state-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
```

Change to:

```js
    const key  = this._backupPrefix(await this._getSlug()) + 'state-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
```

- [ ] **Step 7: Re-persist `meta:slug` after both `deleteAll()` calls**

In `restoreFromBackup()` (~:1903):

```js
    await this.state.storage.deleteAll();
```

Change to:

```js
    await this.state.storage.deleteAll();
    if (this.slug) await this.state.storage.put('meta:slug', this.slug);   // deleteAll wiped it; keep our identity
```

In `factoryReset()` (~:1926):

```js
    await this.state.storage.deleteAll();
    await this.state.storage.put('meta:seq', 1);
```

Change to:

```js
    await this.state.storage.deleteAll();
    if (this.slug) await this.state.storage.put('meta:slug', this.slug);   // deleteAll wiped it; keep our identity
    await this.state.storage.put('meta:seq', 1);
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd "C:/Users/cpach/Documents/GitHub/turndesk" && node --test --test-force-exit test/worker-backup-namespace.test.js`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 9: Confirm the existing restore test still passes**

Run: `cd "C:/Users/cpach/Documents/GitHub/turndesk" && node --test --test-force-exit test/worker-restore.test.js`
Expected: PASS (it sets no slug → exercises the legacy fallback + explicit-key restore).

- [ ] **Step 10: Commit**

```bash
cd "C:/Users/cpach/Documents/GitHub/turndesk" && git add cloudflare/worker.js test/worker-backup-namespace.test.js && git commit -m "feat(worker): namespace R2 backups as backups/<slug>/ + scope list/restore"
```

---

### Task 3: Stamp the slug at provision time

**Files:**
- Modify: `cloudflare/worker.js` — `provisionSeed()` (~:1764), operator create call (~:905), signup-approve call (~:971)
- Test: `test/worker-backup-namespace.test.js` (add a test)

**Interfaces:**
- Consumes: `_rememberSlug` (Task 1).
- Produces: `provisionSeed({ slug, name, template })` now stamps `meta:slug` when `slug` is present.

- [ ] **Step 1: Write the failing test**

Append to `test/worker-backup-namespace.test.js`:

```js
test('provisionSeed stamps the slug so the first backup is already namespaced', async () => {
  const storage = makeStorage();
  const doInst = new TurnDeskDO({ storage }, { PHOTOS_BUCKET: makeBucket() });
  await doInst.provisionSeed({ slug: 'lush', name: 'Lush Nails', template: false });
  assert.equal(await storage.get('meta:slug'), 'lush');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "C:/Users/cpach/Documents/GitHub/turndesk" && node --test --test-force-exit test/worker-backup-namespace.test.js`
Expected: FAIL — `provisionSeed` ignores `slug`, so `meta:slug` is `undefined`.

- [ ] **Step 3: Stamp the slug in `provisionSeed`**

`provisionSeed(opts)` (~:1764) starts:

```js
  async provisionSeed(opts) {
    if (opts && opts.template !== false) {
```

Change to:

```js
  async provisionSeed(opts) {
    if (opts && opts.slug) await this._rememberSlug(opts.slug);   // brand-new salon: label its very first backup
    if (opts && opts.template !== false) {
```

- [ ] **Step 4: Pass the slug from the two operator seed call sites**

Operator create (~:905):

```js
    await salonStub.fetch(new Request('https://do/provision/seed', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: b.name || slug, template: b.template !== false }),
    }));
```

Change the body to include `slug` (in scope as `const slug = v.slug`):

```js
    await salonStub.fetch(new Request('https://do/provision/seed', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, name: b.name || slug, template: b.template !== false }),
    }));
```

Signup approve (~:971):

```js
    await salonStub.fetch(new Request('https://do/provision/seed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: rec.business, template: true }) }));
```

Change the body to include `slug` (in scope as `let slug = v.slug`, uniquified just above):

```js
    await salonStub.fetch(new Request('https://do/provision/seed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug, name: rec.business, template: true }) }));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd "C:/Users/cpach/Documents/GitHub/turndesk" && node --test --test-force-exit test/worker-backup-namespace.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd "C:/Users/cpach/Documents/GitHub/turndesk" && git add cloudflare/worker.js test/worker-backup-namespace.test.js && git commit -m "feat(worker): stamp meta:slug at provision time (create + signup approve)"
```

---

### Task 4: One-time legacy-backup prune + full-suite verification

**Files:**
- Modify: `cloudflare/worker.js` — add `pruneLegacyBackups()` method (~:1888, near the other backup methods) + `POST /state/prune-legacy` route in DO `fetch` (~:1182, after the `/state/reset` route)
- Test: `test/worker-backup-namespace.test.js` (add a test)

**Interfaces:**
- Consumes: `this.env.PHOTOS_BUCKET`.
- Produces: `async pruneLegacyBackups()` → `{ pruned: number, keys: string[] }`; deletes only keys directly under `backups/` (no second `/`).

- [ ] **Step 1: Write the failing test**

Append to `test/worker-backup-namespace.test.js`:

```js
test('pruneLegacyBackups deletes ONLY un-prefixed legacy keys', async () => {
  const bucket = makeBucket();
  await bucket.put('backups/state-old-1.json', '{}');           // legacy
  await bucket.put('backups/state-old-2.json', '{}');           // legacy
  await bucket.put('backups/lush/state-new.json', '{}');        // labeled — must survive
  const doInst = new TurnDeskDO({ storage: makeStorage() }, { PHOTOS_BUCKET: bucket });

  const res = await doInst.pruneLegacyBackups();
  assert.equal(res.pruned, 2);
  assert.equal(await bucket.get('backups/state-old-1.json'), null);
  assert.equal(await bucket.get('backups/state-old-2.json'), null);
  assert.ok(await bucket.get('backups/lush/state-new.json'), 'labeled backup must survive');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "C:/Users/cpach/Documents/GitHub/turndesk" && node --test --test-force-exit test/worker-backup-namespace.test.js`
Expected: FAIL — `doInst.pruneLegacyBackups is not a function`.

- [ ] **Step 3: Add the `pruneLegacyBackups` method**

Add immediately after `backupNow()` (~:1888), before `restoreFromBackup()`:

```js
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
```

- [ ] **Step 4: Add the `POST /state/prune-legacy` route**

In the DO `fetch`, the `/state/reset` route (~:1176) ends:

```js
      const res = await this.factoryReset();
      return new Response(JSON.stringify(res), { status: res.error ? 400 : 200, headers: { 'Content-Type': 'application/json' } });
    }
```

Add this route immediately after that closing `}`:

```js
    // One-time cleanup of legacy un-prefixed backups. Reached via the worker /state/
    // forward (so §13 app-auth applies) and additionally RESTORE_TOKEN-gated, like
    // /state/restore and /state/reset. Bucket-wide; run once from any salon.
    if (url.pathname === '/state/prune-legacy' && request.method === 'POST') {
      let body = {}; try { body = await request.json(); } catch {}
      if (this.env.RESTORE_TOKEN && body.token !== this.env.RESTORE_TOKEN) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      const res = await this.pruneLegacyBackups();
      return new Response(JSON.stringify(res), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
```

- [ ] **Step 5: Run the new test to verify it passes**

Run: `cd "C:/Users/cpach/Documents/GitHub/turndesk" && node --test --test-force-exit test/worker-backup-namespace.test.js`
Expected: PASS.

- [ ] **Step 6: Run the FULL suite (regression gate)**

Run: `cd "C:/Users/cpach/Documents/GitHub/turndesk" && node --test --test-force-exit`
Expected: PASS — all suites, including `test/worker-restore.test.js` and the inherited reports/staff suites. Note the count for the handoff.

- [ ] **Step 7: Syntax-check the worker**

Run: `cd "C:/Users/cpach/Documents/GitHub/turndesk" && node --check cloudflare/worker.js`
Expected: no output (clean parse).

- [ ] **Step 8: Commit**

```bash
cd "C:/Users/cpach/Documents/GitHub/turndesk" && git add cloudflare/worker.js test/worker-backup-namespace.test.js && git commit -m "feat(worker): one-time RESTORE_TOKEN-gated prune of legacy un-prefixed backups"
```

---

## Post-implementation (owner-gated — do NOT run without explicit OK)

These are the deploy/verify steps, listed for the handoff. They are **not** part of the coding tasks and each needs the owner's go:

1. **Merge** `fix/r2-backups-per-salon` → `main`.
2. **`wrangler deploy`** from `turndesk/cloudflare` (verify account `info@musenailandspa.com` / `7e47…fb62`).
3. **Force a labeled backup for EVERY salon, not just demo.** The prune in step 4 deletes every salon's legacy files, so before it runs, each salon must already have a namespaced backup — otherwise a salon whose 6h `alarm()` hasn't fired since deploy would be left with no recovery snapshot until its next alarm. For each registered salon (list them in the operator console — currently `demo` + `glamx-demo`, plus any disabled test artifacts): `POST /state/backup-now` (with `X-Salon: <slug>` + a valid session) → confirm the returned key is under `backups/<slug>/`, and `GET /state/backups` (`X-Salon: <slug>`) lists only that salon's. (This also force-stamps each salon's `meta:slug`, so any pre-deploy salon that hadn't taken client traffic is now labeled too.)
4. **Prune once, LAST:** only after step 3 confirms a labeled `backups/<slug>/` exists for every salon, `POST /state/prune-legacy` (`X-Salon: <any slug>` + `{ token: RESTORE_TOKEN }`) → note `pruned` count; re-run until it returns `0`.
5. Update memory: mark `task_dc7cfcd3` done; log the two follow-ups (registry-DO-not-backed-up; no backup retention).

## Self-Review

- **Spec coverage:** slug learn/persist (T1) ✓; namespaced write/list/restore + deleteAll re-persist + slug-unknown fallback (T2) ✓; provision stamp (T3) ✓; legacy prune route+method (T4) ✓; registry gap + retention logged as out-of-scope ✓; worker-only/no-trio-bump in Global Constraints ✓; test-first with the wrong-salon regression as headline ✓.
- **Placeholder scan:** none — every code step shows the exact before/after.
- **Type consistency:** `_rememberSlug`/`_getSlug`/`_backupPrefix`/`pruneLegacyBackups` names + shapes match across tasks and the spec; `provisionSeed({ slug, … })` and the `{ pruned, keys }` return type are consistent.
