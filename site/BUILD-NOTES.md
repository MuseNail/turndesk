# TurnDesk marketing site — build notes (for continuing in a fresh session)

**What this is:** a STANDALONE marketing site in `site/`, separate from the app. No service
worker, no app-version coupling — editing these files never bumps the app or prompts salon
devices to update. Destined for **turndesk.net**; previewed at `musenail.github.io/turndesk/site/`.

## Status — SITE COMPLETE + LIVE (2026-07-14)
All 4 pages built, styled, and pushed to `main` (GitHub Pages serves them). Asset cache-bust
currently at `site.css?v=7` + `site.js?v=3` (bump N on ALL 4 pages when you touch those files).
- ✅ `site/index.html` — Home: hero, stat strip, "See it in action" (3 rendered windows), 8
  feature cards → `features.html#...`, CTA, footer.
- ✅ `features.html` — 8 anchored deep-dives (`#turns #checkin #floorplan #reports #payments
  #texting #booking #ai`).
- ✅ `pricing.html` — honest $0 beta card, approval-gated start, launch promise, card-processing
  block (NO rate number per owner), 5-Q FAQ.
- ✅ `contact.html` + `assets/contact.js` (ES module, tested in `test/site-contact.test.js`).
- ✅ `assets/site.js` (scroll-reveal + active-tab + mobile menu w/ aria-expanded) · `site.css`
  (motion + `.appshot` browser-frame + `.appshot__body` rendering + `.illus` illustration).
- ✅ `assets/turndesk-appicon.svg`, `turndesk-mark.svg` (OLD ring+dot logo — superseded 2026-07-15
  below, kept in place for history/rollback but no longer referenced by any page).

### ⭐ New T+D logomark (2026-07-15) — replaces the ring+dot mark everywhere on the site
Owner supplied their own logo (a merged T+D monogram with a 2×2 "dashboard" grid in the D's
counter, black/blue/teal on white) and asked for an EXACT recolor — same file, same structure,
brand colors only, no redrawing. Built via a real pixel-level remap (Node + `jimp`, alpha-blend-
against-white solved per pixel so anti-aliased edges recolor cleanly, not a hand-traced SVG):
blue→primary `#1a5252`, the lighter teal→primary-container `#8fd4d3`, black→on-surface `#0b1f1f`.
One grid square (top-right) is gilded to secondary-container `#f5c870` as a deliberate callback —
same gold the OLD icon used for "whose turn is next."
- `assets/turndesk-mark-color.png` — icon-only, tight crop, transparent background, light-on-white
  palette. Used in the header (`h-8 w-auto`) and footer (`h-7 w-auto`) `<img>` on all 4 pages,
  replacing the inline ring+dot `<svg>` (no more `bg-primary` badge tile — the new mark carries
  its own colors and doesn't want a teal square behind it).
- `assets/turndesk-appicon-{32,192,512}.png` — the same mark with ink swapped to white and the
  two teals separated (primary→mint, mint→cream `#eafffb`) for contrast, composited on a plain
  primary-teal tile. Wired as `<link rel="icon" type="image/png">` (32px) and
  `<link rel="apple-touch-icon">` (192px) on all 4 pages.
- Master source files (full lockup incl. wordmark, both light + gold variants, 1254×1254) live in
  the owner's Downloads (`TurnDesk-logo-brandcolor.png` / `-gold.png`), not the repo — re-derive
  from those if the app-icon/PWA-icon work ("eventually add this to the app") needs different crops
  or sizes later.

### ⭐ Visuals are RENDERINGS, not screenshots (owner decision — anti-copy)
Owner did NOT want raw app screenshots (competitors could copy the exact UI). Every product
visual is a **restyled HTML/SVG recreation** inside a `.appshot` browser-window frame — TurnDesk-
flavored but deliberately NOT a pixel copy (different names, "Chair N" vs station codes, tighter
rows). Built from owner-sent reference screenshots. The old `assets/screens/*.png` slots + the
`assets/screens/` folder were REMOVED — no PNGs are needed. features.html visuals:
- **Turn Board** — 5 techs, each row a set of per-turn mini-cards showing **customer name + turn number + service + price** (done = soft-green, in-service = teal "now", half = cream 3½; +Nb bonus badge in the tech column). Enriched 2026-07-15 from the old service-token grid so it shows the detail that sets TurnDesk apart.
- **Check-In** — walk-in form (phone/name/service chips/Check In). ⬜ owner wants BOTH check-in screens shown (kiosk welcome + form) — pending the reference images.
- **Floor Plan** — **FULL-WIDTH** rendering (its own section is full-bleed, not the 2-col split) that mirrors the real app screen: a "Not seated — drag onto a station (3)" chip bar, **P1–P12 pedi pill columns** (left P1–P6 / right P7–P12, top two occupied w/ service·tech·price + timer), a **M1–M15 mani grid** (M1/M5/M7 occupied w/ service·tech·price + timer + corner code), and a **tech turn bar** (turn-count badges + red "In Service" / green "Available" + "↑ Next"). Rebuilt 2026-07-15 from the owner's screen clip. Mani grid uses `repeat(5,minmax(0,1fr))` for even columns; wrapper `min-width:860px` inside `overflow-x:auto` so it scrolls on phones.
- **Reports & Payroll** — metrics strip + compact Staff Breakdown (commission per tech) + Top Services
- **Payments** — checkout modal (line items / tip% / tender / Charge)
- **Text Updates** SVG — appointment reminder · **Smart Booking** SVG — multi-staff day calendar · **AI Insights** SVG — ask-your-data
- The 3 Home "See it in action" windows are compact renderings of Turns / Floor / Report.
- All reflect the app's new color language: **red = Working now, green = Available** (see the app hotfix below).

### Type scale (unified 2026-07-15)
Page/hero **H1** stay largest — home hero `text-4xl md:text-5xl` (48), features intro H1 `text-[2rem] md:text-[2.6rem]` (~42) `leading-[1.1] tracking-tight`. **Section H2s** (both pages) are the clear second level: `text-2xl md:text-3xl font-headline font-extrabold tracking-tight` (~30). Before this, section H2s were `md:text-4xl` (36) and — wrapping to 3 lines in the narrow half-columns — read as big as (or bigger than) the page title, which looked "off." Keep new H2s ≤ H1 when adding sections.

### Cosmetic + honesty notes (shipped)
- Container widened `max-w-6xl`(1152)→`max-w-[1400px]`; prose type bumped (hero 48px, body 16px);
  richer transform-only motion + hover-lift.
- ⚠️ **Owner copy rule: never name the card processor** — say "card processing as low as ~1.8%".
  (Site done; the APP's landing.js STILL names it → separate app-scoped follow-up, chip task_b5930744.)
- Honesty: texting/booking/AI-phone flagged "launching soon"; pricing has no rate number.

### ⭐ Related app hotfix (NOT the site — the salon app)
Turns "Available" vs "Working now" both read green → fixed to match the floor plan: In Service =
red (#fa746f), Available = green (#2a7a4f), in `js/app/features/turns.js`. SHIPPED **TurnDesk
td-v0.47** (main) + **Muse v5.43** (main, standalone color-only hotfix via worktree — Phase 3
work stays on `dev`; next Muse dev→main release must bump PAST v5.43). Demo salon was cleaned of
6 stale ~230h ghost entries + given a fresh 19-entry busy midday board (all today-dated).

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
