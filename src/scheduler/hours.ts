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
    const ranges = hours[weekdayOf(date)];
    if (!ranges?.length) continue;
    // A range never runs past the local day: a travel zone can make a day short.
    const dayEnd = localToUtc(zone, addDays(date, 1), 0);
    for (const [s, e] of ranges) {
      const start = localToUtc(zone, date, s);
      const end = e >= 1440 ? dayEnd : Math.min(localToUtc(zone, date, e), dayEnd);
      out.push({ start: Math.max(start, from), end: Math.min(end, to) });
    }
  }
  return TimeSet.from(out);
}
