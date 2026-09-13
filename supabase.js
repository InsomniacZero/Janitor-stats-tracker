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
    return await res.json();
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

  const payload = {
    character_id: job.character_id,
    character_name: job.character_name || "JanitorAI Character",
    url: job.url || `https://janitorai.com/characters/${job.character_id}`,
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
 * Inserts a single minute snapshot for a tracked character into Supabase.
 */
export async function insertSnapshot(characterId, snapshot) {
  const config = await getSupabaseConfig();
  if (!config) return false;

  const payload = {
    character_id: characterId,
    timestamp: snapshot.timestamp || new Date().toISOString(),
    chats: Number(snapshot.chats) || 0,
    msgs: Number(snapshot.msgs) || 0,
    comments: Number(snapshot.comments) || 0,
    favourites: Number(snapshot.favourites) || 0,
    published_chats: Number(snapshot.publishedChats) || 0
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
  if (!config) return [];

  try {
    const query = `${config.url}/rest/v1/character_snapshots?character_id=eq.${encodeURIComponent(characterId)}&order=timestamp.asc&limit=10000`;
    const res = await fetch(query, {
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${config.anonKey}`,
        Accept: "application/json"
      }
    });

    if (!res.ok) return [];
    const rows = await res.json();
    return rows.map(r => {
      const chats = Number(r.chats);
      const msgs = Number(r.msgs);
      return {
        timestamp: r.timestamp,
        characterId: r.character_id,
        chats,
        msgs,
        chatMsgRatio: chats > 0 ? Number((msgs / chats).toFixed(3)) : null,
        comments: Number(r.comments),
        favourites: Number(r.favourites),
        publishedChats: Number(r.published_chats)
      };
    });
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
              onSnapshot({
                timestamp: record.timestamp,
                characterId: record.character_id,
                chats,
                msgs,
                chatMsgRatio: chats > 0 ? Number((msgs / chats).toFixed(3)) : null,
                comments: Number(record.comments),
                favourites: Number(record.favourites),
                publishedChats: Number(record.published_chats)
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

CREATE INDEX IF NOT EXISTS idx_snapshots_char_time 
  ON character_snapshots(character_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_jobs_status_expires 
  ON tracked_jobs(status, expires_at);

ALTER TABLE tracked_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE character_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anon read tracked_jobs" ON tracked_jobs FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Allow anon insert tracked_jobs" ON tracked_jobs FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Allow anon update tracked_jobs" ON tracked_jobs FOR UPDATE TO anon, authenticated USING (true);
CREATE POLICY "Allow anon delete tracked_jobs" ON tracked_jobs FOR DELETE TO anon, authenticated USING (true);

CREATE POLICY "Allow anon read character_snapshots" ON character_snapshots FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Allow anon insert character_snapshots" ON character_snapshots FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Allow anon delete character_snapshots" ON character_snapshots FOR DELETE TO anon, authenticated USING (true);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE character_snapshots, tracked_jobs;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
`;
