import "server-only";

// Server-only configuration. Read lazily and validated; never logged.
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface ServerEnv {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  n8nIngestToken: string;
}

function required(name: string, min: number): string {
  const v = process.env[name];
  if (typeof v !== "string" || v.trim() === "") throw new ConfigError(`${name} is not configured`);
  if (v.length < min) throw new ConfigError(`${name} is too short`);
  if (v !== v.trim()) throw new ConfigError(`${name} has surrounding whitespace`);
  return v;
}

/**
 * Canonical application base URL (server-only; NOT a secret). Used to build
 * invitation redirects; browser-supplied Host/Origin/Referer values are never
 * consulted. Must be a bare http(s) origin: no path, query, fragment,
 * credentials or trailing slash.
 */
export const DEFAULT_APP_BASE_URL = "http://127.0.0.1:3000";

export function isValidAppBaseUrl(value: string): boolean {
  if (value !== value.trim() || value === "" || value.endsWith("/")) return false;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  return (
    (u.protocol === "http:" || u.protocol === "https:")
    && u.username === "" && u.password === ""
    && u.pathname === "/" && u.search === "" && u.hash === ""
    && u.origin === value
  );
}

export function getAppBaseUrl(): string {
  const configured = process.env.APP_BASE_URL ?? DEFAULT_APP_BASE_URL;
  if (!isValidAppBaseUrl(configured)) throw new ConfigError("APP_BASE_URL must be a bare http(s) origin");
  return configured;
}

export function getServerEnv(): ServerEnv {
  const supabaseUrl = required("SUPABASE_URL", 8);
  let parsed: URL;
  try {
    parsed = new URL(supabaseUrl);
  } catch {
    throw new ConfigError("SUPABASE_URL is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new ConfigError("SUPABASE_URL must be http(s)");
  return {
    supabaseUrl,
    supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY", 20),
    n8nIngestToken: required("N8N_INGEST_TOKEN", 32),
  };
}
