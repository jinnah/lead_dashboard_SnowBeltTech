// Real-session lead assignment through the running production server and local
// Supabase Auth + RLS + set_lead_assignee. No mocks.
// Prerequisites: pnpm run db:start && pnpm run env:local && pnpm build
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const BASE = "http://127.0.0.1:3000";
const CONTAINER = "supabase_db_Dashboard_SnowBeltTech";
const PASSWORD = "local-seed-only";
const BIZ_A = "a0000000-0000-4000-8000-000000000001";
const LEAD_A1 = "aa000000-0000-4000-8000-000000000001"; // seeded: assigned to manager A
const LEAD_A2 = "aa000000-0000-4000-8000-000000000002"; // seeded: unassigned (voice)
const LEAD_A3 = "aa000000-0000-4000-8000-000000000003"; // seeded: unassigned (manual)
const LEAD_B1 = "bb000000-0000-4000-8000-000000000001";
const A_OWNER = "a1000000-0000-4000-8000-000000000001";
const A_MANAGER = "a1000000-0000-4000-8000-000000000002";
const A_STAFF = "a1000000-0000-4000-8000-000000000003";
const A_FORMER = "a1000000-0000-4000-8000-000000000004";
const B_OWNER = "b1000000-0000-4000-8000-000000000001";
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
const assignedTo = (leadId: string) => sql(`select coalesce(assigned_to::text, '') from public.leads where id = '${leadId}'`);
const assignActs = (leadId: string) => Number(sql(`select count(*) from public.lead_activities where lead_id = '${leadId}' and activity_type = 'assignment_changed'`));

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
    const res = await fetch(BASE + p, {
      method: "POST",
      headers: { cookie: this.header(), "content-type": "application/x-www-form-urlencoded", origin: BASE, ...extra },
      body: new URLSearchParams(form).toString(),
      redirect: "manual",
    });
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
const assign = (s: Session, leadId: string, assignee: string) => s.post(`/api/leads/${leadId}/actions`, { action: "set_assignee", assignee_id: assignee });
/** Text of the lead rows in the list (table body only), to check which leads a filter returned. */
const listedLeads = (html: string) => ["INQ-2026-0001", "INQ-2026-0002", "INQ-2026-0003"].filter((n) => html.includes(`/dashboard/leads/${leadIdFor(n)}"`));
const leadIdFor = (n: string) => ({ "INQ-2026-0001": LEAD_A1, "INQ-2026-0002": LEAD_A2, "INQ-2026-0003": LEAD_A3 })[n]!;

let server: ChildProcess | null = null;
const serverLog: string[] = [];

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
       update public.business_memberships set status = 'active' where user_id in ('${A_OWNER}', '${A_MANAGER}', '${A_STAFF}');
       update public.profiles set is_active = true;
       update public.leads set assigned_to = '${A_MANAGER}' where id = '${LEAD_A1}';
       update public.leads set assigned_to = null where id in ('${LEAD_A2}', '${LEAD_A3}');`);
});

describe("assignment authorization", () => {
  it("owner assigns; manager reassigns; unassignment works; no-op adds no activity", async () => {
    const owner = await login("owner-a@example.invalid");
    const before = assignActs(LEAD_A2);
    const r1 = await assign(owner, LEAD_A2, A_STAFF);
    expect(r1.status).toBe(303);
    expect(r1.location).toMatch(new RegExp(`/dashboard/leads/${LEAD_A2}\\?ok=set_assignee$`));
    expect(assignedTo(LEAD_A2)).toBe(A_STAFF);
    expect(assignActs(LEAD_A2)).toBe(before + 1);
    const noop = await assign(owner, LEAD_A2, A_STAFF);
    expect(noop.location).toMatch(/ok=set_assignee$/);
    expect(assignActs(LEAD_A2)).toBe(before + 1);
    const manager = await login("manager-a@example.invalid");
    const r2 = await assign(manager, LEAD_A2, A_OWNER);
    expect(r2.location).toMatch(/ok=set_assignee$/);
    expect(assignedTo(LEAD_A2)).toBe(A_OWNER);
    const r3 = await assign(manager, LEAD_A2, "");
    expect(r3.location).toMatch(/ok=set_assignee$/);
    expect(assignedTo(LEAD_A2)).toBe("");
    expect(assignActs(LEAD_A2)).toBe(before + 3);
    expect(sql(`select old_display_value || '>' || coalesce(new_display_value, '-') from public.lead_activities where lead_id = '${LEAD_A2}' and activity_type = 'assignment_changed' and new_value is null order by created_at desc limit 1`)).toBe("Owner A (synthetic)>-");
  });
  it("staff crafted POST, platform admin and Business B are rejected; values never reach URLs", async () => {
    const staff = await login("staff-a@example.invalid");
    const s1 = await assign(staff, LEAD_A3, A_STAFF);
    expect(s1.status).toBe(303);
    expect(s1.location).toMatch(new RegExp(`/dashboard/leads/${LEAD_A3}\\?err=not_allowed$`));
    expect(s1.location).not.toContain(A_STAFF);
    expect(assignedTo(LEAD_A3)).toBe("");
    const admin = await login("platform-admin@example.invalid");
    expect((await assign(admin, LEAD_A3, A_STAFF)).status).toBe(404);
    const b = await login("owner-b@example.invalid");
    expect((await assign(b, LEAD_A3, B_OWNER)).status).toBe(404);
    expect((await assign(b, LEAD_A3, A_STAFF)).status).toBe(404);
    const owner = await login("owner-a@example.invalid");
    expect((await assign(owner, LEAD_B1, A_STAFF)).status).toBe(404);
    const foreign = await assign(owner, LEAD_A3, B_OWNER);
    expect(foreign.location).toMatch(/err=assignment_rejected$/);
    const former = await assign(owner, LEAD_A3, A_FORMER);
    expect(former.location).toMatch(/err=assignment_rejected$/);
    const bad = await assign(owner, LEAD_A3, "not-a-uuid");
    expect(bad.location).toMatch(/err=invalid_assignee$/);
    const extra = await owner.post(`/api/leads/${LEAD_A3}/actions`, { action: "set_assignee", assignee_id: A_STAFF, business_id: BIZ_A });
    expect(extra.location).toMatch(/err=unassigned_field$|err=unexpected_field$/);
    expect(assignedTo(LEAD_A3)).toBe("");
    expect(assignedTo(LEAD_B1)).toBe(B_OWNER);
    expect(assignActs(LEAD_A3)).toBe(0);
  });
  it("revoked membership, profile or business loses assignment ability on the next request", async () => {
    const manager = await login("manager-a@example.invalid");
    sql(`update public.business_memberships set status = 'inactive' where user_id = '${A_MANAGER}'`);
    expect((await assign(manager, LEAD_A3, A_STAFF)).status).toBe(404);
    sql(`update public.business_memberships set status = 'active' where user_id = '${A_MANAGER}'`);
    sql(`update public.profiles set is_active = false where id = '${A_MANAGER}'`);
    expect((await assign(manager, LEAD_A3, A_STAFF)).status).toBe(404);
    sql(`update public.profiles set is_active = true where id = '${A_MANAGER}'`);
    sql(`update public.businesses set status = 'suspended' where id = '${BIZ_A}'`);
    expect((await assign(manager, LEAD_A3, A_STAFF)).status).toBe(404);
    sql(`update public.businesses set status = 'active' where id = '${BIZ_A}'`);
    expect(assignedTo(LEAD_A3)).toBe("");
    expect((await assign(manager, LEAD_A3, A_STAFF)).location).toMatch(/ok=set_assignee$/);
    expect(assignedTo(LEAD_A3)).toBe(A_STAFF);
  });
});

describe("assignment visibility and filters", () => {
  it("appears on customer detail (with form for owner, read-only for staff), in the list and in admin views", async () => {
    const owner = await login("owner-a@example.invalid");
    const detail = await owner.get(`/dashboard/leads/${LEAD_A3}`);
    expect(detail.text).toContain("Staff A (synthetic)");
    expect(detail.text).toContain('name="assignee_id"');
    expect(detail.text).toContain("Assigned to Staff A (synthetic)");
    const staff = await login("staff-a@example.invalid");
    const staffDetail = await staff.get(`/dashboard/leads/${LEAD_A3}`);
    expect(staffDetail.status).toBe(200);
    expect(staffDetail.text).toContain("Staff A (synthetic)");
    expect(staffDetail.text).not.toContain('name="assignee_id"');
    expect(staffDetail.text).toContain("Owners and managers manage assignments");
    const list = await staff.get("/dashboard");
    expect(list.text).toContain("Manager A (synthetic)"); // A1 assignee
    expect(list.text).toContain("Unassigned");
    const admin = await login("platform-admin@example.invalid");
    const adminDetail = await admin.get(`/admin/leads/${LEAD_A3}`);
    expect(adminDetail.text).toMatch(/Assigned to: <strong>Staff A \(synthetic\)<\/strong>/);
    expect(adminDetail.text).toContain("Assigned to Staff A (synthetic)");
    expect(adminDetail.text).not.toContain('name="assignee_id"');
    const overview = await admin.get("/admin");
    expect(overview.text).toContain("Staff A (synthetic)");
  });
  it("mine / unassigned / teammate filters and combinations are applied in the database", async () => {
    // state now: A1 -> manager, A2 -> unassigned, A3 -> staff
    const staff = await login("staff-a@example.invalid");
    expect(listedLeads((await staff.get("/dashboard?assignment=mine")).text)).toEqual(["INQ-2026-0003"]);
    expect(listedLeads((await staff.get("/dashboard?assignment=unassigned")).text)).toEqual(["INQ-2026-0002"]);
    expect(listedLeads((await staff.get(`/dashboard?assignment=${A_MANAGER}`)).text)).toEqual(["INQ-2026-0001"]);
    expect(listedLeads((await staff.get("/dashboard")).text)).toEqual(["INQ-2026-0001", "INQ-2026-0002", "INQ-2026-0003"]);
    expect(listedLeads((await staff.get(`/dashboard?assignment=${A_MANAGER}&status=new`)).text)).toEqual(["INQ-2026-0001"]);
    expect(listedLeads((await staff.get(`/dashboard?assignment=${A_MANAGER}&status=contacted`)).text)).toEqual([]);
    expect(listedLeads((await staff.get("/dashboard?assignment=unassigned&source=voice_call")).text)).toEqual(["INQ-2026-0002"]);
    expect(listedLeads((await staff.get("/dashboard?assignment=unassigned&source=website_form")).text)).toEqual([]);
    expect(listedLeads((await staff.get("/dashboard?assignment=mine&source=manual")).text)).toEqual(["INQ-2026-0003"]);
  });
  it("foreign, inactive and injection-shaped filter values reveal nothing and fall back to all", async () => {
    const owner = await login("owner-a@example.invalid");
    for (const v of [B_OWNER, A_FORMER, "' or 1=1 --", "00000000-0000-4000-8000-00000000dead", "MINE"]) {
      const r = await owner.get(`/dashboard?assignment=${encodeURIComponent(v)}`);
      expect(r.status, v).toBe(200);
      expect(listedLeads(r.text), v).toEqual(["INQ-2026-0001", "INQ-2026-0002", "INQ-2026-0003"]);
      for (const m of B_MARKERS) expect(r.text, v).not.toContain(m);
    }
    const b = await login("owner-b@example.invalid");
    const cross = await b.get(`/dashboard?assignment=${A_STAFF}`);
    expect(cross.text).not.toContain("Staff A (synthetic)");
    expect(cross.text).not.toContain("Test Contact One");
    expect(cross.text).toContain("Bravo Plumbing (synthetic)");
  });
});

describe("regression and secret isolation", () => {
  it("ingestion endpoint unchanged; no secrets or markers in logs or pages", async () => {
    const noAuth = await fetch(`${BASE}/api/internal/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.getSetCookie()).toEqual([]);
    expect(noAuth.headers.get("access-control-allow-origin")).toBeNull();
    const log = serverLog.join("");
    for (const forbidden of [SERVICE_KEY, INGEST_TOKEN, PASSWORD, A_STAFF, B_OWNER, "owner-a@example.invalid"]) expect(log, forbidden.slice(0, 10)).not.toContain(forbidden);
    expect(log).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\./);
    expect(log).toContain('"action":"set_assignee"');
    const owner = await login("owner-a@example.invalid");
    const page = await owner.get(`/dashboard/leads/${LEAD_A3}`);
    expect(page.text).not.toContain(SERVICE_KEY);
    expect(page.text).not.toContain(INGEST_TOKEN);
  });
});
