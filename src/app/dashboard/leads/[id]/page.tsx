import { Fragment } from "react";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ReviewBadge, SourceBadge, StatusBadge, UrgencyBadge } from "@/components/badges";
import { displayOrDash, formatDateTime, label, SOURCE_LABELS } from "@/lib/format";
import { getViewer } from "@/lib/server/viewer";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LeadDetail {
  id: string;
  business_id: string;
  lead_number: string;
  source: string;
  status: string;
  urgency: string;
  contact_name: string;
  email: string | null;
  phone_e164: string | null;
  phone_raw: string | null;
  service_address: string | null;
  requested_service: string | null;
  details: string | null;
  preferred_contact_method: string | null;
  preferred_callback_at: string | null;
  follow_up_at: string | null;
  custom_fields: Record<string, unknown>;
  email_marketing_consent: boolean;
  sms_consent: boolean;
  sms_consent_version: string | null;
  sms_consent_source: string | null;
  sms_consent_at: string | null;
  caller_phone: string | null;
  call_classification: string | null;
  call_summary: string | null;
  review_recommended: boolean;
  review_reason: string | null;
  ended_reason: string | null;
  created_at: string;
}

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  if (viewer.access.kind === "admin") redirect("/admin");
  if (viewer.access.kind !== "customer") redirect("/no-access");

  const { id } = await params;
  if (!UUID.test(id)) notFound();
  // RLS decides visibility; anything not visible (other tenant, nonexistent) is an identical 404.
  const { data: lead } = await viewer.supabase.from("leads").select("*").eq("id", id).is("archived_at", null).maybeSingle<LeadDetail>();
  if (!lead) notFound();
  const business = viewer.access.businesses.find((b) => b.id === lead.business_id);
  if (!business) notFound();
  const tz = business.timezone;
  const custom = Object.entries(lead.custom_fields ?? {}).filter(([, v]) => v !== null && v !== "");

  return (
    <AppShell subtitle="Lead Portal" userLabel={viewer.profile.display_name || viewer.email || "Signed in"} roleLabel="Customer">
      <div className="page-head">
        <div>
          <div className="eyebrow">{business.name}</div>
          <h1>Lead {lead.lead_number}</h1>
          <p className="muted">Received {formatDateTime(lead.created_at, tz)} · <SourceBadge source={lead.source} /></p>
        </div>
        <a className="btn btn--link" href={`/dashboard?business=${encodeURIComponent(business.slug)}`}>← Back to leads</a>
      </div>
      <div className="detail-grid">
        <section className="card" aria-labelledby="contact-h">
          <h2 id="contact-h">Contact</h2>
          <dl className="kv">
            <dt>Name</dt><dd>{displayOrDash(lead.contact_name)}</dd>
            <dt>Phone</dt><dd>{lead.phone_e164 ? <a href={`tel:${lead.phone_e164}`}>{lead.phone_e164}</a> : "—"}{lead.phone_raw && lead.phone_raw !== lead.phone_e164 ? <span className="muted"> (entered: {lead.phone_raw})</span> : null}</dd>
            <dt>Email</dt><dd>{lead.email ? <a href={`mailto:${lead.email}`}>{lead.email}</a> : "—"}</dd>
            <dt>Address</dt><dd>{displayOrDash(lead.service_address)}</dd>
            <dt>Prefers</dt><dd>{displayOrDash(lead.preferred_contact_method)}</dd>
            <dt>Callback</dt><dd>{formatDateTime(lead.preferred_callback_at, tz)}</dd>
          </dl>
        </section>
        <section className="card" aria-labelledby="request-h">
          <h2 id="request-h">Request</h2>
          <dl className="kv">
            <dt>Status</dt><dd><StatusBadge status={lead.status} /></dd>
            <dt>Urgency</dt><dd><UrgencyBadge urgency={lead.urgency} /></dd>
            <dt>Service</dt><dd>{displayOrDash(lead.requested_service)}</dd>
            <dt>Source</dt><dd>{label(SOURCE_LABELS, lead.source)}</dd>
            <dt>Follow-up</dt><dd>{formatDateTime(lead.follow_up_at, tz)}</dd>
            <dt>Review</dt><dd><ReviewBadge needed={lead.review_recommended} />{lead.review_reason ? <div className="muted">{lead.review_reason}</div> : null}</dd>
          </dl>
          {lead.details ? <><h3 style={{ marginTop: "1rem", fontSize: "0.95rem" }}>Details</h3><p className="pre">{lead.details}</p></> : null}
          {custom.length > 0 ? (
            <dl className="kv" style={{ marginTop: "0.75rem" }}>
              {custom.map(([k, v]) => (<Fragment key={k}><dt>{k.replace(/_/g, " ")}</dt><dd>{String(v)}</dd></Fragment>))}
            </dl>
          ) : null}
        </section>
        {lead.source === "voice_call" ? (
          <section className="card" aria-labelledby="voice-h">
            <h2 id="voice-h">Voice call</h2>
            <dl className="kv">
              <dt>Caller ID</dt><dd>{displayOrDash(lead.caller_phone)}</dd>
              <dt>Classification</dt><dd>{displayOrDash(lead.call_classification)}</dd>
              <dt>Ended</dt><dd>{displayOrDash(lead.ended_reason)}</dd>
            </dl>
            {lead.call_summary ? <><h3 style={{ marginTop: "1rem", fontSize: "0.95rem" }}>Summary</h3><p className="pre">{lead.call_summary}</p></> : null}
          </section>
        ) : null}
        <section className="card" aria-labelledby="consent-h">
          <h2 id="consent-h">Consent</h2>
          <dl className="kv">
            <dt>SMS</dt><dd>{lead.sms_consent ? `Granted · ${lead.sms_consent_version ?? ""} · ${label(SOURCE_LABELS, lead.sms_consent_source)} · ${formatDateTime(lead.sms_consent_at, tz)}` : "Not granted"}</dd>
            <dt>Email marketing</dt><dd>{lead.email_marketing_consent ? "Granted" : "Not granted"}</dd>
          </dl>
        </section>
      </div>
    </AppShell>
  );
}
