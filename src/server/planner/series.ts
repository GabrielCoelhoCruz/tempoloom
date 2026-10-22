// Tempoloom's own recurring series for a meeting made from the form
// (docs/specs/meetings-flexible.md rule 2): one master with an RRULE on the
// meeting's calendar; each occurrence is an instance of it, and the push
// moves an instance by writing its override (RECURRENCE-ID).
import type { MeetingFrequency } from "../../scheduler/model.ts";
import { monthlyDate } from "../../scheduler/plan.ts";
import { addDays, type LocalDate, localToUtc, MINUTE, weekdayOf } from "../../shared/time.ts";
import { all, type Db, one, run } from "../db.ts";
import { seriesInstanceDate } from "../meeting-series.ts";
import type { CalendarProvider, EventWrite, SeriesFacts } from "../providers/types.ts";
import { getSettings } from "../settings.ts";
import { homeZone, planningZone } from "../travel.ts";
import { logChange } from "./meeting-log.ts";
import type { MeetingRow } from "./meetings.ts";

export const BYDAY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/**
 * The rule date of a period: the day its instance starts on. Weekly: the
 * first ideal day of the week; daily: the period's day; monthly: the ideal
 * day of the month (none when the month lacks it, as the planner says).
 */
export function ruleDate(
  f: MeetingFrequency,
  period: LocalDate,
  weekStart: 1 | 7,
): LocalDate | null {
  if (f.period === "daily") return period;
  if (f.period === "monthly")
    return monthlyDate(
      period,
      "nth" in f
        ? { period: "monthly", nth: f.nth, weekday: f.weekday }
        : { period: "monthly", dayOfMonth: f.dayOfMonth },
    );
  const offset = (d: number) => (d - weekStart + 7) % 7;
  const first = [...f.idealDays].sort((a, b) => offset(a) - offset(b))[0] ?? 1;
  return addDays(period, offset(first));
}

/** The RRULE of a frequency whose first instance is on `date` (one instance per period). */
export function seriesRrule(f: MeetingFrequency, date: LocalDate): string {
  const every = (n: number | undefined) => ((n ?? 1) > 1 ? `;INTERVAL=${n}` : "");
  if (f.period === "daily") return `FREQ=DAILY${every(f.everyDays)}`;
  if (f.period === "weekly")
    return `FREQ=WEEKLY${every(f.everyWeeks)};BYDAY=${BYDAY[weekdayOf(date) - 1]}`;
  if ("nth" in f)
    return `FREQ=MONTHLY${every(f.everyMonths)};BYDAY=${f.nth === "last" ? -1 : f.nth}${BYDAY[f.weekday - 1]}`;
  // Day 31 is the month's last day (plan.ts monthlyDate). Day 29 or 30 has no
  // instance in February; the push adds one there when the plan places it.
  const days = f.dayOfMonth === 31 ? "-1" : `${f.dayOfMonth}`;
  return `FREQ=MONTHLY${every(f.everyMonths)};BYMONTHDAY=${days}`;
}

export interface SeriesPlan {
  rrule: string;
  timeZone: string;
  start: number;
  end: number;
  /** The rule start of each given period, by period start. */
  ruleStarts: Map<LocalDate, number>;
}

/**
 * The master of a new series that begins in `first` (a period start), and the
 * rule start of each period in `periods`. The rule is the ideal time in the
 * home zone: its DTSTART, its BYDAY and its EXDATEs are in that one zone. A
 * trip moves single occurrences (overrides), not the rule.
 */
export function planSeries(
  db: Db,
  m: MeetingRow,
  first: LocalDate,
  periods: LocalDate[],
): SeriesPlan | null {
  const f = JSON.parse(m.frequency) as MeetingFrequency;
  const { weekStart } = getSettings(db, m.user_id);
  const zone = homeZone(db, m.user_id);
  const at = (p: LocalDate) => {
    const d = ruleDate(f, p, weekStart);
    return d === null ? null : localToUtc(zone, d, m.ideal_minute);
  };
  const date = ruleDate(f, first, weekStart);
  const start = at(first);
  if (date === null || start === null) return null;
  const ruleStarts = new Map<LocalDate, number>();
  for (const p of periods) {
    const t = at(p);
    if (t !== null) ruleStarts.set(p, t);
  }
  return {
    rrule: seriesRrule(f, date),
    timeZone: zone,
    start,
    end: start + m.duration_minutes * MINUTE,
    ruleStarts,
  };
}

/**
 * The master facts that a series edit is compared with (series-edits.ts):
 * what Tempoloom wrote, and the zone of the rule. Never read back, so a
 * missing read after the write cannot leave a series without a baseline.
 */
export type Baseline = SeriesFacts & {
  /** The home zone the rule is written in. */
  zone?: string;
  /** The form fields that make the rule (`formKey`) when the master was written. */
  form?: string;
  /** What Tempoloom wrote on the master from the form. */
  title?: string;
  description?: string;
  location?: string;
  visibility?: string;
};
export function baselineOf(w: EventWrite, organizer: string): Baseline {
  return {
    start: w.start,
    end: w.end,
    rrule: w.recurrence ?? "",
    summary: w.summary,
    attendees: (w.attendees ?? []).map((e) => e.toLowerCase()).filter((e) => e !== organizer),
    optional: (w.optionalAttendees ?? []).map((e) => e.toLowerCase()),
    own: false,
    ...(w.timeZone ? { zone: w.timeZone } : {}),
    description: w.description,
    location: w.location ?? "",
    visibility: w.visibility ?? "default",
  };
}

/** The form fields that make a series rule: a change of one of them needs a new series. */
export const formKey = (m: MeetingRow) =>
  JSON.stringify([m.frequency, m.starting, m.duration_minutes, m.ideal_minute]);

/**
 * The organizer deleted the whole series in a calendar app (SPEC-MEET-02
 * edge case 5): the meeting turns off and keeps its rules, and the change log
 * says why. Called only on a "not found" from the calendar for the series.
 */
export function seriesDeleted(db: Db, userId: string, meetingId: string, now: number): void {
  run(db, "UPDATE meetings SET enabled = 0, rules_changed_at = ? WHERE id = ?", now, meetingId);
  forgetSeries(db, meetingId);
  logChange(
    db,
    userId,
    {
      meetingId,
      key: `meeting:${meetingId}`,
      oldStart: null,
      oldEnd: null,
      newStart: null,
      newEnd: null,
      actor: "organizer",
      reason: "seriesDeleted",
      written: false,
    },
    now,
  );
}

/** The period key of a series instance (`meeting:<id>:<period>`), as adoptInstances counts it. */
export const instanceDate = (db: Db, userId: string, id: string, start: number) =>
  seriesInstanceDate(planningZone(db, userId), id, start);

/** The calendar of a meeting's series, as the account and the provider name it. */
export function seriesTarget(db: Db, m: MeetingRow) {
  return one<{ account_id: string; provider_id: string }>(
    db,
    "SELECT account_id, provider_id FROM calendars WHERE id = ?",
    m.series_calendar_id,
  );
}

/** Locked occurrences that start after `now`: they stay when the series ends (LCK-2). */
export const lockedIds = (db: Db, m: MeetingRow, now: number) =>
  all<{ event_id: string }>(
    db,
    `SELECT event_id FROM managed_events WHERE kind = 'meeting' AND source_id = ? AND locked = 1
       AND start_ms > ? AND event_id IS NOT NULL`,
    m.id,
    now,
  ).map((r) => r.event_id);

/**
 * Ends Tempoloom's own series at `now` (MEET-02 rules 27-29): an instance
 * that starts before `now` stays, a later one goes, except the ids in `keep`.
 * The provider and this cleanup both use the instance's start (an override's
 * own start, else its rule time). The meeting forgets the series, so the next
 * plan run writes a new one when it places.
 */
export async function endOwnSeries(
  db: Db,
  provider: (accountId: string) => CalendarProvider,
  m: MeetingRow,
  now: number,
  keep: string[],
): Promise<void> {
  if (!m.series_owned || !m.series_event_id) return;
  const cal = seriesTarget(db, m);
  const p = cal ? provider(cal.account_id) : undefined;
  if (cal && p?.endSeries) await p.endSeries(cal.provider_id, m.series_event_id, now, keep);
  const instances =
    "SELECT event_id FROM events WHERE calendar_id = ? AND recurring_id = ? AND start_ms > ?";
  const kept = keep.length > 0 ? `AND event_id NOT IN (${keep.map(() => "?").join(", ")})` : "";
  run(
    db,
    `DELETE FROM managed_events WHERE kind = 'meeting' AND source_id = ? AND start_ms > ?
       AND event_id IN (${instances}) ${kept}`,
    m.id,
    now,
    m.series_calendar_id,
    m.series_event_id,
    now,
    ...keep,
  );
  run(
    db,
    `DELETE FROM events WHERE calendar_id = ? AND recurring_id = ? AND start_ms > ? ${kept}`,
    m.series_calendar_id,
    m.series_event_id,
    now,
    ...keep,
  );
  forgetSeries(db, m.id);
}

/** The meeting has no series now; the next plan run that places it writes one. */
export const forgetSeries = (db: Db, meetingId: string) =>
  run(
    db,
    "UPDATE meetings SET series_calendar_id = NULL, series_event_id = NULL, series_rule = '' WHERE id = ?",
    meetingId,
  );
