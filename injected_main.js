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

  function inspectStatsPayload(obj, depth = 0) {
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
      const charId = cleanUuid(obj.id || obj.character_id || obj.uuid || obj.characterId);
      return {
        characterId: charId,
        msgs,
        chats,
        favourites: Number.isFinite(favourites) && favourites >= 0 ? favourites : null,
        comments: Number.isFinite(comments) && comments >= 0 ? comments : null,
        characterName: obj.name || obj.character_name || null,
        isExact: true
      };
    }

    if (obj.character) {
      const sub = inspectStatsPayload(obj.character, depth + 1);
      if (sub) return sub;
    }
    if (obj.data) {
      const sub = inspectStatsPayload(obj.data, depth + 1);
      if (sub) return sub;
    }

    return null;
  }

  // 1. Monkey-patch window.fetch to intercept API payloads
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const inputUrl = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      if (
        inputUrl.includes("/characters") ||
        inputUrl.includes("/character-analytics") ||
        inputUrl.includes("/hampter/") ||
        inputUrl.includes("kim.janitorai.com")
      ) {
        const clone = response.clone();
        clone
          .json()
          .then((payload) => {
            const parsed = inspectStatsPayload(payload);
            if (parsed) {
              const urlUuid = cleanUuid(inputUrl);
              const charId = parsed.characterId || urlUuid;
              if (charId) {
                parsed.characterId = charId;
                exactStatsCache.set(charId, parsed);
                window.postMessage(
                  {
                    source: "JSTATS_MAIN",
                    type: "EXACT_STATS_CAPTURED",
                    characterId: charId,
                    stats: parsed
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

  // 2. Inspect React Fiber on the DOM
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

  // 3. In-page active fetch using page cookies and authorization
  async function inPageFetchExactStats(characterId) {
    const cleanId = cleanUuid(characterId);
    if (!cleanId) return null;

    const token = parseTokenFromCookieString(document.cookie);
    const headers = { Accept: "application/json, text/plain, */*" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    // Try 1: /hampter/characters/${cleanId}
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

    // Try 2: /hampter/character-analytics/${cleanId}?timeRange=30d
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

  // 4. Handle incoming requests from content.js
  window.addEventListener("message", async (e) => {
    if (e.source !== window || !e.data || e.data.source !== "JSTATS_CONTENT") return;

    if (e.data.type === "REQUEST_EXACT_STATS") {
      const requestId = e.data.requestId;
      const charId = cleanUuid(e.data.characterId) || cleanUuid(location.pathname);

      // Check cache first
      let stats = charId ? exactStatsCache.get(charId) : null;

      // Check React Fiber
      if (!stats) {
        stats = inspectReactFiber();
        if (stats && charId) stats.characterId = charId;
      }

      // Check In-Page Fetch
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
  });

  console.info("JStats: Main World interceptor and React Fiber extractor active.");
})();
