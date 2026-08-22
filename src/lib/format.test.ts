import { describe, expect, it } from "vitest";
import { formatDateTime } from "./format";

describe("formatDateTime", () => {
  it("renders microsecond-precision UTC audit values (the follow-up audit format)", () => {
    expect(formatDateTime("2032-01-01T14:00:00.900009Z", "America/New_York")).toBe("Jan 1, 2032, 9:00 AM");
    expect(formatDateTime("2032-02-02T10:00:00.000000Z", "UTC")).toBe("Feb 2, 2032, 10:00 AM");
    expect(formatDateTime("2026-09-01T18:00:00.000000Z", "America/New_York")).toBe("Sep 1, 2026, 2:00 PM");
  });
  it("renders plain ISO values, nulls and garbage safely", () => {
    expect(formatDateTime("2026-09-01T18:00:00Z", "America/New_York")).toBe("Sep 1, 2026, 2:00 PM");
    expect(formatDateTime(null, "UTC")).toBe("—");
    expect(formatDateTime("not a date", "UTC")).toBe("—");
  });
});
