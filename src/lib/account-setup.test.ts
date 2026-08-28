import { describe, expect, it } from "vitest";
import { ACCOUNT_SETUP_MESSAGES, parseAccountSetup, PASSWORD_MAX, PASSWORD_MIN } from "./account-setup";

// The /auth/confirm callback query parser lives in src/lib/auth-callback.ts
// (see auth-callback.test.ts); this file covers the shared password parser
// used by both /account/setup and /account/reset-password.
const p = (s: string) => parseAccountSetup(new URLSearchParams(s));
const GOOD = "correct-horse-battery";

describe("initial password parsing", () => {
  it("accepts exactly one matching pair within bounds", () => {
    expect(p(`password=${GOOD}&password_confirm=${GOOD}`)).toEqual({ ok: true, password: GOOD });
    const min = "p".repeat(PASSWORD_MIN);
    expect(p(`password=${min}&password_confirm=${min}`)).toEqual({ ok: true, password: min });
    const max = "p".repeat(PASSWORD_MAX);
    expect(p(`password=${max}&password_confirm=${max}`)).toEqual({ ok: true, password: max });
  });
  it("rejects missing, duplicate and unexpected fields", () => {
    expect(p("")).toEqual({ ok: false, error: "missing_field" });
    expect(p(`password=${GOOD}`)).toEqual({ ok: false, error: "missing_field" });
    expect(p(`password_confirm=${GOOD}`)).toEqual({ ok: false, error: "missing_field" });
    expect(p(`password=${GOOD}&password=${GOOD}&password_confirm=${GOOD}`)).toEqual({ ok: false, error: "duplicate_field" });
    expect(p(`password=${GOOD}&password_confirm=${GOOD}&password_confirm=${GOOD}`)).toEqual({ ok: false, error: "duplicate_field" });
    for (const extra of ["email=a@b.invalid", "action=set", "user_id=x", "redirect_to=https://evil.invalid"]) {
      expect(p(`password=${GOOD}&password_confirm=${GOOD}&${extra}`), extra).toEqual({ ok: false, error: "unexpected_field" });
    }
  });
  it("enforces length boundaries and matching", () => {
    const short = "p".repeat(PASSWORD_MIN - 1);
    expect(p(`password=${short}&password_confirm=${short}`)).toEqual({ ok: false, error: "password_too_short" });
    const long = "p".repeat(PASSWORD_MAX + 1);
    expect(p(`password=${long}&password_confirm=${long}`)).toEqual({ ok: false, error: "password_too_long" });
    expect(p(`password=${GOOD}&password_confirm=${GOOD}x`)).toEqual({ ok: false, error: "password_mismatch" });
    expect(p(`password=${GOOD}&password_confirm=`)).toEqual({ ok: false, error: "password_mismatch" });
  });
  it("has an allow-listed message for every outcome and never echoes values", () => {
    for (const msg of Object.values(ACCOUNT_SETUP_MESSAGES)) {
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).not.toMatch(/sql|token|jwt|secret/i);
    }
  });
});
