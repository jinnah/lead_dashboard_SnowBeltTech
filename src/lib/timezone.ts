// Business-timezone wall-clock <-> UTC conversion using only Intl (no library).
// Deterministic DST handling: a nonexistent local time (spring-forward gap) is
// rejected; an ambiguous local time (fall-back overlap) resolves to the EARLIER
// instant (the first occurrence, i.e. still on daylight time).

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{2}):(\d{2})$/;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock components of an instant in a zone. */
function wallClock(instantMs: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(instantMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour") % 24, mi: get("minute") };
}

/** Offset (ms) of the zone at an instant: local wall-clock as UTC minus the instant. */
function offsetAt(instantMs: number, tz: string): number {
  const w = wallClock(instantMs, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - instantMs;
}

export type LocalToUtcResult = { ok: true; date: Date } | { ok: false; reason: "invalid_date" | "invalid_time" | "invalid_timezone" | "nonexistent_time" };

/** Converts a business-local date + HH:MM into the UTC instant. */
export function localToUtc(dateStr: string, timeStr: string, tz: string): LocalToUtcResult {
  const dm = DATE.exec(dateStr ?? "");
  const tm = TIME.exec(timeStr ?? "");
  if (!dm) return { ok: false, reason: "invalid_date" };
  if (!tm) return { ok: false, reason: "invalid_time" };
  if (!isValidTimeZone(tz)) return { ok: false, reason: "invalid_timezone" };
  const [y, mo, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
  const [h, mi] = [Number(tm[1]), Number(tm[2])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return { ok: false, reason: dm && (mo < 1 || mo > 12 || d < 1 || d > 31) ? "invalid_date" : "invalid_time" };
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  const probe = new Date(asUtc);
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return { ok: false, reason: "invalid_date" };

  // Candidate instants using the offsets in force shortly before and after the target.
  const candidates = new Set<number>();
  for (const guess of [asUtc - 24 * 3600e3, asUtc, asUtc + 24 * 3600e3]) {
    candidates.add(asUtc - offsetAt(guess, tz));
  }
  const valid = [...candidates]
    .filter((inst) => {
      const w = wallClock(inst, tz);
      return w.y === y && w.mo === mo && w.d === d && w.h === h && w.mi === mi;
    })
    .sort((a, b) => a - b);
  const first = valid[0];
  if (first === undefined) return { ok: false, reason: "nonexistent_time" };
  return { ok: true, date: new Date(first) };
}

/** Splits an instant into the business-local date and HH:MM strings (for form defaults). */
export function utcToLocalParts(iso: string, tz: string): { date: string; time: string } | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms) || !isValidTimeZone(tz)) return null;
  const w = wallClock(ms, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return { date: `${w.y}-${pad(w.mo)}-${pad(w.d)}`, time: `${pad(w.h)}:${pad(w.mi)}` };
}
