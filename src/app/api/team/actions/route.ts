import { NextResponse } from "next/server";
import { canManageTeam } from "@/lib/access";
import { mapAdminRpcError } from "@/lib/admin-actions";
import { findAuthorizedBusiness } from "@/lib/lead-query";
import { parseTeamAction } from "@/lib/team-actions";
import { ACTION_FORM_MAX_BYTES, readBoundedForm } from "@/lib/server/forms";
import { logEvent, newRequestId } from "@/lib/server/http";
import { inviteCustomerMember, revokeCustomerInvitation } from "@/lib/server/invitations";
import { isSameSiteRequest } from "@/lib/server/same-site";
import { getViewer } from "@/lib/server/viewer";

// Customer-owner Team & access actions. Server-enforced authorization at
// every layer (hiding controls is never authorization):
//   anonymous -> 401; platform administrators and everyone without customer
//   access -> opaque 404 (admins keep their own /admin surface and gain no
//   customer-owner controls here); an unknown or FOREIGN business slug ->
//   the same opaque 404 (strict resolution, no fallback business); an
//   authenticated Manager/Staff of the business -> 403. Every mutation then
//   runs under the caller's ordinary session against SECURITY DEFINER RPCs
//   that re-check the owner/administrator authorization, self/owner-target
//   protection and tenant binding inside the database, so browser-supplied
//   membership/invitation UUIDs, roles and emails are untrusted input only.
// Invitations reuse the hardened coordinator (exact provenance marker,
// fail-closed compensation); nothing here logs emails, names, tokens or
// Auth responses.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function POST(request: Request): Promise<NextResponse> {
  const requestId = newRequestId();
  if (!isSameSiteRequest(request.headers)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  if (viewer.access.kind !== "customer") {
    logEvent({ requestId, event: "team_action", status: 404, category: "no_customer_access" });
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  }

  const form = await readBoundedForm(request, ACTION_FORM_MAX_BYTES);
  if (!form.ok) {
    logEvent({ requestId, event: "team_action", status: form.status, category: form.error });
    return NextResponse.json({ error: form.error }, { status: form.status, headers: NO_STORE });
  }
  const parsed = parseTeamAction(form.fields);
  if (!parsed.ok) {
    logEvent({ requestId, event: "team_action", status: 303, category: parsed.error });
    return back(request, `/dashboard/team?err=${parsed.error}`);
  }

  // STRICT business resolution: the slug must exactly match an RLS-authorized
  // business; unknown and foreign selections get one indistinguishable 404.
  const business = findAuthorizedBusiness(viewer.access.businesses, parsed.businessSlug);
  if (!business) {
    logEvent({ requestId, event: "team_action", status: 404, category: "business_not_authorized" });
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  }
  if (!canManageTeam(viewer.access, business.id)) {
    logEvent({ requestId, event: "team_action", status: 403, category: "role_denied" });
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }

  const dest = (q: string) => `/dashboard/team?business=${encodeURIComponent(business.slug)}&${q}`;
  const a = parsed.action;
  switch (a.kind) {
    case "invite_member": {
      const outcome = await inviteCustomerMember(viewer, requestId, business.id, a.email, a.displayName, a.role);
      logEvent({ requestId, event: "team_action", status: 303, category: outcome === "invited" ? "ok" : outcome, action: a.kind });
      return back(request, dest(outcome === "invited" ? "ok=invited" : `err=${outcome}`));
    }
    case "revoke_invitation": {
      const outcome = await revokeCustomerInvitation(viewer, requestId, business.id, a.invitationId);
      logEvent({ requestId, event: "team_action", status: 303, category: outcome, action: a.kind });
      if (outcome === "invitation_revoked") return back(request, dest("ok=invitation_revoked"));
      return back(request, dest(`err=${outcome === "not_found" ? "invalid_invitation" : outcome === "not_operable" ? "not_operable" : "failed"}`));
    }
    case "set_member_role": {
      const r = await viewer.supabase
        .rpc("admin_set_business_member_role", { p_business_id: business.id, p_user_id: a.userId, p_role: a.role })
        .single<{ user_id: string; role: string; changed: boolean }>();
      const outcome = r.error ? mapAdminRpcError(r.error.code, r.error.message, "set_member_role") : "member_role_updated";
      logEvent({ requestId, event: "team_action", status: 303, category: r.error ? outcome : "ok", action: a.kind, sqlstate: r.error?.code ?? null });
      return back(request, dest(r.error ? `err=${outcome}` : "ok=member_role_updated"));
    }
    case "set_member_status": {
      const r = await viewer.supabase
        .rpc("admin_set_business_member_status", { p_business_id: business.id, p_user_id: a.userId, p_status: a.status })
        .single<{ user_id: string; status: string; changed: boolean }>();
      const outcome = r.error ? mapAdminRpcError(r.error.code, r.error.message, "set_member_status") : "member_status_updated";
      logEvent({ requestId, event: "team_action", status: 303, category: r.error ? outcome : "ok", action: a.kind, sqlstate: r.error?.code ?? null });
      return back(request, dest(r.error ? `err=${outcome}` : "ok=member_status_updated"));
    }
  }
}

function back(request: Request, path: string): NextResponse {
  const res = NextResponse.redirect(new URL(path, request.url), 303);
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}
