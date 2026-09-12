const REQUIRED_STATS = ["msgs", "chats", "comments", "favourites"];
const OPTIONAL_STATS = ["publishedChats"];

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
  return match?.[1] || location.pathname;
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

/**
 * Attempt to extract exact, unrounded single-digit counts for messages and chats
 * using all available client-side sources on JanitorAI:
 * 1. First-party internal API fetch with session token from localStorage
 * 2. Next.js embedded data scripts (__NEXT_DATA__ or React Server Components)
 * 3. Element attributes (title, aria-label, data-tooltip) on the stats ribbon
 */
async function getExactStats(characterId) {
  // 1. First-party API fetch from inside the page
  try {
    let token = null;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.includes("auth-token") || k.includes("supabase") || k.includes("token"))) {
          const raw = localStorage.getItem(k);
          const parsed = JSON.parse(raw);
          token = parsed?.access_token || parsed?.currentSession?.access_token || (Array.isArray(parsed) && parsed[0]?.access_token) || token;
        }
      }
    } catch {}

    const headers = { Accept: "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(`/hampter/characters/${characterId}`, {
      credentials: "include",
      headers
    });

    if (res.ok) {
      const json = await res.json();
      const raw = json.data?.character || json.data || json.character || json;
      if (raw) {
        const msgs = Number(
          raw.stats?.message ?? raw.stats?.messages ?? raw.stats?.msgs ??
          raw.total_message ?? raw.message ?? raw.msgs
        );
        const chats = Number(
          raw.stats?.chat ?? raw.stats?.chats ?? raw.chats ?? raw.chat ?? raw.chat_count
        );
        const favourites = Number(
          raw.stats?.favorite ?? raw.stats?.favourite ?? raw.stats?.favorites ?? raw.stats?.favourites ??
          raw.favourites ?? raw.favorites ?? raw.favorite
        );
        const comments = Number(
          raw.stats?.comment ?? raw.stats?.comments ?? raw.comments ?? raw.comment
        );

        if (Number.isFinite(msgs) && Number.isFinite(chats) && (msgs > 0 || chats > 0)) {
          console.debug("JStats: Got exact single-digit stats from /hampter/ API:", { msgs, chats, favourites, comments });
          return {
            msgs,
            msgsDisplay: msgs.toLocaleString(),
            chats,
            chatsDisplay: chats.toLocaleString(),
            favourites: Number.isFinite(favourites) && favourites > 0 ? favourites : null,
            favouritesDisplay: Number.isFinite(favourites) && favourites > 0 ? favourites.toLocaleString() : null,
            comments: Number.isFinite(comments) && comments >= 0 ? comments : null,
            commentsDisplay: Number.isFinite(comments) && comments >= 0 ? comments.toLocaleString() : null
          };
        }
      }
    }
  } catch (e) {
    console.debug("JStats: /hampter/ fetch inside content script failed", e);
  }

  // 2. Next.js script tags (__NEXT_DATA__ or RSC hydration chunks)
  try {
    const scripts = document.getElementsByTagName("script");
    for (let i = 0; i < scripts.length; i++) {
      const txt = scripts[i].textContent;
      if (!txt || txt.length < 50) continue;

      if (scripts[i].id === "__NEXT_DATA__") {
        try {
          const parsed = JSON.parse(txt);
          const pageProps = parsed.props?.pageProps;
          const char = pageProps?.character || pageProps?.initialData?.character || pageProps?.data?.character;
          if (char?.stats) {
            const msgs = Number(char.stats.message ?? char.stats.messages ?? char.total_message);
            const chats = Number(char.stats.chat ?? char.stats.chats ?? char.total_chat);
            if (Number.isFinite(msgs) && Number.isFinite(chats) && (msgs > 0 || chats > 0)) {
              return {
                msgs,
                msgsDisplay: msgs.toLocaleString(),
                chats,
                chatsDisplay: chats.toLocaleString()
              };
            }
          }
        } catch {}
      }

      if (txt.includes('"message"') && txt.includes('"chat"')) {
        const match = txt.match(/"stats":\s*\{([^}]+)\}/);
        if (match) {
          const statsStr = match[1];
          const mMsg = statsStr.match(/"message(?:s)?"\s*:\s*(\d+)/);
          const mChat = statsStr.match(/"chat(?:s)?"\s*:\s*(\d+)/);
          if (mMsg && mChat) {
            const msgs = Number(mMsg[1]);
            const chats = Number(mChat[1]);
            if (Number.isFinite(msgs) && Number.isFinite(chats) && (msgs > 0 || chats > 0)) {
              return {
                msgs,
                msgsDisplay: msgs.toLocaleString(),
                chats,
                chatsDisplay: chats.toLocaleString()
              };
            }
          }
        }
      }
    }
  } catch (e) {
    console.debug("JStats: script tag inspection failed", e);
  }

  // 3. DOM attributes & Tooltips on ribbon elements
  try {
    const ribbon = document.querySelector(".character-chat-messages-stat-ribbon-tag-hstack");
    if (ribbon) {
      const candidates = [ribbon, ...ribbon.querySelectorAll("*")];
      let exactMsgs = null;
      let exactChats = null;

      for (const el of candidates) {
        for (const attr of ["title", "aria-label", "data-tooltip", "data-label", "data-original-title"]) {
          const val = el.getAttribute(attr);
          if (!val) continue;
          const cleanNum = val.replace(/,/g, "").trim();
          const m = cleanNum.match(/(\d{4,12})/);
          if (m) {
            const n = Number(m[1]);
            const lower = val.toLowerCase();
            if (lower.includes("msg") || lower.includes("message")) {
              exactMsgs = n;
            } else if (lower.includes("chat")) {
              exactChats = n;
            }
          }
        }
      }

      if (Number.isFinite(exactMsgs) && Number.isFinite(exactChats)) {
        return {
          msgs: exactMsgs,
          msgsDisplay: exactMsgs.toLocaleString(),
          chats: exactChats,
          chatsDisplay: exactChats.toLocaleString()
        };
      }

      // Simulate mouseenter on ribbon to trigger Chakra tooltip if present
      for (const p of ribbon.querySelectorAll("p")) {
        p.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      }
      await new Promise(r => setTimeout(r, 60));
      const tooltips = document.querySelectorAll('[role="tooltip"], .chakra-tooltip');
      for (const tip of tooltips) {
        const tipText = tip.textContent || "";
        const m = tipText.replace(/,/g, "").match(/(\d{4,12})/);
        if (m) {
          const n = Number(m[1]);
          const lower = tipText.toLowerCase();
          if (lower.includes("msg") || lower.includes("message")) exactMsgs = n;
          else if (lower.includes("chat")) exactChats = n;
        }
      }

      if (Number.isFinite(exactMsgs) && Number.isFinite(exactChats)) {
        return {
          msgs: exactMsgs,
          msgsDisplay: exactMsgs.toLocaleString(),
          chats: exactChats,
          chatsDisplay: exactChats.toLocaleString()
        };
      }
    }
  } catch (e) {
    console.debug("JStats: DOM attribute inspection failed", e);
  }

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

  const msgs = exact?.msgs ?? messageChat.msgs;
  const msgsDisplay = exact?.msgsDisplay ?? messageChat.msgsDisplay;
  const chats = exact?.chats ?? messageChat.chats;
  const chatsDisplay = exact?.chatsDisplay ?? messageChat.chatsDisplay;

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
    ...dates
  };
}

function statsAreComplete(stats) {
  return REQUIRED_STATS.every(key => Number.isFinite(stats[key]));
}

async function sendSnapshot(stats) {
  return chrome.runtime.sendMessage({ type: "SAVE_SNAPSHOT", payload: { ...stats, timestamp: new Date().toISOString() } });
}

async function collectWhenReady({ attempts = 14, delayMs = 900 } = {}) {
  let zeroCommentsStreak = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const stats = await extractStats();
    if (statsAreComplete(stats)) {
      // JanitorAI briefly renders comments as 0 during page hydration on reload.
      // Require two consecutive zero reads before accepting a real zero.
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
      if (result?.ok) console.debug("JanitorAI Stats Tracker: snapshot collected", stats);
      return result;
    }
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  const fallback = await extractStats();
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
  collectWhenReady({ attempts: 10, delayMs: 850 })
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
