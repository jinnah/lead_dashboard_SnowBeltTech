// Strict request contract for POST /api/internal/ingest.
// Mirrors the database contract of public.ingest_lead_event: allow-listed keys,
// bounded lengths, E.164 phones, explicit-timezone timestamps, consent rules.
// Pure validation: no secrets, safe to unit-test anywhere.
import { z } from "zod";

export const SOURCE_KINDS = ["website_form", "vapi_assistant", "vapi_phone_number"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

// Fields the caller may never control (tenant ownership, identity, workflow, platform).
export const FORBIDDEN_PAYLOAD_FIELDS = [
  "id", "business_id", "lead_number", "source", "source_event_id", "status", "assigned_to",
  "archived_at", "created_at", "updated_at", "follow_up_at", "platform_role", "integration_source_id",
] as const;

const E164 = /^\+[1-9][0-9]{7,14}$/;
const ISO_WITH_TZ = /^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}:?[0-9]{2})$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MACHINE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const PROVIDER_CODE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

const text = (max: number) => z.string().max(max).nullish();
const scalar = z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()]);
const customFields = z
  .record(z.string().min(1).max(64), scalar)
  .refine((o) => Object.keys(o).length <= 32, { message: "custom_fields: at most 32 keys" })
  .refine((o) => JSON.stringify(o).length <= 8000, { message: "custom_fields: at most 8000 characters" })
  .nullish();

const commonPayloadShape = {
  contact_name: text(200),
  email: z.string().max(320).regex(EMAIL).nullish(),
  phone_e164: z.string().regex(E164, "phone_e164 must be E.164").nullish(),
  phone_raw: text(64),
  service_address: text(500),
  requested_service: text(300),
  details: text(5000),
  urgency: z.enum(["normal", "urgent", "emergency"]).nullish(),
  preferred_contact_method: z.enum(["phone", "text", "email"]).nullish(),
  preferred_callback_at: z.string().regex(ISO_WITH_TZ, "timestamp requires an explicit timezone").nullish(),
  custom_fields: customFields,
  email_marketing_consent: z.boolean().nullish(),
  sms_consent: z.boolean().nullish(),
  sms_consent_text: text(2000),
  sms_consent_version: text(64),
  sms_consent_source: z.enum(["website_form", "voice_call", "manual"]).nullish(),
  sms_consent_at: z.string().regex(ISO_WITH_TZ, "timestamp requires an explicit timezone").nullish(),
};

export const websitePayloadSchema = z
  .object(commonPayloadShape)
  .strict()
  .superRefine((p, ctx) => {
    if (p.sms_consent === true) {
      for (const k of ["sms_consent_text", "sms_consent_version", "sms_consent_source", "sms_consent_at"] as const) {
        if (p[k] === undefined || p[k] === null || p[k] === "") {
          ctx.addIssue({ code: "custom", path: [k], message: "sms_consent = true requires complete consent evidence" });
        }
      }
    }
  });

export const voicePayloadSchema = z
  .object({
    ...commonPayloadShape,
    call_id: z.string().min(1).max(255),
    caller_phone: z.string().regex(E164, "caller_phone must be E.164").nullish(),
    call_classification: z.string().regex(MACHINE_CODE, "call_classification must be a machine-readable code").nullish(),
    call_summary: text(5000),
    review_recommended: z.boolean().nullish(),
    review_reason: text(1000),
    ended_reason: z.string().regex(PROVIDER_CODE, "ended_reason must be a machine-readable provider code").nullish(),
    is_lead: z.boolean().nullish(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.sms_consent === true) {
      ctx.addIssue({ code: "custom", path: ["sms_consent"], message: "voice SMS consent is not supported" });
    }
    for (const k of ["sms_consent_text", "sms_consent_version", "sms_consent_source", "sms_consent_at"] as const) {
      if (p[k] !== undefined && p[k] !== null) {
        ctx.addIssue({ code: "custom", path: [k], message: "voice consent evidence is not supported" });
      }
    }
  });

export const ingestRequestSchema = z
  .object({
    source_kind: z.enum(SOURCE_KINDS),
    source_external_id: z.string().min(1).max(255),
    source_event_id: z
      .string()
      .min(1)
      .max(255)
      .refine((s) => s === s.trim(), { message: "source_event_id must not have leading or trailing whitespace" }),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((req, ctx) => {
    // Explicit, named rejection of system-managed fields (strict() would also catch them).
    for (const k of Object.keys(req.payload)) {
      if ((FORBIDDEN_PAYLOAD_FIELDS as readonly string[]).includes(k)) {
        ctx.addIssue({ code: "custom", path: ["payload", k], message: "system-managed field is not allowed" });
      }
    }
    const schema = req.source_kind === "website_form" ? websitePayloadSchema : voicePayloadSchema;
    const r = schema.safeParse(req.payload);
    if (!r.success) {
      for (const issue of r.error.issues) {
        if (issue.code === "unrecognized_keys") {
          for (const key of issue.keys) {
            ctx.addIssue({ code: "custom", path: ["payload", ...issue.path, key], message: "unsupported payload field" });
          }
        } else {
          ctx.addIssue({ code: "custom", path: ["payload", ...issue.path], message: issue.message });
        }
      }
      return;
    }
    if (req.source_kind !== "website_form") {
      const callId = (r.data as { call_id: string }).call_id;
      if (callId !== req.source_event_id) {
        ctx.addIssue({ code: "custom", path: ["payload", "call_id"], message: "call_id must equal the complete source_event_id" });
      }
    }
  });

export type IngestRequest = z.infer<typeof ingestRequestSchema>;

export interface ValidationIssue {
  path: string;
  message: string;
}

/** Validates an already-parsed JSON value. Issues carry paths and rule names only — never values. */
export function validateIngestRequest(
  input: unknown,
): { ok: true; data: IngestRequest } | { ok: false; issues: ValidationIssue[] } {
  const r = ingestRequestSchema.safeParse(input);
  if (r.success) return { ok: true, data: r.data };
  const issues: ValidationIssue[] = [];
  for (const i of r.error.issues) {
    const base = i.path.map(String);
    if (i.code === "unrecognized_keys") {
      for (const key of i.keys) issues.push({ path: [...base, key].join("."), message: "unexpected field" });
    } else {
      issues.push({ path: base.join("."), message: i.message });
    }
  }
  return { ok: false, issues };
}
