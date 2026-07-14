# TurnDesk — Architecture & Tooling Notes

**Date:** 2026-07-14. Captures decisions from a working session on the app's stack, a build
step, and where the marketing website should live.

## The two worlds: the app vs. the website

Keep these mentally separate — they have different jobs and different best tools:

| | The APP | The WEBSITE |
|---|---|---|
| What | The product: check-in, turns, floor plan, POS, reports | Marketing / landing page |
| Needs | Stability, live uptime, integration | Looks great, easy to edit, fast, SEO, converts visitors |
| Stack | Vanilla JS, no build step (keep it) | Standalone — free to use the best tools |
| Connection | — | "Sign in" / "Start free beta" buttons just **link** to the app |

## 1. Is vanilla JavaScript right for the app?

**Not what I'd pick for a brand-new app this size — but the right call to KEEP.**
- Downsides of vanilla: when data changes, the screen doesn't update itself — code updates each
  element by hand (that's `store.js` + the `render...()` functions). Modern frameworks (React,
  Svelte) do that automatically = fewer bugs, less code. The app also leans on a fragile trick
  (attaching functions to `window`) for inline `onclick`s.
- Why keep it anyway: the app is **live, handling real money, and works**. Rewriting into a
  framework = months of work, real risk of bugs in a payments system, and **zero new customer
  value** during the rewrite. The downsides are real but manageable. Don't rewrite what works.

## 2. What is a build step — and should we add one?

**Plain version:** a "prep kitchen." You write code comfortably; a program (Vite, esbuild)
packages it into fast, optimized files before the browser gets them (bundling, shrinking,
compiling Tailwind properly, etc.).

- The app has **none** today: the browser loads source files as-is, and Tailwind runs via a CDN
  (officially flagged "not for production" — slower/heavier than compiled).
- **For the app:** optional, not urgent. The one real win would be compiling Tailwind properly.
  But a build step removes the current simplicity (edit → refresh → live) and adds a compile
  stage that can fail. Not worth rushing.
- **For a standalone website:** a build step (or a builder) makes total sense — clean slate,
  no live-app risk.

## 3. The website should be standalone and connect to the app  ✅ (owner's call — correct)

Today the landing page is **embedded inside the app** (`index.html`) — expedient, but it should
be its **own standalone thing**. Because a standalone site is a clean slate with no live-app risk,
it can freely use the best tools (a build step, a framework, or a no-code builder like Squarespace/
Framer). The app being vanilla does **not** hold the website back.

**Connection = links only:** the website's buttons point at the app's URL, where the real,
security-sensitive sign-in already lives (untouched). Website markets → app runs the salon.

## Decisions (2026-07-14)
1. **App stays vanilla JS, no build step.** Don't rewrite; it works.
2. **Keep iterating the embedded landing for now.** All the *content* (words, colors, logo,
   structure) carries over to whatever standalone form comes later, so it's not wasted work.
3. **The website goes standalone when ready** — Squarespace (no-code; owner already has a
   Squarespace account, but note: Squarespace bills **per site**, so a second site = a second
   subscription) OR a coded standalone site. Deferred, not urgent.
4. **Feature previews on the landing** should look **exactly like the app**. Method: recreate them
   from the app's **real source code** (`turns.js`, `floorplan.js`, `reports.js`, `status.js`,
   `styles.css`) so they use the app's real markup/classes — pixel-close, crisp, and blur-able to
   deter copycats. (Not sign-in screenshots — see tooling note; the owner can also supply literal
   screenshots from the demo salon if ever wanted.)

## Tooling: screenshot tool (Playwright MCP)

Goal: give the AI assistant a reliable way to *see* rendered pages (the built-in screenshot kept
timing out in one session). One-time setup, best run from an **interactive** Claude Code session:

```
claude mcp add -s user playwright -- npx @playwright/mcp@latest
npx playwright install chromium
```

Notes: needs Node.js; verify the exact command against the current Playwright MCP docs (flags
change); a newly-added MCP server becomes available on the **next** session start, not mid-session.
