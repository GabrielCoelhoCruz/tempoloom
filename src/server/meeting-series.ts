// Recurring meetings the user organizes that can become flexible meetings
// (meetings-flexible.md rules 1 and 3; planning-notifications.md NTF-30).
import { createHash } from "node:crypto";
import { type LocalDate, utcToLocal, weekdayOf } from "../shared/time.ts";
import { all, type Db, one } from "./db.ts";

export interface Series {
  /** A short stable id for links: /meetings?adopt=<key>. */
  key: string;
  calendarId: string;
  seriesId: string;
  title: string;
  description: string;
  location: string;
  attendees: string[];
  /** The next instance, which the form copies. */
  start: number;
  end: number;
  idealTime: string;
  idealDay: number;
  everyWeeks: number | "daily";
  firstDate: LocalDate;
}

export const seriesKey = (calendarId: string, seriesId: string) =>
  createHash("sha256").update(`${calendarId}\n${seriesId}`).digest("base64url").slice(0, 16);

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Series with at least one guest that the user organizes on a calendar
 * Tempoloom can write, and that no meeting manages yet (Proposed rule 3: a
 * series where the user is only a guest is not listed).
 */
export function adoptableSeries(db: Db, userId: string, now: number): Series[] {
  const user = one<{ email: string; time_zone: string }>(
    db,
    "SELECT email, time_zone FROM users WHERE id = ?",
    userId,
  );
  if (!user) return [];
  const rows = all<{
    calendar_id: string;
    recurring_id: string;
    summary: string;
    description: string;
    location: string;
    start_ms: number;
    end_ms: number;
    attendees: string;
    private_props: string;
  }>(
    db,
    `SELECT e.calendar_id, e.recurring_id, e.summary, e.description, e.location, e.start_ms,
       e.end_ms, e.attendees, e.private_props
     FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN accounts a ON a.id = c.account_id
     WHERE a.user_id = ? AND a.status = 'ok' AND c.writable = 1 AND e.recurring_id IS NOT NULL
       AND e.organizer_self = 1 AND e.all_day = 0 AND e.end_ms > ?
       AND NOT EXISTS (SELECT 1 FROM meetings m WHERE m.series_event_id = e.recurring_id
                       AND m.series_calendar_id = e.calendar_id)
     ORDER BY e.start_ms`,
    userId,
    now,
  );
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    if ((JSON.parse(r.private_props) as Record<string, string>).tl === "1") continue;
    const k = `${r.calendar_id}\n${r.recurring_id}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out: Series[] = [];
  for (const list of groups.values()) {
    const [first, second] = list;
    if (!first) continue;
    const attendees = (JSON.parse(first.attendees) as string[]).filter(
      (e) => e !== user.email.toLowerCase(),
    );
    if (attendees.length === 0) continue;
    const local = utcToLocal(user.time_zone, first.start_ms);
    const gapDays = second ? Math.round((second.start_ms - first.start_ms) / 86_400_000) : 7;
    out.push({
      key: seriesKey(first.calendar_id, first.recurring_id),
      calendarId: first.calendar_id,
      seriesId: first.recurring_id,
      title: first.summary,
      description: first.description,
      location: first.location,
      attendees,
      start: first.start_ms,
      end: first.end_ms,
      idealTime: `${pad(Math.floor(local.minuteOfDay / 60))}:${pad(local.minuteOfDay % 60)}`,
      idealDay: weekdayOf(local.date),
      everyWeeks: gapDays === 1 ? "daily" : Math.min(52, Math.max(1, Math.round(gapDays / 7))),
      firstDate: local.date,
    });
  }
  return out;
}
