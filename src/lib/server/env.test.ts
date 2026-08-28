import { describe, expect, it } from "vitest";
import { DEFAULT_APP_BASE_URL, isValidAppBaseUrl } from "./env";

describe("canonical application base URL", () => {
  it("accepts only bare http(s) origins", () => {
    expect(isValidAppBaseUrl(DEFAULT_APP_BASE_URL)).toBe(true);
    expect(isValidAppBaseUrl("http://127.0.0.1:3000")).toBe(true);
    expect(isValidAppBaseUrl("https://portal.snowbelttech.com")).toBe(true);
  });
  it("rejects paths, queries, fragments, credentials, trailing slashes and junk", () => {
    for (const v of [
      "http://127.0.0.1:3000/", "http://127.0.0.1:3000/app", "http://127.0.0.1:3000?x=1", "http://127.0.0.1:3000#f",
      "http://user:pw@127.0.0.1:3000", "ftp://127.0.0.1", "127.0.0.1:3000", "", " http://127.0.0.1:3000",
      "http://127.0.0.1:3000 ", "javascript:alert(1)", "//127.0.0.1:3000",
    ]) {
      expect(isValidAppBaseUrl(v), v).toBe(false);
    }
  });
});
