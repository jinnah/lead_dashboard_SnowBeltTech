import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { inviteCustomerMember, revokeCustomerInvitation } from "./invitations";
import type { Viewer } from "./viewer";

// Coordinator fault-injection: the Auth Admin boundary is mocked so every
// failure window is exercised without production hooks. Assertions cover the
// compensation ORDER (database first, Auth cleanup second), exact-user cleanup,
// and that log lines never carry emails, names, tokens or raw Auth errors.
vi.mock("./supabase-auth-admin", () => ({
  inviteAuthUser: vi.fn(),
  deleteUnacceptedAuthUser: vi.fn(),
  getAuthUserEmail: vi.fn(),
}));
import { deleteUnacceptedAuthUser, inviteAuthUser } from "./supabase-auth-admin";

const BIZ = "b0000000-0000-4000-8000-0000000000b1";
const INV = "c0000000-0000-4000-8000-0000000000c1";
const AUTH_USER = "d0000000-0000-4000-8000-0000000000d1";
const EMAIL = "unit-invitee@example.invalid";
const NAME = "Unit Invitee";

type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };

function fakeViewer(rpcPlan: Record<string, RpcResult | RpcResult[]>) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc = vi.fn((fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    const planned = rpcPlan[fn];
    const result: RpcResult = Array.isArray(planned) ? (planned.shift() ?? { data: null, error: { code: "XX000", message: "exhausted" } }) : (planned ?? { data: null, error: { code: "XX000", message: "unplanned" } });
    return { single: async () => result };
  });
  const from = vi.fn(() => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { email: EMAIL }, error: null }) }) }),
  }));
  const viewer = { access: { kind: "admin", businesses: [], roles: {} }, supabase: { rpc, from } } as unknown as Viewer;
  return { viewer, rpc, calls };
}

let logged: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  logged = [];
  vi.spyOn(console, "info").mockImplementation((line: unknown) => { logged.push(String(line)); });
});
afterEach(() => {
  vi.restoreAllMocks();
});

function expectNoLeakage() {
  const all = logged.join("\n");
  for (const forbidden of [EMAIL, NAME, AUTH_USER, "token", "boom", "smtp", "@example.invalid"]) {
    expect(all.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
  }
}

describe("delivery-failure compensation", () => {
  it("marks the invitation failed and deletes a positively matched cleanup candidate", async () => {
    (inviteAuthUser as Mock).mockResolvedValue({ ok: false, category: "failed" });
    (deleteUnacceptedAuthUser as Mock).mockResolvedValue(true);
    const { viewer, calls } = fakeViewer({
      admin_prepare_customer_invitation: { data: { invitation_id: INV }, error: null },
      admin_mark_customer_invitation_failed: { data: { invitation_id: INV, status: "failed", cleanup_auth_user_id: AUTH_USER }, error: null },
    });
    const outcome = await inviteCustomerMember(viewer, "req-1", BIZ, EMAIL, NAME, "BUSINESS_STAFF");
    expect(outcome).toBe("invite_delivery_failed");
    expect(calls.map((c) => c.fn)).toEqual(["admin_prepare_customer_invitation", "admin_mark_customer_invitation_failed"]);
    // failure marking happens BEFORE cleanup, and cleanup targets the exact returned candidate + email
    expect(deleteUnacceptedAuthUser).toHaveBeenCalledExactlyOnceWith(AUTH_USER, EMAIL);
    expectNoLeakage();
  });
  it("deletes nothing when the database returns no candidate (no Auth user was created)", async () => {
    (inviteAuthUser as Mock).mockResolvedValue({ ok: false, category: "failed" });
    const { viewer } = fakeViewer({
      admin_prepare_customer_invitation: { data: { invitation_id: INV }, error: null },
      admin_mark_customer_invitation_failed: { data: { invitation_id: INV, status: "failed", cleanup_auth_user_id: null }, error: null },
    });
    expect(await inviteCustomerMember(viewer, "req-2", BIZ, EMAIL, NAME, "BUSINESS_STAFF")).toBe("invite_delivery_failed");
    expect(deleteUnacceptedAuthUser).not.toHaveBeenCalled();
    expectNoLeakage();
  });
  it("deletes nothing when failure marking itself errors (no candidate is ever guessed)", async () => {
    (inviteAuthUser as Mock).mockResolvedValue({ ok: false, category: "failed" });
    const { viewer } = fakeViewer({
      admin_prepare_customer_invitation: { data: { invitation_id: INV }, error: null },
      admin_mark_customer_invitation_failed: { data: null, error: { code: "XX000", message: "boom" } },
    });
    expect(await inviteCustomerMember(viewer, "req-3", BIZ, EMAIL, NAME, "BUSINESS_STAFF")).toBe("invite_delivery_failed");
    expect(deleteUnacceptedAuthUser).not.toHaveBeenCalled();
    expectNoLeakage();
  });
  it("survives cleanup failure without changing the outcome (invitation stays safely failed)", async () => {
    (inviteAuthUser as Mock).mockResolvedValue({ ok: false, category: "failed" });
    (deleteUnacceptedAuthUser as Mock).mockResolvedValue(false); // e.g. email mismatch or Auth error — deleter refused
    const { viewer } = fakeViewer({
      admin_prepare_customer_invitation: { data: { invitation_id: INV }, error: null },
      admin_mark_customer_invitation_failed: { data: { invitation_id: INV, status: "failed", cleanup_auth_user_id: AUTH_USER }, error: null },
    });
    expect(await inviteCustomerMember(viewer, "req-4", BIZ, EMAIL, NAME, "BUSINESS_STAFF")).toBe("invite_delivery_failed");
    expect(deleteUnacceptedAuthUser).toHaveBeenCalledExactlyOnceWith(AUTH_USER, EMAIL);
    expectNoLeakage();
  });
});

describe("finalization-failure compensation", () => {
  it("mark-sent failure revokes the invitation FIRST, then cleans the exact invited user", async () => {
    (inviteAuthUser as Mock).mockResolvedValue({ ok: true, userId: AUTH_USER });
    (deleteUnacceptedAuthUser as Mock).mockResolvedValue(true);
    const { viewer, calls } = fakeViewer({
      admin_prepare_customer_invitation: { data: { invitation_id: INV }, error: null },
      admin_mark_customer_invitation_sent: { data: null, error: { code: "22023", message: "auth user does not match invitation" } },
      admin_revoke_customer_invitation: { data: { auth_user_id: null, changed: true }, error: null },
    });
    expect(await inviteCustomerMember(viewer, "req-5", BIZ, EMAIL, NAME, "BUSINESS_STAFF")).toBe("failed");
    expect(calls.map((c) => c.fn)).toEqual([
      "admin_prepare_customer_invitation",
      "admin_mark_customer_invitation_sent",
      "admin_revoke_customer_invitation", // database compensation precedes Auth cleanup
    ]);
    expect(deleteUnacceptedAuthUser).toHaveBeenCalledExactlyOnceWith(AUTH_USER, EMAIL);
    expectNoLeakage();
  });
  it("still attempts exact-user cleanup when the revocation itself fails", async () => {
    (inviteAuthUser as Mock).mockResolvedValue({ ok: true, userId: AUTH_USER });
    (deleteUnacceptedAuthUser as Mock).mockResolvedValue(true);
    const { viewer } = fakeViewer({
      admin_prepare_customer_invitation: { data: { invitation_id: INV }, error: null },
      admin_mark_customer_invitation_sent: { data: null, error: { code: "XX000", message: "connection reset" } },
      admin_revoke_customer_invitation: { data: null, error: { code: "XX000", message: "connection reset" } },
    });
    expect(await inviteCustomerMember(viewer, "req-6", BIZ, EMAIL, NAME, "BUSINESS_STAFF")).toBe("failed");
    expect(deleteUnacceptedAuthUser).toHaveBeenCalledExactlyOnceWith(AUTH_USER, EMAIL);
    expectNoLeakage();
  });
  it("never touches Auth cleanup on the success path", async () => {
    (inviteAuthUser as Mock).mockResolvedValue({ ok: true, userId: AUTH_USER });
    const { viewer } = fakeViewer({
      admin_prepare_customer_invitation: { data: { invitation_id: INV }, error: null },
      admin_mark_customer_invitation_sent: { data: { invitation_id: INV, status: "sent" }, error: null },
    });
    expect(await inviteCustomerMember(viewer, "req-7", BIZ, EMAIL, NAME, "BUSINESS_STAFF")).toBe("invited");
    expect(deleteUnacceptedAuthUser).not.toHaveBeenCalled();
    // the exact per-invitation provenance marker travels into the Auth invite call
    expect(inviteAuthUser).toHaveBeenCalledExactlyOnceWith(EMAIL, expect.stringMatching(/^https?:\/\//), INV);
    expectNoLeakage();
  });
  it("prepare failures never reach Supabase Auth at all", async () => {
    const { viewer } = fakeViewer({
      admin_prepare_customer_invitation: { data: null, error: { code: "23505", message: "invitation already active for this email" } },
    });
    expect(await inviteCustomerMember(viewer, "req-8", BIZ, EMAIL, NAME, "BUSINESS_STAFF")).toBe("invitation_exists");
    expect(inviteAuthUser).not.toHaveBeenCalled();
    expect(deleteUnacceptedAuthUser).not.toHaveBeenCalled();
    expectNoLeakage();
  });
});

describe("revocation route compensation", () => {
  it("cleans the bound unaccepted user only after a real database revocation", async () => {
    (deleteUnacceptedAuthUser as Mock).mockResolvedValue(true);
    const { viewer, calls } = fakeViewer({
      admin_revoke_customer_invitation: { data: { auth_user_id: AUTH_USER, changed: true }, error: null },
    });
    expect(await revokeCustomerInvitation(viewer, "req-9", BIZ, INV)).toBe("invitation_revoked");
    expect(calls[0]!.fn).toBe("admin_revoke_customer_invitation");
    expect(deleteUnacceptedAuthUser).toHaveBeenCalledExactlyOnceWith(AUTH_USER, EMAIL);
    expectNoLeakage();
  });
  it("a failed revocation deletes nothing", async () => {
    const { viewer } = fakeViewer({
      admin_revoke_customer_invitation: { data: null, error: { code: "55000", message: "invitation is not revocable" } },
    });
    expect(await revokeCustomerInvitation(viewer, "req-10", BIZ, INV)).toBe("not_operable");
    expect(deleteUnacceptedAuthUser).not.toHaveBeenCalled();
    expectNoLeakage();
  });
});
