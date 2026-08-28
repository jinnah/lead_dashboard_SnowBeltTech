import { describe, expect, it } from "vitest";
import { buildLeadCsv, CSV_BOM, csvCell, csvLine, LEAD_CSV_HEADERS, type LeadCsvRow } from "./csv";

describe("csvCell", () => {
  it("passes ordinary safe text through unchanged", () => {
    for (const v of ["INQ-2026-0001", "Test Contact One", "Furnace tune-up", "contact-one@example.invalid", "Zoë Müller 你好", "O'Brien", "50% off deal"]) {
      expect(csvCell(v)).toBe(v);
    }
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
  it("quotes and escapes embedded quotes, commas and line breaks per RFC 4180", () => {
    expect(csvCell('Quote "Q", comma')).toBe('"Quote ""Q"", comma"');
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell("line\r\nbreak")).toBe('"line\r\nbreak"');
    expect(csvCell('""')).toBe('""""""');
  });
  it("removes NUL characters", () => {
    expect(csvCell("a\u0000b")).toBe("ab");
    expect(csvCell("\u0000=cmd()")).toBe("'=cmd()");
  });
  it("neutralizes formula prefixes = + - @ with a leading apostrophe before quoting", () => {
    expect(csvCell("=HYPERLINK(\"http://evil.invalid\",1)")).toBe("\"'=HYPERLINK(\"\"http://evil.invalid\"\",1)\"");
    expect(csvCell("=1+2")).toBe("'=1+2");
    expect(csvCell("+15550100001")).toBe("'+15550100001");
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell("@cmd|calc")).toBe("'@cmd|calc");
  });
  it("neutralizes whitespace-prefixed formulas (space, tab, CR, LF); the apostrophe lands before the whitespace", () => {
    expect(csvCell(" =SUM(A1:A9)")).toBe("' =SUM(A1:A9)");
    expect(csvCell("\t-2+3")).toBe("'\t-2+3");
    expect(csvCell("\r\n@cmd")).toBe("\"'\r\n@cmd\"");
    expect(csvCell("\n+1234567890")).toBe("\"'\n+1234567890\"");
    expect(csvCell("  ok")).toBe('"  ok"'); // plain leading whitespace still quoted, not neutralized
  });
  it("does not treat interior formula characters as dangerous", () => {
    expect(csvCell("a=b")).toBe("a=b");
    expect(csvCell("Duct + vent cleaning")).toBe("Duct + vent cleaning");
    expect(csvCell("mail@example.invalid")).toBe("mail@example.invalid");
  });
});

describe("buildLeadCsv", () => {
  const row: LeadCsvRow = {
    lead_number: "INQ-2026-0001",
    created_at: "2026-08-21T12:34:56.789Z",
    contact_name: "Test Contact One",
    phone_e164: "+15550100001",
    email: "contact-one@example.invalid",
    requested_service: "Furnace tune-up",
    source: "website_form",
    status: "new",
    urgency: "urgent",
    assigned_to: "a1000000-0000-4000-8000-000000000002",
    follow_up_at: null,
    review_recommended: true,
  };
  it("emits BOM, the exact fixed header, CRLF endings and a trailing CRLF", () => {
    const csv = buildLeadCsv([row], () => "Manager A (synthetic)");
    expect(csv.startsWith(CSV_BOM + "Lead Number,Submitted At UTC,")).toBe(true);
    expect(CSV_BOM).toBe("\uFEFF");
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe(csvLine(LEAD_CSV_HEADERS));
    expect(lines[0]).toBe("Lead Number,Submitted At UTC,Contact Name,Phone,Email,Requested Service,Source,Status,Urgency,Assigned To,Follow Up At UTC,Review Recommended");
    expect(lines.length).toBe(3); // header + row + trailing empty
    expect(lines[2]).toBe("");
    expect(csv.includes("\n") && !csv.includes("\n\r")).toBe(true);
    expect(csv.split("\r\n").length).toBe(3);
  });
  it("renders rows with UTC timestamps, labels, neutralized phone and resolved assignee", () => {
    const csv = buildLeadCsv([row], () => "Manager A (synthetic)");
    const dataLine = csv.slice(1).split("\r\n")[1]!;
    expect(dataLine).toBe(
      "INQ-2026-0001,2026-08-21T12:34:56.789Z,Test Contact One,'+15550100001,contact-one@example.invalid,Furnace tune-up,Website,New,Urgent,Manager A (synthetic),,Yes",
    );
  });
  it("uses Unassigned for missing assignees and never emits UUIDs", () => {
    const csv = buildLeadCsv([{ ...row, assigned_to: null, review_recommended: false }], () => "should-not-be-called");
    expect(csv).toContain("Unassigned");
    expect(csv).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(csv).toContain(",No\r\n");
  });
});
