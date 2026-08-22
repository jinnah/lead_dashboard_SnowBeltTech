import { STATUS_LABELS, formatDateTime, label } from "@/lib/format";

export interface ActivityRow {
  id: string;
  activity_type: "status_changed" | "follow_up_changed" | "note_added";
  old_value: string | null;
  new_value: string | null;
  note: string | null;
  actor_display_name: string | null;
  created_at: string;
}

function describe(a: ActivityRow, tz: string): string {
  switch (a.activity_type) {
    case "status_changed":
      return `Status changed from ${label(STATUS_LABELS, a.old_value)} to ${label(STATUS_LABELS, a.new_value)}`;
    case "follow_up_changed":
      if (!a.new_value) return `Follow-up cleared (was ${formatDateTime(a.old_value, tz)})`;
      if (!a.old_value) return `Follow-up scheduled for ${formatDateTime(a.new_value, tz)}`;
      return `Follow-up moved from ${formatDateTime(a.old_value, tz)} to ${formatDateTime(a.new_value, tz)}`;
    case "note_added":
      return "Note";
  }
}

export function ActivityTimeline({ activities, timeZone }: { activities: ActivityRow[]; timeZone: string }) {
  if (activities.length === 0) return <p className="muted">No activity yet.</p>;
  return (
    <ol className="timeline">
      {activities.map((a) => (
        <li key={a.id} className={`timeline__item timeline__item--${a.activity_type}`}>
          <div className="timeline__meta">
            <span className="timeline__who">{a.actor_display_name ?? "System"}</span>
            <time dateTime={a.created_at}>{formatDateTime(a.created_at, timeZone)}</time>
          </div>
          <div className="timeline__what">{describe(a, timeZone)}</div>
          {/* Notes are rendered as text nodes only — never interpreted as HTML. */}
          {a.activity_type === "note_added" && a.note ? <p className="timeline__note pre">{a.note}</p> : null}
        </li>
      ))}
    </ol>
  );
}
