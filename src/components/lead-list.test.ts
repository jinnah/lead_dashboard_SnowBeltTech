import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LEAD_STATUSES } from "@/lib/access";
import { STATUS_LABELS } from "@/lib/format";
import { LeadList, type LeadListRow } from "./lead-list";

const lead = (n: number): LeadListRow => ({
  id: `aa000000-0000-4000-8000-00000000000${n}`,
  lead_number: `INQ-2026-000${n}`,
  contact_name: `Test Contact ${n}`,
  phone_e164: null,
  email: null,
  requested_service: null,
  source: "manual",
  status: "new",
  urgency: "normal",
  review_recommended: false,
  created_at: "2026-08-21T12:00:00Z",
  assigned_to: null,
});

const render = (props: Partial<Parameters<typeof LeadList>[0]>) =>
  renderToStaticMarkup(
    createElement(LeadList, {
      leads: [lead(1), lead(2)],
      timeZoneFor: () => "UTC",
      assigneeName: () => "Somebody",
      linkBase: "/dashboard/leads",
      emptyText: "empty",
      ...props,
    }),
  );

describe("lead list action link", () => {
  it("renders ONE semantic View / update link per lead cell with an accessible lead-specific name", () => {
    const html = render({ actionLabel: "View / update" });
    for (const n of [1, 2]) {
      // table cell + mobile card = two renderings of the same single link
      const links = html.split(`aria-label="View or update lead INQ-2026-000${n}"`).length - 1;
      expect(links).toBe(2);
      expect(html).toContain(`href="/dashboard/leads/aa000000-0000-4000-8000-00000000000${n}"`);
    }
    expect(html).toContain("View / update");
    expect(html).toContain("lead-open__hint");
    // the number and the action live in the SAME anchor - no duplicate links to one destination
    const anchors = html.match(/<a\b[^>]*href="\/dashboard\/leads\/aa000000-0000-4000-8000-000000000001"/g) ?? [];
    expect(anchors.length).toBe(2); // once in the table, once in the card
    expect(html).toMatch(/<a class="lead-open" href="\/dashboard\/leads\/[0-9a-f-]{36}" aria-label="View or update lead INQ-2026-0001"><strong>INQ-2026-0001<\/strong><span class="lead-open__hint" aria-hidden="true">View \/ update<\/span><\/a>/);
  });
  it("keeps the plain link when no action label is given (administrator surfaces unchanged)", () => {
    const html = render({ linkBase: "/admin/leads" });
    expect(html).not.toContain("View / update");
    expect(html).not.toContain("lead-open");
    expect(html).toContain('href="/admin/leads/aa000000-0000-4000-8000-000000000001"');
  });
});

describe("canonical status model", () => {
  it("contains exactly the seven reviewed statuses, once each, in the intended order", () => {
    expect([...LEAD_STATUSES]).toEqual(["new", "contacted", "qualified", "scheduled", "won", "lost", "spam"]);
    expect(new Set(LEAD_STATUSES).size).toBe(7);
    expect(LEAD_STATUSES.map((s) => STATUS_LABELS[s])).toEqual(["New", "Contacted", "Qualified", "Scheduled", "Won", "Lost", "Spam"]);
  });
});
