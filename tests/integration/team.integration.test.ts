// Customer roles and owner-only Team & access: real Supabase Auth sessions,
// the production Next.js server, the local mail catcher for owner-created
// invitations, and privileged SQL strictly for fixture setup/inspection/
// cleanup. Every authorization assertion goes through the real HTTP/session
// boundary. Synthetic .invalid identities only.
// Prerequisites: pnpm run db:start && pnpm run env:local && pnpm build
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const BASE = "http://127.0.0.1:3000";
const MAIL = "http://127.0.0.1:54324";
const CONTAINER = "supabase_db_Dashboard_SnowBeltTech";
const PASSWORD = "local-seed-only";
const RUN = `team-it-${Date.now().toString(36)}`;

// Fixture tenants owned exclusively by this suite (removed in afterAll).
// The lead owner is OWNER of T1 and MANAGER of T2 (multi-business role proof).
const BIZ_T1 = "f0000000-0000-4000-8000-0000000000f1";
const T1_NAME = "Tango Roofing (synthetic IT)";
const T1_SLUG = "tango-roofing-it";
const BIZ_T2 = "f0000000-0000-4000-8000-0000000000f2";
const T2_NAME = "Uniform Cleaning (synthetic IT)";
const T2_SLUG = "uniform-cleaning-it";
const U_OWNER = "f2000000-0000-4000-8000-000000000001";
const U_OWNER2 = "f2000000-0000-4000-8000-000000000002";
const U_MANAGER = "f2000000-0000-4000-8000-000000000003";
const U_STAFF = "f2000000-0000-4000-8000-000000000004";
const U_T2OWNER = "f2000000-0000-4000-8000-000000000005";
const OWNER_EMAIL = `team-owner-${RUN}@tango.example.invalid`;
const OWNER2_EMAIL = `team-owner2-${RUN}@tango.example.invalid`;
const MANAGER_EMAIL = `team-manager-${RUN}@tango.example.invalid`;
const STAFF_EMAIL = `team-staff-${RUN}@tango.example.invalid`;
const T2OWNER_EMAIL = `team-t2owner-${RUN}@uniform.example.invalid`;
const INVITEE_EMAIL = `team-invitee-${RUN}@tango.example.invalid`;
const FAILMAIL_EMAIL = `team-failmail-${RUN}@tango.example.invalid`;
const MAIL_CONTAINER = "supabase_inbucket_Dashboard_SnowBeltTech";
const NEW_PASSWORD = `Team-Invitee-${RUN}-42`;

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
const membership = (biz: string, userId: string) => sql(`select coalesce((select role || '|' || status from public.business_memberships where business_id = '${biz}' and user_id = '${userId}'), '')`);
const invitation = (email: string) => sql(`select coalesce((select status from public.customer_invitations where email = '${email}' order by created_at desc limit 1), '')`);
const authUsers = (email: string) => Number(sql(`select count(*) from auth.users where lower(email) = '${email}'`));

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
  async postRaw(p: string, body: string, extra: Record<string, string> = {}) {
    const res = await fetch(BASE + p, {
      method: "POST",
      headers: { cookie: this.header(), "content-type": "application/x-www-form-urlencoded", origin: BASE, ...extra },
      body,
      redirect: "manual",
    });
    this.absorb(res);
    return { status: res.status, location: res.headers.get("location"), text: await res.text(), headers: res.headers };
  }
}
async function login(email: string, password = PASSWORD) {
  const s = new Session();
  const r = await s.post("/api/auth/login", { email, password });
  if (r.status !== 303 || !r.location?.endsWith("/")) throw new Error(`login failed for ${email.slice(0, 12)}…`);
  return s;
}
const headerRole = (html: string) => /<strong>[^<]*<\/strong> <span class="muted">· <!-- -->([^<]*)<\/span>/.exec(html)?.[1] ?? null;
const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, "");

interface MailSummary { ID: string; To: Array<{ Address: string }> }
async function inviteLink(address: string): Promise<string> {
  for (let i = 0; i < 25; i++) {
    const res = await fetch(`${MAIL}/api/v1/messages?limit=100`);
    const body = (await res.json()) as { messages: MailSummary[] };
    const mine = (body.messages ?? []).filter((m) => m.To.some((t) => t.Address.toLowerCase() === address.toLowerCase()));
    if (mine.length > 0) {
      const detail = await fetch(`${MAIL}/api/v1/message/${mine[0]!.ID}`);
      const d = (await detail.json()) as { HTML?: string; Text?: string };
      const html = `${d.HTML ?? ""}\n${d.Text ?? ""}`.replace(/&amp;/g, "&");
      const m = /(http:\/\/127\.0\.0\.1:3000\/auth\/confirm\?token_hash=[A-Za-z0-9_-]+&type=invite)/.exec(html);
      if (m) return m[1]!;
      throw new Error("invitation email did not contain the expected confirm link shape");
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("invitation email never arrived");
}

let server: ChildProcess | null = null;
const serverLog: string[] = [];

beforeAll(async () => {
  await fetch(`${MAIL}/api/v1/messages`, { method: "DELETE" }).catch(() => undefined);
  sql(`insert into public.businesses (id, name, slug, industry, timezone, status) values
         ('${BIZ_T1}', '${T1_NAME}', '${T1_SLUG}', 'roofing', 'America/New_York', 'active'),
         ('${BIZ_T2}', '${T2_NAME}', '${T2_SLUG}', 'cleaning', 'America/Chicago', 'active');
       insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
         raw_app_meta_data, raw_user_meta_data, is_sso_user,
         confirmation_token, recovery_token, email_change, email_change_token_new, created_at, updated_at)
       select '00000000-0000-0000-0000-000000000000', x.id, 'authenticated', 'authenticated', x.email,
              extensions.crypt('${PASSWORD}', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', false, '', '', '', '', now(), now()
       from (values ('${U_OWNER}'::uuid, '${OWNER_EMAIL}'), ('${U_OWNER2}'::uuid, '${OWNER2_EMAIL}'), ('${U_MANAGER}'::uuid, '${MANAGER_EMAIL}'),
                    ('${U_STAFF}'::uuid, '${STAFF_EMAIL}'), ('${U_T2OWNER}'::uuid, '${T2OWNER_EMAIL}')) as x(id, email);
       insert into public.profiles (id, display_name, platform_role, is_active) values
         ('${U_OWNER}', 'Tango Owner (synthetic)', null, true),
         ('${U_OWNER2}', 'Tango Second Owner (synthetic)', null, true),
         ('${U_MANAGER}', 'Tango Manager (synthetic)', null, true),
         ('${U_STAFF}', 'Tango Staff (synthetic)', null, true),
         ('${U_T2OWNER}', 'Uniform Owner (synthetic)', null, true);
       insert into public.business_memberships (business_id, user_id, role, status) values
         ('${BIZ_T1}', '${U_OWNER}', 'BUSINESS_OWNER', 'active'),
         ('${BIZ_T1}', '${U_OWNER2}', 'BUSINESS_OWNER', 'active'),
         ('${BIZ_T1}', '${U_MANAGER}', 'BUSINESS_MANAGER', 'active'),
         ('${BIZ_T1}', '${U_STAFF}', 'BUSINESS_STAFF', 'active'),
         ('${BIZ_T2}', '${U_T2OWNER}', 'BUSINESS_OWNER', 'active'),
         ('${BIZ_T2}', '${U_OWNER}', 'BUSINESS_MANAGER', 'active');
       insert into public.leads (business_id, lead_number, source, contact_name, status, urgency, created_at) values
         ('${BIZ_T1}', 'INQ-2026-7001', 'manual', 'Tango Lead One', 'new', 'normal', '2026-08-26T10:00:00Z'),
         ('${BIZ_T1}', 'INQ-2026-7002', 'manual', 'Tango Lead Two', 'contacted', 'normal', '2026-08-26T09:00:00Z');`);

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

afterAll(async () => {
  if (server?.pid) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"]); else server.kill("SIGTERM");
  }
  spawnSync("docker", ["start", MAIL_CONTAINER], { encoding: "utf8" }); // in case the failure test left it stopped
  sql(`update public.businesses set status = 'active' where id in ('${BIZ_T1}', '${BIZ_T2}');
       delete from public.customer_access_events where business_id in ('${BIZ_T1}', '${BIZ_T2}');
       delete from public.customer_invitations where business_id in ('${BIZ_T1}', '${BIZ_T2}');
       delete from public.lead_activities where business_id in ('${BIZ_T1}', '${BIZ_T2}');
       delete from public.leads where business_id in ('${BIZ_T1}', '${BIZ_T2}');
       delete from public.platform_admin_events where business_id in ('${BIZ_T1}', '${BIZ_T2}');`);
  for (const e of [OWNER_EMAIL, OWNER2_EMAIL, MANAGER_EMAIL, STAFF_EMAIL, T2OWNER_EMAIL, INVITEE_EMAIL, FAILMAIL_EMAIL]) {
    sql(`delete from auth.users where lower(email) = '${e}'`); // cascades profiles -> memberships
  }
  sql(`delete from public.businesses where id in ('${BIZ_T1}', '${BIZ_T2}')`);
  await fetch(`${MAIL}/api/v1/messages`, { method: "DELETE" }).catch(() => undefined);
});

describe("role display and lead-workflow UX across roles", () => {
  it("owner/manager/staff headers show the effective role and all see the clarified lead workspace", async () => {
    const cases: Array<[string, string, boolean, boolean]> = [
      [OWNER_EMAIL, "Owner", true, true],       // export + team nav
      [MANAGER_EMAIL, "Manager", true, false],  // export, no team nav
      [STAFF_EMAIL, "Staff", false, false],     // neither
    ];
    for (const [email, role, exportVisible, teamVisible] of cases) {
      const s = await login(email);
      const dash = await s.get(`/dashboard?business=${T1_SLUG}`);
      expect(dash.status, email).toBe(200);
      expect(headerRole(dash.text), email).toBe(role);
      expect(dash.text, email).not.toContain("· <!-- -->Customer<");
      // the preceding batch's clarified UX is role-independent
      for (const marker of ["Filter by status", "Filter by source", "Filter by assignment", "View / update", "Open a lead to update its status"]) {
        expect(dash.text, `${email} ${marker}`).toContain(marker);
      }
      expect(dash.text.includes("Export CSV"), email).toBe(exportVisible);
      expect(dash.text.includes("Team &amp; access"), email).toBe(teamVisible);
    }
    // platform admin surface is untouched
    const admin = await login("platform-admin@example.invalid");
    const adminPage = await admin.get("/admin");
    expect(adminPage.status).toBe(200);
    expect(adminPage.text).toContain("Platform administrator");
    expect(adminPage.text).not.toContain("Team &amp; access");
  });
  it("switching businesses switches the role, the team link, and drops stale parameters", async () => {
    const s = await login(OWNER_EMAIL);
    const t1 = await s.get(`/dashboard?business=${T1_SLUG}`);
    expect(headerRole(t1.text)).toBe("Owner");
    expect(t1.text).toContain("Team &amp; access");
    const t2 = await s.get(`/dashboard?business=${T2_SLUG}`);
    expect(headerRole(t2.text)).toBe("Manager");
    expect(t2.text).not.toContain("Team &amp; access");
    // the business-switch link itself carries only the slug - no other params survive
    const switchHref = /<nav aria-label="Switch business">[\s\S]*?href="\/dashboard\?business=([a-z0-9-]+)"/.exec(t1.text)?.[1];
    expect(switchHref).toBe(T2_SLUG);
    // a browser-supplied role-ish parameter changes nothing
    const forged = await s.get(`/dashboard?business=${T2_SLUG}&role=BUSINESS_OWNER`);
    expect(headerRole(forged.text)).toBe("Manager");
    expect(forged.text).not.toContain("Team &amp; access");
  });
});

describe("team page visibility and authorization", () => {
  it("owner opens Team & access for the selected business only; manager/staff/admin/anon are denied", async () => {
    const owner = await login(OWNER_EMAIL);
    const page = await owner.get(`/dashboard/team?business=${T1_SLUG}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Team &amp; access");
    expect(page.text).toContain("Owners control who can access");
    for (const name of ["Tango Owner (synthetic)", "Tango Second Owner (synthetic)", "Tango Manager (synthetic)", "Tango Staff (synthetic)"]) {
      expect(page.text).toContain(name);
    }
    expect(page.text).toContain("(you)");
    expect(page.text).toContain("Managed by SnowBeltTech"); // other owners are read-only
    expect(page.text).toContain("Invite team member");
    // no foreign tenant data, no UUID-free guarantees violated: T2's team never appears
    expect(page.text).not.toContain("Uniform Owner (synthetic)");
    // owner of T1 is only MANAGER in T2: the page refuses T2 and returns to the dashboard
    const t2 = await owner.get(`/dashboard/team?business=${T2_SLUG}`);
    expect([302, 303, 307, 308]).toContain(t2.status);
    expect(t2.location).toMatch(new RegExp(`/dashboard\\?business=${T2_SLUG}$`));

    const manager = await login(MANAGER_EMAIL);
    const managerPage = await manager.get(`/dashboard/team?business=${T1_SLUG}`);
    expect([302, 303, 307, 308]).toContain(managerPage.status);
    expect(visible(managerPage.text)).not.toContain("Tango Staff (synthetic)");
    const staff = await login(STAFF_EMAIL);
    expect([302, 303, 307, 308]).toContain((await staff.get(`/dashboard/team?business=${T1_SLUG}`)).status);
    const admin = await login("platform-admin@example.invalid");
    const adminTry = await admin.get(`/dashboard/team?business=${T1_SLUG}`);
    expect([302, 303, 307, 308]).toContain(adminTry.status);
    expect(adminTry.location).toMatch(/\/admin$/);
    const anon = await new Session().get(`/dashboard/team?business=${T1_SLUG}`);
    expect([302, 303, 307, 308]).toContain(anon.status);
    expect(anon.location).toMatch(/\/login$/);
  });
  it("action authorization: anon 401, manager/staff 403, foreign/unknown business opaque 404, admin 404", async () => {
    const anon = await new Session().post("/api/team/actions", { action: "set_member_role", business: T1_SLUG, user_id: U_STAFF, role: "BUSINESS_MANAGER" });
    expect(anon.status).toBe(401);
    const manager = await login(MANAGER_EMAIL);
    expect((await manager.post("/api/team/actions", { action: "set_member_role", business: T1_SLUG, user_id: U_STAFF, role: "BUSINESS_MANAGER" })).status).toBe(403);
    expect((await manager.post("/api/team/actions", { action: "invite_member", business: T1_SLUG, email: "m@x.invalid", display_name: "X", role: "BUSINESS_STAFF" })).status).toBe(403);
    const staff = await login(STAFF_EMAIL);
    expect((await staff.post("/api/team/actions", { action: "invite_member", business: T1_SLUG, email: "s@x.invalid", display_name: "X", role: "BUSINESS_STAFF" })).status).toBe(403);
    const owner = await login(OWNER_EMAIL);
    // owner of T1 but only manager of T2 -> T2 actions are 403; foreign/unknown slugs opaque 404
    expect((await owner.post("/api/team/actions", { action: "set_member_role", business: T2_SLUG, user_id: U_STAFF, role: "BUSINESS_STAFF" })).status).toBe(403);
    const foreign = await owner.post("/api/team/actions", { action: "set_member_role", business: "alpha-hvac", user_id: U_STAFF, role: "BUSINESS_STAFF" });
    const unknown = await owner.post("/api/team/actions", { action: "set_member_role", business: "does-not-exist", user_id: U_STAFF, role: "BUSINESS_STAFF" });
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(foreign.text).toBe(unknown.text);
    const admin = await login("platform-admin@example.invalid");
    expect((await admin.post("/api/team/actions", { action: "set_member_role", business: T1_SLUG, user_id: U_STAFF, role: "BUSINESS_MANAGER" })).status).toBe(404);
    expect(membership(BIZ_T1, U_STAFF)).toBe("BUSINESS_STAFF|active"); // nothing moved
    // cross-site + malformed forms
    expect((await owner.post("/api/team/actions", { action: "set_member_role", business: T1_SLUG, user_id: U_STAFF, role: "BUSINESS_MANAGER" }, { origin: "https://evil.example.invalid", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await owner.postRaw("/api/team/actions", `action=set_member_role&business=${T1_SLUG}&user_id=${U_STAFF}&role=BUSINESS_MANAGER&role=BUSINESS_STAFF`)).location).toMatch(/err=duplicate_field$/);
    expect((await owner.postRaw("/api/team/actions", `action=set_member_role&business=${T1_SLUG}&user_id=${U_STAFF}&role=BUSINESS_MANAGER&redirect_to=https%3A%2F%2Fevil.invalid`)).location).toMatch(/err=unexpected_field$/);
  });
});

describe("owner team mutations", () => {
  it("owner changes Manager <-> Staff, deactivates and reactivates; self and other owners are protected", async () => {
    const owner = await login(OWNER_EMAIL);
    const act = (form: Record<string, string>) => owner.post("/api/team/actions", { business: T1_SLUG, ...form });
    expect((await act({ action: "set_member_role", user_id: U_STAFF, role: "BUSINESS_MANAGER" })).location).toMatch(/ok=member_role_updated$/);
    expect(membership(BIZ_T1, U_STAFF)).toBe("BUSINESS_MANAGER|active");
    expect((await act({ action: "set_member_role", user_id: U_STAFF, role: "BUSINESS_STAFF" })).location).toMatch(/ok=member_role_updated$/);
    expect(membership(BIZ_T1, U_STAFF)).toBe("BUSINESS_STAFF|active");
    expect((await act({ action: "set_member_status", user_id: U_MANAGER, status: "inactive" })).location).toMatch(/ok=member_status_updated$/);
    expect(membership(BIZ_T1, U_MANAGER)).toBe("BUSINESS_MANAGER|inactive");
    // deactivation revokes access on the manager's next request
    const manager = await login(MANAGER_EMAIL);
    expect((await manager.get(`/dashboard?business=${T1_SLUG}`)).location).toMatch(/\/no-access$/);
    // repeated deactivation stays a safe no-op; the page shows the inactive state + reactivate control
    expect((await act({ action: "set_member_status", user_id: U_MANAGER, status: "inactive" })).location).toMatch(/ok=member_status_updated$/);
    const page = await owner.get(`/dashboard/team?business=${T1_SLUG}`);
    expect(page.text).toContain("Reactivate access");
    expect((await act({ action: "set_member_status", user_id: U_MANAGER, status: "active" })).location).toMatch(/ok=member_status_updated$/);
    expect(membership(BIZ_T1, U_MANAGER)).toBe("BUSINESS_MANAGER|active");
    expect((await manager.get(`/dashboard?business=${T1_SLUG}`)).status).toBe(200);
    // prohibited: self, other owners, promotion INTO ownership
    expect((await act({ action: "set_member_role", user_id: U_OWNER, role: "BUSINESS_MANAGER" })).location).toMatch(/err=self_forbidden$/);
    expect((await act({ action: "set_member_status", user_id: U_OWNER, status: "inactive" })).location).toMatch(/err=self_forbidden$/);
    expect((await act({ action: "set_member_role", user_id: U_OWNER2, role: "BUSINESS_STAFF" })).location).toMatch(/err=owner_protected$/);
    expect((await act({ action: "set_member_status", user_id: U_OWNER2, status: "inactive" })).location).toMatch(/err=owner_protected$/);
    expect((await owner.postRaw("/api/team/actions", `action=set_member_role&business=${T1_SLUG}&user_id=${U_STAFF}&role=BUSINESS_OWNER`)).location).toMatch(/err=invalid_role$/);
    expect(membership(BIZ_T1, U_OWNER)).toBe("BUSINESS_OWNER|active");
    expect(membership(BIZ_T1, U_OWNER2)).toBe("BUSINESS_OWNER|active");
    // foreign membership UUIDs are inert (T2's owner inside T1)
    expect((await act({ action: "set_member_status", user_id: U_T2OWNER, status: "inactive" })).location).toMatch(/err=not_found$/);
    expect(membership(BIZ_T2, U_T2OWNER)).toBe("BUSINESS_OWNER|active");
    // audit rows carry the owner actor through the existing ledger
    expect(Number(sql(`select count(*) from public.customer_access_events where business_id = '${BIZ_T1}' and actor_id = '${U_OWNER}' and event_type in ('membership_role_changed','membership_status_changed')`))).toBeGreaterThanOrEqual(4);
  });
  it("owner invites a Manager through the real mail flow; the invitee lands with the invited role", async () => {
    const owner = await login(OWNER_EMAIL);
    const invited = await owner.post("/api/team/actions", { action: "invite_member", business: T1_SLUG, email: ` ${INVITEE_EMAIL.toUpperCase()} `, display_name: "Tango Invitee", role: "BUSINESS_MANAGER" });
    expect(invited.status).toBe(303);
    expect(invited.location).toMatch(/ok=invited$/);
    expect(invited.location).not.toContain("tango.example"); // no email in URLs
    expect(invitation(INVITEE_EMAIL)).toBe("sent");
    // the pending invitation is visible to the owner, with a revoke control
    const page = await owner.get(`/dashboard/team?business=${T1_SLUG}`);
    expect(page.text).toContain(INVITEE_EMAIL);
    expect(page.text).toContain("Pending invitation");
    expect(page.text).not.toContain("token_hash");
    // duplicate submission cannot create a second usable invitation
    expect((await owner.post("/api/team/actions", { action: "invite_member", business: T1_SLUG, email: INVITEE_EMAIL, display_name: "Dup", role: "BUSINESS_STAFF" })).location).toMatch(/err=invitation_exists$/);
    // owner cannot invite an owner (server-side, crafted request)
    expect((await owner.postRaw("/api/team/actions", `action=invite_member&business=${T1_SLUG}&email=own%40tango.example.invalid&display_name=X&role=BUSINESS_OWNER`)).location).toMatch(/err=invalid_role$/);
    // the invitee accepts through the untouched invitation flow and arrives as Manager
    const link = await inviteLink(INVITEE_EMAIL);
    const inviteeSession = new Session();
    const followed = await fetch(link, { redirect: "manual" });
    inviteeSession.absorb(followed);
    expect(followed.status).toBe(303);
    expect(followed.headers.get("location")).toMatch(/\/account\/setup$/);
    const set = await inviteeSession.post("/api/account/setup", { password: NEW_PASSWORD, password_confirm: NEW_PASSWORD });
    expect(set.location).toMatch(/\/dashboard$/);
    expect(membership(BIZ_T1, sql(`select id::text from auth.users where lower(email) = '${INVITEE_EMAIL}'`))).toBe("BUSINESS_MANAGER|active");
    const invitee = await login(INVITEE_EMAIL, NEW_PASSWORD);
    const dash = await invitee.get(`/dashboard?business=${T1_SLUG}`);
    expect(headerRole(dash.text)).toBe("Manager");
    expect(dash.text).not.toContain("Team &amp; access");
  });
  it("owner revocation and failed-delivery compensation preserve the hardened invitation lifecycle", async () => {
    const owner = await login(OWNER_EMAIL);
    // revoke: prepare a fresh invitation, capture the link, revoke, link is dead, auth account cleaned
    const revokeEmail = `team-revoke-${RUN}@tango.example.invalid`;
    expect((await owner.post("/api/team/actions", { action: "invite_member", business: T1_SLUG, email: revokeEmail, display_name: "Tango Revoked", role: "BUSINESS_STAFF" })).location).toMatch(/ok=invited$/);
    const link = await inviteLink(revokeEmail);
    const invId = sql(`select id::text from public.customer_invitations where email = '${revokeEmail}'`);
    expect((await owner.post("/api/team/actions", { action: "revoke_invitation", business: T1_SLUG, invitation_id: invId })).location).toMatch(/ok=invitation_revoked$/);
    expect(invitation(revokeEmail)).toBe("revoked");
    expect(authUsers(revokeEmail)).toBe(0); // unaccepted Auth account cleaned through the coordinator
    const dead = await fetch(link, { redirect: "manual" });
    expect(dead.headers.get("location")).toMatch(/\/login\?error=invite$/);
    // a foreign owner cannot revoke Tango invitations (T2 owner, T2 slug + Tango invitation id)
    const t2owner = await login(T2OWNER_EMAIL);
    const foreign = await t2owner.post("/api/team/actions", { action: "revoke_invitation", business: T2_SLUG, invitation_id: invId });
    expect(foreign.location).toMatch(/err=invalid_invitation$/); // opaque: unknown and foreign are identical
    expect(invitation(revokeEmail)).toBe("revoked"); // and the foreign attempt changed nothing
    // failed delivery: stop the catcher; the invitation fails closed and the email is immediately reinvitable
    const stop = spawnSync("docker", ["stop", MAIL_CONTAINER], { encoding: "utf8" });
    expect(stop.status).toBe(0);
    try {
      const r = await owner.post("/api/team/actions", { action: "invite_member", business: T1_SLUG, email: FAILMAIL_EMAIL, display_name: "Tango Failmail", role: "BUSINESS_STAFF" });
      expect(r.location).toMatch(/err=invite_delivery_failed$/);
    } finally {
      expect(spawnSync("docker", ["start", MAIL_CONTAINER], { encoding: "utf8" }).status).toBe(0);
    }
    expect(invitation(FAILMAIL_EMAIL)).toBe("failed");
    expect(authUsers(FAILMAIL_EMAIL)).toBe(0); // exact-provenance compensation held for the owner path
    expect((await owner.post("/api/team/actions", { action: "invite_member", business: T1_SLUG, email: FAILMAIL_EMAIL, display_name: "Tango Failmail", role: "BUSINESS_STAFF" })).location).toMatch(/ok=invited$/);
    const inv2 = sql(`select id::text from public.customer_invitations where email = '${FAILMAIL_EMAIL}' and status = 'sent'`);
    expect((await owner.post("/api/team/actions", { action: "revoke_invitation", business: T1_SLUG, invitation_id: inv2 })).location).toMatch(/ok=invitation_revoked$/);
    expect(authUsers(FAILMAIL_EMAIL)).toBe(0);
  });
  it("tenant isolation: owners see and touch only their own business's team and invitations", async () => {
    const ownerA = await login("owner-a@example.invalid");
    // Business A's owner (seeded) gets Team & access for Business A but never Tango data
    const pageA = await ownerA.get("/dashboard/team");
    expect(pageA.status).toBe(200);
    expect(headerRole(pageA.text)).toBe("Owner");
    for (const name of ["Owner A (synthetic)", "Manager A (synthetic)", "Staff A (synthetic)"]) expect(pageA.text).toContain(name);
    expect(pageA.text).not.toContain("Tango");
    expect(pageA.text).not.toContain(INVITEE_EMAIL);
    // and cannot mutate Tango members even with crafted identifiers
    expect((await ownerA.post("/api/team/actions", { action: "set_member_status", business: T1_SLUG, user_id: U_STAFF, status: "inactive" })).status).toBe(404);
    expect((await ownerA.post("/api/team/actions", { action: "set_member_status", business: "alpha-hvac", user_id: U_STAFF, status: "inactive" })).location).toMatch(/err=not_found$/);
    expect(membership(BIZ_T1, U_STAFF)).toBe("BUSINESS_STAFF|active");
    // suspended business: the owner loses the team surface entirely
    sql(`update public.businesses set status = 'suspended' where id = '${BIZ_T1}'`);
    try {
      const owner = await login(OWNER_EMAIL);
      const suspended = await owner.get(`/dashboard/team?business=${T1_SLUG}`);
      expect([302, 303, 307, 308]).toContain(suspended.status); // no active T1 -> selection falls to T2 (manager) -> back to dashboard
      expect((await owner.post("/api/team/actions", { action: "set_member_status", business: T1_SLUG, user_id: U_STAFF, status: "inactive" })).status).toBe(404);
    } finally {
      sql(`update public.businesses set status = 'active' where id = '${BIZ_T1}'`);
    }
  });
});

describe("logs and bundles", () => {
  it("no email, name, token, JWT, cookie or secret in server logs; no privileged module in browser assets", async () => {
    const log = serverLog.join("");
    for (const forbidden of [
      OWNER_EMAIL, MANAGER_EMAIL, STAFF_EMAIL, INVITEE_EMAIL, FAILMAIL_EMAIL, "tango.example.invalid",
      "Tango Owner", "Tango Invitee", NEW_PASSWORD, PASSWORD, "token_hash=", "portal_invitation_id",
      SERVICE_KEY, INGEST_TOKEN,
    ]) {
      expect(log, forbidden.slice(0, 24)).not.toContain(forbidden);
    }
    expect(log).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\./);
    expect(log).toContain('"event":"team_action"');
    expect(log).toContain('"category":"role_denied"');
    const files: string[] = [];
    const walk = (dir: string) => { for (const f of readdirSync(dir)) { const p = path.join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(js|css|json|html|txt)$/.test(f)) files.push(p); } };
    walk(path.join(ROOT, ".next", "static"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const forbidden of [SERVICE_KEY, INGEST_TOKEN, "SUPABASE_SERVICE_ROLE_KEY", "supabase-admin", "supabase-auth-admin", "inviteUserByEmail", "portal_invitation_id", "team_management_actor"]) {
        expect(text, path.basename(f)).not.toContain(forbidden);
      }
    }
  });
});
