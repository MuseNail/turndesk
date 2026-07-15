# TurnDesk marketing site — build notes (for continuing in a fresh session)

**What this is:** a STANDALONE marketing site in `site/`, separate from the app. No service
worker, no app-version coupling — editing these files never bumps the app or prompts salon
devices to update. Destined for **turndesk.net**; previewed at `musenail.github.io/turndesk/site/`.

## Status (2026-07-14)
- ✅ `site/index.html` — Home page (built + live for preview).
- ✅ `site/assets/site.js` (scroll-reveal + active-tab + mobile menu w/ aria-expanded) ·
  `site.css` (motion).
- ✅ `site/assets/turndesk-appicon.svg`, `turndesk-mark.svg` (logo).
- ✅ `features.html` — 8 anchored deep-dives (`#turns #checkin #floorplan #reports #payments
  #texting #booking #ai`, matching Home's card links); ported the 3 showcase windows + the
  payments-rate card (from the app's landing.js REC_PAYMENTS) + a new Check-In Kiosk window;
  every "Launching soon" honesty line kept (texting body softened, AI line refreshed to the
  accurate shipped state — the app's landing.js still needs the same copy fixes, tracked
  separately).
- ✅ `pricing.html` — honest: $0 beta card ("everything TurnDesk does today — no feature
  tiers"), approval-gated start stated plainly, launch promise ("beta salons hear it first,
  advance notice"), card-processing block (fees go to the processor, no TurnDesk cut, beta =
  cash/manual-first; NO rate number here per owner), 5-question FAQ.
- ✅ `contact.html` + `assets/contact.js` (ES module, unit-tested in `test/site-contact.test.js`)
  — labeled/aria-live form → `POST /demo/request` (prod Worker). ⚠️ SECURITY invariant: the
  `?api=` test override is an EXACT-match allow-list (staging + localhost:8787 ONLY) and is
  NEVER persisted — this page shares the github.io origin with the live app, so writing
  localStorage here (esp. `td_api_origin`) would silently repoint the real app. Form is
  `method="post"` so a no-JS submit 405s instead of leaking PII into the URL.
- ⚠️ **Owner copy rule (2026-07-14): never name the card processor** on the site — say
  "card processing as low as ~1.8% effective". (index.html's payments card was reworded;
  the app's landing.js still names it — separate app-scoped follow-up.)
- ⬜ **turndesk.net DNS** — owner's GoDaddy; no `gh`/Cloudflare CLI in the agent env, so prep
  files + hand the owner exact records. AT THAT STEP also (deliberately deferred until then):
  - a 404 page + robots.txt + sitemap (pointless at the github.io subpath);
  - analytics (none today, by choice);
  - sweep the ~8 absolute `musenail.github.io/turndesk/` app links per page (×4 pages now);
  - ⚠️ if the Worker's `ORIGIN_GATE_ENABLED` secret is EVER turned on, add
    `https://turndesk.net` (+ www) to `ALLOWED_ORIGINS` first — the gate's built-in allow is
    github.io only, and the contact form would 403 from the new domain (CORS itself is `*`
    and needs no change).
- At LAUNCH (beta ends): sweep "Free beta" copy across all 4 pages + rewrite pricing.html.

## Conventions (match index.html exactly)
- Plain HTML per page, Tailwind **CDN** (no build step). Each page's `<head>` repeats the same
  `tailwind.config` teal tokens: primary `#1a5252`, primary-dim `#0f3d3d`, primary-container
  `#8fd4d3`, on-primary `#fff`, on-primary-container `#0a2e2e`, secondary-container `#f5c870`,
  on-secondary-container `#3a2800`, surface `#e8ecee`, surface-lowest `#f5f7f8`, surface-high
  `#c2cacd`, on-surface `#0b1f1f`, on-surface-variant `#4a5258`. Fonts: Manrope (headline) +
  Inter (body) + Material Symbols.
- **Shared header + footer are currently DUPLICATED inline** in index.html (copy them into each
  new page; or refactor to a `site.js`-injected shell if it gets unwieldy — a build step is the
  real fix but not now).
- Include `<script>document.documentElement.classList.add('has-js')</script>` in `<head>` before
  the CSS, and load `assets/site.css?v=N` + `assets/site.js?v=N` (bump N to cache-bust).
- App links are absolute: sign-in `https://musenail.github.io/turndesk/`, signup
  `.../signup.html`. (When turndesk.net + app subdomain exist, revisit these.)

## ⚠️ Animation gotcha (do NOT reintroduce)
- Reveal-on-scroll is **transform-only, never opacity**, and content is visible by default
  (`.has-js .reveal` only adds the transform). Reason: this preview browser leaves OPACITY
  transitions stuck at 0 → nearly shipped invisible sections. Keep it transform-only so content
  can never render blank.
- Do NOT use CSS `transition-delay` for stagger (it ALSO got stuck at the start value) — stagger
  in JS via `setTimeout` in `site.js`'s `sweep()`.
- The simple local server (`.claude/serve-turndesk.ps1`, port 5050 → `/site/index.html`) sends no
  cache headers → the browser caches `site.css`/`site.js`; use the `?v=N` bust when testing.
