import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

console.log("==================================================");
console.log("Running JStats Test Suite");
console.log("==================================================");

let passed = 0;
let failed = 0;

function it(name, fn) {
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${err.message}`);
    failed++;
  }
}

async function runAsync(name, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${err.message}`);
    failed++;
  }
}

// 1. Test common.js
const common = await import("../common.js");

it("common.cleanUuid extracts valid UUIDs", () => {
  const url = "https://janitorai.com/characters/895c6961-c428-4e8b-86fb-a51caf35f89a_test-slug";
  assert.equal(common.cleanUuid(url), "895c6961-c428-4e8b-86fb-a51caf35f89a");
  assert.equal(common.cleanUuid("invalid-uuid"), null);
});

it("common.cleanCreatorHandle sanitizes handles and profile URLs", () => {
  assert.equal(common.cleanCreatorHandle("@CreatorName"), "creatorname");
  assert.equal(common.cleanCreatorHandle("https://janitorai.com/profiles/CreatorName"), "creatorname");
});

it("common.formatCompact formats numbers with standard suffixes", () => {
  assert.equal(common.formatCompact(500), "500");
  assert.equal(common.formatCompact(1500), "1.5k");
  assert.equal(common.formatCompact(2500000), "2.5m");
  assert.equal(common.formatCompact(null), "—");
});

it("common.getWindowStats calculates deltas, percent, and hourly rate", () => {
  const snaps = [
    { timestamp: "2026-09-20T00:00:00Z", chats: 100, msgs: 1000 },
    { timestamp: "2026-09-20T02:00:00Z", chats: 200, msgs: 2200 }
  ];
  const stats = common.getWindowStats(snaps, "chats");
  assert.ok(stats);
  assert.equal(stats.delta, 100);
  assert.equal(stats.percent, 100);
  assert.equal(stats.perHour, 50); // 100 delta over 2 hours = 50/h
});

it("common.sanitizeTransientZeroes filters single-point dropouts", () => {
  const pts = [
    { timestamp: "2026-09-20T00:00:00Z", value: 100 },
    { timestamp: "2026-09-20T00:01:00Z", value: 0 },
    { timestamp: "2026-09-20T00:02:00Z", value: 105 }
  ];
  const sanitized = common.sanitizeTransientZeroes(pts);
  assert.ok(Number.isNaN(sanitized[1].value));
  assert.equal(sanitized[1].transientZero, true);
});

// 2. Test cloud-worker.js helpers
const worker = await import("./cloud-worker.js");

it("cloud-worker.extractSessionObject decodes chunked session cookies", () => {
  const session = { access_token: "jwt_token_sample" };
  const b64 = Buffer.from(JSON.stringify(session)).toString("base64");
  const cookieStr = `sb-project-auth-token.0=${b64}`;
  const extracted = worker.extractSessionObject(cookieStr);
  assert.ok(extracted);
  assert.equal(extracted.access_token, "jwt_token_sample");
});

it("cloud-worker.extractTokenFromString extracts JWT from cookie header", () => {
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2FtcGxl";
  const cookieStr = `sb-project-auth-token.0=${Buffer.from(JSON.stringify({ access_token: jwt })).toString("base64")}`;
  assert.equal(worker.extractTokenFromString(cookieStr), jwt);
});

// 3. Test Supabase Client Layer
const supabase = await import("../supabase.js");

await runAsync("supabase.getSupabaseConfig returns default credentials", async () => {
  const conf = await supabase.getSupabaseConfig();
  assert.ok(conf);
  assert.ok(conf.url.startsWith("https://"));
  assert.ok(conf.anonKey.length > 10);
});

await runAsync("supabase.testSupabaseConnection connects to live Supabase endpoint", async () => {
  const conf = await supabase.getSupabaseConfig();
  const res = await supabase.testSupabaseConnection(conf.url, conf.anonKey);
  assert.equal(res.ok, true);
});

await runAsync("supabase.fetchTrackedJobs retrieves jobs", async () => {
  const jobs = await supabase.fetchTrackedJobs();
  assert.ok(Array.isArray(jobs));
  assert.ok(jobs.length > 0);
});

// 4. Test Manifest V3 Compliance
it("manifest.json has valid match patterns without numeric port pins", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);

  // Chrome MV3 match patterns allow an explicit ":*" port segment (any port),
  // used here for localhost dev origins. A pinned numeric port is what's invalid.
  for (const cs of manifest.content_scripts || []) {
    for (const match of cs.matches || []) {
      const hasNumericPort = /:[0-9]+\//.test(match);
      if (hasNumericPort) {
        throw new Error(`Invalid match pattern with numeric port: ${match}`);
      }
    }
  }
});

console.log("==================================================");
console.log(`Test Results: ${passed} Passed, ${failed} Failed`);
console.log("==================================================");

if (failed > 0) {
  process.exit(1);
}
