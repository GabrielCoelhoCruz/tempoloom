// Recurring meetings the user organizes that can become flexible meetings
// (meetings-flexible.md rules 1 and 3; planning-notifications.md NTF-30).
import { createHash } from "node:crypto";
import { diffDays, type LocalDate, utcToLocal, weekdayOf } from "../shared/time.ts";
import { all, type Db } from "./db.ts";
import { planningZone } from "./travel.ts";

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
  /** From the series recurrence rule (`seriesFrequency`); fixed for the meeting. */
  everyWeeks: number | "daily";
  firstDate: LocalDate;
}

export const seriesKey = (calendarId: string, seriesId: string) =>
  createHash("sha256").update(`${calendarId}\n${seriesId}`).digest("base64url").slice(0, 16);

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The local date of a series instance as its recurrence rule makes it, in the
 * planning zone (`planningZone`); the one date basis for the adopt list
 * (`seriesFrequency`) and the planner's period keys (`adoptInstances`): the
 * date in its recurrence id (CalDAV `<url>#<id>`, Google `<series>_<id>`). A
 * moved instance keeps it. A UTC recurrence id (`...T003000Z`) becomes a date
 * in that zone, so a meeting near UTC midnight keeps its day across a
 * DST change; a date or floating time is already local. Without a recurrence
 * id, the local date of the instance's start.
 */
export function seriesInstanceDate(zone: string, eventId: string, startMs: number): LocalDate {
  const m =
    /#(\d{4})-?(\d{2})-?(\d{2})(?:T(\d{2}):?(\d{2}):?(\d{2})(Z)?)?/.exec(eventId) ??
    /_(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(eventId);
  if (!m) return utcToLocal(zone, startMs).date;
  const [, y, mo, d, h, mi, sec, z] = m;
  if (!z) return `${y}-${mo}-${d}`;
  return utcToLocal(zone, Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${sec}Z`)).date;
}

/**
 * The frequency of a series from its recurrence rule (rule 1): the cache keeps
 * the instances the rule makes in the pull window (120 days), and their
 * smallest step in local days is the rule's FREQ and INTERVAL; a cancelled
 * instance only makes one step longer. Null when the rule repeats neither
 * every day nor every N weeks (monthly, or weekly on two days that are not
 * next to each other): a meeting cannot keep one instance in each of its
 * periods. Two adjacent days a week (MO,TU) read as daily; the user then sets
 * the days on the form. With one instance only, the series counts as weekly.
 */
function seriesFrequency(
  zone: string,
  list: { event_id: string; start_ms: number }[],
): number | "daily" | null {
  const dates = [
    ...new Set(list.map((r) => seriesInstanceDate(zone, r.event_id, r.start_ms))),
  ].sort();
  const steps = dates.slice(1).map((d, i) => diffDays(dates[i] ?? d, d));
  if (steps.length === 0) return 1;
  const step = Math.min(...steps);
  if (step === 1) return "daily";
  if (step % 7 !== 0 || step > 52 * 7 || steps.some((x) => x % step !== 0)) return null;
  return step / 7;
}

/** A solo series of the user's: one that could become a habit (planning-habits rule 8). */
export interface SoloSeries {
  calendarId: string;
  /** The planner id of its next instance, for /habits?from=. */
  eventId: string;
  title: string;
  /** ISO weekdays of its instances, 1 is Monday. */
  days: number[];
  idealTime: string;
  minutes: number;
}

/** The user's own addresses: the sign-in email and every connected account's email, lower case. */
export function ownEmails(db: Db, userId: string): Set<string> {
  return new Set(
    all<{ email: string }>(
      db,
      "SELECT email FROM users WHERE id = ? UNION SELECT email FROM accounts WHERE user_id = ?",
      userId,
      userId,
    ).map((r) => r.email.toLowerCase()),
  );
}

/**
 * The recurring series the user organizes on a calendar Tempoloom can write,
 * that Tempoloom does not write and no meeting manages yet, in one pass: a
 * series with a guest (anyone but the user's own addresses) is in `guests`,
 * the others are in `solo`. So one series is in one list only.
 */
export function ownSeries(
  db: Db,
  userId: string,
  now: number,
): { guests: Series[]; solo: SoloSeries[] } {
  const mine = ownEmails(db, userId);
  const zone = planningZone(db, userId);
  const rows = all<{
    calendar_id: string;
    event_id: string;
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
    `SELECT e.calendar_id, e.event_id, e.recurring_id, e.summary, e.description, e.location, e.start_ms,
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
  const guests: Series[] = [];
  const solo: SoloSeries[] = [];
  for (const list of groups.values()) {
    const [first] = list;
    if (!first) continue;
    const local = utcToLocal(zone, first.start_ms);
    const idealTime = `${pad(Math.floor(local.minuteOfDay / 60))}:${pad(local.minuteOfDay % 60)}`;
    const attendees = (JSON.parse(first.attendees) as string[]).filter(
      (e) => !mine.has(e.toLowerCase()),
    );
    if (attendees.length === 0) {
      solo.push({
        calendarId: first.calendar_id,
        eventId: `ext:${first.calendar_id}:${first.event_id}`,
        title: first.summary,
        days: [...new Set(list.map((o) => utcToLocal(zone, o.start_ms).weekday))].sort(
          (a, b) => a - b,
        ),
        idealTime,
        minutes: Math.round((first.end_ms - first.start_ms) / 60_000),
      });
      continue;
    }
    const everyWeeks = seriesFrequency(zone, list);
    if (everyWeeks === null) continue;
    guests.push({
      key: seriesKey(first.calendar_id, first.recurring_id),
      calendarId: first.calendar_id,
      seriesId: first.recurring_id,
      title: first.summary,
      description: first.description,
      location: first.location,
      attendees,
      start: first.start_ms,
      end: first.end_ms,
      idealTime,
      idealDay: weekdayOf(local.date),
      everyWeeks,
      firstDate: local.date,
    });
  }
  return { guests, solo };
}

/**
 * Series with at least one guest that the user organizes on a calendar
 * Tempoloom can write, and that no meeting manages yet (Proposed rule 3: a
 * series where the user is only a guest is not listed).
 */
export const adoptableSeries = (db: Db, userId: string, now: number): Series[] =>
  ownSeries(db, userId, now).guests;
