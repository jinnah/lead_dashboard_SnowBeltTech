import "server-only";
import { readBoundedBody } from "./http";

// Bounded form reading for public/authenticated form endpoints. Streams the body
// with a hard byte cap (Content-Length is advisory only, so chunked requests are
// capped too), accepts only urlencoded forms, and never logs field values.
export const LOGIN_FORM_MAX_BYTES = 4 * 1024;      // email (<=320) + password (<=1024) + overhead
export const ACTION_FORM_MAX_BYTES = 16 * 1024;    // a 2,000-char note urlencoded (<= ~6 KiB) + fields

export type FormResult =
  | { ok: true; fields: URLSearchParams }
  | { ok: false; status: 413 | 415 | 400; error: "payload_too_large" | "unsupported_media_type" | "bad_request" };

export async function readBoundedForm(request: Request, maxBytes: number): Promise<FormResult> {
  const ct = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (ct !== "application/x-www-form-urlencoded") return { ok: false, status: 415, error: "unsupported_media_type" };
  const body = await readBoundedBody(request, maxBytes);
  if (!body.ok) {
    return body.reason === "too_large"
      ? { ok: false, status: 413, error: "payload_too_large" }
      : { ok: false, status: 400, error: "bad_request" };
  }
  try {
    return { ok: true, fields: new URLSearchParams(body.text) };
  } catch {
    return { ok: false, status: 400, error: "bad_request" };
  }
}

/** Rejects any field name outside the allow-list (unexpected fields are errors, not ignored). */
export function onlyFields(fields: URLSearchParams, allowed: readonly string[]): boolean {
  for (const key of fields.keys()) if (!allowed.includes(key)) return false;
  return true;
}
