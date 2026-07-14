# TurnDesk — Domain Migration + Landing Page + Per-Salon URLs

**Date:** 2026-07-14
**Status:** Sequencing agreed with the owner. Landing page not yet built. Hosting not yet moved.
**Scope:** Three separate, sequential efforts — do not merge them into one pass.

## Goal

Move TurnDesk's public-facing client off `musenail.github.io/turndesk/` (shared origin with the live
`musedashboard` salon app) onto the owner's own domain, **`turndesk.net`**, with a real landing page —
without disrupting the first live beta salon (Krystal Nails Lounge, slug `krystal-nails-lounge`) or its
staff's day-to-day sign-in.

## ⭐ Key finding — read this before touching any of this

**The "sign in on the landing page, get redirected to your own salon" mechanism already exists and is
already live.** It is NOT new work. See `docs/superpowers/specs/2026-07-10-turndesk-adaptive-signin-cross-salon-login.md`
(its "Status: pending implementation" line is now stale — it shipped: `js/app/features/auth.js` +
`js/app/apptoken.js` `serverFindLogin()` + Worker `POST /auth/find-login` / `TurnDeskDO.findLogin`, tested in
`test/worker-cross-salon-login.test.js`, and confirmed on `main` == `origin/main` as of 2026-07-14).

How it works today: open the bare link (`musenail.github.io/turndesk/`, **no** `?salon=`) → `index.html`'s
`#screen-signin` renders `#signin-email-mode` (owner email + password, no PIN pad) instead of the normal
PIN-first flow → submits to the registry (`owneremail:<email>` → candidate slugs → tries each salon's own
`/auth/login`) → on success, claims that salon's slug for the device and mints a session scoped to it. A
salon-specific link (`?salon=<slug>`, e.g. Krystal's) is completely unaffected — staff there still see the
PIN pad first, exactly as today.

**Consequence:** this whole task is a hosting move + a content pass, not new auth/routing engineering.
Do not rebuild or duplicate this login flow.

## The three efforts, in this order — do not reorder or merge

### 1. Landing page (build first, before touching hosting)
Currently `#signin-email-mode` (index.html) is a bare "Sign in to your business" card with no marketing
content — the code literally comments it as a "Temporary TurnDesk welcome mark." Turn it into a real
landing-page experience.

**Recommended architecture:** enhance the *existing* bare-front-door render path in place (same file, same
gating condition — no salon known) rather than introducing a new file or a new URL structure. A separate
marketing file that re-implements its own login form would duplicate the tested auth logic and risk drift;
a new `/app`-prefixed URL structure would be a second breaking change bundled into this one. Keep it to one
file, one code path, real content wrapped around the same working sign-in card.

**Explicitly out of scope for this step:** the domain/hosting move (step 2) and per-salon path URLs (step 3).

**Owner decisions locked in 2026-07-14** (bake these into the build, don't re-ask): visual tone = a
**distinct marketing-site look** (bigger hero, more visual punch than the existing in-app aesthetic — first
impression matters most here); messaging = **openly say "Free beta"** (no pricing, no named customers yet).

The exact build prompt used is in Appendix A below — reuse it verbatim for a fresh session.

### 2. Move client hosting to Cloudflare Pages @ turndesk.net (only after step 1 ships)
- **Host:** Cloudflare Pages, a new deploy of this same repo, DNS pointed at `turndesk.net` (root domain —
  owner intends the whole customer-facing product at the root, not a subdomain).
- **Do NOT touch the existing GitHub Pages deploy at all.** `musenail.github.io/turndesk/` must keep serving
  unchanged and indefinitely — it's Krystal's current live link (`?salon=krystal-nails-lounge`) and the
  safety net during transition. (Reasoning the owner and I worked through: GitHub Pages auto-redirects the
  `github.io` URL once a custom domain is added to the *same* repo's Pages settings — that would kill the
  old link. A separate Cloudflare Pages deploy avoids that entirely; two hosts, one Worker backend, no
  forced cutover.)
- **The Worker does not move.** `https://turndesk.musenailandspa.workers.dev` stays exactly as-is — tenant
  routing is slug-based in the Worker/DO layer and has zero coupling to which origin serves the static
  files. No OAuth redirect URIs, no webhook URLs, no `ALLOWED_ORIGINS`/origin-gate changes are needed unless
  the origin-gate is ever turned on (it's off by default) or the owner separately decides to also move the
  API to a branded domain (e.g. `api.turndesk.net`) — optional, unrelated, not part of this effort.
- **Per-device cost when Krystal (or any salon) does switch to the new link:** re-enter PIN once (session
  lives in localStorage, not carried across origins); anyone with "added to home screen" for push needs to
  redo that from the new domain. No data loss — data lives in the Durable Object, untouched by any of this.
- Once verified end-to-end on the new domain, hand out `turndesk.net/?salon=krystal-nails-lounge` (or
  whatever the new link looks like) — no forced timeline to retire the old one.

### 3. Fix per-salon URLs (only after step 2 is live and verified — not before)
Today, after sign-in (either path) the salon slug lives in `localStorage` (`td_salon`) and the address bar
stays on `?salon=<slug>` — functionally complete, cosmetically not what the owner wants. Target:
`turndesk.net/dashboard/krystal-nails-lounge`-style paths.

This is a real, scoped routing change, deliberately deferred to its own pass:
- A static-host rewrite (Cloudflare Pages `_redirects` or a thin Worker route) that maps any
  `/dashboard/*` path to serve the same `index.html`, so no per-salon static files are needed.
- A client change: `apptoken.js` `salonSlug()`/`urlSalonSlug()` currently read only
  `location.search`'s `?salon=` — they'd need to also parse `location.pathname` for the slug.
- Nothing about this blocks or is blocked by Krystal's usage in the meantime — the existing `?salon=` link
  keeps working exactly as it does today, on either domain.

## Non-goals (explicitly out of scope for all three steps above)
- Krystal's staff PIN sign-in flow — untouched throughout.
- The Worker's own domain / OAuth client / webhook URLs — untouched (see step 2).
- Any change to `signup.html`'s self-serve request flow (may be *linked from* the new landing page; not
  itself part of this work).

---

## Appendix A — build prompt for Step 1 (landing page), ready to paste into a fresh session

Build a real marketing landing page for TurnDesk's public "bare front door" — the screen a visitor sees at
the root URL with no salon context yet (no `?salon=`). Right now it's a bare "Sign in to your business"
card with zero marketing content; turn it into a real product landing page while leaving the actual
sign-in mechanism completely untouched.

**Read first:** `docs/superpowers/plans/2026-07-14-turndesk-domain-migration.md` (this doc) for full context
on what already exists and what comes after this step.

**Critical constraint — do not rebuild or duplicate auth.** The "sign in and get routed to your own salon"
flow already exists and is live: `index.html` `#screen-signin` → `#signin-email-mode` (shown only when no
salon is known) → `js/app/features/auth.js` calls `serverFindLogin()` in `js/app/apptoken.js` → Worker
`POST /auth/find-login` looks the owner up by email across all salons and returns a session scoped to the
matched one. This is security-sensitive, tested (`test/worker-cross-salon-login.test.js`), and shipped.
Your job is the content and visual design around this existing sign-in card, not its logic.

**Scope:** modify `index.html`'s `#screen-signin` / `#signin-email-mode` block (plus whatever supporting
CSS/markup it needs) so the bare front door reads like a real product page: a headline/value prop, a
handful of feature highlights (front-desk check-in queue, the fair-rotation "turns" engine, reports/payroll
— see `CLAUDE.md` "What This Is" for the accurate feature list), and the existing sign-in card kept intact
as the primary call-to-action. Add a path for brand-new prospects who don't have an account yet, linking to
the existing `signup.html` self-serve request flow.

**Visual tone and messaging (owner-decided, don't re-ask):** go for a distinct marketing-site look — a
real hero section, more visual punch than the existing in-app screens, first impression matters most here.
Openly say **"Free beta"** somewhere prominent; no pricing, no named customers yet.

**Stay in the existing stack:** plain ES2020+ modules, Tailwind CDN utility classes, no build step, no new
frameworks — reuse the CSS variable tokens and Material Symbols icons already used elsewhere in `index.html`.

**Explicitly out of scope — do not do these:**
- Do not move hosting or touch the domain (that's Step 2, later, tracked in this same doc).
- Do not build path-based per-salon URLs (`/dashboard/<slug>`) — deliberately deferred as Step 3.
- Do not touch `#signin-pin-mode`, the PIN pad, `serverLogin()`, or any Worker auth route.

**Before you're done:** preview it in a browser at the bare URL (no `?salon=`) and separately confirm the
salon-specific PIN flow (`?salon=<slug>`) still renders exactly as before — this change must not regress
that path. Follow this repo's own conventions (`CLAUDE.md` — commit freely, ask before `git push`;
version-trio bump if the change is user-visible).
