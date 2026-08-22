import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

// Bearer-token authentication for the server-to-server ingestion endpoint.
// Strict single-token grammar; constant-time comparison over fixed-length digests
// so neither length nor content of the configured token leaks through timing.

const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]{32,512})$/;

export function extractBearerToken(authorization: string | null): string | null {
  if (authorization === null) return null;
  // Multiple Authorization headers are joined with ", " by the Fetch API; a comma,
  // a second "Bearer", or any deviation from the grammar is ambiguous -> reject.
  if (authorization.includes(",")) return null;
  const m = BEARER.exec(authorization);
  if (!m) return null;
  const token = m[1] ?? null;
  if (token === null || authorization.indexOf("Bearer") !== authorization.lastIndexOf("Bearer")) return null;
  return token;
}

export function tokensMatch(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export function isAuthorized(authorization: string | null, expectedToken: string): boolean {
  const presented = extractBearerToken(authorization);
  if (presented === null) return false;
  return tokensMatch(presented, expectedToken);
}
