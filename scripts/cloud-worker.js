#!/usr/bin/env node
/**
 * JStats — Autonomous Cloud Tracker Worker
 * Runs 24/7 in GitHub Actions / headless cloud environments.
 * Eliminates the need for the Chrome extension completely.
 * 
 * Features:
 * 1. Queries active 72h tracking jobs from Supabase.
 * 2. Queries watched creators list from Supabase.
 * 3. Launches stealth Playwright Chromium instance.
 * 4. Injects JanitorAI auth session (if provided in env / secret).
 * 5. Discovers new bot releases from watched creators at minute 0 and auto-tracks them.
 * 6. Scrapes live bot stats and writes snapshots into Supabase character_snapshots.
 */

import { chromium } from "playwright";
import { cleanCreatorHandle, matchesWatchedCreator } from "../common.js";
import {
  getSupabaseConfig,
  fetchTrackedJobs,
  saveTrackedJob,
  insertSnapshot,
  fetchWatchedCreatorsFromSupabase
} from "../supabase.js";

const MAX_CYCLES = Number(process.env.MAX_CYCLES) || 8;
const CYCLE_DELAY_MS = Number(process.env.CYCLE_DELAY_MS) || 60000;
const JANITOR_TOKEN = process.env.JANITOR_TOKEN || "";
const JANITOR_COOKIE = process.env.JANITOR_COOKIE || "";

function cleanUuid(raw) {
  if (!raw || typeof raw !== "string") return "";
  const match = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match ? match[0].toLowerCase() : "";
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractCharactersFromPayload(obj, depth = 0, seen = new Set()) {
  if (!obj || typeof obj !== "object" || depth > 5) return [];
  const results = [];

  if (Array.isArray(obj)) {
    for (const item of obj) {
      results.push(...extractCharactersFromPayload(item, depth + 1, seen));
    }
    return results;
  }

  const msgsRaw =
    obj.total_message ??
    obj.total_messages ??
    obj.totalMessages ??
    obj.stats?.message ??
    obj.stats?.messages ??
    obj.stats?.total_message ??
    obj.message_count;

  const chatsRaw =
    obj.total_chat ??
    obj.total_chats ??
    obj.totalChats ??
    obj.stats?.chat ??
    obj.stats?.chats ??
    obj.stats?.total_chat ??
    obj.chat_count;

  const msgs = Number(msgsRaw);
  const chats = Number(chatsRaw);
  const hasMsgs = Number.isFinite(msgs) && msgs >= 0;
  const hasChats = Number.isFinite(chats) && chats >= 0;

  const rawId = obj.id || obj.character_id || obj.uuid || obj.characterId || obj.bot_id;
  const charId = cleanUuid(rawId);
  const hasNameOrStats = Boolean(obj.name || obj.character_name || obj.stats || obj.avatar || obj.creator);

  if (charId && hasMsgs && hasChats && (msgs > 0 || chats > 0 || hasNameOrStats) && !seen.has(charId)) {
    seen.add(charId);

    const favsRaw =
      obj.total_favorite ??
      obj.total_favorites ??
      obj.total_favourite ??
      obj.total_favourites ??
      obj.stats?.favorite ??
      obj.stats?.favourite ??
      obj.favourites;

    const commsRaw =
      obj.total_comment ??
      obj.total_comments ??
      obj.stats?.comment ??
      obj.stats?.comments ??
      obj.comments;

    const pubChatsRaw =
      obj.total_public_chat ??
      obj.total_public_chats ??
      obj.stats?.public_chat ??
      obj.stats?.total_public_chat ??
      obj.stats?.published_chats ??
      obj.published_chats ??
      obj.publishedChats;

    results.push({
      characterId: charId,
      character_name: obj.name || obj.character_name || "JanitorAI Character",
      msgs,
      chats,
      favourites: Number.isFinite(Number(favsRaw)) && Number(favsRaw) >= 0 ? Number(favsRaw) : null,
      comments: Number.isFinite(Number(commsRaw)) && Number(commsRaw) >= 0 ? Number(commsRaw) : null,
      publishedChats: Number.isFinite(Number(pubChatsRaw)) && Number(pubChatsRaw) >= 0 ? Number(pubChatsRaw) : null,
      avatar: obj.avatar || obj.image || null,
      creator: obj.creator || obj.creator_name || obj.author || null
    });
  }

  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === "object" && obj[key] !== null) {
      results.push(...extractCharactersFromPayload(obj[key], depth + 1, seen));
    }
  }

  return results;
}

async function scrapeCharacterPage(page, characterId) {
  const cleanId = cleanUuid(characterId);
  if (!cleanId) return null;

  let captured = null;
  const onResponse = async (res) => {
    const u = res.url();
    if (u.includes(cleanId) || u.includes("/characters/") || u.includes("/hampter/")) {
      try {
        const text = await res.text();
        const json = JSON.parse(text);
        const chars = extractCharactersFromPayload(json);
        const match = chars.find(c => c.characterId === cleanId);
        if (match) captured = match;
      } catch {}
    }
  };

  page.on("response", onResponse);

  try {
    const url = `https://janitorai.com/characters/${cleanId}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(4000);
  } catch (err) {
    console.warn(`[Worker] Goto warning for ${cleanId}: ${err.message}`);
  } finally {
    page.off("response", onResponse);
  }

  // Fallback: evaluate DOM if API was not caught
  if (!captured) {
    try {
      captured = await page.evaluate((cid) => {
        const h1 = document.querySelector("h1")?.innerText?.trim();
        const text = document.body.innerText || "";
        const chatsMatch = text.match(/([0-9,]+)\s*(?:chats?)/i);
        const msgsMatch = text.match(/([0-9,]+)\s*(?:messages?|msgs?)/i);
        if (chatsMatch && msgsMatch) {
          const chats = parseInt(chatsMatch[1].replace(/,/g, ""), 10);
          const msgs = parseInt(msgsMatch[1].replace(/,/g, ""), 10);
          if (Number.isFinite(chats) && Number.isFinite(msgs)) {
            return {
              characterId: cid,
              character_name: h1 || "JanitorAI Character",
              chats,
              msgs,
              favourites: null,
              comments: null,
              publishedChats: null
            };
          }
        }
        return null;
      }, cleanId);
    } catch {}
  }

  return captured;
}

async function checkWatchedCreators(page, watchedCreators, existingJobs) {
  if (!watchedCreators.length) return;
  const existingSet = new Set(existingJobs.map(j => cleanUuid(j.character_id)));

  for (const w of watchedCreators) {
    const handle = typeof w === "string" ? w : w?.creatorHandle;
    const clean = cleanCreatorHandle(handle);
    if (!clean) continue;

    console.log(`[Worker] Checking watched creator: @${clean} ...`);
    const capturedChars = [];
    const onResponse = async (res) => {
      const u = res.url();
      if (u.includes("/characters") || u.includes("/hampter/") || u.includes("profile")) {
        try {
          const text = await res.text();
          const json = JSON.parse(text);
          capturedChars.push(...extractCharactersFromPayload(json));
        } catch {}
      }
    };

    page.on("response", onResponse);

    try {
      const profileUrl = `https://janitorai.com/profiles/${clean}`;
      await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(4000);
    } catch (err) {
      console.warn(`[Worker] Could not load creator profile @${clean}: ${err.message}`);
    } finally {
      page.off("response", onResponse);
    }

    for (const char of capturedChars) {
      if (!char.characterId || existingSet.has(char.characterId)) continue;

      const creatorMatches = matchesWatchedCreator(char.creator || clean, [clean]);
      if (!creatorMatches) continue;

      console.log(`🚀 [Worker] NEW BOT DETECTED AT MINUTE 0: "${char.character_name}" by @${clean}! Auto-tracking...`);
      existingSet.add(char.characterId);

      const jobPayload = {
        character_id: char.characterId,
        character_name: char.character_name,
        url: `https://janitorai.com/characters/${char.characterId}`,
        avatar: char.avatar || null,
        creator: char.creator || clean,
        status: "active",
        started_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 72 * 3600 * 1000).toISOString()
      };

      await saveTrackedJob(jobPayload);

      // Log the exact minute-0 baseline snapshot
      await insertSnapshot(char.characterId, {
        chats: Number(char.chats) || 0,
        msgs: Number(char.msgs) || 0,
        comments: Number(char.comments) || 0,
        favourites: Number(char.favourites) || 0,
        publishedChats: Number(char.publishedChats) || 0
      });

      existingJobs.push(jobPayload);
    }
  }
}

async function runWorker() {
  console.log("==================================================");
  console.log("   JStats — Cloud Worker (Standalone Tracker)");
  console.log("==================================================");

  const config = await getSupabaseConfig();
  if (!config) {
    console.error("FATAL: Supabase configuration missing. Set SUPABASE_URL and SUPABASE_ANON_KEY in environment or secrets.");
    process.exit(1);
  }
  console.log(`Connected to Supabase: ${config.url}`);

  let execPath;
  try {
    const fs = await import("fs");
    const candidates = [
      process.env.CHROMIUM_PATH,
      "/usr/bin/google-chrome",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/home/insomniac/.cache/ms-playwright/chromium-1148/chrome-linux/chrome"
    ].filter(Boolean);
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        execPath = c;
        break;
      }
    }
  } catch {}

  console.log(`Launching Chromium (path: ${execPath || "Playwright default"})...`);
  const browser = await chromium.launch({
    headless: true,
    executablePath: execPath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ]
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    locale: "en-US"
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  // Inject session cookie if provided
  if (JANITOR_COOKIE || JANITOR_TOKEN) {
    console.log("Injecting JanitorAI auth session credentials into browser context...");
    const cookiesToAdd = [];
    if (JANITOR_COOKIE) {
      const parts = JANITOR_COOKIE.split(";");
      for (const part of parts) {
        const [k, ...v] = part.trim().split("=");
        if (k && v.length) {
          cookiesToAdd.push({
            name: k,
            value: v.join("="),
            domain: "janitorai.com",
            path: "/"
          });
        }
      }
    }
    if (JANITOR_TOKEN && !cookiesToAdd.some(c => c.name.includes("auth-token"))) {
      cookiesToAdd.push({
        name: "sb-auth-token",
        value: JANITOR_TOKEN,
        domain: "janitorai.com",
        path: "/"
      });
    }
    if (cookiesToAdd.length) {
      await context.addCookies(cookiesToAdd);
    }
  }

  const page = await context.newPage();

  console.log(`Starting tracker loop (${MAX_CYCLES} cycles, ${CYCLE_DELAY_MS / 1000}s interval)...`);

  for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
    console.log(`\n--- Cycle ${cycle}/${MAX_CYCLES} [${new Date().toLocaleTimeString()}] ---`);

    const allJobs = await fetchTrackedJobs();
    const activeJobs = allJobs.filter(j => j.status === "active" && (!j.expires_at || new Date(j.expires_at) > new Date()));
    const watchedCreators = await fetchWatchedCreatorsFromSupabase();

    console.log(`Active tracking jobs: ${activeJobs.length} | Watched creators: ${watchedCreators.length}`);

    if (activeJobs.length === 0 && watchedCreators.length === 0) {
      console.log("No active tracking jobs or watched creators found. Sleeping.");
      if (cycle === 1) {
        console.log("Exiting early to conserve runner minutes.");
        break;
      }
    }

    // 1. Check watched creators for minute-0 releases
    if (watchedCreators.length > 0) {
      await checkWatchedCreators(page, watchedCreators, activeJobs);
    }

    // 2. Scrape active bots
    for (const job of activeJobs) {
      console.log(`[Worker] Scraping: "${job.character_name}" (${job.character_id})`);
      const scraped = await scrapeCharacterPage(page, job.character_id);
      if (scraped && Number.isFinite(scraped.chats) && Number.isFinite(scraped.msgs)) {
        await insertSnapshot(job.character_id, {
          chats: scraped.chats,
          msgs: scraped.msgs,
          comments: scraped.comments,
          favourites: scraped.favourites,
          publishedChats: scraped.publishedChats
        });
        console.log(`  ✓ Snapshot logged: ${scraped.chats.toLocaleString()} chats, ${scraped.msgs.toLocaleString()} msgs`);
      } else {
        console.log(`  ⚠ Could not collect fresh stats for ${job.character_id} (will retry next cycle).`);
      }
    }

    if (cycle < MAX_CYCLES) {
      console.log(`Sleeping ${CYCLE_DELAY_MS / 1000}s before next cycle...`);
      await sleep(CYCLE_DELAY_MS);
    }
  }

  console.log("\nClosing browser. Worker execution complete.");
  await browser.close();
}

runWorker().catch(err => {
  console.error("Worker fatal error:", err);
  process.exit(1);
});
