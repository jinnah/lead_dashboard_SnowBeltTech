import "server-only";
import { randomUUID } from "node:crypto";

export const MAX_BODY_BYTES = 64 * 1024;

const BASE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

export function json(status: number, body: unknown, requestId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, "X-Request-Id": requestId },
  });
}

export function newRequestId(): string {
  return randomUUID();
}

export function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const mime = contentType.split(";")[0]?.trim().toLowerCase();
  return mime === "application/json";
}

export type BodyResult = { ok: true; text: string } | { ok: false; reason: "too_large" | "unreadable" };

/** Reads the body with a hard byte cap, counting streamed bytes (Content-Length is advisory only). */
export async function readBoundedBody(request: Request, maxBytes = MAX_BODY_BYTES): Promise<BodyResult> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number.isFinite(Number(declared)) && Number(declared) > maxBytes) {
    return { ok: false, reason: "too_large" };
  }
  const body = request.body;
  if (!body) return { ok: true, text: "" };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, text: new TextDecoder("utf-8", { fatal: false }).decode(merged) };
}

/** Structured operational log line. Callers must never pass bodies, identities or secrets. */
export function logEvent(fields: Record<string, string | number | boolean | null | undefined>): void {
  console.info(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}
