import { describe, expect, it } from "vitest";
import { mapRpcError, toPublicResult, type RpcRow } from "./ingest";

const row = (over: Partial<RpcRow> = {}): RpcRow => ({
  outcome: "lead_created",
  should_notify: true,
  customer_sms_allowed: true,
  business_id: "a0000000-0000-4000-8000-000000000001",
  lead_id: "aa000000-0000-4000-8000-0000000000aa",
  lead_number: "INQ-2026-0004",
  ingestion_event_id: "ee000000-0000-4000-8000-0000000000ee",
  attempt_count: 1,
  ...over,
});

describe("toPublicResult", () => {
  it("maps a new lead with notification permission from the database", () => {
    expect(toPublicResult(row())).toEqual({ outcome: "lead_created", should_notify: true, customer_sms_allowed: true, lead_id: row().lead_id, lead_number: "INQ-2026-0004" });
  });
  it("never includes business_id, event id or attempt count", () => {
    const keys = Object.keys(toPublicResult(row()));
    expect(keys).toEqual(["outcome", "should_notify", "customer_sms_allowed", "lead_id", "lead_number"]);
    expect(JSON.stringify(toPublicResult(row()))).not.toContain("a0000000-0000-4000-8000-000000000001");
  });
  it("duplicates and filtered results can never authorize notifications, even if the row said so", () => {
    for (const outcome of ["duplicate_lead", "filtered", "duplicate_filtered"] as const) {
      const r = toPublicResult(row({ outcome, should_notify: true, customer_sms_allowed: true }));
      expect(r.should_notify).toBe(false);
      expect(r.customer_sms_allowed).toBe(false);
    }
  });
  it("filtered results carry null lead fields", () => {
    const r = toPublicResult(row({ outcome: "filtered", should_notify: false, customer_sms_allowed: false, lead_id: null, lead_number: null }));
    expect(r.lead_id).toBeNull();
    expect(r.lead_number).toBeNull();
  });
  it("rejects unexpected outcomes", () => {
    expect(() => toPublicResult(row({ outcome: "weird" as RpcRow["outcome"] }))).toThrow();
  });
});

describe("mapRpcError", () => {
  it("collapses unknown/inactive/suspended/archived into one opaque response", () => {
    const a = mapRpcError({ code: "P0002", message: "unknown integration source" }, false);
    const b = mapRpcError({ code: "55000", message: "business is not active" }, false);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    expect(a.body).toEqual(b.body);
    expect(JSON.stringify(a.body)).not.toMatch(/unknown|inactive|suspended|archived|P0002|55000/);
  });
  it("maps transport failures to 503 and unknown errors to a generic 500", () => {
    expect(mapRpcError(null, true).status).toBe(503);
    expect(mapRpcError({ code: "57P01", message: "terminating connection" }, false).status).toBe(503);
    const e = mapRpcError({ code: "XX000", message: "internal error with SELECT * FROM leads" }, false);
    expect(e.status).toBe(500);
    expect(JSON.stringify(e.body)).not.toMatch(/SELECT|leads|XX000/);
  });
  it("maps database validation classes to 422 without echoing the message", () => {
    const e = mapRpcError({ code: "22023", message: "phone_e164 is not a valid E.164 number" }, false);
    expect(e.status).toBe(422);
    expect(JSON.stringify(e.body)).not.toContain("E.164");
  });
});
