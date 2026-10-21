// Snooze choices of a task (planning-tasks.md TSK-24): the new start date.
import type { WeeklyHours } from "../scheduler/hours.ts";
import {
  addDays,
  HOUR,
  type LocalDate,
  localToUtc,
  utcToLocal,
  weekdayOf,
} from "../shared/time.ts";

export const SNOOZE_CHOICES = ["1h", "3h", "tomorrow", "next-week"] as const;
export type SnoozeChoice = (typeof SNOOZE_CHOICES)[number];

/** The start of the hours on the first day from `date` that has hours; that day at 00:00 when none has. */
function hoursStart(zone: string, weekly: WeeklyHours, date: LocalDate): number {
  for (let i = 0; i < 7; i++) {
    const d = addDays(date, i);
    const ranges = weekly[weekdayOf(d)] ?? [];
    const first = Math.min(...ranges.map(([s]) => s));
    if (Number.isFinite(first)) return localToUtc(zone, d, first);
  }
  return localToUtc(zone, date, 0);
}

/**
 * "1 hour" and "3 hours" count from now. "Tomorrow" is the next day and "next
 * week" the first day of next week, each at the start of the task's hours
 * (the first later day with hours, when that day has none).
 */
export function snoozeUntil(
  choice: SnoozeChoice,
  now: number,
  zone: string,
  weekly: WeeklyHours,
  weekStart: 1 | 7,
): number {
  if (choice === "1h") return now + HOUR;
  if (choice === "3h") return now + 3 * HOUR;
  const today = utcToLocal(zone, now).date;
  if (choice === "tomorrow") return hoursStart(zone, weekly, addDays(today, 1));
  let d = addDays(today, 1);
  while (weekdayOf(d) !== weekStart) d = addDays(d, 1);
  return hoursStart(zone, weekly, d);
}
