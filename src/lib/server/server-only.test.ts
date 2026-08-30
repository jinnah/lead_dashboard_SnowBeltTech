import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Static guarantees: every privileged module is marked server-only, only those
// modules touch the secrets, nothing secret is ever NEXT_PUBLIC_, and no client
// component imports from the server tree.
const root = path.resolve(__dirname, "../../..");
const serverDir = path.resolve(__dirname);
const src = path.join(root, "src");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}
const SECRET_NAMES = ["SUPABASE_SERVICE_ROLE_KEY", "N8N_INGEST_TOKEN"];

describe("privileged module isolation", () => {
  it("every module under src/lib/server imports server-only", () => {
    const modules = readdirSync(serverDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(modules.length).toBeGreaterThan(0);
    for (const f of modules) {
      expect(readFileSync(path.join(serverDir, f), "utf8").startsWith('import "server-only";'), f).toBe(true);
    }
  });
  it("secrets are read only inside src/lib/server", () => {
    for (const file of walk(src).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".test.ts"))) {
      const text = readFileSync(file, "utf8");
      const insideServer = file.startsWith(serverDir);
      for (const name of SECRET_NAMES) {
        if (!insideServer) expect(text.includes(name), `${name} referenced in ${path.relative(root, file)}`).toBe(false);
      }
    }
  });
  it("no client component imports the server tree", () => {
    for (const file of walk(src).filter((f) => /\.(ts|tsx)$/.test(f))) {
      const text = readFileSync(file, "utf8");
      if (/^\s*["']use client["']/m.test(text)) {
        expect(text.includes("lib/server"), path.relative(root, file)).toBe(false);
      }
    }
  });
  it("the Auth Admin boundary is reachable only from the invitation coordinator", () => {
    for (const file of walk(src).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".test.ts"))) {
      const text = readFileSync(file, "utf8");
      const rel = path.relative(root, file).replace(/\\/g, "/");
      if (text.includes("supabase-auth-admin") && rel !== "src/lib/server/supabase-auth-admin.ts") {
        expect(rel, "supabase-auth-admin imported outside the coordinator").toBe("src/lib/server/invitations.ts");
      }
    }
  });
  it("privileged clients stay out of pages and customer routes", () => {
    const allowedAdminImporters = new Set([
      "src/lib/server/supabase-admin.ts",
      "src/lib/server/ingest.ts", // reviewed ingestion path
    ]);
    const allowedCoordinatorImporters = new Set([
      "src/lib/server/invitations.ts",
      "src/app/api/admin/businesses/[id]/actions/route.ts", // reviewed administrator invitation route
      "src/app/api/team/actions/route.ts", // reviewed customer-owner team route (same coordinator, owner-authorized)
    ]);
    for (const file of walk(src).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".test.ts"))) {
      const text = readFileSync(file, "utf8");
      const rel = path.relative(root, file).replace(/\\/g, "/");
      if (rel.endsWith("page.tsx")) {
        expect(text.includes("supabase-admin") || text.includes("supabase-auth-admin") || text.includes("server/invitations"), `${rel} touches a privileged module`).toBe(false);
      }
      if (text.includes("supabase-admin") && !text.includes("supabase-auth-admin") && rel !== "src/lib/server/supabase-admin.ts" && rel !== "src/lib/server/supabase-server.ts") {
        expect(allowedAdminImporters.has(rel), `${rel} imports the ingestion service client`).toBe(true);
      }
      if (text.includes("server/invitations") && rel !== "src/lib/server/invitations.ts") {
        expect(allowedCoordinatorImporters.has(rel), `${rel} imports the invitation coordinator`).toBe(true);
      }
    }
  });
  it("customer search/export surfaces never touch the service-role client, Auth Admin or the invitation coordinator", () => {
    const surfaces = [
      "src/app/dashboard/page.tsx",
      "src/app/api/leads/export/route.ts",
      "src/lib/server/lead-search.ts",
      "src/lib/lead-query.ts",
      "src/lib/csv.ts",
    ];
    for (const rel of surfaces) {
      const text = readFileSync(path.join(root, rel), "utf8");
      for (const forbidden of ["supabase-admin", "supabase-auth-admin", "server/invitations", "SUPABASE_SERVICE_ROLE_KEY", "N8N_INGEST_TOKEN"]) {
        expect(text.includes(forbidden), `${rel} references ${forbidden}`).toBe(false);
      }
    }
    // the export/search path may never build PostgREST .or() grammar from input
    for (const rel of ["src/app/dashboard/page.tsx", "src/app/api/leads/export/route.ts", "src/lib/server/lead-search.ts"]) {
      const text = readFileSync(path.join(root, rel), "utf8");
      expect(text, rel).not.toMatch(/\.or\(/);
      expect(text, rel).not.toMatch(/\.ilike\(/);
    }
  });
  it("customer team surfaces never touch the service-role client or Auth Admin directly", () => {
    for (const rel of ["src/app/dashboard/team/page.tsx", "src/lib/team-actions.ts", "src/components/app-shell.tsx", "src/components/confirm-form.tsx"]) {
      const text = readFileSync(path.join(root, rel), "utf8");
      for (const forbidden of ["supabase-admin", "supabase-auth-admin", "server/invitations", "SUPABASE_SERVICE_ROLE_KEY", "N8N_INGEST_TOKEN", "inviteUserByEmail", "portal_invitation_id"]) {
        expect(text.includes(forbidden), `${rel} references ${forbidden}`).toBe(false);
      }
    }
    // the team route reaches Auth Admin ONLY through the shared coordinator
    const route = readFileSync(path.join(root, "src/app/api/team/actions/route.ts"), "utf8");
    expect(route.includes("supabase-auth-admin")).toBe(false);
    expect(route.includes("supabase-admin")).toBe(false);
    expect(route.includes("server/invitations")).toBe(true);
  });
  it("recovery surfaces never touch the service-role client, Auth Admin or the invitation coordinator", () => {
    const recoverySurfaces = [
      "src/app/forgot-password/page.tsx",
      "src/app/account/reset-password/page.tsx",
      "src/app/api/auth/password-reset/request/route.ts",
      "src/app/api/account/reset-password/route.ts",
      "src/app/auth/confirm/route.ts",
      "src/lib/password-reset.ts",
      "src/lib/auth-callback.ts",
    ];
    for (const rel of recoverySurfaces) {
      const text = readFileSync(path.join(root, rel), "utf8");
      for (const forbidden of ["supabase-admin", "supabase-auth-admin", "server/invitations", "SUPABASE_SERVICE_ROLE_KEY", "N8N_INGEST_TOKEN"]) {
        expect(text.includes(forbidden), `${rel} references ${forbidden}`).toBe(false);
      }
    }
    // and none of them ever reads a request-controlled redirect target
    for (const rel of recoverySurfaces) {
      const text = readFileSync(path.join(root, rel), "utf8");
      expect(text, rel).not.toMatch(/\.get(?:All)?\(\s*["'](?:next|redirect_to|redirect|callback|return_url|origin)["']\s*\)/);
    }
  });
  it(".env.example never places a secret under NEXT_PUBLIC_ and holds placeholders only", () => {
    const example = readFileSync(path.join(root, ".env.example"), "utf8");
    for (const line of example.split(/\r?\n/).filter((l) => l.startsWith("NEXT_PUBLIC_"))) {
      expect(line).not.toMatch(/SERVICE_ROLE|INGEST_TOKEN|SECRET/);
    }
    expect(example).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\./);
    expect(example).toMatch(/^SUPABASE_SERVICE_ROLE_KEY=replace-with/m);
    expect(example).toMatch(/^N8N_INGEST_TOKEN=replace-with/m);
  });
});
