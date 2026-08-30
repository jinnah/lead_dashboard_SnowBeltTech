import "server-only";
import { resolveAccess, type Access, type BusinessRow, type MemberOption, type MembershipRow, type ProfileRow } from "@/lib/access";
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
 *  4. The user's own membership rows supply the per-business role (owner/manager/staff).
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

  const { data: memberships } = await supabase
    .from("business_memberships")
    .select("business_id, role, status")
    .eq("user_id", user.id)
    .returns<MembershipRow[]>();

  const access = resolveAccess(profile ?? null, businesses ?? [], memberships ?? []);
  if (!profile) return null;
  return { userId: user.id, email: user.email ?? null, profile, access, supabase };
}

interface MembershipWithProfile {
  user_id: string;
  role: string;
  status: string;
  profiles: { display_name: string; is_active: boolean } | null;
}

export interface TeamMemberRow {
  user_id: string;
  role: string;
  status: string;
  display_name: string;
  profile_active: boolean;
}

/**
 * Every membership of ONE business (active and inactive) through the viewer's
 * RLS session, for the owner-facing Team & access page. Contains no emails -
 * profiles carry display names only; invitation emails come from the
 * invitations table under its own owner-scoped policy.
 */
export async function loadTeam(viewer: Viewer, businessId: string): Promise<TeamMemberRow[]> {
  const { data } = await viewer.supabase
    .from("business_memberships")
    .select("user_id, role, status, profiles(display_name, is_active)")
    .eq("business_id", businessId)
    .returns<MembershipWithProfile[]>();
  const rows = (data ?? []).map((m) => ({
    user_id: m.user_id,
    role: m.role,
    status: m.status,
    display_name: m.profiles?.display_name?.trim() || "Team member",
    profile_active: m.profiles?.is_active === true,
  }));
  rows.sort((a, b) => a.display_name.localeCompare(b.display_name));
  return rows;
}

/**
 * Members of one business as visible through the viewer's RLS session.
 * `active` = assignable (active membership + active profile); `names` maps every
 * visible member id (incl. inactive) to a display name for rendering assignees.
 */
export async function loadMembers(viewer: Viewer, businessId: string): Promise<{ active: MemberOption[]; names: Map<string, string> }> {
  const { data } = await viewer.supabase
    .from("business_memberships")
    .select("user_id, role, status, profiles(display_name, is_active)")
    .eq("business_id", businessId)
    .returns<MembershipWithProfile[]>();
  const rows = data ?? [];
  const names = new Map<string, string>();
  const active: MemberOption[] = [];
  for (const m of rows) {
    const name = m.profiles?.display_name?.trim() || "Team member";
    names.set(m.user_id, name);
    if (m.status === "active" && m.profiles?.is_active === true) active.push({ user_id: m.user_id, display_name: name, role: m.role });
  }
  active.sort((a, b) => a.display_name.localeCompare(b.display_name));
  return { active, names };
}
