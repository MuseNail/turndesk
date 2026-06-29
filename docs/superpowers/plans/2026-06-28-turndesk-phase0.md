# TurnDesk Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh TurnDesk to current Muse (v5.35), switch on per-salon isolation with hardened salon-scoped login (staff PIN + owner email/password), and seed a rich demo salon ("Lush Nails & Spa", slug `demo`).

**Architecture:** TurnDesk reuses Muse's existing per-salon DO routing (`SALON_DO.idFromName(slug)`) and per-salon `sess:` tokens. We overlay current Muse app code onto the existing turndesk repo/Worker, preserve TurnDesk's identity (wrangler, ORIGIN, VAPID, branding), add client `?salon=` plumbing + owner email/password login, remove the silent salon default, and seed `demo` via a re-runnable generator.

**Tech Stack:** Vanilla ES-module JS (no build step), Cloudflare Worker + Durable Object (SQLite-backed), WebCrypto PBKDF2 for password hashing, R2 photos. Verification via the local static preview server (`.claude/serve-turndesk.ps1`, port 5050) and `curl`/`wrangler tail` against the deployed Worker.

## Global Constraints
- No frontend build step; vanilla ES modules only; no new libraries.
- Do NOT edit inline JS/CSS in `index.html` beyond the existing Tailwind config block.
- Version trio bumps together: `js/app/config.js` APP_VERSION + `version.json` + `sw.js` CACHE_NAME.
- Preserve TurnDesk identity: `cloudflare/wrangler.toml` (worker name `turndesk`, DO class `TurnDeskDO`, R2 `turndesk-photos`), `config.js` ORIGIN = `https://turndesk.musenailandspa.workers.dev`, the turndesk VAPID_PUBLIC_KEY, manifest name "TurnDesk".
- Always `wrangler whoami` and confirm the **info@musenailandspa.com** account (`7e47fe5134a4b77582cf7746bff3fb62`) before `wrangler deploy`.
- Passwords stored hashed (PBKDF2) only; never plaintext, never returned.
- All turndesk git ops use `git -C /c/Users/cpach/Documents/GitHub/turndesk` (Bash cwd resets between calls).

---

### Task 1: Foundation overlay — copy current Muse app code into turndesk

**Files:**
- Copy INTO turndesk from musedashboard: `js/` (whole tree), `css/`, `index.html`, `staff.html`, `reports.html` (+ any other top-level `*.html`), `sw.js`, `icons/`, `cloudflare/worker.js`.
- PRESERVE turndesk's existing: `cloudflare/wrangler.toml`, `manifest.json`, `version.json`, `.git`, `.claude/`, `docs/`, `README.md`, `CLAUDE.md`.

**Approach:** Robocopy/cp the app-code paths only. Do not delete turndesk-only files. `config.js`, `manifest.json`, `version.json`, `sw.js` branding/identity are fixed in Tasks 2–3 right after.

- [ ] Snapshot the list of turndesk top-level `*.html` files first so none are missed.
- [ ] Copy the app-code paths listed above from musedashboard → turndesk (overwrite).
- [ ] `git -C <td> status` to confirm only app code changed; spot-check no stray deletions of turndesk-only files.
- [ ] Commit: `chore: overlay current Muse v5.35 app code onto TurnDesk`.

**Verify:** `git -C <td> status` shows modified js/css/html/worker; turndesk `wrangler.toml`/`manifest.json`/`docs/` untouched.

---

### Task 2: Reconcile Worker — DO class name + remove silent salon default

**Files:** Modify `cloudflare/worker.js` (overlaid from Muse).

**Approach:** The wrangler binding declares DO class `TurnDeskDO` (migration `v1`). Muse's worker exports a differently-named DO class. Rename the overlaid DO class to `TurnDeskDO` (export + any `class_name` references) so the binding/migration stay valid (turndesk has no data → safe). Then change `const salonId = url.searchParams.get('salon') || 'muse'` to require an explicit slug.

- [ ] Find the DO class declaration in `cloudflare/worker.js` and rename it to `TurnDeskDO` (and its `export`/reference points).
- [ ] Replace the salon default: `const salonId = (url.searchParams.get('salon') || '').trim();` then early-return `json({error:'missing salon'}, 400)` for app/data routes when `!salonId` (keep webhook/`/r`/`/gcal/callback` exempt as they are). Login route (`/auth/login`) reads the slug from the POST body or `?salon=`.
- [ ] Confirm migration tag `v1`/`new_sqlite_classes=["TurnDeskDO"]` in `wrangler.toml` matches the class name.
- [ ] Commit: `fix(worker): align DO class to TurnDeskDO; require explicit salon slug`.

**Verify:** `wrangler deploy --dry-run` (or `wrangler deploy` in Task 8) parses with no class/migration mismatch.

---

### Task 3: Re-apply TurnDesk identity — config.js, manifest, version trio

**Files:** Modify `js/app/config.js`, `manifest.json` (confirm), `version.json`, `sw.js`.

**Approach:** Muse's overlaid `config.js` points ORIGIN at the Muse worker and carries Muse's VAPID public key. Override ORIGIN → turndesk worker and VAPID_PUBLIC_KEY → turndesk's key (from `wrangler.toml`: `BCoL00zoZ6BMiurBxzhh05439KLXdDCgmd6z6bQzOl4r30VYBq7Xzvf5Xl5DqsuqUchNE7xnfcaCrvgUvfJ2uKk`). Keep all other new Muse constants.

- [ ] In `js/app/config.js`: set `const ORIGIN = 'https://turndesk.musenailandspa.workers.dev';` and `VAPID_PUBLIC_KEY` to the turndesk key. Set `APP_VERSION` to a TurnDesk line (e.g. `td-v0.10` — independent of Muse's v5.xx).
- [ ] `version.json` → matching version string; `sw.js` CACHE_NAME → matching (e.g. `turndesk-v0.10`).
- [ ] Confirm `manifest.json` name/short_name = "TurnDesk" (kept from turndesk; no change expected).
- [ ] Commit: `chore: re-apply TurnDesk identity (ORIGIN, VAPID, version, cache)`.

**Verify (preview):** start `serve-turndesk.ps1`; load `http://localhost:5050/?salon=demo`; confirm app boots, version badge shows the TurnDesk version, and network calls target the turndesk worker.

---

### Task 4: Client tenant plumbing — send `?salon=<slug>` everywhere

**Files:** Modify `js/app/apptoken.js`, `js/app/sync.js`.

**Approach:** Persist the slug per device and append `?salon=` wherever `?auth=` is already added.

- [ ] In `apptoken.js`: add `export function salonSlug(){ const u=new URLSearchParams(location.search).get('salon'); if(u){ try{localStorage.setItem('td_salon',u)}catch{} return u;} try{return localStorage.getItem('td_salon')||''}catch{return ''} }`.
- [ ] In the `apptoken.js` fetch wrapper (`withAuth`/the wrapper that appends `?auth=`): also append `salon=<slug>` to the URL for WORKER_ORIGINS requests.
- [ ] In `apptoken.js` `serverLogin`: include the slug — POST body `{ slug: salonSlug(), ... }` and/or `?salon=` on the `/auth/login` URL.
- [ ] In `sync.js`: the WS URL builder + `/state` calls append `?salon=<slug>` (import `salonSlug`). Ensure `?auth=` and `?salon=` coexist.
- [ ] Commit: `feat(client): carry salon slug on all worker requests + WS`.

**Verify (preview):** with `?salon=demo`, DevTools/network (or `preview_network`) shows WS + `/state` URLs carrying `salon=demo`; reload without the query keeps `td_salon` from localStorage.

---

### Task 5: Worker — owner email/password login + DO credential store (PBKDF2)

**Files:** Modify `cloudflare/worker.js` (DO `authLogin` + a credential store).

**Interfaces produced:**
- DO storage key `owner:<emailLower>` = `{ email, name, role:'owner'|'manager', salt, hash, iters }`.
- `authLogin` accepts `{slug,pin}` OR `{slug,email,password}`; returns `{token,user,expires}` on success (same shape as today).
- Helper `hashPassword(password, saltB64?, iters?) -> {salt,hash,iters}` and `verifyPassword(password, rec) -> bool` using WebCrypto PBKDF2-SHA256 (e.g. 100k iters), base64 salt/hash.

**Approach:** Reuse the existing per-IP slow-down and `sess:` token mint. Branch on payload: PIN path unchanged; email/password path looks up `owner:<email>` and verifies via PBKDF2.

- [ ] Add `hashPassword`/`verifyPassword` (WebCrypto `crypto.subtle.importKey`+`deriveBits`, PBKDF2-SHA256, random 16-byte salt).
- [ ] In `authLogin`: if `email`+`password` present, load `owner:<emailLower>`; on `verifyPassword` success mint the same `sess:` token (record role); apply the same slow-down/backoff as the PIN path on failure.
- [ ] Add a guarded helper to SET an owner credential (used by the seed in Task 7) — either a DO method invoked via `/state/mutate` op `owner.set` (gated like other mutations) or a `RESTORE_TOKEN`-gated route. Never log/return the password or hash.
- [ ] Commit: `feat(worker): owner email+password login (PBKDF2) alongside staff PIN`.

**Verify (Task 8, live):** `curl -XPOST .../auth/login -d '{"slug":"demo","email":"owner@demo.turndesk.app","password":"<starter>"}'` returns a token; wrong password is rejected and slows down.

---

### Task 6: Login UI — owner sign-in toggle

**Files:** Modify `js/app/features/auth.js`, `js/app/staff.js` if it has its own login, and the login markup in `index.html`/`staff.html` (existing login container only).

**Approach:** Show the salon name (derived from slug). Default view = PIN entry (unchanged). Add an "Owner sign-in" link toggling to email + password fields that call `serverLogin` with `{email,password}`.

- [ ] Derive + display the salon's business name on the login screen (from a public `config` field or a lightweight unauthenticated `/salon/name?salon=<slug>` lookup; if not trivially available, show the slug). Keep minimal.
- [ ] Add the owner toggle + email/password inputs; wire to `serverLogin` (owner variant). Reuse existing styles/`.field` classes.
- [ ] Commit: `feat(ui): owner email+password sign-in toggle on the login screen`.

**Verify (preview + live):** PIN login still works; owner toggle reveals email/password; owner login succeeds against the deployed worker (after Task 8 seed).

---

### Task 7: Demo salon generator (re-runnable)

**Files:** Create `tools/seed-demo.mjs` (Node script; standalone, no bundler) in the turndesk repo.

**Approach:** Generate ~35 days ending today and POST ops to the deployed worker's mutate path for slug `demo`. Config: salon name "Lush Nails & Spa", a realistic generic nail menu (services + prices), fees, 6–8 techs, 3–4 fd_users (with PINs), turns_order, and the owner credential (`owner.set` for owner@demo.turndesk.app + a generated starter password printed to console once). Customers via `customer.bulkUpsert` (a few hundred). Sales `record.save` 15–25/day (weekend-heavier), realistic service/tip/tender mix. Turns history, a few gift cards, daily cash-drawer shifts.

- [ ] Write the menu + staff + customer-name pools and the per-day sales generator (deterministic RNG seeded by a constant for repeatability; dates relative to run time).
- [ ] Script targets `https://turndesk.musenailandspa.workers.dev` with the seed auth (RESTORE_TOKEN or an owner session minted first); prints the owner starter password once.
- [ ] Make it idempotent-ish: a `--reset` flag clears `demo`'s records/customers first (uses existing clear ops) so re-runs don't duplicate.
- [ ] Commit: `feat(tools): re-runnable demo-salon seed generator`.

**Verify:** dry-run prints planned counts; full run reports records/customers/giftcards/shifts created.

---

### Task 8: Deploy, seed, verify end-to-end

**Files:** none (ops).

- [ ] `wrangler whoami` → confirm info@musenailandspa.com / account `7e47…fb62`. If not, stop.
- [ ] From `turndesk/cloudflare`: `wrangler deploy`. Set any new secret (`RESTORE_TOKEN`) if the seed needs it.
- [ ] Run `tools/seed-demo.mjs` against `demo`; capture the printed owner starter password.
- [ ] Verify live: load `https://musenail.github.io/...?salon=demo` (or the turndesk Pages URL) — but first confirm where turndesk's client is hosted (Pages). If client isn't yet on Pages, verify via local preview pointed at the deployed worker.
- [ ] Owner login (email/password) + a staff PIN login both succeed and are scoped to `demo`.
- [ ] Reports/Payroll/Customers/Turns populated with ~a month of data.
- [ ] Isolation check: `?salon=other` is empty; a `demo` token is rejected against `other`.
- [ ] Push turndesk main; report the owner starter password + the demo link to the owner.

**Verify:** all success criteria in the spec met.

---

## Self-Review
- **Spec coverage:** overlay (T1) · DO-class + default removal (T2) · identity (T3) · slug plumbing (T4) · owner login backend (T5) · login UI (T6) · demo generator (T7) · deploy/seed/verify (T8). All spec sections mapped.
- **Open integration unknowns to resolve during execution (not placeholders — investigations):** exact Muse DO class name; exact name of the `?auth=` wrapper in `apptoken.js`; whether `/state/mutate` is the right seed path vs a restore route under `AUTH_ENFORCED`; where turndesk's client is hosted (Pages vs only local). Each is a read-the-code step inside its task.
- **Naming consistency:** `salonSlug()`, `td_salon`, `owner:<email>`, `hashPassword`/`verifyPassword`, `TurnDeskDO` used consistently across tasks.
