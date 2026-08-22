import { vi } from "vitest";

// `server-only` throws when imported outside a React Server Components
// environment, which is exactly the guarantee we want in the app. For unit
// tests running in plain Node, neutralise it; the guard itself is asserted by
// src/lib/server/server-only.test.ts reading the source files.
vi.mock("server-only", () => ({}));
