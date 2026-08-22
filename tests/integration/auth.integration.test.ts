// Real sessions: form login against the local Next.js production server, which
// authenticates with the LOCAL Supabase Auth service; protected pages are then
// fetched with the resulting httpOnly session cookies. No mocks.
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
const BIZ_B = "b0000000-0000-4000-8000-000000000001";
const LEAD_A1 = "aa000000-0000-4000-8000-000000000001";
const LEAD_B1 = "bb000000-0000-4000-8000-000000000001";
const A_MANAGER = "a1000000-0000-4000-8000-000000000002";
const A_STAFF = "a1000000-0000-4000-8000-000000000003";
// Seeded, distinctive tenant content (see supabase/seed.sql)
const A_MARKERS = ["Alpha HVAC (synthetic)", "Test Contact One", "+15550100001", "contact-one@example.invalid", "Furnace tune-up", "Test Caller Two", "Duct cleaning"];
const B_MARKERS = ["Bravo Plumbing (synthetic)", "Test Contact Four", "+15550100004", "contact-four@example.invalid", "Leaking faucet", "Test Caller Five", "Water heater"];

function env(name: string): string {
  const m = new RegExp(`^${name}=(.*)$`, "m").exec(readFileSync(path.join(ROOT, ".env.local"), "utf8"));
  if (!m) throw new Error(`${name} missing from .env.local`);
  return m[1]!.trim();
}
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const INGEST_TOKEN = env("N8N_INGEST_TOKEN");

function sql(q: string): string {
  const r = spawnSync("docker", ["exec", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", q], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr}`);
  return r.stdout.trim();
}

/** Minimal cookie jar: keeps the latest value per cookie name. */
class Session {
  private jar = new Map<string, string>();
  absorb(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq);
      const value = pair!.slice(eq + 1);
      if (value === "" || /max-age=0/i.test(c)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }
  header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  get size() {
    return this.jar.size;
  }
  snapshot(): string {
    return this.header();
  }
  async get(pathname: string) {
    const res = await fetch(BASE + pathname, { headers: { cookie: this.header() }, redirect: "manual" });
    this.absorb(res);
    const text = await res.text();
    return { status: res.status, location: res.headers.get("location"), text, headers: res.headers };
  }
  async post(pathname: string, form: Record<string, string>, extra: Record<string, string> = {}) {
    const res = await fetch(BASE + pathname, {
      method: "POST",
      headers: { cookie: this.header(), "content-type": "application/x-www-form-urlencoded", origin: BASE, ...extra },
      body: new URLSearchParams(form).toString(),
      redirect: "manual",
    });
    this.absorb(res);
    const text = await res.text();
    return { status: res.status, location: res.headers.get("location"), text, headers: res.headers };
  }
}

async function login(email: string, password = PASSWORD): Promise<{ s: Session; status: number; location: string | null }> {
  const s = new Session();
  const r = await s.post("/api/auth/login", { email, password });
  return { s, status: r.status, location: r.location };
}

let server: ChildProcess | null = null;
const serverLog: string[] = [];

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", "3000"], { cwd: ROOT, env: { ...process.env, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout!.on("data", (d) => serverLog.push(String(d)));
  server.stderr!.on("data", (d) => serverLog.push(String(d)));
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/login`);
      if (r.ok) break;
    } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${serverLog.join("")}`);
    await new Promise((r) => setTimeout(r, 500));
  }
});

afterAll(() => {
  if (server?.pid) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"]);
    else server.kill("SIGTERM");
  }
  // restore every fixture this file may have touched
  sql(`update public.businesses set status = 'active' where id in ('${BIZ_A}', '${BIZ_B}');
       update public.business_memberships set status = 'active' where user_id in ('${A_MANAGER}', '${A_STAFF}');
       update public.business_memberships set status = 'inactive' where user_id = 'a1000000-0000-4000-8000-000000000004';
       update public.profiles set is_active = true;`);
});

const expectNone = (text: string, markers: string[]) => { for (const m of markers) expect(text, m).not.toContain(m); };
const expectAll = (text: string, markers: string[]) => { for (const m of markers) expect(text, m).toContain(m); };

describe("authentication", () => {
  it("login page renders, is cacheable by nobody, and has no signup", async () => {
    const r = await new Session().get("/login");
    expect(r.status).toBe(200);
    expect(r.text).toContain("SnowBeltTech");
    expect(r.text).toContain('action="/api/auth/login"');
    expect(r.text).not.toMatch(/sign ?up|register|create an account/i);
    expect(r.headers.get("cache-control")).toContain("no-store");
  });
  it("unauthenticated customer and admin routes redirect to login", async () => {
    for (const p of ["/", "/dashboard", "/admin", `/dashboard/leads/${LEAD_A1}`]) {
      const r = await new Session().get(p);
      expect([302, 303, 307, 308], p).toContain(r.status);
      expect(r.location, p).toMatch(/\/login$/);
    }
  });
  it("each seeded persona signs in with real Supabase Auth and lands on its role page", async () => {
    const cases: Array<[string, string]> = [
      ["owner-a@example.invalid", "/dashboard"], ["manager-a@example.invalid", "/dashboard"], ["staff-a@example.invalid", "/dashboard"],
      ["owner-b@example.invalid", "/dashboard"], ["platform-admin@example.invalid", "/admin"],
    ];
    for (const [email, expected] of cases) {
      const { s, status, location } = await login(email);
      expect(status, email).toBe(303);
      expect(location, email).toMatch(/\/$/);
      expect(s.size, email).toBeGreaterThan(0);
      const root = await s.get("/");
      expect([302, 303, 307, 308], email).toContain(root.status);
      expect(root.location, email).toMatch(new RegExp(`${expected}$`));
    }
  });
  it("invalid password and unknown account fail identically without enumeration", async () => {
    const bad = await login("owner-a@example.invalid", "wrong-password");
    const unknown = await login("nobody@example.invalid");
    expect(bad.status).toBe(303);
    expect(unknown.status).toBe(303);
    expect(bad.location).toBe(unknown.location);
    expect(bad.location).toMatch(/\/login\?error=1$/);
    expect(bad.s.size).toBe(0);
    const page = await new Session().get("/login?error=1");
    expect(page.text).toContain("couldn&#x27;t sign you in");
    expect(page.text).not.toMatch(/no account|not found|does not exist/i);
  });
  it("cross-site login posts are refused", async () => {
    const s = new Session();
    const r = await s.post("/api/auth/login", { email: "owner-a@example.invalid", password: PASSWORD }, { origin: "http://evil.example.invalid", "sec-fetch-site": "cross-site" });
    expect(r.status).toBe(403);
    expect(s.size).toBe(0);
  });
  it("former staff (inactive membership) signs in but gets the access-unavailable page, never tenant data", async () => {
    const { s } = await login("former-staff-a@example.invalid");
    const root = await s.get("/");
    expect(root.location).toMatch(/\/no-access$/);
    const page = await s.get("/no-access");
    expect(page.status).toBe(200);
    expect(page.text).toContain("Access unavailable");
    expectNone(page.text, [...A_MARKERS, ...B_MARKERS]);
    const dash = await s.get("/dashboard");
    expect(dash.location).toMatch(/\/no-access$/);
  });
  it("sign-out clears access for the session; reusing the old cookies no longer works", async () => {
    const { s } = await login("owner-a@example.invalid");
    const before = await s.get("/dashboard");
    expect(before.status).toBe(200);
    const stale = s.snapshot();
    const out = await s.post("/api/auth/logout", {});
    expect(out.status).toBe(303);
    expect(out.location).toMatch(/\/login$/);
    expect(s.size).toBe(0);
    const after = await s.get("/dashboard");
    expect(after.location).toMatch(/\/login$/);
    const replay = await fetch(`${BASE}/dashboard`, { headers: { cookie: stale }, redirect: "manual" });
    expect([302, 303, 307, 308]).toContain(replay.status);
    expect(replay.headers.get("location")).toMatch(/\/login$/);
  });
});

describe("tenant isolation", () => {
  it("owner, manager and staff of Business A see the same Business A leads and nothing from B", async () => {
    for (const email of ["owner-a@example.invalid", "manager-a@example.invalid", "staff-a@example.invalid"]) {
      const { s } = await login(email);
      const r = await s.get("/dashboard");
      expect(r.status, email).toBe(200);
      expect(r.headers.get("cache-control"), email).toContain("no-store");
      expectAll(r.text, A_MARKERS);
      expectNone(r.text, B_MARKERS);
      expect(r.text).not.toContain(LEAD_B1);
      expect(r.text).toContain("INQ-2026-0003");
    }
  });
  it("Business B owner sees only Business B", async () => {
    const { s } = await login("owner-b@example.invalid");
    const r = await s.get("/dashboard");
    expect(r.status).toBe(200);
    expectAll(r.text, B_MARKERS);
    expectNone(r.text, A_MARKERS);
    expect(r.text).not.toContain(LEAD_A1);
  });
  it("query manipulation cannot switch a customer into another business", async () => {
    const { s } = await login("owner-a@example.invalid");
    for (const q of ["?business=bravo-plumbing", `?business=${BIZ_B}`, "?status=new&business=bravo-plumbing"]) {
      const r = await s.get(`/dashboard${q}`);
      expect(r.status, q).toBe(200);
      expectAll(r.text, ["Alpha HVAC (synthetic)"]);
      expectNone(r.text, B_MARKERS);
    }
    const filtered = await s.get("/dashboard?status=new&source=voice_call");
    expect(filtered.text).toContain("Test Caller Two");
    expect(filtered.text).not.toContain("Test Contact One");
    const bogus = await s.get("/dashboard?status=new'%20or%201=1");
    expect(bogus.status).toBe(200);
  });
  it("own lead detail works; a guessed cross-business lead id is an opaque 404 identical to a random id", async () => {
    const { s } = await login("owner-a@example.invalid");
    const own = await s.get(`/dashboard/leads/${LEAD_A1}`);
    expect(own.status).toBe(200);
    expect(own.text).toContain("INQ-2026-0001");
    expect(own.text).toContain("Test Contact One");
    expect(own.text).toContain("Granted · test-v1");
    const foreign = await s.get(`/dashboard/leads/${LEAD_B1}`);
    const random = await s.get("/dashboard/leads/00000000-0000-4000-8000-00000000dead");
    const junk = await s.get("/dashboard/leads/not-a-uuid");
    expect(foreign.status).toBe(404);
    expect(random.status).toBe(404);
    expect(junk.status).toBe(404);
    expectNone(foreign.text, B_MARKERS);
    // The only place the guessed id can appear is the echo of the requested URL itself; after
    // replacing each page's own requested id, the two 404 pages must be indistinguishable.
    const visible = (text: string, id: string) =>
      text.split(id).join("<ID>").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    expect(visible(foreign.text, LEAD_B1)).toBe(visible(random.text, "00000000-0000-4000-8000-00000000dead"));
    expect(foreign.text.split(LEAD_B1).length - 1).toBe(random.text.split("00000000-0000-4000-8000-00000000dead").length - 1);
    for (const r of [foreign, random, junk]) expect(r.text).toContain("This page could not be found");
  });
  it("a customer cannot reach /admin", async () => {
    const { s } = await login("owner-a@example.invalid");
    const r = await s.get("/admin");
    expect([302, 303, 307, 308]).toContain(r.status);
    expect(r.location).not.toMatch(/\/admin$/);
    expectNone(r.text, [...A_MARKERS, ...B_MARKERS]);
  });
  it("the platform administrator sees both businesses and all leads through ordinary RLS", async () => {
    const { s } = await login("platform-admin@example.invalid");
    const r = await s.get("/admin");
    expect(r.status).toBe(200);
    expect(r.text).toContain("Platform administrator");
    expectAll(r.text, ["Alpha HVAC (synthetic)", "Bravo Plumbing (synthetic)", "Test Contact One", "Test Contact Four", "Test Caller Five"]);
    expect(r.headers.get("cache-control")).toContain("no-store");
    const dash = await s.get("/dashboard");
    expect(dash.location).toMatch(/\/admin$/);
  });
});

describe("revocation on the next protected request", () => {
  it("deactivating a membership removes access; restoring it restores access", async () => {
    const { s } = await login("manager-a@example.invalid");
    expect((await s.get("/dashboard")).status).toBe(200);
    sql(`update public.business_memberships set status = 'inactive' where user_id = '${A_MANAGER}'`);
    const denied = await s.get("/dashboard");
    expect(denied.location).toMatch(/\/no-access$/);
    expectNone(denied.text, A_MARKERS);
    sql(`update public.business_memberships set status = 'active' where user_id = '${A_MANAGER}'`);
    const restored = await s.get("/dashboard");
    expect(restored.status).toBe(200);
    expectAll(restored.text, ["Alpha HVAC (synthetic)", "Test Contact One"]);
  });
  it("deactivating a profile removes access", async () => {
    const { s } = await login("staff-a@example.invalid");
    expect((await s.get("/dashboard")).status).toBe(200);
    sql(`update public.profiles set is_active = false where id = '${A_STAFF}'`);
    const denied = await s.get("/dashboard");
    expect(denied.location).toMatch(/\/no-access$/);
    sql(`update public.profiles set is_active = true where id = '${A_STAFF}'`);
    expect((await s.get("/dashboard")).status).toBe(200);
  });
  it("suspending or archiving the business removes customer access while the admin still sees it", async () => {
    const owner = (await login("owner-a@example.invalid")).s;
    const admin = (await login("platform-admin@example.invalid")).s;
    expect((await owner.get("/dashboard")).status).toBe(200);
    for (const status of ["suspended", "archived"]) {
      sql(`update public.businesses set status = '${status}' where id = '${BIZ_A}'`);
      const denied = await owner.get("/dashboard");
      expect(denied.location, status).toMatch(/\/no-access$/);
      expectNone(denied.text, A_MARKERS);
      const a = await admin.get("/admin");
      expect(a.status, status).toBe(200);
      expect(a.text, status).toContain("Alpha HVAC (synthetic)");
      expect(a.text, status).toContain(status === "suspended" ? "Suspended" : "Archived");
      expect(a.text, status).toContain("Test Contact One");
    }
    sql(`update public.businesses set status = 'active' where id = '${BIZ_A}'`);
    const restored = await owner.get("/dashboard");
    expect(restored.status).toBe(200);
    expectAll(restored.text, ["Alpha HVAC (synthetic)", "Test Contact One"]);
  });
});

describe("secret isolation and ingestion regression", () => {
  it("no secret, session token or service key appears in rendered pages or the server log", async () => {
    const { s } = await login("owner-a@example.invalid");
    const pages = [await new Session().get("/login"), await s.get("/dashboard"), await s.get(`/dashboard/leads/${LEAD_A1}`), await (await login("platform-admin@example.invalid")).s.get("/admin")];
    for (const p of pages) {
      expect(p.text).not.toContain(SERVICE_KEY);
      expect(p.text).not.toContain(INGEST_TOKEN);
      expect(p.text).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./); // no JWT in markup
      expect(p.text).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    }
    const log = serverLog.join("");
    expect(log).not.toContain(SERVICE_KEY);
    expect(log).not.toContain(INGEST_TOKEN);
    expect(log).not.toContain(PASSWORD);
    expect(log).not.toContain("owner-a@example.invalid");
    expect(log).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\./);
  });
  it("the internal ingestion endpoint is untouched by session handling", async () => {
    const noAuth = await fetch(`${BASE}/api/internal/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", redirect: "manual" });
    expect(noAuth.status).toBe(401);
    expect(await noAuth.json()).toEqual({ error: "unauthorized" });
    expect(noAuth.headers.getSetCookie()).toEqual([]);
    expect(noAuth.headers.get("access-control-allow-origin")).toBeNull();
    const ok = await fetch(`${BASE}/api/internal/ingest`, {
      method: "POST",
      headers: { authorization: `Bearer ${INGEST_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ source_kind: "website_form", source_external_id: "site-alpha-synthetic", source_event_id: `auth-it-${Date.now().toString(36)}`, payload: { contact_name: "Regression Check" } }),
    });
    expect(ok.status).toBe(201);
    expect(Object.keys(await ok.json()).sort()).toEqual(["customer_sms_allowed", "lead_id", "lead_number", "outcome", "should_notify"]);
    expect(ok.headers.getSetCookie()).toEqual([]);
    sql(`delete from public.ingestion_events where source_event_id like 'auth-it-%'; delete from public.leads where source_event_id like 'auth-it-%';`);
  });
});
