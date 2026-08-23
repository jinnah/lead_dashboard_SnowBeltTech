import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { LeadList, type LeadListRow } from "@/components/lead-list";
import { LEAD_SOURCES, LEAD_STATUSES, allowlisted, parseAssignmentFilter, selectBusiness } from "@/lib/access";
import { SOURCE_LABELS, STATUS_LABELS } from "@/lib/format";
import { getViewer, loadMembers } from "@/lib/server/viewer";
import { FORMER_MEMBER } from "@/lib/activity-text";

export const dynamic = "force-dynamic";

const LEAD_COLUMNS = "id, lead_number, contact_name, phone_e164, email, requested_service, source, status, urgency, review_recommended, created_at, assigned_to";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string; status?: string; source?: string; assignment?: string }>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (viewer.access.kind === "admin") redirect("/admin");
  if (viewer.access.kind !== "customer") redirect("/no-access");

  const params = await searchParams;
  // The slug is only a preference: it must match an RLS-authorized business or it is ignored.
  const business = selectBusiness(viewer.access.businesses, params.business);
  if (!business) redirect("/no-access");
  const status = allowlisted(LEAD_STATUSES, params.status);
  const source = allowlisted(LEAD_SOURCES, params.source);
  const members = await loadMembers(viewer, business.id);
  // A member UUID is honoured only if it is an active member of THIS business (RLS-visible); otherwise "all".
  const assignment = parseAssignmentFilter(params.assignment, viewer.userId, members.active);
  const assignmentValue = assignment.kind === "member" ? assignment.userId : assignment.kind === "all" ? "" : assignment.kind;

  const { supabase } = viewer;
  const base = () => supabase.from("leads").select("id", { count: "exact", head: true }).eq("business_id", business.id).is("archived_at", null);
  const [total, fresh, urgent, review, unassigned] = await Promise.all([
    base(),
    base().eq("status", "new"),
    base().in("urgency", ["urgent", "emergency"]),
    base().eq("review_recommended", true),
    base().is("assigned_to", null),
  ]);

  // All filters are applied in the database query, before the row limit.
  let query = supabase
    .from("leads")
    .select(LEAD_COLUMNS)
    .eq("business_id", business.id)
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(100);
  if (status) query = query.eq("status", status);
  if (source) query = query.eq("source", source);
  if (assignment.kind === "unassigned") query = query.is("assigned_to", null);
  else if (assignment.kind === "mine" || assignment.kind === "member") query = query.eq("assigned_to", assignment.userId);
  const { data: leads } = await query.returns<LeadListRow[]>();

  const others = viewer.access.businesses.filter((b) => b.id !== business.id);
  const filtering = Boolean(status || source || assignment.kind !== "all");
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

      <section className="stats" aria-label="Summary (whole business)">
        <div className="stat"><div className="stat__label">Total leads</div><div className="stat__value">{total.count ?? 0}</div></div>
        <div className="stat"><div className="stat__label">New</div><div className="stat__value">{fresh.count ?? 0}</div></div>
        <div className={`stat${(urgent.count ?? 0) > 0 ? " stat--danger" : ""}`}><div className="stat__label">Urgent / emergency</div><div className="stat__value">{urgent.count ?? 0}</div></div>
        <div className={`stat${(review.count ?? 0) > 0 ? " stat--warn" : ""}`}><div className="stat__label">Needs review</div><div className="stat__value">{review.count ?? 0}</div></div>
        <div className="stat"><div className="stat__label">Unassigned</div><div className="stat__value">{unassigned.count ?? 0}</div></div>
      </section>

      <section aria-labelledby="leads-heading">
        <h2 id="leads-heading">Recent leads</h2>
        <form method="get" className="filters" action="/dashboard">
          {others.length > 0 ? <input type="hidden" name="business" value={business.slug} /> : null}
          <label className="field">
            <span className="field__label">Status</span>
            <select className="field__input" name="status" defaultValue={status ?? ""}>
              <option value="">All statuses</option>
              {LEAD_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Source</span>
            <select className="field__input" name="source" defaultValue={source ?? ""}>
              <option value="">All sources</option>
              {LEAD_SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABELS[s]}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Assignment</span>
            <select className="field__input" name="assignment" defaultValue={assignmentValue}>
              <option value="">All leads</option>
              <option value="mine">My leads</option>
              <option value="unassigned">Unassigned</option>
              {members.active.map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name}</option>)}
            </select>
          </label>
          <button type="submit" className="btn btn--primary">Apply</button>
          {filtering ? <a className="btn btn--link" href={others.length > 0 ? `/dashboard?business=${encodeURIComponent(business.slug)}` : "/dashboard"}>Clear</a> : null}
        </form>
        <LeadList
          leads={leads ?? []}
          timeZoneFor={() => business.timezone}
          assigneeName={(id) => (id ? members.names.get(id) ?? FORMER_MEMBER : "Unassigned")}
          linkBase="/dashboard/leads"
          emptyText={filtering ? "No leads match these filters." : "No leads yet. New website and voice inquiries will appear here."}
        />
      </section>
    </AppShell>
  );
}
