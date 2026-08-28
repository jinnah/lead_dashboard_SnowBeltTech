import { NextResponse } from "next/server";
import { mapAdminRpcError, parseAdminAction, type AdminOk, type AdminResultError } from "@/lib/admin-actions";
import { opaque, readAdminRequest, redirectTo } from "@/lib/server/admin-request";
import { logEvent, newRequestId } from "@/lib/server/http";
import { inviteCustomerMember, revokeCustomerInvitation } from "@/lib/server/invitations";

// Per-business administrator operations: business lifecycle, integration
// sources, customer invitations and membership management. The business id
// comes from the URL only and is passed to reviewed RPCs that re-check the
// administrator role and every state transition inside the database. The
// invitation actions additionally coordinate the server-only Auth Admin
// boundary through src/lib/server/invitations.ts — never from here directly.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT = "admin_business_action";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const requestId = newRequestId();
  const { id } = await ctx.params;
  if (!UUID.test(id)) return opaque(404, "not_found");
  const r = await readAdminRequest(request, requestId, EVENT);
  if (!r.ok) return r.response;
  const page = `/admin/businesses/${id.toLowerCase()}`;

  const parsed = parseAdminAction(r.fields, "business");
  if (!parsed.ok) {
    logEvent({ requestId, event: EVENT, status: 303, category: parsed.error });
    return redirectTo(request, page, { err: parsed.error });
  }
  const a = parsed.action;
  if (a.kind === "create_business") return redirectTo(request, page, { err: "unsupported_action" }); // business scope only
  const { supabase } = r.viewer;

  // Invitation actions coordinate the database AND Supabase Auth (fail closed).
  if (a.kind === "invite_member") {
    const outcome = await inviteCustomerMember(r.viewer, requestId, id, a.email, a.displayName, a.role);
    return redirectTo(request, page, outcome === "invited" ? { ok: "invited" } : { err: outcome });
  }
  if (a.kind === "revoke_invitation") {
    const outcome = await revokeCustomerInvitation(r.viewer, requestId, id, a.invitationId);
    return redirectTo(request, page, outcome === "invitation_revoked" ? { ok: "invitation_revoked" } : { err: outcome });
  }

  const call =
    a.kind === "set_business_status"
      ? supabase.rpc("admin_set_business_status", { p_business_id: id, p_status: a.status })
      : a.kind === "create_source"
        ? supabase.rpc("admin_create_integration_source", { p_business_id: id, p_kind: a.sourceKind, p_external_id: a.externalId, p_label: a.label, p_allowed_origin: a.allowedOrigin })
        : a.kind === "set_source_status"
          ? supabase.rpc("admin_set_integration_source_status", { p_business_id: id, p_source_id: a.sourceId, p_status: a.status })
          : a.kind === "set_member_role"
            ? supabase.rpc("admin_set_business_member_role", { p_business_id: id, p_user_id: a.userId, p_role: a.role })
            : supabase.rpc("admin_set_business_member_status", { p_business_id: id, p_user_id: a.userId, p_status: a.status });
  const { data, error } = await call.single<Record<string, unknown>>();
  if (error || !data) {
    const code: AdminResultError = mapAdminRpcError(error?.code, error?.message, a.kind);
    logEvent({ requestId, event: EVENT, action: a.kind, status: 303, category: code, sqlstate: error?.code ?? null });
    return redirectTo(request, page, { err: code });
  }
  const ok: AdminOk =
    a.kind === "set_business_status" ? "business_status_updated"
      : a.kind === "create_source" ? "source_created"
        : a.kind === "set_source_status" ? "source_status_updated"
          : a.kind === "set_member_role" ? "member_role_updated"
            : "member_status_updated";
  logEvent({ requestId, event: EVENT, action: a.kind, status: 303, category: "ok", changed: typeof data.changed === "boolean" ? data.changed : true });
  return redirectTo(request, page, { ok });
}
