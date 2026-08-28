// Real password recovery: local Supabase Auth + the local mail catcher
// (Mailpit web API on 54324) + the production Next.js server. Synthetic
// .invalid addresses only. No service-role client is used for any
// authorization assertion (privileged SQL is fixture setup, inspection and
// cleanup only; recovery links are extracted from the catcher HARNESS-side).
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
const SEED_PASSWORD = "local-seed-only";
const RUN = `rec-it-${Date.now().toString(36)}`;

// Synthetic fixture tenant + users owned exclusively by this suite (SQL
// fixtures modeled on supabase/seed.sql; removed completely in afterAll).
const BIZ = "d0000000-0000-4000-8000-0000000000d1";
const BIZ_NAME = "Delta Roofing (synthetic IT)";
const BIZ_SLUG = "delta-roofing-it";
const U_OWNER = "d1000000-0000-4000-8000-000000000001";
const U_INACTIVE = "d1000000-0000-4000-8000-000000000002";
const U_ADMIN = "d1000000-0000-4000-8000-000000000003";
const OWNER_EMAIL = `reset-owner-${RUN}@delta.example.invalid`;
const INACTIVE_EMAIL = `reset-inactive-${RUN}@delta.example.invalid`;
const ADMIN2_EMAIL = `reset-admin-${RUN}@delta.example.invalid`;
const INVITEE_EMAIL = `reset-invitee-${RUN}@delta.example.invalid`;
const GHOST_EMAIL = `reset-ghost-${RUN}@delta.example.invalid`;
const ALL_FIXTURE_EMAILS = [OWNER_EMAIL, INACTIVE_EMAIL, ADMIN2_EMAIL, INVITEE_EMAIL];
const NEW_PW_OWNER = `Reset-By-Owner-${RUN}-42`;
const NEW_PW_INACTIVE = `Reset-By-Inactive-${RUN}-42`;
const NEW_PW_ADMIN = `Reset-By-Admin-${RUN}-42`;
const SEED_LEAD_A1 = "aa000000-0000-4000-8000-000000000001";
const A_MARKERS = ["Alpha HVAC (synthetic)", "Test Contact One"];
const B_MARKERS = ["Bravo Plumbing (synthetic)", "Test Contact Four"];

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
const authUsers = (email: string) => Number(sql(`select count(*) from auth.users where lower(email) = '${email}'`));
const membership = (email: string) => sql(`select coalesce((select m.role || '|' || m.status from public.business_memberships m join auth.users u on u.id = m.user_id where lower(u.email) = '${email}'), '')`);
const invitation = (email: string) => sql(`select coalesce((select status from public.customer_invitations where email = '${email}' order by created_at desc limit 1), '')`);
/** One combined provisioning snapshot: any change proves a forbidden side effect. */
const stateSnapshot = () =>
  sql(`select (select count(*) from public.profiles) || '|' || (select count(*) from public.business_memberships) || '|' ||
              (select count(*) from public.customer_invitations) || '|' || (select coalesce(string_agg(status, ',' order by created_at), '-') from public.customer_invitations) || '|' ||
              (select count(*) from public.customer_access_events) || '|' || (select count(*) from public.platform_admin_events)`);

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
  get size() { return this.jar.size; }
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
async function login(email: string, password: string) {
  const s = new Session();
  const r = await s.post("/api/auth/login", { email, password });
  if (r.status !== 303 || !r.location?.endsWith("/")) throw new Error(`login failed for ${email.slice(0, 8)}…`);
  return s;
}
/** Oversized CHUNKED body (no Content-Length): streamed bytes must be counted. */
async function postChunked(p: string, totalBytes: number): Promise<number> {
  const chunk = new Uint8Array(1024).fill(97);
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) { controller.close(); return; }
      controller.enqueue(chunk);
      sent += chunk.length;
    },
  });
  const res = await fetch(BASE + p, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
    body: stream,
    redirect: "manual",
    ...( { duplex: "half" } as object ),
  });
  await res.text();
  return res.status;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- local mail catcher (Mailpit web API) ----------------------------------
interface MailSummary { ID: string; To: Array<{ Address: string }>; Subject: string }
async function mailFor(address: string): Promise<MailSummary[]> {
  const res = await fetch(`${MAIL}/api/v1/messages?limit=100`);
  const body = (await res.json()) as { messages: MailSummary[] };
  return (body.messages ?? []).filter((m) => m.To.some((t) => t.Address.toLowerCase() === address.toLowerCase()));
}
async function mailBody(id: string): Promise<string> {
  const detail = await fetch(`${MAIL}/api/v1/message/${id}`);
  const body = (await detail.json()) as { HTML?: string; Text?: string };
  return `${body.HTML ?? ""}\n${body.Text ?? ""}`.replace(/&amp;/g, "&");
}
const RECOVERY_LINK_RE = /http:\/\/127\.0\.0\.1:3000\/auth\/confirm\?token_hash=[A-Za-z0-9_-]+&type=recovery/;
/** Extracts the newest recovery link for an address — HARNESS ONLY, never shown in app surfaces. */
async function recoveryLink(address: string, minCount = 1): Promise<{ link: string; body: string; subject: string }> {
  for (let i = 0; i < 25; i++) {
    const msgs = await mailFor(address);
    if (msgs.length >= minCount) {
      const body = await mailBody(msgs[0]!.ID);
      const m = RECOVERY_LINK_RE.exec(body);
      if (m) return { link: m[0], body, subject: msgs[0]!.Subject };
      throw new Error("recovery email did not contain the expected confirm link shape");
    }
    await sleep(300);
  }
  throw new Error("recovery email never arrived");
}
async function requestReset(email: string) {
  const s = new Session();
  return { res: await s.post("/api/auth/password-reset/request", { email }), s };
}
/** Follows a recovery link and returns the session holding the recovery cookies. */
async function followRecovery(link: string): Promise<Session> {
  const s = new Session();
  const res = await fetch(link, { redirect: "manual" });
  s.absorb(res);
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toMatch(/\/account\/reset-password$/);
  expect(res.headers.get("cache-control")).toContain("no-store");
  return s;
}

let server: ChildProcess | null = null;
const serverLog: string[] = [];

beforeAll(async () => {
  await fetch(`${MAIL}/api/v1/messages`, { method: "DELETE" }).catch(() => undefined);
  // Fixture tenant + users (modeled on supabase/seed.sql; postgres-only setup).
  sql(`insert into public.businesses (id, name, slug, industry, timezone, status) values
         ('${BIZ}', '${BIZ_NAME}', '${BIZ_SLUG}', 'roofing', 'America/New_York', 'active');
       insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
         raw_app_meta_data, raw_user_meta_data, is_sso_user,
         confirmation_token, recovery_token, email_change, email_change_token_new, created_at, updated_at)
       values
         ('00000000-0000-0000-0000-000000000000', '${U_OWNER}', 'authenticated', 'authenticated', '${OWNER_EMAIL}',
          extensions.crypt('${SEED_PASSWORD}', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', false, '', '', '', '', now(), now()),
         ('00000000-0000-0000-0000-000000000000', '${U_INACTIVE}', 'authenticated', 'authenticated', '${INACTIVE_EMAIL}',
          extensions.crypt('${SEED_PASSWORD}', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', false, '', '', '', '', now(), now()),
         ('00000000-0000-0000-0000-000000000000', '${U_ADMIN}', 'authenticated', 'authenticated', '${ADMIN2_EMAIL}',
          extensions.crypt('${SEED_PASSWORD}', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', false, '', '', '', '', now(), now());
       insert into public.profiles (id, display_name, platform_role, is_active) values
         ('${U_OWNER}', 'Delta Owner (synthetic)', null, true),
         ('${U_INACTIVE}', 'Delta Inactive (synthetic)', null, true),
         ('${U_ADMIN}', 'Delta Platform Admin (synthetic)', 'PLATFORM_ADMIN', true);
       insert into public.business_memberships (business_id, user_id, role, status) values
         ('${BIZ}', '${U_OWNER}', 'BUSINESS_OWNER', 'active'),
         ('${BIZ}', '${U_INACTIVE}', 'BUSINESS_STAFF', 'inactive');`);

  const require = createRequire(import.meta.url);
  server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", "3000"], { cwd: ROOT, env: { ...process.env, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout!.on("data", (d) => serverLog.push(String(d)));
  server.stderr!.on("data", (d) => serverLog.push(String(d)));
  const deadline = Date.now() + 60_000;
  for (;;) {
    try { if ((await fetch(`${BASE}/login`)).ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${serverLog.join("")}`);
    await sleep(500);
  }
});

afterAll(async () => {
  if (server?.pid) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"]); else server.kill("SIGTERM");
  }
  // Remove everything this run created (FK order); privileged SQL is cleanup only.
  sql(`update public.businesses set status = 'active' where id = '${BIZ}';
       delete from public.customer_access_events where business_id = '${BIZ}';
       delete from public.customer_invitations where business_id = '${BIZ}';
       delete from public.platform_admin_events where business_id = '${BIZ}';`);
  for (const e of ALL_FIXTURE_EMAILS) sql(`delete from auth.users where lower(email) = '${e}'`); // cascades profiles -> memberships
  sql(`delete from public.businesses where id = '${BIZ}'`);
  await fetch(`${MAIL}/api/v1/messages`, { method: "DELETE" }).catch(() => undefined);
});

// Sessions shared across sequential tests within this file.
let ownerSession: Session | null = null;

describe("forgot-password page and request endpoint", () => {
  it("1: renders publicly, without any signup control, and is non-cacheable", async () => {
    const r = await new Session().get("/forgot-password");
    expect(r.status).toBe(200);
    expect(r.text).toContain("SnowBeltTech");
    expect(r.text).toContain('action="/api/auth/password-reset/request"');
    expect(r.text).toContain('name="email"');
    expect(r.text).toContain("If an eligible account exists");
    expect(r.text).not.toMatch(/sign ?up|register|create an account/i);
    expect(r.headers.get("cache-control")).toContain("no-store");
    // the login page links here
    const loginPage = await new Session().get("/login");
    expect(loginPage.text).toContain('href="/forgot-password"');
    expect(loginPage.text).toContain("Forgot your password?");
  });
  it("2-3: existing and unknown accounts get indistinguishable responses; only the existing one gets mail", async () => {
    const existing = await requestReset(OWNER_EMAIL);
    const unknown = await requestReset(GHOST_EMAIL);
    for (const r of [existing, unknown]) {
      expect(r.res.status).toBe(303);
      expect(r.res.location).toMatch(/\/forgot-password\?ok=sent$/);
      expect(r.res.headers.getSetCookie()).toEqual([]);
      expect(r.s.size).toBe(0);
    }
    expect(existing.res.location).toBe(unknown.res.location);
    const page = await new Session().get("/forgot-password?ok=sent");
    expect(page.text).toContain("If an eligible account exists for that email, password-reset instructions have been sent.");
    await recoveryLink(OWNER_EMAIL); // the real email arrived through the catcher
    await sleep(1500);
    expect((await mailFor(GHOST_EMAIL)).length).toBe(0);
  });
  it("a signed-in user is routed away from the public form", async () => {
    ownerSession = await login(OWNER_EMAIL, SEED_PASSWORD); // pre-existing session, reused for later revocation proof
    const r = await ownerSession.get("/forgot-password");
    expect([302, 303, 307, 308]).toContain(r.status); // Next redirect() emits 307
    expect(r.location).toMatch(/\/$/);
  });
  it("20-23: cross-site, JSON, oversized (declared and chunked) and malformed fields are rejected", async () => {
    const s = new Session();
    expect((await s.post("/api/auth/password-reset/request", { email: OWNER_EMAIL }, { origin: "https://evil.example.invalid", "sec-fetch-site": "cross-site" })).status).toBe(403);
    const json = await fetch(`${BASE}/api/auth/password-reset/request`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: OWNER_EMAIL }), redirect: "manual" });
    expect(json.status).toBe(415);
    const big = await fetch(`${BASE}/api/auth/password-reset/request`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE }, body: `email=${"a".repeat(5000)}`, redirect: "manual" });
    expect(big.status).toBe(413);
    expect(await postChunked("/api/auth/password-reset/request", 8 * 1024)).toBe(413);
    const cases: Array<[string, string]> = [
      ["", "missing_field"],
      ["email=a%40b.invalid&email=b%40c.invalid", "duplicate_field"],
      ["email=a%40b.invalid&next=https%3A%2F%2Fevil.invalid", "unexpected_field"],
      ["email=a%40b.invalid&redirect_to=https%3A%2F%2Fevil.invalid", "unexpected_field"],
      ["email=a%40b.invalid&callback=https%3A%2F%2Fevil.invalid", "unexpected_field"],
      ["email=a%40b.invalid&business_id=a0000000-0000-4000-8000-000000000001", "unexpected_field"],
      ["email=a%40b.invalid&user_id=a1000000-0000-4000-8000-000000000001", "unexpected_field"],
      ["email=not-an-email", "invalid_email"],
      [`email=${"x".repeat(400)}%40example.invalid`, "invalid_email"],
    ];
    for (const [body, err] of cases) {
      const r = await s.postRaw("/api/auth/password-reset/request", body);
      expect(r.status, body.slice(0, 30)).toBe(303);
      expect(r.location, body.slice(0, 30)).toMatch(new RegExp(`/forgot-password\\?err=${err}$`));
      expect(r.location).not.toContain("%40"); // no submitted email in any redirect
      expect(r.location).not.toContain("@");
    }
  });
});

describe("full recovery flow", () => {
  it("4-13: email -> link -> reset page -> new password; sessions revoked, replay fails, nothing provisioned", async () => {
    const before = stateSnapshot();
    await sleep(1100); // GoTrue max_frequency between recovery emails for one user
    const { res } = await requestReset(OWNER_EMAIL);
    expect(res.location).toMatch(/ok=sent$/);
    const { link, body, subject } = await recoveryLink(OWNER_EMAIL, 2);
    // 5: canonical link shape only; no tenant, role or invitation data in the mail
    expect(subject).toBe("Reset your SnowBeltTech Lead Portal password");
    for (const url of body.match(/https?:\/\/[^\s"'<>]+/g) ?? []) expect(url).toMatch(RECOVERY_LINK_RE);
    for (const forbidden of [BIZ_NAME, BIZ_SLUG, "BUSINESS_OWNER", "portal_invitation_id", SERVICE_KEY, ANON_KEY]) expect(body).not.toContain(forbidden);
    expect(body).toContain("you can ignore this email");

    // 6: the link creates an ordinary recovery session and reaches the reset page
    const recovery = await followRecovery(link);
    expect(recovery.size).toBeGreaterThan(0);
    const page = await recovery.get("/account/reset-password");
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toContain("no-store");
    expect((page.text.match(/autocomplete="new-password"/gi) ?? []).length).toBe(2); // React 19 SSR emits camelCase attributes
    for (const marker of [BIZ_NAME, ...A_MARKERS, ...B_MARKERS, "Invitations", "Team members"]) expect(page.text).not.toContain(marker);

    // malformed update posts are rejected with allow-listed codes
    expect((await recovery.post("/api/account/reset-password", { password: NEW_PW_OWNER, password_confirm: "different-password-42" })).location).toMatch(/err=password_mismatch$/);
    expect((await recovery.post("/api/account/reset-password", { password: "short", password_confirm: "short" })).location).toMatch(/err=password_too_short$/);
    const long = "p".repeat(129);
    expect((await recovery.post("/api/account/reset-password", { password: long, password_confirm: long })).location).toMatch(/err=password_too_long$/);
    expect((await recovery.postRaw("/api/account/reset-password", `password=${NEW_PW_OWNER}&password=${NEW_PW_OWNER}&password_confirm=${NEW_PW_OWNER}`)).location).toMatch(/err=duplicate_field$/);
    expect((await recovery.postRaw("/api/account/reset-password", `password=${NEW_PW_OWNER}&password_confirm=${NEW_PW_OWNER}&next=%2Fadmin`)).location).toMatch(/err=unexpected_field$/);
    expect((await recovery.postRaw("/api/account/reset-password", "")).location).toMatch(/err=missing_field$/);
    const jsonBody = await fetch(`${BASE}/api/account/reset-password`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie: recovery.header() }, body: "{}", redirect: "manual" });
    expect(jsonBody.status).toBe(415);
    expect(await postChunked("/api/account/reset-password", 8 * 1024)).toBe(401); // unauthenticated chunked flood stops at auth

    // 7-8: the reset succeeds, the recovery session is signed out, cookies are gone
    const done = await recovery.post("/api/account/reset-password", { password: NEW_PW_OWNER, password_confirm: NEW_PW_OWNER });
    expect(done.status).toBe(303);
    expect(done.location).toMatch(/\/login\?notice=password_reset$/);
    expect(recovery.size).toBe(0);
    const notice = await new Session().get("/login?notice=password_reset");
    expect(notice.text).toContain("Your password has been updated. Sign in with your new password.");
    expect((await recovery.get("/account/reset-password")).location).toMatch(/\/login\?error=recovery$/);

    // 9-10: old password dead, new password gets exactly the user's own tenant
    const old = await new Session().post("/api/auth/login", { email: OWNER_EMAIL, password: SEED_PASSWORD });
    expect(old.location).toMatch(/\/login\?error=1$/);
    const fresh = await login(OWNER_EMAIL, NEW_PW_OWNER);
    const dash = await fresh.get("/dashboard");
    expect(dash.status).toBe(200);
    expect(dash.text).toContain(BIZ_NAME);
    for (const marker of [...A_MARKERS, ...B_MARKERS]) expect(dash.text).not.toContain(marker);
    expect((await fresh.get("/admin")).status).not.toBe(200);
    ownerSession = fresh;

    // 12-13: replayed and forged links fail generically, with no session and no state change
    // (11 — pre-existing-session invalidation — is proven in the dedicated test below)
    const replay = await fetch(link, { redirect: "manual" });
    expect(replay.status).toBe(303);
    expect(replay.headers.get("location")).toMatch(/\/login\?error=recovery$/);
    expect(replay.headers.getSetCookie().filter((c) => !/max-age=0/i.test(c) && !/=;/.test(c))).toEqual([]);
    const forged = await fetch(`${BASE}/auth/confirm?token_hash=${"a".repeat(24)}&type=recovery`, { redirect: "manual" });
    expect(forged.headers.get("location")).toMatch(/\/login\?error=recovery$/);
    const smuggled = await fetch(`${BASE}/auth/confirm?token_hash=${"a".repeat(24)}&type=recovery&next=https://evil.invalid`, { redirect: "manual" });
    expect(smuggled.headers.get("location")).toMatch(/\/login\?error=recovery$/);

    // 16: recovery provisioned NOTHING: profiles, memberships, invitations, ledgers all unchanged
    expect(stateSnapshot()).toBe(before);
  });
  it("11: a second pre-existing session is invalidated on its next validated request", async () => {
    // ownerSession currently works under the new password; reset again through a fresh recovery
    // and prove the surviving session dies.
    const survivor = ownerSession!;
    expect((await survivor.get("/dashboard")).status).toBe(200);
    await sleep(1100);
    await requestReset(OWNER_EMAIL);
    const { link } = await recoveryLink(OWNER_EMAIL, 3);
    const recovery = await followRecovery(link);
    const done = await recovery.post("/api/account/reset-password", { password: `${NEW_PW_OWNER}-2`, password_confirm: `${NEW_PW_OWNER}-2` });
    expect(done.location).toMatch(/notice=password_reset$/);
    const after = await survivor.get("/dashboard");
    expect([302, 303, 307, 308]).toContain(after.status);
    expect(after.location).toMatch(/\/login$/);
    ownerSession = await login(OWNER_EMAIL, `${NEW_PW_OWNER}-2`);
  });
});

describe("token type separation", () => {
  it("14-15: an invite token cannot enter recovery and a recovery token cannot enter invitation acceptance", async () => {
    const admin = await login("platform-admin@example.invalid", SEED_PASSWORD);
    const invited = await admin.post(`/api/admin/businesses/${BIZ}/actions`, { action: "invite_member", email: INVITEE_EMAIL, display_name: "Delta Invitee", role: "BUSINESS_STAFF" });
    expect(invited.location).toMatch(/ok=invited$/);
    const inviteMsgs = await (async () => {
      for (let i = 0; i < 25; i++) {
        const msgs = await mailFor(INVITEE_EMAIL);
        if (msgs.length > 0) return msgs;
        await sleep(300);
      }
      throw new Error("invitation email never arrived");
    })();
    const inviteBody = await mailBody(inviteMsgs[0]!.ID);
    const inviteToken = /token_hash=([A-Za-z0-9_-]+)&type=invite/.exec(inviteBody)?.[1];
    expect(inviteToken).toBeTruthy();

    // invite token presented as recovery: generic recovery failure, invitation untouched
    const cross1 = await fetch(`${BASE}/auth/confirm?token_hash=${inviteToken}&type=recovery`, { redirect: "manual" });
    expect(cross1.headers.get("location")).toMatch(/\/login\?error=recovery$/);
    expect(invitation(INVITEE_EMAIL)).toBe("sent");
    expect(membership(INVITEE_EMAIL)).toBe("");
    expect(sql(`select count(*) from public.profiles where id in (select auth_user_id from public.customer_invitations where email = '${INVITEE_EMAIL}')`)).toBe("0");

    // recovery token presented as invite: generic invite failure, nothing accepted, no session
    await sleep(1100);
    await requestReset(OWNER_EMAIL);
    const { link } = await recoveryLink(OWNER_EMAIL, 4);
    const recToken = /token_hash=([A-Za-z0-9_-]+)&type=recovery/.exec(link)?.[1];
    const cross2 = await fetch(`${BASE}/auth/confirm?token_hash=${recToken}&type=invite`, { redirect: "manual" });
    expect(cross2.headers.get("location")).toMatch(/\/login\?error=invite$/);
    expect(cross2.headers.getSetCookie().filter((c) => !/max-age=0/i.test(c) && !/=;/.test(c))).toEqual([]);
    expect(invitation(INVITEE_EMAIL)).toBe("sent");
    expect(membership(OWNER_EMAIL)).toBe("BUSINESS_OWNER|active"); // unchanged

    // the untouched invite link still works exactly as before (invitation flow intact)
    const inviteFollow = await fetch(`${BASE}/auth/confirm?token_hash=${inviteToken}&type=invite`, { redirect: "manual" });
    expect(inviteFollow.status).toBe(303);
    expect(inviteFollow.headers.get("location")).toMatch(/\/account\/setup$/);
    expect(invitation(INVITEE_EMAIL)).toBe("accepted");
    expect(membership(INVITEE_EMAIL)).toBe("BUSINESS_STAFF|active");
    // and the properly-consumed recovery link still completes (token separation broke nothing)
    const recovery = await followRecovery(link);
    const done = await recovery.post("/api/account/reset-password", { password: NEW_PW_OWNER, password_confirm: NEW_PW_OWNER });
    expect(done.location).toMatch(/notice=password_reset$/);
    ownerSession = await login(OWNER_EMAIL, NEW_PW_OWNER);
  });
});

describe("recovery restores passwords, never access", () => {
  it("17: an inactive member can reset their password without regaining any access", async () => {
    const { res } = await requestReset(INACTIVE_EMAIL);
    expect(res.location).toMatch(/ok=sent$/);
    const { link } = await recoveryLink(INACTIVE_EMAIL);
    const recovery = await followRecovery(link);
    expect((await recovery.get("/account/reset-password")).status).toBe(200);
    const done = await recovery.post("/api/account/reset-password", { password: NEW_PW_INACTIVE, password_confirm: NEW_PW_INACTIVE });
    expect(done.location).toMatch(/notice=password_reset$/);
    const s = await login(INACTIVE_EMAIL, NEW_PW_INACTIVE);
    expect((await s.get("/")).location).toMatch(/\/no-access$/);
    expect((await s.get("/dashboard")).location).toMatch(/\/no-access$/);
    expect(membership(INACTIVE_EMAIL)).toBe("BUSINESS_STAFF|inactive"); // reset reactivated nothing
    const sb = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    expect((await sb.auth.signInWithPassword({ email: INACTIVE_EMAIL, password: NEW_PW_INACTIVE })).error).toBeNull();
    try {
      expect((await sb.from("leads").select("id")).data).toEqual([]);
      expect((await sb.from("businesses").select("id")).data).toEqual([]);
    } finally {
      await sb.auth.signOut({ scope: "local" });
    }
  });
  it("18: a platform administrator reset grants no customer mutation rights", async () => {
    const statusBefore = sql(`select status from public.leads where id = '${SEED_LEAD_A1}'`);
    const { res } = await requestReset(ADMIN2_EMAIL);
    expect(res.location).toMatch(/ok=sent$/);
    const { link } = await recoveryLink(ADMIN2_EMAIL);
    const recovery = await followRecovery(link);
    const done = await recovery.post("/api/account/reset-password", { password: NEW_PW_ADMIN, password_confirm: NEW_PW_ADMIN });
    expect(done.location).toMatch(/notice=password_reset$/);
    const s = await login(ADMIN2_EMAIL, NEW_PW_ADMIN);
    expect((await s.get("/admin")).status).toBe(200);
    expect((await s.post(`/api/leads/${SEED_LEAD_A1}/actions`, { action: "set_status", status: "won" })).status).toBe(404);
    expect(sql(`select status from public.leads where id = '${SEED_LEAD_A1}'`)).toBe(statusBefore);
    await s.post("/api/auth/logout", {});
  });
  it("19: suspended and archived businesses stay denied after a password reset", async () => {
    const s = ownerSession!;
    expect((await s.get("/dashboard")).status).toBe(200);
    try {
      for (const status of ["suspended", "archived"]) {
        sql(`update public.businesses set status = '${status}' where id = '${BIZ}'`); // fixture only
        const denied = await s.get("/dashboard");
        expect(denied.location, status).toMatch(/\/no-access$/);
        expect(denied.text, status).not.toContain(BIZ_NAME);
      }
    } finally {
      sql(`update public.businesses set status = 'active' where id = '${BIZ}'`);
    }
    expect((await s.get("/dashboard")).status).toBe(200);
  });
});

describe("posture, logs and bundles", () => {
  it("29: public signup remains rejected", async () => {
    const signup = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: "POST",
      headers: { apikey: ANON_KEY, "content-type": "application/json" },
      body: JSON.stringify({ email: `signup-${RUN}@example.invalid`, password: NEW_PW_OWNER }),
    });
    expect(signup.status).toBeGreaterThanOrEqual(400);
    expect(authUsers(`signup-${RUN}@example.invalid`)).toBe(0);
  });
  it("25-26: no email, password, token, link, JWT, cookie or key in server logs or browser assets", async () => {
    const log = serverLog.join("");
    for (const forbidden of [
      ...ALL_FIXTURE_EMAILS, GHOST_EMAIL, NEW_PW_OWNER, `${NEW_PW_OWNER}-2`, NEW_PW_INACTIVE, NEW_PW_ADMIN, SEED_PASSWORD,
      "token_hash=", "/auth/confirm?", "/auth/v1/verify", "/auth/v1/recover", SERVICE_KEY, INGEST_TOKEN, ANON_KEY, "sb-127-auth-token",
    ]) {
      expect(log, forbidden.slice(0, 24)).not.toContain(forbidden);
    }
    expect(log).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\./);
    expect(log).toContain('"event":"password_reset_request"');
    expect(log).toContain('"event":"recovery_confirm"');
    expect(log).toContain('"event":"password_reset","');
    const files: string[] = [];
    const walk = (dir: string) => { for (const f of readdirSync(dir)) { const p = path.join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(js|css|json|html|txt)$/.test(f)) files.push(p); } };
    walk(path.join(ROOT, ".next", "static"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const forbidden of [SERVICE_KEY, INGEST_TOKEN, "SUPABASE_SERVICE_ROLE_KEY", "supabase-admin", "supabase-auth-admin", "resetPasswordForEmail", "inviteUserByEmail", NEW_PW_OWNER]) {
        expect(text, path.basename(f)).not.toContain(forbidden);
      }
    }
  });
});
