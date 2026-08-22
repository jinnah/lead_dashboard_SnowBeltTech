import { describe, expect, it } from "vitest";
import { isValidTimeZone, localToUtc, utcToLocalParts } from "./timezone";

const NY = "America/New_York";
const ok = (r: ReturnType<typeof localToUtc>) => (r.ok ? r.date.toISOString() : `ERR:${r.reason}`);

describe("localToUtc", () => {
  it("converts standard and daylight times in America/New_York", () => {
    expect(ok(localToUtc("2026-01-15", "09:30", NY))).toBe("2026-01-15T14:30:00.000Z"); // EST -5
    expect(ok(localToUtc("2026-07-15", "09:30", NY))).toBe("2026-07-15T13:30:00.000Z"); // EDT -4
    expect(ok(localToUtc("2026-07-15", "00:00", NY))).toBe("2026-07-15T04:00:00.000Z");
    expect(ok(localToUtc("2026-07-15", "23:59", NY))).toBe("2026-07-16T03:59:00.000Z");
  });
  it("rejects the nonexistent spring-forward time and accepts its neighbours", () => {
    // 2026-03-08 02:00-02:59 does not exist in New York
    expect(ok(localToUtc("2026-03-08", "02:30", NY))).toBe("ERR:nonexistent_time");
    expect(ok(localToUtc("2026-03-08", "01:59", NY))).toBe("2026-03-08T06:59:00.000Z");
    expect(ok(localToUtc("2026-03-08", "03:00", NY))).toBe("2026-03-08T07:00:00.000Z");
  });
  it("resolves the ambiguous fall-back time to the first (earlier, EDT) occurrence", () => {
    // 2026-11-01 01:30 occurs twice: 05:30Z (EDT) and 06:30Z (EST)
    expect(ok(localToUtc("2026-11-01", "01:30", NY))).toBe("2026-11-01T05:30:00.000Z");
    expect(ok(localToUtc("2026-11-01", "02:30", NY))).toBe("2026-11-01T07:30:00.000Z");
  });
  it("works in UTC and other zones", () => {
    expect(ok(localToUtc("2026-08-21", "12:00", "UTC"))).toBe("2026-08-21T12:00:00.000Z");
    expect(ok(localToUtc("2026-08-21", "12:00", "America/Chicago"))).toBe("2026-08-21T17:00:00.000Z");
  });
  it("rejects malformed input and invalid zones", () => {
    expect(ok(localToUtc("2026-13-01", "10:00", NY))).toBe("ERR:invalid_date");
    expect(ok(localToUtc("2026-02-30", "10:00", NY))).toBe("ERR:invalid_date");
    expect(ok(localToUtc("21/08/2026", "10:00", NY))).toBe("ERR:invalid_date");
    expect(ok(localToUtc("2026-08-21", "25:00", NY))).toBe("ERR:invalid_time");
    expect(ok(localToUtc("2026-08-21", "9am", NY))).toBe("ERR:invalid_time");
    expect(ok(localToUtc("2026-08-21", "10:00", "Mars/Olympus"))).toBe("ERR:invalid_timezone");
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone(NY)).toBe(true);
  });
  it("round-trips through utcToLocalParts", () => {
    const r = localToUtc("2026-11-20", "16:45", NY);
    expect(r.ok && utcToLocalParts(r.date.toISOString(), NY)).toEqual({ date: "2026-11-20", time: "16:45" });
    expect(utcToLocalParts("not a date", NY)).toBeNull();
  });
});
