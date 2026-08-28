// Pure parsing and allow-listed messages for the local password-recovery
// workflow. No I/O; emails and passwords never leave the function results and
// are never logged. Password parsing itself is shared with the invitation
// flow (parseAccountSetup) so there is exactly one password policy.

import { normalizeInviteEmail } from "@/lib/admin-actions";

export type PasswordResetRequestError = "missing_field" | "duplicate_field" | "unexpected_field" | "invalid_email";

/**
 * Exactly one `email` field; nothing else. Unexpected fields — including any
 * `next`, `redirect_to`, callback URL, tenant or user identifier — are
 * rejected, never ignored or used. The email is normalized exactly like
 * login/invitation handling (trimmed, lowercased, bounded at 320 chars).
 * Whether an ACCOUNT exists for the email is never part of this result.
 */
export function parsePasswordResetRequest(fields: URLSearchParams): { ok: true; email: string } | { ok: false; error: PasswordResetRequestError } {
  for (const key of fields.keys()) if (key !== "email") return { ok: false, error: "unexpected_field" };
  const emails = fields.getAll("email");
  if (emails.length > 1) return { ok: false, error: "duplicate_field" };
  if (emails.length === 0) return { ok: false, error: "missing_field" };
  const email = normalizeInviteEmail(emails[0]!);
  if (!email) return { ok: false, error: "invalid_email" };
  return { ok: true, email };
}

/** The one generic outcome every well-formed request receives — account or not. */
export const PASSWORD_RESET_SENT_MESSAGE =
  "If an eligible account exists for that email, password-reset instructions have been sent.";

export const FORGOT_PASSWORD_MESSAGES: Record<PasswordResetRequestError, string> = {
  missing_field: "Enter your email address.",
  duplicate_field: "The request was ambiguous. Please submit the form again.",
  unexpected_field: "The request contained unexpected data.",
  invalid_email: "Enter a valid email address (up to 320 characters).",
};

/** Generic recovery-link failure — identical for invalid, expired, replayed, forged and wrong-type links. */
export const RECOVERY_LINK_ERROR_MESSAGE =
  "That password reset link is invalid or has expired. You can request a new one.";

/** Neutral post-reset notice shown on the login page. */
export const PASSWORD_RESET_SUCCESS_MESSAGE =
  "Your password has been updated. Sign in with your new password.";
