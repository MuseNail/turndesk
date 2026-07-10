# TurnDesk — adaptive sign-in + cross-salon email login

- **Date:** 2026-07-10
- **Status:** Design approved (mockup signed off), pending implementation
- **Scope:** Client (`index.html`, `js/app/features/auth.js`, `js/app/apptoken.js`) + Worker (`cloudflare/worker.js`). Version-trio bump + `wrangler deploy`.
- **Security-sensitive:** adds a cross-tenant email→salon lookup. Adversarial security review REQUIRED before deploy.

## Approved design

The sign-in **adapts to which link opened the app** — no toggle:
- **Salon-specific link** (`?salon=<slug>` present, or a cached `td_salon`) → **PIN-first**: the sign-in screen leads with the PIN pad. "Forgot PIN? / Owner sign-in" reveals email/password inline.
- **General link** (bare `…/turndesk/`, no salon) → **email/password**: "Sign in and we'll open your salon." A PIN is meaningless without a salon, so it's not shown.

Plus two behaviors the mockup demonstrated:
- **No silent fails:** every PIN entry shows a status (`Enter your PIN` → `Signing in…` → in / `Incorrect PIN` / `That PIN can't sign in here — use Forgot PIN`). A valid PIN works on a cold device because it always asks the server.
- **Cross-salon lookup:** email/password on the general link finds the owner's salon and routes the device there.

## Part A — Client: adaptive sign-in

`js/app/features/auth.js` + `index.html` (`screen-signin`):
- **Mode decision** in `routeSignedOut()` (or the screen render): `salonSlug()` truthy → PIN-first mode; falsy → email-first ("find your salon") mode. (`salonSlug()` already reads `?salon=`/`td_salon` — apptoken.js:45.)
- **PIN-first mode:** `screen-signin` shows the PIN pad (dots + numpad) as the primary, with a small **"Forgot PIN? · Owner sign-in"** link that reveals the email/password fields inline. Business name as the header.
- **Email-first mode:** `screen-signin` shows email/password ("Find your salon") that calls the new cross-salon login (Part B). No PIN pad.
- **No-silent-fail `checkPin()`** (auth.js:286): remove the branch where a complete PIN with no local match and `fd.length > 0` does nothing. New rule: on a complete PIN (≥ the min length) with no local match, **always attempt the server** (`_serverPinLogin`), showing `Signing in…`; on server reject, show a clear message. So a valid PIN works whether the local config is empty, stale, or synced.
- Keep "Customer check-in" + "Set up this device as the front-desk kiosk".

## Part B — Worker: cross-salon email login

The crux (and the security-sensitive part). Today every `/auth/login` needs a salon slug, and each owner's PBKDF2 hash lives inside that one salon's DO. To make the bare link work we add a salon-agnostic login that finds the salon by email.

1. **Registry email→salon index.** The reserved `__registry__` DO stores `owneremail:<lowercased-email>` → `{ slugs: [<slug>, …] }`. Written whenever an owner credential is set. Touch points (all already know the slug + email): operator create (worker.js:909-913), operator owner-reset (worker.js:945-949), signup approve's `/provision/owner` (worker.js:972). After each successful owner-set, the worker calls a new registry route `POST /registry/index-owner { email, slug }` (append slug if new; dedupe). The index holds **no secret** — only email→slug.
2. **Salon-agnostic login** `POST /auth/find-login { email, password }`:
   - Exempt from the salon guard (add to the worker.js:312 exemption list) and from `appAuthOk` (like `/signup/request`). Forwarded to the registry DO.
   - Registry DO handler: **rate-limit per IP** (reuse the `signup/request` escalating pattern); look up `owneremail:<email>` → slugs; for each slug, call `env.SALON_DO.get(idFromName(slug)).fetch('/auth/login', { email, password })` (the salon DO validates the PBKDF2 hash + mints a salon-scoped session); on the **first** success return `{ ok, slug, token, expires, user }`; otherwise a **generic** `{ ok:false }` (never reveal whether the email exists or which salon).
3. **Client routing** (email-first mode): submit → `POST /auth/find-login` → on ok, persist `td_salon = slug` + the session (`turndesk_session`) + reload to `?salon=<slug>` (now signed in and scoped). On fail, generic "Incorrect email or password."

## Security requirements (verify in the adversarial review)

- **No cross-tenant token:** the returned token is minted by the matched salon's DO and is only valid there (existing `salonId + token` session-cache keying already enforces this). A password for salon A must never yield a session usable on salon B.
- **No enumeration:** identical generic error + no timing signal that reveals whether an email exists or how many salons it maps to. (Iterate all candidate slugs the same way; don't short-circuit in a way that leaks count via timing where avoidable — acceptable given rate-limiting.)
- **Rate-limited:** per-IP escalating slow-down on `find-login`, same as `authLogin`/`signup`, to blunt brute force + enumeration.
- **Index integrity:** `owneremail:` holds only email→slug (no hash). An attacker who somehow reads it learns only which email maps to which slug — still gated by the password at login.
- **Password stays in the salon DO:** the registry never sees or stores the password/hash; it only orchestrates.
- **Email change / re-point:** setting a new owner email adds the new mapping (old mapping is harmless — login still requires the password on that salon; optionally prune later).

## Testing (test-first)

Worker (extend the mock-DO harness; registry + salon DO instances):
1. `index-owner` writes `owneremail:<email>` → slug; a second salon for the same email appends (list of 2).
2. `find-login` with correct email/password → returns the right `slug` + a token; the token validates on that salon (`/auth/check`) and is rejected on another salon.
3. `find-login` wrong password → generic `{ok:false}`, no slug leaked.
4. `find-login` unknown email → generic `{ok:false}`.
5. `find-login` email mapping to 2 salons → returns the salon whose password matches.
6. Rate-limit: N rapid attempts → slow-down.

Client (preview-verify): salon link → PIN-first render; bare link → email-first render; no-silent-fail status; Forgot-PIN reveal.

## Deploy

Worker **first** (`find-login` + `index-owner` + guard exemption), then client (adaptive screen + routing). Version-trio bump. **Backfill the index** for existing salons (demo, krystal-nails-lounge, glamx-demo): a one-time pass that re-indexes each salon's owner email (a small script or an operator route), so the general link works for salons created before this change.

## Out of scope / follow-ups

- Multi-salon chooser UI (if one email owns several salons, we sign into the first password-match; a "pick a salon" screen is a later nicety).
- Staff/tech cross-salon login (techs use the salon-specific staff app; not in scope).
