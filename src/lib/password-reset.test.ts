import { describe, expect, it } from "vitest";
import { EMAIL_MAX } from "./admin-actions";
import {
  FORGOT_PASSWORD_MESSAGES,
  parsePasswordResetRequest,
  PASSWORD_RESET_SENT_MESSAGE,
  PASSWORD_RESET_SUCCESS_MESSAGE,
  RECOVERY_LINK_ERROR_MESSAGE,
} from "./password-reset";

const p = (qs: string) => parsePasswordResetRequest(new URLSearchParams(qs));

describe("password reset request parsing", () => {
  it("accepts exactly one email and normalizes it like login/invitations", () => {
    expect(p("email=owner%40example.invalid")).toEqual({ ok: true, email: "owner@example.invalid" });
    expect(p("email=%20%20Owner%40Example.INVALID%20")).toEqual({ ok: true, email: "owner@example.invalid" });
  });
  it("rejects missing and duplicated fields", () => {
    expect(p("")).toEqual({ ok: false, error: "missing_field" });
    expect(p("email=a%40b.invalid&email=b%40c.invalid")).toEqual({ ok: false, error: "duplicate_field" });
  });
  it("rejects unexpected fields instead of ignoring them - no tenant id, user id or redirect is ever accepted", () => {
    for (const extra of [
      "next=/admin", "redirect_to=https://evil.invalid", "callback=https://evil.invalid", "return_url=//evil.invalid",
      "business_id=a0000000-0000-4000-8000-000000000001", "user_id=x", "tenant=alpha", "password=hunter2hunter2",
    ]) {
      expect(p(`email=a%40b.invalid&${extra}`), extra).toEqual({ ok: false, error: "unexpected_field" });
      expect(p(extra), extra).toEqual({ ok: false, error: "unexpected_field" });
    }
  });
  it("enforces the shared email format and length boundary", () => {
    for (const bad of ["", "a@b", "no-at-sign.invalid", "two@@example.invalid", "a b@example.invalid", `${"x".repeat(EMAIL_MAX)}@example.invalid`]) {
      expect(p(`email=${encodeURIComponent(bad)}`), bad).toEqual({ ok: false, error: "invalid_email" });
    }
    const longestLocal = "x".repeat(EMAIL_MAX - "@example.invalid".length);
    expect(p(`email=${longestLocal}%40example.invalid`)).toEqual({ ok: true, email: `${longestLocal}@example.invalid` });
  });
  it("keeps every user-visible message generic - no account existence, email echo, or internals", () => {
    for (const msg of [PASSWORD_RESET_SENT_MESSAGE, RECOVERY_LINK_ERROR_MESSAGE, PASSWORD_RESET_SUCCESS_MESSAGE, ...Object.values(FORGOT_PASSWORD_MESSAGES)]) {
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).not.toMatch(/sql|jwt|secret|supabase|gotrue|@/i);
      expect(msg).not.toMatch(/no account|not found|does not exist|already exists|unknown user/i);
    }
    expect(PASSWORD_RESET_SENT_MESSAGE).toMatch(/^If an eligible account exists/);
  });
});
