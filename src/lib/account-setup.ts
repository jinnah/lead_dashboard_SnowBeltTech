// Pure parsing for initial account setup (and password reset — the same
// password policy applies to both, on purpose). No I/O; passwords never leave
// the function results and are never logged. The /auth/confirm callback query
// itself is parsed by src/lib/auth-callback.ts.

export const PASSWORD_MIN = 12;   // matches supabase/config.toml minimum_password_length
export const PASSWORD_MAX = 128;

export type AccountSetupError = "missing_field" | "duplicate_field" | "unexpected_field" | "password_too_short" | "password_too_long" | "password_mismatch";

export const ACCOUNT_SETUP_MESSAGES: Record<AccountSetupError | "failed" | "not_ready", string> = {
  missing_field: "Fill in both password fields.",
  duplicate_field: "The request was ambiguous. Please submit the form again.",
  unexpected_field: "The request contained unexpected data.",
  password_too_short: `Choose a password of at least ${PASSWORD_MIN} characters.`,
  password_too_long: `Passwords are limited to ${PASSWORD_MAX} characters.`,
  password_mismatch: "The two passwords do not match.",
  failed: "The password could not be set. Please try again.",
  not_ready: "Your invitation could not be verified. Follow the invitation link again or contact your administrator.",
};

/** Exactly one `password` and one `password_confirm`; nothing else. */
export function parseAccountSetup(fields: URLSearchParams): { ok: true; password: string } | { ok: false; error: AccountSetupError } {
  for (const key of fields.keys()) if (key !== "password" && key !== "password_confirm") return { ok: false, error: "unexpected_field" };
  const passwords = fields.getAll("password");
  const confirms = fields.getAll("password_confirm");
  if (passwords.length > 1 || confirms.length > 1) return { ok: false, error: "duplicate_field" };
  if (passwords.length === 0 || confirms.length === 0) return { ok: false, error: "missing_field" };
  const password = passwords[0]!;
  if (password.length < PASSWORD_MIN) return { ok: false, error: "password_too_short" };
  if (password.length > PASSWORD_MAX) return { ok: false, error: "password_too_long" };
  if (password !== confirms[0]) return { ok: false, error: "password_mismatch" };
  return { ok: true, password };
}
