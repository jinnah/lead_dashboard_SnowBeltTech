import { randomUUID } from "node:crypto";
import { notFound, redirect } from "next/navigation";
import { ActivityTimeline, type ActivityRow } from "@/components/activity-timeline";
import { AppShell } from "@/components/app-shell";
import { LEAD_DETAIL_COLUMNS, LeadHeader, LeadInfoSections, type LeadDetail } from "@/components/lead-detail-sections";
import { StatusForm } from "@/components/status-form";
import { LEAD_STATUSES } from "@/lib/access";
import { STATUS_LABELS, formatDateTime } from "@/lib/format";
import { ACTIONS, ERROR_MESSAGES, OK_MESSAGES, type ActionName } from "@/lib/lead-actions";
import { getViewer } from "@/lib/server/viewer";
import { utcToLocalParts } from "@/lib/timezone";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function LeadDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (viewer.access.kind === "admin") redirect("/admin");
  if (viewer.access.kind !== "customer") redirect("/no-access");

  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { supabase } = viewer;
  // RLS decides visibility; anything not visible (other tenant, nonexistent) is an identical 404.
  const { data: lead } = await supabase.from("leads").select(LEAD_DETAIL_COLUMNS).eq("id", id).is("archived_at", null).maybeSingle<LeadDetail>();
  if (!lead) notFound();
  const business = viewer.access.businesses.find((b) => b.id === lead.business_id);
  if (!business) notFound();
  const tz = business.timezone;

  const { data: activities } = await supabase
    .from("lead_activities")
    .select("id, activity_type, old_value, new_value, note, actor_display_name, created_at")
    .eq("lead_id", lead.id)
    .order("created_at", { ascending: false })
    .limit(200)
    .returns<ActivityRow[]>();

  // Feedback codes are allow-listed; submitted values never travel through the URL.
  const sp = await searchParams;
  const okMsg = sp.ok && (ACTIONS as readonly string[]).includes(sp.ok) ? OK_MESSAGES[sp.ok as ActionName] : null;
  const errMsg = sp.err && sp.err in ERROR_MESSAGES ? ERROR_MESSAGES[sp.err as keyof typeof ERROR_MESSAGES] : null;

  const actionUrl = `/api/leads/${lead.id}/actions`;
  const followUp = lead.follow_up_at ? utcToLocalParts(lead.follow_up_at, tz) : null;
  const noteRequestId = randomUUID(); // unique per render: resubmitting the same form is idempotent

  return (
    <AppShell subtitle="Lead Portal" userLabel={viewer.profile.display_name || viewer.email || "Signed in"} roleLabel="Customer">
      <div className="page-head">
        <div>
          <div className="eyebrow">{business.name}</div>
          <LeadHeader lead={lead} tz={tz} />
        </div>
        <a className="btn btn--link" href={`/dashboard?business=${encodeURIComponent(business.slug)}`}>← Back to leads</a>
      </div>

      {okMsg ? <div className="alert alert--success" role="status">{okMsg}</div> : null}
      {errMsg ? <div className="alert alert--error" role="alert">{errMsg}</div> : null}

      <section className="card actions" aria-labelledby="actions-h">
        <h2 id="actions-h">Work this lead</h2>
        <div className="actions__grid">
          <StatusForm action={actionUrl} current={lead.status} options={LEAD_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] ?? s }))} />
          <form method="post" action={actionUrl} className="inline-form">
            <input type="hidden" name="action" value="set_follow_up" />
            <label className="field">
              <span className="field__label">Follow-up date</span>
              <input className="field__input" type="date" name="date" required defaultValue={followUp?.date ?? ""} />
            </label>
            <label className="field">
              <span className="field__label">Time ({tz})</span>
              <input className="field__input" type="time" name="time" required defaultValue={followUp?.time ?? "09:00"} />
            </label>
            <button type="submit" className="btn btn--primary">{lead.follow_up_at ? "Reschedule" : "Schedule follow-up"}</button>
          </form>
          {lead.follow_up_at ? (
            <form method="post" action={actionUrl} className="inline-form inline-form--end">
              <input type="hidden" name="action" value="clear_follow_up" />
              <p className="muted">Current follow-up: {formatDateTime(lead.follow_up_at, tz)}</p>
              <button type="submit" className="btn btn--secondary">Clear follow-up</button>
            </form>
          ) : null}
        </div>
      </section>

      <div className="detail-grid">
        <LeadInfoSections lead={lead} tz={tz} />
        <section className="card card--wide" aria-labelledby="activity-h">
          <h2 id="activity-h">Notes &amp; activity</h2>
          <form method="post" action={actionUrl} className="note-form">
            <input type="hidden" name="action" value="add_note" />
            <input type="hidden" name="request_id" value={noteRequestId} />
            <label className="field">
              <span className="field__label">Add a note</span>
              <textarea className="field__input" name="note" rows={3} maxLength={2000} required placeholder="What happened? (plain text, up to 2,000 characters)" />
            </label>
            <button type="submit" className="btn btn--primary">Add note</button>
          </form>
          <ActivityTimeline activities={activities ?? []} timeZone={tz} />
        </section>
      </div>
    </AppShell>
  );
}
