import {
  getAllCharacters,
  getCharacter,
  saveCharacterSnapshot,
  getLatestSnapshot,
  openTrackerDb,
  importLegacyCharacters
} from "./db.js";
import {
  getSupabaseConfig,
  fetchTrackedJobs,
  saveTrackedJob,
  insertSnapshot,
  updateTrackedJobStatus,
  updateTrackedJobMetadata
} from "./supabase.js";
import {
  cleanCreatorHandle,
  matchesWatchedCreator
} from "./common.js";

const ALARM_NAME = "janitorai-stats-refresh";
const PERIOD_MINUTES = 1;

export function cleanUuid(val) {
  if (!val) return null;
  const m = String(val).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0].toLowerCase() : null;
}

const REQUIRED_STATS = ["msgs", "chats"];
const OPTIONAL_STATS = ["publishedChats", "comments", "favourites"];
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
  const match = String(url).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match ? match[1].toLowerCase() : null;
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

// Map of pending background tab scrape resolvers: characterId -> (snapshot) => void
const pendingTabScrapes = new Map();

/**
 * Fallback: Opens a silent, inactive tab to allow content.js to extract DOM/feed stats
 * with full Cloudflare clearance, then closes the tab automatically.
 */
export async function scrapeViaBackgroundTab(characterId, jobMetadata = null, customUrl = null) {
  if (typeof chrome === "undefined" || !chrome.tabs) return null;

  const targetUrl = customUrl || jobMetadata?.url || `https://janitorai.com/characters/${characterId}`;
  const isFollowingFeed = targetUrl.includes("following");

  // 1. Check if an active tab already exists for this character or following feed
  try {
    const queryUrls = isFollowingFeed
      ? ["*://janitorai.com/?segment=following*", "*://www.janitorai.com/?segment=following*"]
      : [`*://janitorai.com/characters/${characterId}*`, `*://www.janitorai.com/characters/${characterId}*`];

    const existingTabs = await chrome.tabs.query({ url: queryUrls });

    if (existingTabs.length > 0 && existingTabs[0].id) {
      const tabId = existingTabs[0].id;
      try {
        const res = await chrome.tabs.sendMessage(tabId, {
          type: "GET_FEED_CHARACTER_STATS",
          characterId
        });
        if (res?.ok && res?.snapshot) return res.snapshot;
      } catch {}
      await chrome.tabs.reload(tabId, { bypassCache: false }).catch(() => {});
    }
  } catch (e) {
    console.debug("JStats: error querying existing tabs", e);
  }

  const cleanId = cleanUuid(characterId) || characterId;

  // 2. Open temporary inactive background tab
  return new Promise((resolve) => {
    let tempTab = null;
    let timeoutId = null;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (cleanId) pendingTabScrapes.delete(cleanId);
      pendingTabScrapes.delete(characterId);
      if (tempTab?.id) {
        chrome.tabs.remove(tempTab.id).catch(() => {});
      }
    };

    const timeoutDuration = isFollowingFeed ? 12000 : 18000;

    timeoutId = setTimeout(() => {
      console.warn(`JStats: background tab scrape timed out for ${characterId} on ${targetUrl}`);
      cleanup();
      resolve(null);
    }, timeoutDuration);

    const resolver = (snapshot) => {
      cleanup();
      resolve(snapshot);
    };

    if (cleanId) pendingTabScrapes.set(cleanId, resolver);
    pendingTabScrapes.set(characterId, resolver);

    chrome.tabs.create({
      url: targetUrl,
      active: false // Keep background, do not interrupt user
    }).then(created => {
      tempTab = created;
    }).catch(err => {
      console.error("JStats: failed to open background tab for character", err);
      cleanup();
      resolve(null);
    });
  });
}

function extractTokenFromString(raw) {
  if (!raw) return null;
  const b64decode = (s) => {
    try { return atob(s); } catch {}
    try { return atob(s.replace(/-/g, "+").replace(/_/g, "/")); } catch {}
    try {
      let pad = s.replace(/-/g, "+").replace(/_/g, "/");
      while (pad.length % 4) pad += "=";
      return atob(pad);
    } catch {}
    return null;
  };

  let str = raw;
  try { str = decodeURIComponent(raw); } catch {}
  if (str.startsWith("base64-")) str = str.slice(7);

  if (str.startsWith("ey") && str.split(".").length === 3) return str;

  try {
    const o = JSON.parse(str);
    const tok = o?.access_token || o?.accessToken || (Array.isArray(o) && o[0]?.access_token) || o?.currentSession?.access_token;
    if (tok && typeof tok === "string" && tok.startsWith("ey")) return tok;
  } catch {}

  const decoded = b64decode(str);
  if (decoded) {
    if (decoded.startsWith("ey") && decoded.split(".").length === 3) return decoded;
    try {
      const o = JSON.parse(decoded);
      const tok = o?.access_token || o?.accessToken || (Array.isArray(o) && o[0]?.access_token) || o?.currentSession?.access_token;
      if (tok && typeof tok === "string" && tok.startsWith("ey")) return tok;
    } catch {}
    const m = decoded.match(/(eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})/);
    if (m) return m[1];
  }

  const m = str.match(/(eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})/);
  if (m) return m[1];

  return null;
}

/**
 * Retrieves the user's JanitorAI session JWT from Chrome cookies if present.
 * Queries both domain and url patterns to ensure partitioned / host cookies are read.
 * Handles multi-cookie chunking used by Supabase Auth (e.g. .0, .1).
 */
export async function getJanitorToken() {
  if (typeof chrome === "undefined" || !chrome.cookies) return null;
  try {
    const domainCookies = await chrome.cookies.getAll({ domain: "janitorai.com" }).catch(() => []);
    const urlCookies = await chrome.cookies.getAll({ url: "https://janitorai.com" }).catch(() => []);
    const combinedMap = new Map();
    for (const c of [...domainCookies, ...urlCookies]) {
      combinedMap.set(`${c.domain}:${c.name}`, c);
    }
    const cookies = [...combinedMap.values()];

    const chunks = new Map();
    const singles = [];

    for (const c of cookies) {
      if (!c.name.includes("auth-token")) continue;
      const match = c.name.match(/^(.*?)\.(\d+)$/);
      if (match) {
        const baseName = match[1];
        const idx = Number(match[2]);
        if (!chunks.has(baseName)) chunks.set(baseName, []);
        chunks.get(baseName).push({ idx, value: c.value });
      } else {
        singles.push(c.value);
      }
    }

    // Try chunked cookies first (concatenated by index order)
    for (const [, list] of chunks.entries()) {
      list.sort((a, b) => a.idx - b.idx);
      const combined = list.map(x => x.value).join("");
      const token = extractTokenFromString(combined);
      if (token) return token;
    }

    // Try single cookies
    for (const val of singles) {
      const token = extractTokenFromString(val);
      if (token) return token;
    }
  } catch (e) {
    console.debug("JStats: error reading janitorai cookies", e);
  }
  return null;
}

/**
 * Autonomously scrape bot stats from JanitorAI
 * 1. Tries internal API endpoint with user session token via extension privileges.
 * 2. Falls back to silent inactive tab DOM extraction if API is protected or 401/403.
 */
/**
 * Validates, normalizes, and saves a scraped character payload to local IndexedDB,
 * Supabase character_snapshots, and updates tracked_jobs.
 */
export async function processAndSaveScrapedCharacter(cleanId, raw, jobMetadata = null) {
  if (!raw || typeof raw !== "object") return null;

  const charName = raw.name || raw.character_name || jobMetadata?.character_name || "JanitorAI Character";
  const msgsRaw =
    raw.msgs ??
    raw.messages ??
    raw.total_message ??
    raw.total_messages ??
    raw.totalMessages ??
    raw.totalMessage ??
    raw.stats?.msgs ??
    raw.stats?.message ??
    raw.stats?.messages ??
    raw.stats?.total_message ??
    raw.stats?.total_messages ??
    raw.message;

  const chatsRaw =
    raw.chats ??
    raw.total_chat ??
    raw.total_chats ??
    raw.totalChats ??
    raw.totalChat ??
    raw.stats?.chats ??
    raw.stats?.chat ??
    raw.stats?.total_chat ??
    raw.stats?.total_chats ??
    raw.chat ??
    raw.chat_count;

  const favsRaw =
    raw.favourites ??
    raw.favorites ??
    raw.total_favorite ??
    raw.total_favorites ??
    raw.total_favourite ??
    raw.total_favourites ??
    raw.stats?.favorite ??
    raw.stats?.favourite ??
    raw.stats?.favorites ??
    raw.stats?.favourites ??
    raw.favorite;

  const commsRaw =
    raw.comments ??
    raw.comment ??
    raw.total_comment ??
    raw.total_comments ??
    raw.stats?.comment ??
    raw.stats?.comments;

  const msgs = Number(msgsRaw);
  const chats = Number(chatsRaw);
  let favourites = Number(favsRaw);
  let comments = Number(commsRaw);

  if (!Number.isFinite(msgs) || !Number.isFinite(chats) || (msgs === 0 && chats === 0)) {
    return null;
  }

  const pubVal = raw.stats?.publishedChats ?? raw.stats?.published_chats ?? raw.publishedChats ?? raw.published_chats;
  let pubNum = (pubVal != null && Number.isFinite(Number(pubVal)) && Number(pubVal) > 0) ? Number(pubVal) : null;

  let latestSnap = null;
  if (!Number.isFinite(comments) || comments <= 0 || !Number.isFinite(favourites) || favourites <= 0 || pubNum == null || pubNum <= 0) {
    try {
      latestSnap = await getLatestSnapshot(cleanId);
    } catch {}
  }

  const resolvedComments = (Number.isFinite(comments) && comments > 0)
    ? comments
    : (latestSnap && Number.isFinite(Number(latestSnap.comments)) && Number(latestSnap.comments) > 0 ? Number(latestSnap.comments) : (Number.isFinite(comments) && comments >= 0 ? comments : 0));

  const resolvedFavs = (Number.isFinite(favourites) && favourites > 0)
    ? favourites
    : (latestSnap && Number.isFinite(Number(latestSnap.favourites)) && Number(latestSnap.favourites) > 0 ? Number(latestSnap.favourites) : (Number.isFinite(favourites) && favourites >= 0 ? favourites : 0));

  const publishedChats = pubNum != null && pubNum > 0
    ? pubNum
    : (latestSnap && Number.isFinite(Number(latestSnap.publishedChats)) && Number(latestSnap.publishedChats) > 0 ? Number(latestSnap.publishedChats) : (jobMetadata?.publishedChats ? Number(jobMetadata.publishedChats) : null));

  const creator = raw.creator || raw.creator_name || raw.creator?.name || raw.creator_username || (typeof raw.creator === "string" ? raw.creator : null) || raw.user?.name || jobMetadata?.creator || null;
  const charMetadata = {
    characterId: cleanId,
    characterName: charName,
    url: jobMetadata?.url || `https://janitorai.com/characters/${cleanId}`,
    avatar: raw.avatar || null,
    creator,
    createdAt: raw.created_at || raw.createdAt || jobMetadata?.createdAt || null,
    updatedAt: raw.updated_at || raw.updatedAt || new Date().toISOString(),
    publishedAt: raw.published_at || raw.publishedAt || jobMetadata?.publishedAt || null,
    publishedChats
  };

  const snapshot = {
    timestamp: new Date().toISOString(),
    characterId: cleanId,
    msgs,
    msgsDisplay: msgs.toLocaleString(),
    chats,
    chatsDisplay: chats.toLocaleString(),
    chatMsgRatio: chats > 0 ? Number((msgs / chats).toFixed(3)) : null,
    comments: resolvedComments,
    commentsDisplay: resolvedComments.toLocaleString(),
    favourites: resolvedFavs,
    favouritesDisplay: resolvedFavs.toLocaleString(),
    publishedChats,
    publishedChatsDisplay: publishedChats != null ? publishedChats.toLocaleString() : null
  };

  // 1. Save to local IndexedDB
  await saveCharacterSnapshot(charMetadata, snapshot);

  // 2. Save to Supabase (if configured)
  await insertSnapshot(cleanId, snapshot);

  // 3. Update last_scraped_at in Supabase job
  if (jobMetadata) {
    await saveTrackedJob({
      ...jobMetadata,
      character_name: charName,
      avatar: charMetadata.avatar || jobMetadata.avatar || null,
      creator: charMetadata.creator || jobMetadata.creator || null,
      last_scraped_at: snapshot.timestamp
    });
  }

  // 4. Resolve pending background tab scrape if waiting
  const resolver = pendingTabScrapes.get(cleanId);
  if (resolver) {
    pendingTabScrapes.delete(cleanId);
    resolver(snapshot);
  }

  // 5. Broadcast SNAPSHOT_SAVED to all open tabs
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, {
          type: "SNAPSHOT_SAVED",
          payload: { characterId: cleanId, snapshot }
        }).catch(() => {});
      }
    }
  } catch {}

  console.info(`JStats: Successfully saved snapshot for ${charName} (${cleanId})`, snapshot);
  return snapshot;
}

/**
 * Autonomously scrapes bot stats with prioritization for the Following feed:
 * 1. Queries open JanitorAI tabs (user's open Following tab has ultra-fresh real-time stats).
 * 2. Fetches Following feed internal API endpoints directly.
 * 3. Opens a silent background tab to https://janitorai.com/?segment=following.
 * 4. Falls back to direct bot endpoint (/hampter/characters/{id}) if bot is not in Following.
 * 5. Falls back to direct bot background tab.
 */
export async function scrapeCharacterById(characterId, jobMetadata = null) {
  const cleanId = characterIdFromUrl(characterId) || cleanUuid(characterId);
  if (!cleanId) return null;

  // TIER 1: Check Open JanitorAI Tabs (e.g. user currently on Following tab)
  try {
    const openTabs = await chrome.tabs.query({
      url: ["*://janitorai.com/*", "*://www.janitorai.com/*"]
    });

    // Prioritize tabs with 'following' in URL
    openTabs.sort((a, b) => {
      const aF = a.url && a.url.includes("following") ? 1 : 0;
      const bF = b.url && b.url.includes("following") ? 1 : 0;
      return bF - aF;
    });

    for (const tab of openTabs) {
      if (!tab.id) continue;
      try {
        const res = await chrome.tabs.sendMessage(tab.id, {
          type: "GET_FEED_CHARACTER_STATS",
          characterId: cleanId
        });
        if (res?.ok && res?.snapshot) {
          const snap = res.snapshot;
          const processed = await processAndSaveScrapedCharacter(cleanId, snap, jobMetadata);
          if (processed) {
            console.info(`JStats: Scraped ${cleanId} live from open user tab (${tab.url})`, processed);
            return processed;
          }
        }
      } catch {}
    }
  } catch (err) {
    console.debug("JStats: error querying open tabs for feed stats", err);
  }

  // TIER 2: Direct Following Feed API Fetch (updates faster than direct character endpoint)
  try {
    const token = await getJanitorToken();
    const headers = {
      Accept: "application/json, text/plain, */*",
      Referer: "https://janitorai.com/?segment=following"
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const followingEndpoints = [
      "https://janitorai.com/hampter/characters?segment=following",
      "https://janitorai.com/hampter/following/characters",
      "https://janitorai.com/hampter/characters?mode=following"
    ];

    for (const ep of followingEndpoints) {
      try {
        const feedRes = await fetch(ep, { credentials: "include", headers });
        if (feedRes.ok) {
          const feedJson = await feedRes.json();
          const items = feedJson.data || feedJson.characters || (Array.isArray(feedJson) ? feedJson : []);
          if (Array.isArray(items) && items.length > 0) {
            const match = items.find(it => cleanUuid(it.id || it.character_id || it.uuid) === cleanId);
            if (match) {
              const snapshot = await processAndSaveScrapedCharacter(cleanId, match, jobMetadata);
              if (snapshot) {
                console.info(`JStats: Scraped fresh Following feed API for ${cleanId}`, snapshot);
                return snapshot;
              }
            }
          }
        }
      } catch {}
    }
  } catch (err) {
    console.debug("JStats: error fetching following feed API", err);
  }

  // TIER 3: Silent Background Tab targeting https://janitorai.com/?segment=following
  try {
    const followingTabSnapshot = await scrapeViaBackgroundTab(
      cleanId,
      jobMetadata,
      "https://janitorai.com/?segment=following"
    );
    if (followingTabSnapshot) {
      console.info(`JStats: Scraped ${cleanId} from background Following tab`, followingTabSnapshot);
      return followingTabSnapshot;
    }
  } catch (err) {
    console.debug("JStats: error with background Following tab", err);
  }

  // TIER 4: Fallback to direct bot endpoint (/hampter/characters/{id})
  // (In case the character is not present in the user's Following feed)
  try {
    const endpoint = `https://janitorai.com/hampter/characters/${cleanId}`;
    const token = await getJanitorToken();
    const headers = {
      Accept: "application/json, text/plain, */*",
      Referer: "https://janitorai.com/"
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(endpoint, {
      credentials: "include",
      headers
    });

    if (res.ok) {
      const json = await res.json();
      const raw = json.data?.character || json.data || json.character || json;
      if (raw) {
        const snapshot = await processAndSaveScrapedCharacter(cleanId, raw, jobMetadata);
        if (snapshot) return snapshot;
      }
    }
  } catch (err) {
    console.warn(`JStats: direct endpoint error for ${cleanId}`, err);
  }

  // TIER 5: Fallback to direct character background tab
  const directUrl = jobMetadata?.url || `https://janitorai.com/characters/${cleanId}`;
  return await scrapeViaBackgroundTab(cleanId, jobMetadata, directUrl);
}

/**
 * Auto-registers a newly discovered bot from a watched creator or followed feed.
 * Instantly logs the Minute 0 baseline snapshot (0 msgs, 0 chats) and starts autonomous tracking.
 */
export async function autoRegisterCreatorBot(payload) {
  const { characterId, characterName, avatar, creator, url, initialSnapshot } = payload || {};
  const cleanId = cleanUuid(characterId);
  if (!cleanId) throw new Error("Invalid characterId");

  const localStore = await chrome.storage.local.get("trackedJobs");
  const trackedJobs = localStore.trackedJobs || {};
  if (trackedJobs[cleanId] && trackedJobs[cleanId].status === "active") {
    return { ok: true, alreadyTracked: true, job: trackedJobs[cleanId] };
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 72 * 3600 * 1000).toISOString();

  const job = {
    character_id: cleanId,
    character_name: characterName || "JanitorAI Character",
    url: url || `https://janitorai.com/characters/${cleanId}`,
    started_at: now.toISOString(),
    expires_at: expiresAt,
    status: "active",
    last_scraped_at: now.toISOString(),
    creator: creator || null,
    avatar: avatar || null
  };

  // 1. Save to Supabase
  try {
    await saveTrackedJob(job);
  } catch (err) {
    console.debug("Supabase saveTrackedJob error in autoRegisterCreatorBot", err);
  }

  // 2. Save to Chrome Local Storage
  trackedJobs[cleanId] = job;
  await chrome.storage.local.set({ trackedJobs });

  // 3. Save initial Minute 0 Snapshot
  const snap = {
    timestamp: initialSnapshot?.timestamp || now.toISOString(),
    msgs: initialSnapshot?.msgs ?? 0,
    msgsDisplay: (initialSnapshot?.msgs ?? 0).toLocaleString(),
    chats: initialSnapshot?.chats ?? 0,
    chatsDisplay: (initialSnapshot?.chats ?? 0).toLocaleString(),
    comments: initialSnapshot?.comments ?? 0,
    commentsDisplay: (initialSnapshot?.comments ?? 0).toLocaleString(),
    favourites: initialSnapshot?.favourites ?? 0,
    favouritesDisplay: (initialSnapshot?.favourites ?? 0).toLocaleString(),
    publishedChats: initialSnapshot?.publishedChats ?? 0,
    publishedChatsDisplay: (initialSnapshot?.publishedChats ?? 0).toLocaleString(),
    isExact: true
  };

  try {
    await saveCharacterSnapshot(
      {
        characterId: cleanId,
        characterName: job.character_name,
        url: job.url,
        avatar: avatar || null,
        creator: creator || null
      },
      snap
    );
  } catch (err) {
    console.debug("saveCharacterSnapshot error in autoRegisterCreatorBot", err);
  }

  try {
    await insertSnapshot(cleanId, snap);
  } catch (err) {
    console.debug("insertSnapshot error in autoRegisterCreatorBot", err);
  }

  // 4. Send Chrome Notification
  try {
    if (chrome.notifications && chrome.notifications.create) {
      chrome.notifications.create({
        type: "basic",
        iconUrl: avatar || "icons/icon128.png",
        title: "🚨 Auto-Tracked New Bot! (Minute 0)",
        message: `"${job.character_name}" by @${creator || "creator"} was published! Tracking started at minute 0.`,
        priority: 2
      });
    }
  } catch (err) {
    console.debug("Notification error", err);
  }

  await ensureAlarm();

  // 5. Broadcast to all open tabs so dashboard and popup update immediately
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, {
          type: "NEW_BOT_AUTO_TRACKED",
          payload: { characterId: cleanId, job, snapshot: snap }
        }).catch(() => {});
      }
    }
  } catch {}

  return { ok: true, characterId: cleanId, job, snapshot: snap };
}

/**
 * Periodically checks the Following feed for new releases from watched creators.
 */
export async function checkAndAutoTrackWatchedCreators() {
  try {
    const localStore = await chrome.storage.local.get(["watchedCreators", "autoTrackAllFollowed", "trackedJobs"]);
    const watchedCreators = Array.isArray(localStore.watchedCreators) ? localStore.watchedCreators : [];
    const autoTrackAllFollowed = Boolean(localStore.autoTrackAllFollowed);
    if (!watchedCreators.length && !autoTrackAllFollowed) return;

    const trackedJobs = localStore.trackedJobs || {};
    const token = await getJanitorToken();
    const headers = {
      Accept: "application/json, text/plain, */*",
      Referer: "https://janitorai.com/?segment=following"
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const followingEndpoints = [
      "https://janitorai.com/hampter/characters?segment=following",
      "https://janitorai.com/hampter/following/characters"
    ];

    for (const ep of followingEndpoints) {
      try {
        const res = await fetch(ep, { credentials: "include", headers });
        if (!res.ok) continue;
        const json = await res.json();
        const items = json.data || json.characters || (Array.isArray(json) ? json : []);
        if (!Array.isArray(items) || !items.length) continue;

        for (const it of items) {
          const charId = cleanUuid(it.id || it.character_id || it.uuid);
          if (!charId) continue;
          if (trackedJobs[charId] && trackedJobs[charId].status === "active") continue;

          const creator = it.creator_name || it.creator?.name || it.creator?.username || (typeof it.creator === "string" ? it.creator : null) || it.user?.name;
          const isWatched = matchesWatchedCreator(creator, watchedCreators);
          if (isWatched || autoTrackAllFollowed) {
            console.info(`JStats [Background Alarm]: Auto-tracking new bot "${it.name}" from @${creator} (${charId})`);
            const msgs = Number(it.stats?.total_message ?? it.stats?.total_messages ?? it.stats?.msgs ?? it.total_message ?? it.messages ?? 0);
            const chats = Number(it.stats?.total_chat ?? it.stats?.total_chats ?? it.stats?.chats ?? it.total_chat ?? it.chats ?? 0);
            await autoRegisterCreatorBot({
              characterId: charId,
              characterName: it.name || "JanitorAI Character",
              avatar: it.avatar || it.image || null,
              creator,
              url: `https://janitorai.com/characters/${charId}`,
              initialSnapshot: {
                msgs: Number.isFinite(msgs) && msgs >= 0 ? msgs : 0,
                chats: Number.isFinite(chats) && chats >= 0 ? chats : 0,
                comments: Number(it.stats?.total_comment ?? it.total_comment ?? 0),
                favourites: Number(it.stats?.total_favorite ?? it.total_favorite ?? 0),
                publishedChats: Number(it.published_chats ?? 0),
                isExact: true,
                timestamp: new Date().toISOString()
              }
            });
          }
        }
        break; // Successfully polled
      } catch (e) {
        console.debug("JStats: error polling following feed in checkAndAutoTrackWatchedCreators", e);
      }
    }
  } catch (err) {
    console.debug("JStats: error in checkAndAutoTrackWatchedCreators", err);
  }
}

/**
 * 1-Minute Periodic Alarm Listener
 * Queries active 72h jobs and scrapes each active bot.
 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  try {
    // 0. Check Following feed for newly dropped bots from watched creators
    await checkAndAutoTrackWatchedCreators();

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

    // 5. Also refresh and trigger collection on any open JanitorAI Following tabs or character tabs
    const allJanitorTabs = await chrome.tabs.query({
      url: ["*://janitorai.com/*", "*://www.janitorai.com/*"]
    });

    const chosenTabs = new Map();
    const activeIds = new Set(activeJobs.map(j => j.character_id || j.characterId));

    for (const tab of allJanitorTabs) {
      if (!tab.id || !tab.url) continue;

      // If user has a Following feed tab open, trigger fresh card scan
      if (tab.url.includes("following")) {
        try {
          chrome.tabs.sendMessage(tab.id, { type: "COLLECT_STATS" }).catch(() => {});
        } catch {}
        continue;
      }

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
      const cleanId = cleanUuid(payload?.characterId) || characterIdFromUrl(payload?.characterId) || payload?.characterId;
      if (!cleanId) throw new Error("Missing character ID.");

      const chatsVal = Number(payload.chats);
      const msgsVal = Number(payload.msgs);
      if (!Number.isFinite(chatsVal) || !Number.isFinite(msgsVal)) {
        return { ok: false, reason: "INVALID_CHATS_OR_MSGS" };
      }

      let commentsVal = (payload.comments != null && Number.isFinite(Number(payload.comments)) && Number(payload.comments) > 0)
        ? Number(payload.comments)
        : null;
      let favouritesVal = (payload.favourites != null && Number.isFinite(Number(payload.favourites)) && Number(payload.favourites) > 0)
        ? Number(payload.favourites)
        : null;
      let pubChatsVal = (payload.publishedChats != null && Number.isFinite(Number(payload.publishedChats)) && Number(payload.publishedChats) > 0)
        ? Number(payload.publishedChats)
        : null;
      let latestSnap = null;

      if (commentsVal == null || favouritesVal == null || pubChatsVal == null) {
        try {
          latestSnap = await getLatestSnapshot(cleanId);
        } catch {}
      }

      if (commentsVal == null && latestSnap && Number.isFinite(Number(latestSnap.comments)) && Number(latestSnap.comments) > 0) {
        commentsVal = Number(latestSnap.comments);
      }
      if (favouritesVal == null && latestSnap && Number.isFinite(Number(latestSnap.favourites)) && Number(latestSnap.favourites) > 0) {
        favouritesVal = Number(latestSnap.favourites);
      }
      if (pubChatsVal == null && latestSnap && Number.isFinite(Number(latestSnap.publishedChats)) && Number(latestSnap.publishedChats) > 0) {
        pubChatsVal = Number(latestSnap.publishedChats);
      }

      const finalComments = commentsVal != null && commentsVal >= 0 ? commentsVal : 0;
      const finalFavs = favouritesVal != null && favouritesVal >= 0 ? favouritesVal : 0;
      const finalPub = pubChatsVal != null && pubChatsVal > 0 ? pubChatsVal : null;

      const snapshot = {
        timestamp: payload.timestamp || new Date().toISOString(),
        characterId: cleanId,
        msgs: msgsVal,
        msgsDisplay: payload.msgsDisplay ?? msgsVal.toLocaleString(),
        chats: chatsVal,
        chatsDisplay: payload.chatsDisplay ?? chatsVal.toLocaleString(),
        chatMsgRatio: chatsVal > 0 ? Number((msgsVal / chatsVal).toFixed(3)) : null,
        comments: finalComments,
        commentsDisplay: payload.commentsDisplay ?? finalComments.toLocaleString(),
        favourites: finalFavs,
        favouritesDisplay: payload.favouritesDisplay ?? finalFavs.toLocaleString(),
        publishedChats: finalPub,
        publishedChatsDisplay: payload.publishedChatsDisplay ?? (finalPub != null ? finalPub.toLocaleString() : null)
      };

      await saveCharacterSnapshot(
        {
          characterId: cleanId,
          characterName: payload.characterName,
          url: payload.url,
          avatar: payload.avatar || null,
          creator: payload.creator || null,
          createdAt: payload.createdAt,
          updatedAt: payload.updatedAt,
          publishedAt: payload.publishedAt
        },
        snapshot
      );

      // Forward to Supabase in real time
      await insertSnapshot(cleanId, snapshot);

      // If metadata provided, update Supabase tracked job
      if (payload.avatar || payload.creator) {
        updateTrackedJobMetadata(cleanId, {
          avatar: payload.avatar,
          creator: payload.creator
        }).catch(() => {});
      }

      // Resolve pending background tab scrape if waiting
      const resolver = pendingTabScrapes.get(cleanId) || pendingTabScrapes.get(payload.characterId);
      if (resolver) {
        if (cleanId) pendingTabScrapes.delete(cleanId);
        pendingTabScrapes.delete(payload.characterId);
        resolver(snapshot);
      }

      // Update last_scraped_at in Supabase job
      try {
        const config = await getSupabaseConfig();
        if (config) {
          fetch(`${config.url}/rest/v1/tracked_jobs?character_id=eq.${encodeURIComponent(cleanId)}`, {
            method: "PATCH",
            headers: {
              apikey: config.anonKey,
              Authorization: `Bearer ${config.anonKey}`,
              "Content-Type": "application/json",
              Prefer: "return=minimal"
            },
            body: JSON.stringify({
              last_scraped_at: snapshot.timestamp,
              character_name: payload.characterName || undefined
            })
          }).catch(() => {});
        }
      } catch {}

      const active = await chrome.storage.local.get("activeCharacterId");
      if (!active.activeCharacterId) {
        await chrome.storage.local.set({ activeCharacterId: cleanId });
      }

      // Broadcast SNAPSHOT_SAVED to all open tabs
      try {
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
          if (tab.id) {
            chrome.tabs.sendMessage(tab.id, {
              type: "SNAPSHOT_SAVED",
              payload: {
                characterId: cleanId,
                snapshot
              }
            }).catch(() => {});
          }
        }
      } catch {}

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
      const rawId = message.payload?.characterId;
      const charId = cleanUuid(rawId) || characterIdFromUrl(rawId) || rawId;
      if (!charId) throw new Error("Missing characterId");
      const snapshot = await scrapeCharacterById(charId);
      return { ok: true, snapshot };
    })()
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  // 5. GET_JANITOR_TOKEN
  if (message?.type === "GET_JANITOR_TOKEN") {
    getJanitorToken()
      .then(token => sendResponse({ ok: true, token }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // 6. GET_BOT_DETAILS
  if (message?.type === "GET_BOT_DETAILS") {
    (async () => {
      const charId = cleanUuid(message.payload?.characterId);
      if (!charId) return { ok: false, error: "Missing characterId" };

      // 1. Check local IndexedDB
      let char = null;
      try { char = await getCharacter(charId); } catch {}
      let avatar = char?.avatar || null;
      let creator = char?.creator || null;

      // 2. Query open JanitorAI tabs
      try {
        const openTabs = await chrome.tabs.query({
          url: ["*://janitorai.com/*", "*://www.janitorai.com/*"]
        });
        for (const tab of openTabs) {
          if (!tab.id) continue;
          try {
            const res = await chrome.tabs.sendMessage(tab.id, {
              type: "GET_CHARACTER_PAGE_DETAILS",
              characterId: charId
            });
            if (res?.ok) {
              if (res.avatar && !avatar) avatar = res.avatar;
              if (res.creator && !creator) creator = res.creator;
              if (Array.isArray(res.reviews) && res.reviews.length > 0) {
                await chrome.storage.local.set({ [`jstats_reviews_${charId}`]: res.reviews });
              }
              if (avatar || creator) break;
            }
          } catch {}
        }
      } catch {}

      // 3. Read cached reviews
      const revStore = await chrome.storage.local.get(`jstats_reviews_${charId}`).catch(() => ({}));
      const reviews = revStore[`jstats_reviews_${charId}`] || [];

      return {
        ok: true,
        characterId: charId,
        avatar,
        creator,
        reviews
      };
    })()
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  // 7. UPDATE_BOT_META
  if (message?.type === "UPDATE_BOT_META") {
    (async () => {
      const { characterId, avatar, creator } = message.payload || {};
      const cleanId = cleanUuid(characterId);
      if (!cleanId) return { ok: false };

      try {
        const char = await getCharacter(cleanId);
        if (char) {
          if (avatar) char.avatar = avatar;
          if (creator) char.creator = creator;
          const db = await openTrackerDb();
          const tx = db.transaction("characters", "readwrite");
          tx.objectStore("characters").put(char);
          await new Promise(r => tx.oncomplete = r);
          db.close();
        }
      } catch {}

      await updateTrackedJobMetadata(cleanId, { avatar, creator });
      return { ok: true };
    })()
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  // 8. AUTO_REGISTER_CREATOR_BOT: Instantly register new bot from watched creator from minute 0
  if (message?.type === "AUTO_REGISTER_CREATOR_BOT") {
    autoRegisterCreatorBot(message.payload)
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  // 9. GET_WATCHED_CREATORS
  if (message?.type === "GET_WATCHED_CREATORS") {
    (async () => {
      const localStore = await chrome.storage.local.get(["watchedCreators", "autoTrackAllFollowed"]);
      return {
        ok: true,
        watchedCreators: Array.isArray(localStore.watchedCreators) ? localStore.watchedCreators : [],
        autoTrackAllFollowed: Boolean(localStore.autoTrackAllFollowed)
      };
    })()
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  // 10. ADD_WATCHED_CREATOR
  if (message?.type === "ADD_WATCHED_CREATOR") {
    (async () => {
      const raw = message.payload?.creatorHandle || message.payload?.handle || "";
      const handle = cleanCreatorHandle(raw);
      if (!handle) throw new Error("Invalid creator handle or profile link.");

      const localStore = await chrome.storage.local.get("watchedCreators");
      const list = Array.isArray(localStore.watchedCreators) ? localStore.watchedCreators : [];
      if (!list.some(w => cleanCreatorHandle(typeof w === "string" ? w : w.creatorHandle) === handle)) {
        list.push({
          creatorHandle: handle,
          addedAt: new Date().toISOString()
        });
        await chrome.storage.local.set({ watchedCreators: list });
      }
      return { ok: true, watchedCreators: list };
    })()
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  // 11. REMOVE_WATCHED_CREATOR
  if (message?.type === "REMOVE_WATCHED_CREATOR") {
    (async () => {
      const raw = message.payload?.creatorHandle || message.payload?.handle || "";
      const handle = cleanCreatorHandle(raw);
      const localStore = await chrome.storage.local.get("watchedCreators");
      let list = Array.isArray(localStore.watchedCreators) ? localStore.watchedCreators : [];
      list = list.filter(w => cleanCreatorHandle(typeof w === "string" ? w : w.creatorHandle) !== handle);
      await chrome.storage.local.set({ watchedCreators: list });
      return { ok: true, watchedCreators: list };
    })()
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  // 12. SET_AUTO_TRACK_FOLLOWED
  if (message?.type === "SET_AUTO_TRACK_FOLLOWED") {
    (async () => {
      const enabled = Boolean(message.payload?.enabled);
      await chrome.storage.local.set({ autoTrackAllFollowed: enabled });
      return { ok: true, autoTrackAllFollowed: enabled };
    })()
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

initialize().catch(console.error);
