# JStats

A private, client-side statistics dashboard and tracker for JanitorAI character metrics. Built with **Vite**, deployable directly to **Vercel**, and fully compatible as an unpacked **Chrome Manifest V3 Extension**.

---

## Features

- **3-Day Automated Bot Tracker ($0 Cost)**: Paste any JanitorAI character URL (`https://janitorai.com/characters/...`) to continuously scrape and log stats every 1 minute for 72 hours (4,320 snapshots) in the background without keeping tabs open.
- **Supabase Cloud Sync**: Connect a free Supabase PostgreSQL database to permanently store and synchronize all bot data across devices and live on Vercel without data resets.
- **Realtime Graph Streaming**: Open dashboards automatically update charts via Supabase Realtime WebSocket connections as each minute snapshot arrives.
- **Time-Series Charts**: Dedicated charts for every tracked metric with exact interactive hover tooltips (timestamp, delta, percentage change, elapsed time).
- **Combined Normalized Trends**: Index all tracked series to 100 at window start to contrast relative growth rates.
- **Flexible Growth Windows**: Inspect data over `1h`, `6h`, `24h`, `7d`, `30d`, and `All`.
- **Engagement Ratios & Velocity**: Real-time calculations for messages per chat, chats per 1k messages, favourites per chat, comments velocity, and growth rates per hour.
- **100% Private Local Storage Fallback**: Stores time-series data locally in the browser's `IndexedDB` storage when Supabase is not configured.
- **Demo Data Mode**: Test and explore all charts and analytics with 1-click sample generation.
- **CSV Import & Export**: Seamlessly backup, restore, and transfer character history between browsers and devices.
- **Manual Snapshot Entry**: Log and track statistics directly through the web interface with custom number steppers.

---

## Tracked Metrics

- **Messages** (total messages sent)
- **Chats** (total active chats)
- **Comments** (character comments count)
- **Favourites** (character bookmark count)
- **Published chats** (optional public chat logs)
- **Metadata**: Created, Updated, and Published dates

---

## ⚡ Free 3-Day Autonomous Bot Tracker (Option A)

### How it Works
1. **$0 Infrastructure**: Uses your Chrome Extension background worker (`chrome.alarms`) to fetch JanitorAI's internal endpoint (`/hampter/characters/{id}`) natively using browser clearance. This completely bypasses Cloudflare WAF blocks for $0, avoiding costly proxies or cloud servers that sleep.
2. **Permanent Storage**: Each 1-minute snapshot is saved to your free Supabase PostgreSQL database (`character_snapshots`), so your live Vercel dashboard (`https://janitor-stats-tracker.vercel.app/`) never loses data on reloads, browser restarts, or updates.
3. **Automatic 72h Lifecycle**: Automatically marks the tracking job completed after 72 hours (3 days) while keeping all historical data permanently accessible.

### Setup (Takes 2 Minutes)
1. Create a free project at [supabase.com](https://supabase.com).
2. Go to **SQL Editor** in Supabase, paste the contents of [`schema.sql`](./schema.sql), and click **Run**.
3. Open JStats, click **Cloud Sync** in the header, and paste your **Project URL** and **Anon Public Key** (from Project Settings → API).
4. Click **Track Bot Link**, paste your JanitorAI bot URL, and click **Start Autonomous Tracker**!

---

## 🚀 Web Deployment (Vercel & Vite)

### Local Development

```bash
# Install dependencies
npm install

# Start local Vite development server
npm run dev

# Build production bundle
npm run build

# Preview production build locally
npm run preview
```

### Deploy to Vercel

1. Push this repository to GitHub.
2. Import the project in [Vercel](https://vercel.com).
3. Vercel automatically detects the **Vite** framework (`npm run build` -> `dist`).
4. Ready! Your analytics dashboard is live.

---

## 🧩 Chrome Extension Installation

You can use this repository directly as an unpacked Chrome Extension to automatically collect data from JanitorAI:

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions`.
3. Toggle on **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select this directory.
5. Click **Track Bot Link** in the dashboard to start logging any JanitorAI bot for 3 days!

