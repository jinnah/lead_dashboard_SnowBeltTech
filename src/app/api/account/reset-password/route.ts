import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { parseAccountSetup } from "@/lib/account-setup";
import { LOGIN_FORM_MAX_BYTES, readBoundedForm } from "@/lib/server/forms";
import { logEvent, newRequestId } from "@/lib/server/http";
import { isSameSiteRequest } from "@/lib/server/same-site";
import { createServerSupabase } from "@/lib/server/supabase-server";

// Password replacement for the signed-in user (normally a recovery session).
// The SAME parser and policy as the invitation /account/setup path applies
// (parseAccountSetup: exactly one password + confirmation, 12–128 chars).
// Identity is revalidated with the Auth server, the password changes ONLY
// through auth.updateUser under the user's own ordinary session (never the
// service-role key, never Auth Admin, never an application table/RPC/URL/log),
// and afterwards every session is revoked with the strongest ordinary client
// operation (signOut scope "global" — refresh tokens for ALL of the user's
// sessions, the recovery session included). Auth cookies are additionally
// force-expired below so the current browser can never keep operating on a
// half-finished recovery even if the revocation call itself fails. Residual
// limitation (documented, not weakened): an already-issued access JWT stays
// cryptographically valid until its one-hour expiry, but every protected
// surface in this application validates sessions with the Auth server
// (auth.getUser()), which rejects revoked sessions immediately — so revoked
// sessions lose application and database access on their next request.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function back(request: Request, path: string): NextResponse {
  const res = NextResponse.redirect(new URL(path, request.url), 303);
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}

export async function POST(request: Request): Promise<NextResponse> {
  const requestId = newRequestId();
  if (!isSameSiteRequest(request.headers)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: { "Cache-Control": "private, no-store" } });
  }

  const supabase = await createServerSupabase();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "private, no-store" } });
  }

  const form = await readBoundedForm(request, LOGIN_FORM_MAX_BYTES);
  if (!form.ok) {
    logEvent({ requestId, event: "password_reset", status: form.status, category: form.error });
    return NextResponse.json({ error: form.error }, { status: form.status, headers: { "Cache-Control": "private, no-store" } });
  }
  const parsed = parseAccountSetup(form.fields);
  if (!parsed.ok) {
    logEvent({ requestId, event: "password_reset", status: 303, category: parsed.error });
    return back(request, `/account/reset-password?err=${parsed.error}`);
  }

  const { error: updateError } = await supabase.auth.updateUser({ password: parsed.password });
  if (updateError) {
    logEvent({ requestId, event: "password_reset", status: 303, category: "update_rejected" });
    return back(request, "/account/reset-password?err=failed");
  }

  // Revoke every session (recovery session included); fall back to revoking at
  // least the current one, and force-expire the auth cookies regardless.
  let revoked: "global" | "local" | "cookies_only" = "global";
  const signedOut = await supabase.auth.signOut({ scope: "global" });
  if (signedOut.error) {
    revoked = (await supabase.auth.signOut({ scope: "local" })).error ? "cookies_only" : "local";
  }
  const cookieStore = await cookies();
  for (const c of cookieStore.getAll()) {
    if (c.name.startsWith("sb-")) cookieStore.delete(c.name);
  }

  logEvent({ requestId, event: "password_reset", status: 303, category: "ok", revoked });
  return back(request, "/login?notice=password_reset");
}
