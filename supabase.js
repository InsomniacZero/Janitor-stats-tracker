/**
 * JStats — Supabase Client Layer
 * Native, zero-dependency REST & Realtime interface for Supabase PostgreSQL.
 * Fully compatible with Vercel Web, Vite, and Chrome MV3 Extension environments.
 */

export const DEFAULT_SUPABASE_URL = "https://vclvynlyfylnjcjvyrfy.supabase.co";
export const DEFAULT_SUPABASE_ANON_KEY = "sb_publishable_zQ5xfP0Ok8sV6tCVAqLQbQ_EWpAOs7G";

function cleanUrl(raw) {
  return (raw || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/rest\/v1\/?$/, "");
}

export async function getSupabaseConfig() {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      const res = await chrome.storage.local.get(["supabaseUrl", "supabaseAnonKey"]);
      if (res.supabaseUrl && res.supabaseAnonKey) {
        return {
          url: cleanUrl(res.supabaseUrl),
          anonKey: res.supabaseAnonKey.trim()
        };
      }
    }
  } catch {
    // Fall back to localStorage
  }

  try {
    if (typeof localStorage !== "undefined") {
      const url = localStorage.getItem("jstats_supabase_url");
      const anonKey = localStorage.getItem("jstats_supabase_anon_key");
      if (url && anonKey) {
        return {
          url: cleanUrl(url),
          anonKey: anonKey.trim()
        };
      }
    }
  } catch {
    // Storage access unavailable
  }

  // Pre-configured default project
  if (DEFAULT_SUPABASE_URL && DEFAULT_SUPABASE_ANON_KEY) {
    return {
      url: cleanUrl(DEFAULT_SUPABASE_URL),
      anonKey: DEFAULT_SUPABASE_ANON_KEY.trim()
    };
  }

  return null;
}

export async function setSupabaseConfig(url, anonKey) {
  const normalizedUrl = cleanUrl(url);
  const cleanKey = (anonKey || "").trim();

  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      await chrome.storage.local.set({ supabaseUrl: normalizedUrl, supabaseAnonKey: cleanKey });
    }
  } catch {
    // Non-extension context
  }

  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("jstats_supabase_url", normalizedUrl);
      localStorage.setItem("jstats_supabase_anon_key", cleanKey);
    }
  } catch {
    // LocalStorage unavailable
  }
}

export async function clearSupabaseConfig() {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      await chrome.storage.local.remove(["supabaseUrl", "supabaseAnonKey"]);
    }
  } catch {}

  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem("jstats_supabase_url");
      localStorage.removeItem("jstats_supabase_anon_key");
    }
  } catch {}
}

/**
 * Validates connection to the user's Supabase project.
 */
export async function testSupabaseConnection(url, anonKey) {
  const cleanUrl = (url || "").trim().replace(/\/+$/, "");
  const cleanKey = (anonKey || "").trim();

  if (!cleanUrl || !cleanKey) {
    return { ok: false, error: "Missing Supabase URL or Anon Key." };
  }

  try {
    const res = await fetch(`${cleanUrl}/rest/v1/tracked_jobs?select=character_id&limit=1`, {
      method: "GET",
      headers: {
        apikey: cleanKey,
        Authorization: `Bearer ${cleanKey}`,
        Accept: "application/json"
      }
    });

    if (res.ok) {
      return { ok: true };
    }

    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Invalid Anon Key or Unauthorized." };
    }

    if (res.status === 404) {
      return { ok: false, error: "Table 'tracked_jobs' not found. Please run schema.sql first." };
    }

    return { ok: false, error: `HTTP ${res.status}: ${res.statusText}` };
  } catch (err) {
    return { ok: false, error: `Connection failed: ${err.message || String(err)}` };
  }
}

/**
 * Fetch all tracked character jobs from Supabase.
 */
export async function fetchTrackedJobs() {
  const config = await getSupabaseConfig();
  if (!config) return [];

  try {
    const res = await fetch(`${config.url}/rest/v1/tracked_jobs?select=*&order=started_at.desc`, {
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${config.anonKey}`,
        Accept: "application/json"
      }
    });

    if (!res.ok) return [];
    const jobs = await res.json();
    if (Array.isArray(jobs)) {
      for (const job of jobs) {
        if (job.url && job.url.includes("#meta=")) {
          try {
            const rawMeta = job.url.slice(job.url.indexOf("#meta=") + 6);
            const parsedMeta = JSON.parse(decodeURIComponent(rawMeta));
            if (parsedMeta.avatar && !job.avatar) job.avatar = parsedMeta.avatar;
            if (parsedMeta.creator && !job.creator) job.creator = parsedMeta.creator;
          } catch {}
        }
      }
    }
    return jobs;
  } catch (err) {
    console.warn("JStats: failed to fetch tracked jobs from Supabase", err);
    return [];
  }
}

/**
 * Creates or updates a 72-hour tracking job in Supabase.
 */
export async function saveTrackedJob(job) {
  const config = await getSupabaseConfig();
  if (!config) return false;

  let url = job.url || `https://janitorai.com/characters/${job.character_id}`;
  const baseUrl = url.split("#")[0];

  // Preserve or extract existing metadata
  let existingMeta = {};
  if (url.includes("#meta=")) {
    try {
      existingMeta = JSON.parse(decodeURIComponent(url.slice(url.indexOf("#meta=") + 6)));
    } catch {}
  }

  const avatar = job.avatar || existingMeta.avatar || null;
  const creator = job.creator || existingMeta.creator || null;

  const metaObj = { ...existingMeta };
  if (avatar) metaObj.avatar = avatar;
  if (creator) metaObj.creator = creator;

  const fullUrl = Object.keys(metaObj).length > 0
    ? `${baseUrl}#meta=${encodeURIComponent(JSON.stringify(metaObj))}`
    : baseUrl;

  const payload = {
    character_id: job.character_id,
    character_name: job.character_name || "JanitorAI Character",
    url: fullUrl,
    started_at: job.started_at || new Date().toISOString(),
    expires_at: job.expires_at || new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
    status: job.status || "active",
    last_scraped_at: job.last_scraped_at || new Date().toISOString()
  };

  try {
    const res = await fetch(`${config.url}/rest/v1/tracked_jobs`, {
      method: "POST",
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${config.anonKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=representation"
      },
      body: JSON.stringify(payload)
    });

    return res.ok;
  } catch (err) {
    console.error("JStats: failed to save tracked job to Supabase", err);
    return false;
  }
}

/**
 * Updates metadata (avatar, creator) for a tracked character in Supabase.
 */
export async function updateTrackedJobMetadata(characterId, { avatar, creator }) {
  const config = await getSupabaseConfig();
  if (!config || !characterId) return false;

  try {
    const fetchRes = await fetch(`${config.url}/rest/v1/tracked_jobs?character_id=eq.${encodeURIComponent(characterId)}&limit=1`, {
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${config.anonKey}`,
        Accept: "application/json"
      }
    });

    if (!fetchRes.ok) return false;
    const items = await fetchRes.json();
    const currentJob = items?.[0];
    if (!currentJob) return false;

    let baseUrl = (currentJob.url || `https://janitorai.com/characters/${characterId}`).split("#")[0];
    let metaObj = {};
    if (currentJob.url && currentJob.url.includes("#meta=")) {
      try {
        metaObj = JSON.parse(decodeURIComponent(currentJob.url.slice(currentJob.url.indexOf("#meta=") + 6)));
      } catch {}
    }

    if (avatar !== undefined && avatar !== null) metaObj.avatar = avatar;
    if (creator !== undefined && creator !== null) metaObj.creator = creator;

    const newUrl = Object.keys(metaObj).length > 0
      ? `${baseUrl}#meta=${encodeURIComponent(JSON.stringify(metaObj))}`
      : baseUrl;

    const patchRes = await fetch(`${config.url}/rest/v1/tracked_jobs?character_id=eq.${encodeURIComponent(characterId)}`, {
      method: "PATCH",
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${config.anonKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify({ url: newUrl })
    });

    return patchRes.ok;
  } catch (err) {
    console.error("JStats: failed to update job metadata in Supabase", err);
    return false;
  }
}

/**
 * Inserts a single minute snapshot for a tracked character into Supabase.
 */
export async function insertSnapshot(characterId, snapshot) {
  const config = await getSupabaseConfig();
  if (!config) return false;

  let comments = Number(snapshot.comments);
  let favourites = Number(snapshot.favourites);
  let publishedChats = Number(snapshot.publishedChats);

  // If any optional stat is missing or <= 0, query the latest record in Supabase to inherit
  if (
    (!Number.isFinite(comments) || comments <= 0) ||
    (!Number.isFinite(favourites) || favourites <= 0) ||
    (!Number.isFinite(publishedChats) || publishedChats <= 0)
  ) {
    try {
      const q = `${config.url}/rest/v1/character_snapshots?character_id=eq.${encodeURIComponent(characterId)}&order=timestamp.desc&limit=1`;
      const res = await fetch(q, {
        headers: {
          apikey: config.anonKey,
          Authorization: `Bearer ${config.anonKey}`,
          Accept: "application/json"
        }
      });
      if (res.ok) {
        const rows = await res.json();
        if (Array.isArray(rows) && rows.length > 0) {
          const prev = rows[0];
          if ((!Number.isFinite(comments) || comments <= 0) && Number(prev.comments) > 0) {
            comments = Number(prev.comments);
          }
          if ((!Number.isFinite(favourites) || favourites <= 0) && Number(prev.favourites) > 0) {
            favourites = Number(prev.favourites);
          }
          if ((!Number.isFinite(publishedChats) || publishedChats <= 0) && Number(prev.published_chats) > 0) {
            publishedChats = Number(prev.published_chats);
          }
        }
      }
    } catch {}
  }

  const payload = {
    character_id: characterId,
    timestamp: snapshot.timestamp || new Date().toISOString(),
    chats: Number(snapshot.chats) || 0,
    msgs: Number(snapshot.msgs) || 0,
    comments: Number.isFinite(comments) && comments >= 0 ? comments : 0,
    favourites: Number.isFinite(favourites) && favourites >= 0 ? favourites : 0,
    published_chats: Number.isFinite(publishedChats) && publishedChats >= 0 ? publishedChats : 0
  };

  try {
    const res = await fetch(`${config.url}/rest/v1/character_snapshots`, {
      method: "POST",
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${config.anonKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    return res.ok;
  } catch (err) {
    console.error("JStats: failed to insert snapshot into Supabase", err);
    return false;
  }
}

/**
 * Fetches all snapshots for a given character from Supabase.
 */
export async function fetchCharacterSnapshots(characterId) {
  const config = await getSupabaseConfig();
  if (!config || !characterId) return [];

  try {
    const cleanId = characterId.includes("/") ? characterId.split("/").pop() : characterId;
    let allRows = [];
    const pageSize = 1000;
    let offset = 0;

    while (true) {
      const query = `${config.url}/rest/v1/character_snapshots?character_id=eq.${encodeURIComponent(cleanId)}&order=timestamp.asc&limit=${pageSize}&offset=${offset}`;
      const res = await fetch(query, {
        headers: {
          apikey: config.anonKey,
          Authorization: `Bearer ${config.anonKey}`,
          Accept: "application/json"
        }
      });

      if (!res.ok) break;
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) break;
      allRows = allRows.concat(rows);
      if (rows.length < pageSize) break;
      offset += pageSize;
    }

    let lastKnownComments = null;
    let lastKnownFavourites = null;
    let lastKnownPubChats = null;

    const mapped = allRows.map(r => {
      const chats = Number(r.chats);
      const msgs = Number(r.msgs);
      let comments = Number(r.comments);
      let favourites = Number(r.favourites);
      let pubChats = Number(r.published_chats);

      // Protect against transient zeroes from feed card artifacts
      if (Number.isFinite(comments) && comments > 0) {
        lastKnownComments = comments;
      } else if ((!Number.isFinite(comments) || comments <= 0) && lastKnownComments != null) {
        comments = lastKnownComments;
      }

      if (Number.isFinite(favourites) && favourites > 0) {
        lastKnownFavourites = favourites;
      } else if ((!Number.isFinite(favourites) || favourites <= 0) && lastKnownFavourites != null) {
        favourites = lastKnownFavourites;
      }

      if (Number.isFinite(pubChats) && pubChats > 0) {
        lastKnownPubChats = pubChats;
      } else if ((!Number.isFinite(pubChats) || pubChats <= 0) && lastKnownPubChats != null) {
        pubChats = lastKnownPubChats;
      }

      return {
        timestamp: r.timestamp,
        characterId: r.character_id,
        chats,
        msgs,
        chatMsgRatio: chats > 0 ? Number((msgs / chats).toFixed(3)) : null,
        comments: Number.isFinite(comments) && comments >= 0 ? comments : 0,
        favourites: Number.isFinite(favourites) && favourites >= 0 ? favourites : 0,
        publishedChats: Number.isFinite(pubChats) && pubChats >= 0 ? pubChats : 0
      };
    });

    // If early snapshots had 0 publishedChats before the first positive one was encountered, backfill them
    if (lastKnownPubChats != null && lastKnownPubChats > 0) {
      for (let i = 0; i < mapped.length; i++) {
        if (mapped[i].publishedChats === 0) {
          mapped[i].publishedChats = lastKnownPubChats;
        } else {
          break;
        }
      }
    }

    return mapped;
  } catch (err) {
    console.warn("JStats: failed to fetch snapshots from Supabase", err);
    return [];
  }
}

/**
 * Connects to Supabase Realtime WebSocket to receive instant snapshot pushes.
 */
export function subscribeToRealtimeSnapshots(characterId, onSnapshot) {
  let ws = null;
  let heartbeatTimer = null;
  let isClosed = false;

  getSupabaseConfig().then(config => {
    if (!config || isClosed) return;

    try {
      const wsUrl = config.url.replace(/^http/, "ws") + `/realtime/v1/websocket?apikey=${config.anonKey}&vsn=1.0.0`;
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        // Join public:character_snapshots topic
        ws.send(JSON.stringify({
          topic: "realtime:public:character_snapshots",
          event: "phx_join",
          payload: {},
          ref: "1"
        }));

        heartbeatTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: "heartbeat" }));
          }
        }, 25000);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.event === "INSERT" && msg.payload?.record) {
            const record = msg.payload.record;
            if (!characterId || record.character_id === characterId) {
              const chats = Number(record.chats);
              const msgs = Number(record.msgs);
              const pubChats = Number(record.published_chats);
              const comms = Number(record.comments);
              const favs = Number(record.favourites);
              onSnapshot({
                timestamp: record.timestamp,
                characterId: record.character_id,
                chats,
                msgs,
                chatMsgRatio: chats > 0 ? Number((msgs / chats).toFixed(3)) : null,
                comments: Number.isFinite(comms) && comms > 0 ? comms : null,
                favourites: Number.isFinite(favs) && favs > 0 ? favs : null,
                publishedChats: Number.isFinite(pubChats) && pubChats > 0 ? pubChats : null
              });
            }
          }
        } catch {}
      };

      ws.onerror = (e) => {
        console.debug("Supabase Realtime socket event", e);
      };
    } catch (e) {
      console.debug("Could not initialize Realtime websocket", e);
    }
  });

  return () => {
    isClosed = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (ws) ws.close();
  };
}

/**
 * Updates the status of a tracked job (e.g. 'active', 'completed', 'paused').
 */
export async function updateTrackedJobStatus(characterId, status) {
  const config = await getSupabaseConfig();
  if (!config) return false;

  try {
    const res = await fetch(`${config.url}/rest/v1/tracked_jobs?character_id=eq.${encodeURIComponent(characterId)}`, {
      method: "PATCH",
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${config.anonKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({ status })
    });
    return res.ok;
  } catch (err) {
    console.error("JStats: failed to update job status in Supabase", err);
    return false;
  }
}

/**
 * Deletes a tracked job and its cascading snapshots from Supabase.
 */
export async function deleteTrackedJob(characterId) {
  const config = await getSupabaseConfig();
  if (!config) return false;

  try {
    const res = await fetch(`${config.url}/rest/v1/tracked_jobs?character_id=eq.${encodeURIComponent(characterId)}`, {
      method: "DELETE",
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${config.anonKey}`
      }
    });
    return res.ok;
  } catch (err) {
    console.error("JStats: failed to delete tracked job from Supabase", err);
    return false;
  }
}

export const SCHEMA_SQL = `-- JStats: Supabase Schema (100% Free PostgreSQL setup)
CREATE TABLE IF NOT EXISTS tracked_jobs (
  character_id TEXT PRIMARY KEY,
  character_name TEXT NOT NULL,
  url TEXT NOT NULL,
  avatar TEXT,
  creator TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '72 hours'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'paused')),
  last_scraped_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS character_snapshots (
  id BIGSERIAL PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES tracked_jobs(character_id) ON DELETE CASCADE,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  chats BIGINT NOT NULL DEFAULT 0,
  msgs BIGINT NOT NULL DEFAULT 0,
  comments BIGINT NOT NULL DEFAULT 0,
  favourites BIGINT NOT NULL DEFAULT 0,
  published_chats BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS watched_creators (
  creator_handle TEXT PRIMARY KEY,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_snapshots_char_time 
  ON character_snapshots(character_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_jobs_status_expires 
  ON tracked_jobs(status, expires_at);

ALTER TABLE tracked_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE character_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE watched_creators ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anon read tracked_jobs" ON tracked_jobs FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Allow anon insert tracked_jobs" ON tracked_jobs FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Allow anon update tracked_jobs" ON tracked_jobs FOR UPDATE TO anon, authenticated USING (true);
CREATE POLICY "Allow anon delete tracked_jobs" ON tracked_jobs FOR DELETE TO anon, authenticated USING (true);

CREATE POLICY "Allow anon read character_snapshots" ON character_snapshots FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Allow anon insert character_snapshots" ON character_snapshots FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Allow anon delete character_snapshots" ON character_snapshots FOR DELETE TO anon, authenticated USING (true);

CREATE POLICY "Allow anon read watched_creators" ON watched_creators FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Allow anon insert watched_creators" ON watched_creators FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Allow anon delete watched_creators" ON watched_creators FOR DELETE TO anon, authenticated USING (true);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE character_snapshots, tracked_jobs, watched_creators;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
`;
