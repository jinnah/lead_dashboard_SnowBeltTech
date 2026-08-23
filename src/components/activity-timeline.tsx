import { actorLabel, describeActivity, type ActivityRow } from "@/lib/activity-text";
import { formatDateTime } from "@/lib/format";

export type { ActivityRow } from "@/lib/activity-text";
export const ACTIVITY_COLUMNS = "id, activity_type, old_value, new_value, old_display_value, new_display_value, note, actor_display_name, created_at";

export function ActivityTimeline({ activities, timeZone }: { activities: ActivityRow[]; timeZone: string }) {
  if (activities.length === 0) return <p className="muted">No activity yet.</p>;
  return (
    <ol className="timeline">
      {activities.map((a) => (
        <li key={a.id} className={`timeline__item timeline__item--${a.activity_type}`}>
          <div className="timeline__meta">
            <span className="timeline__who">{actorLabel(a)}</span>
            <time dateTime={a.created_at}>{formatDateTime(a.created_at, timeZone)}</time>
          </div>
          <div className="timeline__what">{describeActivity(a, timeZone)}</div>
          {/* Notes are rendered as text nodes only — never interpreted as HTML. */}
          {a.activity_type === "note_added" && a.note ? <p className="timeline__note pre">{a.note}</p> : null}
        </li>
      ))}
    </ol>
  );
}
