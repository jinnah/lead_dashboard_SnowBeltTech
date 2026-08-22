import { describe, expect, it } from "vitest";
import { validateIngestRequest } from "./schema";

const web = (over: Record<string, unknown> = {}, payloadOver: Record<string, unknown> = {}) => ({
  source_kind: "website_form",
  source_external_id: "site-alpha-synthetic",
  source_event_id: "stable-form-submission-0001",
  payload: { contact_name: "Synthetic Customer", email: "customer@example.invalid", phone_e164: "+15550100001", requested_service: "Furnace inspection", sms_consent: false, ...payloadOver },
  ...over,
});
const voice = (payloadOver: Record<string, unknown> = {}, eventId = "vapi-call-full-id-0001") => ({
  source_kind: "vapi_assistant",
  source_external_id: "asst-alpha-synthetic-0001",
  source_event_id: eventId,
  payload: { call_id: eventId, is_lead: true, call_classification: "legitimate_lead", caller_phone: "+15550100002", ...payloadOver },
});
const issuePaths = (r: ReturnType<typeof validateIngestRequest>) => (r.ok ? [] : r.issues.map((i) => i.path));

describe("ingest request schema", () => {
  it("accepts the documented website request", () => {
    const r = validateIngestRequest(web());
    expect(r.ok).toBe(true);
  });
  it("preserves the event id exactly", () => {
    const id = "Evt_ABC-123.xyz:Mixed/Case~";
    const r = validateIngestRequest(web({ source_event_id: id }));
    expect(r.ok && r.data.source_event_id).toBe(id);
  });
  it("rejects whitespace-padded, empty and oversized event ids", () => {
    expect(issuePaths(validateIngestRequest(web({ source_event_id: " padded" })))).toContain("source_event_id");
    expect(issuePaths(validateIngestRequest(web({ source_event_id: "padded " })))).toContain("source_event_id");
    expect(issuePaths(validateIngestRequest(web({ source_event_id: "" })))).toContain("source_event_id");
    expect(issuePaths(validateIngestRequest(web({ source_event_id: "x".repeat(256) })))).toContain("source_event_id");
    expect(validateIngestRequest(web({ source_event_id: "y".repeat(255) })).ok).toBe(true);
  });
  it("rejects unexpected top-level fields and unsupported kinds", () => {
    expect(issuePaths(validateIngestRequest(web({ business_id: "x" })))).toContain("business_id");
    expect(issuePaths(validateIngestRequest(web({ extra: 1 })))).toContain("extra");
    expect(validateIngestRequest(web({ source_kind: "twilio_number" })).ok).toBe(false);
    expect(validateIngestRequest("not an object").ok).toBe(false);
  });
  it("rejects tenant / system-managed fields inside the payload", () => {
    for (const k of ["business_id", "id", "lead_number", "source", "source_event_id", "status", "assigned_to", "archived_at", "created_at", "platform_role", "integration_source_id"]) {
      const r = validateIngestRequest(web({}, { [k]: "x" }));
      expect(r.ok, k).toBe(false);
      expect(issuePaths(r)).toContain(`payload.${k}`);
    }
  });
  it("rejects unknown payload keys and voice-only keys on website events", () => {
    expect(issuePaths(validateIngestRequest(web({}, { call_id: "abc" })))).toContain("payload.call_id");
    expect(issuePaths(validateIngestRequest(web({}, { anything: "x" })))).toContain("payload.anything");
  });
  it("validates phones, emails, enums and lengths", () => {
    expect(issuePaths(validateIngestRequest(web({}, { phone_e164: "5550100001" })))).toContain("payload.phone_e164");
    expect(issuePaths(validateIngestRequest(web({}, { email: "not-an-email" })))).toContain("payload.email");
    expect(issuePaths(validateIngestRequest(web({}, { urgency: "asap" })))).toContain("payload.urgency");
    expect(issuePaths(validateIngestRequest(web({}, { contact_name: "x".repeat(201) })))).toContain("payload.contact_name");
    expect(validateIngestRequest(web({}, { phone_e164: null, email: null })).ok).toBe(true);
  });
  it("requires explicit timezones on timestamps", () => {
    expect(validateIngestRequest(web({}, { preferred_callback_at: "2026-08-22T09:00:00Z" })).ok).toBe(true);
    expect(validateIngestRequest(web({}, { preferred_callback_at: "2026-08-22T09:00:00-04:00" })).ok).toBe(true);
    expect(issuePaths(validateIngestRequest(web({}, { preferred_callback_at: "2026-08-22T09:00:00" })))).toContain("payload.preferred_callback_at");
  });
  it("enforces website consent evidence", () => {
    const full = { sms_consent: true, sms_consent_text: "t", sms_consent_version: "v1", sms_consent_source: "website_form", sms_consent_at: "2026-08-21T10:00:00Z" };
    expect(validateIngestRequest(web({}, full)).ok).toBe(true);
    const r = validateIngestRequest(web({}, { ...full, sms_consent_at: undefined }));
    expect(issuePaths(r)).toContain("payload.sms_consent_at");
    expect(issuePaths(validateIngestRequest(web({}, { ...full, sms_consent_at: "2026-08-21T10:00:00" })))).toContain("payload.sms_consent_at");
  });
  it("keeps custom_fields bounded and scalar-only", () => {
    expect(validateIngestRequest(web({}, { custom_fields: { business_name: "Co", business_type: "HVAC", n: 1, b: true, z: null } })).ok).toBe(true);
    expect(issuePaths(validateIngestRequest(web({}, { custom_fields: { nested: { a: 1 } } })))).toContain("payload.custom_fields.nested");
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, "v"]));
    expect(issuePaths(validateIngestRequest(web({}, { custom_fields: many })))).toContain("payload.custom_fields");
  });
  it("accepts a legitimate voice event and a filtered voice event", () => {
    expect(validateIngestRequest(voice()).ok).toBe(true);
    expect(validateIngestRequest(voice({ is_lead: false, call_classification: "uncertain", review_recommended: true, review_reason: "free text ok on lead path", ended_reason: "customer-ended-call" })).ok).toBe(true);
    expect(validateIngestRequest({ ...voice(), source_kind: "vapi_phone_number", source_external_id: "+15550100500" }).ok).toBe(true);
  });
  it("requires the full call id to equal the event id", () => {
    expect(issuePaths(validateIngestRequest(voice({ call_id: "id-0001" })))).toContain("payload.call_id");
    expect(issuePaths(validateIngestRequest(voice({ call_id: undefined })))).toContain("payload.call_id");
    expect(issuePaths(validateIngestRequest(voice({ call_id: "vapi-call-full-id-0001 " })))).toContain("payload.call_id");
  });
  it("rejects voice consent assertions and evidence", () => {
    expect(issuePaths(validateIngestRequest(voice({ sms_consent: true })))).toContain("payload.sms_consent");
    expect(issuePaths(validateIngestRequest(voice({ sms_consent_text: "t" })))).toContain("payload.sms_consent_text");
    expect(issuePaths(validateIngestRequest(voice({ sms_consent_at: "2026-08-21T10:00:00Z" })))).toContain("payload.sms_consent_at");
  });
  it("constrains machine-readable voice codes", () => {
    expect(issuePaths(validateIngestRequest(voice({ ended_reason: "Caller hung up, phone 555" })))).toContain("payload.ended_reason");
    expect(issuePaths(validateIngestRequest(voice({ call_classification: "Not A Lead" })))).toContain("payload.call_classification");
  });
  it("issues never echo values", () => {
    const r = validateIngestRequest(web({}, { email: "leaky-secret@example.invalid", business_id: "tenant-uuid" }));
    const text = JSON.stringify(r);
    expect(text).not.toContain("leaky-secret");
    expect(text).not.toContain("tenant-uuid");
  });
});
