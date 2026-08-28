import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getServerEnv } from "./env";

// Dedicated Supabase AUTH ADMIN boundary (service-role key). Server-only and
// deliberately narrow: it exposes exactly the three reviewed Auth Admin
// operations the invitation workflow needs and NOTHING else — no table reads,
// no table writes, no RLS bypass, no RPC calls. Application-database changes
// always go through the signed-in administrator's ordinary session.
// The raw client and the raw Auth responses (which carry user objects) never
// leave this module; results are reduced to ids and allow-listed categories.
let cached: SupabaseClient | null = null;

function authAdmin() {
  if (!cached) {
    const env = getServerEnv();
    cached = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { "x-client-info": "snowbelttech-lead-portal/auth-admin" } },
    });
  }
  return cached.auth.admin;
}

export type AuthInviteResult = { ok: true; userId: string } | { ok: false; category: "email_exists" | "rate_limited" | "failed" };

/** User-metadata key that carries the invitation's own UUID as an exact provenance marker. */
export const INVITATION_MARKER_KEY = "portal_invitation_id";

/**
 * Sends the local invitation email and creates the invited Auth account. The
 * invitation's UUID is persisted on that account under INVITATION_MARKER_KEY,
 * so failed-delivery compensation can identify the account created by this
 * exact attempt with exact equality — never by email/time inference. The
 * marker is provenance-for-deletion only and is never read for authorization.
 */
export async function inviteAuthUser(email: string, redirectTo: string, invitationId: string): Promise<AuthInviteResult> {
  const { data, error } = await authAdmin().inviteUserByEmail(email, { redirectTo, data: { [INVITATION_MARKER_KEY]: invitationId } });
  if (error || !data.user?.id) {
    const status = error && "status" in error ? (error as { status?: number }).status : undefined;
    if (status === 422 || /already.*registered/i.test(error?.message ?? "")) return { ok: false, category: "email_exists" };
    if (status === 429) return { ok: false, category: "rate_limited" };
    return { ok: false, category: "failed" };
  }
  return { ok: true, userId: data.user.id };
}

/** Normalized email of an Auth user, or null. Used only to guard cleanup. */
export async function getAuthUserEmail(userId: string): Promise<string | null> {
  const { data, error } = await authAdmin().getUserById(userId);
  if (error || !data.user) return null;
  return data.user.email?.toLowerCase() ?? null;
}

/**
 * Deletes ONE Auth account as invitation compensation/cleanup. The caller must
 * have already revoked/failed the database invitation, and the expected email
 * is re-checked here so a mistaken id can never delete an unrelated account.
 */
export async function deleteUnacceptedAuthUser(userId: string, expectedEmail: string): Promise<boolean> {
  const actual = await getAuthUserEmail(userId);
  if (actual === null || actual !== expectedEmail.toLowerCase()) return false;
  const { error } = await authAdmin().deleteUser(userId);
  return !error;
}
