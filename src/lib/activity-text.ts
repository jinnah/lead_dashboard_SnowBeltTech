// Pure, safe descriptions of activity rows (plain strings; React renders them as text).
import { STATUS_LABELS, formatDateTime, label } from "./format";

export interface ActivityRow {
  id: string;
  activity_type: "status_changed" | "follow_up_changed" | "assignment_changed" | "note_added";
  old_value: string | null;
  new_value: string | null;
  old_display_value: string | null;
  new_display_value: string | null;
  note: string | null;
  actor_display_name: string | null;
  created_at: string;
}

export const FORMER_MEMBER = "a former team member";

/** Display name for an assignee in history: stored snapshot, else a safe fallback; never the raw UUID. */
export function assigneeLabel(display: string | null, id: string | null): string {
  if (!id) return "Unassigned";
  const d = display?.trim();
  return d && d.length > 0 ? d : FORMER_MEMBER;
}

export function describeActivity(a: ActivityRow, tz: string): string {
  switch (a.activity_type) {
    case "status_changed":
      return `Status changed from ${label(STATUS_LABELS, a.old_value)} to ${label(STATUS_LABELS, a.new_value)}`;
    case "follow_up_changed":
      if (!a.new_value) return `Follow-up cleared (was ${formatDateTime(a.old_value, tz)})`;
      if (!a.old_value) return `Follow-up scheduled for ${formatDateTime(a.new_value, tz)}`;
      return `Follow-up moved from ${formatDateTime(a.old_value, tz)} to ${formatDateTime(a.new_value, tz)}`;
    case "assignment_changed":
      if (!a.new_value) return `Unassigned (was ${assigneeLabel(a.old_display_value, a.old_value)})`;
      if (!a.old_value) return `Assigned to ${assigneeLabel(a.new_display_value, a.new_value)}`;
      return `Reassigned from ${assigneeLabel(a.old_display_value, a.old_value)} to ${assigneeLabel(a.new_display_value, a.new_value)}`;
    case "note_added":
      return "Note";
  }
}

export function actorLabel(a: ActivityRow): string {
  const d = a.actor_display_name?.trim();
  return d && d.length > 0 ? d : "System";
}
