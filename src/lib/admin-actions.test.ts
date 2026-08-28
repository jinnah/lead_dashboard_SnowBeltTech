import { describe, expect, it } from "vitest";
import {
  ADMIN_ERROR_MESSAGES, ADMIN_OK_MESSAGES, describeAccessEvent, describeAdminEvent, isCanonicalHttpsOrigin,
  isSupportedTimeZone, isValidExternalId, mapAdminRpcError, normalizeInviteEmail, parseAdminAction, REGISTRABLE_SOURCE_KINDS,
} from "./admin-actions";

const pp = (s: string) => parseAdminAction(new URLSearchParams(s), "platform");
const pb = (s: string) => parseAdminAction(new URLSearchParams(s), "business");
const SRC = "a3000000-0000-4000-8000-000000000001";
const BIZ = "name=Charlie+Roofing&slug=charlie-roofing&industry=roofing&timezone=America/Denver";

describe("create_business parsing", () => {
  it("accepts a complete, valid form and trims the name", () => {
    expect(pp(`action=create_business&name=++Charlie+Roofing++&slug=charlie-roofing&industry=roofing&timezone=America/Denver`))
      .toEqual({ ok: true, action: { kind: "create_business", name: "Charlie Roofing", slug: "charlie-roofing", industry: "roofing", timezone: "America/Denver" } });
    expect(pp(`action=create_business&${BIZ.replace("America/Denver", "UTC")}`)).toMatchObject({ ok: true, action: { timezone: "UTC" } });
  });
  it("requires every field exactly once", () => {
    expect(pp("action=create_business&slug=x&industry=hvac&timezone=UTC")).toEqual({ ok: false, error: "missing_field" });
    expect(pp(`action=create_business&${BIZ}&name=Second`)).toEqual({ ok: false, error: "duplicate_field" });
    expect(pp(`action=create_business&${BIZ}&slug=other`)).toEqual({ ok: false, error: "duplicate_field" });
    expect(pp(`action=create_business&action=create_business&${BIZ}`)).toEqual({ ok: false, error: "duplicate_field" });
    expect(pp(BIZ)).toEqual({ ok: false, error: "missing_field" });
  });
  it("rejects unexpected fields (tenant/actor/role/status/secrets) and unknown actions", () => {
    for (const extra of ["business_id=x", "id=x", "actor_id=x", "platform_role=PLATFORM_ADMIN", "status=active", "secret_key=x", "created_at=now"]) {
      expect(pp(`action=create_business&${BIZ}&${extra}`), extra).toEqual({ ok: false, error: "unexpected_field" });
    }
    expect(pp(`action=delete_business&${BIZ}`)).toEqual({ ok: false, error: "unsupported_action" });
    expect(pp(`action=set_business_status&status=active`)).toEqual({ ok: false, error: "unsupported_action" }); // wrong scope
    expect(pb(`action=create_business&${BIZ}`)).toEqual({ ok: false, error: "unsupported_action" });
  });
  it("validates name, slug, industry and timezone", () => {
    expect(pp(`action=create_business&${BIZ.replace("Charlie+Roofing", "+++")}`)).toEqual({ ok: false, error: "invalid_name" });
    expect(pp(`action=create_business&${BIZ.replace("Charlie+Roofing", "n".repeat(201))}`)).toEqual({ ok: false, error: "invalid_name" });
    expect(pp(`action=create_business&${BIZ.replace("Charlie+Roofing", "n".repeat(200))}`)).toMatchObject({ ok: true });
    for (const slug of ["Charlie", "charlie roofing", "-charlie", "charlie-", "charlie_roofing", "a".repeat(64), "", "ch/arlie"]) {
      expect(pp(`action=create_business&${BIZ.replace("charlie-roofing", encodeURIComponent(slug))}`), slug).toEqual({ ok: false, error: "invalid_slug" });
    }
    expect(pp(`action=create_business&${BIZ.replace("charlie-roofing", "a".repeat(63))}`)).toMatchObject({ ok: true });
    for (const ind of ["banking", "HVAC", "", "roofing;drop"]) {
      expect(pp(`action=create_business&${BIZ.replace("industry=roofing", `industry=${encodeURIComponent(ind)}`)}`), ind).toEqual({ ok: false, error: "invalid_industry" });
    }
    for (const tz of ["Mars/Olympus_Mons", "America/Not_A_Zone", "EST", "", "UTC+5", "Etc/GMT+5;x", "America/Denver/"]) {
      expect(pp(`action=create_business&${BIZ.replace("America/Denver", encodeURIComponent(tz))}`), tz).toEqual({ ok: false, error: "invalid_timezone" });
    }
    for (const tz of ["America/New_York", "Europe/London", "Asia/Kolkata", "UTC"]) expect(isSupportedTimeZone(tz), tz).toBe(true);
  });
});

describe("business lifecycle parsing", () => {
  it("allows only active/suspended targets, exactly once", () => {
    expect(pb("action=set_business_status&status=suspended")).toEqual({ ok: true, action: { kind: "set_business_status", status: "suspended" } });
    expect(pb("action=set_business_status&status=active")).toEqual({ ok: true, action: { kind: "set_business_status", status: "active" } });
    for (const st of ["archived", "inactive", "ACTIVE", "", "deleted"]) expect(pb(`action=set_business_status&status=${st}`), st).toEqual({ ok: false, error: "invalid_status" });
    expect(pb("action=set_business_status")).toEqual({ ok: false, error: "missing_field" });
    expect(pb("action=set_business_status&status=active&status=suspended")).toEqual({ ok: false, error: "duplicate_field" });
    expect(pb("action=set_business_status&status=active&business_id=x")).toEqual({ ok: false, error: "unexpected_field" });
  });
});

describe("source registration parsing", () => {
  it("accepts the three ingestible kinds; label and origin are optional and normalized", () => {
    expect(pb("action=create_source&kind=website_form&external_id=site-charlie&label=+Charlie+site+&allowed_origin=https://charlie.example.invalid"))
      .toEqual({ ok: true, action: { kind: "create_source", sourceKind: "website_form", externalId: "site-charlie", label: "Charlie site", allowedOrigin: "https://charlie.example.invalid" } });
    expect(pb("action=create_source&kind=vapi_assistant&external_id=asst-1")).toMatchObject({ ok: true, action: { label: null, allowedOrigin: null } });
    expect(pb("action=create_source&kind=vapi_phone_number&external_id=%2B15550100777&label=&allowed_origin=")).toMatchObject({ ok: true, action: { externalId: "+15550100777", label: null, allowedOrigin: null } });
    expect(REGISTRABLE_SOURCE_KINDS).not.toContain("twilio_number");
  });
  it("rejects unsupported kinds, bad identifiers, long labels, non-canonical origins and origins on voice sources", () => {
    for (const kind of ["twilio_number", "sms", "Website_Form", ""]) expect(pb(`action=create_source&kind=${kind}&external_id=x`), kind).toEqual({ ok: false, error: "invalid_kind" });
    for (const id of ["", "+padded", "padded+", "%09tab", "a%0Ab", "x".repeat(256)]) expect(pb(`action=create_source&kind=website_form&external_id=${id}`), id).toEqual({ ok: false, error: "invalid_external_id" });
    expect(isValidExternalId("x".repeat(255))).toBe(true);
    expect(isValidExternalId("site alpha")).toBe(true); // interior spaces are preserved exactly
    expect(pb(`action=create_source&kind=website_form&external_id=x&label=${"l".repeat(101)}`)).toEqual({ ok: false, error: "invalid_label" });
    for (const o of ["http://a.example", "https://a.example/", "https://a.example/p", "https://a.example?q", "https://a.example#f", "https://u:p@a.example", "https://A.example", "https://a.example:443", "https://a.example:70000", "+https://a.example", "https://", "a.example"]) {
      expect(pb(`action=create_source&kind=website_form&external_id=x&allowed_origin=${encodeURIComponent(o)}`), o).toEqual({ ok: false, error: "invalid_origin" });
      expect(isCanonicalHttpsOrigin(o.replace("+", " ")), o).toBe(false);
    }
    expect(isCanonicalHttpsOrigin("https://a.example:8443")).toBe(true);
    expect(pb("action=create_source&kind=vapi_assistant&external_id=asst-1&allowed_origin=https://a.example")).toEqual({ ok: false, error: "invalid_origin" });
  });
  it("enforces cardinality and the field allow-list", () => {
    expect(pb("action=create_source&kind=website_form")).toEqual({ ok: false, error: "missing_field" });
    expect(pb("action=create_source&kind=website_form&external_id=a&external_id=b")).toEqual({ ok: false, error: "duplicate_field" });
    expect(pb("action=create_source&kind=website_form&external_id=a&label=x&label=y")).toEqual({ ok: false, error: "duplicate_field" });
    for (const extra of ["business_id=x", "status=inactive", "id=x", "actor_id=x", "secret=x"]) {
      expect(pb(`action=create_source&kind=website_form&external_id=a&${extra}`), extra).toEqual({ ok: false, error: "unexpected_field" });
    }
  });
});

describe("source lifecycle parsing", () => {
  it("requires a UUID source and an active/inactive target", () => {
    expect(pb(`action=set_source_status&source_id=${SRC.toUpperCase()}&status=inactive`)).toEqual({ ok: true, action: { kind: "set_source_status", sourceId: SRC, status: "inactive" } });
    expect(pb(`action=set_source_status&source_id=not-a-uuid&status=inactive`)).toEqual({ ok: false, error: "invalid_source" });
    expect(pb(`action=set_source_status&source_id=${SRC}&status=archived`)).toEqual({ ok: false, error: "invalid_status" });
    expect(pb(`action=set_source_status&source_id=${SRC}&source_id=${SRC}&status=active`)).toEqual({ ok: false, error: "duplicate_field" });
    expect(pb(`action=set_source_status&status=active`)).toEqual({ ok: false, error: "missing_field" });
    expect(pb(`action=set_source_status&source_id=${SRC}&status=active&business_id=x`)).toEqual({ ok: false, error: "unexpected_field" });
  });
});

describe("result mapping and messages", () => {
  it("maps database outcomes to allow-listed codes and every code has a message", () => {
    expect(mapAdminRpcError("42501", "platform administrator required", "create_business")).toBe("not_allowed");
    expect(mapAdminRpcError("P0002", "business not found", "set_source_status")).toBe("not_found");
    expect(mapAdminRpcError("55000", "archived businesses cannot be changed", "set_business_status")).toBe("not_operable");
    expect(mapAdminRpcError("23505", "slug already exists", "create_business")).toBe("slug_taken");
    expect(mapAdminRpcError("23505", "integration source identifier already registered", "create_source")).toBe("source_taken");
    expect(mapAdminRpcError("22023", "unsupported timezone", "create_business")).toBe("invalid_timezone");
    expect(mapAdminRpcError("22023", "slug must be a lowercase DNS-label style identifier", "create_business")).toBe("invalid_slug");
    expect(mapAdminRpcError("22023", "voice sources do not accept a website origin", "create_source")).toBe("invalid_origin");
    expect(mapAdminRpcError("22023", "external identifier must be 1-255 characters", "create_source")).toBe("invalid_external_id");
    expect(mapAdminRpcError("22023", null, "create_business")).toBe("invalid_name");
    expect(mapAdminRpcError("22023", "something new", "create_source")).toBe("invalid_external_id");
    expect(mapAdminRpcError("XX000", "internal", "create_source")).toBe("failed");
    expect(mapAdminRpcError(undefined, undefined, "create_source")).toBe("failed");
    for (const msg of [...Object.values(ADMIN_ERROR_MESSAGES), ...Object.values(ADMIN_OK_MESSAGES)]) {
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).not.toMatch(/sql|postgres|exception/i);
    }
  });
  it("describes ledger rows with labels, never identifiers", () => {
    const row = { id: "e", event_type: "integration_source_status_changed", integration_source_id: SRC, actor_display_name: "Admin", old_value: "active", new_value: "inactive", created_at: "2026-08-23T00:00:00Z" };
    expect(describeAdminEvent(row, () => "Alpha website form")).toBe("Alpha website form: active → inactive");
    expect(describeAdminEvent({ ...row, event_type: "business_created", integration_source_id: null }, () => "x")).toBe("Business created");
    expect(describeAdminEvent({ ...row, event_type: "business_status_changed", integration_source_id: null, old_value: "active", new_value: "suspended" }, () => "x")).toBe("Business active → suspended");
    expect(describeAdminEvent({ ...row, event_type: "integration_source_created" }, () => "Charlie form")).toBe("Registered Charlie form");
    expect(describeAdminEvent({ ...row, event_type: "something_else" }, () => "x")).toBe("Platform operation");
  });
});

describe("invitation form parsing", () => {
  const OWNER_INVITE = "action=invite_member&email=owner%40charlie.example.invalid&display_name=Charlie+Owner&role=BUSINESS_OWNER";
  it("accepts a complete invitation and normalizes the email", () => {
    expect(pb(OWNER_INVITE)).toEqual({ ok: true, action: { kind: "invite_member", email: "owner@charlie.example.invalid", displayName: "Charlie Owner", role: "BUSINESS_OWNER" } });
    expect(pb("action=invite_member&email=++Mixed.Case%40Example.INVALID++&display_name=X&role=BUSINESS_STAFF")).toMatchObject({ ok: true, action: { email: "mixed.case@example.invalid" } });
    expect(normalizeInviteEmail("  UPPER@Example.Invalid  ")).toBe("upper@example.invalid");
  });
  it("rejects malformed, padded-only, overlong emails and bad names/roles", () => {
    for (const e of ["", "   ", "plain", "a@b", "a b@c.invalid", "a@b .invalid", `${"x".repeat(320)}@ex.invalid`]) {
      expect(pb(`action=invite_member&email=${encodeURIComponent(e)}&display_name=X&role=BUSINESS_STAFF`), e).toEqual({ ok: false, error: "invalid_email" });
      expect(normalizeInviteEmail(e), e).toBeNull();
    }
    expect(pb("action=invite_member&email=a%40b.invalid&display_name=++&role=BUSINESS_STAFF")).toEqual({ ok: false, error: "invalid_display_name" });
    expect(pb(`action=invite_member&email=a%40b.invalid&display_name=${"n".repeat(101)}&role=BUSINESS_STAFF`)).toEqual({ ok: false, error: "invalid_display_name" });
    for (const r of ["PLATFORM_ADMIN", "OWNER", "business_owner", ""]) {
      expect(pb(`action=invite_member&email=a%40b.invalid&display_name=X&role=${r}`), r).toEqual({ ok: false, error: "invalid_role" });
    }
  });
  it("enforces exact field cardinality and the allow-list", () => {
    expect(pb("action=invite_member&email=a%40b.invalid&display_name=X")).toEqual({ ok: false, error: "missing_field" });
    expect(pb(`${OWNER_INVITE}&email=second%40b.invalid`)).toEqual({ ok: false, error: "duplicate_field" });
    for (const extra of ["business_id=x", "actor_id=x", "platform_role=PLATFORM_ADMIN", "redirect_to=https://evil.invalid", "auth_user_id=x", "service_key=x"]) {
      expect(pb(`${OWNER_INVITE}&${extra}`), extra).toEqual({ ok: false, error: "unexpected_field" });
    }
  });
});

describe("invitation revocation and membership parsing", () => {
  const U = "a1000000-0000-4000-8000-000000000003";
  it("revoke requires exactly one invitation UUID", () => {
    expect(pb(`action=revoke_invitation&invitation_id=${U.toUpperCase()}`)).toEqual({ ok: true, action: { kind: "revoke_invitation", invitationId: U } });
    expect(pb("action=revoke_invitation&invitation_id=not-a-uuid")).toEqual({ ok: false, error: "invalid_invitation" });
    expect(pb("action=revoke_invitation")).toEqual({ ok: false, error: "missing_field" });
    expect(pb(`action=revoke_invitation&invitation_id=${U}&invitation_id=${U}`)).toEqual({ ok: false, error: "duplicate_field" });
    expect(pb(`action=revoke_invitation&invitation_id=${U}&email=x%40y.invalid`)).toEqual({ ok: false, error: "unexpected_field" });
  });
  it("member role and status changes validate UUIDs and allow-lists", () => {
    expect(pb(`action=set_member_role&user_id=${U}&role=BUSINESS_MANAGER`)).toEqual({ ok: true, action: { kind: "set_member_role", userId: U, role: "BUSINESS_MANAGER" } });
    expect(pb(`action=set_member_role&user_id=${U}&role=PLATFORM_ADMIN`)).toEqual({ ok: false, error: "invalid_role" });
    expect(pb("action=set_member_role&user_id=nope&role=BUSINESS_STAFF")).toEqual({ ok: false, error: "invalid_member" });
    expect(pb(`action=set_member_status&user_id=${U}&status=inactive`)).toEqual({ ok: true, action: { kind: "set_member_status", userId: U, status: "inactive" } });
    expect(pb(`action=set_member_status&user_id=${U}&status=active`)).toMatchObject({ ok: true });
    for (const st of ["suspended", "ACTIVE", "", "deleted"]) {
      expect(pb(`action=set_member_status&user_id=${U}&status=${st}`), st).toEqual({ ok: false, error: "invalid_status" });
    }
    expect(pb(`action=set_member_status&user_id=${U}&status=active&status=inactive`)).toEqual({ ok: false, error: "duplicate_field" });
    expect(pb(`action=set_member_role&user_id=${U}&role=BUSINESS_OWNER&business_id=x`)).toEqual({ ok: false, error: "unexpected_field" });
  });
  it("maps the new database outcomes to allow-listed codes", () => {
    expect(mapAdminRpcError("22023", "invitation email is invalid", "invite_member")).toBe("invalid_email");
    expect(mapAdminRpcError("22023", "display name must be 1-100 characters", "invite_member")).toBe("invalid_display_name");
    expect(mapAdminRpcError("22023", "unsupported customer role", "set_member_role")).toBe("invalid_role");
    expect(mapAdminRpcError("22023", "unsupported membership status", "set_member_status")).toBe("invalid_status");
    expect(mapAdminRpcError("22023", "first member must be a business owner", "invite_member")).toBe("owner_required");
    expect(mapAdminRpcError("22023", "email already registered", "invite_member")).toBe("email_in_use");
    expect(mapAdminRpcError("23505", "invitation already active for this email", "invite_member")).toBe("invitation_exists");
    expect(mapAdminRpcError("55000", "cannot demote the last active owner", "set_member_role")).toBe("last_owner");
    expect(mapAdminRpcError("55000", "cannot deactivate the last active owner", "set_member_status")).toBe("last_owner");
    expect(mapAdminRpcError("55000", "business is not active", "invite_member")).toBe("not_operable");
    expect(mapAdminRpcError("P0002", "membership not found", "set_member_role")).toBe("not_found");
  });
  it("describes access events with names and statuses only (never emails)", () => {
    const row = { id: "e", event_type: "membership_role_changed", invitation_id: null, target_user_id: "u", actor_display_name: "Admin", old_value: "BUSINESS_OWNER", new_value: "BUSINESS_MANAGER", created_at: "2026-08-27T00:00:00Z" };
    expect(describeAccessEvent(row, () => "Charlie Owner")).toBe("Charlie Owner: Owner → Manager");
    expect(describeAccessEvent({ ...row, event_type: "membership_status_changed", old_value: "active", new_value: "inactive" }, () => "Charlie Owner")).toContain("membership active");
    expect(describeAccessEvent({ ...row, event_type: "invitation_accepted" }, () => "Charlie Owner")).toBe("Invitation accepted by Charlie Owner");
    for (const t of ["invitation_prepared", "invitation_sent", "invitation_failed", "invitation_revoked"]) {
      const text = describeAccessEvent({ ...row, event_type: t }, () => "x");
      expect(text).not.toContain("@");
    }
  });
});
