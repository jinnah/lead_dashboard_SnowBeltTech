// ONE shared definition of the customer lead search/filter/sort/pagination
// query for BOTH the dashboard and the CSV export, so their meaning can never
// drift. Pure parsing only - no I/O, no reflection of raw input anywhere.
import {
  allowlisted,
  LEAD_SOURCES,
  LEAD_STATUSES,
  parseAssignmentFilter,
  type AssignmentFilter,
  type BusinessRow,
  type MemberOption,
} from "@/lib/access";

export const PAGE_SIZE = 50;
export const SEARCH_MAX_LENGTH = 120;
export const EXPORT_MAX_ROWS = 25_000;
export const EXPORT_BATCH_SIZE = 1_000;
export const PAGE_MAX = 99_999;

export const LEAD_SORTS = ["newest", "oldest"] as const;
export type LeadSort = (typeof LEAD_SORTS)[number];

type Param = string | string[] | null | undefined;

/**
 * Normalizes the search text: surrounding whitespace trimmed, internal runs of
 * whitespace collapsed to one space, bounded at SEARCH_MAX_LENGTH. An empty
 * (or duplicated/non-string) value means "no search".
 */
export function normalizeSearch(value: Param): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/\s+/g, " ").trim().slice(0, SEARCH_MAX_LENGTH);
  return collapsed === "" ? null : collapsed;
}

/** Allow-listed sort; anything else (including duplicates) is "newest". */
export function parseSort(value: Param): LeadSort {
  return allowlisted(LEAD_SORTS, typeof value === "string" ? value : null) ?? "newest";
}

/**
 * Page number: a plain positive integer up to PAGE_MAX. Invalid, duplicated,
 * negative, fractional, oversized or nonnumeric values fall back to page 1.
 */
export function parsePage(value: Param): number {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,4}$/.test(value)) return 1;
  const page = Number(value);
  return page >= 1 && page <= PAGE_MAX ? page : 1;
}

export interface LeadQuery {
  q: string | null;
  status: (typeof LEAD_STATUSES)[number] | null;
  source: (typeof LEAD_SOURCES)[number] | null;
  assignment: AssignmentFilter;
  sort: LeadSort;
}

/**
 * Parses the full query from GET parameters. Assignment UUIDs are honoured
 * only when they belong to an RLS-visible active member of the SELECTED
 * business (parseAssignmentFilter); everything else is allow-listed.
 */
export function parseLeadQuery(
  params: { q?: Param; status?: Param; source?: Param; assignment?: Param; sort?: Param },
  viewerId: string,
  members: MemberOption[],
): LeadQuery {
  return {
    q: normalizeSearch(params.q),
    status: allowlisted(LEAD_STATUSES, typeof params.status === "string" ? params.status : null),
    source: allowlisted(LEAD_SOURCES, typeof params.source === "string" ? params.source : null),
    assignment: parseAssignmentFilter(typeof params.assignment === "string" ? params.assignment : null, viewerId, members),
    sort: parseSort(params.sort),
  };
}

/**
 * The parameterized arguments for public.search_leads (paging added by the
 * caller). Values are passed as RPC parameters - never interpolated into
 * PostgREST filter grammar - so user input cannot become query syntax.
 */
export function searchLeadArgs(businessId: string, query: LeadQuery): {
  p_business_id: string;
  p_q: string | null;
  p_status: string | null;
  p_source: string | null;
  p_unassigned: boolean;
  p_assigned_to: string | null;
  p_oldest: boolean;
} {
  const a = query.assignment;
  return {
    p_business_id: businessId,
    p_q: query.q,
    p_status: query.status,
    p_source: query.source,
    p_unassigned: a.kind === "unassigned",
    p_assigned_to: a.kind === "mine" || a.kind === "member" ? a.userId : null,
    p_oldest: query.sort === "oldest",
  };
}

/**
 * Normalized, allow-listed URL parameters for dashboard/pagination/export
 * links. Only validated values ever appear; defaults are omitted so URLs stay
 * canonical. Never carries lead data or raw input.
 */
export function leadQueryParams(
  business: BusinessRow | null,
  query: LeadQuery,
  extra: { page?: number; err?: "export_too_large" } = {},
): string {
  const params = new URLSearchParams();
  if (business) params.set("business", business.slug);
  if (query.q) params.set("q", query.q);
  if (query.status) params.set("status", query.status);
  if (query.source) params.set("source", query.source);
  const a = query.assignment;
  if (a.kind === "mine" || a.kind === "unassigned") params.set("assignment", a.kind);
  else if (a.kind === "member") params.set("assignment", a.userId);
  if (query.sort !== "newest") params.set("sort", query.sort);
  if (extra.page && extra.page > 1) params.set("page", String(extra.page));
  if (extra.err) params.set("err", extra.err);
  return params.toString();
}

/**
 * STRICT business resolution for the export endpoint: a provided slug must
 * match an authorized business exactly (no silent fallback - unknown and
 * foreign selections stay opaque to the caller); only a missing slug selects
 * the default business.
 */
export function findAuthorizedBusiness(businesses: BusinessRow[], requestedSlug: Param): BusinessRow | null {
  if (requestedSlug === null || requestedSlug === undefined) return businesses[0] ?? null;
  if (typeof requestedSlug !== "string") return null;
  return businesses.find((b) => b.slug === requestedSlug) ?? null;
}
