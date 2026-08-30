import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { LeadList } from "@/components/lead-list";
import { canAssign, canExportLeads, LEAD_SOURCES, LEAD_STATUSES, selectBusiness } from "@/lib/access";
import { leadQueryParams, parseLeadQuery, parsePage, PAGE_SIZE, SEARCH_MAX_LENGTH } from "@/lib/lead-query";
import { SOURCE_LABELS, STATUS_LABELS } from "@/lib/format";
import { fetchLeadPage } from "@/lib/server/lead-search";
import { getViewer, loadMembers } from "@/lib/server/viewer";
import { FORMER_MEMBER } from "@/lib/activity-text";

export const dynamic = "force-dynamic";

const ERR_MESSAGES: Record<string, string> = {
  export_too_large: "There are more than 25,000 matching leads, which is too many for one CSV export. Narrow the search or filters and try again.",
};

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string; status?: string; source?: string; assignment?: string; q?: string; sort?: string; page?: string; err?: string }>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (viewer.access.kind === "admin") redirect("/admin");
  if (viewer.access.kind !== "customer") redirect("/no-access");

  const params = await searchParams;
  // The slug is only a preference: it must match an RLS-authorized business or it is ignored.
  const business = selectBusiness(viewer.access.businesses, params.business);
  if (!business) redirect("/no-access");
  const members = await loadMembers(viewer, business.id);
  // ONE shared query definition with the CSV export (assignment UUIDs honoured
  // only for active members of THIS business; everything else allow-listed).
  const query = parseLeadQuery(params, viewer.userId, members.active);
  const requestedPage = parsePage(params.page);
  const errMsg = params.err && typeof params.err === "string" && params.err in ERR_MESSAGES ? ERR_MESSAGES[params.err] : null;

  const { supabase } = viewer;
  const base = () => supabase.from("leads").select("id", { count: "exact", head: true }).eq("business_id", business.id).is("archived_at", null);
  const [total, fresh, urgent, review, unassigned, pageResult] = await Promise.all([
    base(),
    base().eq("status", "new"),
    base().in("urgency", ["urgent", "emergency"]),
    base().eq("review_recommended", true),
    base().is("assigned_to", null),
    // Search + all filters run in PostgreSQL (search_leads, SECURITY INVOKER
    // under this session's RLS) BEFORE pagination; never paginated in JS.
    fetchLeadPage(supabase, business.id, query, requestedPage),
  ]);
  const { rows: leads, total: matching, page } = pageResult;
  const pageCount = Math.max(1, Math.ceil(matching / PAGE_SIZE));
  const rangeStart = matching === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = (page - 1) * PAGE_SIZE + leads.length;

  const others = viewer.access.businesses.filter((b) => b.id !== business.id);
  const filtering = Boolean(query.q || query.status || query.source || query.assignment.kind !== "all");
  const businessHasLeads = (total.count ?? 0) > 0;
  const hrefFor = (p: number) => `/dashboard?${leadQueryParams(others.length > 0 ? business : null, query, { page: p })}`;
  const assignmentValue = query.assignment.kind === "member" ? query.assignment.userId : query.assignment.kind === "all" ? "" : query.assignment.kind;
  const exportAllowed = canExportLeads(viewer.access, business.id);

  return (
    <AppShell subtitle="Lead Portal" userLabel={viewer.profile.display_name || viewer.email || "Signed in"} roleLabel="Customer">
      <div className="page-head">
        <div>
          <div className="eyebrow">Business workspace</div>
          <h1>{business.name}</h1>
          <p className="muted">Leads received through your website and voice assistant. Times shown in {business.timezone}.</p>
        </div>
        {others.length > 0 ? (
          <nav aria-label="Switch business">
            {others.map((b) => (
              <a key={b.id} className="btn btn--link" href={`/dashboard?business=${encodeURIComponent(b.slug)}`}>
                Switch to {b.name}
              </a>
            ))}
          </nav>
        ) : null}
      </div>

      {errMsg ? (
        <div className="alert alert--error" role="alert">
          {errMsg}
        </div>
      ) : null}

      <section className="stats" aria-label="Summary for the whole business">
        <div className="stat"><div className="stat__label">Total leads</div><div className="stat__value">{total.count ?? 0}</div></div>
        <div className="stat"><div className="stat__label">New</div><div className="stat__value">{fresh.count ?? 0}</div></div>
        <div className={`stat${(urgent.count ?? 0) > 0 ? " stat--danger" : ""}`}><div className="stat__label">Urgent / emergency</div><div className="stat__value">{urgent.count ?? 0}</div></div>
        <div className={`stat${(review.count ?? 0) > 0 ? " stat--warn" : ""}`}><div className="stat__label">Needs review</div><div className="stat__value">{review.count ?? 0}</div></div>
        <div className="stat"><div className="stat__label">Unassigned</div><div className="stat__value">{unassigned.count ?? 0}</div></div>
      </section>
      <p className="muted" style={{ marginTop: "-0.5rem", fontSize: "0.85rem" }}>Summary counts always describe the whole business, not the current search results.</p>

      <section aria-labelledby="leads-heading">
        <h2 id="leads-heading">Leads</h2>
        <form method="get" className="filters" action="/dashboard">
          {others.length > 0 ? <input type="hidden" name="business" value={business.slug} /> : null}
          <label className="field">
            <span className="field__label">Search</span>
            <input
              className="field__input"
              type="search"
              name="q"
              defaultValue={query.q ?? ""}
              maxLength={SEARCH_MAX_LENGTH}
              placeholder="Lead number, name, email, phone, service"
            />
          </label>
          <label className="field">
            <span className="field__label">Filter by status</span>
            <select className="field__input" name="status" defaultValue={query.status ?? ""}>
              <option value="">All statuses</option>
              {LEAD_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Filter by source</span>
            <select className="field__input" name="source" defaultValue={query.source ?? ""}>
              <option value="">All sources</option>
              {LEAD_SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABELS[s]}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Filter by assignment</span>
            <select className="field__input" name="assignment" defaultValue={assignmentValue}>
              <option value="">All leads</option>
              <option value="mine">My leads</option>
              <option value="unassigned">Unassigned</option>
              {members.active.map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Sort</span>
            <select className="field__input" name="sort" defaultValue={query.sort}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
          </label>
          <button type="submit" className="btn btn--primary">Apply</button>
          {filtering || query.sort !== "newest" ? (
            <a className="btn btn--link" href={others.length > 0 ? `/dashboard?business=${encodeURIComponent(business.slug)}` : "/dashboard"}>Clear</a>
          ) : null}
          {exportAllowed ? (
            <a className="btn btn--link" href={`/api/leads/export?${leadQueryParams(business, query)}`}>Export CSV</a>
          ) : null}
        </form>
        <p className="muted">
          {canAssign(viewer.access, business.id)
            ? "The dropdowns above only filter this list. Open a lead to update its status, assignment, follow-up, or notes."
            : "The dropdowns above only filter this list. Open a lead to update its status, follow-up, or notes."}
        </p>
        <p className="muted" aria-live="polite">
          {matching === 0 ? "Showing 0 leads" : `Showing ${rangeStart}–${rangeEnd} of ${matching} matching ${matching === 1 ? "lead" : "leads"}`}
        </p>
        <LeadList
          leads={leads}
          timeZoneFor={() => business.timezone}
          assigneeName={(id) => (id ? members.names.get(id) ?? FORMER_MEMBER : "Unassigned")}
          linkBase="/dashboard/leads"
          actionLabel="View / update"
          emptyText={
            businessHasLeads
              ? "No leads match the current search and filters."
              : "No leads yet. New website and voice inquiries will appear here."
          }
        />
        {pageCount > 1 ? (
          <nav className="filters" aria-label="Pagination" style={{ marginTop: "1rem" }}>
            {page > 1 ? <a className="btn btn--link" href={hrefFor(page - 1)}>Previous</a> : null}
            <span className="muted">{`Page ${page} of ${pageCount}`}</span>
            {page < pageCount ? <a className="btn btn--link" href={hrefFor(page + 1)}>Next</a> : null}
          </nav>
        ) : null}
      </section>
    </AppShell>
  );
}
