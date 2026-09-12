/**
 * JStats Extension Bridge
 * Bridges the Vercel web dashboard (or localhost) with the background Chrome Extension.
 */
(() => {
  function announceExtension() {
    window.postMessage({
      source: "JSTATS_EXTENSION",
      type: "EXTENSION_READY",
      version: chrome.runtime.getManifest()?.version || "1.3.0",
      active: true,
      timestamp: Date.now()
    }, "*");
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "JSTATS_DASHBOARD") return;

    if (msg.type === "PING_EXTENSION") {
      announceExtension();
    } else if (msg.type === "TRIGGER_SCRAPE_NOW") {
      chrome.runtime.sendMessage({
        type: "TRIGGER_SCRAPE_NOW",
        payload: msg.payload
      }, (res) => {
        window.postMessage({
          source: "JSTATS_EXTENSION",
          type: "TRIGGER_SCRAPE_RESPONSE",
          payload: res
        }, "*");
      });
    }
  });

  announceExtension();
  setInterval(announceExtension, 4000);
})();
