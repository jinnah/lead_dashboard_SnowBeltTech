import { NextResponse } from "next/server";
import { LOGIN_FORM_MAX_BYTES, readBoundedForm } from "@/lib/server/forms";
import { isSameSiteRequest } from "@/lib/server/same-site";
import { createServerSupabase } from "@/lib/server/supabase-server";

// Form POST from /login. Body is streamed with a hard 4 KiB cap BEFORE parsing
// (Content-Length advisory, chunked bodies capped). Signs in with Supabase Auth
// using the PUBLIC anon key; the session lives only in httpOnly cookies.
// Failures are generic (no account enumeration) and redirect to the login page.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FIELD = 320;

function redirectTo(request: Request, path: string): NextResponse {
  const res = NextResponse.redirect(new URL(path, request.url), 303);
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameSiteRequest(request.headers)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const form = await readBoundedForm(request, LOGIN_FORM_MAX_BYTES);
  if (!form.ok) {
    if (form.status === 413) return NextResponse.json({ error: "payload_too_large" }, { status: 413, headers: { "Cache-Control": "no-store" } });
    if (form.status === 415) return NextResponse.json({ error: "unsupported_media_type" }, { status: 415, headers: { "Cache-Control": "no-store" } });
    return redirectTo(request, "/login?error=1");
  }
  const email = (form.fields.get("email") ?? "").trim().toLowerCase();
  const password = form.fields.get("password") ?? "";
  if (!email || !password || email.length > MAX_FIELD || password.length > 1024) {
    return redirectTo(request, "/login?error=1");
  }
  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    console.info(JSON.stringify({ ts: new Date().toISOString(), event: "login", outcome: "rejected" }));
    return redirectTo(request, "/login?error=1");
  }
  console.info(JSON.stringify({ ts: new Date().toISOString(), event: "login", outcome: "ok" }));
  return redirectTo(request, "/");
}
