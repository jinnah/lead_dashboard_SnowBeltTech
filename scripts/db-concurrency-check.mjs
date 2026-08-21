#!/usr/bin/env node
// Concurrency verification for public.ingest_lead_event against the LOCAL
// Supabase stack. Runs real parallel sessions (separate psql processes inside
// the local db container, so no credentials are needed or committed), each
// calling the RPC as service_role.
//
//   pnpm run db:concurrency
//
// Proves: (1) N concurrent deliveries of ONE event -> exactly one lead and
// exactly one should_notify=true; (2) N concurrent DISTINCT events -> N leads
// with N distinct numbers, none colliding with pre-existing numbers.
// Uses only synthetic seed identifiers and cleans up after itself.

import { spawn, spawnSync } from "node:child_process";

const CONTAINER = "supabase_db_Dashboard_SnowBeltTech";
const N = 8;
const SOURCE = "site-alpha-synthetic"; // seeded website_form source of Business A
const BIZ_A = "a0000000-0000-4000-8000-000000000001";
const PREFIX = "concurrency-harness-";

function psqlSync(sql) {
  const r = spawnSync("docker", ["exec", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

function psqlAsync(sql) {
  return new Promise((resolve) => {
    const p = spawn("docker", ["exec", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", sql]);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

// Each session: become service_role, wait so all N sessions are connected, then call the RPC.
const call = (eventId) =>
  `set role service_role; select pg_sleep(1.5); ` +
  `select outcome || '|' || should_notify::text || '|' || coalesce(lead_number, '') ` +
  `from public.ingest_lead_event('website_form', '${SOURCE}', '${PREFIX}${eventId}', '{"contact_name":"Concurrency ${eventId}"}'::jsonb);`;

function fail(msg) {
  console.error(`\n[concurrency] FAIL: ${msg}`);
  cleanup();
  process.exit(1);
}

function cleanup() {
  try {
    psqlSync(`delete from public.ingestion_events where source_event_id like '${PREFIX}%';
              delete from public.leads where source_event_id like '${PREFIX}%';
              delete from public.lead_number_counters where business_id = '${BIZ_A}';`);
  } catch (e) {
    console.error(`[concurrency] cleanup error: ${e.message}`);
  }
}

(async () => {
  const ok = spawnSync("docker", ["exec", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-Atqc", "select 1"], { encoding: "utf8" });
  if (ok.status !== 0) { console.error("[concurrency] local Supabase db container is not running (pnpm run db:start)"); process.exit(1); }
  cleanup(); // idempotent start
  const existing = psqlSync(`select string_agg(lead_number, ',' order by lead_number) from public.leads where business_id = '${BIZ_A}'`).split(",").filter(Boolean);
  console.log(`[concurrency] pre-existing Business A lead numbers: ${existing.join(", ")}`);

  // ---- 1. same event, N parallel deliveries -------------------------------------------------
  console.log(`[concurrency] phase 1: ${N} parallel deliveries of the SAME event`);
  const same = await Promise.all(Array.from({ length: N }, () => psqlAsync(call("same-0001"))));
  const sameRows = same.map((r) => (r.code === 0 ? r.out : `ERROR:${r.err}`));
  sameRows.forEach((r, i) => console.log(`  session ${i + 1}: ${r}`));
  const created = sameRows.filter((r) => r.startsWith("lead_created|true|")).length;
  const dups = sameRows.filter((r) => r.startsWith("duplicate_lead|false|")).length;
  if (created !== 1) fail(`expected exactly 1 lead_created, got ${created}`);
  if (dups !== N - 1) fail(`expected ${N - 1} duplicate_lead results, got ${dups}`);
  const numbers1 = new Set(sameRows.map((r) => r.split("|")[2]));
  if (numbers1.size !== 1) fail(`all sessions should report the same lead number, saw ${[...numbers1].join(", ")}`);
  const leadCount1 = psqlSync(`select count(*) from public.leads where source_event_id = '${PREFIX}same-0001'`);
  const attempts = psqlSync(`select attempt_count from public.ingestion_events where source_event_id = '${PREFIX}same-0001'`);
  if (leadCount1 !== "1") fail(`database holds ${leadCount1} leads for the event`);
  if (attempts !== String(N)) fail(`attempt_count is ${attempts}, expected ${N}`);
  console.log(`[concurrency] phase 1 OK: 1 lead, 1 notify, ${dups} duplicates, attempt_count=${attempts}, number ${[...numbers1][0]}`);

  // ---- 2. distinct events, N parallel deliveries ---------------------------------------------
  console.log(`[concurrency] phase 2: ${N} parallel deliveries of DISTINCT events`);
  const distinct = await Promise.all(Array.from({ length: N }, (_, i) => psqlAsync(call(`distinct-${String(i + 1).padStart(4, "0")}`))));
  const distinctRows = distinct.map((r) => (r.code === 0 ? r.out : `ERROR:${r.err}`));
  distinctRows.forEach((r, i) => console.log(`  session ${i + 1}: ${r}`));
  if (distinctRows.some((r) => !r.startsWith("lead_created|true|"))) fail("every distinct event must create a notifying lead");
  const numbers2 = distinctRows.map((r) => r.split("|")[2]);
  if (new Set(numbers2).size !== N) fail(`expected ${N} distinct lead numbers, got ${new Set(numbers2).size}`);
  const collide = numbers2.filter((n) => existing.includes(n) || numbers1.has(n));
  if (collide.length) fail(`allocated numbers collide with existing ones: ${collide.join(", ")}`);
  const total = psqlSync(`select count(*) from public.leads where source_event_id like '${PREFIX}%'`);
  if (total !== String(N + 1)) fail(`expected ${N + 1} harness leads in total, found ${total}`);
  const uniqueAll = psqlSync(`select count(*) = count(distinct lead_number) from public.leads where business_id = '${BIZ_A}'`);
  if (uniqueAll !== "t") fail("lead numbers are not unique within Business A");
  console.log(`[concurrency] phase 2 OK: ${N} leads, numbers ${numbers2.sort().join(", ")}; all Business A numbers unique`);

  cleanup();
  console.log("[concurrency] PASS (harness rows removed)");
})().catch((e) => fail(e.message));
