// RFC 4180-compatible CSV generation for the customer lead export. Pure and
// deliberately conservative: NUL bytes are removed, spreadsheet formula
// prefixes are neutralized BEFORE quoting (including whitespace-prefixed
// variants and "+"-prefixed phone numbers), embedded quotes/commas/line breaks
// are quoted per RFC, and ordinary safe text passes through unchanged.
import { label, SOURCE_LABELS, STATUS_LABELS, URGENCY_LABELS } from "@/lib/format";

/** Fixed export header, in exact column order. Never derived from input. */
export const LEAD_CSV_HEADERS = [
  "Lead Number",
  "Submitted At UTC",
  "Contact Name",
  "Phone",
  "Email",
  "Requested Service",
  "Source",
  "Status",
  "Urgency",
  "Assigned To",
  "Follow Up At UTC",
  "Review Recommended",
] as const;

/** UTF-8 BOM so Excel reliably detects the encoding (covered by tests). */
export const CSV_BOM = "\uFEFF";

/**
 * Encodes ONE cell. Order matters: strip NUL, then neutralize a dangerous
 * first meaningful character (`=`, `+`, `-`, `@` - even behind leading
 * spaces/tabs/CR/LF) with a leading apostrophe, then apply RFC 4180 quoting.
 */
export function csvCell(value: string | null | undefined): string {
  let v = (value ?? "").replace(/\u0000/g, "");
  const meaningful = v.replace(/^\s+/, "");
  if (/^[=+\-@]/.test(meaningful)) v = "'" + v;
  if (/[",\r\n]/.test(v) || /^\s|\s$/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
  return v;
}

export function csvLine(cells: ReadonlyArray<string | null | undefined>): string {
  return cells.map(csvCell).join(",");
}

export interface LeadCsvRow {
  lead_number: string;
  created_at: string;
  contact_name: string;
  phone_e164: string | null;
  email: string | null;
  requested_service: string | null;
  source: string;
  status: string;
  urgency: string;
  assigned_to: string | null;
  follow_up_at: string | null;
  review_recommended: boolean;
}

/** Explicit, unambiguous UTC timestamp (ISO 8601 with Z); empty when absent. */
function utc(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

/**
 * Builds the complete CSV document (BOM + header + rows, CRLF line endings,
 * trailing CRLF). `assigneeName` must resolve ids through RLS-visible,
 * tenant-safe data only (former members get the neutral label upstream).
 */
export function buildLeadCsv(rows: LeadCsvRow[], assigneeName: (id: string | null) => string): string {
  const lines = [csvLine(LEAD_CSV_HEADERS)];
  for (const r of rows) {
    lines.push(
      csvLine([
        r.lead_number,
        utc(r.created_at),
        r.contact_name,
        r.phone_e164,
        r.email,
        r.requested_service,
        label(SOURCE_LABELS, r.source),
        label(STATUS_LABELS, r.status),
        label(URGENCY_LABELS, r.urgency),
        r.assigned_to ? assigneeName(r.assigned_to) : "Unassigned",
        utc(r.follow_up_at),
        r.review_recommended ? "Yes" : "No",
      ]),
    );
  }
  return CSV_BOM + lines.join("\r\n") + "\r\n";
}
