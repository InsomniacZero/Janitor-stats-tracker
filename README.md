# JanitorAI Stats Tracker 📊

A private, client-side time-series analytics dashboard and tracker for JanitorAI character statistics. Built with **Vite**, deployable directly to **Vercel**, and fully compatible as a **Chrome Manifest V3 Extension**.

---

## Features

- 📈 **Time-Series Charts**: Dedicated charts for every tracked metric with exact interactive hover tooltips (timestamp, delta, percentage change, elapsed time).
- 🧬 **Combined Normalized Trends**: Index all tracked series to 100 at window start to contrast relative growth rates.
- ⏱️ **Flexible Growth Windows**: Inspect data over `1h`, `6h`, `24h`, `7d`, `30d`, and `All`.
- 🧮 **Engagement Ratios & Velocity**: Real-time calculations for messages per chat, chats per 1k messages, favourites per chat, comments velocity, and growth rates per hour.
- 💾 **100% Private Local Storage**: Stores time-series data locally in the browser's `IndexedDB` storage. No analytics or metrics are sent to any external server.
- ✨ **Demo Data Mode**: Test and explore all charts and analytics with 1-click sample generation.
- 📂 **CSV Import & Export**: Seamlessly backup, restore, and transfer character history between browsers and devices.
- ➕ **Manual Snapshot Entry**: Log and track statistics directly through the web interface without needing the extension.

---

## Tracked Metrics

- **Messages** (total messages sent)
- **Chats** (total active chats)
- **Comments** (character comments count)
- **Favourites** (character bookmark count)
- **Published chats** (optional public chat logs)
- **Metadata**: Created, Updated, and Published dates

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

You can also use this repository directly as an unpacked Chrome Extension to automatically collect data from open JanitorAI tabs:

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions`.
3. Toggle on **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select this directory.
5. Open any JanitorAI character page (`https://janitorai.com/characters/...`).
6. Click the extension icon in the toolbar or click **Open dashboard** to view live stats.

---

## Data Privacy & Storage

All tracked data resides locally inside the browser's `IndexedDB` database (`janitorai-stats-tracker`). Nothing is uploaded or transmitted to third parties.
