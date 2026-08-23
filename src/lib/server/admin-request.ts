import "server-only";
import { NextResponse } from "next/server";
import { ACTION_FORM_MAX_BYTES, readBoundedForm } from "./forms";
import { logEvent } from "./http";
import { isSameSiteRequest } from "./same-site";
import { getViewer, type Viewer } from "./viewer";

// Shared prelude for platform-administrator action routes. Runs under the
// administrator's ordinary session (anon key + RLS); the service-role client is
// never involved. Customers get an opaque 404, anonymous callers 401, cross-site
// posts 403. Form bodies are streamed with the existing hard byte cap and parsed
// as urlencoded only. Nothing submitted is ever logged.
export function opaque(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "private, no-store" } });
}

export function redirectTo(request: Request, path: string, result: { ok: string } | { err: string }): NextResponse {
  const url = new URL(path, request.url);
  if ("ok" in result) url.searchParams.set("ok", result.ok);
  else url.searchParams.set("err", result.err);
  const res = NextResponse.redirect(url, 303);
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}

export type AdminRequest = { ok: true; viewer: Viewer; fields: URLSearchParams } | { ok: false; response: NextResponse };

export async function readAdminRequest(request: Request, requestId: string, event: string): Promise<AdminRequest> {
  if (!isSameSiteRequest(request.headers)) return { ok: false, response: opaque(403, "forbidden") };
  const viewer = await getViewer();
  if (!viewer) return { ok: false, response: opaque(401, "unauthorized") };
  if (viewer.access.kind !== "admin") {
    logEvent({ requestId, event, status: 404, category: "not_admin" });
    return { ok: false, response: opaque(404, "not_found") };
  }
  const form = await readBoundedForm(request, ACTION_FORM_MAX_BYTES);
  if (!form.ok) {
    logEvent({ requestId, event, status: form.status, category: form.error });
    return { ok: false, response: opaque(form.status, form.error) };
  }
  return { ok: true, viewer, fields: form.fields };
}
