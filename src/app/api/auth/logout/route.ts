import { NextResponse } from "next/server";
import { isSameSiteRequest } from "@/lib/server/same-site";
import { createServerSupabase } from "@/lib/server/supabase-server";

// Explicit POST-only sign-out: revokes the session at the Auth server and
// clears the session cookies, then redirects to the login page.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameSiteRequest(request.headers)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const supabase = await createServerSupabase();
  await supabase.auth.signOut({ scope: "global" });
  const res = NextResponse.redirect(new URL("/login", request.url), 303);
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}
