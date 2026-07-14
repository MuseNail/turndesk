# TurnDesk marketing site — build notes (for continuing in a fresh session)

**What this is:** a STANDALONE marketing site in `site/`, separate from the app. No service
worker, no app-version coupling — editing these files never bumps the app or prompts salon
devices to update. Destined for **turndesk.net**; previewed at `musenail.github.io/turndesk/site/`.

## Status (2026-07-14)
- ✅ `site/index.html` — Home page (built + live for preview).
- ✅ `site/assets/site.js` (scroll-reveal + active-tab + mobile menu) · `site.css` (motion).
- ✅ `site/assets/turndesk-appicon.svg`, `turndesk-mark.svg` (logo).
- ⬜ `features.html` — deep-dives per feature (reuse the app-matched preview windows from
  index.html's showcase; the Home feature cards link to `features.html#turns` etc.).
- ⬜ `pricing.html` — HONEST: "free during beta, pricing at launch" (no invented prices).
- ⬜ `contact.html` — a form that POSTs to the Worker `POST /demo/request`
  (`https://turndesk.musenailandspa.workers.dev/demo/request`, body `{name,email,phone,lookingFor}`,
  validated by `cloudflare/demo-util.js`). Reuse `js/app/demo.js`'s fetch pattern (standalone,
  no app modules). Optional: add a parallel `/contact` Worker route mirroring `/demo/request`.
- ⬜ **turndesk.net DNS** — owner's GoDaddy; no `gh`/Cloudflare CLI in the agent env, so prep
  files + hand the owner exact records.

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
