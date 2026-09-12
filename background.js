import { getAllCharacters, saveCharacterSnapshot, importLegacyCharacters } from "./db.js";

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

function characterIdFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const uuid = path.match(/\/characters\/([0-9a-f]{8}-[0-9a-f-]{27,})/i);
    return uuid?.[1] || null;
  } catch {
    return null;
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

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  try {
    const characters = await getAllCharacters();
    if (!characters.length) return;

    const trackedIds = new Set(characters.map(c => c.characterId));

    const tabs = await chrome.tabs.query({
      url: [
        "https://janitorai.com/characters/*",
        "https://www.janitorai.com/characters/*"
      ]
    });

    // Reload at most one open tab per tracked character.
    const chosenTabs = new Map();
    for (const tab of tabs) {
      if (!tab.id || !tab.url) continue;
      const characterId = characterIdFromUrl(tab.url);
      if (!characterId || !trackedIds.has(characterId)) continue;
      if (!chosenTabs.has(characterId)) chosenTabs.set(characterId, tab);
    }

    for (const [characterId, tab] of chosenTabs) {
      try {
        await chrome.tabs.reload(tab.id, { bypassCache: false });
        console.debug("Refreshed tracked character", characterId, tab.id);
      } catch (error) {
        console.warn("JanitorAI refresh failed", tab.id, error);
      }
    }

    await ensureAlarm();
  } catch (error) {
    console.error("Tracker alarm error", error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

  if (message?.type === "OPEN_DASHBOARD") {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

initialize().catch(console.error);
