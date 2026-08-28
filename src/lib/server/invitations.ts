import "server-only";
import { mapAdminRpcError, type AdminResultError } from "@/lib/admin-actions";
import { getAppBaseUrl } from "./env";
import { logEvent } from "./http";
import { deleteUnacceptedAuthUser, inviteAuthUser } from "./supabase-auth-admin";
import type { Viewer } from "./viewer";

// Invitation coordinator: the ONLY place where the application database
// invitation lifecycle and Supabase Auth Admin are combined. The two systems
// cannot share one transaction, so every step fails CLOSED:
//   prepare (admin session RPC)  ->  Auth invite (service key, email out)
//     -> mark sent (admin session RPC)
//   Auth failure                 ->  mark failed (no usable invitation remains)
//   finalize failure             ->  revoke first, then delete the new
//                                    still-unaccepted Auth account
// Nothing here logs or returns emails, names, tokens, links or Auth errors.

export type InviteOutcome = "invited" | "invite_delivery_failed" | AdminResultError;
export type RevokeOutcome = "invitation_revoked" | "not_found" | "not_operable" | "failed";

export async function inviteCustomerMember(
  viewer: Viewer,
  requestId: string,
  businessId: string,
  email: string,
  displayName: string,
  role: string,
): Promise<InviteOutcome> {
  if (viewer.access.kind !== "admin") return "failed"; // routes re-check; defense in depth
  const { supabase } = viewer;

  const prepared = await supabase
    .rpc("admin_prepare_customer_invitation", { p_business_id: businessId, p_email: email, p_display_name: displayName, p_role: role })
    .single<{ invitation_id: string }>();
  if (prepared.error || !prepared.data) {
    const outcome = mapAdminRpcError(prepared.error?.code, prepared.error?.message, "invite_member");
    logEvent({ requestId, event: "invite_member", step: "prepare", category: outcome, sqlstate: prepared.error?.code ?? null });
    return outcome;
  }
  const invitationId = prepared.data.invitation_id;

  const invited = await inviteAuthUser(email, getAppBaseUrl());
  if (!invited.ok) {
    const failed = await supabase.rpc("admin_mark_customer_invitation_failed", { p_invitation_id: invitationId }).single();
    logEvent({ requestId, event: "invite_member", step: "auth_invite", category: invited.category, compensated: !failed.error });
    return invited.category === "email_exists" ? "email_in_use" : "invite_delivery_failed";
  }

  const sent = await supabase
    .rpc("admin_mark_customer_invitation_sent", { p_invitation_id: invitationId, p_auth_user_id: invited.userId })
    .single<{ invitation_id: string; status: string }>();
  if (sent.error || !sent.data) {
    // Fail closed: kill the invitation FIRST, then remove the Auth account this
    // call just created (still unaccepted; email re-verified inside the deleter).
    const revoked = await supabase.rpc("admin_revoke_customer_invitation", { p_business_id: businessId, p_invitation_id: invitationId }).single();
    const cleaned = revoked.error ? false : await deleteUnacceptedAuthUser(invited.userId, email);
    logEvent({ requestId, event: "invite_member", step: "finalize", category: "failed", sqlstate: sent.error?.code ?? null, revoked: !revoked.error, cleaned });
    return "failed";
  }

  logEvent({ requestId, event: "invite_member", category: "ok" });
  return "invited";
}

export async function revokeCustomerInvitation(
  viewer: Viewer,
  requestId: string,
  businessId: string,
  invitationId: string,
): Promise<RevokeOutcome> {
  if (viewer.access.kind !== "admin") return "failed";
  const { supabase } = viewer;

  // 1. Database revocation first: from this moment acceptance is impossible,
  //    regardless of what happens to the Auth account below.
  const revoked = await supabase
    .rpc("admin_revoke_customer_invitation", { p_business_id: businessId, p_invitation_id: invitationId })
    .single<{ auth_user_id: string | null; changed: boolean }>();
  if (revoked.error || !revoked.data) {
    const outcome: RevokeOutcome = revoked.error?.code === "P0002" ? "not_found" : revoked.error?.code === "55000" ? "not_operable" : "failed";
    logEvent({ requestId, event: "revoke_invitation", category: outcome, sqlstate: revoked.error?.code ?? null });
    return outcome;
  }

  // 2. Best-effort cleanup of the still-unaccepted Auth account. The invitation
  //    email is read back through the admin's OWN session (RLS: admins only).
  let cleaned: boolean | null = null;
  if (revoked.data.changed && revoked.data.auth_user_id) {
    const inv = await supabase.from("customer_invitations").select("email").eq("id", invitationId).maybeSingle<{ email: string }>();
    cleaned = inv.data ? await deleteUnacceptedAuthUser(revoked.data.auth_user_id, inv.data.email) : false;
  }
  logEvent({ requestId, event: "revoke_invitation", category: "ok", changed: revoked.data.changed, cleaned });
  return "invitation_revoked";
}
