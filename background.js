import { getAllCharacters, saveCharacterSnapshot, importLegacyCharacters } from "./db.js";
import {
  getSupabaseConfig,
  fetchTrackedJobs,
  saveTrackedJob,
  insertSnapshot,
  updateTrackedJobStatus
} from "./supabase.js";

const ALARM_NAME = "janitorai-stats-refresh";
const PERIOD_MINUTES = 1;

const REQUIRED_STATS = ["msgs", "chats", "comments", "favourites"];
const OPTIONAL_STATS = ["publishedChats"];
const LEGACY_MIGRATION_VERSION = 1;

async function migrateLegacyStorage() {
  const marker = await chrome.storage.local.get("legacyMigrationVersion");
  if (marker.legacyMigrationVersion >= LEGACY_MIGRATION_VERSION) return;

  const legacy = await chrome.storage.local.get("characters");
  if (!legacy.characters || Object.keys(legacy.characters).length === 0) {
    await chrome.storage.local.set({ legacyMigrationVersion: LEGACY_MIGRATION_VERSION });
    return;
  }

  try {
    const imported = await importLegacyCharacters(legacy.characters);
    await chrome.storage.local.remove(["characters", "lastSnapshot"]);
    await chrome.storage.local.set({
      legacyMigrationVersion: LEGACY_MIGRATION_VERSION,
      legacyMigratedSnapshots: imported
    });
    console.info(`JanitorAI Stats Tracker: migrated ${imported} legacy snapshots.`);
  } catch (error) {
    console.error("JanitorAI Stats Tracker: legacy migration failed; old data was left intact.", error);
  }
}

export function characterIdFromUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://janitorai.com/characters/${url}`);
    const match = parsed.pathname.match(/\/characters\/([0-9a-f]{8}-[0-9a-f-]{27,})/i);
    if (match?.[1]) return match[1];
    // Also handle simple uuid directly in path
    const directMatch = parsed.pathname.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return directMatch?.[1] || null;
  } catch {
    const directMatch = String(url).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return directMatch?.[1] || null;
  }
}

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    await chrome.alarms.create(ALARM_NAME, {
      periodInMinutes: PERIOD_MINUTES
    });
  }
}

let initializationPromise = null;

async function initialize() {
  if (!initializationPromise) {
    initializationPromise = migrateLegacyStorage()
      .then(() => ensureAlarm())
      .catch(error => {
        initializationPromise = null;
        throw error;
      });
  }
  return initializationPromise;
}

chrome.runtime.onInstalled.addListener(() => {
  initialize().catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  initialize().catch(console.error);
});

/**
 * Autonomously scrape bot stats from JanitorAI's internal API endpoint
 * using extension privileges (Datacat / Janny model).
 */
export async function scrapeCharacterById(characterId, jobMetadata = null) {
  if (!characterId) return null;

  try {
    const endpoint = `https://janitorai.com/hampter/characters/${characterId}`;
    const res = await fetch(endpoint, {
      credentials: "include",
      headers: {
        Accept: "application/json, text/plain, */*",
        Referer: "https://janitorai.com/"
      }
    });

    if (!res.ok) {
      console.warn(`JStats: direct fetch returned HTTP ${res.status} for character ${characterId}`);
      return null;
    }

    const json = await res.json();
    const raw = json.data?.character || json.data || json.character || json;
    if (!raw) return null;

    const charName = raw.name || raw.character_name || jobMetadata?.character_name || "JanitorAI Character";
    const msgs = Number(
      raw.stats?.message ?? raw.stats?.messages ?? raw.stats?.msgs ??
      raw.total_message ?? raw.message ?? raw.msgs
    ) || 0;
    const chats = Number(
      raw.stats?.chat ?? raw.stats?.chats ?? raw.chats ?? raw.chat ?? raw.chat_count
    ) || 0;
    const favourites = Number(
      raw.stats?.favorite ?? raw.stats?.favourite ?? raw.stats?.favorites ?? raw.stats?.favourites ??
      raw.favourites ?? raw.favorites ?? raw.favorite
    ) || 0;
    const comments = Number(
      raw.stats?.comment ?? raw.stats?.comments ?? raw.comments ?? raw.comment
    ) || 0;
    const pubVal = raw.stats?.publishedChats ?? raw.stats?.published_chats ?? raw.publishedChats ?? raw.published_chats;
    const publishedChats = pubVal != null ? Number(pubVal) : null;

    const charMetadata = {
      characterId,
      characterName: charName,
      url: jobMetadata?.url || `https://janitorai.com/characters/${characterId}`,
      avatar: raw.avatar || null,
      createdAt: raw.created_at || raw.createdAt || jobMetadata?.createdAt || null,
      updatedAt: raw.updated_at || raw.updatedAt || new Date().toISOString(),
      publishedAt: raw.published_at || raw.publishedAt || jobMetadata?.publishedAt || null,
      publishedChats
    };

    const snapshot = {
      timestamp: new Date().toISOString(),
      characterId,
      msgs,
      msgsDisplay: msgs.toLocaleString(),
      chats,
      chatsDisplay: chats.toLocaleString(),
      comments,
      commentsDisplay: comments.toLocaleString(),
      favourites,
      favouritesDisplay: favourites.toLocaleString(),
      publishedChats,
      publishedChatsDisplay: publishedChats != null ? publishedChats.toLocaleString() : null
    };

    // 1. Save to local IndexedDB
    await saveCharacterSnapshot(charMetadata, snapshot);

    // 2. Save to Supabase (if configured)
    await insertSnapshot(characterId, snapshot);

    // 3. Update last_scraped_at in Supabase job
    if (jobMetadata) {
      await saveTrackedJob({
        ...jobMetadata,
        character_name: charName,
        last_scraped_at: snapshot.timestamp
      });
    }

    console.debug(`JStats: Successfully scraped 1m snapshot for ${charName} (${characterId})`);
    return snapshot;
  } catch (err) {
    console.error(`JStats: error scraping character ${characterId}:`, err);
    return null;
  }
}

/**
 * 1-Minute Periodic Alarm Listener
 * Queries active 72h jobs and scrapes each active bot.
 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  try {
    const nowMs = Date.now();

    // 1. Retrieve jobs from Supabase
    let activeJobs = [];
    const supabaseJobs = await fetchTrackedJobs();

    if (supabaseJobs && supabaseJobs.length > 0) {
      for (const job of supabaseJobs) {
        const isExpired = job.expires_at && nowMs >= new Date(job.expires_at).getTime();
        if (isExpired && job.status === "active") {
          await updateTrackedJobStatus(job.character_id, "completed");
          console.info(`JStats: 72h tracking completed for ${job.character_name} (${job.character_id})`);
        } else if (job.status === "active") {
          activeJobs.push(job);
        }
      }
    }

    // 2. Fallback / Merge with local tracked jobs
    const localStore = await chrome.storage.local.get("trackedJobs");
    const localJobs = localStore.trackedJobs || {};
    for (const [charId, localJob] of Object.entries(localJobs)) {
      const isExpired = localJob.expires_at && nowMs >= new Date(localJob.expires_at).getTime();
      if (isExpired && localJob.status === "active") {
        localJob.status = "completed";
        localJobs[charId] = localJob;
        await chrome.storage.local.set({ trackedJobs: localJobs });
      } else if (localJob.status === "active" && !activeJobs.some(j => j.character_id === charId)) {
        activeJobs.push(localJob);
      }
    }

    // 3. If no active jobs defined yet, fall back to existing local characters
    if (!activeJobs.length) {
      const existingCharacters = await getAllCharacters();
      for (const char of existingCharacters) {
        activeJobs.push({
          character_id: char.characterId,
          character_name: char.characterName,
          url: char.url,
          status: "active"
        });
      }
    }

    // 4. Scrape all active bots autonomously
    for (const job of activeJobs) {
      const charId = job.character_id || job.characterId;
      if (!charId) continue;
      await scrapeCharacterById(charId, job);
    }

    // 5. Also reload any open JanitorAI character tabs to keep session fresh
    const tabs = await chrome.tabs.query({
      url: [
        "https://janitorai.com/characters/*",
        "https://www.janitorai.com/characters/*"
      ]
    });

    const chosenTabs = new Map();
    const activeIds = new Set(activeJobs.map(j => j.character_id || j.characterId));
    for (const tab of tabs) {
      if (!tab.id || !tab.url) continue;
      const characterId = characterIdFromUrl(tab.url);
      if (!characterId || !activeIds.has(characterId)) continue;
      if (!chosenTabs.has(characterId)) chosenTabs.set(characterId, tab);
    }

    for (const [characterId, tab] of chosenTabs) {
      try {
        await chrome.tabs.reload(tab.id, { bypassCache: false });
        console.debug("Refreshed active character tab", characterId, tab.id);
      } catch (error) {
        console.warn("JanitorAI tab refresh failed", tab.id, error);
      }
    }

    await ensureAlarm();
  } catch (error) {
    console.error("Tracker alarm error", error);
  }
});

/**
 * Runtime Message Dispatcher
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 1. SAVE_SNAPSHOT: from content script or manual entry
  if (message?.type === "SAVE_SNAPSHOT") {
    (async () => {
      const payload = message.payload;
      if (!payload?.characterId) throw new Error("Missing character ID.");

      const snapshot = {
        timestamp: payload.timestamp || new Date().toISOString(),
        msgs: payload.msgs,
        msgsDisplay: payload.msgsDisplay ?? null,
        chats: payload.chats,
        chatsDisplay: payload.chatsDisplay ?? null,
        comments: payload.comments,
        commentsDisplay: payload.commentsDisplay ?? null,
        favourites: payload.favourites,
        favouritesDisplay: payload.favouritesDisplay ?? null,
        publishedChats: Number.isFinite(payload.publishedChats) ? payload.publishedChats : null,
        publishedChatsDisplay: payload.publishedChatsDisplay ?? null
      };

      const allPresent = REQUIRED_STATS.every(key => Number.isFinite(snapshot[key]));
      if (!allPresent) {
        return { ok: false, reason: "INCOMPLETE_STATS" };
      }

      await saveCharacterSnapshot(
        {
          characterId: payload.characterId,
          characterName: payload.characterName,
          url: payload.url,
          createdAt: payload.createdAt,
          updatedAt: payload.updatedAt,
          publishedAt: payload.publishedAt
        },
        snapshot
      );

      // Forward to Supabase in real time
      await insertSnapshot(payload.characterId, snapshot);

      const active = await chrome.storage.local.get("activeCharacterId");
      if (!active.activeCharacterId) {
        await chrome.storage.local.set({ activeCharacterId: payload.characterId });
      }

      return { ok: true, snapshot };
    })()
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  // 2. TRACK_NEW_URL: starts autonomous 3-day tracking for given character link
  if (message?.type === "TRACK_NEW_URL") {
    (async () => {
      const { url, durationHours = 72, characterName } = message.payload || {};
      const characterId = characterIdFromUrl(url) || url.trim();

      if (!characterId) {
        throw new Error("Could not extract a valid JanitorAI character ID or UUID from URL.");
      }

      const now = new Date();
      const hours = Number(durationHours) || 72;
      const expiresAt = new Date(now.getTime() + hours * 3600 * 1000).toISOString();

      const job = {
        character_id: characterId,
        character_name: characterName || "JanitorAI Character",
        url: url.startsWith("http") ? url : `https://janitorai.com/characters/${characterId}`,
        started_at: now.toISOString(),
        expires_at: expiresAt,
        status: "active",
        last_scraped_at: now.toISOString()
      };

      // 1. Save to Supabase
      await saveTrackedJob(job);

      // 2. Save to Chrome Local Storage
      const localStore = await chrome.storage.local.get("trackedJobs");
      const trackedJobs = localStore.trackedJobs || {};
      trackedJobs[characterId] = job;
      await chrome.storage.local.set({ trackedJobs, activeCharacterId: characterId });

      // 3. Trigger immediate scrape
      const snapshot = await scrapeCharacterById(characterId, job);
      await ensureAlarm();

      return { ok: true, characterId, job, snapshot };
    })()
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  // 3. OPEN_DASHBOARD
  if (message?.type === "OPEN_DASHBOARD") {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
    sendResponse({ ok: true });
    return false;
  }

  // 4. TRIGGER_SCRAPE_NOW
  if (message?.type === "TRIGGER_SCRAPE_NOW") {
    (async () => {
      const charId = message.payload?.characterId;
      if (!charId) throw new Error("Missing characterId");
      const snapshot = await scrapeCharacterById(charId);
      return { ok: true, snapshot };
    })()
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

initialize().catch(console.error);
