# TurnDesk — Self-serve signup + onboarding (design)

Date: 2026-07-06
Status: approved (brainstorm), ready for implementation planning
Depends on: Phase 2 provisioning (operator console) — LIVE; business sign-in (td-v0.15) — LIVE

## 1. Goal

Let a prospective salon owner request their own TurnDesk salon from a public page,
without the platform owner hand-creating each one in the operator console. This is
the "new customers get the app and set up their own salons" piece — minus payments,
which are deferred (a free beta).

Two owner-control requirements are folded in:
- A single **master admin code** that signs the platform owner into ANY salon.
- Clear, always-available **access/export of any salon's data** for integrity review.

## 2. Decisions (locked in brainstorm)

1. **Signup is approval-gated ("request + you approve").** Anyone can *request*; nothing
   is provisioned until the platform owner approves. This makes abuse protection nearly
   free — there is no public "create a salon" endpoint to attack.
2. **Owner picks their password at request time.** It is hashed immediately and stored
   with the pending request; the plaintext is never stored. On approval it becomes the
   salon's owner credential. No transactional-email service is added — the platform owner
   relays the salon link to the approved owner by hand (email/text).
3. **Minimal onboarding.** The new salon is seeded with a starter menu; on first sign-in
   the owner sees a one-time welcome banner pointing to Settings. No guided wizard.
4. **Master admin code (new).** One secret 6-digit code, held as a Worker secret, signs
   in as admin on any salon.
5. **Centralized data export (new).** An "Export data" action in the operator console
   downloads any salon's full data as one file (in-app export + R2 backups already exist).

## 3. Reuse vs. new

**Reused unchanged:** `validSlug` + `RESERVED_SLUGS`, the salon DO `/provision/seed`,
registry `get/put/list`, `hashPassword`, the per-IP throttle pattern from `/report`,
the operator-console shell (`operator.html` + `handleOperator`), the business sign-in
screen (`screen-signin`), the salon DO `/state/snapshot`, and Settings → Backup &
Restore (in-app export).

**New (small):**
- `signup.html` + `js/app/signup.js` — the public request form.
- Public `POST /signup/request` (auth-exempt, salon-agnostic) → registry DO storage.
- Registry DO: `/signup/request` (store), `/registry/signups` (list), `/signup/decide`
  (approve/reject).
- Salon DO: `/provision/owner` (write a pre-hashed owner credential).
- Operator console: a "Pending requests" panel + `GET /operator/requests`,
  `POST /operator/requests/decide`, and `GET /operator/export`.
- Master admin code check in the salon DO `authLogin`.
- A dismissible welcome banner on the dashboard (synced `config.onboarding_done` flag).

## 4. End-to-end flow

1. **Request** — Owner opens `…/turndesk/signup.html`, fills business name, their name,
   email, password (+ confirm), optional phone + note, and submits.
2. **Store (no salon yet)** — `POST /signup/request` is validated + rate-limited, the
   password is hashed into an owner-credential record, and a `signup:<id>` entry
   (status `pending`) is written to the reserved `__registry__` DO. Response: `{ ok:true }`.
   The owner sees "Thanks — we'll review and send your salon link once approved."
3. **Review** — In `operator.html` (OPERATOR_TOKEN-gated) the platform owner sees a
   "Pending requests" list (business, name, email, phone, note, proposed slug, when),
   with Approve (editable slug) / Reject per row.
4. **Approve → provision** — Approving runs the existing provisioning: pick the final
   slug (proposed or overridden; validated + made unique), `/provision/seed` (starter
   menu), `/provision/owner` (the stored hashed credential), registry entry active, then
   mark the request approved with the final slug. Returns the salon link to copy.
5. **Relay** — Platform owner sends the link (`…/turndesk/?salon=<slug>`) to the owner
   by email/text.
6. **First sign-in** — Owner opens the link → business sign-in → signs in with the email +
   password they chose → dashboard with the starter menu and a one-time welcome banner
   pointing to Settings.

## 5. Data model

Pending request, stored in the `__registry__` DO under `signup:<id>` (`id` = UUID):

```
{
  id,
  status: 'pending' | 'approved' | 'rejected',
  business,                 // 1–80 chars
  ownerName,                // 1–60 chars
  email,                    // lowercased, validated
  phone,                    // optional, ≤ 40 chars
  note,                     // optional, ≤ 500 chars
  ownerRecord,              // { email, name, role:'owner', ...hashPassword(pw) } — no plaintext
  proposedSlug,             // slugify(business), uniquified
  finalSlug,                // set on approval
  createdAt,                // ms
  decidedAt,                // ms, set on approve/reject
  rejectReason,             // optional
}
```

`signup:` is NOT a `buildSnapshot` prefix, so requests never ship to any client, exactly
like the existing `salon:` registry rows.

Salon-side onboarding flag: synced `config.onboarding_done`. Absent/false after
provisioning → the welcome banner shows; dismissing sets it true (via `dispatch('config.set',
{ key:'onboarding_done', value:true })`).

## 6. Worker + DO endpoints

### Public — `POST /signup/request`
- Added to the appAuthOk exemptions AND the salon-guard exemption (salon-agnostic, like
  `/terminal/webhook`). The Worker forwards the original request to the registry DO so the
  real `CF-Connecting-IP` is available for throttling.
- Registry DO handler:
  - Per-IP rate limit: 5 requests / rolling hour via a stored `sreqrl:<ip>` counter; over → 429.
  - Total-pending cap: 200 pending requests; over → 503 (a full queue means you have plenty to review).
  - Validate business/name/email/password (lengths + email format + password ≥ 6). Invalid → 400.
  - `ownerRecord = { email, name: ownerName, role:'owner', ...(await hashPassword(password)) }`.
  - `proposedSlug = uniquify(slugify(business))` (checks reserved + existing registry).
  - Store `signup:<id>`; return `{ ok:true }`.

### Operator — OPERATOR_TOKEN-gated (in `handleOperator`)
- `GET /operator/requests` → registry DO `/registry/signups` → `{ requests: [...] }`
  (pending first, plus recent decided, capped).
- `POST /operator/requests/decide` `{ id, action, slug?, reason? }`:
  - `approve`: load the request; `finalSlug = uniquify(validSlug(slug || proposedSlug))`;
    salon `/provision/seed`; salon `/provision/owner` with `ownerRecord`; registry
    `/registry/put` (active entry); registry `/signup/decide` (status approved + finalSlug).
    Return `{ ok:true, slug, link }`.
  - `reject`: registry `/signup/decide` (status rejected + reason). Return `{ ok:true }`.
  - Guard: a request already approved/rejected → no-op with a clear message.
- `GET /operator/export?slug=<slug>` → `salonStub.fetch('https://do/state/snapshot')` →
  return the full snapshot JSON with `Content-Disposition: attachment` for one-click download.

### Salon DO — `/provision/owner` (internal, reached only via the operator flow)
- `POST { record }` → `this.state.storage.put('owner:' + record.email, record)`. Never
  broadcasts (owner records are not a snapshot prefix). Reached only through the
  OPERATOR_TOKEN-gated approve path, same trust model as the existing `/provision/seed`.

### Master admin code — in the salon DO `authLogin`
- If `this.env.APP_ADMIN_PIN` is set and the entered PIN equals it, mint an admin session:
  `user = { kind:'appadmin', id:'appadmin', name:'App Admin', role:'admin' }`, clear the
  per-IP fail counter, return the token. Checked BEFORE the fresh-system `1234` fallback and
  independent of whether the salon has any users, so it works on every salon. Shares the
  existing per-IP slow-down. Because the session's `name` is "App Admin", the client's
  login audit records "App Admin signed in".
- Set/rotated by the platform owner: `wrangler secret put APP_ADMIN_PIN` (worker `turndesk`,
  account info@musenailandspa.com). Unset ⇒ feature off.

## 7. Client

- `signup.html` — standalone public page (TurnDesk-branded, Material-3, matches the app),
  loading `js/app/signup.js`. NOT imported into the salon app; it does a plain `fetch` to
  `ORIGIN + '/signup/request'` (no salon, no auth token). Client-side validation
  (required fields, email format, password length + match, submit-disabled while sending).
  Success → a confirmation panel; error → an inline message.
- `screen-signin` gets a subtle "New here? Request a salon" link → `signup.html`;
  `signup.html` links back to the sign-in for existing owners.
- Welcome banner — a dismissible dashboard banner shown while `config.onboarding_done` is
  falsy: "Welcome to TurnDesk — add your services, staff, and logo in Settings." Dismiss →
  set the flag. Rendered from existing dashboard init; markup in `index.html`, logic in a
  small existing module (e.g. `main.js`/`settings.js`).

## 8. Data storage + integrity (owner requirement 2)

- **Per-salon isolation:** each salon's entire dataset (config/services/staff/prices, live
  queue, transaction records, gift cards, customers, cash drawer, chat, audit log) lives in
  its OWN Durable Object keyed by slug. No shared store; no cross-salon bleed. Photos/logos
  live in R2 (`turndesk-photos`). Everything is in the owner's Cloudflare account.
- **Backups:** a scheduled DO `alarm()` snapshots each salon's state to R2. (Per-salon
  namespacing of these backup keys is being fixed separately — task `task_dc7cfcd3` — so a
  restore always loads the correct salon.)
- **Access/download, three ways:** (1) in-app Settings → Backup & Restore → Export (per
  salon; reachable via the master admin code); (2) operator-console "Export data" per salon
  (this spec); (3) the raw R2 snapshot files in the Cloudflare account.
- **Integrity guards (already in place):** stale-write rejection (records/queue/config/
  customers/gift cards), deletion tombstones (deleted records can't silently reappear),
  daily restorable backups, and the automatic bug reporter surfacing silent failures.

## 9. Security / abuse

- Nothing is provisioned until approval → no public salon-creation vector.
- `/signup/request`: public but rate-limited per IP + total-pending capped + input-validated;
  password hashed on arrival (no plaintext at rest).
- Master admin code: a Worker secret (never in salon data or app files), sessions marked
  "App Admin" + audited, covered by the login slow-down, rotatable. Documented caveat: it is
  a master key — whoever holds it can admin every salon.
- Operator routes stay OPERATOR_TOKEN-gated; `/operator/export` returns data only for the
  requested slug.

## 10. Out of scope (deferred fast-follows)

Transactional email / auto-notification · password reset (self-service) · guided first-run
wizard · public marketing/landing page · automated billing · CAPTCHA / email verification
(unnecessary while approval-gated).

## 11. Testing

- **Unit:** `slugify` + `uniquify` (collisions, reserved, length); request validation
  (missing/invalid fields, password rules); `hashPassword` round-trip (request → ownerRecord
  → successful login with the chosen password).
- **Manual (preview + live demo salon):** submit a request → it appears in the operator
  console → approve (default + overridden slug) → open the salon link → sign in with the
  chosen credentials → welcome banner shows then dismisses → operator "Export data"
  downloads the salon JSON. Reject path marks the request rejected and provisions nothing.
  Master admin code: set the secret, sign into two different salons with it, confirm admin
  access + the "App Admin" audit line.

## 12. Rollout

- New Worker secret: `APP_ADMIN_PIN` (owner sets via `wrangler secret put`).
- No new bindings; uses existing `SALON_DO`, the `__registry__` instance, and R2.
- Client-only files (`signup.html`, `js/app/signup.js`, `index.html`, `screen-signin` link,
  welcome banner) ship via GitHub Pages; Worker changes (`/signup/*`, `/operator/*` additions,
  `/provision/owner`, the admin-PIN check) need a `wrangler deploy`.
- Version bump (config.js + version.json + sw.js) with `signup.html` added to the SW precache.
