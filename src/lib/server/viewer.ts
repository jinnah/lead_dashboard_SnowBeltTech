import "server-only";
import { resolveAccess, type Access, type BusinessRow, type ProfileRow } from "@/lib/access";
import { createServerSupabase } from "./supabase-server";

export interface Viewer {
  userId: string;
  email: string | null;
  profile: ProfileRow;
  access: Access;
  supabase: Awaited<ReturnType<typeof createServerSupabase>>;
}

/**
 * Server-side identity + effective access, re-derived on EVERY protected request:
 *  1. auth.getUser() validates the session with the Auth server (not a local JWT read).
 *  2. The user's own profiles row (RLS self policy) supplies is_active / platform_role.
 *  3. Visible businesses come from RLS (active membership + active business, or platform admin).
 * Deactivated profile, inactive membership, suspended/archived business => no access, immediately.
 */
export async function getViewer(): Promise<Viewer | null> {
  const supabase = await createServerSupabase();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, display_name, platform_role, is_active")
    .eq("id", user.id)
    .maybeSingle<ProfileRow>();

  const { data: businesses } = await supabase
    .from("businesses")
    .select("id, name, slug, timezone, status")
    .order("name", { ascending: true })
    .returns<BusinessRow[]>();

  const access = resolveAccess(profile ?? null, businesses ?? []);
  if (!profile) return null;
  return { userId: user.id, email: user.email ?? null, profile, access, supabase };
}
