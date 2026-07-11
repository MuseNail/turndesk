# TurnDesk Multi-Salon Stress Test — 2026-07-11

**Question:** Is TurnDesk ready to host multiple salons (target: **5–25 salons near-term**)?

**Verdict:** **Architecturally yes.** Tenant isolation is genuinely well-engineered and held up under concurrent multi-salon load with **zero cross-tenant leaks**. But **3 HIGH issues** should be fixed before onboarding more real salons — two of them (the PIN-`1234` backdoor and the stale-restore DR bug) bite regardless of salon count, and the third (shared payment secrets) is a hard blocker *before* enabling card processing (currently defused by the free-beta `processor:'none'` guardrail).

---

## How it was tested (3 independent methods)

1. **Deep code audit** — 49 subagents across 9 stress dimensions (registry contention, backup/cron fan-out, shared-R2 blast radius, Cloudflare limits + cost, cross-tenant isolation, auth/throttle scaling, provisioning concurrency, concurrent-write data-integrity, deploy blast-radius). Every finding was adversarially re-verified against the real code. → **38 findings** (1 refuted): 3 HIGH, 2 MEDIUM, 21 LOW, 12 INFO.
2. **Local load simulation** — the *real* `cloudflare/worker.js` + `TurnDeskDO` run under `wrangler dev` (local DO SQLite + R2 + WebSockets), driven by a no-deps Node harness: 25 salons provisioned, 125 WebSockets, 20s of steady writes, a 625-write burst, and isolation probes.
3. **Empirical security probes** — targeted checks against the running Worker (e.g. the PIN-`1234` backdoor, cross-token rejection).

Harness + probes live in the session scratchpad (`td-stress.mjs`, `probe-backdoor.mjs`). To re-run locally: create `cloudflare/.dev.vars` (gitignored) with `AUTH_ENFORCED="true"`, `OPERATOR_TOKEN`, `RESTORE_TOKEN`, `APP_ADMIN_PIN`; `npx wrangler dev --port 8787` from `cloudflare/`; then `SALONS=25 node td-stress.mjs`.

> ⚠️ The **live production load test was intentionally skipped** — the audit + local sim answer the readiness question conclusively at this scale, and a live run would need the real operator secret, leave un-deletable synthetic salons on the production account, and risk contending with the live beta salon (Krystal). Real-Cloudflare capacity at 5–25 small tenants is not in question (DOs handle thousands of small tenants).

---

## Load results — 25 salons, live against the real Worker+DO

| Phase | Result |
|---|---|
| Provision 25 salons (concurrent) | 25/25 ok — ~1.4 s each (dominated by PBKDF2 owner-password hashing) |
| Login 25 owners (concurrent) | 25/25 ok — ~1.3 s each (PBKDF2 verify) |
| **Steady load** (25 salons, 20 s) | 1,466 writes, **72/s aggregate**, latency **p50 7 ms / p95 19 ms / p99 65 ms / max 104 ms** |
| **Burst** (625 writes fired simultaneously) | 0 dropped, p95 1.35 s — per-DO single-writer serialization working as designed |
| **WS fan-out** | 125 sockets, **10,340 broadcast frames delivered**, 0 dropped mid-run |
| Client-side errors | **0** |

**Isolation (the critical check):** 1,752 stored entities checked across 25 salons → **0 content leaks**; cross-tenant token → **401**, missing-slug → **400**, bad token → **401**. Isolation holds under concurrent load.

*Note:* absolute latency/throughput reflect the local machine + Miniflare, not the Cloudflare edge — the value here is **correctness under concurrency + relative scaling behavior**, both clean. `wrangler dev` emitted "Network connection lost" lines at teardown (socket close / DO disposal) — a local artifact; no client errors or dropped writes resulted.

---

## 🔴 HIGH — fix before onboarding more salons

### H1 — PIN `1234` is an admin backdoor on freshly-provisioned salons
`cloudflare/worker.js:1866` · **empirically confirmed**

`provisionSeed` seeds services/items/fees/payment_processor but **not** `fd_users`, so every freshly self-serve-provisioned salon starts with an empty `fd_users`. The fresh-system fallback then accepts PIN `1234` and mints a **full admin** front-desk session. Salugs are `slugify(business name)` (public, in the owner's URL — not a secret), so **anyone who knows a salon's slug can `POST /auth/login {pin:"1234"}` and get admin** access to customer PII + financials + settings, until the owner happens to complete the first-run manager-PIN prompt.

Worse: the minted session has `id:'fallback'` and is **exempt from revocation** in `authCheck` (`worker.js:1928`), so a token grabbed during the open window **stays valid its full 30 days** even after `fd_users` is later populated.

Reproduced live:
```
POST /auth/login {pin:"1234"}  → 200 {kind:"fd", id:"fallback", role:"admin"}
read salon state with token     → 200 (customers/records readable)
after operator sets manager PIN → OLD 1234 token STILL valid (200)   ← revocation-exempt
new 1234 login after PIN set     → 401 (window closes for NEW logins only)
```

**Fix:** gate the fallback so it can never grant admin over the network on a provisioned salon — accept `1234` only when the DO has **no owner credential AND no staff at all** (a truly un-provisioned instance), or have provisioning always set an initial `fd-manager` PIN server-side (the operator `/managerpin` route already exists). Independently, **stop exempting `fallback` sessions from `authCheck` revocation** so configuring `fd_users` immediately kills any outstanding `1234` session. *Verify against the client first-run flow before shipping.*

### H2 — Stale-restore: "restore latest" can silently restore a months-old backup
`cloudflare/worker.js:2107`

Each salon's `alarm()` writes 4 full-state snapshots/day to `backups/<slug>/state-<ISO>.json` and **nothing ever prunes them**. `listBackups()` does a **single non-paginated** `PHOTOS_BUCKET.list({prefix})` — R2 caps a page at 1,000 objects and returns keys in lexicographic (= chronological ascending) order. After ~1,000 snapshots (~8 months for *any* one salon), the page contains the **oldest** 1,000 and omits the newest, so `restoreFromBackup(null)` restores the **newest-of-the-oldest** — a ~8-month-old snapshot — while the operator believes they restored last night's data. A silent, catastrophic DR failure exactly when DR is needed; independent of salon count.

**Fix:** (a) add **retention** in `alarm()` (keep newest N / last M days, delete older — same pass that already prunes `mut:`/`sess:` keys) — *touches persisted data, needs a retention-policy decision + rollback plan*; and (b) make `listBackups()` **paginate the cursor** or list newest-first (store snapshots under a reverse-sortable key) so the first page is always the newest.

### H3 — Shared payment secrets across all salons *(deferred by owner — keep guardrail)*
`cloudflare/worker.js:700`

All `/helcim/*` and `/square/*` routes use one account-wide `HELCIM_API_TOKEN`/`SQUARE_TOKEN`. Once any salon enables a card processor: charges settle to the one operator merchant account, `GET /helcim/transactions` returns the **whole account's** card sales (salon A can read salon B's), and `/helcim/refund` can refund any transaction. **Currently defused** by the launch guardrail (`config.payment_processor` default `'none'` / manual checkout). This is the known-deferred E1/E2 item. **Hard blocker before enabling real card processing for more than one tenant** — needs per-salon processor credentials + per-salon webhook routing first.

---

## 🟡 MEDIUM — should-fix soon

- **M1 — No WebSocket Hibernation** (`worker.js:1543`): DO uses `ws.accept()` + `addEventListener`, not `state.acceptWebSocket()`. Every open socket bills the salon's DO wall-clock GB-s all day. **Top cost lever: ~$37–96/mo at 25 salons → ~$6–8/mo** with hibernation. (Also requires moving the 20s app ping to `setWebSocketAutoResponse()` — `js/app/sync.js:156` — or hibernation never kicks in.) Cost, not correctness.
- **M2 — No staging/canary** (`cloudflare/wrangler.toml:34`): one Worker + one DO migration lineage serve every tenant; no `[env.staging]`, no gradual deployment. Every `wrangler deploy`/migration hits all 5–25 salons at once with only manual all-or-nothing rollback.

## 🟢 Notable LOW / hygiene

- **Unbounded R2 backup growth** — no retention/rotation; ~36k snapshot objects/year at 25 salons (same root cause as H2's retention half).
- **`GET /photos` is auth+salon-exempt** — staff face photos readable by guessable key (`<slug>/staff-1`). Mildly-sensitive PII; deliberate "public branding" choice — document or randomize keys.
- **Non-transactional provisioning** — 3-step provision ignores sub-request status; a transient failure can leave a half-provisioned salon reported as `{ok:true}`.
- **`queue.assignmentPatch` / `queue.entryPatch`** — apply with no `updatedAt`/stale guard (asymmetric with `queue.upsert`'s `_mergeNewerAssignments`). Money is protected (early-return on paid/done); a concurrent per-assignment/note edit can be reverted.
- **`config.set` is whole-array last-write-wins** — concurrent settings edits on the same array config clobber each other.
- **No `salonId` in Worker logs** — can't attribute a 500/stale-write/Helcim failure to a salon during a multi-tenant incident (`worker.js:287`).
- **Dead cron** — `crons=["30 10 * * *"]` is declared but there is **no `scheduled()` handler** and no Sheets/email code anywhere; the advertised daily export/email backup **does not run** (per-DO R2 `alarm()` is the only backup). Remove the trigger+comment or implement the handler.
- **`/state/restore` doesn't validate `body.key` is within the caller's own `backups/<slug>/` prefix** — operator footgun / accidental cross-tenant restore (RESTORE_TOKEN-gated, not a tenant escalation).

## ✅ What held up well (no action)

- **Per-salon DO isolation** — `idFromName(slug)` used consistently at every stub site; state lives only in the addressed instance. No accidental cross-salon write path.
- **Registry chokepoint is fine at this scale** — every request's `isSalonDisabled` check is shielded by a 60s cache and **fails open**, so a registry blip degrades nothing app-critical; hot `/ws`+`/state` paths go straight to each salon's DO. Becomes a latency concern only at *hundreds* of salons.
- **Backups are per-DO `alarm()`**, not a fragile all-salons cron fan-out — scales cleanly.
- **Financial writes** (`record.save`/`giftcard.save`) are merge-by-id + stale-guarded + deletion-marker-blocked. **Sessions + per-IP throttle are per-salon**; `safeEqual` used for every real secret.

---

## Suggested fix order

1. **H1 — PIN `1234` backdoor** (security; every new salon) — TDD, verify client first-run flow.
2. **H2 — stale-restore + backup retention** (data-safety; the owner's #1 value) — retention policy needs a decision + rollback plan before deleting any R2 objects.
3. **M1 — WebSocket hibernation** (cuts the bill ~5×) — when convenient.
4. Hygiene LOWs (log `salonId`, remove dead cron, guard the patch ops, `/state/restore` prefix check).
5. **H3 — per-salon payment credentials** — required *before* enabling real card processing for a 2nd salon (owner-deferred until "card processing later").

*H3 and the shared-account items remain owner-deferred (E1/E2). Everything else is safe to schedule now.*
