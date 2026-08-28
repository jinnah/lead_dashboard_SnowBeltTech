import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { parsePasswordResetRequest } from "@/lib/password-reset";
import { getAppBaseUrl } from "@/lib/server/env";
import { LOGIN_FORM_MAX_BYTES, readBoundedForm } from "@/lib/server/forms";
import { logEvent, newRequestId } from "@/lib/server/http";
import { isSameSiteRequest } from "@/lib/server/same-site";
import { getPublicSupabaseEnv } from "@/lib/supabase/public-env";

// Form POST from /forgot-password. Body is streamed with the same hard 4 KiB
// cap as login (Content-Length advisory, chunked bodies counted). Exactly one
// `email` field is accepted; a browser can never supply a redirect target,
// tenant id or callback — the recovery redirect is built ONLY from the
// validated canonical APP_BASE_URL. The recovery email goes through Supabase
// Auth's ordinary password-recovery API under the PUBLIC anon key (never the
// service-role key or the Auth Admin client) and Supabase's configured
// recovery-email controls are the rate limit — an in-process application
// limiter would not survive multiple processes and is deliberately absent.
// EVERY well-formed request gets the identical generic outcome, so account
// existence, inactive membership, delivery suppression and ordinary Auth
// rejection are indistinguishable to the requester. Nothing here logs the
// email, body, Auth response, token, link, cookies or query.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function redirectTo(request: Request, path: string): NextResponse {
  const res = NextResponse.redirect(new URL(path, request.url), 303);
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}

export async function POST(request: Request): Promise<NextResponse> {
  const requestId = newRequestId();
  if (!isSameSiteRequest(request.headers)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const form = await readBoundedForm(request, LOGIN_FORM_MAX_BYTES);
  if (!form.ok) {
    logEvent({ requestId, event: "password_reset_request", status: form.status, category: form.error });
    return NextResponse.json({ error: form.error }, { status: form.status, headers: { "Cache-Control": "no-store" } });
  }
  const parsed = parsePasswordResetRequest(form.fields);
  if (!parsed.ok) {
    logEvent({ requestId, event: "password_reset_request", status: 303, category: parsed.error });
    return redirectTo(request, `/forgot-password?err=${parsed.error}`);
  }

  // Stateless anon-key client on purpose: an anonymous recovery request must
  // not read or write ANY browser state (the cookie-based SSR client would
  // persist a PKCE code-verifier cookie here; the emailed link is verified by
  // token_hash server-side, so no verifier belongs in the requester's browser).
  const { url, anonKey } = getPublicSupabaseEnv();
  const supabase = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.email, { redirectTo: getAppBaseUrl() });
  // Generic outcome regardless of the Auth result (GoTrue already answers
  // unknown emails positively; a rejection here is delivery/rate-limit only).
  logEvent({ requestId, event: "password_reset_request", status: 303, category: error ? "suppressed" : "accepted" });
  return redirectTo(request, "/forgot-password?ok=sent");
}
