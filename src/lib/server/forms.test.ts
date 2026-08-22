import { describe, expect, it } from "vitest";
import { ACTION_FORM_MAX_BYTES, LOGIN_FORM_MAX_BYTES, onlyFields, readBoundedForm } from "./forms";

const form = (body: BodyInit, contentType: string | null = "application/x-www-form-urlencoded", headers: Record<string, string> = {}) =>
  new Request("http://127.0.0.1:3000/x", {
    method: "POST",
    headers: { ...(contentType ? { "content-type": contentType } : {}), ...headers },
    body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);

describe("readBoundedForm", () => {
  it("parses a small urlencoded form", async () => {
    const r = await readBoundedForm(form("email=a%40example.invalid&password=pw"), LOGIN_FORM_MAX_BYTES);
    expect(r.ok && r.fields.get("email")).toBe("a@example.invalid");
  });
  it("rejects JSON and missing content types with 415", async () => {
    expect((await readBoundedForm(form("{}", "application/json"), LOGIN_FORM_MAX_BYTES))).toMatchObject({ ok: false, status: 415 });
    expect((await readBoundedForm(form("a=b", null), LOGIN_FORM_MAX_BYTES))).toMatchObject({ ok: false, status: 415 });
  });
  it("rejects an oversized declared body with 413 before reading it", async () => {
    const big = "password=" + "x".repeat(LOGIN_FORM_MAX_BYTES + 10);
    expect(await readBoundedForm(form(big), LOGIN_FORM_MAX_BYTES)).toMatchObject({ ok: false, status: 413 });
  });
  it("rejects an oversized chunked body (no Content-Length) with 413", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const chunk = new TextEncoder().encode("password=" + "y".repeat(1015));
        for (let i = 0; i < 20; i++) c.enqueue(chunk);
        c.close();
      },
    });
    const req = form(stream);
    expect(req.headers.get("content-length")).toBeNull();
    expect(await readBoundedForm(req, LOGIN_FORM_MAX_BYTES)).toMatchObject({ ok: false, status: 413 });
  });
  it("accepts a body just under the action limit", async () => {
    const body = "action=add_note&request_id=11111111-1111-4111-8111-111111111111&note=" + "z".repeat(ACTION_FORM_MAX_BYTES - 200);
    expect((await readBoundedForm(form(body), ACTION_FORM_MAX_BYTES)).ok).toBe(true);
  });
});

describe("onlyFields", () => {
  it("rejects unexpected fields rather than ignoring them", () => {
    expect(onlyFields(new URLSearchParams("action=set_status&status=won"), ["action", "status"])).toBe(true);
    expect(onlyFields(new URLSearchParams("action=set_status&status=won&business_id=x"), ["action", "status"])).toBe(false);
    expect(onlyFields(new URLSearchParams("action=set_status&actor_id=x"), ["action", "status"])).toBe(false);
  });
});
