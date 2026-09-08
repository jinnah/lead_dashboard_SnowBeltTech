import { describe, expect, it } from "vitest";
import { canReissueInvitation, invitationStatusLabel } from "./invitation-state";
import { parseTeamAction } from "./team-actions";
import { parseAdminAction } from "./admin-actions";

const now = Date.parse("2026-09-08T01:00:00Z");
const inv = { status: "sent", sent_at: "2026-09-08T00:55:00Z", expires_at: "2026-09-08T01:55:00Z" };
const id = "f1000000-0000-4000-8000-000000000001";
describe("invitation replacement UX", () => {
  it("distinguishes usable, expired and undelivered invitations", () => {
    expect(invitationStatusLabel(inv, now)).toContain("link usable");
    expect(invitationStatusLabel({ ...inv, expires_at: new Date(now).toISOString() }, now)).toBe("Expired invitation");
    expect(invitationStatusLabel({ ...inv, status: "prepared" }, now)).toBe("Awaiting delivery");
  });
  it("allows sent invitations at the cooldown boundary, including expired ones", () => {
    expect(canReissueInvitation(inv, now)).toBe(true);
    expect(canReissueInvitation(inv, now - 1)).toBe(false);
    expect(canReissueInvitation({ ...inv, expires_at: "2026-09-07T23:00:00Z" }, now)).toBe(true);
    for (const status of ["prepared", "accepted", "revoked", "failed"]) expect(canReissueInvitation({ ...inv, status }, now)).toBe(false);
    expect(canReissueInvitation({ ...inv, sent_at: null }, now)).toBe(false);
  });
  it("accepts only the untrusted invitation identifier and existing business selection", () => {
    const fields = new URLSearchParams({ action: "reissue_invitation", invitation_id: id });
    expect(parseAdminAction(fields, "business")).toEqual({ ok: true, action: { kind: "reissue_invitation", invitationId: id } });
    fields.set("business", "alpha-hvac");
    expect(parseTeamAction(fields)).toEqual({ ok: true, businessSlug: "alpha-hvac", action: { kind: "reissue_invitation", invitationId: id } });
    for (const key of ["email", "display_name", "role", "auth_user_id", "redirect_to", "business_id", "token"]) {
      const bad = new URLSearchParams(fields); bad.set(key, "untrusted");
      expect(parseTeamAction(bad)).toEqual({ ok: false, error: "unexpected_field" });
      bad.delete("business");
      expect(parseAdminAction(bad, "business")).toEqual({ ok: false, error: "unexpected_field" });
    }
    fields.append("invitation_id", id);
    expect(parseTeamAction(fields)).toEqual({ ok: false, error: "duplicate_field" });
    fields.delete("business");
    expect(parseAdminAction(fields, "business")).toEqual({ ok: false, error: "duplicate_field" });
  });
});
