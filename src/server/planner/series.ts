// Tempoloom's own recurring series for a meeting made from the form
// (docs/specs/meetings-flexible.md rule 2): one master with an RRULE on the
// meeting's calendar; each occurrence is an instance of it, and the push
// moves an instance by writing its override (RECURRENCE-ID).
import type { MeetingFrequency } from "../../scheduler/model.ts";
import { monthlyDate } from "../../scheduler/plan.ts";
import { addDays, type LocalDate, localToUtc, MINUTE, weekdayOf } from "../../shared/time.ts";
import type { Db } from "../db.ts";
import { seriesInstanceDate } from "../meeting-series.ts";
import { getSettings } from "../settings.ts";
import { homeZone, planningZone } from "../travel.ts";
import type { MeetingRow } from "./meetings.ts";

const BYDAY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

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
  // Day 29 to 31 is the month's last day in a shorter month (plan.ts monthlyDate).
  const days =
    f.dayOfMonth <= 28
      ? `${f.dayOfMonth}`
      : `${Array.from({ length: f.dayOfMonth - 27 }, (_, i) => 28 + i).join(",")};BYSETPOS=-1`;
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
 * rule start of each period in `periods`. Times are the ideal time in the
 * planning zone, written in the user's home zone.
 */
export function planSeries(
  db: Db,
  m: MeetingRow,
  first: LocalDate,
  periods: LocalDate[],
): SeriesPlan | null {
  const f = JSON.parse(m.frequency) as MeetingFrequency;
  const { weekStart } = getSettings(db, m.user_id);
  const zone = planningZone(db, m.user_id);
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
    timeZone: homeZone(db, m.user_id),
    start,
    end: start + m.duration_minutes * MINUTE,
    ruleStarts,
  };
}

/** The period key of a series instance (`meeting:<id>:<period>`), as adoptInstances counts it. */
export const instanceDate = (db: Db, userId: string, id: string, start: number) =>
  seriesInstanceDate(planningZone(db, userId), id, start);
