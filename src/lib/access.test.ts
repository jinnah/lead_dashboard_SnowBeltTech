import { describe, expect, it } from "vitest";
import { LEAD_SOURCES, LEAD_STATUSES, allowlisted, resolveAccess, selectBusiness, type BusinessRow, type ProfileRow } from "./access";

const profile = (over: Partial<ProfileRow> = {}): ProfileRow => ({ id: "u", display_name: "U", platform_role: null, is_active: true, ...over });
const biz = (over: Partial<BusinessRow> = {}): BusinessRow => ({ id: "b1", name: "Alpha", slug: "alpha", timezone: "UTC", status: "active", ...over });

describe("resolveAccess", () => {
  it("derives customer access only from active businesses", () => {
    expect(resolveAccess(profile(), [biz()]).kind).toBe("customer");
    expect(resolveAccess(profile(), []).kind).toBe("none");
    expect(resolveAccess(profile(), [biz({ status: "suspended" })]).kind).toBe("none");
    expect(resolveAccess(profile(), [biz({ status: "archived" })]).kind).toBe("none");
  });
  it("denies inactive or missing profiles regardless of businesses", () => {
    expect(resolveAccess(profile({ is_active: false }), [biz()]).kind).toBe("none");
    expect(resolveAccess(null, [biz()]).kind).toBe("none");
    expect(resolveAccess(profile({ is_active: false, platform_role: "PLATFORM_ADMIN" }), []).kind).toBe("none");
  });
  it("recognises the system-managed platform role only by its exact value", () => {
    expect(resolveAccess(profile({ platform_role: "PLATFORM_ADMIN" }), []).kind).toBe("admin");
    expect(resolveAccess(profile({ platform_role: "platform_admin" }), []).kind).toBe("none");
    expect(resolveAccess(profile({ platform_role: "ADMIN" }), [biz()]).kind).toBe("customer");
  });
});

describe("selectBusiness", () => {
  const list = [biz(), biz({ id: "b2", name: "Bravo", slug: "bravo" })];
  it("honours a requested slug only when authorized", () => {
    expect(selectBusiness(list, "bravo")?.id).toBe("b2");
    expect(selectBusiness(list, "charlie")?.id).toBe("b1");
    expect(selectBusiness(list, "b0000000-0000-4000-8000-000000000001")?.id).toBe("b1");
    expect(selectBusiness([], "alpha")).toBeNull();
  });
});

describe("allowlisted", () => {
  it("accepts only exact allow-listed strings", () => {
    expect(allowlisted(LEAD_STATUSES, "new")).toBe("new");
    expect(allowlisted(LEAD_STATUSES, "NEW")).toBeNull();
    expect(allowlisted(LEAD_STATUSES, "new' or 1=1")).toBeNull();
    expect(allowlisted(LEAD_SOURCES, ["voice_call"])).toBeNull();
    expect(allowlisted(LEAD_SOURCES, undefined)).toBeNull();
  });
});
