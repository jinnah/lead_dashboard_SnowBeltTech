import { defineConfig } from "vitest/config";
import path from "node:path";

// Real HTTP -> local Next.js production server -> local Supabase -> ingest_lead_event.
// Prerequisites: `pnpm run db:start`, `pnpm run env:local`, `pnpm build`.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
