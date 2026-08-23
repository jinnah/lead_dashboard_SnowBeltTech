// Pure parsing of the lead-action form contract (no I/O, no secrets).
import { LEAD_STATUSES, allowlisted } from "./access";
import { localToUtc } from "./timezone";

export const ACTIONS = ["set_status", "set_follow_up", "clear_follow_up", "add_note", "set_assignee"] as const;
export type ActionName = (typeof ACTIONS)[number];

/** Fields allowed per action. Anything else is rejected, never ignored. */
export const ACTION_FIELDS: Record<ActionName, readonly string[]> = {
  set_status: ["action", "status"],
  set_follow_up: ["action", "date", "time"],
  clear_follow_up: ["action"],
  add_note: ["action", "note", "request_id"],
  set_assignee: ["action", "assignee_id"],
};

export const NOTE_MAX = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ANY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ParsedAction =
  | { kind: "set_status"; status: (typeof LEAD_STATUSES)[number] }
  | { kind: "set_follow_up"; at: Date }
  | { kind: "clear_follow_up" }
  | { kind: "add_note"; note: string; requestId: string }
  | { kind: "set_assignee"; assigneeId: string | null };

export type ActionError =
  | "unsupported_action" | "unexpected_field" | "invalid_status" | "invalid_follow_up" | "nonexistent_time"
  | "invalid_note" | "invalid_request_id" | "invalid_assignee";

export const ERROR_MESSAGES: Record<ActionError | "not_found" | "failed" | "not_allowed" | "assignment_rejected", string> = {
  unsupported_action: "That action is not supported.",
  unexpected_field: "The request contained unexpected data.",
  invalid_status: "Choose a valid status.",
  invalid_follow_up: "Enter a valid follow-up date and time.",
  nonexistent_time: "That time does not exist on that date in your business timezone (daylight-saving change). Pick another time.",
  invalid_note: "Notes must be between 1 and 2,000 characters.",
  invalid_request_id: "Please reload the page and try again.",
  invalid_assignee: "Choose a team member from the list.",
  not_allowed: "Only business owners and managers can change assignments.",
  assignment_rejected: "The assignment could not be applied. Choose an active team member and try again.",
  not_found: "That lead is not available.",
  failed: "The change could not be saved. Please try again.",
};

export const OK_MESSAGES: Record<ActionName, string> = {
  set_status: "Status updated.",
  set_follow_up: "Follow-up scheduled.",
  clear_follow_up: "Follow-up cleared.",
  add_note: "Note added.",
  set_assignee: "Assignment updated.",
};

export function parseLeadAction(fields: URLSearchParams, businessTimeZone: string): { ok: true; action: ParsedAction } | { ok: false; error: ActionError } {
  const name = fields.get("action");
  if (!name || !(ACTIONS as readonly string[]).includes(name)) return { ok: false, error: "unsupported_action" };
  const action = name as ActionName;
  for (const key of fields.keys()) if (!ACTION_FIELDS[action].includes(key)) return { ok: false, error: "unexpected_field" };

  switch (action) {
    case "set_status": {
      const status = allowlisted(LEAD_STATUSES, fields.get("status"));
      return status ? { ok: true, action: { kind: "set_status", status } } : { ok: false, error: "invalid_status" };
    }
    case "set_follow_up": {
      const r = localToUtc(fields.get("date") ?? "", fields.get("time") ?? "", businessTimeZone);
      if (r.ok) return { ok: true, action: { kind: "set_follow_up", at: r.date } };
      return { ok: false, error: r.reason === "nonexistent_time" ? "nonexistent_time" : "invalid_follow_up" };
    }
    case "clear_follow_up":
      return { ok: true, action: { kind: "clear_follow_up" } };
    case "add_note": {
      const note = (fields.get("note") ?? "").trim();
      const requestId = fields.get("request_id") ?? "";
      if (!UUID.test(requestId)) return { ok: false, error: "invalid_request_id" };
      if (note.length < 1 || note.length > NOTE_MAX) return { ok: false, error: "invalid_note" };
      return { ok: true, action: { kind: "add_note", note, requestId } };
    }
    case "set_assignee": {
      const raw = (fields.get("assignee_id") ?? "").trim();
      if (raw === "") return { ok: true, action: { kind: "set_assignee", assigneeId: null } };
      if (!ANY_UUID.test(raw)) return { ok: false, error: "invalid_assignee" };
      return { ok: true, action: { kind: "set_assignee", assigneeId: raw.toLowerCase() } };
    }
  }
}
