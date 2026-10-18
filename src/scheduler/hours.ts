import { addDays, type IsoWeekday, localToUtc, utcToLocal, weekdayOf } from "../shared/time.ts";
import { type Interval, TimeSet } from "./timeset.ts";

/** Local windows per ISO weekday, as [startMinute, endMinute) with 0 <= start < end <= 1440. */
export type WeeklyHours = Partial<Record<IsoWeekday, ReadonlyArray<readonly [number, number]>>>;

/** Absolute time covered by weekly local hours within [from, to). */
export function hoursToTimeSet(
  hours: WeeklyHours,
  zone: string,
  from: number,
  to: number,
): TimeSet {
  const out: Interval[] = [];
  const last = utcToLocal(zone, to).date;
  for (let date = utcToLocal(zone, from).date; date <= last; date = addDays(date, 1)) {
    for (const [s, e] of hours[weekdayOf(date)] ?? []) {
      const start = localToUtc(zone, date, s);
      const end = e >= 1440 ? localToUtc(zone, addDays(date, 1), 0) : localToUtc(zone, date, e);
      out.push({ start: Math.max(start, from), end: Math.min(end, to) });
    }
  }
  return TimeSet.from(out);
}
