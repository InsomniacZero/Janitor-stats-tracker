#!/usr/bin/env bash
set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

echo "=================================================="
echo "Initializing Janitor Stats Tracker (JStats)"
echo "Directory: $PROJECT_DIR"
echo "=================================================="

# 1. Check Node.js & npm
if ! command -v node >/dev/null 2>&1; then
  echo "[!] Node.js is required but not installed. Please install Node.js (v18+) first."
  exit 1
fi

NODE_VER=$(node -v)
echo "[+] Node.js detected: $NODE_VER"

if ! command -v npm >/dev/null 2>&1; then
  echo "[!] npm is required but not installed."
  exit 1
fi

# 2. Setup Environment Variables
if [ ! -f "$PROJECT_DIR/.env" ]; then
  if [ -f "$PROJECT_DIR/.env.example" ]; then
    echo "[+] Creating .env from .env.example..."
    cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
  fi
else
  echo "[+] Existing .env detected."
fi

# 3. Install Node dependencies
echo "[+] Installing npm dependencies..."
npm install

# 4. Ensure Playwright Chromium is available for cloud worker
if command -v npx >/dev/null 2>&1; then
  echo "[+] Checking/installing Playwright Chromium browser..."
  npx playwright install chromium || echo "[!] Playwright browser install skipped or already up to date."
fi

# 5. Build production bundle
echo "[+] Running production build check..."
npm run build

echo "=================================================="
echo "Initialization Complete!"
echo "=================================================="
echo "Available Commands:"
echo "  1. Start Web Dashboard (Dev):  npm run dev"
echo "  2. Run Headless Cloud Worker:   npm run worker"
echo "  3. Build Production Bundle:     npm run build"
echo "  4. Chrome Extension (Unpacked): Open chrome://extensions, enable Dev Mode, and Load Unpacked -> $PROJECT_DIR"
echo "=================================================="
