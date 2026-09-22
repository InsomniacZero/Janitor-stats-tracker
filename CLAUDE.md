# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

JStats: a statistics tracker/dashboard for JanitorAI character metrics (messages, chats, comments, favourites, published chats). It ships as three things from one codebase:

1. A Vite web app deployed to Vercel (`index.html`, `dashboard.html`, `popup.html`).
2. An unpacked Chrome MV3 extension (same source files, loaded directly — no separate build).
3. A headless Playwright worker (`scripts/cloud-worker.js`) run on a schedule via GitHub Actions for $0-cost 24/7 tracking when no browser is open.

All three write to the same Supabase Postgres backend (or fall back to local IndexedDB when Supabase isn't configured), so data stays consistent across the extension, the live dashboard, and the cloud worker.

## Commands

```bash
npm install              # install deps
npm run dev               # Vite dev server (port 5173)
npm run build              # production build -> dist/ (Vercel entrypoint)
npm run preview            # preview production build
npm run worker             # run the headless Playwright cloud worker locally
bash init.sh               # first-time setup: copies .env, installs deps + Playwright chromium, builds
node scripts/run-tests.js  # run the test suite (no test runner framework — plain Node script)
```

There is no `npm test` script wired up yet — invoke `scripts/run-tests.js` directly with `node`. Tests are plain functions (`it(...)` / `runAsync(...)`) run top-to-bottom in that one file; there's no filtering flag for running a single test — comment out or temporarily isolate the block you care about.

Chrome extension: `chrome://extensions` -> enable Developer mode -> Load unpacked -> select repo root (uses `manifest.json` directly, not `dist/`).

## Architecture

### Data capture pipeline (extension side)

Stats are captured through a layered content-script setup because JanitorAI is behind Cloudflare and stats aren't reliably present in the plain DOM:

- `injected_main.js` runs in the page's MAIN world at `document_start`. It monkey-patches `window.fetch` and `XMLHttpRequest` to intercept JanitorAI's own API responses (`/hampter/characters/*`, following-feed payloads, reviews) and can also fire authenticated in-page fetches reusing the page's session/Cloudflare clearance. It talks to `content.js` exclusively via `window.postMessage`.
- `content.js` runs in the isolated content-script world at `document_idle`. It listens for the postMessage traffic from `injected_main.js`, falls back to DOM scraping (`getMessagesAndChats`, `getFavourites`, `getComments`, etc.) when the intercepted payload is incomplete, and forwards finished snapshots to the background service worker.
- `background.js` is the MV3 service worker. It owns a `chrome.alarms` timer (`janitorai-stats-refresh`, every 1 minute) that drives `scrapeCharacterById` / `scrapeViaBackgroundTab` for every actively tracked job, persists tracked jobs in `chrome.storage.local`, and is the only place that writes snapshots out to Supabase (via `supabase.js`) or IndexedDB (via `db.js`). It also handles auto-registration of newly-tracked bots and auto-tracking of watched creators' new posts.
- `content_bridge.js` is a separate content script scoped to the *dashboard's own origin* (`janitor-stats-tracker.vercel.app`, `localhost`). It relays `window.postMessage` calls between the web dashboard page and the extension's background worker, which is what lets the plain web app (no extension installed) still ask an installed extension to do things like start tracking a bot.

### Cloud worker (no browser required)

`scripts/cloud-worker.js` is a standalone Node/Playwright script, independent of the extension. It launches headless Chromium, optionally injects a `JANITOR_COOKIE`/`JANITOR_TOKEN` for authenticated/private bots, scrapes each active tracked job directly from `janitorai.com/characters/{id}`, and writes snapshots to Supabase using the same schema the extension uses. It's invoked by `.github/workflows/tracker.yml` on a `*/10 * * * *` cron (concurrency-limited to one run at a time, 5 min timeout) so tracking continues even when nobody has a browser tab open. `.github/workflows/test-all-bots.yml` is a manual (`workflow_dispatch`) smoke test that scrapes a fixed bot list directly to sanity-check scraping still works against JanitorAI's current markup/WAF behavior.

Env vars (`.env`, see `.env.example`): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `JANITOR_COOKIE`, `JANITOR_TOKEN`, `MAX_CYCLES`, `CYCLE_DELAY_MS`. Default Supabase URL/anon key in `.env.example` and hardcoded in `supabase.js` (`DEFAULT_SUPABASE_URL`/`DEFAULT_SUPABASE_ANON_KEY`) point at the project's own public demo database — the anon key is a publishable key, not a secret.

### Storage layer

Two interchangeable backends behind the same call sites in the dashboard/extension code:

- `supabase.js` — REST calls to Supabase Postgres (`tracked_jobs`, `character_snapshots` tables, see `schema.sql`), plus `subscribeToRealtimeSnapshots` for live chart updates over Supabase Realtime websockets.
- `db.js` — IndexedDB (`janitorai-stats-tracker` database) used as the local-only fallback when no Supabase project is configured.

`schema.sql` is the source of truth for the Postgres schema; paste it into the Supabase SQL editor when standing up a new project (also embedded as a string export `SCHEMA_SQL` in `supabase.js` so the dashboard can show/copy it in-app).

### Dashboard/UI

`dashboard.js` (large, single file) renders all the time-series charts, growth-window calculations (1h/6h/24h/7d/30d/All), and CSV import/export, reading snapshot data from whichever backend (`supabase.js` or `db.js`) is active. `common.js` holds shared pure helpers used across dashboard, background, and content scripts — number formatting, UUID/handle cleaning, window-stat math, chart tooltip/scale helpers — so changes to formatting or stat math belong there, not duplicated per file.

### Build output

`npm run build` outputs to `dist/` (three entry points: `index.html`, `dashboard.html`, `popup.html`, per `vite.config.js`). `dist/` is committed in this repo as of the current state — check whether that's intentional before assuming it should be `.gitignore`d.
