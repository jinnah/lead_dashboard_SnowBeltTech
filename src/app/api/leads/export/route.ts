import { NextResponse } from "next/server";
import { canExportLeads } from "@/lib/access";
import { buildLeadCsv } from "@/lib/csv";
import { findAuthorizedBusiness, leadQueryParams, parseLeadQuery } from "@/lib/lead-query";
import { FORMER_MEMBER } from "@/lib/activity-text";
import { fetchLeadExport } from "@/lib/server/lead-search";
import { logEvent, newRequestId } from "@/lib/server/http";
import { getViewer, loadMembers } from "@/lib/server/viewer";

// Customer CSV export. Server-enforced authorization (hiding the button is
// not authorization): only an active BUSINESS_OWNER or BUSINESS_MANAGER of
// the SELECTED active business may export; staff get 403, administrators and
// everyone without customer access get an opaque 404, anonymous gets 401, and
// an unknown or foreign business slug is an opaque 404 (no fallback business,
// no counts, no existence signal). All reads go through the viewer's ordinary
// session client and public.search_leads (SECURITY INVOKER + forced RLS) with
// EXACTLY the same normalized query definition as the dashboard. Nothing
// user-controlled reaches response headers, the filename, or logs.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

function param(searchParams: URLSearchParams, name: string): string | string[] | undefined {
  const all = searchParams.getAll(name);
  return all.length === 0 ? undefined : all.length === 1 ? all[0] : all;
}

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = newRequestId();
  const viewer = await getViewer();
  if (!viewer) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  if (viewer.access.kind !== "customer") {
    logEvent({ requestId, event: "leads_export", status: 404, category: "no_customer_access" });
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  }

  const searchParams = new URL(request.url).searchParams;
  const business = findAuthorizedBusiness(viewer.access.businesses, param(searchParams, "business"));
  if (!business) {
    // Opaque: unknown and foreign business selections are indistinguishable.
    logEvent({ requestId, event: "leads_export", status: 404, category: "business_not_authorized" });
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  }
  if (!canExportLeads(viewer.access, business.id)) {
    logEvent({ requestId, event: "leads_export", status: 403, category: "role_denied" });
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }

  const members = await loadMembers(viewer, business.id);
  const query = parseLeadQuery(
    {
      q: param(searchParams, "q"),
      status: param(searchParams, "status"),
      source: param(searchParams, "source"),
      assignment: param(searchParams, "assignment"),
      sort: param(searchParams, "sort"),
    },
    viewer.userId,
    members.active,
  );

  const result = await fetchLeadExport(viewer.supabase, business.id, query);
  if (!result.ok) {
    if (result.error === "export_too_large") {
      logEvent({ requestId, event: "leads_export", status: 303, category: "export_too_large" });
      const back = leadQueryParams(business, query, { err: "export_too_large" });
      const res = NextResponse.redirect(new URL(`/dashboard?${back}`, request.url), 303);
      res.headers.set("Cache-Control", "private, no-store");
      return res;
    }
    logEvent({ requestId, event: "leads_export", status: 500, category: "failed" });
    return NextResponse.json({ error: "export_failed" }, { status: 500, headers: NO_STORE });
  }

  const csv = buildLeadCsv(result.rows, (id) => (id ? members.names.get(id) ?? FORMER_MEMBER : "Unassigned"));
  // Filename from server-validated data only: the DB-constrained slug
  // (^[a-z0-9](...)$) and the current UTC date. Never from query values.
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  logEvent({ requestId, event: "leads_export", status: 200, category: "ok", rows: result.rows.length });
  return new NextResponse(csv, {
    status: 200,
    headers: {
      ...NO_STORE,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${business.slug}-leads-${date}.csv"`,
    },
  });
}
