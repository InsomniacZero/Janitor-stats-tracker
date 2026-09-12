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
    msgs: parseStat(values[0]),
    msgsDisplay: values[0] ?? null,
    chats: parseStat(values[1]),
    chatsDisplay: values[1] ?? null
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

function extractStats() {
  const messageChat = getMessagesAndChats();
  const favourites = getFavourites();
  const comments = getComments();
  const publishedChats = getPublishedChats();
  const dates = getDateMeta();

  return {
    characterId: getCharacterId(),
    characterName: getCharacterName(),
    url: location.href,
    ...messageChat,
    comments: comments.comments,
    commentsDisplay: comments.commentsDisplay,
    favourites: favourites.favourites,
    favouritesDisplay: favourites.favouritesDisplay,
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
    const stats = extractStats();
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

  console.warn("JanitorAI Stats Tracker: stats never became ready", location.href, extractStats());
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
