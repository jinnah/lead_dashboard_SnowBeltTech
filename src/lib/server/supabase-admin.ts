import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getServerEnv } from "./env";

// Privileged (service_role) client. Server-only: bypasses RLS, so it is used
// exclusively to call reviewed SECURITY DEFINER RPCs, never for ad-hoc queries.
let cached: SupabaseClient | null = null;

export function getAdminClient(): SupabaseClient {
  if (cached) return cached;
  const env = getServerEnv();
  cached = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "x-client-info": "snowbelttech-lead-portal/ingest" } },
  });
  return cached;
}
