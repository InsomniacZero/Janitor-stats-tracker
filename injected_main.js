/**
 * JStats - Main World Injected Script
 * Runs in the page's execution context ("world": "MAIN") at document_start.
 *
 * Capabilities:
 * 1. Monkey-patches window.fetch to intercept raw API responses (/hampter/characters/*, etc.)
 *    giving 100% exact, unrounded single-digit counts before React rounds them for UI display.
 * 2. Directly inspects the React Fiber component tree on the DOM for raw numeric props/state.
 * 3. Executes in-page authenticated fetches sharing the active page session and Cloudflare clearance.
 * 4. Communicates bidirectional exact stats to content.js via window.postMessage.
 */

(function () {
  "use strict";

  if (window.__JSTATS_MAIN_LOADED__) return;
  window.__JSTATS_MAIN_LOADED__ = true;

  const exactStatsCache = new Map(); // cleanId -> stats object
  const exactReviewsCache = new Map(); // cleanId -> array of real review objects

  function cleanUuid(val) {
    if (!val) return null;
    const m = String(val).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return m ? m[0].toLowerCase() : null;
  }

  function parseTokenFromCookieString(str) {
    if (!str) return null;
    try {
      const parts = {};
      const cookies = str.split(";");
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
        let raw = joined;
        try { raw = decodeURIComponent(raw); } catch {}
        if (raw.startsWith("base64-")) raw = raw.slice(7);
        if (raw.startsWith("ey") && raw.split(".").length === 3) return raw;

        try {
          const parsed = JSON.parse(raw);
          const tok = parsed?.access_token || parsed?.accessToken || (Array.isArray(parsed) && parsed[0]?.access_token);
          if (tok && typeof tok === "string" && tok.startsWith("ey")) return tok;
        } catch {}

        try {
          let pad = raw.replace(/-/g, "+").replace(/_/g, "/");
          while (pad.length % 4) pad += "=";
          const decoded = atob(pad);
          if (decoded.startsWith("ey") && decoded.split(".").length === 3) return decoded;
          const parsed = JSON.parse(decoded);
          const tok = parsed?.access_token || parsed?.accessToken || (Array.isArray(parsed) && parsed[0]?.access_token);
          if (tok && typeof tok === "string" && tok.startsWith("ey")) return tok;
        } catch {}

        const m = raw.match(/(eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})/);
        if (m) return m[1];
      }
    } catch {}
    return null;
  }

  /**
   * Recursively extracts real user reviews from network payloads.
   * Never fabricates reviews - only extracts authentic user comments.
   */
  function extractAllReviews(obj, depth = 0, results = [], seen = new Set()) {
    if (!obj || depth > 5) return results;

    if (Array.isArray(obj)) {
      for (const item of obj) extractAllReviews(item, depth + 1, results, seen);
      return results;
    }

    if (typeof obj !== "object") return results;

    const text = obj.text || obj.comment || obj.content || obj.body || obj.review;
    const author =
      obj.author ||
      obj.author_name ||
      obj.user?.name ||
      obj.user?.username ||
      obj.creator_name ||
      obj.username ||
      (typeof obj.user === "string" ? obj.user : null);

    const rawId = obj.id || obj.review_id || obj._id || (author && text ? `${author}_${text.slice(0, 16)}` : null);
    const reviewId = rawId ? String(rawId).replace(/[^a-zA-Z0-9_-]/g, "") : null;

    if (
      text &&
      typeof text === "string" &&
      text.trim().length > 1 &&
      author &&
      reviewId &&
      !seen.has(reviewId)
    ) {
      seen.add(reviewId);
      const likes = Number(obj.likes ?? obj.like_count ?? obj.upvotes ?? obj.reactions?.like ?? 0) || 0;
      const time = obj.created_at || obj.createdAt || obj.date || "";
      results.push({
        id: reviewId,
        author: String(author).trim().replace(/^@/, ""),
        time: String(time).trim(),
        likes,
        text: String(text).trim()
      });
    }

    for (const k of Object.keys(obj)) {
      if (typeof obj[k] === "object" && obj[k] !== null && k !== "stats") {
        extractAllReviews(obj[k], depth + 1, results, seen);
      }
    }

    return results;
  }

  /**
   * Recursively extracts all character data objects from any payload (arrays, feeds, nested objects).
   * Returns an array of character objects with exact unrounded single-digit counts.
   */
  function extractAllCharacters(obj, depth = 0, results = [], seen = new Set()) {
    if (!obj || depth > 6) return results;

    if (Array.isArray(obj)) {
      for (const item of obj) {
        extractAllCharacters(item, depth + 1, results, seen);
      }
      return results;
    }

    if (typeof obj !== "object") return results;

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
    const favourites = Number(favsRaw);
    const comments = Number(commsRaw);

    const hasMsgs = Number.isFinite(msgs) && msgs >= 0;
    const hasChats = Number.isFinite(chats) && chats >= 0;

    const rawId = obj.id || obj.character_id || obj.uuid || obj.characterId || obj.bot_id;
    const hasNameOrStats = Boolean(obj.name || obj.character_name || obj.stats || obj.avatar || obj.creator);
    if (charId && hasMsgs && hasChats && (msgs > 0 || chats > 0 || hasNameOrStats) && !seen.has(charId)) {
      seen.add(charId);
      results.push({
        characterId: charId,
        msgs,
        msgsDisplay: msgs.toLocaleString(),
        chats,
        chatsDisplay: chats.toLocaleString(),
        favourites: Number.isFinite(favourites) && favourites >= 0 ? favourites : null,
        favouritesDisplay: Number.isFinite(favourites) && favourites >= 0 ? favourites.toLocaleString() : null,
        comments: Number.isFinite(comments) && comments >= 0 ? comments : null,
        commentsDisplay: Number.isFinite(comments) && comments >= 0 ? comments.toLocaleString() : null,
        characterName: obj.name || obj.character_name || null,
        avatar: obj.avatar || obj.image || obj.avatar_url || obj.avatarUrl || null,
        creator:
          obj.creator_name ||
          obj.creator?.name ||
          obj.creator?.username ||
          obj.creator_username ||
          (typeof obj.creator === "string" ? obj.creator : null) ||
          obj.user?.name ||
          obj.user?.username ||
          obj.author_name ||
          null,
        createdAt: obj.created_at || obj.createdAt || null,
        updatedAt: obj.updated_at || obj.updatedAt || null,
        publishedAt: obj.published_at || obj.publishedAt || null,
        isExact: true
      });
    }

    // Traverse child properties (data, characters, results, items, etc.)
    for (const k of Object.keys(obj)) {
      if (typeof obj[k] === "object" && obj[k] !== null && k !== "stats") {
        extractAllCharacters(obj[k], depth + 1, results, seen);
      }
    }

    return results;
  }

  function inspectStatsPayload(obj) {
    const chars = extractAllCharacters(obj);
    return chars.length > 0 ? chars[0] : null;
  }

  function cacheAndBroadcastCharacters(characters, originUrl = "") {
    if (!characters || !characters.length) return;

    for (const c of characters) {
      if (c.characterId) {
        exactStatsCache.set(c.characterId, c);
      }
    }

    window.postMessage(
      {
        source: "JSTATS_MAIN",
        type: "EXACT_STATS_CAPTURED_BATCH",
        characters,
        originUrl
      },
      "*"
    );

    // If single character or URL contains UUID, also send single message
    const urlUuid = cleanUuid(originUrl);
    const target = (urlUuid && characters.find(c => c.characterId === urlUuid)) || (characters.length === 1 ? characters[0] : null);
    if (target) {
      window.postMessage(
        {
          source: "JSTATS_MAIN",
          type: "EXACT_STATS_CAPTURED",
          characterId: target.characterId,
          stats: target
        },
        "*"
      );
    }
  }

  // 1. Monkey-patch window.fetch to intercept raw API payloads (direct & feed)
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const inputUrl = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      if (
        inputUrl.includes("/characters") ||
        inputUrl.includes("/character-analytics") ||
        inputUrl.includes("/hampter/") ||
        inputUrl.includes("following") ||
        inputUrl.includes("/feed") ||
        inputUrl.includes("kim.janitorai.com") ||
        inputUrl.includes("/api/")
      ) {
        const clone = response.clone();
        clone
          .json()
          .then((payload) => {
            const found = extractAllCharacters(payload);
            if (found.length > 0) {
              cacheAndBroadcastCharacters(found, inputUrl);
            }

            // Also check for reviews in the response
            if (inputUrl.includes("review") || inputUrl.includes("comment")) {
              const reviews = extractAllReviews(payload);
              const cid = cleanUuid(inputUrl) || cleanUuid(location.pathname);
              if (reviews.length > 0 && cid) {
                exactReviewsCache.set(cid, reviews);
                window.postMessage(
                  {
                    source: "JSTATS_MAIN",
                    type: "REVIEWS_CAPTURED",
                    characterId: cid,
                    reviews
                  },
                  "*"
                );
              }
            }
          })
          .catch(() => {});
      }
    } catch {}
    return response;
  };

  // 2. Monkey-patch XMLHttpRequest to intercept any XHR payloads
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__jstatsUrl = typeof url === "string" ? url : "";
    return originalOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      try {
        const url = this.__jstatsUrl || "";
        if (
          url.includes("/characters") ||
          url.includes("/hampter/") ||
          url.includes("following") ||
          url.includes("/feed") ||
          url.includes("review") ||
          url.includes("comment")
        ) {
          let payload = null;
          if (this.responseType === "json" && this.response) {
            payload = this.response;
          } else if (typeof this.responseText === "string" && this.responseText.trim().startsWith("{")) {
            payload = JSON.parse(this.responseText);
          }
          if (payload) {
            const found = extractAllCharacters(payload);
            if (found.length > 0) {
              cacheAndBroadcastCharacters(found, url);
            }

            if (url.includes("review") || url.includes("comment")) {
              const reviews = extractAllReviews(payload);
              const cid = cleanUuid(url) || cleanUuid(location.pathname);
              if (reviews.length > 0 && cid) {
                exactReviewsCache.set(cid, reviews);
                window.postMessage(
                  {
                    source: "JSTATS_MAIN",
                    type: "REVIEWS_CAPTURED",
                    characterId: cid,
                    reviews
                  },
                  "*"
                );
              }
            }
          }
        }
      } catch {}
    });
    return originalSend.apply(this, args);
  };

  // 3. Inspect React Fiber on the DOM for character cards (Following feed, trending, search)
  function scanCardsInMainWorld() {
    const found = [];
    try {
      const cardLinks = document.querySelectorAll('a[href*="/characters/"]');
      for (const a of cardLinks) {
        const href = a.getAttribute("href") || "";
        const charId = cleanUuid(href);
        if (!charId) continue;

        let charStats = exactStatsCache.get(charId);
        if (charStats) {
          found.push(charStats);
          continue;
        }

        // Check React Fiber on anchor and surrounding parent/child nodes
        const elementsToTest = [
          a,
          a.parentElement,
          a.parentElement?.parentElement,
          a.parentElement?.parentElement?.parentElement,
          a.firstElementChild
        ].filter(Boolean);

        for (const el of elementsToTest) {
          const fiberKey = Object.keys(el).find((k) =>
            k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
          );
          if (!fiberKey) continue;

          let curr = el[fiberKey];
          let depth = 0;
          while (curr && depth < 25) {
            if (curr.memoizedProps) {
              const chars = extractAllCharacters(curr.memoizedProps);
              const match = chars.find((c) => c.characterId === charId) || chars[0];
              if (match) {
                match.characterId = charId;
                exactStatsCache.set(charId, match);
                found.push(match);
                break;
              }
            }
            if (curr.memoizedState) {
              const chars = extractAllCharacters(curr.memoizedState);
              const match = chars.find((c) => c.characterId === charId) || chars[0];
              if (match) {
                match.characterId = charId;
                exactStatsCache.set(charId, match);
                found.push(match);
                break;
              }
            }
            curr = curr.return;
            depth++;
          }
          if (exactStatsCache.has(charId)) break;
        }
      }
    } catch (err) {
      console.debug("JStats: error scanning cards in main world", err);
    }

    if (found.length > 0) {
      cacheAndBroadcastCharacters(found, location.href);
    }

    return found;
  }

  // 4. Inspect React Fiber on the full DOM for single character view
  function inspectReactFiber() {
    try {
      const candidates = [
        document.querySelector(".character-chat-messages-stat-ribbon-tag-hstack"),
        document.querySelector("h2.chakra-heading"),
        document.querySelector("main"),
        document.querySelector("#__next"),
        document.querySelector("#root")
      ].filter(Boolean);

      for (const el of candidates) {
        const fiberKey = Object.keys(el).find((k) =>
          k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
        );
        if (!fiberKey) continue;

        let curr = el[fiberKey];
        let depth = 0;
        while (curr && depth < 35) {
          if (curr.memoizedProps) {
            const found = inspectStatsPayload(curr.memoizedProps);
            if (found && found.msgs > 0) return found;
          }
          if (curr.memoizedState) {
            const found = inspectStatsPayload(curr.memoizedState);
            if (found && found.msgs > 0) return found;
          }
          curr = curr.return;
          depth++;
        }
      }
    } catch {}
    return null;
  }

  // 5. In-page active fetch using page cookies and authorization
  async function inPageFetchExactStats(characterId) {
    const cleanId = cleanUuid(characterId);
    if (!cleanId) return null;

    const token = parseTokenFromCookieString(document.cookie);
    const headers = { Accept: "application/json, text/plain, */*" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    // Try 1: Following feed endpoint directly (/hampter/characters?segment=following)
    try {
      const res = await originalFetch(`/hampter/characters?segment=following`, {
        credentials: "include",
        headers
      });
      if (res.ok) {
        const json = await res.json();
        const chars = extractAllCharacters(json);
        if (chars.length > 0) {
          cacheAndBroadcastCharacters(chars, "/hampter/characters?segment=following");
          const match = chars.find((c) => c.characterId === cleanId);
          if (match) return match;
        }
      }
    } catch {}

    // Try 2: /hampter/characters/${cleanId}
    try {
      const res = await originalFetch(`/hampter/characters/${cleanId}`, {
        credentials: "include",
        headers
      });
      if (res.ok) {
        const json = await res.json();
        const found = inspectStatsPayload(json);
        if (found) {
          found.characterId = cleanId;
          exactStatsCache.set(cleanId, found);
          return found;
        }
      }
    } catch {}

    // Try 3: /hampter/character-analytics/${cleanId}?timeRange=30d
    try {
      const res = await originalFetch(`/hampter/character-analytics/${cleanId}?timeRange=30d`, {
        credentials: "include",
        headers
      });
      if (res.ok) {
        const json = await res.json();
        const data = json.data || json;
        const chats = Number(data.total_chats ?? data.total_chat ?? data.chats);
        const msgs = Number(data.total_messages ?? data.total_message ?? data.messages ?? data.msgs);
        if (Number.isFinite(chats) && Number.isFinite(msgs) && (chats > 0 || msgs > 0)) {
          const stats = { characterId: cleanId, chats, msgs, isExact: true };
          exactStatsCache.set(cleanId, stats);
          return stats;
        }
      }
    } catch {}

    return null;
  }

  // 6. Active fetch of Following Feed in page context
  async function inPageFetchFollowingFeed() {
    const token = parseTokenFromCookieString(document.cookie);
    const headers = { Accept: "application/json, text/plain, */*" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const endpoints = [
      "/hampter/characters?segment=following",
      "/hampter/following/characters",
      "/hampter/characters?mode=following"
    ];

    for (const ep of endpoints) {
      try {
        const res = await originalFetch(ep, { credentials: "include", headers });
        if (res.ok) {
          const json = await res.json();
          const chars = extractAllCharacters(json);
          if (chars.length > 0) {
            cacheAndBroadcastCharacters(chars, ep);
            return chars;
          }
        }
      } catch {}
    }
    return [];
  }

  // 7. Handle incoming requests from content.js
  window.addEventListener("message", async (e) => {
    if (e.source !== window || !e.data || e.data.source !== "JSTATS_CONTENT") return;

    if (e.data.type === "REQUEST_EXACT_STATS") {
      const requestId = e.data.requestId;
      const charId = cleanUuid(e.data.characterId) || cleanUuid(location.pathname);

      // 1. Check cache first
      let stats = charId ? exactStatsCache.get(charId) : null;

      // 2. Check React Fiber cards on the page (e.g. Following tab cards)
      if (!stats) {
        scanCardsInMainWorld();
        stats = charId ? exactStatsCache.get(charId) : null;
      }

      // 3. Check React Fiber full DOM (single character page)
      if (!stats) {
        stats = inspectReactFiber();
        if (stats && charId) stats.characterId = charId;
      }

      // 4. In-page fetch
      if (!stats && charId) {
        stats = await inPageFetchExactStats(charId);
      }

      window.postMessage(
        {
          source: "JSTATS_MAIN",
          type: "EXACT_STATS_RESPONSE",
          requestId,
          characterId: charId,
          stats: stats || null
        },
        "*"
      );
    }

    if (e.data.type === "REQUEST_FEED_CARDS") {
      const cards = scanCardsInMainWorld();
      if (!cards.length) {
        await inPageFetchFollowingFeed();
      }
      window.postMessage(
        {
          source: "JSTATS_MAIN",
          type: "FEED_CARDS_RESPONSE",
          requestId: e.data.requestId,
          characters: Array.from(exactStatsCache.values())
        },
        "*"
      );
    }

    if (e.data.type === "REQUEST_REVIEWS") {
      const charId = cleanUuid(e.data.characterId) || cleanUuid(location.pathname);
      let reviews = charId ? exactReviewsCache.get(charId) || [] : [];
      if (!reviews.length && charId) {
        reviews = await inPageFetchReviews(charId);
      }
      window.postMessage(
        {
          source: "JSTATS_MAIN",
          type: "REVIEWS_RESPONSE",
          requestId: e.data.requestId,
          characterId: charId,
          reviews: reviews || []
        },
        "*"
      );
    }
  });

  // 8. In-page active fetch for character reviews
  async function inPageFetchReviews(characterId) {
    const cleanId = cleanUuid(characterId);
    if (!cleanId) return [];

    const cached = exactReviewsCache.get(cleanId);
    if (cached && cached.length > 0) return cached;

    const token = parseTokenFromCookieString(document.cookie);
    const headers = { Accept: "application/json, text/plain, */*" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const endpoints = [
      `/hampter/characters/${cleanId}/reviews`,
      `/hampter/reviews?character_id=${cleanId}`,
      `/api/characters/${cleanId}/reviews`
    ];

    for (const ep of endpoints) {
      try {
        const res = await originalFetch(ep, { credentials: "include", headers });
        if (res.ok) {
          const json = await res.json();
          const reviews = extractAllReviews(json);
          if (reviews.length > 0) {
            exactReviewsCache.set(cleanId, reviews);
            window.postMessage(
              {
                source: "JSTATS_MAIN",
                type: "REVIEWS_CAPTURED",
                characterId: cleanId,
                reviews
              },
              "*"
            );
            return reviews;
          }
        }
      } catch {}
    }
    return [];
  }

  // 8. Auto-scan DOM for cards on initial load, mutations, and periodic intervals
  setTimeout(scanCardsInMainWorld, 750);
  setTimeout(scanCardsInMainWorld, 2000);
  setTimeout(scanCardsInMainWorld, 4500);

  try {
    let debounceTimer = null;
    const observer = new MutationObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(scanCardsInMainWorld, 350);
    });
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });
  } catch {}

  // Periodic card scan (every 6s) if character cards are present
  setInterval(() => {
    if (document.querySelector('a[href*="/characters/"]')) {
      scanCardsInMainWorld();
    }
  }, 6000);

  console.info("JStats: Main World interceptor, Following feed extractor, and React Fiber card scanner active.");
})();
