import "server-only";

// Rejects cross-site form posts to state-changing auth routes (login/logout CSRF).
// Accepts same-origin / user-initiated navigations; a matching Origin header is
// also accepted for clients that do not send Fetch Metadata.
export function isSameSiteRequest(headers: Headers): boolean {
  const site = headers.get("sec-fetch-site");
  if (site === "same-origin" || site === "none") return true;
  if (site === "cross-site" || site === "same-site") return false;
  const origin = headers.get("origin");
  const host = headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
