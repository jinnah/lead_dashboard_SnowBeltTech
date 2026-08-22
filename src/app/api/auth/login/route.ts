import { NextResponse } from "next/server";
import { isSameSiteRequest } from "@/lib/server/same-site";
import { createServerSupabase } from "@/lib/server/supabase-server";

// Form POST from /login. Signs in with Supabase Auth using the PUBLIC anon key;
// the resulting session is stored only in httpOnly cookies. Failures are
// generic (no account enumeration) and redirect back to the login page.
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
  let email = "";
  let password = "";
  try {
    const form = await request.formData();
    email = String(form.get("email") ?? "").trim().toLowerCase();
    password = String(form.get("password") ?? "");
  } catch {
    return redirectTo(request, "/login?error=1");
  }
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
