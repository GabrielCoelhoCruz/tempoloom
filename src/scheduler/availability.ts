// Times a booking link offers (docs/specs/booking-links-availability.md).
import { addDays, localToUtc, MINUTE, utcToLocal, weekdayOf } from "../shared/time.ts";
import { hoursToTimeSet, type WeeklyHours } from "./hours.ts";
import type { Level } from "./model.ts";
import type { Interval } from "./timeset.ts";

export interface LinkRules {
  durationMinutes: number;
  /** Link priority. A slot over a managed event of this level or higher (smaller number) is not offered. */
  level: Level;
  hours: WeeklyHours;
  zone: string;
  weekStart: 1 | 7;
  /** Minimum time from now to the start. */
  noticeMinutes: number;
  /** Last bookable day: today plus this many days. */
  rangeEndDays: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  maxPerDay: number | null;
  maxPerWeek: number | null;
}

/** One event of the organizer, classified as in the spec's class table. */
export interface CalendarItem extends Interval {
  cls: "free" | "booked" | "fixed" | "prioritized";
  /** For prioritized items: the item's level (focus time counts as P2). */
  level?: Level;
  /** For booked items: the booking that created the event. */
  bookingId?: string;
}

export interface Booking extends Interval {
  id: string;
}

export interface OfferedTime {
  start: number;
  end: number;
  preferred: boolean;
}

const STEP = 15 * MINUTE;

export function offeredTimes(
  rules: LinkRules,
  items: CalendarItem[],
  bookings: Booking[],
  now: number,
  from: number,
  to: number,
  rescheduling?: string,
): OfferedTime[] {
  const len = rules.durationMinutes * MINUTE;
  const today = utcToLocal(rules.zone, now).date;
  const rangeEnd = localToUtc(rules.zone, addDays(today, rules.rangeEndDays + 1), 0);
  const earliest = Math.max(from, now + rules.noticeMinutes * MINUTE);
  const latest = Math.min(to, rangeEnd);
  if (latest <= earliest) return [];
  const hours = hoursToTimeSet(rules.hours, rules.zone, earliest, latest + len);
  const relevant = items.filter((i) => !(rescheduling && i.bookingId === rescheduling));
  const blocks = (i: CalendarItem) =>
    i.cls === "booked" ||
    i.cls === "fixed" ||
    (i.cls === "prioritized" && (i.level ?? 1) <= rules.level);
  const blocking = relevant.filter(blocks);
  const counted = bookings.filter((b) => b.id !== rescheduling);
  const dayKey = (t: number) => utcToLocal(rules.zone, t).date;
  const weekKey = (t: number) => {
    const d = dayKey(t);
    return addDays(d, -((weekdayOf(d) - rules.weekStart + 7) % 7));
  };
  const perDay = new Map<string, number>();
  const perWeek = new Map<string, number>();
  for (const b of counted) {
    perDay.set(dayKey(b.start), (perDay.get(dayKey(b.start)) ?? 0) + 1);
    perWeek.set(weekKey(b.start), (perWeek.get(weekKey(b.start)) ?? 0) + 1);
  }
  const overlaps = (list: Interval[], s: number, e: number) =>
    list.some((i) => i.start < e && i.end > s);
  const out: OfferedTime[] = [];
  for (const range of hours.intervals()) {
    for (
      let s = Math.ceil(Math.max(range.start, earliest) / STEP) * STEP;
      s + len <= range.end && s < latest;
      s += STEP
    ) {
      const e = s + len;
      if (rules.maxPerDay !== null && (perDay.get(dayKey(s)) ?? 0) >= rules.maxPerDay) continue;
      if (rules.maxPerWeek !== null && (perWeek.get(weekKey(s)) ?? 0) >= rules.maxPerWeek) continue;
      const before = s - rules.bufferBeforeMinutes * MINUTE;
      const after = e + rules.bufferAfterMinutes * MINUTE;
      if (overlaps(blocking, before, after)) continue;
      out.push({ start: s, end: e, preferred: !overlaps(relevant, s, e) });
    }
  }
  return out;
}
