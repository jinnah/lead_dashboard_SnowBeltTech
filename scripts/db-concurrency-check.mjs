#!/usr/bin/env node
// Concurrency verification for public.ingest_lead_event against the LOCAL
// Supabase stack, fully isolated in a dedicated synthetic harness business.
//
//   pnpm run db:concurrency
//
// Real parallel sessions: separate psql processes inside the local db
// container (no credentials needed or committed), each calling the RPC as
// service_role. Proves: (1) N concurrent deliveries of ONE event -> exactly one
// lead and exactly one should_notify=true; (2) N concurrent DISTINCT events ->
// N leads with N distinct numbers that continue after a pre-existing number.
//
// Isolation: the harness creates its own business + website source (fixed,
// clearly synthetic ids), seeds one pre-existing lead number so allocator
// seeding is exercised, and deletes ONLY its own events/leads/counter/source/
// business on success AND failure. Seeded businesses (incl. Business A's
// allocator row) are never touched. Re-running is idempotent.
//
// Honest limitation: overlap between sessions is induced by a start-up delay,
// not a deterministic barrier, so simultaneity is probabilistic.

import { spawn, spawnSync } from "node:child_process";

const CONTAINER = "supabase_db_Dashboard_SnowBeltTech";
const N = 8;
const H = {
  businessId: "c0000000-0000-4000-8000-0000000000c0",
  sourceId: "c3000000-0000-4000-8000-0000000000c3",
  slug: "concurrency-harness-synthetic",
  sourceExternalId: "site-concurrency-harness-synthetic",
  eventPrefix: "concurrency-harness-",
  timezone: "America/New_York",
};

const PSQL = ["exec", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-Atq", "-v", "ON_ERROR_STOP=1", "-c"];

function psqlSync(sql) {
  const r = spawnSync("docker", [...PSQL, sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}
function psqlAsync(sql) {
  return new Promise((resolve) => {
    const p = spawn("docker", [...PSQL, sql]);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

// Remove ONLY harness-owned rows, in dependency order. Safe when nothing exists.
function cleanup() {
  psqlSync(`
    delete from public.ingestion_events where business_id = '${H.businessId}';
    delete from public.leads where business_id = '${H.businessId}';
    delete from public.lead_number_counters where business_id = '${H.businessId}';
    delete from public.integration_sources where business_id = '${H.businessId}';
    delete from public.businesses where id = '${H.businessId}';`);
}
function harnessRowCount() {
  return psqlSync(`select (select count(*) from public.businesses where id = '${H.businessId}')
                        + (select count(*) from public.integration_sources where business_id = '${H.businessId}')
                        + (select count(*) from public.leads where business_id = '${H.businessId}')
                        + (select count(*) from public.ingestion_events where business_id = '${H.businessId}')
                        + (select count(*) from public.lead_number_counters where business_id = '${H.businessId}')`);
}

const call = (eventId) =>
  `set role service_role; select pg_sleep(1.5); ` +
  `select outcome || '|' || should_notify::text || '|' || coalesce(lead_number, '') ` +
  `from public.ingest_lead_event('website_form', '${H.sourceExternalId}', '${H.eventPrefix}${eventId}', '{"contact_name":"Concurrency ${eventId}"}'::jsonb);`;

let failed = false;
function fail(msg) {
  failed = true;
  throw new Error(msg);
}

async function main() {
  const ok = spawnSync("docker", [...PSQL, "select 1"], { encoding: "utf8" });
  if (ok.status !== 0) throw new Error("local Supabase db container is not running (pnpm run db:start)");

  const bizASnapshot = psqlSync(`select coalesce(string_agg(year || ':' || last_value, ',' order by year), '(none)') from public.lead_number_counters where business_id = 'a0000000-0000-4000-8000-000000000001'`);
  cleanup(); // idempotent start
  const year = psqlSync(`select extract(year from (now() at time zone '${H.timezone}'))::int`);
  const preexisting = `INQ-${year}-0007`;
  psqlSync(`
    insert into public.businesses (id, name, slug, industry, timezone, status)
      values ('${H.businessId}', 'Concurrency Harness (synthetic)', '${H.slug}', 'other', '${H.timezone}', 'active');
    insert into public.integration_sources (id, business_id, kind, external_id, label, status)
      values ('${H.sourceId}', '${H.businessId}', 'website_form', '${H.sourceExternalId}', 'harness source', 'active');
    insert into public.leads (business_id, lead_number, source, contact_name)
      values ('${H.businessId}', '${preexisting}', 'manual', 'Pre-existing (synthetic)');`);
  console.log(`[concurrency] harness business created; pre-existing lead number ${preexisting}; Business A allocator rows before: ${bizASnapshot}`);

  // ---- 1. same event, N parallel deliveries ----------------------------------------------
  console.log(`[concurrency] phase 1: ${N} parallel deliveries of the SAME event`);
  const same = (await Promise.all(Array.from({ length: N }, () => psqlAsync(call("same-0001"))))).map((r) => (r.code === 0 ? r.out : `ERROR:${r.err}`));
  same.forEach((r, i) => console.log(`  session ${i + 1}: ${r}`));
  const created = same.filter((r) => r.startsWith("lead_created|true|")).length;
  const dups = same.filter((r) => r.startsWith("duplicate_lead|false|")).length;
  if (created !== 1) fail(`expected exactly 1 lead_created, got ${created}`);
  if (dups !== N - 1) fail(`expected ${N - 1} duplicate_lead results, got ${dups}`);
  const numbers1 = new Set(same.map((r) => r.split("|")[2]));
  if (numbers1.size !== 1) fail(`all sessions should report one lead number, saw ${[...numbers1].join(", ")}`);
  if ([...numbers1][0] !== `INQ-${year}-0008`) fail(`allocator should continue after ${preexisting}; got ${[...numbers1][0]}`);
  const leadCount1 = psqlSync(`select count(*) from public.leads where business_id = '${H.businessId}' and source_event_id = '${H.eventPrefix}same-0001'`);
  const attempts = psqlSync(`select attempt_count from public.ingestion_events where business_id = '${H.businessId}' and source_event_id = '${H.eventPrefix}same-0001'`);
  if (leadCount1 !== "1") fail(`database holds ${leadCount1} leads for the event`);
  if (attempts !== String(N)) fail(`attempt_count is ${attempts}, expected ${N}`);
  console.log(`[concurrency] phase 1 OK: 1 lead, 1 notify, ${dups} duplicates, attempt_count=${attempts}, number ${[...numbers1][0]} (seeded after ${preexisting})`);

  // ---- 2. distinct events, N parallel deliveries -------------------------------------------
  console.log(`[concurrency] phase 2: ${N} parallel deliveries of DISTINCT events`);
  const distinct = (await Promise.all(Array.from({ length: N }, (_, i) => psqlAsync(call(`distinct-${String(i + 1).padStart(4, "0")}`))))).map((r) => (r.code === 0 ? r.out : `ERROR:${r.err}`));
  distinct.forEach((r, i) => console.log(`  session ${i + 1}: ${r}`));
  if (distinct.some((r) => !r.startsWith("lead_created|true|"))) fail("every distinct event must create a notifying lead");
  const numbers2 = distinct.map((r) => r.split("|")[2]);
  if (new Set(numbers2).size !== N) fail(`expected ${N} distinct lead numbers, got ${new Set(numbers2).size}`);
  if (numbers2.includes(preexisting) || numbers2.some((n) => numbers1.has(n))) fail("allocated numbers collide with existing ones");
  const total = psqlSync(`select count(*) from public.leads where business_id = '${H.businessId}'`);
  if (total !== String(N + 2)) fail(`expected ${N + 2} harness leads (pre-existing + same + ${N} distinct), found ${total}`);
  const uniqueAll = psqlSync(`select count(*) = count(distinct lead_number) from public.leads where business_id = '${H.businessId}'`);
  if (uniqueAll !== "t") fail("lead numbers are not unique within the harness business");
  console.log(`[concurrency] phase 2 OK: ${N} leads, numbers ${numbers2.sort().join(", ")}; all harness numbers unique`);

  const bizAAfter = psqlSync(`select coalesce(string_agg(year || ':' || last_value, ',' order by year), '(none)') from public.lead_number_counters where business_id = 'a0000000-0000-4000-8000-000000000001'`);
  if (bizAAfter !== bizASnapshot) fail(`Business A allocator rows changed: ${bizASnapshot} -> ${bizAAfter}`);
}

(async () => {
  let exit = 0;
  try {
    await main();
  } catch (e) {
    console.error(`\n[concurrency] FAIL: ${e.message}`);
    exit = 1;
  } finally {
    try {
      cleanup();
      const left = harnessRowCount();
      console.log(`[concurrency] cleanup: harness rows remaining = ${left}`);
      if (left !== "0") { console.error("[concurrency] FAIL: cleanup left harness rows"); exit = 1; }
    } catch (e) {
      console.error(`[concurrency] cleanup error: ${e.message}`);
      exit = 1;
    }
  }
  console.log(exit === 0 ? "[concurrency] PASS" : "[concurrency] FAILED");
  process.exit(exit);
})();
