// Real-session lead workflow: status / follow-up / notes through the running
// production server and local Supabase Auth + RLS. No mocks.
// Prerequisites: pnpm run db:start && pnpm run env:local && pnpm build
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const BASE = "http://127.0.0.1:3000";
const CONTAINER = "supabase_db_Dashboard_SnowBeltTech";
const PASSWORD = "local-seed-only";
const BIZ_A = "a0000000-0000-4000-8000-000000000001";
const LEAD_A1 = "aa000000-0000-4000-8000-000000000001";
const LEAD_A3 = "aa000000-0000-4000-8000-000000000003";
const LEAD_B1 = "bb000000-0000-4000-8000-000000000001";
const A_STAFF = "a1000000-0000-4000-8000-000000000003";
const B_MARKERS = ["Bravo Plumbing (synthetic)", "Test Contact Four", "+15550100004", "contact-four@example.invalid"];

function env(name: string): string {
  const m = new RegExp(`^${name}=(.*)$`, "m").exec(readFileSync(path.join(ROOT, ".env.local"), "utf8"));
  if (!m) throw new Error(`${name} missing`);
  return m[1]!.trim();
}
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const INGEST_TOKEN = env("N8N_INGEST_TOKEN");

function sql(q: string): string {
  const r = spawnSync("docker", ["exec", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", q], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr}`);
  return r.stdout.trim();
}
const activityCount = (leadId: string, type?: string) =>
  Number(sql(`select count(*) from public.lead_activities where lead_id = '${leadId}'${type ? ` and activity_type = '${type}'` : ""}`));

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
  async post(p: string, form: Record<string, string>, extra: Record<string, string> = {}, rawBody?: BodyInit) {
    const res = await fetch(BASE + p, {
      method: "POST",
      headers: { cookie: this.header(), "content-type": "application/x-www-form-urlencoded", origin: BASE, ...extra },
      body: rawBody ?? new URLSearchParams(form).toString(),
      redirect: "manual",
      ...(rawBody instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit);
    this.absorb(res);
    return { status: res.status, location: res.headers.get("location"), text: await res.text(), headers: res.headers };
  }
}
async function login(email: string) {
  const s = new Session();
  const r = await s.post("/api/auth/login", { email, password: PASSWORD });
  if (r.status !== 303 || !r.location?.endsWith("/")) throw new Error(`login failed for ${email}: ${r.status}`);
  return s;
}
const act = (s: Session, leadId: string, form: Record<string, string>, extra?: Record<string, string>, raw?: BodyInit) =>
  s.post(`/api/leads/${leadId}/actions`, form, extra, raw);

let server: ChildProcess | null = null;
const serverLog: string[] = [];
const NOTE_SECRET_MARKER = `note-marker-${randomUUID()}`;

beforeAll(async () => {
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
  sql(`update public.businesses set status = 'active' where id = '${BIZ_A}';
       update public.business_memberships set status = 'active' where user_id = '${A_STAFF}';
       update public.profiles set is_active = true;
       update public.leads set status = 'new', follow_up_at = null where id = '${LEAD_A1}';
       update public.leads set status = 'contacted' where id = '${LEAD_A3}';`);
});

describe("request-size hardening", () => {
  it("oversized declared and chunked login bodies are rejected with 413 before parsing", async () => {
    const s = new Session();
    const big = "email=owner-a%40example.invalid&password=" + "x".repeat(5000);
    const declared = await s.post("/api/auth/login", {}, {}, big);
    expect(declared.status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({ start(c) { const enc = new TextEncoder(); for (let i = 0; i < 6; i++) c.enqueue(enc.encode("password=" + "y".repeat(1000) + "&")); c.close(); } });
    const chunked = await s.post("/api/auth/login", {}, {}, stream);
    expect(chunked.status).toBe(413);
    expect(s.header()).toBe("");
    const json = await s.post("/api/auth/login", {}, { "content-type": "application/json" }, JSON.stringify({ email: "x", password: "y" }));
    expect(json.status).toBe(415);
    expect((await login("owner-a@example.invalid")).header()).not.toBe("");
  });
  it("oversized action bodies are rejected with 413", async () => {
    const s = await login("owner-a@example.invalid");
    const big = `action=add_note&request_id=${randomUUID()}&note=` + "z".repeat(20_000);
    const r = await act(s, LEAD_A1, {}, {}, big);
    expect(r.status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({ start(c) { const enc = new TextEncoder(); for (let i = 0; i < 20; i++) c.enqueue(enc.encode("note=" + "w".repeat(1000) + "&")); c.close(); } });
    expect((await act(s, LEAD_A1, {}, {}, stream)).status).toBe(413);
    expect(activityCount(LEAD_A1, "note_added")).toBe(0);
  });
});

describe("status workflow", () => {
  it("owner, manager and staff can change status; each change is audited once; no-op is not", async () => {
    const before = activityCount(LEAD_A1, "status_changed");
    let expected = before;
    for (const [email, status] of [["owner-a@example.invalid", "contacted"], ["manager-a@example.invalid", "qualified"], ["staff-a@example.invalid", "scheduled"]] as const) {
      const s = await login(email);
      const r = await act(s, LEAD_A1, { action: "set_status", status });
      expect(r.status, email).toBe(303);
      expect(r.location, email).toMatch(new RegExp(`/dashboard/leads/${LEAD_A1}\\?ok=set_status$`));
      expected += 1;
      expect(activityCount(LEAD_A1, "status_changed"), email).toBe(expected);
      expect(sql(`select status from public.leads where id = '${LEAD_A1}'`)).toBe(status);
    }
    const s = await login("owner-a@example.invalid");
    const noop = await act(s, LEAD_A1, { action: "set_status", status: "scheduled" });
    expect(noop.status).toBe(303);
    expect(activityCount(LEAD_A1, "status_changed")).toBe(expected);
    const page = await s.get(`/dashboard/leads/${LEAD_A1}?ok=set_status`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Status updated.");
    expect(page.text).toContain("Status changed from Qualified to Scheduled");
    expect(page.text).toContain("Staff A (synthetic)");
    expect(page.text).toContain("Status changed from New to Contacted");
    const dash = await s.get("/dashboard");
    expect(dash.text).toMatch(/badge--scheduled/);
  });
  it("rejects arbitrary statuses, unexpected fields and tenant/actor injection", async () => {
    const s = await login("owner-a@example.invalid");
    const before = activityCount(LEAD_A1);
    expect((await act(s, LEAD_A1, { action: "set_status", status: "deleted" })).location).toMatch(/err=invalid_status$/);
    expect((await act(s, LEAD_A1, { action: "set_status", status: "won", business_id: "b0000000-0000-4000-8000-000000000001" })).location).toMatch(/err=unexpected_field$/);
    expect((await act(s, LEAD_A1, { action: "set_status", status: "won", actor_id: A_STAFF })).location).toMatch(/err=unexpected_field$/);
    expect((await act(s, LEAD_A1, { action: "set_status", status: "won", contact_name: "Hacked" })).location).toMatch(/err=unexpected_field$/);
    expect((await act(s, LEAD_A1, { action: "assign", status: "won" })).location).toMatch(/err=unsupported_action$/);
    expect(activityCount(LEAD_A1)).toBe(before);
    expect(sql(`select status from public.leads where id = '${LEAD_A1}'`)).toBe("scheduled");
  });
});

describe("follow-up in the business timezone", () => {
  it("stores the business-local time as the right UTC instant, displays it back, and can be cleared", async () => {
    const s = await login("owner-a@example.invalid");
    const set = await act(s, LEAD_A1, { action: "set_follow_up", date: "2026-09-01", time: "14:00" });
    expect(set.location).toMatch(/ok=set_follow_up$/);
    expect(sql(`select follow_up_at at time zone 'UTC' from public.leads where id = '${LEAD_A1}'`)).toBe("2026-09-01 18:00:00"); // 14:00 EDT
    const page = await s.get(`/dashboard/leads/${LEAD_A1}`);
    expect(page.text).toContain("Sep 1, 2026, 2:00 PM");
    expect(page.text).toContain("Follow-up scheduled for Sep 1, 2026, 2:00 PM");
    expect(page.text).toContain('value="2026-09-01"');
    expect(page.text).toContain('value="14:00"');
    const winter = await act(s, LEAD_A1, { action: "set_follow_up", date: "2026-12-01", time: "14:00" });
    expect(winter.location).toMatch(/ok=set_follow_up$/);
    expect(sql(`select follow_up_at at time zone 'UTC' from public.leads where id = '${LEAD_A1}'`)).toBe("2026-12-01 19:00:00"); // 14:00 EST
    const cleared = await act(s, LEAD_A1, { action: "clear_follow_up" });
    expect(cleared.location).toMatch(/ok=clear_follow_up$/);
    expect(sql(`select follow_up_at is null from public.leads where id = '${LEAD_A1}'`)).toBe("t");
    const after = await s.get(`/dashboard/leads/${LEAD_A1}`);
    expect(after.text).toContain("Follow-up cleared");
  });
  it("rejects invalid and DST-nonexistent times without changing anything", async () => {
    const s = await login("owner-a@example.invalid");
    const before = activityCount(LEAD_A1, "follow_up_changed");
    expect((await act(s, LEAD_A1, { action: "set_follow_up", date: "2026-03-08", time: "02:30" })).location).toMatch(/err=nonexistent_time$/);
    expect((await act(s, LEAD_A1, { action: "set_follow_up", date: "not-a-date", time: "10:00" })).location).toMatch(/err=invalid_follow_up$/);
    expect((await act(s, LEAD_A1, { action: "set_follow_up", date: "2026-02-30", time: "10:00" })).location).toMatch(/err=invalid_follow_up$/);
    expect(activityCount(LEAD_A1, "follow_up_changed")).toBe(before);
    const page = await s.get(`/dashboard/leads/${LEAD_A1}?err=nonexistent_time`);
    expect(page.text).toContain("daylight-saving change");
  });
});

describe("notes", () => {
  it("adds a note, renders it as text (no HTML execution), and replays idempotently", async () => {
    const s = await login("owner-a@example.invalid");
    const requestId = randomUUID();
    const note = `<script>alert(1)</script><b>bold</b> ${NOTE_SECRET_MARKER}`;
    const r = await act(s, LEAD_A3, { action: "add_note", note, request_id: requestId });
    expect(r.status).toBe(303);
    expect(r.location).toMatch(new RegExp(`/dashboard/leads/${LEAD_A3}\\?ok=add_note$`));
    expect(r.location).not.toContain("alert");
    expect(activityCount(LEAD_A3, "note_added")).toBe(1);
    const replay = await act(s, LEAD_A3, { action: "add_note", note: "different text same id", request_id: requestId });
    expect(replay.location).toMatch(/ok=add_note$/);
    expect(activityCount(LEAD_A3, "note_added")).toBe(1);
    expect(sql(`select note from public.lead_activities where lead_id = '${LEAD_A3}' and activity_type = 'note_added'`)).toBe(note);
    const page = await s.get(`/dashboard/leads/${LEAD_A3}?ok=add_note`);
    expect(page.text).toContain("Note added.");
    expect(page.text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&lt;b&gt;bold&lt;/b&gt;");
    expect(page.text).not.toContain("<script>alert(1)</script>");
    expect(page.text).toContain("Owner A (synthetic)");
    const staff = await login("staff-a@example.invalid");
    expect((await staff.get(`/dashboard/leads/${LEAD_A3}`)).text).toContain(NOTE_SECRET_MARKER);
    const second = await act(s, LEAD_A3, { action: "add_note", note: "Second note", request_id: randomUUID() });
    expect(second.location).toMatch(/ok=add_note$/);
    expect(activityCount(LEAD_A3, "note_added")).toBe(2);
  });
  it("rejects blank notes and bad request ids", async () => {
    const s = await login("owner-a@example.invalid");
    expect((await act(s, LEAD_A3, { action: "add_note", note: "   ", request_id: randomUUID() })).location).toMatch(/err=invalid_note$/);
    expect((await act(s, LEAD_A3, { action: "add_note", note: "x", request_id: "nope" })).location).toMatch(/err=invalid_request_id$/);
    expect(activityCount(LEAD_A3, "note_added")).toBe(2);
  });
});

describe("cross-tenant and revocation", () => {
  it("Business B cannot mutate or annotate a Business A lead; responses disclose nothing", async () => {
    const b = await login("owner-b@example.invalid");
    const before = activityCount(LEAD_A1);
    const statusBefore = sql(`select status from public.leads where id = '${LEAD_A1}'`);
    const r1 = await act(b, LEAD_A1, { action: "set_status", status: "spam" });
    const r2 = await act(b, LEAD_A1, { action: "add_note", note: "intrusion", request_id: randomUUID() });
    const r3 = await act(b, LEAD_A1, { action: "set_follow_up", date: "2026-09-01", time: "09:00" });
    const random = await act(b, "00000000-0000-4000-8000-00000000dead", { action: "set_status", status: "spam" });
    for (const r of [r1, r2, r3, random]) {
      expect(r.status).toBe(404);
      expect(r.text).toBe(JSON.stringify({ error: "not_found" }));
    }
    expect(activityCount(LEAD_A1)).toBe(before);
    expect(sql(`select status from public.leads where id = '${LEAD_A1}'`)).toBe(statusBefore);
    const a = await login("owner-a@example.invalid");
    const foreign = await act(a, LEAD_B1, { action: "set_status", status: "spam" });
    expect(foreign.status).toBe(404);
    expect(sql(`select status from public.leads where id = '${LEAD_B1}'`)).toBe("new");
    expect(Number(sql(`select count(*) from public.lead_activities where lead_id = '${LEAD_B1}'`))).toBe(0);
  });
  it("unauthenticated and cross-site posts are refused", async () => {
    const anon = new Session();
    expect((await act(anon, LEAD_A1, { action: "set_status", status: "won" })).status).toBe(401);
    const s = await login("owner-a@example.invalid");
    expect((await act(s, LEAD_A1, { action: "set_status", status: "won" }, { origin: "http://evil.example.invalid", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await act(s, LEAD_A1, { action: "set_status", status: "won" }, { "content-type": "application/json" }, JSON.stringify({ action: "set_status", status: "won" }))).status).toBe(415);
    expect(sql(`select status from public.leads where id = '${LEAD_A1}'`)).not.toBe("won");
  });
  it("revoked access loses mutation ability on the next request", async () => {
    const s = await login("staff-a@example.invalid");
    expect((await act(s, LEAD_A1, { action: "set_status", status: "contacted" })).status).toBe(303);
    const before = activityCount(LEAD_A1);
    sql(`update public.business_memberships set status = 'inactive' where user_id = '${A_STAFF}'`);
    expect((await act(s, LEAD_A1, { action: "set_status", status: "won" })).status).toBe(404);
    sql(`update public.business_memberships set status = 'active' where user_id = '${A_STAFF}'`);
    sql(`update public.businesses set status = 'suspended' where id = '${BIZ_A}'`);
    expect((await act(s, LEAD_A1, { action: "add_note", note: "x", request_id: randomUUID() })).status).toBe(404);
    sql(`update public.businesses set status = 'active' where id = '${BIZ_A}'`);
    expect(activityCount(LEAD_A1)).toBe(before);
    expect(sql(`select status from public.leads where id = '${LEAD_A1}'`)).toBe("contacted");
  });
});

describe("administrator inspection", () => {
  it("admin opens cross-tenant lead details with activity, also for a suspended business; customers cannot", async () => {
    const admin = await login("platform-admin@example.invalid");
    const page = await admin.get(`/admin/leads/${LEAD_A3}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Alpha HVAC (synthetic)");
    expect(page.text).toContain("INQ-2026-0003");
    expect(page.text).toContain(NOTE_SECRET_MARKER);
    expect(page.text).toContain("Owner A (synthetic)");
    expect(page.text).toContain("Read-only inspection");
    expect(page.text).not.toContain('action="/api/leads/');
    expect(page.headers.get("cache-control")).toContain("no-store");
    const overview = await admin.get("/admin");
    expect(overview.text).toContain(`href="/admin/leads/${LEAD_A1}"`);
    sql(`update public.businesses set status = 'suspended' where id = '${BIZ_A}'`);
    const suspended = await admin.get(`/admin/leads/${LEAD_A3}`);
    sql(`update public.businesses set status = 'active' where id = '${BIZ_A}'`);
    expect(suspended.status).toBe(200);
    expect(suspended.text).toContain("Suspended");
    expect(suspended.text).toContain(NOTE_SECRET_MARKER);
    expect((await admin.get("/admin/leads/00000000-0000-4000-8000-00000000dead")).status).toBe(404);
    expect((await admin.get("/admin/leads/junk")).status).toBe(404);
    const customer = await login("owner-a@example.invalid");
    const denied = await customer.get(`/admin/leads/${LEAD_B1}`);
    expect([302, 303, 307, 308]).toContain(denied.status);
    for (const m of B_MARKERS) expect(denied.text).not.toContain(m);
    expect((await admin.get(`/admin/leads/${LEAD_B1}`)).text).toContain("Bravo Plumbing (synthetic)");
  });
});

describe("regression and secret isolation", () => {
  it("ingestion endpoint unaffected; no secrets, notes or cookies in logs or redirects", async () => {
    const noAuth = await fetch(`${BASE}/api/internal/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(noAuth.status).toBe(401);
    const log = serverLog.join("");
    for (const forbidden of [SERVICE_KEY, INGEST_TOKEN, PASSWORD, NOTE_SECRET_MARKER, "alert(1)", "owner-a@example.invalid", "sb-127"]) {
      expect(log, forbidden.slice(0, 12)).not.toContain(forbidden);
    }
    expect(log).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\./);
    expect(log).toContain('"event":"lead_action"');
    const s = await login("owner-a@example.invalid");
    const page = await s.get(`/dashboard/leads/${LEAD_A3}`);
    expect(page.text).not.toContain(SERVICE_KEY);
    expect(page.text).not.toContain(INGEST_TOKEN);
    expect(page.text).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./);
  });
});
