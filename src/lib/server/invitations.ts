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
//   Auth failure                 ->  mark failed; the RPC positively identifies
//                                    the Auth account this attempt created (or
//                                    NULL) and that exact account is deleted,
//                                    so the email is immediately reinvitable
//   finalize failure             ->  revoke first, then delete the exact Auth
//                                    user id returned by THIS invite call —
//                                    attempted even when revocation itself
//                                    fails (email re-verified before deletion)
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

  const invited = await inviteAuthUser(email, getAppBaseUrl(), invitationId);
  if (!invited.ok) {
    // Mark failed FIRST (acceptance becomes impossible), then remove the Auth
    // account this attempt created, if the database positively identified one.
    const failed = await supabase
      .rpc("admin_mark_customer_invitation_failed", { p_invitation_id: invitationId })
      .single<{ invitation_id: string; status: string; cleanup_auth_user_id: string | null }>();
    let cleaned: boolean | null = null;
    if (!failed.error && failed.data?.cleanup_auth_user_id) {
      cleaned = await deleteUnacceptedAuthUser(failed.data.cleanup_auth_user_id, email);
    }
    logEvent({ requestId, event: "invite_member", step: "auth_invite", category: invited.category, compensated: !failed.error, cleaned });
    return invited.category === "email_exists" ? "email_in_use" : "invite_delivery_failed";
  }

  const sent = await supabase
    .rpc("admin_mark_customer_invitation_sent", { p_invitation_id: invitationId, p_auth_user_id: invited.userId })
    .single<{ invitation_id: string; status: string }>();
  if (sent.error || !sent.data) {
    // Fail closed: kill the invitation FIRST, then remove the exact Auth account
    // THIS call created. Cleanup runs even when the revocation response itself
    // fails or is ambiguous — the deleter re-verifies the normalized email, and
    // if mark-sent actually committed, deleting the account still fails closed:
    // the delivered link becomes unusable, no profile or membership can appear,
    // and the stranded sent invitation stays revocable by the administrator.
    const revoked = await supabase.rpc("admin_revoke_customer_invitation", { p_business_id: businessId, p_invitation_id: invitationId }).single();
    const cleaned = await deleteUnacceptedAuthUser(invited.userId, email);
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
