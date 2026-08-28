// Real lead search, database-side pagination and CSV export: production
// Next.js server + local Supabase (search_leads runs SECURITY INVOKER under
// each session's RLS). Synthetic .invalid identities and fixture tenants only.
// Privileged SQL is fixture setup, inspection and cleanup - every
// authorization assertion goes through the real HTTP/session boundary.
// Prerequisites: pnpm run db:start && pnpm run env:local && pnpm build
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const BASE = "http://127.0.0.1:3000";
const CONTAINER = "supabase_db_Dashboard_SnowBeltTech";
const PASSWORD = "local-seed-only";
const RUN = `se-it-${Date.now().toString(36)}`;

// Fixture tenants owned exclusively by this suite (removed in afterAll).
const BIZ_E1 = "e0000000-0000-4000-8000-0000000000e1";
const E1_NAME = "Echo HVAC (synthetic IT)";
const E1_SLUG = "echo-hvac-it";
const BIZ_E2 = "e0000000-0000-4000-8000-0000000000e2";
const E2_SLUG = "foxtrot-plumbing-it";
const U_OWNER = "e1000000-0000-4000-8000-000000000001";
const U_MANAGER = "e1000000-0000-4000-8000-000000000002";
const U_STAFF = "e1000000-0000-4000-8000-000000000003";
const U_INACTIVE = "e1000000-0000-4000-8000-000000000004";
const OWNER_EMAIL = `search-owner-${RUN}@echo.example.invalid`;
const MANAGER_EMAIL = `search-manager-${RUN}@echo.example.invalid`;
const STAFF_EMAIL = `search-staff-${RUN}@echo.example.invalid`;
const INACTIVE_EMAIL = `search-inactive-${RUN}@echo.example.invalid`;
const B_OWNER_UUID = "b1000000-0000-4000-8000-000000000001";

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
  if (r.status !== 303 || !r.location?.endsWith("/")) throw new Error(`login failed for ${email.slice(0, 10)}…`);
  return s;
}
const leadNumbers = (html: string) => html.match(/INQ-2026-\d{4,5}/g) ?? [];
const unique = (xs: string[]) => [...new Set(xs)];

let server: ChildProcess | null = null;
const serverLog: string[] = [];

beforeAll(async () => {
  // ---- fixture tenants, personas and a deterministic lead population -------
  sql(`insert into public.businesses (id, name, slug, industry, timezone, status) values
         ('${BIZ_E1}', '${E1_NAME}', '${E1_SLUG}', 'hvac', 'America/New_York', 'active'),
         ('${BIZ_E2}', 'Foxtrot Plumbing (synthetic IT)', '${E2_SLUG}', 'plumbing', 'America/Chicago', 'active');
       insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
         raw_app_meta_data, raw_user_meta_data, is_sso_user,
         confirmation_token, recovery_token, email_change, email_change_token_new, created_at, updated_at)
       values
         ('00000000-0000-0000-0000-000000000000', '${U_OWNER}', 'authenticated', 'authenticated', '${OWNER_EMAIL}',
          extensions.crypt('${PASSWORD}', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', false, '', '', '', '', now(), now()),
         ('00000000-0000-0000-0000-000000000000', '${U_MANAGER}', 'authenticated', 'authenticated', '${MANAGER_EMAIL}',
          extensions.crypt('${PASSWORD}', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', false, '', '', '', '', now(), now()),
         ('00000000-0000-0000-0000-000000000000', '${U_STAFF}', 'authenticated', 'authenticated', '${STAFF_EMAIL}',
          extensions.crypt('${PASSWORD}', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', false, '', '', '', '', now(), now()),
         ('00000000-0000-0000-0000-000000000000', '${U_INACTIVE}', 'authenticated', 'authenticated', '${INACTIVE_EMAIL}',
          extensions.crypt('${PASSWORD}', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', false, '', '', '', '', now(), now());
       insert into public.profiles (id, display_name, platform_role, is_active) values
         ('${U_OWNER}', 'Echo Owner (synthetic)', null, true),
         ('${U_MANAGER}', 'Echo Manager (synthetic)', null, true),
         ('${U_STAFF}', 'Echo Staff (synthetic)', null, true),
         ('${U_INACTIVE}', 'Echo Inactive (synthetic)', null, true);
       insert into public.business_memberships (business_id, user_id, role, status) values
         ('${BIZ_E1}', '${U_OWNER}', 'BUSINESS_OWNER', 'active'),
         ('${BIZ_E2}', '${U_OWNER}', 'BUSINESS_OWNER', 'active'),
         ('${BIZ_E1}', '${U_MANAGER}', 'BUSINESS_MANAGER', 'active'),
         ('${BIZ_E1}', '${U_STAFF}', 'BUSINESS_STAFF', 'active'),
         ('${BIZ_E1}', '${U_INACTIVE}', 'BUSINESS_STAFF', 'inactive');`);

  // 130 bulk leads: i=60..119 share ONE timestamp (tie block spanning pages);
  // i%3=0 -> manual/no event id, otherwise website_form with an event id that
  // must never be searchable; i%5=0 -> contacted; i%4=0 -> assigned to staff.
  sql(`insert into public.leads (business_id, lead_number, source, source_event_id, contact_name, email, phone_e164, requested_service, status, urgency, assigned_to, created_at)
       select '${BIZ_E1}',
              'INQ-2026-' || (1000 + i),
              case when i % 3 = 0 then 'manual' else 'website_form' end,
              case when i % 3 = 0 then null else 'echo-evt-' || i end,
              'Echo Contact ' || i,
              'echo-' || i || '@example.invalid',
              '+1555020' || lpad(i::text, 4, '0'),
              'Service ' || i,
              case when i % 5 = 0 then 'contacted' else 'new' end,
              'normal',
              case when i % 4 = 0 then '${U_STAFF}'::uuid else null end,
              case when i between 60 and 119 then '2026-08-24T00:00:00Z'::timestamptz
                   else '2026-08-25T12:00:00Z'::timestamptz - make_interval(mins => i) end
       from generate_series(1, 130) i;`);

  // Special leads: searchable singletons, CSV hazard payloads, consent bait,
  // and one lead deep beyond the former 100-row window.
  sql(`insert into public.leads (business_id, lead_number, source, source_event_id, contact_name, email, phone_e164, requested_service, status, urgency, assigned_to, created_at,
                                 sms_consent, sms_consent_text, sms_consent_version, sms_consent_source, sms_consent_at)
       values
       ('${BIZ_E1}', 'INQ-2026-1201', 'website_form', 'echo-evt-secret-1201', 'MiXeD Case Finder', 'finder-echo@example.invalid', '+15550977777', 'Chimney Sweep', 'new', 'normal', null, '2026-08-25T11:00:00Z',
        true, 'SECRET-CONSENT-echo evidence text', 'test-v1', 'website_form', '2026-08-25T11:00:00Z'),
       ('${BIZ_E1}', 'INQ-2026-1202', 'manual', null, '=HYPERLINK("http://evil.invalid",1)', null, '+15550978881', 'Hazard One', 'new', 'normal', null, '2026-08-25T10:59:00Z', false, null, null, null, null),
       ('${BIZ_E1}', 'INQ-2026-1203', 'manual', null, ' +SUM(A1:A9)', null, '+15550978882', 'Hazard Two', 'new', 'normal', null, '2026-08-25T10:58:00Z', false, null, null, null, null),
       ('${BIZ_E1}', 'INQ-2026-1204', 'manual', null, e'\\t-2+3', null, '+15550978883', 'Hazard Three', 'new', 'normal', null, '2026-08-25T10:57:00Z', false, null, null, null, null),
       ('${BIZ_E1}', 'INQ-2026-1205', 'manual', null, '@cmd|calc', null, '+15550978884', 'Hazard Four', 'new', 'normal', null, '2026-08-25T10:56:00Z', false, null, null, null, null),
       ('${BIZ_E1}', 'INQ-2026-1206', 'manual', null, 'Quote "Q", comma', null, '+15550978885', 'Hazard Five', 'new', 'normal', null, '2026-08-25T10:55:00Z', false, null, null, null, null),
       ('${BIZ_E1}', 'INQ-2026-1207', 'manual', null, e'Line\\nBreak Lead', null, '+15550978886', 'Hazard Six', 'new', 'normal', null, '2026-08-25T10:54:00Z', false, null, null, null, null),
       ('${BIZ_E1}', 'INQ-2026-1208', 'manual', null, 'Zoë Müller 你好', null, '+15550978887', 'Hazard Seven', 'new', 'normal', null, '2026-08-25T10:53:00Z', false, null, null, null, null),
       ('${BIZ_E1}', 'INQ-2026-1209', 'manual', null, '100% Furnace_Fix', null, '+15550978888', 'Hazard Eight', 'new', 'normal', null, '2026-08-25T10:52:00Z', false, null, null, null, null),
       ('${BIZ_E1}', 'INQ-2026-1210', 'manual', null, 'Deep Window Lead', null, '+15550978889', 'Oldest Service', 'new', 'normal', null, '2026-08-20T00:00:00Z', false, null, null, null, null);`);

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
  // Remove everything this run created (FK order); privileged SQL is cleanup only.
  sql(`update public.businesses set status = 'active' where id in ('${BIZ_E1}', '${BIZ_E2}');
       delete from public.lead_activities where business_id in ('${BIZ_E1}', '${BIZ_E2}');
       delete from public.leads where business_id in ('${BIZ_E1}', '${BIZ_E2}');
       delete from public.lead_number_counters where business_id in ('${BIZ_E1}', '${BIZ_E2}');
       delete from public.customer_access_events where business_id in ('${BIZ_E1}', '${BIZ_E2}');
       delete from public.platform_admin_events where business_id in ('${BIZ_E1}', '${BIZ_E2}');`);
  for (const id of [U_OWNER, U_MANAGER, U_STAFF, U_INACTIVE]) sql(`delete from auth.users where id = '${id}'`); // cascades profiles -> memberships
  sql(`delete from public.businesses where id in ('${BIZ_E1}', '${BIZ_E2}')`);
});

describe("search and database-side pagination", () => {
  it("1-4: finds leads by number, mixed-case name, email, punctuated phone and service; never by payload internals", async () => {
    const owner = await login(OWNER_EMAIL);
    // a real note through the ordinary RPC boundary - notes must never be searchable
    const noteLead = sql(`select id::text from public.leads where business_id = '${BIZ_E1}' and lead_number = 'INQ-2026-1201'`);
    const noted = await owner.post(`/api/leads/${noteLead}/actions`, { action: "add_note", note: "SECRET-NOTE-echo body", request_id: "c0ffee00-0000-4000-8000-000000000001" });
    expect(noted.location).toMatch(/ok=add_note$/);

    const byNumber = await owner.get(`/dashboard?q=${encodeURIComponent("INQ-2026-1210")}`);
    expect(byNumber.status).toBe(200);
    expect(leadNumbers(byNumber.text)).toContain("INQ-2026-1210");
    expect(byNumber.text).toContain("of 1 matching");
    const byName = await owner.get(`/dashboard?q=${encodeURIComponent("mixed case FINDER")}`);
    expect(leadNumbers(byName.text)).toContain("INQ-2026-1201");
    expect(byName.text).toContain("of 1 matching");
    const byEmail = await owner.get(`/dashboard?q=${encodeURIComponent("FINDER-ECHO@example.invalid")}`);
    expect(leadNumbers(byEmail.text)).toContain("INQ-2026-1201");
    const byPhone = await owner.get(`/dashboard?q=${encodeURIComponent("(555) 020-0042")}`);
    expect(leadNumbers(byPhone.text)).toContain("INQ-2026-1042");
    expect(byPhone.text).toContain("of 1 matching");
    const byService = await owner.get(`/dashboard?q=${encodeURIComponent("Chimney Sweep")}`);
    expect(leadNumbers(byService.text)).toContain("INQ-2026-1201");

    // internals are NOT searchable: source event ids, consent text, note bodies
    for (const q of ["echo-evt-secret-1201", "SECRET-CONSENT-echo", "SECRET-NOTE-echo"]) {
      const r = await owner.get(`/dashboard?q=${encodeURIComponent(q)}`);
      expect(r.status, q).toBe(200);
      expect(leadNumbers(r.text), q).toEqual([]);
      expect(r.text, q).toContain("No leads match the current search and filters.");
    }
  });
  it("5,16: search combines with status/source/assignment; summary cards stay whole-business", async () => {
    const owner = await login(OWNER_EMAIL);
    const combo = await owner.get(`/dashboard?q=${encodeURIComponent("Echo Contact")}&status=contacted&source=manual`);
    expect(combo.status).toBe(200);
    // i%5=0 and i%3=0 -> multiples of 15 in 1..130 -> 8 leads
    expect(combo.text).toContain("of 8 matching");
    const assigned = await owner.get(`/dashboard?q=${encodeURIComponent("Echo Contact")}&assignment=${U_STAFF}`);
    expect(assigned.text).toContain("of 32 matching"); // i%4=0 in 1..130
    const unassignedPage = await owner.get(`/dashboard?q=${encodeURIComponent("Echo Contact 7")}&assignment=unassigned`);
    // 'Echo Contact 7' matches 7 and 70..79; of those, multiples of 4 (72,76) are assigned -> 9 unassigned
    expect(unassignedPage.text).toContain("of 9 matching");
    // whole-business summary stays 140 while the filtered list is smaller, and is labelled
    expect(combo.text).toContain("Summary counts always describe the whole business");
    expect(combo.text).toContain(">140<");
  });
  it("6-9: filters run before pagination; deep matches are found; tie-block pages never duplicate or skip; sorts are deterministic", async () => {
    const owner = await login(OWNER_EMAIL);
    const deep = await owner.get(`/dashboard?q=${encodeURIComponent("Deep Window")}`);
    expect(leadNumbers(deep.text)).toContain("INQ-2026-1210"); // beyond the former 100-row window
    for (const sort of ["newest", "oldest"] as const) {
      const collected: string[] = [];
      for (const page of [1, 2, 3]) {
        const r = await owner.get(`/dashboard?q=${encodeURIComponent("Echo Contact")}&sort=${sort}&page=${page}`);
        expect(r.status, `${sort} p${page}`).toBe(200);
        // each lead renders twice (table + mobile card): dedupe within the page first
        collected.push(...unique(leadNumbers(r.text)));
      }
      expect(collected.length, sort).toBe(130); // no page duplicated a lead
      expect(unique(collected).length, sort).toBe(130); // and none skipped
    }
    const newest = await owner.get("/dashboard?sort=newest");
    expect(leadNumbers(newest.text)[0]).toBe("INQ-2026-1001"); // newest lead first
    const oldest = await owner.get("/dashboard?sort=oldest");
    expect(leadNumbers(oldest.text)[0]).toBe("INQ-2026-1210"); // 2026-08-20, the oldest
    const oldestAgain = await owner.get("/dashboard?sort=oldest");
    expect(leadNumbers(oldestAgain.text)).toEqual(leadNumbers(oldest.text)); // deterministic
    const range = await owner.get(`/dashboard?q=${encodeURIComponent("Echo Contact")}&page=2`);
    expect(range.text).toContain("51");
    expect(range.text).toContain("of 130 matching");
    expect(range.text).toContain("Page 2 of 3");
  });
  it("10-11: invalid page/sort/search and PostgREST metacharacters are handled safely", async () => {
    const owner = await login(OWNER_EMAIL);
    // out-of-bound and invalid pages resolve to EXACTLY page 1 (same rows, same
    // range, page-1 pagination) and never echo the requested page number
    const pageOne = await owner.get(`/dashboard?q=${encodeURIComponent("Echo Contact")}`);
    expect(pageOne.text).toContain("Showing 1–50 of 130 matching");
    expect(pageOne.text).toContain("Page 1 of 3");
    const pageOneRows = unique(leadNumbers(pageOne.text));
    for (const p of ["99999", "20002", "0", "-1", "1.5", "abc", "2&page=3"]) {
      const r = await owner.get(`/dashboard?q=${encodeURIComponent("Echo Contact")}&page=${encodeURIComponent(p)}`);
      expect(r.status, p).toBe(200);
      expect(unique(leadNumbers(r.text)), p).toEqual(pageOneRows); // the exact page-1 slice
      expect(r.text, p).toContain("Showing 1–50 of 130 matching"); // page 1's range
      expect(r.text, p).toContain("Page 1 of 3");
      // visible/derived output only: Next's RSC payload scripts legitimately
      // echo the request's own URL, so strip scripts before asserting
      const visible = r.text.replace(/<script[\s\S]*?<\/script>/g, "");
      for (const echo of ["page=99999", "page=20002", "Page 99999", "Page 20002"]) expect(visible, `${p} -> ${echo}`).not.toContain(echo);
    }
    // the maximum aligned page (offset = the RPC's 1,000,000 clamp) is accepted
    // by the parser; with this fixture it is simply out of range -> page 1
    const maxPage = await owner.get(`/dashboard?q=${encodeURIComponent("Echo Contact")}&page=20001`);
    expect(maxPage.status).toBe(200);
    expect(maxPage.text).toContain("Showing 1–50 of 130 matching");
    expect(maxPage.text).toContain("Page 1 of 3");
    expect((await owner.get("/dashboard?sort=created_at.desc;drop")).status).toBe(200);
    expect((await owner.get(`/dashboard?q=${encodeURIComponent("x".repeat(400))}`)).status).toBe(200);
    for (const q of ["%", "_", "\\", "*", "or(status.eq.new)", "');drop table leads;--", 'q",eq.x)']) {
      const r = await owner.get(`/dashboard?q=${encodeURIComponent(q)}`);
      expect(r.status, q).toBe(200);
      expect(r.text, q).not.toContain("Echo Contact 1"); // grammar never reinterpreted as match-all
    }
    // LIKE wildcards match literally: "%"/"_" as wildcards would match all 130
    // "Echo Contact" leads; as literals they match nothing
    for (const q of ["Echo%Contact", "Echo_Contact", "Echo\\Contact"]) {
      const r = await owner.get(`/dashboard?q=${encodeURIComponent(q)}`);
      expect(leadNumbers(r.text), q).toEqual([]);
      expect(r.text, q).toContain("No leads match the current search and filters.");
    }
    // and the one lead really containing "%" / "_" is found by its literal text
    const percent = await owner.get(`/dashboard?q=${encodeURIComponent("100% Furnace")}`);
    expect(unique(leadNumbers(percent.text))).toEqual(["INQ-2026-1209"]);
    const underscore = await owner.get(`/dashboard?q=${encodeURIComponent("Furnace_Fix")}`);
    expect(unique(leadNumbers(underscore.text))).toEqual(["INQ-2026-1209"]);
  });
  it("12-15: tenant isolation, assignment stays a filter, foreign member UUIDs are ignored, revoked identities see nothing", async () => {
    const ownerA = await login("owner-a@example.invalid");
    const cross = await ownerA.get(`/dashboard?q=${encodeURIComponent("Echo Contact")}`);
    expect(cross.status).toBe(200);
    expect(leadNumbers(cross.text)).toEqual([]); // no Business E rows, no counts
    expect(cross.text).toContain("No leads match the current search and filters.");
    expect(cross.text).not.toContain(E1_NAME);

    const staff = await login(STAFF_EMAIL);
    const all = await staff.get("/dashboard");
    expect(all.text).toContain("of 140 matching"); // staff see ALL leads - assignment is never a visibility boundary
    const foreignAssign = await staff.get(`/dashboard?assignment=${B_OWNER_UUID}`);
    expect(foreignAssign.status).toBe(200);
    expect(foreignAssign.text).toContain("of 140 matching"); // unauthorized UUID falls back to "all"
    expect(foreignAssign.text).not.toContain("Owner B (synthetic)");

    const inactive = await login(INACTIVE_EMAIL);
    expect((await inactive.get("/dashboard")).location).toMatch(/\/no-access$/);
    sql(`update public.businesses set status = 'suspended' where id in ('${BIZ_E1}', '${BIZ_E2}')`);
    try {
      const owner = await login(OWNER_EMAIL);
      expect((await owner.get(`/dashboard?q=${encodeURIComponent("Echo Contact")}`)).location).toMatch(/\/no-access$/);
      expect((await owner.get(`/api/leads/export?business=${E1_SLUG}`)).status).toBe(404);
    } finally {
      sql(`update public.businesses set status = 'active' where id in ('${BIZ_E1}', '${BIZ_E2}')`);
    }
  });
});

describe("CSV export", () => {
  it("17-18,24-25,27-31: owner and manager export the exact filtered set with safe RFC 4180 cells", async () => {
    const owner = await login(OWNER_EMAIL);
    const full = await owner.get(`/api/leads/export?business=${E1_SLUG}`);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(full.headers.get("cache-control")).toBe("private, no-store");
    expect(full.headers.get("x-content-type-options")).toBe("nosniff");
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    expect(full.headers.get("content-disposition")).toBe(`attachment; filename="${E1_SLUG}-leads-${date}.csv"`);
    // fetch().text() strips a leading BOM, so prove the BOM from the raw bytes
    const rawRes = await fetch(`${BASE}/api/leads/export?business=${E1_SLUG}`, { headers: { cookie: owner.header() } });
    const rawBytes = new Uint8Array(await rawRes.arrayBuffer());
    expect([rawBytes[0], rawBytes[1], rawBytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = full.text.split("\r\n");
    expect(lines[0]).toBe("Lead Number,Submitted At UTC,Contact Name,Phone,Email,Requested Service,Source,Status,Urgency,Assigned To,Follow Up At UTC,Review Recommended");
    expect(lines.length).toBe(1 + 140 + 1); // header + all matching rows (beyond page one) + trailing CRLF
    expect(lines[lines.length - 1]).toBe("");
    expect(full.text).toContain("INQ-2026-1210"); // far beyond the first dashboard page

    // hazard cells: formulas neutralized (whitespace-prefixed included), quotes/commas/newlines quoted, unicode intact, + phones inert
    expect(full.text).toContain('"\'=HYPERLINK(""http://evil.invalid"",1)"');
    expect(full.text).toContain("' +SUM(A1:A9)");
    expect(full.text).toContain("'\t-2+3");
    expect(full.text).toContain("'@cmd|calc");
    expect(full.text).toContain('"Quote ""Q"", comma"');
    expect(full.text).toContain('"Line\nBreak Lead"');
    expect(full.text).toContain("Zoë Müller 你好");
    expect(full.text).toContain("'+15550977777");
    expect(full.text).not.toMatch(/\r\n=HYPERLINK|,=HYPERLINK/);
    expect(full.text).toContain("Echo Staff (synthetic)"); // tenant-safe assignee names
    expect(full.text).toContain("Unassigned");

    // export matches the dashboard's normalized filters exactly (q + status + source)
    const filtered = await owner.get(`/api/leads/export?business=${E1_SLUG}&q=${encodeURIComponent("Echo Contact")}&status=contacted&source=manual&sort=oldest`);
    expect(filtered.status).toBe(200);
    const nums = unique(leadNumbers(filtered.text));
    expect(nums.length).toBe(8); // multiples of 15 in 1..130 - same count the dashboard shows
    for (const n of nums) expect((Number(n.slice(9)) - 1000) % 15, n).toBe(0); // 1015, 1030, ... 1120 -> i multiples of 15
    const manager = await login(MANAGER_EMAIL);
    const managerCsv = await manager.get(`/api/leads/export?business=${E1_SLUG}&q=${encodeURIComponent("Deep Window")}`);
    expect(managerCsv.status).toBe(200);
    expect(unique(leadNumbers(managerCsv.text))).toEqual(["INQ-2026-1210"]);
  });
  it("28: the CSV never contains UUIDs, event ids, payload internals, consent text or notes", async () => {
    const owner = await login(OWNER_EMAIL);
    const full = await owner.get(`/api/leads/export?business=${E1_SLUG}`);
    expect(full.status).toBe(200);
    for (const forbidden of [BIZ_E1, U_STAFF, "echo-evt-", "SECRET-CONSENT-echo", "SECRET-NOTE-echo", "e0000000", "e1000000"]) {
      expect(full.text, forbidden).not.toContain(forbidden);
    }
    expect(full.text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
  it("19-23: staff, administrators, anonymous, foreign tenants and unknown businesses are refused server-side", async () => {
    const staff = await login(STAFF_EMAIL);
    expect((await staff.get("/dashboard")).text).not.toContain("Export CSV"); // control hidden...
    expect((await staff.get(`/api/leads/export?business=${E1_SLUG}`)).status).toBe(403); // ...and the server still refuses
    const admin = await login("platform-admin@example.invalid");
    expect((await admin.get(`/api/leads/export?business=${E1_SLUG}`)).status).toBe(404);
    expect((await new Session().get("/api/leads/export")).status).toBe(401);
    const ownerA = await login("owner-a@example.invalid");
    const foreign = await ownerA.get(`/api/leads/export?business=${E1_SLUG}`);
    const unknown = await ownerA.get("/api/leads/export?business=does-not-exist");
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(foreign.text).toBe(unknown.text); // opaque and indistinguishable
    const owner = await login(OWNER_EMAIL);
    expect((await owner.get("/dashboard")).text).toContain("Export CSV"); // owners do see the control
    expect((await owner.get(`/api/leads/export?business=alpha-hvac`)).status).toBe(404); // foreign from the other side
  });
  it("26: exports beyond 25,000 matching rows refuse without truncation; narrowing the filters recovers", async () => {
    sql(`insert into public.leads (business_id, lead_number, source, contact_name, status, created_at)
         select '${BIZ_E2}', 'INQ-2026-2' || lpad(i::text, 5, '0'), 'manual', 'Bulk Contact ' || i,
                case when i % 12550 = 0 then 'contacted' else 'new' end,
                '2026-08-25T00:00:00Z'::timestamptz - make_interval(secs => i)
         from generate_series(1, 25100) i;`);
    try {
      const owner = await login(OWNER_EMAIL);
      const refused = await owner.get(`/api/leads/export?business=${E2_SLUG}`);
      expect(refused.status).toBe(303);
      expect(refused.location).toContain("/dashboard?");
      expect(refused.location).toContain("err=export_too_large");
      expect(refused.location).toContain(`business=${E2_SLUG}`);
      const back = await owner.get(`/dashboard?business=${E2_SLUG}&err=export_too_large`);
      expect(back.status).toBe(200);
      expect(back.text).toContain("more than 25,000 matching leads");
      // narrowing the search/filters makes the export work again, exactly as instructed
      const narrowed = await owner.get(`/api/leads/export?business=${E2_SLUG}&status=contacted`);
      expect(narrowed.status).toBe(200);
      expect(unique(leadNumbers(narrowed.text)).length).toBe(2); // 12550, 25100
      // and the too-large refusal leaked nothing: no rows, no partial CSV
      expect(refused.text).not.toContain("Bulk Contact");
    } finally {
      sql(`delete from public.leads where business_id = '${BIZ_E2}'`);
    }
  });
  it("32-33: filenames and headers never carry query-controlled values", async () => {
    const owner = await login(OWNER_EMAIL);
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const tricky = await owner.get(`/api/leads/export?business=${E1_SLUG}&q=${encodeURIComponent('"attack.csv"\r\nX-Evil: 1')}`);
    expect(tricky.status).toBe(200);
    expect(tricky.headers.get("content-disposition")).toBe(`attachment; filename="${E1_SLUG}-leads-${date}.csv"`);
    expect(tricky.headers.get("x-evil")).toBeNull();
    expect(tricky.headers.get("cache-control")).toBe("private, no-store");
    expect(tricky.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("logs, bundles and regressions", () => {
  it("35: no PII, search text, exported content, cookie, JWT or secret reaches server logs", async () => {
    const log = serverLog.join("");
    for (const forbidden of [
      "Echo Contact", "MiXeD Case Finder", "Deep Window", "Bulk Contact", "HYPERLINK", "SECRET-CONSENT", "SECRET-NOTE",
      "finder-echo@example.invalid", OWNER_EMAIL, "Chimney Sweep", "+1555020", SERVICE_KEY, INGEST_TOKEN, PASSWORD,
    ]) {
      expect(log, forbidden.slice(0, 20)).not.toContain(forbidden);
    }
    expect(log).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\./);
    expect(log).toContain('"event":"leads_export"');
    expect(log).toContain('"category":"export_too_large"');
    expect(log).toContain('"category":"role_denied"');
  });
  it("34: no privileged module or secret reaches browser assets", async () => {
    const files: string[] = [];
    const walk = (dir: string) => { for (const f of readdirSync(dir)) { const p = path.join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(js|css|json|html|txt)$/.test(f)) files.push(p); } };
    walk(path.join(ROOT, ".next", "static"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const forbidden of [SERVICE_KEY, INGEST_TOKEN, "SUPABASE_SERVICE_ROLE_KEY", "supabase-admin", "supabase-auth-admin", "fetchLeadExport", "search_leads"]) {
        expect(text, path.basename(f)).not.toContain(forbidden);
      }
    }
  });
  it("36: existing lead detail and mutations still work under the new workspace", async () => {
    const owner = await login(OWNER_EMAIL);
    const leadId = sql(`select id::text from public.leads where business_id = '${BIZ_E1}' and lead_number = 'INQ-2026-1210'`);
    const detail = await owner.get(`/dashboard/leads/${leadId}`);
    expect(detail.status).toBe(200);
    expect(detail.text).toContain("Deep Window Lead");
    const move = await owner.post(`/api/leads/${leadId}/actions`, { action: "set_status", status: "contacted" });
    expect(move.location).toMatch(/ok=set_status$/);
    expect(sql(`select status from public.leads where id = '${leadId}'`)).toBe("contacted");
  });
});
