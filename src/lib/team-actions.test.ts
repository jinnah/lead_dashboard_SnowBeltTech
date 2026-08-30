import { describe, expect, it } from "vitest";
import { canManageTeam, customerRoleLabel, resolveAccess, ROLE_DISPLAY_LABELS, type Access, type MembershipRow, type ProfileRow } from "./access";
import { parseTeamAction, TEAM_GRANTABLE_ROLES } from "./team-actions";

const p = (s: string) => parseTeamAction(new URLSearchParams(s));
const MEMBER = "a1000000-0000-4000-8000-000000000003";
const INV = "c1000000-0000-4000-8000-000000000009";

describe("team action parsing", () => {
  it("accepts each action with exactly its allow-listed fields", () => {
    expect(p(`action=invite_member&business=alpha-hvac&email=New.Member%40Example.INVALID&display_name=%20New%20Member%20&role=BUSINESS_MANAGER`)).toEqual({
      ok: true,
      businessSlug: "alpha-hvac",
      action: { kind: "invite_member", email: "new.member@example.invalid", displayName: "New Member", role: "BUSINESS_MANAGER" },
    });
    expect(p(`action=revoke_invitation&business=alpha-hvac&invitation_id=${INV.toUpperCase()}`)).toEqual({
      ok: true, businessSlug: "alpha-hvac", action: { kind: "revoke_invitation", invitationId: INV },
    });
    expect(p(`action=set_member_role&business=alpha-hvac&user_id=${MEMBER}&role=BUSINESS_STAFF`)).toEqual({
      ok: true, businessSlug: "alpha-hvac", action: { kind: "set_member_role", userId: MEMBER, role: "BUSINESS_STAFF" },
    });
    expect(p(`action=set_member_status&business=alpha-hvac&user_id=${MEMBER}&status=inactive`)).toEqual({
      ok: true, businessSlug: "alpha-hvac", action: { kind: "set_member_status", userId: MEMBER, status: "inactive" },
    });
  });
  it("owners can never submit an OWNER role - the value is not even parseable", () => {
    expect(TEAM_GRANTABLE_ROLES).toEqual(["BUSINESS_MANAGER", "BUSINESS_STAFF"]);
    expect(p(`action=invite_member&business=alpha-hvac&email=a%40b.invalid&display_name=X&role=BUSINESS_OWNER`)).toEqual({ ok: false, error: "invalid_role" });
    expect(p(`action=set_member_role&business=alpha-hvac&user_id=${MEMBER}&role=BUSINESS_OWNER`)).toEqual({ ok: false, error: "invalid_role" });
    expect(p(`action=invite_member&business=alpha-hvac&email=a%40b.invalid&display_name=X&role=PLATFORM_ADMIN`)).toEqual({ ok: false, error: "invalid_role" });
  });
  it("rejects missing, duplicated and unexpected fields", () => {
    expect(p("")).toEqual({ ok: false, error: "missing_field" });
    expect(p("action=invite_member&action=invite_member")).toEqual({ ok: false, error: "duplicate_field" });
    expect(p("action=explode")).toEqual({ ok: false, error: "unsupported_action" });
    expect(p(`action=invite_member&business=alpha-hvac&email=a%40b.invalid&display_name=X`)).toEqual({ ok: false, error: "missing_field" });
    expect(p(`action=invite_member&business=alpha-hvac&email=a%40b.invalid&email=b%40c.invalid&display_name=X&role=BUSINESS_STAFF`)).toEqual({ ok: false, error: "duplicate_field" });
    for (const extra of ["business_id=b0000000-0000-4000-8000-000000000001", "redirect_to=https%3A%2F%2Fevil.invalid", "user_id=x", "next=%2Fadmin"]) {
      expect(p(`action=invite_member&business=alpha-hvac&email=a%40b.invalid&display_name=X&role=BUSINESS_STAFF&${extra}`), extra).toEqual({ ok: false, error: "unexpected_field" });
    }
  });
  it("rejects malformed emails, names, ids and statuses", () => {
    expect(p(`action=invite_member&business=alpha-hvac&email=nope&display_name=X&role=BUSINESS_STAFF`)).toEqual({ ok: false, error: "invalid_email" });
    expect(p(`action=invite_member&business=alpha-hvac&email=a%40b.invalid&display_name=${"x".repeat(101)}&role=BUSINESS_STAFF`)).toEqual({ ok: false, error: "invalid_display_name" });
    expect(p(`action=set_member_role&business=alpha-hvac&user_id=not-a-uuid&role=BUSINESS_STAFF`)).toEqual({ ok: false, error: "invalid_member" });
    expect(p(`action=revoke_invitation&business=alpha-hvac&invitation_id=nope`)).toEqual({ ok: false, error: "invalid_invitation" });
    expect(p(`action=set_member_status&business=alpha-hvac&user_id=${MEMBER}&status=deleted`)).toEqual({ ok: false, error: "invalid_status" });
    expect(p(`action=set_member_status&business=&user_id=${MEMBER}&status=active`)).toEqual({ ok: false, error: "missing_field" });
  });
});

describe("role display and team capability", () => {
  const profile: ProfileRow = { id: "u1", display_name: "U", platform_role: null, is_active: true };
  const businesses = [
    { id: "b1", name: "Alpha", slug: "alpha", timezone: "UTC", status: "active" },
    { id: "b2", name: "Bravo", slug: "bravo", timezone: "UTC", status: "active" },
  ];
  const memberships: MembershipRow[] = [
    { business_id: "b1", role: "BUSINESS_OWNER", status: "active" },
    { business_id: "b2", role: "BUSINESS_MANAGER", status: "active" },
  ];
  const access = resolveAccess(profile, businesses, memberships);

  it("labels the effective role per selected business (Owner in A, Manager in B)", () => {
    expect(customerRoleLabel(access, "b1")).toBe("Owner");
    expect(customerRoleLabel(access, "b2")).toBe("Manager");
    expect(ROLE_DISPLAY_LABELS.BUSINESS_STAFF).toBe("Staff");
  });
  it("grants team management only to the owner of THAT business", () => {
    expect(canManageTeam(access, "b1")).toBe(true);
    expect(canManageTeam(access, "b2")).toBe(false);
    expect(canManageTeam(access, "b3-unknown")).toBe(false);
    const admin: Access = { kind: "admin", businesses: [], roles: {} };
    expect(canManageTeam(admin, "b1")).toBe(false); // admins use /admin, never the customer-owner surface
  });
  it("an inactive membership or unknown business never yields an active role label", () => {
    const inactive = resolveAccess(profile, businesses, [{ business_id: "b1", role: "BUSINESS_OWNER", status: "inactive" }]);
    expect(customerRoleLabel(inactive, "b1")).toBe("Customer");
    expect(canManageTeam(inactive, "b1")).toBe(false);
    expect(customerRoleLabel(access, "unknown")).toBe("Customer");
  });
});
