/**
 * JStats Extension Bridge
 * Bridges the Vercel web dashboard (or localhost) with the background Chrome Extension.
 */
(() => {
  function isExtensionValid() {
    try {
      return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function safeSendMessage(message, callback) {
    if (!isExtensionValid()) return;
    try {
      chrome.runtime.sendMessage(message, (res) => {
        if (chrome.runtime?.lastError) {
          return;
        }
        if (callback) callback(res);
      });
    } catch {
      // Catch synchronous context invalidation gracefully
    }
  }

  function announceExtension() {
    if (!isExtensionValid()) return;
    try {
      window.postMessage({
        source: "JSTATS_EXTENSION",
        type: "EXTENSION_READY",
        version: chrome.runtime.getManifest()?.version || "1.3.0",
        active: true,
        timestamp: Date.now()
      }, "*");
    } catch {}
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "JSTATS_DASHBOARD") return;
    if (!isExtensionValid()) return;

    if (msg.type === "PING_EXTENSION") {
      announceExtension();
    } else if (msg.type === "TRIGGER_SCRAPE_NOW") {
      safeSendMessage({
        type: "TRIGGER_SCRAPE_NOW",
        payload: msg.payload
      }, (res) => {
        window.postMessage({
          source: "JSTATS_EXTENSION",
          type: "TRIGGER_SCRAPE_RESPONSE",
          payload: res
        }, "*");
      });
    } else if (msg.type === "GET_BOT_DETAILS") {
      safeSendMessage({
        type: "GET_BOT_DETAILS",
        payload: msg.payload
      }, (res) => {
        if (res?.ok) {
          window.postMessage({
            source: "JSTATS_EXTENSION",
            type: "BOT_DETAILS_RESOLVED",
            payload: res
          }, "*");
        }
      });
    } else if (msg.type === "UPDATE_BOT_META") {
      safeSendMessage({
        type: "UPDATE_BOT_META",
        payload: msg.payload
      }, (res) => {
        if (res) {
          window.postMessage({
            source: "JSTATS_EXTENSION",
            type: "BOT_META_UPDATED",
            payload: res
          }, "*");
        }
      });
    }
  });

  // Listen for messages pushed from background (e.g. real reviews, snapshots scraped on JanitorAI)
  try {
    if (isExtensionValid()) {
      chrome.runtime.onMessage.addListener((message) => {
        if (
          message?.type === "REVIEWS_SYNCED" ||
          message?.type === "BOT_DETAILS_RESOLVED" ||
          message?.type === "SNAPSHOT_SAVED"
        ) {
          window.postMessage({
            source: "JSTATS_EXTENSION",
            type: message.type,
            payload: message.payload
          }, "*");
        }
      });
    }
  } catch {}

  announceExtension();
  const announceTimer = setInterval(() => {
    if (!isExtensionValid()) {
      clearInterval(announceTimer);
      return;
    }
    announceExtension();
  }, 4000);
})();
