# TurnDesk — Data Storage Safety & Isolation Review

**Date:** 2026-07-10 · **Scope:** How TurnDesk stores data — safety, accessibility, corruption/loss resistance, cross-salon isolation, and multi-salon concurrency.
**Method:** Code audit of `cloudflare/worker.js` (Worker + `TurnDeskDO`), `js/app/{apptoken,sync,store}.js`, `features/*`, plus 7 parallel deep-dive reviewers and an adversarial verification pass per finding (30 candidate findings → 27 real, 3 false-positives dismissed). Every finding below was read against the real code.

Reviewed at: client `td-v0.29` (`4378b9c`), Worker `27a163a9`.

---

## Bottom line

**The foundation is genuinely strong.** The parts that matter most for "can't be corrupted or lost" are well built:

- **Each salon is a separate Durable Object** (`idFromName(slug)`), single-writer, per-key storage — no shared blob to clobber, and one salon literally cannot see another salon's live state through the sync layer.
- **The server enforces the same anti-corruption guards the client does** — stale-write rejection, deletion tombstones (deleted records/customers/appointments can't be revived), per-assignment merge so a tech and the front desk can edit the same ticket at once without clobbering each other, and atomic chat append. A malicious or buggy client cannot corrupt newer data.
- **Sessions are proper random tokens**, bound to the salon that minted them; removing a user revokes their sessions within ~60s.
- **Per-salon R2 backups** every 6h, with a safety snapshot taken before any restore or reset.

**But the review found real gaps** — none catastrophic today (the beta runs with `AUTH_ENFORCED=true`, `RESTORE_TOKEN` set, `payment_processor='none'`, and essentially one live salon), but several that matter the moment more salons come online or a disaster-recovery restore is ever run. The four that deserve action first:

1. **A customer-directory cache in the browser is not salon-scoped** → one salon's customer names/phones/emails can appear in another salon's app on a shared device. *(Cross-salon PII leak, client-side.)*
2. **The photo endpoint trusts the filename the client sends** → an authenticated user of one salon can overwrite or delete another salon's images (and even touch the backup namespace). *(Cross-salon write, server-side.)*
3. **Restoring a backup wipes the owner's login, the Google Calendar token, and the audit trail** and doesn't put them back → after disaster recovery the owner is locked out of their own salon. *(Data loss on restore.)*
4. **Card/Square/SMS integrations run on one shared platform account** and authorize on "any valid session," not "your salon" → one tenant can read another's Square/Helcim data or spend shared quota. *(Shared-account cross-tenant exposure.)*

Everything is fixable without an architecture change. A prioritized roadmap is at the end.

---

# Section A — Cross-salon isolation (server side)

### A1 · Photo endpoint trusts the client-supplied key — cross-tenant image overwrite/delete  — **HIGH** *(confirmed)*
`cloudflare/worker.js:365` — `const key = path.slice('/photos/'.length)`. PUT (`:371`), GET (`:379`), DELETE (`:390`) all use that raw key with **no check that it belongs to the calling salon**. The client politely namespaces keys as `<slug>/<name>` (`features/photos.js:18`) and the logo name is the fixed literal `logo_business`, so a victim salon's key is fully predictable (`<victim-slug>/logo_business`, `<victim-slug>/staff_staff-1`).

**Failure scenario:** An authenticated user of Salon A sends `PUT /photos/krystal-nails-lounge/logo_business` with their own valid `X-Salon: salon-a` token. `appAuthOk` only proves they're signed in *somewhere*; the photo handler ignores which salon — so it overwrites Krystal's logo across their check-in/desk/receipt screens. The same request as DELETE erases another salon's logo/staff photos. Because backups live in the **same R2 bucket** under `backups/<slug>/` (`:2034`, `:2048`), a crafted key can also reach into another salon's backup namespace.

**Fix:** Derive the prefix from the authenticated `salonId` server-side. For PUT/DELETE, reject any key that doesn't start with `salonId + '/'` (403); ideally rebuild the stored key as `${salonId}/${subkey}`. Explicitly refuse any key starting with `backups/` on the photos route.

### A2 · `/gcal/callback` resolves an empty-salon DO — Google Calendar can't connect  — **LOW (availability)** *(confirmed)*
`worker.js:565` hands Google a fixed `redirect_uri` of `origin + '/gcal/callback'` with no salon. On return there's no `?salon=`/`X-Salon`, so `salonId=''` and the state-nonce is read from the empty-named DO where it was never written (`:566`, exempt from the missing-salon guard at `:327`). The connect always fails. **Fails closed** (no token written anywhere) — a correctness/availability bug, not a leak. *(May be moot if the app-native calendar has superseded Google sync.)*

**Fix:** Carry the salon through OAuth — encode the slug in the OAuth `state` value and, in the callback, parse it out to resolve the correct DO before reading/writing `gcal:blob`.

### A3 · Helcim webhook salon-routing is fragile  — **LOW/MEDIUM (isolation)** *(partial — mitigated today)*
`worker.js:777` routes the finalize to `idFromName(salonId)` where `salonId` comes from the webhook URL's `?salon=` (`:294`), and `/terminal/webhook` is exempt from the missing-salon guard (`:327`). The Helcim payload carries no salon id. With **one shared Helcim account**, there's one registered webhook URL for all salons, so a real card result can finalize into the wrong or an empty-named DO. **Currently harmless** because the beta uses `payment_processor='none'` (no live Helcim). This must be solved before any multi-tenant card processing (e.g. encode the salon in the `invoiceNumber` and derive `salonId` from it, server-side).

---

# Section B — Cross-salon isolation (client browser storage)

*Context:* the recent `td-v0.29` work introduced `scopedKey(base) → base:<slug>` and correctly scoped the four biggest keys — state cache, session, outbox, dead-letter. This review found **keys the scoping pass missed.** On a shared browser used for two salons, an unscoped key holds one salon's data under the other's link.

### B1 · Customer-directory cache is not salon-scoped — cross-salon PII leak  — **HIGH** *(confirmed)*
`features/square-customers.js:52` writes the current salon's full customer directory (first/last name, phone, email) to the bare key `turndesk_customers`; `:41` reads it back as a fallback whenever the synced store is momentarily empty (fresh load before the WebSocket hydrates, or offline).

**Failure scenario:** A browser is used for Salon A, then opens Salon B's link. Before Salon B's data hydrates — or indefinitely if Salon B is offline — the check-in autocomplete and Customers tab render **Salon A's customers' names and phone numbers**. This is exactly the bleed the scoping work set out to kill; this key was simply overlooked. It's also *redundant* — the already-scoped state cache holds per-salon customers.

**Fix:** Wrap it in `scopedKey('turndesk_customers')`, or drop the separate cache entirely and read customers from the scoped state cache.

### B2 · Turns / rotation history is not salon-scoped  — **MEDIUM** *(confirmed)*
`features/turns.js:23/24` (write) and `features/queue.js:177` (read) use the bare key `turndesk_turns_history`. A shared browser shows one salon's rotation history under another salon's link. Operational, not PII, but still wrong-salon data. **Fix:** `scopedKey('turndesk_turns_history')`.

### B3 · Staff/reports "who am I" identity keys are not salon-scoped  — **MEDIUM** *(partial)*
`staff.js:31/33` (`turndesk_staff_id`, `turndesk_staff_fd_id`) and `reports-app.js:28` (`turndesk_reports_uid`) are bare. On a shared staff/reports device, a carried-over id resolves against the *current* salon's config (`staff.js` `me()`), so the staff app can show the wrong person or a stale login **without a fresh PIN**. Not a cross-salon data leak (auth session itself is scoped), but a confusing/stale-identity bug. **Fix:** scope these keys, or clear them on salon switch.

### B4 · Back Office sync token is not salon-scoped  — **LOW** *(partial — no data misroute)*
`features/backoffice-sync.js:23` stores `turndesk_bo_token` bare. The verification confirmed rows are routed to the books DO by the salon-scoped `businessId` in the body, **not** by this token — so there's no cross-salon books misroute. Still worth scoping for cleanliness/least-surprise on a shared device.

*(Two suspected client-isolation issues were investigated and **cleared** — see "False positives" at the end: the Square paid/pending keys and the cached Google-Calendar token do **not** cause cross-salon effects.)*

---

# Section C — Backup / Restore / Disaster recovery (data loss)

*Context:* `restoreFromBackup` (`worker.js:2108`) and `factoryReset` (`:2141`) both do `state.storage.deleteAll()` then rebuild **only the families that `buildSnapshot` captures** (`config`, `queue`, `records`, `giftcards`, `customers`, `appointments`, and the deletion tombstones). Several durable keys are neither in the snapshot nor rebuilt, so `deleteAll()` erases them permanently.

### C1 · Restore wipes owner/manager login credentials — owner locked out after disaster recovery  — **HIGH** *(confirmed)*
`owner:<email>` (the PBKDF2 password hash, `worker.js:1863`) is the credential for owner/manager email sign-in (checked at `authLogin:1794` and via `findLogin:1954`). It is **not** a snapshot prefix and **not** rebuilt by restore. After any restore, `deleteAll()` (`:2119`) has erased it and it never comes back → the owner can no longer sign in to their own salon by email. (Staff PINs still work — those live in `config:` — so the salon isn't fully bricked, but the account holder is locked out until an operator re-runs `/auth/owner-set`.)

### C2 · Restore also wipes the Google-Calendar token and push subscriptions  — **MEDIUM** *(confirmed by inspection)*
Same mechanism: `gcal:blob` (Google refresh token) and `push:*` (staff push subscriptions) are erased by `deleteAll()` and not restored. After a restore, calendar sync silently stops working and push notifications stop until every device re-subscribes.

### C3 · Restore drops `cfgmeta:` — stale-write guard has no baseline after a restore  — **MEDIUM** *(confirmed)*
`buildSnapshot` captures `configMeta` (`:1984`) and the backup JSON contains it, but the restore rebuild loop (`:2121`) writes `config:<k>` and **never** `cfgmeta:<k>`. With the per-key write-version baseline gone, the config stale-write guard can't tell a legitimately-newer write from an older one right after a restore — a lingering stale offline device could clobber restored settings/catalog and re-broadcast the regression.

### C4 · Restore silently drops the entire audit trail  — **LOW/MEDIUM** *(confirmed)*
`buildSnapshot` captures up to 500 `audit:` events (`:2002`) but the restore loop never re-persists them, so the activity log is empty after any restore.

> **One fix covers C1–C4.** Change restore/reset so it preserves the non-snapshot durable keys instead of blowing them away: before `deleteAll()`, read `owner:*`, `gcal:blob`, `push:*` (and optionally `sess:*`) and re-`put` them afterward; and add `cfgmeta:` and `audit:` to the rebuild loop (they're already in the snapshot). Alternatively, delete only the entity-family prefixes rather than calling `deleteAll()`. This is the same class as the customer-wipe restore bug fixed on 2026-07-09 — that fix rebuilt customers, but owner/calendar/audit/cfgmeta are still collateral of `deleteAll()`.

### C5 · Restore accepts an arbitrary R2 key with no salon-prefix check  — **LOW** *(partial — operator-only)*
`restoreFromBackup(key)` uses a caller-supplied `key` verbatim (`:2110`) with no check that it starts with this salon's `backups/<slug>/` prefix. The normal UI path (`listBackups`, `:2076`) is safely scoped; only the explicit-key path bypasses it, and it's gated by `RESTORE_TOKEN` (operator secret). So it's an operator footgun (restore Salon B's backup into Salon A by mistyping a key), not a tenant-reachable hole. **Fix:** reject any `key` that doesn't start with `_backupPrefix(await this._getSlug())`.

---

# Section D — Authentication & access control

### D1 · `authOwnerSet` / restore / reset gates fail OPEN if their secret is unset  — **HIGH (latent, currently mitigated)** *(confirmed)*
`worker.js:1858` — `if (this.env.RESTORE_TOKEN && body.token !== this.env.RESTORE_TOKEN) return 403`. The leading `this.env.RESTORE_TOKEN &&` **short-circuits the whole check when the secret is empty/undefined**, and `/auth/owner-set` is auth-exempt (`:243`). So if `RESTORE_TOKEN` were ever unset/rotated-to-empty, anyone could `POST /auth/owner-set?salon=<any>` to create/overwrite an owner credential on any salon and take it over. The same fail-open pattern guards `/state/restore` (`:1267`) and `/state/reset` (`:1277`). **`RESTORE_TOKEN` is set in production today**, so this is latent — but the security of three destructive routes rests entirely on a secret being present, and the code fails *open* rather than *closed*. **Fix:** fail closed — if `RESTORE_TOKEN` is unset, deny these routes.

### D2 · Master `APP_ADMIN_PIN` brute-force throttle resets when the salon slug is rotated  — **MEDIUM** *(confirmed)*
`APP_ADMIN_PIN` (`:1811`) is a single Worker-wide secret that signs in as admin on **any** salon, checked in each salon's DO before the digit-format check. The brute-force counter `authfail:<ip>` lives in **each salon's own DO**, so an attacker can rotate `?salon=` across many slugs and get a **fresh throttle per slug** — effectively defeating the per-IP slow-down for the one credential that unlocks every salon. Security therefore rests entirely on `APP_ADMIN_PIN` being long and random. **Fix:** ensure `APP_ADMIN_PIN` is a long random string (not a 4–8 digit PIN); consider centralizing its throttle in the registry DO and/or IP-allowlisting master-admin use.

### D3 · `AUTH_ENFORCED != 'true'` opens every route on every salon  — **MEDIUM (latent, currently mitigated)** *(partial)*
`appAuthOk:239` returns `true` (auth off) whenever `AUTH_ENFORCED` isn't the string `true`. It **is** `'true'` in production (and `.toLowerCase()` makes it case-tolerant, so `'True'` still enforces — the finder's claim otherwise was wrong). But the design fails *open by default*: a config slip disables auth on `/state/mutate`, `/state/snapshot`, customers, records, backups for every salon. This is the exact issue that exposed ~1,206 Muse customers when the flag had never been set. **Fix:** treat "auth off" as an explicit, logged, alarming state; consider failing closed once initial setup is complete.

### D4 · Master secrets compared with non-constant-time `===`/`!==`  — **LOW** *(confirmed)*
`OPERATOR_TOKEN` (`:945`), `APP_ADMIN_PIN` (`:1811`), `RESTORE_TOKEN` (`:1858`) use plain string comparison (`verifyPassword` correctly uses a constant-time compare, so the pattern exists in the codebase). Timing side-channel is largely theoretical over the network, but these are high-value cross-tenant secrets. **Fix:** constant-time compare.

### D5 · Signup pending-cap can be used to block all new signups  — **LOW** *(confirmed)*
`/signup/request` (`:1179`) rate-limits 5/hour per IP but the queue-full guard counts **all** pending signups globally and 503s at 200 (`:1188`). An IP-rotating attacker can fill 200 pending records and block legitimate signups until an operator clears the queue. **Fix:** expire stale pending signups, or cap per-IP pending count.

### D6 · Isolate auth cache keeps a revoked/expired session valid for up to ~60s  — **LOW (documented tradeoff)** *(confirmed)*
`appAuthOk:268` caches a positive auth result for 60s keyed by `salonId + '\0' + token`. Deactivating a user takes up to ~60s to fully cut their access. This is a deliberate performance tradeoff and is documented; acceptable, noted for completeness.

---

# Section E — Shared external accounts (cross-tenant financial/PII)

*This is the single biggest multi-tenant design gap.* Square, Helcim, SMS, and AI all run on **one shared platform account**, and the proxy routes authorize on "is this caller signed into *some* salon," not "does this resource belong to *their* salon."

### E1 · Shared-account proxies read across all tenants  — **HIGH** *(confirmed)*
`/square/*` (`:787`) forwards to Muse's shared Square account with `SQUARE_TOKEN`; `/helcim/*` (`:640-780`) uses the shared `HELCIM_API_TOKEN`. Both are gated only by `appAuthOk`. **Any authenticated tenant** can call `/square/customers` to read Muse's Square customer list, or `/helcim/card-transactions` to read **every salon's** card transactions on the shared Helcim account. **Fix:** scope external calls per tenant — per-salon Square/Helcim credentials, or a server-side allow-list of which endpoints/paths a tenant may hit, and filter results to the tenant. Until then, treat Square/Helcim as unavailable for non-Muse tenants.

### E2 · "Manual checkout only" guardrail is client-side only  — **MEDIUM** *(confirmed)*
The beta guardrail against charging the shared card account is the seeded default `config:payment_processor='none'` (`provisionSeed:1881`). But `/helcim/purchase` (`:646`) has **no server-side check** of `payment_processor` — a salon that flips the setting (or a crafted request) will charge the shared Helcim terminal. **Fix:** server-side, refuse `/helcim/*` charge routes unless that salon is explicitly provisioned for Helcim.

### E3 · SMS and AI proxies spend shared quota / send from the shared number  — **LOW** *(confirmed)*
`/sms/send` (`:514`) sends from the single `HTTPSMS_FROM` number with the shared key regardless of tenant; `/ai/ask` (`:471`) burns the shared Anthropic/Gemini key. Any tenant can consume the shared quota, and customers of any salon receive texts from the same (Muse) number. **Fix:** per-tenant SMS identity + quota metering; rate-limit AI per tenant.

### E4 · `POST /report` is auth-exempt — owner push-spam  — **LOW** *(confirmed)*
`/report` is intentionally unauthenticated so error reports arrive even if auth itself broke (`:248`). Its only limiter is a per-minute global counter, so anyone who knows a salon slug can push-spam that owner's diagnostics/alerts. **Fix:** per-IP + per-salon rate limits on `/report`.

---

# Section F — Server mutation path & concurrency  *(mostly a clean bill of health)*

The write path is the strongest part of the system. Verified working correctly:

- **Per-salon socket set + broadcast** (`this.sockets`, `:1091`) — one DO instance is one salon, so broadcasts never cross tenants; the `/ws` upgrade is gated by `appAuthOk` before the DO, token via `?auth=`, cache keyed by salon+token.
- **Full stale-write / tombstone parity** between client (`store.js`) and server (`applyMutation:1555`) for config, queue, records, giftcards, customers, appointments — older writes rejected, deleted entities can't be revived, per-assignment merge protects concurrent tech/front-desk edits, chat append is atomic and idempotent.
- **Concurrency:** Cloudflare's single-writer DO serializes the read-modify-write sequences (`nextSeq`, `queue.upsert`), so there's no lost-update race; `mutationId` dedupe is globally unique; storage growth is bounded (`mut:`/`sess:`/`authfail:`/`audit:` all pruned in `alarm()`; `chat_log` capped at 300).

Minor items:

### F1 · Legacy WS relay rebroadcasts unrecognized messages verbatim, bypassing guards  — **LOW** *(confirmed)*
`worker.js:1536` — any WS frame that isn't `ping`/`hello`/`mutate` is broadcast verbatim to every other socket in the salon, with no guard. Current clients ignore unknown message types, so it's inert today, but it's an ungated broadcast channel that the comment already marks "Remove after cutover." **Fix:** delete the legacy relay branch.

### F2 · A transient DO storage exception dead-letters the write instead of retrying  — **LOW** *(confirmed)*
`applyMutation:1734` catch returns `{error}`, which the client turns into a dead-letter (`sync.js` `deadLetter`), rather than leaving it queued for an idempotent retry. A momentary storage hiccup can push a good write into Data Recovery instead of just retrying. **Fix:** distinguish transient storage errors (keep queued) from real rejections (dead-letter).

### F3 · WebSocket hibernation not implemented  — **INFO** *(confirmed — no correctness bug)*
Sockets are held in an in-memory Set (non-hibernating API). No correctness issue (clients auto-reconnect on eviction; state is re-read from storage), but with many concurrent salons/devices this is a cost/scale concern (per the roadmap's "DO-WS-Hibernation" next step).

---

# Section G — Data recovery UX

### G1 · Data Recovery can only re-apply rejected queue/record writes  — **LOW** *(confirmed)*
`features/recovery.js:127` marks an item "restorable" only for `queue.upsert` / `record.save`; a rejected `giftcard.save`, `customer.upsert`, or `appt.upsert` is shown but the one-click Restore is disabled ("can't be auto-restored"). Rejected writes are never silently dropped (good — they're logged and surfaced), but gift-card/customer/appointment rejections need manual re-entry. **Fix:** extend the restore action to those op types.

---

# Prioritized remediation roadmap

**Do first (real, present-tense risk):**
1. **B1 — scope `turndesk_customers`** (one-line `scopedKey` fix; stops cross-salon PII on shared devices).
2. **A1 — enforce the salon prefix on `/photos/*`** server-side (stops cross-tenant image + backup-namespace tampering).
3. **C1–C4 — make restore/reset preserve owner/gcal/push + rebuild cfgmeta/audit** (stops owner lockout + silent loss on disaster recovery). One change, four fixes.
4. **E1/E2 — gate the shared Square/Helcim proxies per tenant** (or disable them for non-Muse salons) before onboarding more salons.

**Do before scaling past the current beta:**
5. **B2, B3 — scope turns-history and staff/reports identity keys.**
6. **D1, D3 — make the `RESTORE_TOKEN` and `AUTH_ENFORCED` gates fail *closed*.**
7. **D2 — confirm `APP_ADMIN_PIN` is long+random; harden its throttle.**
8. **A3 — solve per-salon webhook routing before enabling live card processing.**

**Hardening / cleanup:**
9. D4 (constant-time compares), D5 (signup cap), E3/E4 (SMS/AI/report rate-limiting), F1 (remove legacy relay), F2 (transient-retry), G1 (recovery UX), C5 (restore key-prefix check), A2 (gcal callback salon).

---

# Appendix — Investigated and dismissed (false positives)

The adversarial verification pass **cleared** three candidate findings — recorded here so they aren't re-raised:

- **Chat history lost on restore** — *false.* `chat_log` is stored at `config:chat_log` (`worker.js:1722/1727`), so it **is** captured by `buildSnapshot` and rebuilt on restore.
- **Square paid/pending keys mark the wrong salon's ticket paid** — *false.* Queue entry ids are device-id-prefixed and globally unique (`utils.js` `newEntryId`), so the cross-salon id collision the concern required cannot occur; a stale flag is a harmless no-op in another salon.
- **Cached Google-Calendar token leaks across salons** — *false.* `turndesk_turndesk_gcal_token` is used only as a presence/freshness sentinel; the live gapi credential is minted fresh for the current salon via the salon-scoped `/gcal/token` fetch. (Cosmetic note: the doubled `turndesk_turndesk_` prefix is a search-replace artifact, harmless.)

---

*Generated by a multi-agent code review (7 dimension reviewers + per-finding adversarial verification) cross-checked against a direct human-directed read of the same code.*
