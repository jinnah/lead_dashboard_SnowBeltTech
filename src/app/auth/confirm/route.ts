import { NextResponse } from "next/server";
import { parseAuthConfirmCallback } from "@/lib/auth-callback";
import { logEvent, newRequestId } from "@/lib/server/http";
import { createServerSupabase } from "@/lib/server/supabase-server";

// Email confirmation callback (from the local invite/recovery templates):
//   GET /auth/confirm?token_hash=<hash>&type=invite
//   GET /auth/confirm?token_hash=<hash>&type=recovery
// The token is verified with Supabase Auth under the ORDINARY public client
// (the session lands in httpOnly cookies) and STRICTLY as the type named in
// the allow-listed `type` parameter — an invite token can never enter the
// recovery path and a recovery token can never enter invitation acceptance,
// because GoTrue's verification is type-specific. Only these two types are
// supported; duplicated or unexpected query parameters are rejected; there is
// no browser-controlled redirect target; the token is never logged, stored or
// reflected; the service-role key is never involved.
//
// type=invite additionally accepts the invitation inside the database
// (accept_customer_invitation, bound to the now-authenticated user).
// type=recovery touches NO application table, RPC or ledger: a valid token
// only yields the ordinary session that /account/reset-password requires.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function redirectTo(request: Request, path: string): NextResponse {
  const res = NextResponse.redirect(new URL(path, request.url), 303);
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = newRequestId();
  const url = new URL(request.url);
  const parsed = parseAuthConfirmCallback(url.searchParams);
  if (!parsed.ok) {
    logEvent({ requestId, event: parsed.errorTarget === "recovery" ? "recovery_confirm" : "invite_confirm", status: 303, category: "bad_callback" });
    return redirectTo(request, `/login?error=${parsed.errorTarget}`);
  }

  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.verifyOtp({ type: parsed.type, token_hash: parsed.tokenHash });

  if (parsed.type === "recovery") {
    if (error) {
      // Opaque: expired, replayed, forged and wrong-type tokens all end here.
      logEvent({ requestId, event: "recovery_confirm", status: 303, category: "verify_rejected" });
      return redirectTo(request, "/login?error=recovery");
    }
    logEvent({ requestId, event: "recovery_confirm", status: 303, category: "ok" });
    return redirectTo(request, "/account/reset-password");
  }

  if (error) {
    logEvent({ requestId, event: "invite_confirm", status: 303, category: "verify_rejected" });
    return redirectTo(request, "/login?error=invite");
  }

  const accepted = await supabase.rpc("accept_customer_invitation").single<{ business_id: string; replayed: boolean }>();
  if (accepted.error || !accepted.data) {
    // Opaque: revoked/expired/mismatched invitations all end here with no state change.
    logEvent({ requestId, event: "invite_confirm", status: 303, category: "not_accepted", sqlstate: accepted.error?.code ?? null });
    await supabase.auth.signOut({ scope: "local" });
    return redirectTo(request, "/login?error=invite");
  }
  logEvent({ requestId, event: "invite_confirm", status: 303, category: "ok", replayed: accepted.data.replayed });
  return redirectTo(request, "/account/setup");
}
