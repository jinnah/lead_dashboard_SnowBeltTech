import { isAuthorized } from "@/lib/server/auth";
import { ConfigError, getServerEnv } from "@/lib/server/env";
import { isJsonContentType, json, logEvent, newRequestId, readBoundedBody } from "@/lib/server/http";
import { ingestLeadEvent } from "@/lib/server/ingest";
import { validateIngestRequest } from "@/lib/ingest/schema";

// Server-to-server ingestion endpoint for n8n.
// Node.js runtime (crypto.timingSafeEqual, streaming body cap); never cached;
// no CORS headers (not a browser endpoint); authenticates BEFORE reading the body.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();

  let expectedToken: string;
  try {
    expectedToken = getServerEnv().n8nIngestToken;
  } catch (e) {
    logEvent({ requestId, event: "ingest", category: "config_error", detail: e instanceof ConfigError ? e.message : "unknown" });
    return json(500, { error: "internal_error" }, requestId);
  }

  if (!isAuthorized(request.headers.get("authorization"), expectedToken)) {
    logEvent({ requestId, event: "ingest", status: 401, category: "unauthorized" });
    return json(401, { error: "unauthorized" }, requestId);
  }

  if (!isJsonContentType(request.headers.get("content-type"))) {
    logEvent({ requestId, event: "ingest", status: 415, category: "unsupported_media_type" });
    return json(415, { error: "unsupported_media_type" }, requestId);
  }

  const body = await readBoundedBody(request);
  if (!body.ok) {
    const status = body.reason === "too_large" ? 413 : 400;
    logEvent({ requestId, event: "ingest", status, category: body.reason });
    return json(status, { error: body.reason === "too_large" ? "payload_too_large" : "bad_request" }, requestId);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    logEvent({ requestId, event: "ingest", status: 400, category: "malformed_json" });
    return json(400, { error: "malformed_json" }, requestId);
  }

  const validated = validateIngestRequest(parsed);
  if (!validated.ok) {
    logEvent({ requestId, event: "ingest", status: 422, category: "invalid_request", issues: validated.issues.length });
    return json(422, { error: "invalid_request", issues: validated.issues }, requestId);
  }

  const result = await ingestLeadEvent(validated.data);
  if (result.kind === "error") {
    logEvent({ requestId, event: "ingest", status: result.status, category: result.category, sqlstate: result.sqlstate ?? null });
    return json(result.status, result.body, requestId);
  }
  logEvent({
    requestId,
    event: "ingest",
    status: result.status,
    category: "processed",
    source_kind: validated.data.source_kind,
    outcome: result.body.outcome,
    should_notify: result.body.should_notify,
  });
  return json(result.status, result.body, requestId);
}
