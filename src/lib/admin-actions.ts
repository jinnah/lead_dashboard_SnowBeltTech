// Pure parsing of the platform-administrator operation forms (no I/O, no secrets).
// Mirrors the database contract of the admin_* RPCs; the database re-validates
// everything and is the authority. Field cardinality is explicit: every field
// must appear exactly once (optional fields at most once) — missing or
// duplicated fields are errors, never guesses.

export const PLATFORM_ACTIONS = ["create_business"] as const;
export const BUSINESS_ACTIONS = ["set_business_status", "create_source", "set_source_status"] as const;
export type PlatformAction = (typeof PLATFORM_ACTIONS)[number];
export type BusinessAction = (typeof BUSINESS_ACTIONS)[number];
export type AdminActionName = PlatformAction | BusinessAction;

/** Fields per action: required ones exactly once, optional ones at most once. Anything else is rejected. */
export const ADMIN_ACTION_FIELDS: Record<AdminActionName, { required: readonly string[]; optional: readonly string[] }> = {
  create_business: { required: ["action", "name", "slug", "industry", "timezone"], optional: [] },
  set_business_status: { required: ["action", "status"], optional: [] },
  create_source: { required: ["action", "kind", "external_id"], optional: ["label", "allowed_origin"] },
  set_source_status: { required: ["action", "source_id", "status"], optional: [] },
};

export const INDUSTRIES = [
  "hvac", "plumbing", "roofing", "landscaping", "cleaning", "auto_repair",
  "property_maintenance", "electrical", "technology_services", "other",
] as const;
export const INDUSTRY_LABELS: Record<(typeof INDUSTRIES)[number], string> = {
  hvac: "HVAC", plumbing: "Plumbing", roofing: "Roofing", landscaping: "Landscaping", cleaning: "Cleaning",
  auto_repair: "Auto repair", property_maintenance: "Property maintenance", electrical: "Electrical",
  technology_services: "Technology services", other: "Other",
};

/** Only kinds the ingestion endpoint accepts today (twilio_number is deliberately absent). */
export const REGISTRABLE_SOURCE_KINDS = ["website_form", "vapi_assistant", "vapi_phone_number"] as const;
export const SOURCE_KIND_LABELS: Record<(typeof REGISTRABLE_SOURCE_KINDS)[number], string> = {
  website_form: "Website form", vapi_assistant: "Vapi assistant", vapi_phone_number: "Vapi phone number",
};

export const BUSINESS_STATUS_TARGETS = ["active", "suspended"] as const;
export const SOURCE_STATUS_TARGETS = ["active", "inactive"] as const;

export const NAME_MAX = 200;
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const EXTERNAL_ID_MAX = 255;
export const LABEL_MAX = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TZ_FORMAT = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?";
const ORIGIN_RE = new RegExp(`^https://${HOST_LABEL}(?:\\.${HOST_LABEL})*(?::([1-9][0-9]{0,4}))?$`);

/**
 * A real IANA zone known to this runtime, in Area/Location form (or UTC). Uses
 * Intl.DateTimeFormat resolution (link names such as Asia/Kolkata count) rather
 * than Intl.supportedValuesOf, which lists only CLDR-canonical ids. The database
 * is the authority (pg_timezone_names, exact case).
 */
export function isSupportedTimeZone(value: string): boolean {
  if (value === "UTC") return true;
  if (!TZ_FORMAT.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Canonical HTTPS origin: lowercase host, optional non-default port, nothing else. */
export function isCanonicalHttpsOrigin(value: string): boolean {
  const m = ORIGIN_RE.exec(value);
  if (!m) return false;
  const port = m[1];
  if (port !== undefined && (port === "443" || Number(port) > 65535)) return false;
  return value.length <= 253 + 8 + 6;
}

export function isValidExternalId(value: string): boolean {
  return value.length >= 1 && value.length <= EXTERNAL_ID_MAX && value === value.trim() && !CONTROL.test(value);
}

export type ParsedAdminAction =
  | { kind: "create_business"; name: string; slug: string; industry: (typeof INDUSTRIES)[number]; timezone: string }
  | { kind: "set_business_status"; status: (typeof BUSINESS_STATUS_TARGETS)[number] }
  | { kind: "create_source"; sourceKind: (typeof REGISTRABLE_SOURCE_KINDS)[number]; externalId: string; label: string | null; allowedOrigin: string | null }
  | { kind: "set_source_status"; sourceId: string; status: (typeof SOURCE_STATUS_TARGETS)[number] };

export type AdminActionError =
  | "unsupported_action" | "unexpected_field" | "missing_field" | "duplicate_field"
  | "invalid_name" | "invalid_slug" | "invalid_industry" | "invalid_timezone"
  | "invalid_kind" | "invalid_external_id" | "invalid_label" | "invalid_origin" | "invalid_status" | "invalid_source";

/** Database outcomes mapped to allow-listed codes (never the SQL message). */
export type AdminResultError = AdminActionError | "slug_taken" | "source_taken" | "not_found" | "not_operable" | "not_allowed" | "failed";
export type AdminOk = "business_created" | "business_status_updated" | "source_created" | "source_status_updated";

export const ADMIN_ERROR_MESSAGES: Record<AdminResultError, string> = {
  unsupported_action: "That action is not supported.",
  unexpected_field: "The request contained unexpected data.",
  missing_field: "A required field was missing. Please fill in the form again.",
  duplicate_field: "The request was ambiguous. Please submit the form again.",
  invalid_name: "Enter a business name between 1 and 200 characters.",
  invalid_slug: "Slug must be lowercase letters, digits and hyphens (no leading or trailing hyphen, up to 63 characters).",
  invalid_industry: "Choose an industry from the list.",
  invalid_timezone: "Choose a valid IANA timezone (for example America/New_York).",
  invalid_kind: "Choose a supported source kind.",
  invalid_external_id: "Enter the exact source identifier (1–255 characters, no surrounding whitespace).",
  invalid_label: "Labels are limited to 100 characters.",
  invalid_origin: "Allowed origin must be a canonical https origin such as https://www.example.com (no path, no trailing slash). Voice sources do not take an origin.",
  invalid_status: "That status change is not available.",
  invalid_source: "Choose a registered source.",
  slug_taken: "That slug is already in use. Choose another.",
  source_taken: "That source identifier is already registered. Identifiers are never moved between businesses.",
  not_found: "That business or source is not available.",
  not_operable: "Archived or suspended businesses cannot be changed this way.",
  not_allowed: "Only active platform administrators can perform this operation.",
  failed: "The operation could not be completed. Please try again.",
};

export const ADMIN_OK_MESSAGES: Record<AdminOk, string> = {
  business_created: "Business created.",
  business_status_updated: "Business status updated.",
  source_created: "Integration source registered.",
  source_status_updated: "Source status updated.",
};

/** The RPCs' 22023 messages, matched by prefix only; the message itself is never surfaced. */
const VALIDATION_PREFIXES: ReadonlyArray<[string, AdminActionError]> = [
  ["name must", "invalid_name"], ["slug must", "invalid_slug"], ["unsupported industry", "invalid_industry"],
  ["unsupported timezone", "invalid_timezone"], ["unsupported integration source kind", "invalid_kind"],
  ["external identifier", "invalid_external_id"], ["label must", "invalid_label"],
  ["allowed origin", "invalid_origin"], ["voice sources", "invalid_origin"], ["status must", "invalid_status"],
];

/** Maps a Supabase/Postgres error from an admin RPC to an allow-listed result code (never the SQL text). */
export function mapAdminRpcError(sqlstate: string | null | undefined, message: string | null | undefined, action: AdminActionName): AdminResultError {
  switch (sqlstate) {
    case "42501": return "not_allowed";
    case "P0002": return "not_found";
    case "55000": return "not_operable";
    case "23505": return action === "create_business" ? "slug_taken" : "source_taken";
    case "22023": {
      const m = (message ?? "").toLowerCase();
      for (const [prefix, code] of VALIDATION_PREFIXES) if (m.startsWith(prefix)) return code;
      return action === "create_business" ? "invalid_name" : action === "create_source" ? "invalid_external_id" : "invalid_status";
    }
    default: return "failed";
  }
}

type Parse = { ok: true; action: ParsedAdminAction } | { ok: false; error: AdminActionError };

function take(fields: URLSearchParams, name: string, required: boolean): { ok: true; value: string | null } | { ok: false; error: AdminActionError } {
  const all = fields.getAll(name);
  if (all.length > 1) return { ok: false, error: "duplicate_field" };
  if (all.length === 0) return required ? { ok: false, error: "missing_field" } : { ok: true, value: null };
  return { ok: true, value: all[0]! };
}

export function parseAdminAction(fields: URLSearchParams, scope: "platform" | "business"): Parse {
  const names = fields.getAll("action");
  if (names.length !== 1) return { ok: false, error: names.length === 0 ? "missing_field" : "duplicate_field" };
  const allowedActions: readonly string[] = scope === "platform" ? PLATFORM_ACTIONS : BUSINESS_ACTIONS;
  const name = names[0]!;
  if (!allowedActions.includes(name)) return { ok: false, error: "unsupported_action" };
  const action = name as AdminActionName;
  const spec = ADMIN_ACTION_FIELDS[action];
  for (const key of fields.keys()) if (!spec.required.includes(key) && !spec.optional.includes(key)) return { ok: false, error: "unexpected_field" };
  const got: Record<string, string | null> = {};
  for (const key of spec.required) {
    if (key === "action") continue;
    const r = take(fields, key, true);
    if (!r.ok) return r;
    got[key] = r.value;
  }
  for (const key of spec.optional) {
    const r = take(fields, key, false);
    if (!r.ok) return r;
    got[key] = r.value;
  }

  switch (action) {
    case "create_business": {
      const name = got.name!.trim();
      if (name.length < 1 || name.length > NAME_MAX) return { ok: false, error: "invalid_name" };
      const slug = got.slug!;
      if (!SLUG_RE.test(slug)) return { ok: false, error: "invalid_slug" };
      const industry = got.industry!;
      if (!(INDUSTRIES as readonly string[]).includes(industry)) return { ok: false, error: "invalid_industry" };
      const timezone = got.timezone!;
      if (!isSupportedTimeZone(timezone)) return { ok: false, error: "invalid_timezone" };
      return { ok: true, action: { kind: "create_business", name, slug, industry: industry as (typeof INDUSTRIES)[number], timezone } };
    }
    case "set_business_status": {
      const status = got.status!;
      if (!(BUSINESS_STATUS_TARGETS as readonly string[]).includes(status)) return { ok: false, error: "invalid_status" };
      return { ok: true, action: { kind: "set_business_status", status: status as (typeof BUSINESS_STATUS_TARGETS)[number] } };
    }
    case "create_source": {
      const sourceKind = got.kind!;
      if (!(REGISTRABLE_SOURCE_KINDS as readonly string[]).includes(sourceKind)) return { ok: false, error: "invalid_kind" };
      const externalId = got.external_id!;
      if (!isValidExternalId(externalId)) return { ok: false, error: "invalid_external_id" };
      const labelRaw = (got.label ?? "").trim();
      if (labelRaw.length > LABEL_MAX) return { ok: false, error: "invalid_label" };
      const originRaw = got.allowed_origin ?? "";
      let allowedOrigin: string | null = null;
      if (originRaw !== "") {
        if (sourceKind !== "website_form" || !isCanonicalHttpsOrigin(originRaw)) return { ok: false, error: "invalid_origin" };
        allowedOrigin = originRaw;
      }
      return { ok: true, action: { kind: "create_source", sourceKind: sourceKind as (typeof REGISTRABLE_SOURCE_KINDS)[number], externalId, label: labelRaw === "" ? null : labelRaw, allowedOrigin } };
    }
    case "set_source_status": {
      const sourceId = got.source_id!;
      if (!UUID.test(sourceId)) return { ok: false, error: "invalid_source" };
      const status = got.status!;
      if (!(SOURCE_STATUS_TARGETS as readonly string[]).includes(status)) return { ok: false, error: "invalid_status" };
      return { ok: true, action: { kind: "set_source_status", sourceId: sourceId.toLowerCase(), status: status as (typeof SOURCE_STATUS_TARGETS)[number] } };
    }
  }
}

/** Human text for a platform_admin_events row. Status values only; never identifiers. */
export interface AdminEventRow {
  id: string;
  event_type: string;
  integration_source_id: string | null;
  actor_display_name: string | null;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
}
export function describeAdminEvent(e: AdminEventRow, sourceLabel: (id: string) => string): string {
  const src = e.integration_source_id ? sourceLabel(e.integration_source_id) : "source";
  switch (e.event_type) {
    case "business_created": return "Business created";
    case "business_status_changed": return `Business ${e.old_value ?? "?"} → ${e.new_value ?? "?"}`;
    case "integration_source_created": return `Registered ${src}`;
    case "integration_source_status_changed": return `${src}: ${e.old_value ?? "?"} → ${e.new_value ?? "?"}`;
    default: return "Platform operation";
  }
}
