import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "./proxy";

describe("proxy matcher", () => {
  const pattern = config.matcher[0]!;
  // Next compiles the matcher with path-to-regexp; the negative lookahead is what excludes paths.
  const re = new RegExp(`^${pattern}$`);
  it("excludes the internal n8n endpoint and static assets", () => {
    expect(re.test("/api/internal/ingest")).toBe(false);
    expect(re.test("/_next/static/chunks/main.js")).toBe(false);
    expect(re.test("/favicon.ico")).toBe(false);
  });
  it("covers page and auth routes", () => {
    for (const p of ["/", "/login", "/dashboard", "/dashboard/leads/x", "/admin", "/api/auth/login"]) expect(re.test(p), p).toBe(true);
  });
  it("short-circuits the internal endpoint in code as well", () => {
    const src = readFileSync(path.resolve(__dirname, "proxy.ts"), "utf8");
    expect(src).toContain('pathname.startsWith("/api/internal")');
    expect(src).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(src).not.toContain("supabase-admin");
  });
});
