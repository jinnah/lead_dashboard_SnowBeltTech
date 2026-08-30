// Pure parsing for the customer-owner Team & access actions. Mirrors the
// administrator action parser's discipline - every field exactly once,
// unexpected fields rejected, allow-listed values only - but with the OWNER
// role surface: owners may assign or grant only Manager/Staff, never Owner.
// The business is identified by its slug and re-resolved server-side against
// the viewer's RLS-authorized businesses (a browser-supplied UUID is never
// proof of anything); the database RPCs re-enforce every rule again.
import { EMAIL_MAX, normalizeInviteEmail } from "@/lib/admin-actions";

export const TEAM_ACTIONS = ["invite_member", "revoke_invitation", "set_member_role", "set_member_status"] as const;
export type TeamActionName = (typeof TEAM_ACTIONS)[number];

/** Roles a customer OWNER may grant or assign. Ownership stays with SnowBeltTech. */
export const TEAM_GRANTABLE_ROLES = ["BUSINESS_MANAGER", "BUSINESS_STAFF"] as const;
export const TEAM_STATUS_TARGETS = ["active", "inactive"] as const;
export { EMAIL_MAX };

export const TEAM_ACTION_FIELDS: Record<TeamActionName, readonly string[]> = {
  invite_member: ["action", "business", "email", "display_name", "role"],
  revoke_invitation: ["action", "business", "invitation_id"],
  set_member_role: ["action", "business", "user_id", "role"],
  set_member_status: ["action", "business", "user_id", "status"],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ParsedTeamAction =
  | { kind: "invite_member"; email: string; displayName: string; role: (typeof TEAM_GRANTABLE_ROLES)[number] }
  | { kind: "revoke_invitation"; invitationId: string }
  | { kind: "set_member_role"; userId: string; role: (typeof TEAM_GRANTABLE_ROLES)[number] }
  | { kind: "set_member_status"; userId: string; status: (typeof TEAM_STATUS_TARGETS)[number] };

export type TeamActionError =
  | "unsupported_action" | "missing_field" | "duplicate_field" | "unexpected_field"
  | "invalid_email" | "invalid_display_name" | "invalid_role" | "invalid_member" | "invalid_invitation" | "invalid_status";

export type TeamParse =
  | { ok: true; businessSlug: string; action: ParsedTeamAction }
  | { ok: false; error: TeamActionError };

/**
 * Exactly the allow-listed fields for the named action, each exactly once.
 * Returns the (still untrusted) business slug for STRICT server-side
 * re-authorization plus the validated action payload.
 */
export function parseTeamAction(fields: URLSearchParams): TeamParse {
  const actions = fields.getAll("action");
  if (actions.length !== 1) return { ok: false, error: actions.length === 0 ? "missing_field" : "duplicate_field" };
  const action = actions[0] as TeamActionName;
  if (!(TEAM_ACTIONS as readonly string[]).includes(action)) return { ok: false, error: "unsupported_action" };
  const allowed = TEAM_ACTION_FIELDS[action];
  for (const key of fields.keys()) if (!allowed.includes(key)) return { ok: false, error: "unexpected_field" };
  const got: Record<string, string> = {};
  for (const key of allowed) {
    const values = fields.getAll(key);
    if (values.length > 1) return { ok: false, error: "duplicate_field" };
    if (values.length === 0) return { ok: false, error: "missing_field" };
    got[key] = values[0]!;
  }
  const businessSlug = got.business!.trim();
  if (businessSlug === "" || businessSlug.length > 63) return { ok: false, error: "missing_field" };

  switch (action) {
    case "invite_member": {
      const email = normalizeInviteEmail(got.email!);
      if (!email) return { ok: false, error: "invalid_email" };
      const displayName = got.display_name!.trim();
      if (displayName.length < 1 || displayName.length > 100) return { ok: false, error: "invalid_display_name" };
      const role = got.role!;
      if (!(TEAM_GRANTABLE_ROLES as readonly string[]).includes(role)) return { ok: false, error: "invalid_role" };
      return { ok: true, businessSlug, action: { kind: "invite_member", email, displayName, role: role as (typeof TEAM_GRANTABLE_ROLES)[number] } };
    }
    case "revoke_invitation": {
      const invitationId = got.invitation_id!;
      if (!UUID.test(invitationId)) return { ok: false, error: "invalid_invitation" };
      return { ok: true, businessSlug, action: { kind: "revoke_invitation", invitationId: invitationId.toLowerCase() } };
    }
    case "set_member_role": {
      const userId = got.user_id!;
      if (!UUID.test(userId)) return { ok: false, error: "invalid_member" };
      const role = got.role!;
      if (!(TEAM_GRANTABLE_ROLES as readonly string[]).includes(role)) return { ok: false, error: "invalid_role" };
      return { ok: true, businessSlug, action: { kind: "set_member_role", userId: userId.toLowerCase(), role: role as (typeof TEAM_GRANTABLE_ROLES)[number] } };
    }
    case "set_member_status": {
      const userId = got.user_id!;
      if (!UUID.test(userId)) return { ok: false, error: "invalid_member" };
      const status = got.status!;
      if (!(TEAM_STATUS_TARGETS as readonly string[]).includes(status)) return { ok: false, error: "invalid_status" };
      return { ok: true, businessSlug, action: { kind: "set_member_status", userId: userId.toLowerCase(), status: status as (typeof TEAM_STATUS_TARGETS)[number] } };
    }
  }
}
