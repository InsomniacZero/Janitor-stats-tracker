-- ==============================================================================
-- JStats: JanitorAI Statistics Tracker — Supabase Schema
-- 100% Free PostgreSQL setup with 72h Tracking Jobs & Time-Series Snapshots
-- ==============================================================================

-- 1. Create Tracked Jobs Table
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

-- 2. Create Character Snapshots Table
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

-- 3. High-Performance Time-Series Indexes
CREATE INDEX IF NOT EXISTS idx_snapshots_char_time 
  ON character_snapshots(character_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_jobs_status_expires 
  ON tracked_jobs(status, expires_at);

-- 4. Enable Row Level Security (RLS)
ALTER TABLE tracked_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE character_snapshots ENABLE ROW LEVEL SECURITY;

-- 5. Open Public/Anon Policies (Allows web dashboard & extension direct access)
CREATE POLICY "Allow anon read tracked_jobs" 
  ON tracked_jobs FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "Allow anon insert tracked_jobs" 
  ON tracked_jobs FOR INSERT TO anon, authenticated WITH CHECK (true);

CREATE POLICY "Allow anon update tracked_jobs" 
  ON tracked_jobs FOR UPDATE TO anon, authenticated USING (true);

CREATE POLICY "Allow anon delete tracked_jobs" 
  ON tracked_jobs FOR DELETE TO anon, authenticated USING (true);

CREATE POLICY "Allow anon read character_snapshots" 
  ON character_snapshots FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "Allow anon insert character_snapshots" 
  ON character_snapshots FOR INSERT TO anon, authenticated WITH CHECK (true);

CREATE POLICY "Allow anon delete character_snapshots" 
  ON character_snapshots FOR DELETE TO anon, authenticated USING (true);

-- 6. Enable Realtime Publications
-- Allows the web app on Vercel to receive instant graph updates as new minute snapshots arrive
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE character_snapshots, tracked_jobs;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
