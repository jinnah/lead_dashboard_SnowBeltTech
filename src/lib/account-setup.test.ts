import { describe, expect, it } from "vitest";
import { ACCOUNT_SETUP_MESSAGES, parseAccountSetup, parseInviteCallback, PASSWORD_MAX, PASSWORD_MIN } from "./account-setup";

const p = (s: string) => parseAccountSetup(new URLSearchParams(s));
const GOOD = "correct-horse-battery";

describe("invitation callback validation", () => {
  it("accepts only type=invite with a bounded URL-safe token hash", () => {
    expect(parseInviteCallback("a".repeat(24), "invite")).toEqual({ ok: true, tokenHash: "a".repeat(24) });
    expect(parseInviteCallback("pkce_0123456789abcdef-_A", "invite")).toMatchObject({ ok: true });
  });
  it("rejects every other type, missing values and malformed or oversized tokens", () => {
    for (const type of ["recovery", "email", "magiclink", "signup", "email_change", "", null, "INVITE"]) {
      expect(parseInviteCallback("a".repeat(24), type), String(type)).toEqual({ ok: false });
    }
    for (const token of [null, "", "short", "a".repeat(513), "bad token", "tok<script>", "tok%2Fslash", "tok/slash"]) {
      expect(parseInviteCallback(token, "invite"), String(token)).toEqual({ ok: false });
    }
  });
});

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
