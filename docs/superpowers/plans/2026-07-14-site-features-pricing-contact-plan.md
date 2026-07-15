# Plan — marketing site: features.html + pricing.html + contact.html (2026-07-14)

**Status: v2 — rewritten from 4-reviewer adversarial review (1 blocker, 9 should-fix, 10 nits
— all accepted or recorded). OWNER SIGNED OFF 2026-07-14 with these decisions:**
1. Payments: beta qualifier YES, **and remove "Helcim" by name from the whole site** (incl.
   index.html's payments card) — phrase as "card processing as low as ~1.8%". (The in-app
   landing.js mentions are app-scoped → separate follow-up task, chip task_b5930744.)
2. Pricing page: NO rate number — just "fees go to your processor; TurnDesk adds no cut."
3. Launch wording: commit to "beta salons hear it first, with advance notice before anything
   changes."
4. Contact: form only, no published email.

## Goal
Finish the standalone marketing site's tab set (`turndesk/site/`): a Features deep-dive page,
an honest Pricing page, and a Contact page whose form feeds the existing demo-request lead
queue. Zero app coupling — the commit must touch ONLY `site/` files (+ docs), no app-version
files, no PROD Worker change.

## Files
| File | Action |
|---|---|
| `site/features.html` | NEW |
| `site/pricing.html` | NEW |
| `site/contact.html` | NEW |
| `site/assets/site.js` | small edit: aria-expanded toggle on the mobile menu button → bump to `site.js?v=3` on ALL FOUR pages (incl. index.html) |
| `site/index.html` | only the `?v=` bump + `aria-expanded`/`aria-controls` attrs on #menu-btn |
| `site/BUILD-NOTES.md` | status update + new deferral/sweep notes (below) |
| `cloudflare/STAGING.md` | fix stale "?api= not yet built" note (it shipped: `js/app/apiorigin.js` + tests) |

## Shared shell — copy EXACTLY, per reviewer findings
- **Copy index.html's FULL `<head>` + body-open verbatim** (Tailwind CDN script, fonts link,
  tailwind.config tokens, `has-js` script BEFORE the CSS link, favicon link, robots meta,
  `site.css?v=4`, the `.material-symbols-outlined{opsz}` style line, body classes
  `bg-surface text-on-surface font-body`) — **then edit per page:** unique `<title>`,
  `<meta name="description">`, `og:title`, `og:description` (og:type stays `website`).
- **`site.js` loads at the END of `<body>`** (index.html:209) — NOT in head; it queries the
  DOM immediately (no defer/DOMContentLoaded), head placement kills reveal/menu/nav-tab.
- Header + footer duplicated inline from index.html (no shared-shell refactor this pass).
  Nav active-tab lights up via the existing `data-nav` logic — no site.js change needed for it.
- index.html's inline `style="transition-delay:.06s"` attributes are **inert** (neutralized by
  site.css's `transition-delay:0s !important`; the real stagger is JS `setTimeout`). Don't
  copy them onto new pages; don't remove the `!important`.
- Reveal animation: existing `.reveal` classes only — **transform-only, never opacity, no CSS
  delays** (the preview-browser gotcha in BUILD-NOTES).

## features.html
- Intro strip + anchor jump-pills for the 8 features.
- 8 deep-dive sections, `id` anchors matching Home's links exactly:
  `turns, checkin, floorplan, reports, payments, texting, booking, ai`. Each section gets
  `scroll-mt-24` (scroll-margin-top — NOT a real margin) so the sticky h-16 header + the 18px
  un-revealed translate never cover anchored content.
- Copy adapted from `js/app/features/landing.js` `LANDING_FEATURES` (title / lead / bullets /
  `soon` lines), static-copied (the site loads no app modules) — with these deliberate,
  honesty-driven divergences:
  - **Texting:** body copy softened to match reality (the only send UI today is the Settings
    test panel; no text-a-customer button exists — sms.js Phase 1). New body: sending is
    built in and live today; texting from a customer's profile + automatic texts are next.
    Keep the auto-send `soon` line.
  - **AI:** landing.js's `soon` line is STALE (the dashboard "Ask About Your Data" panel
    already shipped — index.html ai-q + reports.js aiAsk → /ai/ask; only the PHONE app button
    is missing). features.html states the accurate version. (landing.js gets the same fix in
    a separate app-scoped pass — out of scope here; tracked as a follow-up chip.)
  - **Payments:** subject to owner decision Q1 (below) — default adds a beta-status
    qualifier line.
  - All other `soon` lines (turns fairness-rule, reports on-the-go calendar, booking
    entirely) kept verbatim.
- Visuals: port the THREE faithful app-window recreations from site/index.html's showcase
  (turn grid, floor plan, daily report) + port `REC_PAYMENTS` (the effective-rate card) from
  landing.js:94-101 into static HTML. Build ONE new faithful window for the Check-In Kiosk
  (fully shipped — checkin.js collects exactly name/phone/services; a simple form mock in the
  same window style is honest). Texting / Booking / AI get icon treatment only — NO invented
  screenshots for features that aren't fully built.
- Alternating two-column rows (copy | visual) desktop, stacked mobile. CTA card + footer.

## pricing.html
- HONEST framing: free during beta, pricing at launch — **no invented prices, no fake tiers.**
- Centerpiece "Free beta" card: $0 during beta, no credit card (both code-verified true).
  Feature line phrased **"everything TurnDesk does today — no feature tiers"** (NOT "all
  features included", which collides with booking/auto-texts being unshipped).
- Sign-up reality stated plainly: "Start free beta" is an approval-gated REQUEST
  (signup.html: "Request access — we'll review it and send your salon link") — the pricing
  page must not imply instant self-serve start. FAQ gets "How do I start / how long until
  I'm in?" answering with the review-then-link flow.
- "What happens at launch" block — wording per owner decision Q3.
- Card-processing block — per owner decisions Q1 + Q2. Code-verified fact that CAN be stated
  regardless: TurnDesk itself adds no per-transaction cut (no fee logic anywhere in the
  charge path).
- Short FAQ (really free? · how do I start? · what at launch? · hardware? · processing?).
- CTA card + footer.

## contact.html
- Centerpiece: the demo-request form — name, email, phone (optional), "what are you looking
  for?" → `POST /demo/request` on the prod Worker
  (`https://turndesk.musenailandspa.workers.dev`), body `{name,email,phone,lookingFor}`.
  Client limits mirror `cloudflare/demo-util.js` exactly: name ≤60, email format ≤120,
  phone ≤40, lookingFor 1–500.
- **Form accessibility + no-JS (reviewer-mandated):** real `<label for>` on all four fields;
  `aria-live="polite"` on the inline error line; `autocomplete="name|email|tel"`;
  focus moves to the success panel on success; **`method="post"`** on the form so a no-JS
  submit gets a 405 from GitHub Pages instead of leaking name/email/phone into the URL as a
  GET; a `<noscript>` notice ("the form needs JavaScript — email us via the sign-up page"
  → actually: noscript points at the signup/demo app page). Mobile-menu button gains
  `aria-expanded`/`aria-controls` (the one site.js change).
- Implementation: small page-local inline script (plain JS): submit handler (Enter works),
  disabled-button "Sending…" state, inline error line, success-panel swap. Server error
  shapes it must surface via `j.error || generic` (demo.js pattern): 400 `{error:<specific>}`,
  429 rate-limit (5/IP/hour), 503 queue-full (200 pending), 500 internal.
- **`?api=` staging override — BLOCKER-grade spec (do not loosen):**
  - Exact-match allowlist ONLY: `https://turndesk-staging.musenailandspa.workers.dev` and
    `http://localhost:8787`. Any other value is IGNORED (falls back to prod).
  - Read per-page-load from `location.search` only. **NEVER written to localStorage** — the
    site shares the `musenail.github.io` origin with the live app; touching `td_api_origin`
    would repoint the REAL app to staging, and any persistence would silently send future
    real leads to the staging queue nobody reviews.
- NOT building the optional `/contact` Worker route — `/demo/request` already exists,
  validated + rate-limited + unit-tested; the lead lands in the same operator queue.
- No published email/phone by default (owner decision Q4 can add one). Secondary CTA → signup.

## Verified facts recorded from review (no action needed)
- **CORS is fine now and after the domain move:** Worker sends `Access-Control-Allow-Origin: *`
  on everything incl. errors; OPTIONS preflight → 204. Works from localhost, github.io,
  turndesk.net with zero Worker change.
- **Migration landmine (recorded in BUILD-NOTES):** the dormant `ORIGIN_GATE_ENABLED` origin
  allowlist only knows `https://musenail.github.io` — if that gate is EVER enabled, add
  `https://turndesk.net` (+ www) to `ALLOWED_ORIGINS` first, or the contact form 403s from
  the new domain only.
- `/demo/request` route: auth-exempt, salon-exempt, validation-before-rate-limit, leads
  excluded from snapshots/backups.

## Verification (browser is the test rig; per-page)
1. Serve via `C:/Users/cpach/Documents/GitHub/musedashboard/.claude/serve-turndesk.ps1`
   (port 5050 — the script lives in the MUSEDASHBOARD repo, not turndesk). Cache-bust `?v=`.
2. Each page, desktop + mobile widths: correct per-page `<title>`/meta, nav active-tab,
   mobile menu (incl. aria-expanded), reveal animation (content NEVER blank — the same rig
   that caught the original opacity bug), console clean.
3. Anchors: all 8 Home feature cards → `features.html#<key>` land with the section heading
   visible below the sticky header.
4. Contact form, in order:
   a. **Staging pre-probe (free):** `POST <staging>/demo/request` with `{}` → expect
      400 "Enter your name." (proves route live, consumes no rate budget, stores nothing).
      If 404 → staging predates td-v0.44 → `wrangler deploy --env staging` (allowed: staging
      is the isolated env; PROD Worker stays untouched).
   b. Each client-validation path.
   c. ONE DevTools-crafted invalid POST (bypassing client checks) against staging → confirms
      the server-error render path (`j.error` inline) actually works.
   d. ONE end-to-end submit with `?api=<staging>` → 200 + success panel + focus lands there.
   e. Confirm `?api=https://evil.example` is ignored (network tab shows prod origin) and
      localStorage has NO new keys.
   f. **NO prod submission** (the last smoke-test lead is still in the prod queue).
   g. Awareness: staging enforces the same 5/IP/hour limit — don't loop full submits.
5. Keyboard + no-JS pass on the form (tab order, labels announce, no-JS = 405 not URL leak).
6. `git status` scope check: ONLY `site/` + docs changed → app not bumped.

## BUILD-NOTES.md additions (while touching it)
- Deferral (deliberate): no 404 page / robots.txt / sitemap at the github.io subpath — add
  them at the turndesk.net Cloudflare Pages step; no analytics by choice, revisit then too.
- Sweep note: at domain migration, sweep the ~8 absolute `musenail.github.io/turndesk/` app
  links across ALL FOUR pages; at launch, sweep beta copy + rewrite pricing.html.
- The ORIGIN_GATE_ENABLED/ALLOWED_ORIGINS landmine (above).

## Rollback
Purely additive static files + a 2-line site.js aria change: revert = `git revert`. No prod
Worker change, no app version bump, no persisted-data surface.

## Owner decisions needed (sign-off gate)
1. **Payments honesty (features + pricing):** the "bring your own processor / fees paid to
   your processor" copy is live on Home but contradicted by the repo's own data-safety review
   (E1: shared Helcim/Square accounts; new salons seeded `processor='none'`; no per-salon
   hookup exists). Default proposal: keep the pitch but add a beta-status line — "During the
   beta, new salons start with cash/manual checkout; card-processor hookup is arranged
   individually as we roll it out." Or keep Home's wording as-is (owner accepts the gap).
2. **The ~1.8% number on the pricing page:** repeat it with a qualifier ("effective rate from
   real statements at our flagship salon — varies by card mix"), repeat as-is like Home, or
   leave the number off pricing entirely.
3. **"At launch" wording:** OK to commit to "beta salons get advance notice before anything
   changes"? (mild but real promise) — or the weaker "pricing will be announced at launch."
4. **Contact channel:** form only (default), or also publish a contact email address?
