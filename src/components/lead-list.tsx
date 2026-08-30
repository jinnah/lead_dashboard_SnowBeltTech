import { displayOrDash, formatDateTime } from "@/lib/format";
import { ReviewBadge, SourceBadge, StatusBadge, UrgencyBadge } from "./badges";

export interface LeadListRow {
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
  assigned_to: string | null;
  /** Only present on the administrator overview. */
  business_name?: string;
}

export function LeadList({
  leads,
  timeZoneFor,
  assigneeName,
  linkBase,
  showBusiness = false,
  emptyText,
  actionLabel,
}: {
  leads: LeadListRow[];
  timeZoneFor: (lead: LeadListRow) => string;
  /** Resolves an assignee id to a display name (RLS-visible data only). */
  assigneeName: (id: string | null) => string;
  linkBase: string | null;
  showBusiness?: boolean;
  emptyText: string;
  /**
   * Visible action phrase (e.g. "View / update") rendered inside the SAME
   * lead link so the primary action is discoverable at the left edge of the
   * table. Omitted on administrator surfaces, which keep the plain link.
   */
  actionLabel?: string;
}) {
  if (leads.length === 0) {
    return (
      <div className="card">
        <div className="empty">{emptyText}</div>
      </div>
    );
  }
  // ONE semantic link per lead cell: number + action phrase, named for the
  // specific lead so assistive tech announces exactly what it opens.
  const num = (l: LeadListRow) =>
    linkBase ? (
      actionLabel ? (
        <a className="lead-open" href={`${linkBase}/${l.id}`} aria-label={`View or update lead ${l.lead_number}`}>
          <strong>{l.lead_number}</strong>
          <span className="lead-open__hint" aria-hidden="true">{actionLabel}</span>
        </a>
      ) : (
        <a href={`${linkBase}/${l.id}`}>{l.lead_number}</a>
      )
    ) : (
      <strong>{l.lead_number}</strong>
    );
  const assignee = (l: LeadListRow) => (l.assigned_to ? assigneeName(l.assigned_to) : <span className="muted">Unassigned</span>);
  return (
    <>
      <div className="table-wrap">
        <table className="leads">
          <thead>
            <tr>
              <th scope="col">Lead</th>
              {showBusiness ? <th scope="col">Business</th> : null}
              <th scope="col">Contact</th>
              <th scope="col">Phone</th>
              <th scope="col">Email</th>
              <th scope="col">Service</th>
              <th scope="col">Source</th>
              <th scope="col">Status</th>
              <th scope="col">Assigned</th>
              <th scope="col">Urgency</th>
              <th scope="col">Received</th>
              <th scope="col">Review</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => (
              <tr key={l.id}>
                <td>{num(l)}</td>
                {showBusiness ? <td>{l.business_name ?? "—"}</td> : null}
                <td>{displayOrDash(l.contact_name)}</td>
                <td>{l.phone_e164 ? <a href={`tel:${l.phone_e164}`}>{l.phone_e164}</a> : "—"}</td>
                <td>{l.email ? <a href={`mailto:${l.email}`}>{l.email}</a> : "—"}</td>
                <td>{displayOrDash(l.requested_service)}</td>
                <td><SourceBadge source={l.source} /></td>
                <td><StatusBadge status={l.status} /></td>
                <td>{assignee(l)}</td>
                <td><UrgencyBadge urgency={l.urgency} /></td>
                <td>{formatDateTime(l.created_at, timeZoneFor(l))}</td>
                <td><ReviewBadge needed={l.review_recommended} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="lead-cards" role="list">
        {leads.map((l) => (
          <article className="lead-card" role="listitem" key={l.id}>
            <div className="lead-card__row">
              <strong>{num(l)}</strong>
              <StatusBadge status={l.status} />
            </div>
            {showBusiness ? <div className="lead-card__row"><span>Business</span><span>{l.business_name ?? "—"}</span></div> : null}
            <div className="lead-card__row"><span>Contact</span><span>{displayOrDash(l.contact_name)}</span></div>
            <div className="lead-card__row"><span>Phone</span><span>{l.phone_e164 ?? "—"}</span></div>
            <div className="lead-card__row"><span>Service</span><span>{displayOrDash(l.requested_service)}</span></div>
            <div className="lead-card__row"><span>Source</span><SourceBadge source={l.source} /></div>
            <div className="lead-card__row"><span>Assigned</span><span>{assignee(l)}</span></div>
            <div className="lead-card__row"><span>Urgency</span><UrgencyBadge urgency={l.urgency} /></div>
            <div className="lead-card__row"><span>Received</span><span>{formatDateTime(l.created_at, timeZoneFor(l))}</span></div>
            {l.review_recommended ? <div className="lead-card__row"><span>Review</span><ReviewBadge needed /></div> : null}
          </article>
        ))}
      </div>
    </>
  );
}
