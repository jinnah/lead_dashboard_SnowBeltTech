import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "f".repeat(64);
const SERVICE_KEY = "service-role-key-unit-test-value-0123456789";
const rpcMock = vi.fn();

vi.mock("@/lib/server/supabase-admin", () => ({
  getAdminClient: () => ({ rpc: (...args: unknown[]) => ({ single: () => rpcMock(...args) }) }),
}));

process.env.SUPABASE_URL = "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
process.env.N8N_INGEST_TOKEN = TOKEN;

const { POST } = await import("./route");

const okRow = {
  outcome: "lead_created", should_notify: true, customer_sms_allowed: false,
  business_id: "a0000000-0000-4000-8000-000000000001", lead_id: "aa000000-0000-4000-8000-0000000000aa",
  lead_number: "INQ-2026-0004", ingestion_event_id: "ee000000-0000-4000-8000-0000000000ee", attempt_count: 1,
};
const validBody = {
  source_kind: "website_form", source_external_id: "site-alpha-synthetic", source_event_id: "stable-form-submission-0001",
  payload: { contact_name: "Synthetic Customer", email: "customer@example.invalid", phone_e164: "+15550100001", requested_service: "Furnace inspection", sms_consent: false },
};

function req(init: { auth?: string | null; contentType?: string | null; body?: BodyInit | null; headers?: Record<string, string> } = {}) {
  const headers = new Headers(init.headers ?? {});
  if (init.auth !== null) headers.set("authorization", init.auth ?? `Bearer ${TOKEN}`);
  if (init.contentType !== null) headers.set("content-type", init.contentType ?? "application/json");
  const body = init.body === undefined ? JSON.stringify(validBody) : init.body;
  return new Request("http://127.0.0.1:3000/api/internal/ingest", { method: "POST", headers, body, ...(body instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit);
}

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockResolvedValue({ data: okRow, error: null });
});

describe("POST /api/internal/ingest", () => {
  it("creates a lead: 201 with the minimal public body and no business_id", async () => {
    const res = await POST(req());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ outcome: "lead_created", should_notify: true, customer_sms_allowed: false, lead_id: okRow.lead_id, lead_number: "INQ-2026-0004" });
    expect(JSON.stringify(body)).not.toContain("business_id");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(rpcMock).toHaveBeenCalledWith("ingest_lead_event", {
      p_source_kind: "website_form", p_source_external_id: "site-alpha-synthetic", p_source_event_id: "stable-form-submission-0001", p_payload: validBody.payload,
    });
  });
  it("rejects missing, malformed, wrong and duplicate bearer tokens with an opaque 401 before touching the body", async () => {
    for (const auth of [null, "Bearer nope", `Bearer ${"e".repeat(64)}`, `Bearer ${TOKEN}, Bearer ${TOKEN}`, `Basic ${TOKEN}`]) {
      const res = await POST(req({ auth, body: "{not json" }));
      expect(res.status, String(auth)).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(rpcMock).not.toHaveBeenCalled();
  });
  it("rejects non-JSON content types with 415", async () => {
    expect((await POST(req({ contentType: "text/plain" }))).status).toBe(415);
    expect((await POST(req({ contentType: null }))).status).toBe(415);
    expect((await POST(req({ contentType: "application/json; charset=utf-8" }))).status).toBe(201);
  });
  it("rejects malformed JSON with 400 and invalid fields with 422 (paths only)", async () => {
    expect((await POST(req({ body: "{not json" }))).status).toBe(400);
    const res = await POST(req({ body: JSON.stringify({ ...validBody, payload: { ...validBody.payload, business_id: "b0000000-0000-4000-8000-000000000001", email: "leak@example.invalid" } }) }));
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).toContain("payload.business_id");
    expect(text).not.toContain("b0000000");
    expect(text).not.toContain("leak@");
    expect(rpcMock).not.toHaveBeenCalled();
  });
  it("rejects oversized bodies (Content-Length) and oversized chunked bodies with 413", async () => {
    const big = JSON.stringify({ ...validBody, payload: { ...validBody.payload, details: "x".repeat(70_000) } });
    expect((await POST(req({ body: big }))).status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const chunk = new TextEncoder().encode("x".repeat(8192));
        for (let i = 0; i < 10; i++) c.enqueue(chunk);
        c.close();
      },
    });
    const chunked = new Request("http://127.0.0.1:3000/api/internal/ingest", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(chunked.headers.get("content-length")).toBeNull();
    expect((await POST(chunked)).status).toBe(413);
    expect(rpcMock).not.toHaveBeenCalled();
  });
  it("maps duplicates and filtered results to 200 with should_notify=false", async () => {
    rpcMock.mockResolvedValueOnce({ data: { ...okRow, outcome: "duplicate_lead", should_notify: false, attempt_count: 2 }, error: null });
    let res = await POST(req());
    expect(res.status).toBe(200);
    expect((await res.json()).should_notify).toBe(false);
    rpcMock.mockResolvedValueOnce({ data: { ...okRow, outcome: "filtered", should_notify: false, lead_id: null, lead_number: null }, error: null });
    res = await POST(req({ body: JSON.stringify({ source_kind: "vapi_assistant", source_external_id: "asst-alpha-synthetic-0001", source_event_id: "call-1", payload: { call_id: "call-1", is_lead: false, call_classification: "uncertain" } }) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "filtered", should_notify: false, customer_sms_allowed: false, lead_id: null, lead_number: null });
  });
  it("returns one opaque 403 for unknown source, inactive source and suspended business", async () => {
    const bodies = new Set<string>();
    for (const code of ["P0002", "55000", "55000"]) {
      rpcMock.mockResolvedValueOnce({ data: null, error: { code, message: "suspended business / unknown integration source" } });
      const res = await POST(req());
      expect(res.status).toBe(403);
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
    expect([...bodies][0]).not.toMatch(/suspend|unknown|inactive|P0002|55000/);
  });
  it("maps database unavailability to 503 and unexpected failures to 500 without leaking", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { code: "", message: "TypeError: fetch failed" } });
    expect((await POST(req())).status).toBe(503);
    rpcMock.mockRejectedValueOnce(new Error("socket hang up"));
    expect((await POST(req())).status).toBe(503);
    rpcMock.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: `boom ${SERVICE_KEY} select * from leads` } });
    const res = await POST(req());
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toEqual(JSON.stringify({ error: "internal_error" }));
    expect(text).not.toContain(SERVICE_KEY);
    expect(text).not.toContain(TOKEN);
  });
  it("never writes the token, key or request body to the log", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "info").mockImplementation((m: unknown) => { lines.push(String(m)); });
    await POST(req());
    await POST(req({ auth: "Bearer wrong-token-wrong-token-wrong-token-000" }));
    spy.mockRestore();
    const joined = lines.join("\n");
    expect(lines.length).toBe(2);
    expect(joined).not.toContain(TOKEN);
    expect(joined).not.toContain(SERVICE_KEY);
    expect(joined).not.toContain("Synthetic Customer");
    expect(joined).not.toContain("customer@example.invalid");
    expect(joined).not.toContain("+15550100001");
  });
});
