// Pure parsing for the /auth/confirm email callback. No I/O; the token is only
// ever forwarded to Supabase verifyOtp — never logged, stored or reflected.

/** Bounded URL-safe token hash shape shared by invite and recovery links. */
const TOKEN_HASH_RE = /^[A-Za-z0-9_-]{16,512}$/;

export const AUTH_CONFIRM_TYPES = ["invite", "recovery"] as const;
export type AuthConfirmType = (typeof AUTH_CONFIRM_TYPES)[number];

export type AuthConfirmParse =
  | { ok: true; type: AuthConfirmType; tokenHash: string }
  | { ok: false; errorTarget: AuthConfirmType };

/**
 * Validates the complete /auth/confirm query. Exactly two parameters are
 * accepted — one `token_hash` (bounded, URL-safe) and one allow-listed `type`
 * (`invite` or `recovery`). Anything else — duplicated parameters, unexpected
 * parameters (`next`, `redirect_to`, callbacks, …), unknown types, malformed
 * tokens — is rejected without detail. There is no browser-controlled redirect
 * target anywhere in this flow. `errorTarget` only selects which GENERIC login
 * error page a rejection lands on (recovery links get the recovery wording);
 * it never affects verification.
 */
export function parseAuthConfirmCallback(params: URLSearchParams): AuthConfirmParse {
  const types = params.getAll("type");
  const errorTarget: AuthConfirmType = types.length === 1 && types[0] === "recovery" ? "recovery" : "invite";
  for (const key of params.keys()) {
    if (key !== "token_hash" && key !== "type") return { ok: false, errorTarget };
  }
  const tokens = params.getAll("token_hash");
  if (types.length !== 1 || tokens.length !== 1) return { ok: false, errorTarget };
  const type = types[0]!;
  if (type !== "invite" && type !== "recovery") return { ok: false, errorTarget };
  const tokenHash = tokens[0]!;
  if (!TOKEN_HASH_RE.test(tokenHash)) return { ok: false, errorTarget };
  return { ok: true, type, tokenHash };
}
