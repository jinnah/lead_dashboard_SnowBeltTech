import { notFound, redirect } from "next/navigation";
import { ActivityTimeline, type ActivityRow } from "@/components/activity-timeline";
import { AppShell } from "@/components/app-shell";
import { BusinessStatusBadge } from "@/components/badges";
import { LEAD_DETAIL_COLUMNS, LeadHeader, LeadInfoSections, type LeadDetail } from "@/components/lead-detail-sections";
import type { BusinessRow } from "@/lib/access";
import { getViewer } from "@/lib/server/viewer";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Read-only administrator inspection. Same session/RLS model as /admin; no
// mutation forms; suspended/archived businesses remain inspectable.
export default async function AdminLeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (viewer.access.kind !== "admin") redirect("/");

  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { supabase } = viewer;
  const { data: lead } = await supabase.from("leads").select(LEAD_DETAIL_COLUMNS).eq("id", id).maybeSingle<LeadDetail>();
  if (!lead) notFound();
  const { data: business } = await supabase.from("businesses").select("id, name, slug, timezone, status").eq("id", lead.business_id).maybeSingle<BusinessRow>();
  if (!business) notFound();
  const tz = business.timezone;
  const { data: activities } = await supabase
    .from("lead_activities")
    .select("id, activity_type, old_value, new_value, note, actor_display_name, created_at")
    .eq("lead_id", lead.id)
    .order("created_at", { ascending: false })
    .limit(500)
    .returns<ActivityRow[]>();

  return (
    <AppShell subtitle="Platform administration" userLabel={viewer.profile.display_name || viewer.email || "Administrator"} roleLabel="Platform administrator">
      <div className="page-head">
        <div>
          <div className="eyebrow">{business.name} · <BusinessStatusBadge status={business.status} /></div>
          <LeadHeader lead={lead} tz={tz} />
          <p className="muted">Read-only inspection. Times shown in {tz}.</p>
        </div>
        <a className="btn btn--link" href="/admin">← Back to overview</a>
      </div>
      <div className="detail-grid">
        <LeadInfoSections lead={lead} tz={tz} />
        <section className="card card--wide" aria-labelledby="activity-h">
          <h2 id="activity-h">Activity</h2>
          <ActivityTimeline activities={activities ?? []} timeZone={tz} />
        </section>
      </div>
    </AppShell>
  );
}
