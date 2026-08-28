import { describe, expect, it } from "vitest";
import { parseAuthConfirmCallback } from "./auth-callback";

const p = (qs: string) => parseAuthConfirmCallback(new URLSearchParams(qs));
const TOKEN = "a".repeat(24);

describe("auth confirm callback validation", () => {
  it("accepts exactly token_hash + type for both allow-listed types", () => {
    expect(p(`token_hash=${TOKEN}&type=invite`)).toEqual({ ok: true, type: "invite", tokenHash: TOKEN });
    expect(p(`token_hash=${TOKEN}&type=recovery`)).toEqual({ ok: true, type: "recovery", tokenHash: TOKEN });
    expect(p(`type=recovery&token_hash=pkce_0123456789abcdef-_A`)).toMatchObject({ ok: true, type: "recovery" });
  });
  it("rejects every non-allow-listed type", () => {
    for (const type of ["email", "magiclink", "signup", "email_change", "sms", "", "INVITE", "RECOVERY", "invite%20", " recovery"]) {
      expect(p(`token_hash=${TOKEN}&type=${encodeURIComponent(type)}`), type).toMatchObject({ ok: false });
    }
    expect(p(`token_hash=${TOKEN}`)).toEqual({ ok: false, errorTarget: "invite" });
  });
  it("rejects malformed, short and oversized tokens", () => {
    for (const token of ["", "short", "a".repeat(15), "a".repeat(513), "bad token", "tok<script>", "tok%2Fslash", "tok/slash", "tok.dot"]) {
      expect(p(`token_hash=${encodeURIComponent(token)}&type=invite`), token).toEqual({ ok: false, errorTarget: "invite" });
      expect(p(`token_hash=${encodeURIComponent(token)}&type=recovery`), token).toEqual({ ok: false, errorTarget: "recovery" });
    }
    expect(p("type=invite")).toEqual({ ok: false, errorTarget: "invite" });
    expect(p("type=recovery")).toEqual({ ok: false, errorTarget: "recovery" });
    expect(p("")).toEqual({ ok: false, errorTarget: "invite" });
  });
  it("rejects duplicated parameters", () => {
    expect(p(`token_hash=${TOKEN}&token_hash=${TOKEN}&type=invite`)).toEqual({ ok: false, errorTarget: "invite" });
    expect(p(`token_hash=${TOKEN}&type=recovery&type=recovery`)).toEqual({ ok: false, errorTarget: "invite" });
    expect(p(`token_hash=${TOKEN}&type=invite&type=recovery`)).toEqual({ ok: false, errorTarget: "invite" });
  });
  it("rejects unexpected parameters instead of ignoring them - no request-controlled redirect exists", () => {
    for (const extra of ["next=https://evil.invalid", "redirect_to=https://evil.invalid", "callback=//evil.invalid", "origin=x", "return_url=/admin", "business_id=x", "email=a@b.invalid"]) {
      expect(p(`token_hash=${TOKEN}&type=invite&${extra}`), extra).toEqual({ ok: false, errorTarget: "invite" });
      expect(p(`token_hash=${TOKEN}&type=recovery&${extra}`), extra).toEqual({ ok: false, errorTarget: "recovery" });
    }
  });
  it("chooses the recovery error target only for an unambiguous recovery type", () => {
    expect(p(`type=recovery&next=x`)).toEqual({ ok: false, errorTarget: "recovery" });
    expect(p(`type=invite&next=x`)).toEqual({ ok: false, errorTarget: "invite" });
    expect(p(`type=unknown&next=x`)).toEqual({ ok: false, errorTarget: "invite" });
  });
});
