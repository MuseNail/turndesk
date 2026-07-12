# TurnDesk — Staging & Release Runbook (M2 deploy safety)

TurnDesk is **one Worker serving every salon**, so a bad deploy or a bad Durable Object
migration hits all salons at once. Staging fixes that: validate every change on a
**separate, fully-isolated worker** first, then promote the *same code* to prod.

## What staging is

`wrangler deploy --env staging` publishes a second worker, **`turndesk-staging`**, defined
by the `[env.staging]` block in `wrangler.toml`. Because it's a different worker name:

- its **Durable Object namespace is separate** — `idFromName("smoke")` on staging is a
  *different* DO instance with *different* SQLite storage than prod. DO data never crosses.
- its **R2 bucket is separate** (`turndesk-photos-staging`) — photos + `backups/<slug>/`
  are isolated.
- its **secrets are separate** — set explicitly, using throwaway values.

**Nothing on staging can touch Krystal or any live salon.** (Verified against Cloudflare's
DO-environments + wrangler-inheritance docs.)

---

## One-time setup (creates resources — run once)

```bash
cd cloudflare

# 1. Create the isolated staging R2 bucket (deploy won't auto-create it)
wrangler r2 bucket create turndesk-photos-staging

# 2. Confirm the config targets the staging worker + staging bucket BEFORE deploying
wrangler deploy --env staging --dry-run      # expect name "turndesk-staging", bucket "...-staging"

# 3. Deploy the staging worker (creates it + its DO namespace)
wrangler deploy --env staging

# 4. Set staging-only secrets — THROWAWAY values, never the prod tokens.
#    (AUTH_ENFORCED is already a var in wrangler.toml, so it's not needed here.)
wrangler secret put OPERATOR_TOKEN --env staging     # e.g. `openssl rand -hex 32`
wrangler secret put RESTORE_TOKEN  --env staging     # e.g. `openssl rand -hex 32`
wrangler secret put APP_ADMIN_PIN  --env staging     # a throwaway PIN
wrangler secret list --env staging                   # confirm the 3 names are present

# Leave UNSET so the feature is inert on staging (guardrail):
#   HELCIM_API_TOKEN, HELCIM_WEBHOOK_VERIFIER, SQUARE_TOKEN  (no card ever hits a live processor)
#   SHEETS_URL (no Sheets export)   VAPID_PRIVATE_KEY (no push)
```

Staging URL: `https://turndesk-staging.<your-workers-subdomain>.workers.dev`

### Provision a throwaway test salon on staging

```bash
S=https://turndesk-staging.<sub>.workers.dev
OP=<staging OPERATOR_TOKEN>
# 'smoke' is an ordinary slug (avoid reserved: admin/api/demo-reserved/__registry__)
curl -X POST "$S/operator/salons" -H "Authorization: Bearer $OP" -H "Content-Type: application/json" \
  -d '{"slug":"smoke","name":"Smoke Test","ownerEmail":"smoke@test.local","ownerPassword":"smoke123","template":true}'
# optional: seed believable history (existing tool, just repoint WORKER)
WORKER=$S SALON=smoke RESTORE_TOKEN=<staging RESTORE_TOKEN> OWNER_EMAIL=smoke@test.local OWNER_PASSWORD=smoke123 node ../tools/seed-demo.mjs
# tear down when done (no hard-delete route — disable it):
curl -X POST "$S/operator/salons/smoke/status" -H "Authorization: Bearer $OP" -H "Content-Type: application/json" -d '{"status":"disabled"}'
```

### Pointing a browser client at staging

The client hardcodes the prod origin in **three** files (`js/app/config.js`, `js/app/sync.js`,
`js/app/apptoken.js` — HTTP proxies, the `/ws` WebSocket, and `/auth/login` respectively), so
deploying the staging worker alone does **not** redirect any client. To smoke-test in a browser,
temporarily repoint all three to the staging URL, run a local static server, test, then revert:

```bash
# temp-edit ORIGIN/PROD_ORIGIN in config.js, sync.js, apptoken.js → the staging URL
git checkout -- js/app/config.js js/app/sync.js js/app/apptoken.js   # revert before committing
```

> **Optional improvement (not yet built):** add one guarded `apiOrigin()` helper (allow-listed to
> `^https://turndesk-staging\.[a-z0-9-]+\.workers\.dev$` + localhost, default prod, off unless a
> `?api=` param is set) and use it in all three files — it's inert in prod and removes the temp-edit
> dance. Deferred because it's a security-sensitive change to the live client (a loose allow-list would
> let a hostile `?api=` link repoint a real salon). Ask before adding.

---

## Release runbook (the default path)

```
1. wrangler deploy --env staging          # ship the change to staging
2. Smoke-test on staging with the throwaway salon: sign-in (PIN), check-in, assign & price,
   manual checkout (processor 'none'), a backup + restore.   Watch: wrangler tail --env staging
3. wrangler deployments status            # note the current GOOD prod version id (rollback target)
4. wrangler deploy                        # promote the SAME code to prod (atomic, 100%)
5. wrangler deployments status            # verify; spot-check one real salon
```

### Rollback (fast escape hatch — stops the bleeding; does NOT undo data)

```bash
wrangler rollback --message "revert: <what broke>"          # to the immediately-previous version
# or to a specific known-good version:
wrangler versions list                                      # copy the good Version ID
wrangler rollback <VERSION_ID> --message "revert to known-good"
```

- Rollback re-points 100% of traffic to an older **code** version instantly. It does **not**
  undo data a bad version already wrote — for corrupted salon data, also restore from
  `backups/<slug>/` via the `RESTORE_TOKEN` path.
- **Hard limit:** you cannot roll back past the last deployed **DO migration**. TurnDeskDO is at
  tag `v1` (long applied), so rollback among today's versions is safe. The day you add a `v2`
  SQLite migration: ship it as its **own** release via plain `wrangler deploy` (migrations can't be
  gradually rolled out), and know it becomes a rollback floor — recovery for a bad migration is
  fix-forward + R2 restore.

### Why not gradual/canary deployments (for TurnDesk)

Cloudflare gradual deployments exist, but a "10% canary" moves ~10% of **whole salons** to the new
version (a DO is pinned to one version for the rollout) — not a safe fractional slice, and you can't
canary within a salon or roll a single pilot salon forward. Staging + a throwaway salon is the real
safety net. Reserve gradual rollout only for pure, migration-free, backward-compatible code changes.

---

## Guardrails checklist (before any staging deploy)

- [ ] `wrangler deploy --env staging --dry-run` shows name `turndesk-staging` + bucket `turndesk-photos-staging`
- [ ] staging DO binding has **no** `script_name` (else it hits prod DOs)
- [ ] staging secrets are **throwaway**, and `HELCIM_API_TOKEN`/`SQUARE_TOKEN` are **unset**
- [ ] every command that should target staging carries `--env staging` (a bare command hits prod)
