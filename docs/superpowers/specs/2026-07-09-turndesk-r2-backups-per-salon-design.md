# TurnDesk — R2 backups per salon (data-safety gate)

- **Date:** 2026-07-09
- **Status:** Design — approved approach, pending spec review
- **Scope:** Worker-only (`cloudflare/worker.js`). No client change, no version-trio bump. `wrangler deploy`.
- **Related:** `task_dc7cfcd3`; [[project-calendar-harden]] restore fix (its `test/worker-restore.test.js` mock-DO harness is the template); [[turndesk-plan]] "R2-backups-per-salon" block.

## Problem

TurnDesk is multi-tenant: one Durable Object per salon, addressed by `SALON_DO.idFromName(slug)`. But the R2 bucket `turndesk-photos` is **shared** across every salon, and all backup paths write **un-prefixed** keys:

- `alarm()` (worker.js:1847) → `backups/state-<ts>.json`
- `backupNow()` (worker.js:1885) → `backups/state-<ts>.json`
- `listBackups()` (worker.js:1875) → lists `prefix:'backups/'` (every salon's backups)
- `restoreFromBackup(null)` (worker.js:1896) → picks `listBackups()[0]` = newest across **all** salons

**Consequence (the data-safety bug):** salons' backups collide in one namespace, and salon A's "restore latest" can load salon B's snapshot — i.e. **restore the wrong salon's data over A's DO.** This is the gate to clear before a second real salon exists.

## Root cause / the crux

The per-salon DO is keyed by `idFromName(slug)` but **does not store its own slug**, and `alarm()` is timer-driven (fires with no `request`, and on a cold-started DO instance where nothing is cached in memory). So the DO has no way, at backup time, to know which salon it is.

### Key invariant that makes the fix sound

`ensureBackupScheduled()` (which arms the alarm) is only ever reached through `applyMutation` (worker.js:1650), `restoreFromBackup`, or `factoryReset` — all of which are driven by **slug-bearing requests** (`/state/mutate` carries the `X-Salon` header; `/ws` carries `?salon=`). Therefore **any DO that ever writes a backup has necessarily already received at least one request carrying its slug.** If the DO learns its slug from request traffic and **persists it to durable storage**, then:

- **Durability** means the persisted slug survives DO hibernation/eviction and is readable by a cold-start `alarm()` that has no request and no in-memory state.
- The invariant guarantees the slug is already persisted before any alarm can fire.

That is the whole fix: **learn the slug per request → persist `meta:slug` → read it in `alarm()`/`backupNow()`/`listBackups()` → namespace keys as `backups/<slug>/…` and scope list/restore to `prefix:'backups/<slug>/'`.**

## Design

### 1. DO learns + persists its slug

- New in-memory field `this.slug` (unset in the constructor).
- Helper `async _rememberSlug(slug)`:
  - No-op if `slug` is falsy or already equal to `this.slug`.
  - Otherwise set `this.slug = slug` and `await this.state.storage.put('meta:slug', slug)`.
- At the **very top of the DO's `fetch(request)`** (before the WebSocket-upgrade early return at worker.js:1027), extract `slug = (url.searchParams.get('salon') || request.headers.get('X-Salon') || '').trim()` and `await this._rememberSlug(slug)` when non-empty.
  - Covers WS upgrades (`?salon=`) and every HTTP route the client hits with `X-Salon` (`/state/*`, `/auth/*`, `/push/*`, `/report`). This **heals every existing salon** (demo, glamx-demo, any future one) on its first request after deploy.
  - Synthetic internal requests (`https://do/provision/*`, `/registry/*`, `/review-target`, operator `export`'s `/state/snapshot`) carry no slug → `_rememberSlug` is a no-op for them, which is correct.

### 2. Provision-time stamp (belt-and-suspenders)

So a brand-new salon's **very first** backup is already namespaced (not reliant on "first mutation stamps it"):

- `provisionSeed(opts)` (worker.js:1764) also does `await this._rememberSlug(opts.slug)` when `opts.slug` is present.
- The two operator call sites that seed a salon pass the slug in the body:
  - Operator create — worker.js:905 `{ name, template }` → add `slug`.
  - Signup approve — worker.js:971 `{ name, template }` → add `slug`.
- `meta:slug` is **not** a `buildSnapshot()` prefix (snapshot scans `config:`/`queue:`/`record:`/`giftcard:`/`customer:`/`appt:`/tombstones/`audit:`), so it never ships to clients and never rides inside a backup snapshot. Good — the slug is DO-identity metadata, not tenant data.

### 3. Read the slug where backups are written/listed

- `async _getSlug()`: return `this.slug` if set; else read `meta:slug` from storage into `this.slug` (coerced: non-empty string or `''`) and return it. `alarm()` (cold start, no request) relies on this reading from durable storage.
- Helper `_backupPrefix(slug)` → `slug ? 'backups/' + slug + '/' : 'backups/'`.

### 4. Namespace the writes

- `alarm()` and `backupNow()` build the key as `_backupPrefix(slug) + 'state-' + ts + '.json'`, where `slug = await this._getSlug()`.
- **Slug-unknown fallback:** if `slug` is `''`, the prefix is the legacy `backups/` (current behavior). By the invariant this is unreachable for a real backing-up salon; it exists only as a safe floor and keeps the existing `worker-restore.test.js` (which sets no slug) valid.

### 5. Scope list + restore to the salon

- `listBackups()` lists `prefix: this._backupPrefix(await this._getSlug())` — only this salon's own labeled folder (or the legacy folder when slug unknown).
- `restoreFromBackup(null)` picks the newest from the scoped `listBackups()` → **always this salon's own** snapshot. `restoreFromBackup(explicitKey)` still fetches the exact key (unchanged), so an explicit legacy key still works if ever needed.

### 6. Re-persist `meta:slug` after `deleteAll()`

`restoreFromBackup` (worker.js:1903) and `factoryReset` (worker.js:1926) call `state.storage.deleteAll()`, which wipes `meta:slug` along with everything else. Immediately after each `deleteAll()`, re-write it from the in-memory cache:

```js
await this.state.storage.deleteAll();
if (this.slug) await this.state.storage.put('meta:slug', this.slug);
```

Both methods run inside a slug-bearing `/state/*` request, so step 1 has already populated `this.slug` before `deleteAll()` runs.

### 7. Delete the legacy un-prefixed backups (one-time, deliberate)

Owner decision: delete the old shared-folder files rather than orphan them.

- New DO method `async pruneLegacyBackups()`:
  - `list({ prefix: 'backups/' })`, keep only **strict legacy** keys — `k.startsWith('backups/') && !k.slice('backups/'.length).includes('/')` (matches `backups/state-*.json`; **never** matches a labeled `backups/<slug>/…`).
  - Delete those keys; return `{ pruned: <count>, keys: <deleted keys, capped> }`.
- New DO route `POST /state/prune-legacy`, gated by `RESTORE_TOKEN` exactly like `/state/restore` and `/state/reset` (require `{ token }` matching `env.RESTORE_TOKEN` when set). It is reached through the **existing** worker `/state/` forward (worker.js:393) — no new worker-level route — so it also inherits the §13 app-auth gate, i.e. double-gated (a valid session **and** `RESTORE_TOKEN`), same operational model as restore/reset. Bucket-wide sweep; run once from any salon (e.g. `X-Salon: demo`).
- **Not automatic** — the owner triggers it once, **after** the deploy is verified and labeled backups exist. Idempotent and safe to keep (re-runs are no-ops once the legacy set is empty).

## Touchpoints (all in `cloudflare/worker.js`)

| What | Location |
|---|---|
| `this.slug` field | constructor (worker.js:1015) |
| `_rememberSlug`, `_getSlug`, `_backupPrefix` helpers | new methods near the backup methods (~worker.js:1836) |
| Per-request slug stamp | top of DO `fetch()` (worker.js:1023, before the upgrade return at :1027) |
| `provisionSeed` stamps `opts.slug` | worker.js:1764 |
| Operator create passes `slug` | worker.js:905 |
| Signup approve passes `slug` | worker.js:971 |
| `alarm()` namespaced key | worker.js:1847 |
| `backupNow()` namespaced key | worker.js:1885 |
| `listBackups()` scoped prefix | worker.js:1875 |
| Re-persist `meta:slug` after `deleteAll` (restore + factoryReset) | worker.js:1903, :1926 |
| `pruneLegacyBackups()` method + `POST /state/prune-legacy` route | new method (~worker.js:1888) + route in DO `fetch` (~worker.js:1166) |

## Testing (test-first)

New file `test/worker-backup-namespace.test.js`, reusing the `worker-restore.test.js` mock-DO / mock-bucket harness (extend the mock bucket with a `delete(key|keys)` method for the prune test). Each test written to **fail before** the corresponding change and pass after:

1. **Wrong-salon restore regression (headline).** Two DOs (`lush`, `glam`) sharing one bucket, each with `meta:slug` set and **different** data. `backupNow()` on each. `lush.restoreFromBackup(null)` must restore **lush's** data — assert a lush-only record is present and a glam-only record is absent. (Fails today: newest-across-all could load glam.)
2. **Per-salon key prefix.** `lush.backupNow()` returns a key starting `backups/lush/`; `glam.backupNow()` → `backups/glam/`.
3. **List scoping.** With both salons' backups in the shared bucket, `lush.listBackups()` returns only `backups/lush/…` keys (count excludes glam's).
4. **Slug learned + persisted from request.** `doInst.fetch(new Request('https://do/state/snapshot?salon=lush'))` → `meta:slug === 'lush'`. Same via an `X-Salon: lush` header on an HTTP route.
5. **`meta:slug` survives `deleteAll`.** After `restoreFromBackup`, `meta:slug` still equals the salon slug (not wiped).
6. **Provision stamps slug.** `provisionSeed({ slug: 'lush', template: false })` → `meta:slug === 'lush'`.
7. **Prune deletes only legacy.** Seed bucket with `backups/state-old.json` (legacy) + `backups/lush/state-new.json` (labeled). `pruneLegacyBackups()` deletes the legacy one, **keeps** the labeled one, returns `pruned:1`.
8. **Slug-unknown fallback.** With no `meta:slug`, `backupNow()` writes a legacy `backups/state-…` key (no `backups//…` double-slash, no throw).

Keep `test/worker-restore.test.js` green (it sets no slug → exercises the legacy/unknown path and explicit-key restore). Full suite must stay green (`node --test --test-force-exit`).

## Out of scope / follow-ups (logged, not built here)

- **Registry DO is never backed up.** The reserved `__registry__` DO (salon directory, pending signups, owner-credential hashes) uses direct `storage.put` and never calls `applyMutation`, so it never arms an alarm and has **no** R2 backup today. Pre-existing gap, separate from the collision bug. Deferred by owner decision (2026-07-09); track as its own task.
- **No backup retention.** Every salon writes a snapshot every 6h with no pruning → backups accumulate forever (a larger long-term storage drain than the legacy files this task deletes). Separate future task (retention policy: keep newest N per salon).

## Deploy & rollback

- **Deploy:** worker-only → `wrangler deploy` from `turndesk/cloudflare` on account `info@musenailandspa.com` (`7e47…fb62`). No client push, no `version.json`/`sw.js`/`config.js` bump.
- **Order:** (1) merge/commit, (2) `wrangler deploy`, (3) verify a fresh labeled backup appears (`POST /state/backup-now?salon=demo` → key under `backups/demo/`; `GET /state/backups?salon=demo` lists only demo's), (4) run `POST /state/prune-legacy` once to delete legacy files, (5) re-verify demo list still shows its labeled backup and legacy is gone.
- **Rollback:** revert the worker commit and `wrangler deploy` the prior version. New labeled backups remain valid; the reverted (old) code simply resumes writing/reading the legacy un-prefixed path. No data migration to undo. (Do the prune step **last**, after verification, so a rollback before pruning loses nothing.)
