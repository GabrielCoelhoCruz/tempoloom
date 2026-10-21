// The availability map of a flexible meeting (docs/specs/meetings-flexible.md
// rules 6-7): for each day of next week, the organizer's hours, the hours of
// each required guest converted to the organizer's time zone, and the overlap
// of all of them. A guest who is a user here gives meeting hours, or the hours
// the organizer set for that guest; Tempoloom cannot see other guests' hours.
import { hoursToTimeSet, type WeeklyHours } from "../scheduler/hours.ts";
import type { TimeSet } from "../scheduler/timeset.ts";
import { addDays, type LocalDate, localToUtc, utcToLocal, weekdayOf } from "../shared/time.ts";
import { type Db, one } from "./db.ts";
import { type Attendee, guestHoursJson, instanceUser } from "./planner/meetings.ts";
import { getSettings } from "./settings.ts";
import { homeZone } from "./travel.ts";

/** Minutes of the organizer's local day, [start, end). */
type Ranges = [number, number][];

export interface AvailabilityMap {
  zone: string;
  /** The first day of the week the map shows. */
  week: LocalDate;
  /** Required guests, with their zone; null when Tempoloom cannot see their hours. */
  people: { email: string; zone: string | null; set: boolean }[];
  days: {
    date: LocalDate;
    /** ISO weekday. */
    day: number;
    you: Ranges;
    /** One entry per person; null: unknown hours. */
    people: (Ranges | null)[];
    overlap: Ranges;
  }[];
}

export function availabilityMap(
  db: Db,
  userId: string,
  hoursSetId: string,
  attendees: Attendee[],
  now: number,
): AvailabilityMap {
  const zone = homeZone(db, userId);
  const weekStart = getSettings(db, userId).weekStart;
  const today = utcToLocal(zone, now).date;
  const week = addDays(today, 7 - ((weekdayOf(today) - weekStart + 7) % 7));
  const from = localToUtc(zone, week, 0);
  const to = localToUtc(zone, addDays(week, 7), 0);
  const weekly = one<{ weekly: string }>(
    db,
    "SELECT weekly FROM hours_sets WHERE id = ? AND user_id = ?",
    hoursSetId,
    userId,
  )?.weekly;
  const you = hoursToTimeSet(JSON.parse(weekly ?? "{}") as WeeklyHours, zone, from, to);
  const guests = attendees
    .filter((a) => a.required)
    .map((a) => {
      const user = instanceUser(db, a.email);
      const hours =
        user && user.id !== userId
          ? hoursToTimeSet(
              JSON.parse(guestHoursJson(db, user.id, a)) as WeeklyHours,
              user.time_zone,
              from,
              to,
            )
          : null;
      return {
        email: a.email,
        zone: user?.time_zone ?? null,
        set: Boolean(a.hoursOverride),
        hours,
      };
    });
  let overlap = you;
  for (const g of guests) if (g.hours) overlap = overlap.intersect(g.hours);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(week, i);
    const start = localToUtc(zone, date, 0);
    const end = localToUtc(zone, addDays(date, 1), 0);
    const ranges = (set: TimeSet): Ranges =>
      set
        .clip(start, end)
        .intervals()
        .map((iv) => [
          utcToLocal(zone, iv.start).minuteOfDay,
          iv.end >= end ? 1440 : utcToLocal(zone, iv.end).minuteOfDay,
        ]);
    days.push({
      date,
      day: weekdayOf(date),
      you: ranges(you),
      people: guests.map((g) => (g.hours ? ranges(g.hours) : null)),
      overlap: ranges(overlap),
    });
  }
  return {
    zone,
    week,
    people: guests.map((g) => ({ email: g.email, zone: g.zone, set: g.set })),
    days,
  };
}
