import { defineConfig } from "vitest/config";
import path from "node:path";

// Unit tests only (no server, no database). Integration tests use vitest.integration.config.ts.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test/setup-unit.ts"],
  },
});
