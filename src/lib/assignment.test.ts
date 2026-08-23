import { describe, expect, it } from "vitest";
import { canAssign, parseAssignmentFilter, resolveAccess, type BusinessRow, type MemberOption, type ProfileRow } from "./access";
import { assigneeLabel, describeActivity, FORMER_MEMBER, type ActivityRow } from "./activity-text";
import { parseLeadAction } from "./lead-actions";

const NY = "America/New_York";
const p = (s: string) => parseLeadAction(new URLSearchParams(s), NY);
const STAFF = "a1000000-0000-4000-8000-000000000003";
const MANAGER = "a1000000-0000-4000-8000-000000000002";
const OWNER = "a1000000-0000-4000-8000-000000000001";
const B_OWNER = "b1000000-0000-4000-8000-000000000001";

describe("set_assignee action parsing", () => {
  it("accepts a UUID assignee and an empty value for unassignment", () => {
    expect(p(`action=set_assignee&assignee_id=${STAFF}`)).toEqual({ ok: true, action: { kind: "set_assignee", assigneeId: STAFF } });
    expect(p(`action=set_assignee&assignee_id=${STAFF.toUpperCase()}`)).toEqual({ ok: true, action: { kind: "set_assignee", assigneeId: STAFF } });
    expect(p("action=set_assignee&assignee_id=")).toEqual({ ok: true, action: { kind: "set_assignee", assigneeId: null } });
    expect(p("action=set_assignee")).toEqual({ ok: true, action: { kind: "set_assignee", assigneeId: null } });
  });
  it("rejects malformed ids and unexpected fields (tenant/actor/role/flags/columns)", () => {
    expect(p("action=set_assignee&assignee_id=not-a-uuid")).toEqual({ ok: false, error: "invalid_assignee" });
    expect(p("action=set_assignee&assignee_id=staff-a%40example.invalid")).toEqual({ ok: false, error: "invalid_assignee" });
    for (const extra of ["business_id=x", "actor_id=x", "role=BUSINESS_OWNER", "is_active=true", "platform_role=PLATFORM_ADMIN", "status=won", "assigned_to=x"]) {
      expect(p(`action=set_assignee&assignee_id=${STAFF}&${extra}`), extra).toEqual({ ok: false, error: "unexpected_field" });
    }
  });
});

describe("role capability", () => {
  const profile: ProfileRow = { id: OWNER, display_name: "U", platform_role: null, is_active: true };
  const bizA: BusinessRow = { id: "biz-a", name: "A", slug: "a", timezone: NY, status: "active" };
  const bizB: BusinessRow = { id: "biz-b", name: "B", slug: "b", timezone: NY, status: "active" };
  it("grants assignment only to an active owner/manager membership of THAT business", () => {
    const access = resolveAccess(profile, [bizA, bizB], [
      { business_id: "biz-a", role: "BUSINESS_OWNER", status: "active" },
      { business_id: "biz-b", role: "BUSINESS_STAFF", status: "active" },
    ]);
    expect(canAssign(access, "biz-a")).toBe(true);
    expect(canAssign(access, "biz-b")).toBe(false);
    expect(canAssign(access, "biz-c")).toBe(false);
  });
  it("ignores inactive memberships, unknown roles and admin/none access kinds", () => {
    expect(canAssign(resolveAccess(profile, [bizA], [{ business_id: "biz-a", role: "BUSINESS_MANAGER", status: "inactive" }]), "biz-a")).toBe(false);
    expect(canAssign(resolveAccess(profile, [bizA], [{ business_id: "biz-a", role: "SUPER_OWNER", status: "active" }]), "biz-a")).toBe(false);
    expect(canAssign(resolveAccess({ ...profile, platform_role: "PLATFORM_ADMIN" }, [bizA], [{ business_id: "biz-a", role: "BUSINESS_OWNER", status: "active" }]), "biz-a")).toBe(false);
    expect(canAssign(resolveAccess(profile, [{ ...bizA, status: "suspended" }], [{ business_id: "biz-a", role: "BUSINESS_OWNER", status: "active" }]), "biz-a")).toBe(false);
    expect(canAssign(resolveAccess(profile, [bizA], [{ business_id: "biz-a", role: "BUSINESS_MANAGER", status: "active" }]), "biz-a")).toBe(true);
  });
});

describe("assignment filter parsing", () => {
  const members: MemberOption[] = [
    { user_id: OWNER, display_name: "Owner A", role: "BUSINESS_OWNER" },
    { user_id: STAFF, display_name: "Staff A", role: "BUSINESS_STAFF" },
  ];
  it("parses all / mine / unassigned and authorized member ids", () => {
    expect(parseAssignmentFilter(undefined, MANAGER, members)).toEqual({ kind: "all" });
    expect(parseAssignmentFilter("", MANAGER, members)).toEqual({ kind: "all" });
    expect(parseAssignmentFilter("all", MANAGER, members)).toEqual({ kind: "all" });
    expect(parseAssignmentFilter("mine", MANAGER, members)).toEqual({ kind: "mine", userId: MANAGER });
    expect(parseAssignmentFilter("unassigned", MANAGER, members)).toEqual({ kind: "unassigned" });
    expect(parseAssignmentFilter(STAFF, MANAGER, members)).toEqual({ kind: "member", userId: STAFF });
    expect(parseAssignmentFilter(STAFF.toUpperCase(), MANAGER, members)).toEqual({ kind: "member", userId: STAFF });
  });
  it("falls back to all for foreign, inactive, unknown and injection-shaped values", () => {
    expect(parseAssignmentFilter(B_OWNER, MANAGER, members)).toEqual({ kind: "all" });
    expect(parseAssignmentFilter(MANAGER, MANAGER, members)).toEqual({ kind: "all" }); // not in the active list
    expect(parseAssignmentFilter("' or 1=1 --", MANAGER, members)).toEqual({ kind: "all" });
    expect(parseAssignmentFilter(["mine"], MANAGER, members)).toEqual({ kind: "all" });
    expect(parseAssignmentFilter("MINE", MANAGER, members)).toEqual({ kind: "all" });
  });
});

describe("assignment timeline text", () => {
  const row = (over: Partial<ActivityRow>): ActivityRow => ({
    id: "x", activity_type: "assignment_changed", old_value: null, new_value: null, old_display_value: null, new_display_value: null,
    note: null, actor_display_name: "Owner A", created_at: "2026-08-21T00:00:00Z", ...over,
  });
  it("describes assign / reassign / unassign with snapshots", () => {
    expect(describeActivity(row({ new_value: STAFF, new_display_value: "Staff A" }), NY)).toBe("Assigned to Staff A");
    expect(describeActivity(row({ old_value: STAFF, old_display_value: "Staff A", new_value: OWNER, new_display_value: "Owner A" }), NY)).toBe("Reassigned from Staff A to Owner A");
    expect(describeActivity(row({ old_value: STAFF, old_display_value: "Staff A" }), NY)).toBe("Unassigned (was Staff A)");
  });
  it("falls back safely for deleted users and never prints the UUID", () => {
    const text = describeActivity(row({ old_value: STAFF, old_display_value: null }), NY);
    expect(text).toBe(`Unassigned (was ${FORMER_MEMBER})`);
    expect(text).not.toContain(STAFF);
    expect(assigneeLabel("   ", STAFF)).toBe(FORMER_MEMBER);
    expect(assigneeLabel(null, null)).toBe("Unassigned");
    expect(assigneeLabel("<b>x</b>", STAFF)).toBe("<b>x</b>"); // plain string; React renders it as text
  });
});
