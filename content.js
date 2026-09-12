const REQUIRED_STATS = ["msgs", "chats", "comments", "favourites"];
const OPTIONAL_STATS = ["publishedChats"];

// Cache of exact stats received from the MAIN world (injected_main.js)
const mainWorldStatsCache = new Map();
const pendingMainWorldRequests = new Map(); // requestId -> resolve(stats)

window.addEventListener("message", (e) => {
  if (e.source !== window || !e.data || e.data.source !== "JSTATS_MAIN") return;

  if (e.data.type === "EXACT_STATS_CAPTURED" || e.data.type === "EXACT_STATS_RESPONSE") {
    const stats = e.data.stats;
    const charId = cleanUuid(e.data.characterId || stats?.characterId);
    if (charId && stats) {
      mainWorldStatsCache.set(charId, stats);
    }
    if (e.data.requestId && pendingMainWorldRequests.has(e.data.requestId)) {
      const resolve = pendingMainWorldRequests.get(e.data.requestId);
      pendingMainWorldRequests.delete(e.data.requestId);
      resolve(stats);
    }
  }
});

function cleanUuid(val) {
  if (!val) return null;
  const m = String(val).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0].toLowerCase() : null;
}

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

function cleanDisplay(value) {
  return value == null ? null : String(value).trim();
}

function getCharacterId() {
  const match = location.pathname.match(/\/characters\/([0-9a-f]{8}-[0-9a-f-]{27,})/i);
  if (match?.[1]) {
    const uuid = cleanUuid(match[1]);
    if (uuid) return uuid;
  }
  return cleanUuid(location.pathname) || location.pathname;
}

function getCharacterName() {
  const heading = document.querySelector("h2.chakra-heading");
  return heading?.textContent?.trim() || document.title?.trim() || "JanitorAI character";
}

function getMessagesAndChats() {
  const ribbon = document.querySelector(".character-chat-messages-stat-ribbon-tag-hstack");
  if (!ribbon) return { msgs: null, msgsDisplay: null, chats: null, chatsDisplay: null };
  const values = [...ribbon.querySelectorAll("p")].map(el => cleanDisplay(el.textContent)).filter(Boolean);
  return {
    chats: parseStat(values[0]),
    chatsDisplay: values[0] ?? null,
    msgs: parseStat(values[1]),
    msgsDisplay: values[1] ?? null
  };
}

function getFavourites() {
  const button = document.querySelector('button[title*="favorite" i], button[title*="favourite" i], button[aria-label*="favorite" i], button[aria-label*="favourite" i]');
  if (!button) return { favourites: null, favouritesDisplay: null };
  const container = button.parentElement;
  const number = container?.querySelector('[class*="_number_"]');
  const display = cleanDisplay(number?.textContent);
  return { favourites: parseStat(display), favouritesDisplay: display };
}

function getComments() {
  const labels = [...document.querySelectorAll(".profile-badge-total-text")];
  for (const label of labels) {
    if (label.textContent.trim().toLowerCase() !== "comments") continue;
    const count = label.parentElement?.querySelector(".profile-badge-total-count");
    const display = cleanDisplay(count?.textContent);
    const comments = parseStat(display);
    if (comments != null) return { comments, commentsDisplay: display };
  }
  return { comments: null, commentsDisplay: null };
}

function getPublishedChats() {
  for (const heading of document.querySelectorAll("h3")) {
    const directText = [...heading.childNodes]
      .filter(node => node.nodeType === Node.TEXT_NODE)
      .map(node => node.textContent)
      .join(" ")
      .trim();

    if (!/^Published chats$/i.test(directText)) continue;
    const count = [...heading.querySelectorAll("span")]
      .map(el => cleanDisplay(el.textContent))
      .map(parseStat)
      .find(Number.isFinite);
    if (count != null) return { publishedChats: count, publishedChatsDisplay: formatPublishedCount(count) };
  }
  return { publishedChats: null, publishedChatsDisplay: null };
}

function formatPublishedCount(value) {
  return Number(value).toLocaleString();
}

function getDateMeta() {
  const result = { createdAt: null, updatedAt: null, publishedAt: null };
  for (const paragraph of document.querySelectorAll("p")) {
    const text = paragraph.textContent.trim().replace(/\s+/g, " ");
    const match = text.match(/^(Created|Updated|Published)\s+([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})$/i);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === "created") result.createdAt = value;
    if (key === "updated") result.updatedAt = value;
    if (key === "published") result.publishedAt = value;
  }
  return result;
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

function parseTokenFromCookies(cookieStr) {
  if (!cookieStr) return null;
  try {
    const parts = {};
    const cookies = cookieStr.split(";");
    for (const c of cookies) {
      const eq = c.indexOf("=");
      if (eq < 0) continue;
      const name = c.slice(0, eq).trim();
      const val = c.slice(eq + 1).trim();
      const mm = name.match(/^(sb-.*-auth-token)(?:\.(\d+))?$/);
      if (!mm) continue;
      const base = mm[1];
      const idx = mm[2] ? parseInt(mm[2], 10) : 0;
      if (!parts[base]) parts[base] = {};
      parts[base][idx] = val;
    }
    for (const base in parts) {
      const idxs = Object.keys(parts[base]).map(Number).sort((a, b) => a - b);
      let joined = "";
      for (const i of idxs) joined += parts[base][i];
      const tok = extractTokenFromString(joined);
      if (tok) return tok;
    }
  } catch {}
  return null;
}

function inspectStatsObject(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 4) return null;

  const msgsRaw =
    obj.total_message ??
    obj.total_messages ??
    obj.totalMessages ??
    obj.totalMessage ??
    obj.stats?.message ??
    obj.stats?.messages ??
    obj.stats?.msgs ??
    obj.stats?.total_message ??
    obj.stats?.total_messages ??
    obj.message_count ??
    obj.messageCount;

  const chatsRaw =
    obj.total_chat ??
    obj.total_chats ??
    obj.totalChats ??
    obj.totalChat ??
    obj.stats?.chat ??
    obj.stats?.chats ??
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
  const favourites = Number(favsRaw);
  const comments = Number(commsRaw);

  const hasMsgs = Number.isFinite(msgs) && msgs >= 0;
  const hasChats = Number.isFinite(chats) && chats >= 0;

  if (hasMsgs && hasChats && (msgs > 0 || chats > 0)) {
    return {
      msgs,
      msgsDisplay: msgs.toLocaleString(),
      chats,
      chatsDisplay: chats.toLocaleString(),
      favourites: Number.isFinite(favourites) && favourites >= 0 ? favourites : null,
      favouritesDisplay: Number.isFinite(favourites) && favourites >= 0 ? favourites.toLocaleString() : null,
      comments: Number.isFinite(comments) && comments >= 0 ? comments : null,
      commentsDisplay: Number.isFinite(comments) && comments >= 0 ? comments.toLocaleString() : null,
      isExact: true
    };
  }

  if (obj.character) {
    const sub = inspectStatsObject(obj.character, depth + 1);
    if (sub) return sub;
  }
  if (obj.data) {
    const sub = inspectStatsObject(obj.data, depth + 1);
    if (sub) return sub;
  }

  return null;
}

/**
 * Ask the main world script (injected_main.js) for exact stats.
 */
async function requestExactStatsFromMainWorld(charId, timeoutMs = 1200) {
  const requestId = "req_" + Math.random().toString(36).slice(2, 9);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingMainWorldRequests.delete(requestId);
      resolve(null);
    }, timeoutMs);

    pendingMainWorldRequests.set(requestId, (stats) => {
      clearTimeout(timer);
      resolve(stats);
    });

    window.postMessage(
      {
        source: "JSTATS_CONTENT",
        type: "REQUEST_EXACT_STATS",
        requestId,
        characterId: charId
      },
      "*"
    );
  });
}

/**
 * Attempt to extract exact, unrounded single-digit counts for messages and chats.
 */
async function getExactStats(characterId) {
  const cleanId = cleanUuid(characterId) || cleanUuid(location.pathname);
  if (!cleanId) return null;

  // 1. Check MAIN world cache
  if (mainWorldStatsCache.has(cleanId)) {
    const cached = mainWorldStatsCache.get(cleanId);
    if (cached && Number.isFinite(cached.msgs) && Number.isFinite(cached.chats)) {
      return {
        ...cached,
        msgsDisplay: cached.msgs.toLocaleString(),
        chatsDisplay: cached.chats.toLocaleString(),
        isExact: true
      };
    }
  }

  // 2. Query MAIN world script
  try {
    const mainStats = await requestExactStatsFromMainWorld(cleanId);
    if (mainStats && Number.isFinite(mainStats.msgs) && Number.isFinite(mainStats.chats)) {
      return {
        ...mainStats,
        msgsDisplay: mainStats.msgs.toLocaleString(),
        chatsDisplay: mainStats.chats.toLocaleString(),
        isExact: true
      };
    }
  } catch (e) {
    console.debug("JStats: request to main world failed", e);
  }

  // 3. Obtain authentication token (cookies -> background -> localStorage)
  let token = parseTokenFromCookies(document.cookie);

  if (!token && typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    try {
      const bgResp = await chrome.runtime.sendMessage({ type: "GET_JANITOR_TOKEN" });
      if (bgResp?.token) token = bgResp.token;
    } catch {}
  }

  if (!token) {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.includes("auth-token") || k.includes("supabase") || k.includes("token"))) {
          token = extractTokenFromString(localStorage.getItem(k)) || token;
        }
      }
    } catch {}
  }

  // 4. Fetch directly from first-party API with token and credentials
  const headers = { Accept: "application/json, text/plain, */*" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  // Try endpoint 1: /hampter/characters/${cleanId}
  try {
    const res = await fetch(`/hampter/characters/${cleanId}`, {
      credentials: "include",
      headers
    });
    if (res.ok) {
      const json = await res.json();
      const parsed = inspectStatsObject(json);
      if (parsed) {
        console.debug("JStats: Got exact single-digit stats from /hampter/characters API:", parsed);
        return parsed;
      }
    }
  } catch (e) {
    console.debug("JStats: /hampter/characters fetch error", e);
  }

  // Try endpoint 2: /hampter/character-analytics/${cleanId}?timeRange=30d
  try {
    const res = await fetch(`/hampter/character-analytics/${cleanId}?timeRange=30d`, {
      credentials: "include",
      headers
    });
    if (res.ok) {
      const json = await res.json();
      const data = json.data || json;
      const chats = Number(data.total_chats ?? data.total_chat ?? data.chats);
      const msgs = Number(data.total_messages ?? data.total_message ?? data.messages ?? data.msgs);
      if (Number.isFinite(chats) && Number.isFinite(msgs) && (chats > 0 || msgs > 0)) {
        return {
          msgs,
          msgsDisplay: msgs.toLocaleString(),
          chats,
          chatsDisplay: chats.toLocaleString(),
          isExact: true
        };
      }
    }
  } catch (e) {
    console.debug("JStats: analytics fetch error", e);
  }

  // 5. Inspect Next.js script tags
  try {
    const scripts = document.getElementsByTagName("script");
    for (let i = 0; i < scripts.length; i++) {
      const txt = scripts[i].textContent;
      if (!txt || txt.length < 50) continue;

      if (scripts[i].id === "__NEXT_DATA__") {
        try {
          const parsed = JSON.parse(txt);
          const pageProps = parsed.props?.pageProps;
          const found = inspectStatsObject(pageProps);
          if (found) return found;
        } catch {}
      }

      if (txt.includes('"message"') && txt.includes('"chat"')) {
        const mMsg = txt.match(/"(?:total_)?messages?"\s*:\s*(\d+)/);
        const mChat = txt.match(/"(?:total_)?chats?"\s*:\s*(\d+)/);
        if (mMsg && mChat) {
          const msgs = Number(mMsg[1]);
          const chats = Number(mChat[1]);
          if (Number.isFinite(msgs) && Number.isFinite(chats) && (msgs > 0 || chats > 0)) {
            return {
              msgs,
              msgsDisplay: msgs.toLocaleString(),
              chats,
              chatsDisplay: chats.toLocaleString(),
              isExact: true
            };
          }
        }
      }
    }
  } catch (e) {}

  return null;
}

async function extractStats() {
  const charId = getCharacterId();
  const exact = await getExactStats(charId);

  const messageChat = getMessagesAndChats();
  const favourites = getFavourites();
  const comments = getComments();
  const publishedChats = getPublishedChats();
  const dates = getDateMeta();

  const isExact = exact?.isExact === true;
  const msgs = isExact ? exact.msgs : messageChat.msgs;
  const msgsDisplay = isExact ? exact.msgsDisplay : messageChat.msgsDisplay;
  const chats = isExact ? exact.chats : messageChat.chats;
  const chatsDisplay = isExact ? exact.chatsDisplay : messageChat.chatsDisplay;

  return {
    characterId: charId,
    characterName: getCharacterName(),
    url: location.href,
    msgs,
    msgsDisplay,
    chats,
    chatsDisplay,
    comments: exact?.comments ?? comments.comments,
    commentsDisplay: exact?.commentsDisplay ?? comments.commentsDisplay,
    favourites: exact?.favourites ?? favourites.favourites,
    favouritesDisplay: exact?.favouritesDisplay ?? favourites.favouritesDisplay,
    publishedChats: publishedChats.publishedChats,
    publishedChatsDisplay: publishedChats.publishedChatsDisplay,
    isExact,
    ...dates
  };
}

function statsAreComplete(stats) {
  return REQUIRED_STATS.every(key => Number.isFinite(stats[key]));
}

async function sendSnapshot(stats) {
  return chrome.runtime.sendMessage({
    type: "SAVE_SNAPSHOT",
    payload: { ...stats, timestamp: new Date().toISOString() }
  });
}

async function collectWhenReady({ attempts = 16, delayMs = 850 } = {}) {
  let zeroCommentsStreak = 0;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const stats = await extractStats();

    // If complete AND we have verified single-digit accuracy (not rounded '12k')
    if (statsAreComplete(stats) && stats.isExact) {
      if (stats.comments === 0) {
        zeroCommentsStreak += 1;
        if (zeroCommentsStreak < 2 && attempt < attempts - 1) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
      } else {
        zeroCommentsStreak = 0;
      }

      const result = await sendSnapshot(stats);
      if (result?.ok) {
        console.info("JStats: EXACT single-digit snapshot collected successfully!", stats);
      }
      return result;
    }

    // If stats are complete but still rounded (isExact: false), keep asking main world for exact stats
    if (statsAreComplete(stats) && !stats.isExact) {
      const cleanId = cleanUuid(stats.characterId);
      if (cleanId) {
        window.postMessage(
          {
            source: "JSTATS_CONTENT",
            type: "REQUEST_EXACT_STATS",
            characterId: cleanId
          },
          "*"
        );
      }
    }

    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  // Fallback after all attempts
  const fallback = await extractStats();
  if (statsAreComplete(fallback)) {
    console.warn("JStats: Exact single-digit counts could not be resolved after all retries; sending best available stats", fallback);
    return await sendSnapshot(fallback);
  }

  console.warn("JanitorAI Stats Tracker: stats never became ready", location.href, fallback);
  return { ok: false, reason: "STATS_NOT_READY" };
}

let collectionStarted = false;
let lastKnownUrl = location.href;

function scheduleCollection() {
  if (collectionStarted) return;
  collectionStarted = true;
  collectWhenReady().catch(console.error);
}

scheduleCollection();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "COLLECT_STATS") return false;
  collectWhenReady({ attempts: 12, delayMs: 750 })
    .then(sendResponse)
    .catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});

// JanitorAI is a SPA. Catch character-to-character navigation without a full reload.
setInterval(() => {
  if (location.href === lastKnownUrl) return;
  lastKnownUrl = location.href;
  if (/\/characters\//i.test(location.pathname)) {
    collectionStarted = false;
    scheduleCollection();
  }
}, 1500);
