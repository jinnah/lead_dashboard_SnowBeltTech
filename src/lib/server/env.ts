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
