// Real-session platform-administrator operations through the running production
// server and local Supabase Auth + RLS + the admin_* RPCs. No mocks, no
// service-role client for authorization. Runs FIRST (alphabetical) and removes
// every row it creates so later suites keep their absolute seeded counts.
// Prerequisites: pnpm run db:start && pnpm run env:local && pnpm build
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const BASE = "http://127.0.0.1:3000";
const CONTAINER = "supabase_db_Dashboard_SnowBeltTech";
const PASSWORD = "local-seed-only";
const RUN = `admin-it-${Date.now().toString(36)}`;
const BIZ_A = "a0000000-0000-4000-8000-000000000001";
const BIZ_B = "b0000000-0000-4000-8000-000000000001";
const ADMIN = "10000000-0000-4000-8000-000000000001";
const SLUG = "charlie-roofing-it";
const NAME = "Charlie Roofing (synthetic IT)";
const SRC_ID = `site-charlie-${RUN}`;
const C_MARKERS = [NAME, SLUG, SRC_ID, "Charlie Caller"];

function env(name: string): string {
  const m = new RegExp(`^${name}=(.*)$`, "m").exec(readFileSync(path.join(ROOT, ".env.local"), "utf8"));
  if (!m) throw new Error(`${name} missing`);
  return m[1]!.trim();
}
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const INGEST_TOKEN = env("N8N_INGEST_TOKEN");
const SUPABASE_URL = env("NEXT_PUBLIC_SUPABASE_URL");
const ANON_KEY = env("NEXT_PUBLIC_SUPABASE_ANON_KEY");

function sql(q: string): string {
  const r = spawnSync("docker", ["exec", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", q], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr}`);
  return r.stdout.trim();
}
const bizId = () => sql(`select coalesce((select id::text from public.businesses where slug = '${SLUG}'), '')`);
const bizStatus = (id: string) => sql(`select status from public.businesses where id = '${id}'`);
const srcRow = () => sql(`select coalesce((select id::text || '|' || business_id::text || '|' || status from public.integration_sources where kind = 'website_form' and external_id = '${SRC_ID}'), '')`);
const eventCount = (id: string) => Number(sql(`select count(*) from public.platform_admin_events where business_id = '${id}'`));

class Session {
  private jar = new Map<string, string>();
  absorb(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq), value = pair!.slice(eq + 1);
      if (value === "" || /max-age=0/i.test(c)) this.jar.delete(name); else this.jar.set(name, value);
    }
  }
  header() { return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; "); }
  async get(p: string) {
    const res = await fetch(BASE + p, { headers: { cookie: this.header() }, redirect: "manual" });
    this.absorb(res);
    return { status: res.status, location: res.headers.get("location"), text: await res.text(), headers: res.headers };
  }
  async post(p: string, form: Record<string, string>, extra: Record<string, string> = {}) {
    return this.postRaw(p, new URLSearchParams(form).toString(), extra);
  }
  async postRaw(p: string, body: string | ReadableStream<Uint8Array>, extra: Record<string, string> = {}) {
    const res = await fetch(BASE + p, {
      method: "POST",
      headers: { cookie: this.header(), "content-type": "application/x-www-form-urlencoded", origin: BASE, ...extra },
      body,
      redirect: "manual",
      ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit);
    this.absorb(res);
    return { status: res.status, location: res.headers.get("location"), text: await res.text(), headers: res.headers };
  }
}
async function login(email: string) {
  const s = new Session();
  const r = await s.post("/api/auth/login", { email, password: PASSWORD });
  if (r.status !== 303 || !r.location?.endsWith("/")) throw new Error(`login failed for ${email}`);
  return s;
}
const loc = (path: string, q: string) => new RegExp(`^http://[^/]+${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?${q}$`);

async function ingest(externalId: string, eventId: string, contact = "Charlie Caller") {
  const res = await fetch(`${BASE}/api/internal/ingest`, {
    method: "POST",
    headers: { authorization: `Bearer ${INGEST_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ source_kind: "website_form", source_external_id: externalId, source_event_id: eventId, payload: { contact_name: contact, phone_e164: "+15550100199", requested_service: "Roof inspection", sms_consent: false } }),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

let server: ChildProcess | null = null;
const serverLog: string[] = [];
const countersBeforeA = { n: "" };

beforeAll(async () => {
  countersBeforeA.n = sql(`select count(*) from public.lead_number_counters where business_id = '${BIZ_A}'`);
  const require = createRequire(import.meta.url);
  server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", "3000"], { cwd: ROOT, env: { ...process.env, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout!.on("data", (d) => serverLog.push(String(d)));
  server.stderr!.on("data", (d) => serverLog.push(String(d)));
  const deadline = Date.now() + 60_000;
  for (;;) {
    try { if ((await fetch(`${BASE}/login`)).ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${serverLog.join("")}`);
    await new Promise((r) => setTimeout(r, 500));
  }
});

afterAll(() => {
  if (server?.pid) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"]); else server.kill("SIGTERM");
  }
  // Remove everything this run created (FK order), restore seeded state. Privileged SQL is used ONLY for cleanup.
  const id = bizId();
  if (id) {
    sql(`delete from public.ingestion_events where business_id = '${id}';
         delete from public.lead_activities where business_id = '${id}';
         delete from public.leads where business_id = '${id}';
         delete from public.lead_number_counters where business_id = '${id}';
         delete from public.platform_admin_events where business_id = '${id}';
         delete from public.integration_sources where business_id = '${id}';
         delete from public.businesses where id = '${id}';`);
  }
  sql(`delete from public.ingestion_events where source_event_id like '${RUN}%';
       delete from public.leads where source_event_id like '${RUN}%';
       delete from public.platform_admin_events where business_id in ('${BIZ_A}', '${BIZ_B}');
       update public.businesses set status = 'active' where id in ('${BIZ_A}', '${BIZ_B}');
       update public.integration_sources set status = 'active' where business_id in ('${BIZ_A}', '${BIZ_B}');`);
  if (countersBeforeA.n === "0") sql(`delete from public.lead_number_counters where business_id = '${BIZ_A}'`);
});

describe("business onboarding", () => {
  it("1-2: the administrator creates a synthetic business and it appears in /admin and its detail page", async () => {
    const admin = await login("platform-admin@example.invalid");
    const form = await admin.get("/admin/businesses/new");
    expect(form.status).toBe(200);
    expect(form.text).toContain('action="/api/admin/businesses/actions"');
    const r = await admin.post("/api/admin/businesses/actions", { action: "create_business", name: NAME, slug: SLUG, industry: "roofing", timezone: "America/Denver" });
    expect(r.status).toBe(303);
    const id = bizId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.location).toMatch(loc(`/admin/businesses/${id}`, "ok=business_created"));
    expect(r.location).not.toContain(SLUG);
    expect(sql(`select name || '|' || industry || '|' || timezone || '|' || status from public.businesses where id = '${id}'`)).toBe(`${NAME}|roofing|America/Denver|active`);
    expect(sql(`select event_type || '|' || actor_id::text || '|' || actor_display_name || '|' || new_value from public.platform_admin_events where business_id = '${id}'`)).toBe(`business_created|${ADMIN}|Platform Admin (synthetic)|active`);
    const overview = await admin.get("/admin");
    expect(overview.text).toContain(NAME);
    expect(overview.text).toContain(`href="/admin/businesses/${id}"`);
    const detail = await admin.get(`/admin/businesses/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.headers.get("cache-control")).toContain("no-store");
    for (const m of [NAME, SLUG, "America/Denver", "Roofing", "Business created", "Platform operations history", "Suspend business", 'value="create_source"']) expect(detail.text, m).toContain(m);
  });
  it("creation rejects a duplicate slug, bad input and malformed requests without creating anything", async () => {
    const admin = await login("platform-admin@example.invalid");
    const before = Number(sql("select count(*) from public.businesses"));
    const cases: Array<[string, Record<string, string> | string, string]> = [
      ["duplicate slug", { action: "create_business", name: "Dup", slug: SLUG, industry: "hvac", timezone: "UTC" }, "slug_taken"],
      ["seeded slug", { action: "create_business", name: "Dup", slug: "alpha-hvac", industry: "hvac", timezone: "UTC" }, "slug_taken"],
      ["bad slug", { action: "create_business", name: "X", slug: "Bad Slug", industry: "hvac", timezone: "UTC" }, "invalid_slug"],
      ["bad industry", { action: "create_business", name: "X", slug: "x-it", industry: "banking", timezone: "UTC" }, "invalid_industry"],
      ["fake timezone", { action: "create_business", name: "X", slug: "x-it", industry: "hvac", timezone: "Mars/Olympus_Mons" }, "invalid_timezone"],
      ["wrong-case timezone (database authority)", { action: "create_business", name: "X", slug: "x-it", industry: "hvac", timezone: "america/denver" }, "invalid_timezone"],
      ["missing field", "action=create_business&name=X&slug=x-it&industry=hvac", "missing_field"],
      ["duplicate field", `action=create_business&name=X&name=Y&slug=x-it&industry=hvac&timezone=UTC`, "duplicate_field"],
      ["unexpected field", { action: "create_business", name: "X", slug: "x-it", industry: "hvac", timezone: "UTC", platform_role: "PLATFORM_ADMIN" }, "unexpected_field"],
      ["unsupported action", { action: "delete_business", name: "X", slug: "x-it", industry: "hvac", timezone: "UTC" }, "unsupported_action"],
    ];
    for (const [label, body, code] of cases) {
      const r = typeof body === "string" ? await admin.postRaw("/api/admin/businesses/actions", body) : await admin.post("/api/admin/businesses/actions", body);
      expect(r.status, label).toBe(303);
      expect(r.location, label).toMatch(loc("/admin/businesses/new", `err=${code}`));
    }
    expect(Number(sql("select count(*) from public.businesses"))).toBe(before);
    expect(sql(`select count(*) from public.businesses where slug = 'x-it'`)).toBe("0");
  });
});

describe("integration sources and ingestion", () => {
  it("4-6: registering a website source makes the ingestion endpoint route a lead into the new business, which the administrator can inspect", async () => {
    const admin = await login("platform-admin@example.invalid");
    const id = bizId();
    const r = await admin.post(`/api/admin/businesses/${id}/actions`, { action: "create_source", kind: "website_form", external_id: SRC_ID, label: "Charlie website form", allowed_origin: "https://charlie.example.invalid" });
    expect(r.location).toMatch(loc(`/admin/businesses/${id}`, "ok=source_created"));
    expect(r.location).not.toContain(SRC_ID);
    const [srcId, srcBiz, srcStatus] = srcRow().split("|");
    expect(srcBiz).toBe(id);
    expect(srcStatus).toBe("active");
    const detail = await admin.get(`/admin/businesses/${id}`);
    for (const m of [SRC_ID, "Charlie website form", "https://charlie.example.invalid", "Registered Charlie website form", `value="${srcId}"`, "Deactivate"]) expect(detail.text, m).toContain(m);
    const ing = await ingest(SRC_ID, `${RUN}-lead-1`);
    expect(ing.status).toBe(201);
    expect(ing.json?.outcome).toBe("lead_created");
    const leadId = sql(`select id::text from public.leads where source_event_id = '${RUN}-lead-1'`);
    expect(sql(`select business_id::text from public.leads where id = '${leadId}'`)).toBe(id);
    const lead = await admin.get(`/admin/leads/${leadId}`);
    expect(lead.status).toBe(200);
    expect(lead.text).toContain("Charlie Caller");
    expect(lead.text).toContain(NAME);
    const overview = await admin.get("/admin");
    expect(overview.text).toContain("Charlie Caller");
  });
  it("8-9: deactivating the source yields the existing opaque ingestion rejection; reactivating restores it", async () => {
    const admin = await login("platform-admin@example.invalid");
    const id = bizId();
    const [srcId] = srcRow().split("|");
    const off = await admin.post(`/api/admin/businesses/${id}/actions`, { action: "set_source_status", source_id: srcId!, status: "inactive" });
    expect(off.location).toMatch(loc(`/admin/businesses/${id}`, "ok=source_status_updated"));
    expect(srcRow().endsWith("|inactive")).toBe(true);
    const rejected = await ingest(SRC_ID, `${RUN}-lead-2`);
    expect(rejected.status).toBe(403);
    expect(rejected.json).toEqual({ error: "source_not_accepted" });
    expect(sql(`select count(*) from public.leads where source_event_id = '${RUN}-lead-2'`)).toBe("0");
    const noop = await admin.post(`/api/admin/businesses/${id}/actions`, { action: "set_source_status", source_id: srcId!, status: "inactive" });
    expect(noop.location).toMatch(/ok=source_status_updated$/);
    const eventsAfterNoop = eventCount(id);
    const on = await admin.post(`/api/admin/businesses/${id}/actions`, { action: "set_source_status", source_id: srcId!, status: "active" });
    expect(on.location).toMatch(/ok=source_status_updated$/);
    expect(eventCount(id)).toBe(eventsAfterNoop + 1); // the no-op wrote nothing; the real change wrote one
    const accepted = await ingest(SRC_ID, `${RUN}-lead-2`);
    expect(accepted.status).toBe(201);
    expect(sql(`select old_value || '>' || new_value from public.platform_admin_events where integration_source_id = '${srcId}' and event_type = 'integration_source_status_changed' order by created_at`)).toBe("active>inactive\ninactive>active");
  });
  it("12-13: another business's identifier cannot be claimed, unsupported kinds and bad origins are rejected, nothing changes", async () => {
    const admin = await login("platform-admin@example.invalid");
    const id = bizId();
    const srcCount = Number(sql(`select count(*) from public.integration_sources`));
    const events = eventCount(id);
    const cases: Array<[string, Record<string, string>, string]> = [
      ["seeded Alpha identifier", { action: "create_source", kind: "website_form", external_id: "site-alpha-synthetic", label: "hijack" }, "source_taken"],
      ["own identifier again", { action: "create_source", kind: "website_form", external_id: SRC_ID }, "source_taken"],
      ["twilio_number", { action: "create_source", kind: "twilio_number", external_id: "+15550100999" }, "invalid_kind"],
      ["unknown kind", { action: "create_source", kind: "sms", external_id: "x" }, "invalid_kind"],
      ["padded identifier", { action: "create_source", kind: "website_form", external_id: " padded " }, "invalid_external_id"],
      ["http origin", { action: "create_source", kind: "website_form", external_id: `o-${RUN}`, allowed_origin: "http://charlie.example.invalid" }, "invalid_origin"],
      ["origin with path", { action: "create_source", kind: "website_form", external_id: `o-${RUN}`, allowed_origin: "https://charlie.example.invalid/form" }, "invalid_origin"],
      ["origin on voice source", { action: "create_source", kind: "vapi_assistant", external_id: `asst-${RUN}`, allowed_origin: "https://charlie.example.invalid" }, "invalid_origin"],
      ["malformed source id", { action: "set_source_status", source_id: "not-a-uuid", status: "inactive" }, "invalid_source"],
      ["foreign source id", { action: "set_source_status", source_id: "a3000000-0000-4000-8000-000000000001", status: "inactive" }, "not_found"],
      ["archived status", { action: "set_business_status", status: "archived" }, "invalid_status"],
      ["tenant field", { action: "create_source", kind: "website_form", external_id: `t-${RUN}`, business_id: BIZ_A }, "unexpected_field"],
    ];
    for (const [label, body, code] of cases) {
      const r = await admin.post(`/api/admin/businesses/${id}/actions`, body);
      expect(r.status, label).toBe(303);
      expect(r.location, label).toMatch(loc(`/admin/businesses/${id}`, `err=${code}`));
      expect(r.location, label).not.toContain("site-alpha");
    }
    expect(Number(sql(`select count(*) from public.integration_sources`))).toBe(srcCount);
    expect(sql(`select business_id::text || '|' || status from public.integration_sources where kind = 'website_form' and external_id = 'site-alpha-synthetic'`)).toBe(`${BIZ_A}|active`);
    expect(eventCount(id)).toBe(events);
  });
});

describe("business lifecycle", () => {
  it("10-11: suspending a seeded business removes customer access and blocks ingestion; reactivation restores both", async () => {
    const admin = await login("platform-admin@example.invalid");
    const owner = await login("owner-a@example.invalid");
    expect((await owner.get("/dashboard")).status).toBe(200);
    const eventsBefore = eventCount(BIZ_A);
    const off = await admin.post(`/api/admin/businesses/${BIZ_A}/actions`, { action: "set_business_status", status: "suspended" });
    expect(off.location).toMatch(loc(`/admin/businesses/${BIZ_A}`, "ok=business_status_updated"));
    expect(bizStatus(BIZ_A)).toBe("suspended");
    const dash = await owner.get("/dashboard");
    expect(dash.status).not.toBe(200);
    expect(dash.location).toMatch(/\/no-access$/);
    const blocked = await ingest("site-alpha-synthetic", `${RUN}-alpha-1`, "Synthetic Alpha");
    expect(blocked.status).toBe(403);
    expect(blocked.json).toEqual({ error: "source_not_accepted" });
    const noop = await admin.post(`/api/admin/businesses/${BIZ_A}/actions`, { action: "set_business_status", status: "suspended" });
    expect(noop.location).toMatch(/ok=business_status_updated$/);
    expect(eventCount(BIZ_A)).toBe(eventsBefore + 1);
    const detail = await admin.get(`/admin/businesses/${BIZ_A}`);
    expect(detail.text).toContain("Reactivate business");
    expect(detail.text).toContain("Business active → suspended");
    expect(detail.text).toContain("Alpha website form"); // configuration and sources are preserved
    const on = await admin.post(`/api/admin/businesses/${BIZ_A}/actions`, { action: "set_business_status", status: "active" });
    expect(on.location).toMatch(/ok=business_status_updated$/);
    expect(bizStatus(BIZ_A)).toBe("active");
    expect((await owner.get("/dashboard")).status).toBe(200);
    const restored = await ingest("site-alpha-synthetic", `${RUN}-alpha-1`, "Synthetic Alpha");
    expect(restored.status).toBe(201);
    expect(eventCount(BIZ_A)).toBe(eventsBefore + 2);
    expect(sql(`select count(*) from public.integration_sources where business_id = '${BIZ_A}' and status = 'active'`)).toBe("2");
  });
  it("archived businesses are visible but not operable", async () => {
    const admin = await login("platform-admin@example.invalid");
    sql(`update public.businesses set status = 'archived' where id = '${BIZ_B}'`);
    try {
      const detail = await admin.get(`/admin/businesses/${BIZ_B}`);
      expect(detail.status).toBe(200);
      expect(detail.text).toContain("archived");
      expect(detail.text).not.toContain('value="set_business_status"');
      expect(detail.text).not.toContain('value="create_source"');
      expect(detail.text).not.toContain('value="set_source_status"');
      const r = await admin.post(`/api/admin/businesses/${BIZ_B}/actions`, { action: "set_business_status", status: "active" });
      expect(r.location).toMatch(loc(`/admin/businesses/${BIZ_B}`, "err=not_operable"));
      expect(bizStatus(BIZ_B)).toBe("archived");
    } finally {
      sql(`update public.businesses set status = 'active' where id = '${BIZ_B}'`);
    }
  });
});

describe("tenant isolation and administrator boundaries", () => {
  it("3, 7, 14, 16: customers cannot reach administrator pages, endpoints, the new business, its sources, or the ledger — in the UI or directly at the database", async () => {
    const id = bizId();
    const leadId = sql(`select id::text from public.leads where source_event_id = '${RUN}-lead-1'`);
    for (const email of ["owner-a@example.invalid", "owner-b@example.invalid", "staff-a@example.invalid"]) {
      const s = await login(email);
      for (const p of [`/admin/businesses/${id}`, "/admin/businesses/new", `/admin/leads/${leadId}`, "/admin"]) {
        const r = await s.get(p);
        expect(r.status, `${email} ${p}`).not.toBe(200);
        for (const m of C_MARKERS) expect(r.text, `${email} ${p}`).not.toContain(m);
        expect(r.text, `${email} ${p}`).not.toContain("Platform operations history");
      }
      expect((await s.post("/api/admin/businesses/actions", { action: "create_business", name: "X", slug: `x-${RUN}`, industry: "hvac", timezone: "UTC" })).status, email).toBe(404);
      expect((await s.post(`/api/admin/businesses/${id}/actions`, { action: "set_business_status", status: "suspended" })).status, email).toBe(404);
      expect((await s.post(`/api/admin/businesses/${BIZ_A}/actions`, { action: "create_source", kind: "website_form", external_id: `x-${RUN}` })).status, email).toBe(404);
      const dash = await s.get("/dashboard");
      for (const m of C_MARKERS) expect(dash.text, email).not.toContain(m);
      expect((await s.get(`/dashboard/leads/${leadId}`)).status, email).not.toBe(200);
      // direct database boundary under the customer's own real session (anon key), not via the app
      const sb = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      expect((await sb.auth.signInWithPassword({ email, password: PASSWORD })).error).toBeNull();
      try {
        const create = await sb.rpc("admin_create_business", { p_name: "Direct", p_slug: `direct-${RUN}`, p_industry: "hvac", p_timezone: "UTC" });
        expect(create.error?.code, email).toBe("42501");
        const suspend = await sb.rpc("admin_set_business_status", { p_business_id: BIZ_A, p_status: "suspended" });
        expect(suspend.error?.code, email).toBe("42501");
        const src = await sb.rpc("admin_create_integration_source", { p_business_id: BIZ_A, p_kind: "website_form", p_external_id: `direct-${RUN}`, p_label: null, p_allowed_origin: null });
        expect(src.error?.code, email).toBe("42501");
        const biz = await sb.from("businesses").select("id").eq("id", id);
        expect(biz.data, email).toEqual([]);
        const sources = await sb.from("integration_sources").select("id");
        expect(sources.data, email).toEqual([]);
        const events = await sb.from("platform_admin_events").select("id");
        expect(events.data, email).toEqual([]);
        const leads = await sb.from("leads").select("id").eq("id", leadId);
        expect(leads.data, email).toEqual([]);
      } finally {
        await sb.auth.signOut({ scope: "local" });
      }
    }
    expect(sql(`select count(*) from public.businesses where slug like 'direct-%' or slug like 'x-%'`)).toBe("0");
    expect(bizStatus(BIZ_A)).toBe("active");
    const anon = new Session();
    expect((await anon.post("/api/admin/businesses/actions", { action: "create_business", name: "X", slug: "anon", industry: "hvac", timezone: "UTC" })).status).toBe(401);
    expect((await anon.get(`/admin/businesses/${id}`)).location).toMatch(/\/login$/);
  });
  it("15: administrator lead pages remain read-only (no assignment or lead-editing forms)", async () => {
    const admin = await login("platform-admin@example.invalid");
    const leadId = sql(`select id::text from public.leads where source_event_id = '${RUN}-lead-1'`);
    for (const p of [`/admin/leads/${leadId}`, "/admin/leads/aa000000-0000-4000-8000-000000000001"]) {
      const r = await admin.get(p);
      expect(r.status, p).toBe(200);
      expect(r.text, p).not.toContain('name="assignee_id"');
      expect(r.text, p).not.toContain('value="set_status"');
      expect(r.text, p).not.toContain('value="add_note"');
      expect(r.text, p).not.toContain("/api/leads/");
      expect(r.text, p).toContain("Read-only inspection");
    }
    expect((await admin.post(`/api/leads/${leadId}/actions`, { action: "set_status", status: "contacted" })).status).toBe(404);
    const detail = await admin.get(`/admin/businesses/${bizId()}`);
    expect(detail.text).not.toContain("/api/leads/");
  });
  it("17: cross-site, oversized (incl. chunked), wrong media type, unexpected/duplicate fields and malformed ids are rejected safely", async () => {
    const admin = await login("platform-admin@example.invalid");
    const id = bizId();
    const events = eventCount(id);
    const srcCount = Number(sql(`select count(*) from public.integration_sources`));
    expect((await admin.post(`/api/admin/businesses/${id}/actions`, { action: "set_business_status", status: "suspended" }, { origin: "https://evil.example.invalid", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await admin.post("/api/admin/businesses/actions", { action: "create_business", name: "X", slug: `x-${RUN}`, industry: "hvac", timezone: "UTC" }, { origin: "https://evil.example.invalid" })).status).toBe(403);
    const big = `action=create_source&kind=website_form&external_id=${"x".repeat(20_000)}`;
    expect((await admin.postRaw(`/api/admin/businesses/${id}/actions`, big)).status).toBe(413);
    const chunked = new ReadableStream<Uint8Array>({ start(c) { const enc = new TextEncoder(); for (let i = 0; i < big.length; i += 4096) c.enqueue(enc.encode(big.slice(i, i + 4096))); c.close(); } });
    expect((await admin.postRaw(`/api/admin/businesses/${id}/actions`, chunked)).status).toBe(413);
    expect((await admin.postRaw(`/api/admin/businesses/${id}/actions`, JSON.stringify({ action: "set_business_status", status: "suspended" }), { "content-type": "application/json" })).status).toBe(415);
    expect((await admin.post(`/api/admin/businesses/not-a-uuid/actions`, { action: "set_business_status", status: "suspended" })).status).toBe(404);
    expect((await admin.post(`/api/admin/businesses/00000000-0000-4000-8000-00000000dead/actions`, { action: "set_business_status", status: "suspended" })).location).toMatch(/err=not_found$/);
    expect((await admin.postRaw(`/api/admin/businesses/${id}/actions`, "action=set_business_status&status=suspended&status=active")).location).toMatch(/err=duplicate_field$/);
    expect((await admin.postRaw(`/api/admin/businesses/${id}/actions`, "action=set_business_status&status=suspended&actor_id=x")).location).toMatch(/err=unexpected_field$/);
    expect((await admin.postRaw(`/api/admin/businesses/${id}/actions`, "action=set_business_status")).location).toMatch(/err=missing_field$/);
    expect((await admin.get("/admin/businesses/not-a-uuid")).status).toBe(404);
    expect(bizStatus(id)).toBe("active");
    expect(bizStatus(BIZ_A)).toBe("active");
    expect(eventCount(id)).toBe(events);
    expect(Number(sql(`select count(*) from public.integration_sources`))).toBe(srcCount);
  });
});

describe("secret and data isolation", () => {
  it("18: no service key, ingestion token, password, JWT, email, submitted identifier or customer details in server logs or browser bundles", async () => {
    const log = serverLog.join("");
    for (const forbidden of [SERVICE_KEY, INGEST_TOKEN, PASSWORD, SRC_ID, NAME, SLUG, "Charlie Caller", "platform-admin@example.invalid", "owner-a@example.invalid", "+15550100199"]) {
      expect(log, forbidden.slice(0, 12)).not.toContain(forbidden);
    }
    expect(log).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\./);
    expect(log).toContain('"event":"admin_platform_action"');
    expect(log).toContain('"event":"admin_business_action"');
    const files: string[] = [];
    const walk = (dir: string) => { for (const f of readdirSync(dir)) { const p = path.join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(js|css|json|html|txt)$/.test(f)) files.push(p); } };
    walk(path.join(ROOT, ".next", "static"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const forbidden of [SERVICE_KEY, INGEST_TOKEN, "SUPABASE_SERVICE_ROLE_KEY", "N8N_INGEST_TOKEN", "supabase-admin"]) expect(text, path.basename(f)).not.toContain(forbidden);
    }
  });
});
