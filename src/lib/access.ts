// Pure access derivation from RLS-authorized rows. No I/O, no secrets.
// Authority comes only from database rows the authenticated user could read:
//  - their own profiles row (system-managed platform_role, is_active)
//  - businesses rows visible through private.active_business_ids() / platform admin
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

export type AccessKind = "admin" | "customer" | "none";

export interface Access {
  kind: AccessKind;
  /** Businesses the user may operate as a customer (active, via active membership). */
  businesses: BusinessRow[];
}

export function resolveAccess(profile: ProfileRow | null, businesses: BusinessRow[]): Access {
  if (!profile || profile.is_active !== true) return { kind: "none", businesses: [] };
  if (profile.platform_role === "PLATFORM_ADMIN") return { kind: "admin", businesses: [] };
  const active = businesses.filter((b) => b.status === "active");
  if (active.length === 0) return { kind: "none", businesses: [] };
  return { kind: "customer", businesses: active };
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
