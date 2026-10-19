// One member's figures per local day of a date range: the stats buckets of
// docs/specs/analytics-personal-stats.md (deep and shallow work, free time),
// meetings outside work hours, solo sessions, fragmented time
// (teams-policies.md rule 21) and long free blocks (analytics-organization.md
// rule 3). Days use the member's own zone (analytics-team-stats.md edge case 4).
import { attends } from "../../scheduler/blocking.ts";
import { type Category, categoryOf } from "../../scheduler/categories.ts";
import { hoursToTimeSet, type WeeklyHours } from "../../scheduler/hours.ts";
import { type Interval, TimeSet } from "../../scheduler/timeset.ts";
import {
  addDays,
  type IsoWeekday,
  type LocalDate,
  localToUtc,
  MINUTE,
  weekdayOf,
} from "../../shared/time.ts";
import { all, type Db, one } from "../db.ts";
import { externalEvents } from "../planner/events.ts";
import { fragmentedMinutes } from "./fragmentation.ts";

export type Kind =
  | "oneOnOne"
  | "teamMeetings"
  | "externalMeetings"
  | "solo"
  | "personal"
  | "travel"
  | "breaks"
  | "vacation"
  /** Time away shorter than 8 hours (events-out-of-office.md rule 7). */
  | "commitment";

export const MEETINGS = ["oneOnOne", "teamMeetings", "externalMeetings"] as const;
export const BUCKETS = [
  ...MEETINGS,
  "deepWork",
  "shallowWork",
  "personal",
  "travel",
  "breaks",
  "vacation",
  "commitment",
  "free",
] as const;
export type Bucket = (typeof BUCKETS)[number];

export interface Span extends Interval {
  kind: Kind;
  /** Managed time that the "work habits and tasks" and highlights panels count. */
  tag?: "task" | "workHabit" | "focus";
  booking?: boolean;
}

export interface Day {
  date: LocalDate;
  weekday: IsoWeekday;
  /** Minutes of work hours. */
  work: number;
  minutes: Record<Bucket, number>;
  meetingsOutsideWork: number;
  tasks: number;
  workHabits: number;
  focusHeld: number;
  bookings: number;
  /** Lengths in minutes of the solo sessions that start on this day. */
  sessions: number[];
  fragmented: number;
  /** Free work minutes in blocks of 2 hours or more. */
  freeInLongBlocks: number;
}

/** A solo session of this length or more is deep work (personal stats, proposal). */
const DEEP = 120 * MINUTE;
const LONG_BLOCK = 120 * MINUTE;
/** teams-policies.md `min_usable_block_minutes`, proposed default. */
const MIN_USABLE_BLOCK = 60;

const emptyDay = (date: LocalDate): Day => ({
  date,
  weekday: weekdayOf(date),
  work: 0,
  minutes: Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>,
  meetingsOutsideWork: 0,
  tasks: 0,
  workHabits: 0,
  focusHeld: 0,
  bookings: 0,
  sessions: [],
  fragmented: 0,
  freeInLongBlocks: 0,
});

const isMeeting = (k: Kind) => k === "oneOnOne" || k === "teamMeetings" || k === "externalMeetings";

/** Figures per local day from `from` to `to` (inclusive) for one member's classified time. */
export function memberDays(
  spans: Span[],
  zone: string,
  weekly: WeeklyHours,
  from: LocalDate,
  to: LocalDate,
): Day[] {
  const days: Day[] = [];
  const bounds: number[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    days.push(emptyDay(d));
    bounds.push(localToUtc(zone, d, 0));
  }
  bounds.push(localToUtc(zone, addDays(to, 1), 0));
  const start = bounds[0] as number;
  const end = bounds.at(-1) as number;
  const work = hoursToTimeSet(weekly, zone, start, end);
  /** Calls fn with the day index and minutes of each day that [s, e) touches. */
  const perDay = (s: number, e: number, fn: (day: Day, minutes: number) => void) => {
    for (let i = 0; i < days.length; i++) {
      const a = Math.max(s, bounds[i] as number);
      const b = Math.min(e, bounds[i + 1] as number);
      if (b > a) fn(days[i] as Day, (b - a) / MINUTE);
    }
  };
  const dayOf = (t: number) => {
    for (let i = 0; i < days.length; i++) if (t < (bounds[i + 1] as number)) return days[i];
    return undefined;
  };

  // Vacation counts inside work hours only: one day off is one work day.
  const input = spans.flatMap((s) =>
    s.kind === "vacation"
      ? work
          .clip(s.start, s.end)
          .intervals()
          .map((i) => ({ ...s, start: i.start, end: i.end }))
      : [s],
  );
  // Edge case 3: each minute once, for the event that started first; on a tie, the longer.
  input.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const unclaimed = TimeSet.from([{ start, end }]);
  const parts: Span[] = [];
  for (const s of input) {
    if (s.booking && s.start >= start && s.start < end) (dayOf(s.start) as Day).bookings++;
    for (const i of unclaimed.clip(s.start, s.end).intervals()) parts.push({ ...s, ...i });
    unclaimed.subtract(s);
  }
  const occupied = TimeSet.from(parts);

  for (const p of parts) {
    if (p.kind !== "solo") {
      perDay(p.start, p.end, (d, m) => {
        d.minutes[p.kind as Exclude<Kind, "solo">] += m;
      });
    }
    if (p.tag) {
      const key = p.tag === "task" ? "tasks" : p.tag === "workHabit" ? "workHabits" : "focusHeld";
      perDay(p.start, p.end, (d, m) => {
        d[key] += m;
      });
    }
    if (isMeeting(p.kind)) {
      const outside = TimeSet.from([p]);
      for (const w of work.clip(p.start, p.end).intervals()) outside.subtract(w);
      for (const o of outside.intervals())
        perDay(o.start, o.end, (d, m) => {
          d.meetingsOutsideWork += m;
        });
    }
  }
  // Touching solo events form one session (proposal).
  for (const s of TimeSet.from(parts.filter((p) => p.kind === "solo")).intervals()) {
    const bucket = s.end - s.start >= DEEP ? "deepWork" : "shallowWork";
    perDay(s.start, s.end, (d, m) => {
      d.minutes[bucket] += m;
    });
    dayOf(s.start)?.sessions.push((s.end - s.start) / MINUTE);
  }
  days.forEach((d, i) => {
    const workDay = work.clip(bounds[i] as number, bounds[i + 1] as number);
    d.work = workDay.total() / MINUTE;
    const free = workDay.clone();
    for (const o of occupied.clip(bounds[i] as number, bounds[i + 1] as number).intervals())
      free.subtract(o);
    d.minutes.free = free.total() / MINUTE;
    for (const f of free.intervals())
      if (f.end - f.start >= LONG_BLOCK) d.freeInLongBlocks += (f.end - f.start) / MINUTE;
    d.fragmented = fragmentedMinutes(
      [...occupied.intervals()],
      [...workDay.intervals()],
      MIN_USABLE_BLOCK,
    );
  });
  return days;
}

const KIND: Record<Category, Kind> = {
  one_on_one: "oneOnOne",
  team_meeting: "teamMeetings",
  external_meeting: "externalMeetings",
  solo_work: "solo",
  personal: "personal",
  personal_commitment: "commitment",
  travel: "travel",
  flight: "travel",
  vacation: "vacation",
};

/** Reads one member's calendar time from the cache and managed events, then computes the days. */
export function loadMemberDays(db: Db, userId: string, from: LocalDate, to: LocalDate): Day[] {
  const user = one<{ time_zone: string; email: string }>(
    db,
    "SELECT time_zone, email FROM users WHERE id = ?",
    userId,
  );
  const zone = user?.time_zone ?? "UTC";
  const start = localToUtc(zone, from, 0);
  const end = localToUtc(zone, addDays(to, 1), 0);
  const weekly = JSON.parse(
    one<{ weekly: string }>(
      db,
      "SELECT weekly FROM hours_sets WHERE user_id = ? AND kind = 'work' ORDER BY created_at LIMIT 1",
      userId,
    )?.weekly ?? "{}",
  ) as WeeklyHours;
  const spans: Span[] = [];
  for (const e of externalEvents(db, userId, start, end)) {
    // Personal stats edge cases 1 and 4: declined events and all-day events other than vacation do not count.
    if (!attends(e) || e.eventType === "workingLocation") continue;
    if (e.allDay && e.category !== "vacation") continue;
    spans.push({
      start: e.start,
      end: e.end,
      kind: KIND[e.category ?? "solo_work"],
      ...(e.bookedViaLink ? { booking: true } : {}),
    });
  }
  const personalHabits = new Set(
    all<{ id: string }>(
      db,
      `SELECT h.id FROM habits h JOIN hours_sets s ON s.id = h.hours_set_id
       WHERE h.user_id = ? AND s.kind = 'personal'`,
      userId,
    ).map((h) => h.id),
  );
  const travelBuffers = new Set(
    all<{ id: string; filter: string }>(
      db,
      "SELECT id, filter FROM buffers WHERE user_id = ?",
      userId,
    )
      .filter((b) => {
        const f = JSON.parse(b.filter) as { travel?: boolean; flight?: boolean };
        return f.travel || f.flight;
      })
      .map((b) => b.id),
  );
  for (const m of all<{
    kind: string;
    source_id: string;
    start_ms: number;
    end_ms: number;
    extra: string;
  }>(
    db,
    `SELECT kind, source_id, start_ms, end_ms, extra FROM managed_events
     WHERE user_id = ? AND kind <> 'mirror' AND end_ms > ? AND start_ms < ?`,
    userId,
    start,
    end,
  )) {
    const at = { start: m.start_ms, end: m.end_ms };
    if (m.kind === "task") spans.push({ ...at, kind: "solo", tag: "task" });
    else if (m.kind === "focus") spans.push({ ...at, kind: "solo", tag: "focus" });
    else if (m.kind === "habit")
      spans.push(
        personalHabits.has(m.source_id)
          ? { ...at, kind: "personal" }
          : { ...at, kind: "solo", tag: "workHabit" },
      );
    // Personal stats: recovery and break buffers are breaks; travel and airport buffers are travel.
    else if (m.kind === "buffer")
      spans.push({ ...at, kind: travelBuffers.has(m.source_id) ? "travel" : "breaks" });
    else if (m.kind === "meeting") {
      const extra = (m.extra ? JSON.parse(m.extra) : {}) as {
        attendees?: string[];
        optional?: string[];
      };
      const category = categoryOf(
        {
          title: "",
          description: "",
          rsvpNote: "",
          start: m.start_ms,
          end: m.end_ms,
          eventType: "default",
          attendees: [...(extra.attendees ?? []), ...(extra.optional ?? [])],
          managedKind: "meeting",
          personalCalendar: false,
          manual: null,
        },
        user?.email ?? "",
      );
      spans.push({ ...at, kind: KIND[category] });
    }
  }
  return memberDays(spans, zone, weekly, from, to);
}
