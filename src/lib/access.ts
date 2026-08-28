// Pure access derivation from RLS-authorized rows. No I/O, no secrets.
// Authority comes only from database rows the authenticated user could read:
//  - their own profiles row (system-managed platform_role, is_active)
//  - businesses rows visible through private.active_business_ids() / platform admin
//  - their own business_memberships rows (role per business)
export interface ProfileRow {
  id: string;
  display_name: string;
  platform_role: string | null;
  is_active: boolean;
}

export interface BusinessRow {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  status: string;
}

export interface MembershipRow {
  business_id: string;
  role: string;
  status: string;
}

export type AccessKind = "admin" | "customer" | "none";
export type BusinessRole = "BUSINESS_OWNER" | "BUSINESS_MANAGER" | "BUSINESS_STAFF";

export interface Access {
  kind: AccessKind;
  /** Businesses the user may operate as a customer (active, via active membership). */
  businesses: BusinessRow[];
  /** Active membership role per business id (only for businesses listed above). */
  roles: Record<string, BusinessRole>;
}

const ROLES: readonly BusinessRole[] = ["BUSINESS_OWNER", "BUSINESS_MANAGER", "BUSINESS_STAFF"];

export function resolveAccess(profile: ProfileRow | null, businesses: BusinessRow[], memberships: MembershipRow[] = []): Access {
  if (!profile || profile.is_active !== true) return { kind: "none", businesses: [], roles: {} };
  if (profile.platform_role === "PLATFORM_ADMIN") return { kind: "admin", businesses: [], roles: {} };
  const active = businesses.filter((b) => b.status === "active");
  if (active.length === 0) return { kind: "none", businesses: [], roles: {} };
  const roles: Record<string, BusinessRole> = {};
  for (const m of memberships) {
    if (m.status === "active" && (ROLES as readonly string[]).includes(m.role) && active.some((b) => b.id === m.business_id)) {
      roles[m.business_id] = m.role as BusinessRole;
    }
  }
  return { kind: "customer", businesses: active, roles };
}

/** Role-based capability for ONE business: only an active owner/manager membership in that business may assign. */
export function canAssign(access: Access, businessId: string): boolean {
  const role = access.roles[businessId];
  return access.kind === "customer" && (role === "BUSINESS_OWNER" || role === "BUSINESS_MANAGER");
}

/**
 * Bulk CSV export capability: only an active BUSINESS_OWNER or BUSINESS_MANAGER
 * membership in that business may export. Staff keep full lead visibility and
 * search but no bulk export; platform administrators have none in this batch.
 */
export function canExportLeads(access: Access, businessId: string): boolean {
  return canAssign(access, businessId);
}

/** Chooses the business to display: a requested slug is honoured only if it is in the authorized list. */
export function selectBusiness(businesses: BusinessRow[], requestedSlug: string | null | undefined): BusinessRow | null {
  if (businesses.length === 0) return null;
  if (requestedSlug) {
    const match = businesses.find((b) => b.slug === requestedSlug);
    if (match) return match;
  }
  return businesses[0] ?? null;
}

export const LEAD_STATUSES = ["new", "contacted", "qualified", "scheduled", "won", "lost", "spam"] as const;
export const LEAD_SOURCES = ["website_form", "voice_call", "manual", "import"] as const;

export function allowlisted<T extends readonly string[]>(allowed: T, value: string | string[] | null | undefined): T[number] | null {
  if (typeof value !== "string") return null;
  return (allowed as readonly string[]).includes(value) ? (value as T[number]) : null;
}

/** An active member of a business (active membership + active profile), as visible through RLS. */
export interface MemberOption {
  user_id: string;
  display_name: string;
  role: string;
}

export type AssignmentFilter = { kind: "all" } | { kind: "mine"; userId: string } | { kind: "unassigned" } | { kind: "member"; userId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parses the `assignment` query value. A UUID is honoured only when it is one of the
 * RLS-visible active members of the SELECTED business; anything else falls back to "all".
 */
export function parseAssignmentFilter(value: string | string[] | null | undefined, viewerId: string, members: MemberOption[]): AssignmentFilter {
  if (typeof value !== "string" || value === "" || value === "all") return { kind: "all" };
  if (value === "mine") return { kind: "mine", userId: viewerId };
  if (value === "unassigned") return { kind: "unassigned" };
  if (UUID.test(value) && members.some((m) => m.user_id.toLowerCase() === value.toLowerCase())) {
    return { kind: "member", userId: value.toLowerCase() };
  }
  return { kind: "all" };
}
