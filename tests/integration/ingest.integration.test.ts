// Real path: HTTP -> local Next.js production server (spawned here, stdout captured)
// -> server-only service-role client -> public.ingest_lead_event -> local Supabase.
// Prerequisites: pnpm run db:start && pnpm run env:local && pnpm build
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const BASE = "http://127.0.0.1:3000";
const ENDPOINT = `${BASE}/api/internal/ingest`;
const CONTAINER = "supabase_db_Dashboard_SnowBeltTech";
const RUN = `http-it-${Date.now().toString(36)}`;
const BIZ_A = "a0000000-0000-4000-8000-000000000001";
const BIZ_B = "b0000000-0000-4000-8000-000000000001";

function env(name: string): string {
  const text = readFileSync(path.join(ROOT, ".env.local"), "utf8");
  const m = new RegExp(`^${name}=(.*)$`, "m").exec(text);
  if (!m) throw new Error(`${name} missing from .env.local`);
  return m[1]!.trim();
}
const TOKEN = env("N8N_INGEST_TOKEN");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

function sql(q: string): string {
  const r = spawnSync("docker", ["exec", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", q], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr}`);
  return r.stdout.trim();
}
const leadsFor = (eventId: string) => Number(sql(`select count(*) from public.leads where source_event_id = '${eventId}'`));
const eventsFor = (eventId: string) => Number(sql(`select count(*) from public.ingestion_events where source_event_id = '${eventId}'`));

async function post(body: unknown, init: { token?: string | null; contentType?: string; method?: string; raw?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.token !== null) headers.authorization = `Bearer ${init.token ?? TOKEN}`;
  headers["content-type"] = init.contentType ?? "application/json";
  const res = await fetch(ENDPOINT, { method: init.method ?? "POST", headers, body: init.raw ?? JSON.stringify(body) });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, text, json, headers: res.headers };
}
const webReq = (eventId: string, payload: Record<string, unknown> = {}, source = "site-alpha-synthetic") => ({
  source_kind: "website_form", source_external_id: source, source_event_id: eventId,
  payload: { contact_name: "Synthetic Customer", email: "customer@example.invalid", phone_e164: "+15550100001", requested_service: "Furnace inspection", sms_consent: false, ...payload },
});
const voiceReq = (eventId: string, payload: Record<string, unknown> = {}) => ({
  source_kind: "vapi_assistant", source_external_id: "asst-alpha-synthetic-0001", source_event_id: eventId,
  payload: { call_id: eventId, is_lead: true, call_classification: "legitimate_lead", caller_phone: "+15550100002", contact_name: "Voice Caller", ...payload },
});

let server: ChildProcess | null = null;
const serverLog: string[] = [];
const countersBefore = { a: "", b: "" };

beforeAll(async () => {
  countersBefore.a = sql(`select count(*) from public.lead_number_counters where business_id = '${BIZ_A}'`);
  countersBefore.b = sql(`select count(*) from public.lead_number_counters where business_id = '${BIZ_B}'`);
  const require = createRequire(import.meta.url);
  const nextBin = require.resolve("next/dist/bin/next");
  server = spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", "3000"], { cwd: ROOT, env: { ...process.env, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout!.on("data", (d) => serverLog.push(String(d)));
  server.stderr!.on("data", (d) => serverLog.push(String(d)));
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const r = await fetch(BASE, { method: "GET" });
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${serverLog.join("")}`);
    await new Promise((r) => setTimeout(r, 500));
  }
});

afterAll(() => {
  if (server?.pid) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"]);
    else server.kill("SIGTERM");
  }
  // remove only this run's rows; drop allocator rows only if this run created them
  sql(`delete from public.ingestion_events where source_event_id like '${RUN}%';
       delete from public.leads where source_event_id like '${RUN}%';`);
  if (countersBefore.a === "0") sql(`delete from public.lead_number_counters where business_id = '${BIZ_A}'`);
  if (countersBefore.b === "0") sql(`delete from public.lead_number_counters where business_id = '${BIZ_B}'`);
  sql(`update public.businesses set status = 'active' where id in ('${BIZ_A}', '${BIZ_B}');
       update public.integration_sources set status = 'active' where business_id in ('${BIZ_A}', '${BIZ_B}');`);
});

describe("ingestion endpoint against local Supabase", () => {
  it("listens only on 127.0.0.1:3000 and exposes no CORS", async () => {
    if (process.platform === "win32") {
      const out = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" }).stdout;
      const listeners = out.split(/\r?\n/).filter((l) => /LISTENING/.test(l) && /:3000\s/.test(l)).map((l) => l.trim().split(/\s+/)[1]);
      expect(listeners.length).toBeGreaterThan(0);
      expect(listeners.every((a) => a === "127.0.0.1:3000")).toBe(true);
    }
    const res = await fetch(ENDPOINT, { method: "OPTIONS", headers: { origin: "https://evil.example.invalid" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("unauthenticated request creates no lead or event", async () => {
    const id = `${RUN}-unauth`;
    const r1 = await post(webReq(id), { token: null });
    const r2 = await post(webReq(id), { token: "0".repeat(64) });
    expect(r1.status).toBe(401);
    expect(r2.status).toBe(401);
    expect(r1.text).toBe(r2.text);
    expect(leadsFor(id)).toBe(0);
    expect(eventsFor(id)).toBe(0);
  });
  it("unsupported method and content type fail correctly", async () => {
    const get = await fetch(ENDPOINT, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(get.status).toBe(405);
    const form = await post(webReq(`${RUN}-ct`), { contentType: "application/x-www-form-urlencoded" });
    expect(form.status).toBe(415);
    expect(leadsFor(`${RUN}-ct`)).toBe(0);
  });
  it("valid website request creates exactly one lead; response has no business_id", async () => {
    const id = `${RUN}-web-1`;
    const r = await post(webReq(id));
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ outcome: "lead_created", should_notify: true, customer_sms_allowed: false });
    expect(Object.keys(r.json!).sort()).toEqual(["customer_sms_allowed", "lead_id", "lead_number", "outcome", "should_notify"]);
    expect(r.text).not.toContain(BIZ_A);
    expect(r.text).not.toContain("customer@example.invalid");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(leadsFor(id)).toBe(1);
    expect(sql(`select business_id || '|' || contact_name || '|' || email from public.leads where source_event_id = '${id}'`)).toBe(`${BIZ_A}|Synthetic Customer|customer@example.invalid`);
    expect(sql(`select lead_number from public.leads where source_event_id = '${id}'`)).toBe(r.json!.lead_number);
  });
  it("replaying the website event is a non-notifying duplicate and creates nothing", async () => {
    const id = `${RUN}-web-1`;
    const r = await post(webReq(id, { contact_name: "Changed On Replay" }));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ outcome: "duplicate_lead", should_notify: false, customer_sms_allowed: false });
    expect(leadsFor(id)).toBe(1);
    expect(sql(`select contact_name from public.leads where source_event_id = '${id}'`)).toBe("Synthetic Customer");
    expect(sql(`select attempt_count from public.ingestion_events where source_event_id = '${id}'`)).toBe("2");
  });
  it("valid website consent yields customer_sms_allowed=true; missing evidence is rejected", async () => {
    const ok = await post(webReq(`${RUN}-consent-ok`, { sms_consent: true, sms_consent_text: "Synthetic consent text.", sms_consent_version: "test-v1", sms_consent_source: "website_form", sms_consent_at: "2026-08-21T10:00:00Z" }));
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({ outcome: "lead_created", should_notify: true, customer_sms_allowed: true });
    expect(sql(`select sms_consent::text || '|' || sms_consent_version from public.leads where source_event_id = '${RUN}-consent-ok'`)).toBe("true|test-v1");
    const bad = await post(webReq(`${RUN}-consent-bad`, { sms_consent: true, sms_consent_text: "t", sms_consent_version: "v" }));
    expect(bad.status).toBe(422);
    expect(leadsFor(`${RUN}-consent-bad`)).toBe(0);
    const naive = await post(webReq(`${RUN}-consent-naive`, { sms_consent: true, sms_consent_text: "t", sms_consent_version: "v", sms_consent_source: "website_form", sms_consent_at: "2026-08-21T10:00:00" }));
    expect(naive.status).toBe(422);
  });
  it("accepted Vapi call creates a voice lead with the complete call id", async () => {
    const id = `${RUN}-vapi-call-0123456789abcdef-0123456789abcdef-full`;
    const r = await post(voiceReq(id, { ended_reason: "customer-ended-call", review_recommended: true, review_reason: "Callback unconfirmed." }));
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ outcome: "lead_created", should_notify: true, customer_sms_allowed: false });
    expect(sql(`select source || '|' || call_id || '|' || (call_id = source_event_id)::text from public.leads where source_event_id = '${id}'`)).toBe(`voice_call|${id}|true`);
    const mismatch = await post(voiceReq(`${RUN}-vapi-mismatch`, { call_id: "mismatch" }));
    expect(mismatch.status).toBe(422);
    expect(leadsFor(`${RUN}-vapi-mismatch`)).toBe(0);
  });
  it("filtered Vapi call creates only a filtered event; its duplicate stays non-notifying", async () => {
    const id = `${RUN}-vapi-filtered`;
    const r = await post(voiceReq(id, { is_lead: false, call_classification: "uncertain", review_reason: "Name and phone spoken here", ended_reason: "customer-ended-call" }));
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ outcome: "filtered", should_notify: false, customer_sms_allowed: false, lead_id: null, lead_number: null });
    expect(leadsFor(id)).toBe(0);
    expect(sql(`select outcome || '|' || (metadata ? 'review_reason')::text || '|' || (metadata ->> 'filter_reason') from public.ingestion_events where source_event_id = '${id}'`)).toBe("filtered|false|not_a_lead");
    const dup = await post(voiceReq(id, { is_lead: false, call_classification: "uncertain" }));
    expect(dup.status).toBe(200);
    expect(dup.json).toMatchObject({ outcome: "duplicate_filtered", should_notify: false, customer_sms_allowed: false });
    expect(eventsFor(id)).toBe(1);
    expect(leadsFor(id)).toBe(0);
  });
  it("Business A and Business B sources route to their own businesses", async () => {
    const id = `${RUN}-shared`;
    const a = await post(webReq(id, {}, "site-alpha-synthetic"));
    const b = await post(webReq(id, {}, "site-bravo-synthetic"));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(sql(`select string_agg(business_id::text, ',' order by business_id) from public.leads where source_event_id = '${id}'`)).toBe(`${BIZ_A},${BIZ_B}`);
    expect(a.text).not.toContain(BIZ_A);
    expect(b.text).not.toContain(BIZ_B);
  });
  it("unknown, inactive and suspended conditions return one opaque response and create nothing", async () => {
    const responses: string[] = [];
    const unknown = await post(webReq(`${RUN}-unknown`, {}, "site-does-not-exist"));
    responses.push(`${unknown.status}|${unknown.text}`);
    sql(`update public.integration_sources set status = 'inactive' where external_id = 'site-bravo-synthetic'`);
    const inactive = await post(webReq(`${RUN}-inactive`, {}, "site-bravo-synthetic"));
    sql(`update public.integration_sources set status = 'active' where external_id = 'site-bravo-synthetic'`);
    responses.push(`${inactive.status}|${inactive.text}`);
    sql(`update public.businesses set status = 'suspended' where id = '${BIZ_B}'`);
    const suspended = await post(webReq(`${RUN}-suspended`, {}, "site-bravo-synthetic"));
    sql(`update public.businesses set status = 'active' where id = '${BIZ_B}'`);
    responses.push(`${suspended.status}|${suspended.text}`);
    expect(new Set(responses).size).toBe(1);
    expect(unknown.status).toBe(403);
    expect(unknown.text).not.toMatch(/unknown|inactive|suspend|P0002|55000/);
    expect(Number(sql(`select count(*) from public.leads where source_event_id in ('${RUN}-unknown','${RUN}-inactive','${RUN}-suspended')`))).toBe(0);
  });
  it("payload business_id injection creates no lead", async () => {
    const id = `${RUN}-inject`;
    const r = await post(webReq(id, { business_id: BIZ_B }));
    expect(r.status).toBe(422);
    expect(r.text).not.toContain(BIZ_B);
    expect(leadsFor(id)).toBe(0);
    const top = await post({ ...webReq(`${RUN}-inject-top`), business_id: BIZ_B });
    expect(top.status).toBe(422);
    expect(leadsFor(`${RUN}-inject-top`)).toBe(0);
  });
  it("chunked oversized body is rejected with 413 and creates nothing", async () => {
    const id = `${RUN}-big`;
    const big = JSON.stringify(webReq(id, { details: "x".repeat(70_000) }));
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({ start(c) { const enc = new TextEncoder(); for (let i = 0; i < big.length; i += 8192) c.enqueue(enc.encode(big.slice(i, i + 8192))); c.close(); } }),
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(leadsFor(id)).toBe(0);
  });
  it("no secret appears in any response or in the application log; home page renders", async () => {
    const home = await fetch(BASE);
    const html = await home.text();
    expect(home.status).toBe(200);
    expect(html).toContain("SnowBeltTech Lead Portal");
    const log = serverLog.join("");
    for (const secret of [TOKEN, SERVICE_KEY]) {
      expect(html).not.toContain(secret);
      expect(log).not.toContain(secret);
    }
    expect(log).not.toContain("customer@example.invalid");
    expect(log).not.toContain("+15550100001");
    expect(log).not.toContain("Synthetic Customer");
    expect(log).toContain('"category":"unauthorized"');
    expect(log).toContain('"outcome":"lead_created"');
  });
});
