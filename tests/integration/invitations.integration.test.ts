// Real invitation-only customer provisioning: local Supabase Auth + the local
// mail catcher (Mailpit web API on 54324) + the production Next.js server.
// Synthetic .invalid addresses only. No service-role client is used for any
// authorization assertion (privileged SQL/docker is fixture setup + cleanup).
// Prerequisites: pnpm run db:start && pnpm run env:local && pnpm build
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const BASE = "http://127.0.0.1:3000";
const MAIL = "http://127.0.0.1:54324";
const CONTAINER = "supabase_db_Dashboard_SnowBeltTech";
const MAIL_CONTAINER = "supabase_inbucket_Dashboard_SnowBeltTech";
const PASSWORD = "local-seed-only";
const RUN = `inv-it-${Date.now().toString(36)}`;
const BIZ_A = "a0000000-0000-4000-8000-000000000001";
const SLUG = "juliet-hvac-it";
const NAME = "Juliet HVAC (synthetic IT)";
const OWNER_EMAIL = `owner-${RUN}@juliet.example.invalid`;
const MANAGER_EMAIL = `manager-${RUN}@juliet.example.invalid`;
const STAFF_EMAIL = `staff-${RUN}@juliet.example.invalid`;
const REVOKED_EMAIL = `revoked-${RUN}@juliet.example.invalid`;
const FAILED_EMAIL = `failed-${RUN}@juliet.example.invalid`;
const ALL_EMAILS = [OWNER_EMAIL, MANAGER_EMAIL, STAFF_EMAIL, REVOKED_EMAIL, FAILED_EMAIL];
const NEW_PASSWORD = `Set-By-Invitee-${RUN}-42`;

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
const invitation = (email: string) => sql(`select coalesce((select id::text || '|' || status || '|' || coalesce(auth_user_id::text, '-') from public.customer_invitations where email = '${email}' order by created_at desc limit 1), '')`);
const membership = (email: string) => sql(`select coalesce((select m.role || '|' || m.status from public.business_memberships m join auth.users u on u.id = m.user_id where lower(u.email) = '${email}'), '')`);
const authUsers = (email: string) => Number(sql(`select count(*) from auth.users where lower(email) = '${email}'`));
const userId = (email: string) => sql(`select coalesce((select id::text from auth.users where lower(email) = '${email}'), '')`);
const accessEvents = (id: string) => Number(sql(`select count(*) from public.customer_access_events where business_id = '${id}'`));

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
  if (r.status !== 303 || !r.location?.endsWith("/")) throw new Error(`login failed for ${email.slice(0, 4)}…`);
  return s;
}

// ---- local mail catcher (Mailpit web API) ----------------------------------
interface MailSummary { ID: string; To: Array<{ Address: string }>; Subject: string }
async function mailFor(address: string): Promise<MailSummary[]> {
  const res = await fetch(`${MAIL}/api/v1/messages?limit=100`);
  const body = (await res.json()) as { messages: MailSummary[] };
  return (body.messages ?? []).filter((m) => m.To.some((t) => t.Address.toLowerCase() === address.toLowerCase()));
}
/** Extracts the /auth/confirm link for an address — HARNESS ONLY, never shown in app surfaces. */
async function invitationLink(address: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const msgs = await mailFor(address);
    if (msgs.length > 0) {
      const detail = await fetch(`${MAIL}/api/v1/message/${msgs[0]!.ID}`);
      const body = (await detail.json()) as { HTML?: string; Text?: string };
      const html = `${body.HTML ?? ""}\n${body.Text ?? ""}`.replace(/&amp;/g, "&");
      const m = /(http:\/\/127\.0\.0\.1:3000\/auth\/confirm\?token_hash=[A-Za-z0-9_-]+&type=invite)/.exec(html);
      if (m) return m[1]!;
      throw new Error("invitation email did not contain the expected confirm link shape");
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("invitation email never arrived");
}

async function followInvitation(link: string): Promise<Session> {
  const s = new Session();
  const res = await fetch(link, { redirect: "manual" });
  s.absorb(res);
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toMatch(/\/account\/setup$/);
  return s;
}

const invite = (s: Session, id: string, email: string, name: string, role: string) =>
  s.post(`/api/admin/businesses/${id}/actions`, { action: "invite_member", email, display_name: name, role });

let server: ChildProcess | null = null;
const serverLog: string[] = [];

beforeAll(async () => {
  await fetch(`${MAIL}/api/v1/messages`, { method: "DELETE" }).catch(() => undefined);
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
  // Remove everything this run created (FK order); privileged SQL is cleanup only.
  const id = bizId();
  if (id) {
    sql(`delete from public.customer_access_events where business_id = '${id}';
         delete from public.customer_invitations where business_id = '${id}';
         delete from public.ingestion_events where business_id = '${id}';
         delete from public.lead_activities where business_id = '${id}';
         delete from public.leads where business_id = '${id}';
         delete from public.lead_number_counters where business_id = '${id}';
         delete from public.platform_admin_events where business_id = '${id}';
         delete from public.integration_sources where business_id = '${id}';`);
    for (const e of ALL_EMAILS) sql(`delete from auth.users where lower(email) = '${e}'`); // cascades profiles -> memberships
    sql(`delete from public.businesses where id = '${id}'`);
  }
  await fetch(`${MAIL}/api/v1/messages`, { method: "DELETE" }).catch(() => undefined);
});

describe("owner invitation end to end", () => {
  it("1-8: invite -> local email -> confirm link -> profile/membership/acceptance, replay-safe", async () => {
    const admin = await login("platform-admin@example.invalid");
    const created = await admin.post("/api/admin/businesses/actions", { action: "create_business", name: NAME, slug: SLUG, industry: "hvac", timezone: "America/New_York" });
    expect(created.status).toBe(303);
    const id = bizId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    // an unprovisioned business must start with its owner
    const staffFirst = await invite(admin, id, STAFF_EMAIL, "Juliet Staff", "BUSINESS_STAFF");
    expect(staffFirst.location).toMatch(/err=owner_required$/);

    const invited = await invite(admin, id, ` ${OWNER_EMAIL.toUpperCase()} `, "Juliet Owner", "BUSINESS_OWNER");
    expect(invited.status).toBe(303);
    expect(invited.location).toMatch(/ok=invited$/);
    expect(invited.location).not.toContain("juliet.example");
    const [invId, invStatus, invAuth] = invitation(OWNER_EMAIL).split("|");
    expect(invStatus).toBe("sent");
    expect(invAuth).toBe(userId(OWNER_EMAIL));
    expect(authUsers(OWNER_EMAIL)).toBe(1);
    // the exact provenance marker is really persisted by GoTrue on the invited account
    expect(sql(`select raw_user_meta_data->>'portal_invitation_id' from auth.users where lower(email) = '${OWNER_EMAIL}'`)).toBe(invId);

    // duplicates and already-registered emails are refused without another email
    expect((await invite(admin, id, OWNER_EMAIL, "Dup", "BUSINESS_OWNER")).location).toMatch(/err=invitation_exists$/);
    expect((await invite(admin, id, "owner-a@example.invalid", "Existing", "BUSINESS_OWNER")).location).toMatch(/err=email_in_use$/);

    // the admin page shows the invitation state but never a token or confirm URL
    const page = await admin.get(`/admin/businesses/${id}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain(OWNER_EMAIL);
    expect(page.text).toContain("Juliet Owner");
    expect(page.text).toContain("sent");
    expect(page.text).not.toContain("token_hash");
    expect(page.text).not.toContain("/auth/confirm");

    // exactly one synthetic email in the local catcher; link extracted ONLY here
    const msgs = await mailFor(OWNER_EMAIL);
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.Subject).toContain("invited");
    const link = await invitationLink(OWNER_EMAIL);

    const invitee = await followInvitation(link);
    expect(membership(OWNER_EMAIL)).toBe("BUSINESS_OWNER|active");
    expect(sql(`select display_name || '|' || coalesce(platform_role, '-') from public.profiles where id = '${userId(OWNER_EMAIL)}'`)).toBe("Juliet Owner|-");
    expect(invitation(OWNER_EMAIL)).toBe(`${invId}|accepted|${userId(OWNER_EMAIL)}`);
    expect(sql(`select count(*) from public.customer_access_events where invitation_id = '${invId}'`)).toBe("3"); // prepared, sent, accepted

    // replaying the consumed link cannot create anything or grant a session
    const replay = await fetch(link, { redirect: "manual" });
    expect(replay.status).toBe(303);
    expect(replay.headers.get("location")).toMatch(/\/login\?error=invite$/);
    expect(sql(`select count(*) from public.business_memberships m join auth.users u on u.id = m.user_id where lower(u.email) = '${OWNER_EMAIL}'`)).toBe("1");
    expect(sql(`select count(*) from public.customer_access_events where invitation_id = '${invId}'`)).toBe("3");

    // 9-10: initial password through the real setup action, then a real sign-in
    expect((await invitee.get("/account/setup")).status).toBe(200);
    expect((await invitee.post("/api/account/setup", { password: NEW_PASSWORD, password_confirm: "different-password-42" })).location).toMatch(/err=password_mismatch$/);
    expect((await invitee.post("/api/account/setup", { password: "short", password_confirm: "short" })).location).toMatch(/err=password_too_short$/);
    const set = await invitee.post("/api/account/setup", { password: NEW_PASSWORD, password_confirm: NEW_PASSWORD });
    expect(set.status).toBe(303);
    expect(set.location).toMatch(/\/dashboard$/);
    await invitee.post("/api/auth/logout", {});
    const owner = await login(OWNER_EMAIL, NEW_PASSWORD);

    // 11-12: correct tenant, nothing else
    const dash = await owner.get("/dashboard");
    expect(dash.status).toBe(200);
    expect(dash.text).toContain(NAME);
    for (const marker of ["Alpha HVAC (synthetic)", "Bravo Plumbing (synthetic)", "Test Contact One"]) expect(dash.text).not.toContain(marker);
    const adminPage = await owner.get("/admin");
    expect(adminPage.status).not.toBe(200);
    const sb = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    expect((await sb.auth.signInWithPassword({ email: OWNER_EMAIL, password: NEW_PASSWORD })).error).toBeNull();
    try {
      expect((await sb.from("customer_invitations").select("id")).data).toEqual([]);
      expect((await sb.from("customer_access_events").select("id")).data).toEqual([]);
      expect((await sb.from("integration_sources").select("id")).data).toEqual([]);
      expect((await sb.from("platform_admin_events").select("id")).data).toEqual([]);
      expect((await sb.from("businesses").select("id").eq("id", BIZ_A)).data).toEqual([]);
      // ordinary customers cannot call the administrator invitation/membership RPCs
      expect((await sb.rpc("admin_prepare_customer_invitation", { p_business_id: id, p_email: "x@y.invalid", p_display_name: "X", p_role: "BUSINESS_STAFF" })).error?.code).toBe("42501");
      expect((await sb.rpc("admin_set_business_member_status", { p_business_id: id, p_user_id: userId(OWNER_EMAIL), p_status: "inactive" })).error?.code).toBe("42501");
    } finally {
      await sb.auth.signOut({ scope: "local" });
    }
  });
});

describe("team provisioning, roles and membership lifecycle", () => {
  it("13-19: manager/staff invitations, role permissions, deactivate/reactivate, last-owner protection", async () => {
    const admin = await login("platform-admin@example.invalid");
    const id = bizId();
    // a lead for permission checks (through the real ingestion path)
    await admin.post(`/api/admin/businesses/${id}/actions`, { action: "create_source", kind: "website_form", external_id: `site-${RUN}` });
    const ing = await fetch(`${BASE}/api/internal/ingest`, {
      method: "POST",
      headers: { authorization: `Bearer ${INGEST_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ source_kind: "website_form", source_external_id: `site-${RUN}`, source_event_id: `${RUN}-lead-1`, payload: { contact_name: "Juliet Caller", sms_consent: false } }),
    });
    expect(ing.status).toBe(201);
    const leadId = sql(`select id::text from public.leads where source_event_id = '${RUN}-lead-1'`);

    for (const [email, name, role] of [[MANAGER_EMAIL, "Juliet Manager", "BUSINESS_MANAGER"], [STAFF_EMAIL, "Juliet Staff", "BUSINESS_STAFF"]] as const) {
      expect((await invite(admin, id, email, name, role)).location).toMatch(/ok=invited$/);
      const invitee = await followInvitation(await invitationLink(email));
      expect(membership(email)).toBe(`${role}|active`);
      const set = await invitee.post("/api/account/setup", { password: NEW_PASSWORD, password_confirm: NEW_PASSWORD });
      expect(set.location).toMatch(/\/dashboard$/);
      await invitee.post("/api/auth/logout", {});
    }

    // 14: staff cannot assign; manager can (existing rules, new tenant)
    const staff = await login(STAFF_EMAIL, NEW_PASSWORD);
    const staffAssign = await staff.post(`/api/leads/${leadId}/actions`, { action: "set_assignee", assignee_id: userId(STAFF_EMAIL) });
    expect(staffAssign.location).toMatch(/err=not_allowed$/);
    const manager = await login(MANAGER_EMAIL, NEW_PASSWORD);
    const managerAssign = await manager.post(`/api/leads/${leadId}/actions`, { action: "set_assignee", assignee_id: userId(STAFF_EMAIL) });
    expect(managerAssign.location).toMatch(/ok=set_assignee$/);

    // 15: role change takes effect on the next request
    const promote = await admin.post(`/api/admin/businesses/${id}/actions`, { action: "set_member_role", user_id: userId(STAFF_EMAIL), role: "BUSINESS_MANAGER" });
    expect(promote.location).toMatch(/ok=member_role_updated$/);
    const nowManagerAssign = await staff.post(`/api/leads/${leadId}/actions`, { action: "set_assignee", assignee_id: "" });
    expect(nowManagerAssign.location).toMatch(/ok=set_assignee$/);
    const demote = await admin.post(`/api/admin/businesses/${id}/actions`, { action: "set_member_role", user_id: userId(STAFF_EMAIL), role: "BUSINESS_STAFF" });
    expect(demote.location).toMatch(/ok=member_role_updated$/);

    // 16-17: deactivation removes access immediately; reactivation restores it; data survives
    const before = accessEvents(id);
    const off = await admin.post(`/api/admin/businesses/${id}/actions`, { action: "set_member_status", user_id: userId(MANAGER_EMAIL), status: "inactive" });
    expect(off.location).toMatch(/ok=member_status_updated$/);
    const blocked = await manager.get("/dashboard");
    expect(blocked.status).not.toBe(200);
    expect(blocked.location).toMatch(/\/no-access$/);
    const sbM = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    expect((await sbM.auth.signInWithPassword({ email: MANAGER_EMAIL, password: NEW_PASSWORD })).error).toBeNull(); // authentication alone grants nothing
    try {
      expect((await sbM.from("leads").select("id")).data).toEqual([]);
      expect((await sbM.from("businesses").select("id")).data).toEqual([]);
    } finally {
      await sbM.auth.signOut({ scope: "local" });
    }
    expect(sql(`select count(*) from public.leads where business_id = '${id}'`)).toBe("1");
    expect(membership(MANAGER_EMAIL)).toBe("BUSINESS_MANAGER|inactive");
    const on = await admin.post(`/api/admin/businesses/${id}/actions`, { action: "set_member_status", user_id: userId(MANAGER_EMAIL), status: "active" });
    expect(on.location).toMatch(/ok=member_status_updated$/);
    expect((await manager.get("/dashboard")).status).toBe(200);
    expect(accessEvents(id)).toBe(before + 2);

    // 18-19: last-owner protection, then promote-and-demote
    const events = accessEvents(id);
    expect((await admin.post(`/api/admin/businesses/${id}/actions`, { action: "set_member_status", user_id: userId(OWNER_EMAIL), status: "inactive" })).location).toMatch(/err=last_owner$/);
    expect((await admin.post(`/api/admin/businesses/${id}/actions`, { action: "set_member_role", user_id: userId(OWNER_EMAIL), role: "BUSINESS_STAFF" })).location).toMatch(/err=last_owner$/);
    expect(membership(OWNER_EMAIL)).toBe("BUSINESS_OWNER|active");
    expect(accessEvents(id)).toBe(events); // rejected attempts audit nothing
    expect((await admin.post(`/api/admin/businesses/${id}/actions`, { action: "set_member_role", user_id: userId(MANAGER_EMAIL), role: "BUSINESS_OWNER" })).location).toMatch(/ok=member_role_updated$/);
    expect((await admin.post(`/api/admin/businesses/${id}/actions`, { action: "set_member_role", user_id: userId(OWNER_EMAIL), role: "BUSINESS_MANAGER" })).location).toMatch(/ok=member_role_updated$/);
    expect(membership(OWNER_EMAIL)).toBe("BUSINESS_MANAGER|active");
    // restore the original owner for later assertions
    expect((await admin.post(`/api/admin/businesses/${id}/actions`, { action: "set_member_role", user_id: userId(OWNER_EMAIL), role: "BUSINESS_OWNER" })).location).toMatch(/ok=member_role_updated$/);
    expect((await admin.post(`/api/admin/businesses/${id}/actions`, { action: "set_member_role", user_id: userId(MANAGER_EMAIL), role: "BUSINESS_MANAGER" })).location).toMatch(/ok=member_role_updated$/);
  });
});

describe("revocation, failure compensation and hardening", () => {
  it("20: a revoked invitation's captured link can never provision access", async () => {
    const admin = await login("platform-admin@example.invalid");
    const id = bizId();
    expect((await invite(admin, id, REVOKED_EMAIL, "Juliet Revoked", "BUSINESS_STAFF")).location).toMatch(/ok=invited$/);
    const link = await invitationLink(REVOKED_EMAIL);
    const [invId] = invitation(REVOKED_EMAIL).split("|");
    const revoke = await admin.post(`/api/admin/businesses/${id}/actions`, { action: "revoke_invitation", invitation_id: invId! });
    expect(revoke.location).toMatch(/ok=invitation_revoked$/);
    expect(invitation(REVOKED_EMAIL).split("|")[1]).toBe("revoked");
    expect(authUsers(REVOKED_EMAIL)).toBe(0); // unaccepted Auth account cleaned up
    const followed = await fetch(link, { redirect: "manual" });
    expect(followed.status).toBe(303);
    expect(followed.headers.get("location")).toMatch(/\/login\?error=invite$/);
    expect(membership(REVOKED_EMAIL)).toBe("");
    expect(sql(`select count(*) from public.profiles p join public.customer_invitations i on i.auth_user_id = p.id where i.id = '${invId}'`)).toBe("0");
    // 21: replayed revocation and duplicate submissions stay safe
    expect((await admin.post(`/api/admin/businesses/${id}/actions`, { action: "revoke_invitation", invitation_id: invId! })).location).toMatch(/ok=invitation_revoked$/);
    expect(sql(`select count(*) from public.customer_access_events where invitation_id = '${invId}' and event_type = 'invitation_revoked'`)).toBe("1");
  });
  it("22: a controlled delivery failure compensates fully - the same email is reinvitable with NO privileged cleanup", async () => {
    const admin = await login("platform-admin@example.invalid");
    const id = bizId();
    const stop = spawnSync("docker", ["stop", MAIL_CONTAINER], { encoding: "utf8" });
    expect(stop.status).toBe(0);
    try {
      const r = await invite(admin, id, FAILED_EMAIL, "Juliet Failed", "BUSINESS_STAFF");
      expect(r.status).toBe(303);
      expect(r.location).toMatch(/err=invite_delivery_failed$/);
    } finally {
      const start = spawnSync("docker", ["start", MAIL_CONTAINER], { encoding: "utf8" });
      expect(start.status).toBe(0);
    }
    // application-level compensation only from here on: NO privileged SQL cleanup
    expect(invitation(FAILED_EMAIL).split("|")[1]).toBe("failed");
    expect(membership(FAILED_EMAIL)).toBe("");
    expect(sql(`select count(*) from public.profiles p join auth.users u on u.id = p.id where lower(u.email) = '${FAILED_EMAIL}'`)).toBe("0");
    expect(authUsers(FAILED_EMAIL)).toBe(0); // rolled back by Auth, or removed by the coordinator's bounded cleanup
    expect(sql(`select count(*) from public.customer_access_events where event_type = 'invitation_failed' and business_id = '${id}'`)).toBe("1");
    // the same email is immediately reinvitable through the application alone
    expect((await invite(admin, id, FAILED_EMAIL, "Juliet Failed", "BUSINESS_STAFF")).location).toMatch(/ok=invited$/);
    expect(invitation(FAILED_EMAIL).split("|")[1]).toBe("sent");
    const link = await invitationLink(FAILED_EMAIL); // the new email really arrived through the catcher
    expect(link).toContain("/auth/confirm?token_hash=");
    const [inv2] = invitation(FAILED_EMAIL).split("|");
    expect((await admin.post(`/api/admin/businesses/${id}/actions`, { action: "revoke_invitation", invitation_id: inv2! })).location).toMatch(/ok=invitation_revoked$/);
    expect(authUsers(FAILED_EMAIL)).toBe(0); // revocation cleanup, as before
  });
  it("archived businesses reject membership administration at every boundary", async () => {
    const admin = await login("platform-admin@example.invalid");
    const id = bizId();
    const memberState = () => sql(`select string_agg(m.role || '/' || m.status, ',' order by m.created_at) from public.business_memberships m where m.business_id = '${id}'`);
    const before = memberState();
    const eventsBefore = accessEvents(id);
    sql(`update public.businesses set status = 'archived' where id = '${id}'`); // fixture only
    try {
      // real HTTP route with crafted valid forms (the UI hides these controls)
      const role = await admin.post(`/api/admin/businesses/${id}/actions`, { action: "set_member_role", user_id: userId(STAFF_EMAIL), role: "BUSINESS_MANAGER" });
      expect(role.location).toMatch(/err=not_operable$/);
      const status = await admin.post(`/api/admin/businesses/${id}/actions`, { action: "set_member_status", user_id: userId(STAFF_EMAIL), status: "inactive" });
      expect(status.location).toMatch(/err=not_operable$/);
      // direct RPC calls under the administrator's real anon-key session
      const sb = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      expect((await sb.auth.signInWithPassword({ email: "platform-admin@example.invalid", password: PASSWORD })).error).toBeNull();
      try {
        const r1 = await sb.rpc("admin_set_business_member_role", { p_business_id: id, p_user_id: userId(STAFF_EMAIL), p_role: "BUSINESS_MANAGER" });
        expect(r1.error?.code).toBe("55000");
        const r2 = await sb.rpc("admin_set_business_member_status", { p_business_id: id, p_user_id: userId(STAFF_EMAIL), p_status: "inactive" });
        expect(r2.error?.code).toBe("55000");
      } finally {
        await sb.auth.signOut({ scope: "local" });
      }
      expect(memberState()).toBe(before);
      expect(accessEvents(id)).toBe(eventsBefore);
      // the archived detail page stays read-only for memberships
      const page = await admin.get(`/admin/businesses/${id}`);
      expect(page.status).toBe(200);
      expect(page.text).not.toContain('value="set_member_role"');
      expect(page.text).not.toContain('value="set_member_status"');
      expect(page.text).not.toContain('value="invite_member"');
    } finally {
      sql(`update public.businesses set status = 'active' where id = '${id}'`);
    }
    expect(memberState()).toBe(before);
  });
  it("23-25: signup stays closed and malformed administrator requests are rejected safely", async () => {
    const signup = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: "POST",
      headers: { apikey: ANON_KEY, "content-type": "application/json" },
      body: JSON.stringify({ email: `signup-${RUN}@example.invalid`, password: NEW_PASSWORD }),
    });
    expect(signup.status).toBeGreaterThanOrEqual(400);
    expect(authUsers(`signup-${RUN}@example.invalid`)).toBe(0);

    const admin = await login("platform-admin@example.invalid");
    const id = bizId();
    const invitationsBefore = Number(sql(`select count(*) from public.customer_invitations`));
    expect((await admin.post(`/api/admin/businesses/${id}/actions`, { action: "invite_member", email: OWNER_EMAIL, display_name: "X", role: "BUSINESS_OWNER" }, { origin: "https://evil.example.invalid", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await admin.postRaw(`/api/admin/businesses/${id}/actions`, JSON.stringify({ action: "invite_member" }), { "content-type": "application/json" })).status).toBe(415);
    expect((await admin.postRaw(`/api/admin/businesses/${id}/actions`, `action=invite_member&email=a%40b.invalid&email=b%40c.invalid&display_name=X&role=BUSINESS_STAFF`)).location).toMatch(/err=duplicate_field$/);
    expect((await admin.postRaw(`/api/admin/businesses/${id}/actions`, `action=invite_member&email=a%40b.invalid&display_name=X`)).location).toMatch(/err=missing_field$/);
    expect((await admin.postRaw(`/api/admin/businesses/${id}/actions`, `action=invite_member&email=a%40b.invalid&display_name=X&role=BUSINESS_STAFF&redirect_to=https%3A%2F%2Fevil.invalid`)).location).toMatch(/err=unexpected_field$/);
    expect((await admin.post(`/api/admin/businesses/${id}/actions`, { action: "invite_member", email: "a@b.invalid", display_name: "X", role: "PLATFORM_ADMIN" })).location).toMatch(/err=invalid_role$/);
    expect((await admin.post(`/api/admin/businesses/${id}/actions`, { action: "revoke_invitation", invitation_id: "not-a-uuid" })).location).toMatch(/err=invalid_invitation$/);
    expect((await admin.post(`/api/admin/businesses/${id}/actions`, { action: "set_member_role", user_id: "not-a-uuid", role: "BUSINESS_STAFF" })).location).toMatch(/err=invalid_member$/);
    const customer = await login("owner-a@example.invalid");
    expect((await customer.post(`/api/admin/businesses/${id}/actions`, { action: "invite_member", email: "a@b.invalid", display_name: "X", role: "BUSINESS_STAFF" })).status).toBe(404);
    const anon = new Session();
    expect((await anon.post(`/api/admin/businesses/${id}/actions`, { action: "invite_member", email: "a@b.invalid", display_name: "X", role: "BUSINESS_STAFF" })).status).toBe(401);
    expect(Number(sql(`select count(*) from public.customer_invitations`))).toBe(invitationsBefore);
    // /auth/confirm rejects wrong types, malformed and forged tokens without side effects
    for (const q of ["?token_hash=aaaaaaaaaaaaaaaaaaaaaaaa&type=recovery", "?token_hash=short&type=invite", "?type=invite", "?token_hash=aaaaaaaaaaaaaaaaaaaaaaaa&type=invite&next=https://evil.invalid"]) {
      const r = await fetch(`${BASE}/auth/confirm${q}`, { redirect: "manual" });
      expect([303]).toContain(r.status);
      expect(r.headers.get("location"), q).toMatch(/\/login\?error=invite$/);
    }
    // GET /account/setup unauthenticated -> login; POST without session -> 401
    const bare = new Session();
    expect((await bare.get("/account/setup")).location).toMatch(/\/login$/);
    expect((await bare.post("/api/account/setup", { password: NEW_PASSWORD, password_confirm: NEW_PASSWORD })).status).toBe(401);
  });
  it("26-28: administrator surfaces stay read-only for leads; platform operations and ingestion unchanged", async () => {
    const admin = await login("platform-admin@example.invalid");
    const id = bizId();
    const leadId = sql(`select id::text from public.leads where source_event_id = '${RUN}-lead-1'`);
    const leadPage = await admin.get(`/admin/leads/${leadId}`);
    expect(leadPage.status).toBe(200);
    expect(leadPage.text).not.toContain('name="assignee_id"');
    expect((await admin.post(`/api/leads/${leadId}/actions`, { action: "set_status", status: "contacted" })).status).toBe(404);
    expect((await admin.post(`/api/admin/businesses/${id}/actions`, { action: "set_business_status", status: "active" })).location).toMatch(/ok=business_status_updated$/);
    const rejected = await fetch(`${BASE}/api/internal/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(rejected.status).toBe(401);
  });
});

describe("secret and data isolation", () => {
  it("29-30: no invited email, password, token, link, JWT or key in server logs or browser bundles", async () => {
    const log = serverLog.join("");
    for (const forbidden of [...ALL_EMAILS, NEW_PASSWORD, "token_hash=", "/auth/v1/verify", "Juliet Owner", "Juliet Manager", SERVICE_KEY, INGEST_TOKEN, PASSWORD]) {
      expect(log, forbidden.slice(0, 16)).not.toContain(forbidden);
    }
    expect(log).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\./);
    expect(log).toContain('"event":"invite_member"');
    expect(log).toContain('"event":"invite_confirm"');
    expect(log).toContain('"event":"account_setup"');
    const files: string[] = [];
    const walk = (dir: string) => { for (const f of readdirSync(dir)) { const p = path.join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(js|css|json|html|txt)$/.test(f)) files.push(p); } };
    walk(path.join(ROOT, ".next", "static"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const forbidden of [SERVICE_KEY, INGEST_TOKEN, "SUPABASE_SERVICE_ROLE_KEY", "supabase-admin", "supabase-auth-admin", "inviteUserByEmail", NEW_PASSWORD]) {
        expect(text, path.basename(f)).not.toContain(forbidden);
      }
    }
  });
});
