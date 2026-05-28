# TurnDesk

**TurnDesk** is a multi-tenant SaaS front-desk app for nail salons — check-in queue, a fair-rotation "turns" engine, floor plan, reports, payroll, gift cards, and pluggable payment processors (Square / Stripe / Helcim).

It is a productization of a battle-tested single-salon app, rebuilt to serve many salons, each isolated in its own data store.

## Tech

- **Frontend:** vanilla ES modules, no build step, no framework (Tailwind via CDN). Served as static files by GitHub Pages at `/turndesk/`.
- **Backend:** a Cloudflare Worker + a per-tenant Durable Object as the source of truth, with R2 (photos), KV, a daily backup cron, and Web Push.
- **Sync:** WebSocket with an HTTP fallback and an offline outbox.

## Status

Early development. See `CLAUDE.md` for architecture, the isolation rules, the P0→P5 build plan, and the current open follow-ups.

## Develop

```
npm test                          # run the unit test suite (Node's built-in runner)
npm run check                     # syntax-check the Cloudflare Worker
```

There is no frontend build — open `index.html` through any static server (or the project preview) to run the app.
