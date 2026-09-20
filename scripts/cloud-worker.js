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

export function extractSessionObject(str) {
  if (!str || typeof str !== "string") return null;
  const trimmed = str.trim();

  // 1. Direct JSON (e.g. if user pasted session JSON directly)
  try {
    const o = JSON.parse(trimmed);
    if (o?.access_token) return o;
    if (Array.isArray(o) && o[0]?.access_token) return o[0];
    if (o?.currentSession?.access_token) return o.currentSession;
  } catch {}

  // 2. Chunked cookies (sb-auth-auth-token.0, sb-auth-auth-token.1, etc.)
  if (trimmed.includes("auth-token")) {
    const chunks = [];
    const chunkMatches = trimmed.matchAll(/(?:sb-[a-zA-Z0-9_-]*-)?auth-token(?:\.(\d+))?=(?:base64-)?([^;]+)/g);
    for (const match of chunkMatches) {
      const idx = match[1] !== undefined ? parseInt(match[1], 10) : 0;
      let val = match[2].trim();
      chunks.push({ idx, val });
    }
    if (chunks.length > 0) {
      chunks.sort((a, b) => a.idx - b.idx);
      const combinedB64 = chunks.map(c => c.val).join("");
      try {
        const decoded = Buffer.from(combinedB64, "base64").toString("utf-8");
        const parsed = JSON.parse(decoded);
        if (parsed?.access_token) return parsed;
      } catch {}
    }
  }

  // 3. Standalone base64- prefix in the string
  const b64Match = trimmed.match(/base64-([A-Za-z0-9+/=]+)/);
  if (b64Match) {
    try {
      const decoded = Buffer.from(b64Match[1], "base64").toString("utf-8");
      const parsed = JSON.parse(decoded);
      if (parsed?.access_token) return parsed;
    } catch {}
  }

  // 4. Standalone base64 string
  try {
    const decoded = Buffer.from(trimmed.replace(/^base64-/, ""), "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);
    if (parsed?.access_token) return parsed;
  } catch {}

  return null;
}

export function extractTokenFromString(str) {
  if (!str || typeof str !== "string") return null;

  // 1. Try extracting through parsed session object
  const session = extractSessionObject(str);
  if (session?.access_token && typeof session.access_token === "string") {
    return session.access_token;
  }

  const trimmed = str.trim();

  // 2. Try raw base64 string that decodes directly to a JWT (starts with eyJ)
  try {
    const decoded = Buffer.from(trimmed.replace(/^base64-/, ""), "base64").toString("utf-8");
    if (decoded.startsWith("ey") && decoded.split(".").length === 3) return decoded;
    const m = decoded.match(/(eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})/);
    if (m) return m[1];
  } catch {}

  // 3. Direct raw JWT pattern in the string
  const m = trimmed.match(/(eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})/);
  if (m) return m[1];

  return null;
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
    obj.msgs ??
    obj.messages ??
    obj.total_message ??
    obj.total_messages ??
    obj.totalMessages ??
    obj.totalMessage ??
    obj.stats?.msgs ??
    obj.stats?.message ??
    obj.stats?.messages ??
    obj.stats?.total_message ??
    obj.stats?.total_messages ??
    obj.message_count ??
    obj.messageCount;

  const chatsRaw =
    obj.chats ??
    obj.total_chat ??
    obj.total_chats ??
    obj.totalChats ??
    obj.totalChat ??
    obj.stats?.chats ??
    obj.stats?.chat ??
    obj.stats?.total_chat ??
    obj.stats?.total_chats ??
    obj.chat_count ??
    obj.chatCount;

  const favsRaw =
    obj.total_favorite ??
    obj.total_favorites ??
    obj.total_favourite ??
    obj.total_favourites ??
    obj.stats?.favorite ??
    obj.stats?.favourite ??
    obj.stats?.favorites ??
    obj.stats?.favourites ??
    obj.favourites ??
    obj.favorites ??
    obj.favorite;

  const commsRaw =
    obj.total_comment ??
    obj.total_comments ??
    obj.stats?.comment ??
    obj.stats?.comments ??
    obj.comments ??
    obj.comment;

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

async function scrapeFollowingFeed(context) {
  const capturedChars = [];
  const page = await context.newPage();

  const onResponse = async (res) => {
    const u = res.url();
    if (u.includes("/characters") || u.includes("/hampter/")) {
      try {
        const text = await res.text();
        if (text.startsWith("{") || text.startsWith("[")) {
          const json = JSON.parse(text);
          const found = extractCharactersFromPayload(json);
          if (found.length > 0) {
            capturedChars.push(...found);
            console.log(`  [Worker] Intercepted feed response (${u.substring(0, 70)}...): extracted ${found.length} characters.`);
          }
        }
      } catch {}
    }
  };

  page.on("response", onResponse);
  try {
    console.log("[Worker] Navigating to Following feed (https://janitorai.com/?segment=following) for 1s-precision stats...");
    await page.goto("https://janitorai.com/?segment=following", { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(6000);
  } catch (err) {
    console.warn("[Worker] Warning navigating to Following feed:", err.message);
  } finally {
    page.off("response", onResponse);
    await page.close().catch(() => {});
  }

  return capturedChars;
}

async function scrapeCharacterPage(context, characterId) {
  const cleanId = cleanUuid(characterId);
  if (!cleanId) return null;

  const page = await context.newPage();

  // Navigate directly to character page with live network capture
  let captured = null;
  let interceptedFavs = null;
  let interceptedReviews = null;

  const onResponse = async (res) => {
    const u = res.url();
    try {
      if (u.includes(cleanId) || u.includes("/characters/")) {
        const text = await res.text();
        const json = JSON.parse(text);
        const chars = extractCharactersFromPayload(json);
        const match = chars.find(c => c.characterId === cleanId);
        if (match) captured = match;
      }
      if (u.includes("/hampter/favorites/character/") && u.includes("/count")) {
        const text = await res.text();
        const json = JSON.parse(text);
        if (Number.isFinite(json.favoritesCount)) {
          interceptedFavs = json.favoritesCount;
        }
      }
      if (u.includes("/hampter/reviews/counts/")) {
        const text = await res.text();
        const json = JSON.parse(text);
        if (Number.isFinite(json.total)) {
          interceptedReviews = json.total;
        }
      }
    } catch {}
  };

  try {
    page.on("response", onResponse);

    try {
      const url = `https://janitorai.com/characters/${cleanId}`;
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
      const status = resp ? resp.status() : 200;
      if (status === 404) {
        console.warn(`  [Worker] Character ${cleanId} returned 404 Not Found.`);
        return null;
      }
      await page.waitForTimeout(5000);
    } catch (err) {
      console.warn(`[Worker] Goto warning for ${cleanId}: ${err.message}`);
    } finally {
      page.off("response", onResponse);
    }

    // 3. Fallback: evaluate internal API, DOM text, scripts, ribbons, and badges
    if (!captured) {
      try {
        captured = await page.evaluate(async (cid) => {
          function parseStat(value) {
            if (value == null) return null;
            const text = String(value).trim().toLowerCase().replace(/,/g, "").replace(/\s+/g, "");
            const match = text.match(/^([\d.]+)([kmb])?$/i);
            if (!match) return null;
            let number = Number(match[1]);
            if (!Number.isFinite(number)) return null;
            if (match[2] === "k") number *= 1e3;
            if (match[2] === "m") number *= 1e6;
            if (match[2] === "b") number *= 1e9;
            return Math.round(number);
          }

          // A. Try internal first-party fetch from within origin
          try {
            let token = null;
            try {
              for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && (k.includes("auth-token") || k.includes("token"))) {
                  const val = localStorage.getItem(k);
                  const m = val?.match(/(eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})/);
                  if (m) { token = m[1]; break; }
                }
              }
            } catch {}

            const headers = { Accept: "application/json, text/plain, */*" };
            if (token) headers["Authorization"] = `Bearer ${token}`;

            const res = await fetch(`/hampter/characters/${cid}`, { credentials: "include", headers });
            if (res.ok) {
              const json = await res.json();
              const c = json?.character || json?.data || json;
              const msgsRaw = c?.total_message ?? c?.total_messages ?? c?.stats?.message ?? c?.stats?.total_message ?? c?.msgs ?? c?.messages;
              const chatsRaw = c?.total_chat ?? c?.total_chats ?? c?.stats?.chat ?? c?.stats?.total_chat ?? c?.chats;
              const favsRaw = c?.total_favorite ?? c?.total_favorites ?? c?.stats?.favorite ?? c?.favourites;
              if (Number.isFinite(Number(msgsRaw)) && Number.isFinite(Number(chatsRaw))) {
                return {
                  characterId: cid,
                  character_name: c.name || null,
                  avatar: c.avatar || null,
                  creator: c.creator || c.creator_name || null,
                  chats: Number(chatsRaw),
                  msgs: Number(msgsRaw),
                  favourites: Number.isFinite(Number(favsRaw)) ? Number(favsRaw) : null,
                  comments: null,
                  publishedChats: null
                };
              }
            }
          } catch {}

          const h1 = document.querySelector("h1, h2.chakra-heading")?.innerText?.trim() || "JanitorAI Character";
          const avatarEl = document.querySelector('img[src*="bot-avatars"], img[src*="characters"], .character-avatar img');
          const creatorEl = document.querySelector('a[href*="/profiles/"], a[href^="/@"]');
          const creator = creatorEl?.textContent?.replace(/^@|\s+/g, "") || null;

          // B. Primary regex matching on character title & metrics in text body
          const fullText = document.body.innerText || "";
          const mHero = fullText.match(/(?:^|\n)(.*?)\s+([\d.,kmbKMB]+)\s+([\d.,kmbKMB]+)\s+by:\s*@?([^\s\n]+)(?:\s+([\d.,kmbKMB]+))?/i);
          if (mHero) {
            const cChats = parseStat(mHero[2]);
            const cMsgs = parseStat(mHero[3]);
            const cFavs = mHero[5] ? parseStat(mHero[5]) : null;
            if (cChats !== null && cMsgs !== null) {
              return {
                characterId: cid,
                character_name: h1 && h1 !== "JanitorAI Character" ? h1 : mHero[1].trim(),
                avatar: avatarEl?.src || null,
                creator: creator || mHero[4].trim(),
                chats: cChats,
                msgs: cMsgs,
                favourites: cFavs,
                comments: null,
                publishedChats: null
              };
            }
          }

          // C. Check __NEXT_DATA__
          const nextEl = document.getElementById("__NEXT_DATA__");
          if (nextEl) {
            try {
              const parsed = JSON.parse(nextEl.textContent);
              const char = parsed.props?.pageProps?.character || parsed.props?.pageProps?.data || parsed.props?.pageProps?.bot;
              if (char) {
                const msgs = Number(char.total_message ?? char.total_messages ?? char.stats?.message);
                const chats = Number(char.total_chat ?? char.total_chats ?? char.stats?.chat);
                if (Number.isFinite(msgs) && Number.isFinite(chats)) {
                  return {
                    characterId: cid,
                    character_name: char.name || h1,
                    avatar: char.avatar || avatarEl?.src || null,
                    creator: char.creator || creator,
                    chats,
                    msgs,
                    favourites: null,
                    comments: null,
                    publishedChats: null
                  };
                }
              }
            } catch {}
          }

          // D. Check script tags for exact counts
          for (const s of Array.from(document.querySelectorAll("script"))) {
            const txt = s.textContent || "";
            if (txt.includes("message") && txt.includes("chat")) {
              const mMsg = txt.match(/"(?:total_)?messages?"\s*:\s*(\d+)/);
              const mChat = txt.match(/"(?:total_)?chats?"\s*:\s*(\d+)/);
              if (mMsg && mChat) {
                const msgs = Number(mMsg[1]);
                const chats = Number(mChat[1]);
                if (Number.isFinite(msgs) && Number.isFinite(chats)) {
                  return {
                    characterId: cid,
                    character_name: h1,
                    avatar: avatarEl?.src || null,
                    creator,
                    chats,
                    msgs,
                    favourites: null,
                    comments: null,
                    publishedChats: null
                  };
                }
              }
            }
          }

          // E. Check ribbon (.character-chat-messages-stat-ribbon-tag-hstack)
          const ribbon = document.querySelector(".character-chat-messages-stat-ribbon-tag-hstack");
          if (ribbon) {
            const pEls = Array.from(ribbon.querySelectorAll("p")).map(p => p.textContent.trim()).filter(Boolean);
            if (pEls.length >= 2) {
              const chats = parseStat(pEls[0]);
              const msgs = parseStat(pEls[1]);
              if (Number.isFinite(chats) && Number.isFinite(msgs)) {
                return {
                  characterId: cid,
                  character_name: h1,
                  avatar: avatarEl?.src || null,
                  creator,
                  chats,
                  msgs,
                  favourites: null,
                  comments: null,
                  publishedChats: null
                };
              }
            }
          }

          // F. Check stats elements & badges (using textContent for headless reliability)
          const statsElements = Array.from(document.querySelectorAll("p, span, div, button, b, strong"))
            .filter(el => el.children.length === 0 && el.textContent && el.textContent.trim());

          let domChats = null;
          let domMsgs = null;

          for (let i = 0; i < statsElements.length; i++) {
            const el = statsElements[i];
            const val = parseStat(el.textContent);
            if (val !== null) {
              const prev = statsElements[i - 1]?.textContent?.toLowerCase() || "";
              const next = statsElements[i + 1]?.textContent?.toLowerCase() || "";
              const parent = (el.parentElement?.textContent || "").toLowerCase();
              
              if (domChats === null && (parent.includes("chat") || prev.includes("chat") || next.includes("chat"))) {
                domChats = val;
              } else if (domMsgs === null && (parent.includes("msg") || parent.includes("message") || prev.includes("msg") || next.includes("msg"))) {
                domMsgs = val;
              }
            }
          }

          // Fallback: If both chats and msgs are numbers found in order near the title
          if (domChats === null || domMsgs === null) {
            const numbers = [];
            for (const el of statsElements) {
              const val = parseStat(el.textContent);
              if (val !== null && val > 0) numbers.push(val);
            }
            if (numbers.length >= 2) {
              if (domChats === null) domChats = numbers[0];
              if (domMsgs === null) domMsgs = numbers[1];
            }
          }

          const favBtn = document.querySelector('button[title*="favorite" i], button[aria-label*="favorite" i]');
          const favDisplay = favBtn?.parentElement?.querySelector('[class*="_number_"]')?.textContent;
          const favCount = favDisplay ? parseStat(favDisplay) : null;

          if (domChats !== null && domMsgs !== null) {
            return {
              characterId: cid,
              character_name: h1,
              avatar: avatarEl?.src || null,
              creator,
              chats: domChats,
              msgs: domMsgs,
              favourites: favCount,
              comments: null,
              publishedChats: null
            };
          }

          return null;
        }, cleanId);
      } catch {}
    }

    if (captured) {
      if (interceptedFavs !== null && (!captured.favourites || captured.favourites === 0)) {
        captured.favourites = interceptedFavs;
      }
      if (interceptedReviews !== null && (!captured.comments || captured.comments === 0)) {
        captured.comments = interceptedReviews;
      }
    }

    if (!captured) {
      try {
        const diag = await page.evaluate(() => {
          return {
            title: document.title,
            url: location.href,
            h1: document.querySelector("h1, h2")?.innerText?.trim() || "No heading",
            bodyPreview: (document.body?.innerText || "").slice(0, 200).replace(/\n+/g, " ")
          };
        });
        console.warn(`  [Diag for ${cleanId}] Title: "${diag.title}" | H1: "${diag.h1}" | Body: "${diag.bodyPreview}"`);
      } catch (e) {
        console.warn(`  [Diag error for ${cleanId}]: ${e.message}`);
      }
    }

    return captured;
  } finally {
    await page.close().catch(() => {});
  }
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

      // DOM extraction on profile page
      const domChars = await page.evaluate((creatorClean) => {
        const found = [];
        const links = Array.from(document.querySelectorAll('a[href*="/characters/"]'));
        for (const a of links) {
          const m = a.getAttribute("href")?.match(/\/characters\/([0-9a-f]{8}-[0-9a-f-]{27,})/i);
          if (m && m[1]) {
            const cid = m[1].toLowerCase();
            const name = a.querySelector("h2, h3, h4, p, span")?.textContent?.trim() || a.textContent?.trim() || "JanitorAI Character";
            const img = a.querySelector("img")?.src || null;
            found.push({
              characterId: cid,
              character_name: name,
              avatar: img,
              creator: creatorClean,
              chats: 0,
              msgs: 0
            });
          }
        }
        return found;
      }, clean);
      capturedChars.push(...domChars);
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

  console.log("Launching Chromium with Playwright stealth patches...");
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled"
    ]
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    locale: "en-US",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
      "sec-ch-ua": "\"Chromium\";v=\"128\", \"Not;A=Brand\";v=\"24\", \"Google Chrome\";v=\"128\"",
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": "\"Windows\""
    }
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  // Inject session cookie & credentials if provided
  let extractedToken = null;
  let sessionObj = null;
  if (JANITOR_COOKIE || JANITOR_TOKEN) {
    console.log("Injecting JanitorAI auth session credentials into browser context...");

    sessionObj = extractSessionObject(JANITOR_COOKIE) || extractSessionObject(JANITOR_TOKEN);
    extractedToken = extractTokenFromString(JANITOR_TOKEN) || extractTokenFromString(JANITOR_COOKIE);

    const cookiesToAdd = [];
    if (JANITOR_COOKIE) {
      const parts = JANITOR_COOKIE.split(";");
      for (const part of parts) {
        const [k, ...v] = part.trim().split("=");
        if (k && v.length) {
          cookiesToAdd.push({
            name: k,
            value: v.join("="),
            domain: ".janitorai.com",
            path: "/"
          });
        }
      }
    }
    if (JANITOR_TOKEN && !cookiesToAdd.some(c => c.name.includes("auth-token"))) {
      cookiesToAdd.push({
        name: "sb-auth-token",
        value: JANITOR_TOKEN,
        domain: ".janitorai.com",
        path: "/"
      });
    }
    if (cookiesToAdd.length) {
      await context.addCookies(cookiesToAdd);
    }

    if (sessionObj) {
      if (sessionObj.user?.email) {
        console.log(`✓ Authenticated JanitorAI User: ${sessionObj.user.email}`);
      }
      const sessionJsonStr = JSON.stringify(sessionObj);
      await context.addInitScript((sStr) => {
        try {
          window.localStorage.setItem("sb-auth-auth-token", sStr);
          window.localStorage.setItem("sb-mcmzxtzhmmmpnyhreddbo-auth-token", sStr);
        } catch {}
      }, sessionJsonStr);
    }

    if (extractedToken) {
      console.log(`✓ Extracted valid JanitorAI session JWT (${extractedToken.substring(0, 16)}... len: ${extractedToken.length}).`);
    } else {
      console.warn("⚠️ Could not extract Bearer JWT from provided JANITOR_COOKIE / JANITOR_TOKEN.");
    }
  } else {
    console.warn("⚠️ WARNING: No JANITOR_COOKIE or JANITOR_TOKEN detected in GitHub Secrets!");
    console.warn("⚠️ JanitorAI returns 403 Forbidden for bot stats if an active session cookie/token is not provided.");
    console.warn("⚠️ Please set JANITOR_COOKIE in GitHub: Repo Settings -> Secrets and variables -> Actions.");
  }

  console.log(`Starting tracker loop (${MAX_CYCLES} cycles, ${CYCLE_DELAY_MS / 1000}s interval)...`);

  for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
    console.log(`\n--- Cycle ${cycle}/${MAX_CYCLES} [${new Date().toLocaleTimeString()}] ---`);

    const allJobs = await fetchTrackedJobs();
    const activeJobs = allJobs.filter(j => j.status === "active" && (!j.expires_at || new Date(j.expires_at) > new Date()));
    const watchedCreators = await fetchWatchedCreatorsFromSupabase();

    console.log(`Active tracking jobs: ${activeJobs.length} | Watched creators: ${watchedCreators.length}`);

    // 1. Scrape Following feed first for 1s-precision stats and minute-0 releases
    const feedChars = await scrapeFollowingFeed(context);
    console.log(`[Worker] Following feed captured ${feedChars.length} characters with 1s-level precision.`);

    const handledIds = new Set();
    const existingJobSet = new Set(allJobs.map(j => cleanUuid(j.character_id)));

    for (const char of feedChars) {
      // Check if this character is one of our active tracked bots
      const matchingJob = activeJobs.find(j => cleanUuid(j.character_id) === char.characterId);
      if (matchingJob) {
        await insertSnapshot(char.characterId, {
          chats: char.chats,
          msgs: char.msgs,
          comments: char.comments,
          favourites: char.favourites,
          publishedChats: char.publishedChats
        });
        handledIds.add(char.characterId);
        console.log(`  ✓ Exact 1s snapshot logged: "${matchingJob.character_name}" -> ${char.chats.toLocaleString()} chats, ${char.msgs.toLocaleString()} msgs (from Following feed)`);
      }

      // Check watched creators for minute-0 releases
      if (watchedCreators.length > 0 && !existingJobSet.has(char.characterId)) {
        const isWatched = matchesWatchedCreator(char.creator, watchedCreators);
        if (isWatched) {
          console.log(`🚀 [Worker] NEW BOT DETECTED AT MINUTE 0: "${char.character_name}" by @${char.creator}! Auto-tracking...`);
          existingJobSet.add(char.characterId);
          await saveTrackedJob({
            character_id: char.characterId,
            character_name: char.character_name,
            url: `https://janitorai.com/characters/${char.characterId}`,
            avatar: char.avatar || null,
            creator: char.creator,
            status: "active",
            started_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 72 * 3600 * 1000).toISOString()
          });
        }
      }
    }

    // 2. Check profile pages of watched creators if specified
    if (watchedCreators.length > 0) {
      const p = await context.newPage();
      try {
        await checkWatchedCreators(p, watchedCreators, allJobs);
      } finally {
        await p.close().catch(() => {});
      }
    }

    // 3. For any active jobs not in the Following feed, scrape their direct character page
    const remainingJobs = activeJobs.filter(j => !handledIds.has(cleanUuid(j.character_id)));
    if (remainingJobs.length > 0) {
      console.log(`[Worker] Scraping ${remainingJobs.length} standalone bots via direct character pages...`);
      for (const job of remainingJobs) {
        console.log(`[Worker] Scraping direct page: "${job.character_name}" (${job.character_id})`);
        const scraped = await scrapeCharacterPage(context, job.character_id);
        if (scraped && Number.isFinite(scraped.chats) && Number.isFinite(scraped.msgs)) {
          await insertSnapshot(job.character_id, {
            chats: scraped.chats,
            msgs: scraped.msgs,
            comments: scraped.comments,
            favourites: scraped.favourites,
            publishedChats: scraped.publishedChats
          });
          console.log(`  ✓ Direct snapshot logged: ${scraped.chats.toLocaleString()} chats, ${scraped.msgs.toLocaleString()} msgs`);
        } else {
          console.log(`  ⚠ Could not collect fresh stats for ${job.character_id} (will retry next cycle).`);
        }
        await sleep(3500);
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

const isMain = Boolean(process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()));
if (isMain) {
  runWorker().catch(err => {
    console.error("Worker fatal error:", err);
    process.exit(1);
  });
}

