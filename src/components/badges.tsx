import { BUSINESS_STATUS_LABELS, SOURCE_LABELS, STATUS_LABELS, URGENCY_LABELS, label } from "@/lib/format";

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge--${status}`}>{label(STATUS_LABELS, status)}</span>;
}

export function SourceBadge({ source }: { source: string }) {
  const cls = source === "voice_call" ? "voice" : source === "website_form" ? "website" : "other";
  return <span className={`badge badge--${cls}`}>{label(SOURCE_LABELS, source)}</span>;
}

export function UrgencyBadge({ urgency }: { urgency: string }) {
  if (urgency === "normal") return <span className="muted">Normal</span>;
  return <span className={`badge badge--${urgency}`}>{label(URGENCY_LABELS, urgency)}</span>;
}

export function BusinessStatusBadge({ status }: { status: string }) {
  return <span className={`badge badge--${status}`}>{label(BUSINESS_STATUS_LABELS, status)}</span>;
}

export function ReviewBadge({ needed }: { needed: boolean }) {
  return needed ? <span className="badge badge--review">Needs review</span> : <span className="muted">—</span>;
}
