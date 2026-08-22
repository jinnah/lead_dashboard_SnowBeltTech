import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getPublicSupabaseEnv } from "@/lib/supabase/public-env";

// Per-request Supabase client bound to the signed-in user's cookie session.
// Uses ONLY the public anon key: every query runs as `authenticated` under RLS.
// Never used for privileged work (that is src/lib/server/supabase-admin.ts,
// reserved for the internal ingestion path).
export async function createServerSupabase() {
  const { url, anonKey } = getPublicSupabaseEnv();
  const cookieStore = await cookies();
  return createServerClient(url, anonKey, {
    cookieOptions: { httpOnly: true, sameSite: "lax", secure: url.startsWith("https://"), path: "/" },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Server Components cannot set cookies; the proxy refreshes sessions there.
        }
      },
    },
  });
}
