import { describe, expect, it } from "vitest";
import { extractBearerToken, isAuthorized, tokensMatch } from "./auth";

const TOKEN = "a".repeat(64);

describe("extractBearerToken", () => {
  it("accepts a single well-formed bearer token", () => {
    expect(extractBearerToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
  });
  it("rejects a missing header", () => {
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken("")).toBeNull();
  });
  it("rejects malformed schemes and grammar", () => {
    expect(extractBearerToken(TOKEN)).toBeNull();
    expect(extractBearerToken(`bearer ${TOKEN}`)).toBeNull();
    expect(extractBearerToken(`Basic ${TOKEN}`)).toBeNull();
    expect(extractBearerToken(`Bearer  ${TOKEN}`)).toBeNull();
    expect(extractBearerToken(`Bearer ${TOKEN} `)).toBeNull();
    expect(extractBearerToken("Bearer short")).toBeNull();
    expect(extractBearerToken(`Bearer ${TOKEN}\n`)).toBeNull();
  });
  it("rejects multiple or ambiguous bearer values", () => {
    expect(extractBearerToken(`Bearer ${TOKEN}, Bearer ${TOKEN}`)).toBeNull();
    expect(extractBearerToken(`Bearer ${TOKEN} Bearer ${TOKEN}`)).toBeNull();
    expect(extractBearerToken(`Bearer ${TOKEN},${TOKEN}`)).toBeNull();
  });
});

describe("tokensMatch", () => {
  it("matches identical tokens and rejects different ones", () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(tokensMatch(TOKEN, "b".repeat(64))).toBe(false);
    expect(tokensMatch(TOKEN, TOKEN.slice(0, 63))).toBe(false);
    expect(tokensMatch(TOKEN + "a", TOKEN)).toBe(false);
  });
  it("compares fixed-length digests so unequal lengths cannot throw or leak", () => {
    expect(() => tokensMatch("x", TOKEN)).not.toThrow();
    expect(tokensMatch("x", TOKEN)).toBe(false);
  });
});

describe("isAuthorized", () => {
  it("accepts only the exact configured token", () => {
    expect(isAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isAuthorized(`Bearer ${"c".repeat(64)}`, TOKEN)).toBe(false);
    expect(isAuthorized(null, TOKEN)).toBe(false);
    expect(isAuthorized(`Bearer ${TOKEN}, Bearer ${TOKEN}`, TOKEN)).toBe(false);
  });
});
