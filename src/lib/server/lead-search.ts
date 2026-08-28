import "server-only";
import { EXPORT_BATCH_SIZE, EXPORT_MAX_ROWS, PAGE_SIZE, searchLeadArgs, type LeadQuery } from "@/lib/lead-query";
import type { createServerSupabase } from "./supabase-server";

// Executes the shared lead query through public.search_leads under the
// viewer's ORDINARY session client (SECURITY INVOKER + forced RLS: a foreign
// business id yields zero rows). Used by the dashboard page and the CSV
// export so both read through exactly one query definition.

export interface LeadSearchRow {
  id: string;
  lead_number: string;
  contact_name: string;
  phone_e164: string | null;
  email: string | null;
  requested_service: string | null;
  source: string;
  status: string;
  urgency: string;
  review_recommended: boolean;
  created_at: string;
  follow_up_at: string | null;
  assigned_to: string | null;
  total_count: number;
}

type Supabase = Awaited<ReturnType<typeof createServerSupabase>>;

async function runSearch(
  supabase: Supabase,
  businessId: string,
  query: LeadQuery,
  paging: { limit: number; offset?: number; cursor?: { created_at: string; id: string } },
): Promise<LeadSearchRow[] | null> {
  const { data, error } = await supabase.rpc("search_leads", {
    ...searchLeadArgs(businessId, query),
    p_limit: paging.limit,
    p_offset: paging.offset ?? 0,
    p_cursor_created: paging.cursor?.created_at ?? null,
    p_cursor_id: paging.cursor?.id ?? null,
  });
  return error ? null : ((data ?? []) as LeadSearchRow[]);
}

export interface LeadPage {
  rows: LeadSearchRow[];
  total: number;
  /** The page actually shown (an out-of-range request falls back to page 1). */
  page: number;
}

/** One dashboard page (PAGE_SIZE rows) plus the exact filtered total. */
export async function fetchLeadPage(supabase: Supabase, businessId: string, query: LeadQuery, page: number): Promise<LeadPage> {
  let rows = await runSearch(supabase, businessId, query, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  if (rows === null) return { rows: [], total: 0, page: 1 };
  if (rows.length === 0 && page > 1) {
    // Out-of-range page parameter: fall back safely to the first page.
    rows = (await runSearch(supabase, businessId, query, { limit: PAGE_SIZE, offset: 0 })) ?? [];
    page = 1;
  }
  return { rows, total: rows[0]?.total_count ?? 0, page };
}

export type LeadExport = { ok: true; rows: LeadSearchRow[] } | { ok: false; error: "export_too_large" | "export_failed" };

/**
 * Every matching row for the CSV export, fetched in stable keyset batches
 * (cursor on the deterministic created_at+id order, so concurrent inserts can
 * never duplicate or skip rows mid-export). Refuses - without truncating -
 * when the match count exceeds EXPORT_MAX_ROWS, including the pathological
 * case where concurrent inserts push past the limit between batches.
 */
export async function fetchLeadExport(supabase: Supabase, businessId: string, query: LeadQuery): Promise<LeadExport> {
  const first = await runSearch(supabase, businessId, query, { limit: EXPORT_BATCH_SIZE });
  if (first === null) return { ok: false, error: "export_failed" };
  if ((first[0]?.total_count ?? 0) > EXPORT_MAX_ROWS) return { ok: false, error: "export_too_large" };
  const rows = [...first];
  let batch = first;
  while (batch.length === EXPORT_BATCH_SIZE) {
    const last = batch[batch.length - 1]!;
    const next = await runSearch(supabase, businessId, query, { limit: EXPORT_BATCH_SIZE, cursor: { created_at: last.created_at, id: last.id } });
    if (next === null) return { ok: false, error: "export_failed" };
    rows.push(...next);
    if (rows.length > EXPORT_MAX_ROWS) return { ok: false, error: "export_too_large" };
    batch = next;
  }
  return { ok: true, rows };
}
