import { describe, expect, it } from "vitest";
import { isSameSiteRequest } from "./same-site";

const h = (o: Record<string, string>) => new Headers(o);

describe("isSameSiteRequest", () => {
  it("accepts same-origin and user-initiated requests", () => {
    expect(isSameSiteRequest(h({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameSiteRequest(h({ "sec-fetch-site": "none" }))).toBe(true);
  });
  it("rejects cross-site requests even with a matching Origin", () => {
    expect(isSameSiteRequest(h({ "sec-fetch-site": "cross-site", origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000" }))).toBe(false);
  });
  it("falls back to an exact Origin/Host match", () => {
    expect(isSameSiteRequest(h({ origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000" }))).toBe(true);
    expect(isSameSiteRequest(h({ origin: "http://evil.example.invalid", host: "127.0.0.1:3000" }))).toBe(false);
    expect(isSameSiteRequest(h({ host: "127.0.0.1:3000" }))).toBe(false);
    expect(isSameSiteRequest(h({ origin: "not a url", host: "127.0.0.1:3000" }))).toBe(false);
  });
});
