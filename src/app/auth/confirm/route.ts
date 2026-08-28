import { NextResponse } from "next/server";
import { parseInviteCallback } from "@/lib/account-setup";
import { logEvent, newRequestId } from "@/lib/server/http";
import { createServerSupabase } from "@/lib/server/supabase-server";

// Invitation confirmation callback (from the local invite email template):
//   GET /auth/confirm?token_hash=<hash>&type=invite
// Verifies the token with Supabase Auth under the ORDINARY public client (the
// session lands in httpOnly cookies), then accepts the invitation bound to the
// now-authenticated user inside the database, and finally redirects to the
// initial-password page. Only type=invite is supported; there is no
// browser-controlled redirect target; the token is never logged, stored or
// reflected; the service-role key is never involved.
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
  const parsed = parseInviteCallback(url.searchParams.get("token_hash"), url.searchParams.get("type"));
  if (!parsed.ok) {
    logEvent({ requestId, event: "invite_confirm", status: 303, category: "bad_callback" });
    return redirectTo(request, "/login?error=invite");
  }

  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.verifyOtp({ type: "invite", token_hash: parsed.tokenHash });
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
