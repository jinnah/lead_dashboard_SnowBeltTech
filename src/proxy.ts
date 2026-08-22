import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getPublicSupabaseEnv } from "@/lib/supabase/public-env";

// Session refresh + coarse gate for page routes (Next 16 "proxy", formerly middleware).
// Defense in depth only: every protected page re-validates identity and access
// server-side. The internal n8n endpoint is excluded by the matcher and is
// additionally short-circuited below, so it never sees sessions or redirects.
const PROTECTED_PREFIXES = ["/dashboard", "/admin"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/api/internal")) return NextResponse.next();

  let response = NextResponse.next({ request });
  const { url, anonKey } = getPublicSupabaseEnv();
  const supabase = createServerClient(url, anonKey, {
    cookieOptions: { httpOnly: true, sameSite: "lax", secure: url.startsWith("https://"), path: "/" },
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
      },
    },
  });

  // Validates with the Auth server and rotates the session cookie when needed.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = "";
    const redirect = NextResponse.redirect(login, 303);
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    redirect.headers.set("Cache-Control", "private, no-store");
    return redirect;
  }

  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  // Everything except the internal n8n endpoint, Next internals and static assets.
  matcher: ["/((?!api/internal|_next/static|_next/image|favicon.ico).*)"],
};
