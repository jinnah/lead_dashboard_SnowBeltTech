// Presentation helpers (pure). Dates render in the business's IANA timezone.
export function formatDateTime(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }).format(d) + " UTC";
  }
}

export const STATUS_LABELS: Record<string, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  scheduled: "Scheduled",
  won: "Won",
  lost: "Lost",
  spam: "Spam",
};

export const SOURCE_LABELS: Record<string, string> = {
  website_form: "Website",
  voice_call: "Voice call",
  manual: "Manual",
  import: "Import",
};

export const URGENCY_LABELS: Record<string, string> = {
  normal: "Normal",
  urgent: "Urgent",
  emergency: "Emergency",
};

export const BUSINESS_STATUS_LABELS: Record<string, string> = {
  active: "Active",
  suspended: "Suspended",
  archived: "Archived",
};

export function label(map: Record<string, string>, value: string | null | undefined): string {
  if (!value) return "—";
  return map[value] ?? value;
}

export function displayOrDash(value: string | null | undefined): string {
  return value && value.trim() !== "" ? value : "—";
}
