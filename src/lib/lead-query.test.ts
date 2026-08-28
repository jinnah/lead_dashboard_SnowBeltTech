import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BusinessRow, MemberOption } from "./access";
import {
  EXPORT_BATCH_SIZE,
  EXPORT_MAX_ROWS,
  findAuthorizedBusiness,
  leadQueryParams,
  normalizeSearch,
  PAGE_MAX,
  PAGE_SIZE,
  parseLeadQuery,
  parsePage,
  parseSort,
  SEARCH_MAX_LENGTH,
  SEARCH_MAX_OFFSET,
  searchLeadArgs,
} from "./lead-query";

const VIEWER = "a1000000-0000-4000-8000-000000000001";
const MEMBER = "a1000000-0000-4000-8000-000000000002";
const FOREIGN = "b1000000-0000-4000-8000-000000000001";
const members: MemberOption[] = [
  { user_id: VIEWER, display_name: "Owner A", role: "BUSINESS_OWNER" },
  { user_id: MEMBER, display_name: "Manager A", role: "BUSINESS_MANAGER" },
];
const biz: BusinessRow = { id: "a0000000-0000-4000-8000-000000000001", name: "Alpha", slug: "alpha-hvac", timezone: "America/New_York", status: "active" };
const bravo: BusinessRow = { id: "b0000000-0000-4000-8000-000000000001", name: "Bravo", slug: "bravo-plumbing", timezone: "America/Chicago", status: "active" };

describe("normalizeSearch", () => {
  it("trims, collapses internal whitespace and bounds the length", () => {
    expect(normalizeSearch("  Test   Contact\t One \n")).toBe("Test Contact One");
    expect(normalizeSearch("plain")).toBe("plain");
    expect(normalizeSearch("x".repeat(500))).toBe("x".repeat(SEARCH_MAX_LENGTH));
    expect(normalizeSearch("x".repeat(500))!.length).toBe(120);
  });
  it("treats empty, whitespace-only, duplicated and missing values as no search", () => {
    expect(normalizeSearch("")).toBeNull();
    expect(normalizeSearch("   \t\n ")).toBeNull();
    expect(normalizeSearch(undefined)).toBeNull();
    expect(normalizeSearch(null)).toBeNull();
    expect(normalizeSearch(["a", "b"])).toBeNull();
  });
});

describe("parseSort and parsePage", () => {
  it("allow-lists sorts", () => {
    expect(parseSort("newest")).toBe("newest");
    expect(parseSort("oldest")).toBe("oldest");
    for (const bad of ["OLDEST", "created_at.desc", "", "1; drop", undefined, null, ["oldest", "oldest"]]) {
      expect(parseSort(bad as never), String(bad)).toBe("newest");
    }
  });
  it("accepts only plain positive integers whose offset stays inside the database clamp", () => {
    expect(parsePage("1")).toBe(1);
    expect(parsePage("3")).toBe(3);
    expect(parsePage(String(PAGE_MAX))).toBe(20001); // offset exactly SEARCH_MAX_OFFSET
    for (const bad of ["20002", "99999", "0", "-1", "1.5", "  2", "2 ", "+2", "1e3", "abc", "100000", "999999999999", "", undefined, null, ["2", "3"]]) {
      expect(parsePage(bad as never), String(bad)).toBe(1);
    }
  });
  it("keeps the page bound and the database offset clamp aligned - they cannot drift", () => {
    expect(SEARCH_MAX_OFFSET).toBe(1_000_000);
    expect(PAGE_MAX).toBe(Math.floor(SEARCH_MAX_OFFSET / PAGE_SIZE) + 1);
    expect(PAGE_MAX).toBe(20001);
    expect((PAGE_MAX - 1) * PAGE_SIZE).toBeLessThanOrEqual(SEARCH_MAX_OFFSET); // max valid page never exceeds the clamp
    expect(PAGE_MAX * PAGE_SIZE).toBeGreaterThan(SEARCH_MAX_OFFSET); // the first rejected page would
    // and the constant is pinned to the actual migration, so a future SQL edit breaks this test
    const migration = readFileSync(path.resolve(__dirname, "../../supabase/migrations/20260821190000_lead_search.sql"), "utf8");
    expect(migration).toContain(`least(greatest(coalesce(p_offset, 0), 0), ${SEARCH_MAX_OFFSET})`);
  });
});

describe("parseLeadQuery + searchLeadArgs", () => {
  it("maps assignment kinds to parameterized RPC arguments (never filter grammar)", () => {
    const all = parseLeadQuery({}, VIEWER, members);
    expect(searchLeadArgs(biz.id, all)).toEqual({
      p_business_id: biz.id, p_q: null, p_status: null, p_source: null, p_unassigned: false, p_assigned_to: null, p_oldest: false,
    });
    const mine = parseLeadQuery({ assignment: "mine", sort: "oldest", q: " Boiler  Overhaul ", status: "new", source: "voice_call" }, VIEWER, members);
    expect(searchLeadArgs(biz.id, mine)).toEqual({
      p_business_id: biz.id, p_q: "Boiler Overhaul", p_status: "new", p_source: "voice_call", p_unassigned: false, p_assigned_to: VIEWER, p_oldest: true,
    });
    const unassigned = parseLeadQuery({ assignment: "unassigned" }, VIEWER, members);
    expect(searchLeadArgs(biz.id, unassigned).p_unassigned).toBe(true);
    const member = parseLeadQuery({ assignment: MEMBER.toUpperCase() }, VIEWER, members);
    expect(searchLeadArgs(biz.id, member).p_assigned_to).toBe(MEMBER);
  });
  it("drops foreign member UUIDs, unknown filters and hostile values to safe defaults", () => {
    const q = parseLeadQuery(
      { assignment: FOREIGN, status: "new' or 1=1", source: "or(source.eq.manual)", sort: "evil", q: "ok" },
      VIEWER,
      members,
    );
    expect(q.assignment).toEqual({ kind: "all" });
    expect(q.status).toBeNull();
    expect(q.source).toBeNull();
    expect(q.sort).toBe("newest");
    expect(q.q).toBe("ok");
  });
});

describe("leadQueryParams", () => {
  it("emits only normalized allow-listed parameters and omits defaults", () => {
    const query = parseLeadQuery({ q: "  needle  thread ", status: "new", assignment: "unassigned", sort: "oldest" }, VIEWER, members);
    const p = new URLSearchParams(leadQueryParams(biz, query, { page: 3 }));
    expect([...p.keys()].sort()).toEqual(["assignment", "business", "page", "q", "sort", "status"]);
    expect(p.get("business")).toBe("alpha-hvac");
    expect(p.get("q")).toBe("needle thread");
    expect(p.get("page")).toBe("3");
    expect(p.get("sort")).toBe("oldest");
  });
  it("never carries hostile or default values", () => {
    const query = parseLeadQuery({ assignment: FOREIGN, sort: "evil", status: "nope" }, VIEWER, members);
    expect(leadQueryParams(null, query)).toBe("");
    expect(leadQueryParams(biz, query, { page: 1 })).toBe("business=alpha-hvac");
    expect(leadQueryParams(biz, query, { err: "export_too_large" })).toContain("err=export_too_large");
  });
});

describe("findAuthorizedBusiness (strict export resolution)", () => {
  it("returns the default business only when no slug was requested", () => {
    expect(findAuthorizedBusiness([biz, bravo], undefined)).toBe(biz);
    expect(findAuthorizedBusiness([], undefined)).toBeNull();
  });
  it("honours only an exact authorized slug - unknown, foreign and duplicated selections resolve to nothing", () => {
    expect(findAuthorizedBusiness([biz, bravo], "bravo-plumbing")).toBe(bravo);
    expect(findAuthorizedBusiness([biz], "bravo-plumbing")).toBeNull();
    expect(findAuthorizedBusiness([biz], "does-not-exist")).toBeNull();
    expect(findAuthorizedBusiness([biz], "")).toBeNull();
    expect(findAuthorizedBusiness([biz], ["alpha-hvac", "alpha-hvac"])).toBeNull();
  });
});

describe("export limits", () => {
  it("keeps the documented bounds", () => {
    expect(PAGE_SIZE).toBe(50);
    expect(EXPORT_MAX_ROWS).toBe(25000);
    expect(EXPORT_BATCH_SIZE).toBeLessThanOrEqual(1000);
  });
});
