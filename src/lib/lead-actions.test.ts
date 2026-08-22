import { describe, expect, it } from "vitest";
import { parseLeadAction } from "./lead-actions";

const NY = "America/New_York";
const p = (s: string) => parseLeadAction(new URLSearchParams(s), NY);
const REQ = "11111111-1111-4111-8111-111111111111";

describe("parseLeadAction", () => {
  it("accepts allow-listed statuses only", () => {
    expect(p("action=set_status&status=won")).toEqual({ ok: true, action: { kind: "set_status", status: "won" } });
    expect(p("action=set_status&status=WON")).toEqual({ ok: false, error: "invalid_status" });
    expect(p("action=set_status&status=deleted")).toEqual({ ok: false, error: "invalid_status" });
    expect(p("action=set_status")).toEqual({ ok: false, error: "invalid_status" });
  });
  it("rejects unknown actions and unexpected fields (tenant/actor/columns)", () => {
    expect(p("action=delete")).toEqual({ ok: false, error: "unsupported_action" });
    expect(p("status=won")).toEqual({ ok: false, error: "unsupported_action" });
    for (const extra of ["business_id=x", "actor_id=x", "platform_role=PLATFORM_ADMIN", "assigned_to=x", "contact_name=x", "lead_number=x"]) {
      expect(p(`action=set_status&status=won&${extra}`), extra).toEqual({ ok: false, error: "unexpected_field" });
    }
    expect(p("action=clear_follow_up&date=2026-09-01")).toEqual({ ok: false, error: "unexpected_field" });
  });
  it("converts follow-up in the business timezone and rejects bad or nonexistent times", () => {
    const r = p("action=set_follow_up&date=2026-09-01&time=14:00");
    expect(r.ok && r.action.kind === "set_follow_up" && r.action.at.toISOString()).toBe("2026-09-01T18:00:00.000Z");
    expect(p("action=set_follow_up&date=2026-03-08&time=02:30")).toEqual({ ok: false, error: "nonexistent_time" });
    expect(p("action=set_follow_up&date=bogus&time=14:00")).toEqual({ ok: false, error: "invalid_follow_up" });
    expect(p("action=set_follow_up&date=2026-09-01&time=99:00")).toEqual({ ok: false, error: "invalid_follow_up" });
    expect(parseLeadAction(new URLSearchParams("action=set_follow_up&date=2026-09-01&time=14:00"), "Mars/Olympus")).toEqual({ ok: false, error: "invalid_follow_up" });
  });
  it("validates notes and request ids", () => {
    expect(p(`action=add_note&note=%20Hello%20&request_id=${REQ}`)).toEqual({ ok: true, action: { kind: "add_note", note: "Hello", requestId: REQ } });
    expect(p(`action=add_note&note=%20%20&request_id=${REQ}`)).toEqual({ ok: false, error: "invalid_note" });
    expect(p(`action=add_note&note=${"x".repeat(2001)}&request_id=${REQ}`)).toEqual({ ok: false, error: "invalid_note" });
    expect(p("action=add_note&note=hi&request_id=not-a-uuid")).toEqual({ ok: false, error: "invalid_request_id" });
    expect(p("action=add_note&note=hi")).toEqual({ ok: false, error: "invalid_request_id" });
  });
});
