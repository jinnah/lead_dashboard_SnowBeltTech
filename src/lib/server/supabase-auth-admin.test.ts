import { beforeEach, describe, expect, it, vi } from "vitest";

// The deleter's own guard: it re-reads the target account's email through the
// Auth Admin API and refuses to delete on ANY mismatch or lookup failure —
// a wrong id can never remove an unrelated account.
const getUserById = vi.fn();
const deleteUser = vi.fn();
const inviteUserByEmail = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { admin: { getUserById, deleteUser, inviteUserByEmail } } }),
}));

const USER = "d0000000-0000-4000-8000-0000000000d1";
const INV = "c0000000-0000-4000-8000-0000000000c1";

async function loadModule() {
  vi.resetModules();
  process.env.SUPABASE_URL = "http://127.0.0.1:54321";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "unit-test-placeholder-service-key";
  process.env.N8N_INGEST_TOKEN = "unit-test-placeholder-ingest-token-0000";
  return import("./supabase-auth-admin");
}

beforeEach(() => {
  getUserById.mockReset();
  deleteUser.mockReset();
  inviteUserByEmail.mockReset();
});

describe("inviteAuthUser provenance marker", () => {
  it("persists the invitation UUID under the narrow metadata key on the invited account", async () => {
    const mod = await loadModule();
    inviteUserByEmail.mockResolvedValue({ data: { user: { id: USER } }, error: null });
    const r = await mod.inviteAuthUser("invitee@example.invalid", "http://127.0.0.1:3000", INV);
    expect(r).toEqual({ ok: true, userId: USER });
    expect(inviteUserByEmail).toHaveBeenCalledExactlyOnceWith("invitee@example.invalid", {
      redirectTo: "http://127.0.0.1:3000",
      data: { [mod.INVITATION_MARKER_KEY]: INV },
    });
    expect(mod.INVITATION_MARKER_KEY).toBe("portal_invitation_id");
  });
});

describe("deleteUnacceptedAuthUser guard", () => {
  it("deletes only when the account's normalized email matches exactly", async () => {
    const mod = await loadModule();
    getUserById.mockResolvedValue({ data: { user: { id: USER, email: "Invitee@Example.INVALID" } }, error: null });
    deleteUser.mockResolvedValue({ data: { user: null }, error: null });
    expect(await mod.deleteUnacceptedAuthUser(USER, "invitee@example.invalid")).toBe(true);
    expect(deleteUser).toHaveBeenCalledExactlyOnceWith(USER);
  });
  it("refuses on email mismatch", async () => {
    const mod = await loadModule();
    getUserById.mockResolvedValue({ data: { user: { id: USER, email: "someone-else@example.invalid" } }, error: null });
    expect(await mod.deleteUnacceptedAuthUser(USER, "invitee@example.invalid")).toBe(false);
    expect(deleteUser).not.toHaveBeenCalled();
  });
  it("refuses when the account cannot be looked up or has no email", async () => {
    const mod = await loadModule();
    getUserById.mockResolvedValue({ data: { user: null }, error: { message: "not found" } });
    expect(await mod.deleteUnacceptedAuthUser(USER, "invitee@example.invalid")).toBe(false);
    getUserById.mockResolvedValue({ data: { user: { id: USER, email: undefined } }, error: null });
    expect(await mod.deleteUnacceptedAuthUser(USER, "invitee@example.invalid")).toBe(false);
    expect(deleteUser).not.toHaveBeenCalled();
  });
  it("reports failure when the Auth deletion itself errors", async () => {
    const mod = await loadModule();
    getUserById.mockResolvedValue({ data: { user: { id: USER, email: "invitee@example.invalid" } }, error: null });
    deleteUser.mockResolvedValue({ data: { user: null }, error: { message: "boom" } });
    expect(await mod.deleteUnacceptedAuthUser(USER, "invitee@example.invalid")).toBe(false);
  });
});
