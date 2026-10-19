// Times a booking link offers (docs/specs/booking-links-availability.md), for
// one organizer, a team, or a round-robin pool (booking-links-team.md).
import { addDays, localToUtc, MINUTE, utcToLocal, weekdayOf } from "../shared/time.ts";
import { hoursToTimeSet, type WeeklyHours } from "./hours.ts";
import type { Level } from "./model.ts";
import type { Interval, TimeSet } from "./timeset.ts";

/** Rules that apply to the whole link. Day, week and range use the main organizer's zone. */
export interface TeamRules {
  durationMinutes: number;
  /** Link priority. A slot over a managed event of this level or higher (smaller number) is not offered. */
  level: Level;
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

/** A single organizer's link: the rules plus that organizer's hours. */
export interface LinkRules extends TeamRules {
  hours: WeeklyHours;
}

/** One person whose calendar a link checks: a required organizer or a pool member. */
export interface Person {
  id: string;
  /** The hours chosen for this person on the link, read in `zone`. */
  hours: WeeklyHours;
  zone: string;
  items: CalendarItem[];
  /** Minutes after a booked meeting that this person's recovery buffer needs (0: none or off). */
  recoveryMinutes: number;
  /** Minutes of the hour this person's meetings may start at, in `zone` (meetings-start-intervals.md rule 3). */
  startMinutes?: number[];
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
  /** Round robin: the pool members who pass every check, in pool order. */
  pool?: string[];
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
  const { hours, ...team } = rules;
  const organizer = { id: "", hours, zone: rules.zone, items, recoveryMinutes: 0 };
  return teamOffers(team, [organizer], [], bookings, now, from, to, rescheduling);
}

interface Checked {
  id: string;
  hours: TimeSet;
  blocking: Interval[];
  all: Interval[];
  recovery: number;
  /** True when a start's local minute of the hour is allowed. */
  startOk: (t: number) => boolean;
}

function startCheck(p: Person): (t: number) => boolean {
  if (!p.startMinutes || p.startMinutes.length === 4) return () => true;
  const allowed = new Set(p.startMinutes);
  return (t) => allowed.has(utcToLocal(p.zone, t).minuteOfDay % 60);
}

const overlaps = (list: Interval[], s: number, e: number) =>
  list.some((i) => i.start < e && i.end > s);

/**
 * Starts where every check passes for every required person and, when the link
 * has a pool, for at least one pool member (availability rules 16 and 17).
 */
export function teamOffers(
  rules: TeamRules,
  required: Person[],
  pool: Person[],
  bookings: Booking[],
  now: number,
  from: number,
  to: number,
  rescheduling?: string,
): OfferedTime[] {
  if (required.length === 0 && pool.length === 0) return [];
  const len = rules.durationMinutes * MINUTE;
  const today = utcToLocal(rules.zone, now).date;
  const rangeEnd = localToUtc(rules.zone, addDays(today, rules.rangeEndDays + 1), 0);
  const earliest = Math.max(from, now + rules.noticeMinutes * MINUTE);
  const latest = Math.min(to, rangeEnd);
  if (latest <= earliest) return [];
  const blocks = (i: CalendarItem) =>
    i.cls === "booked" ||
    i.cls === "fixed" ||
    (i.cls === "prioritized" && (i.level ?? 1) <= rules.level);
  const check = (p: Person): Checked => {
    const relevant = p.items.filter((i) => !(rescheduling && i.bookingId === rescheduling));
    return {
      id: p.id,
      hours: hoursToTimeSet(p.hours, p.zone, earliest, latest + len),
      blocking: relevant.filter(blocks),
      all: relevant,
      recovery: p.recoveryMinutes,
      startOk: startCheck(p),
    };
  };
  const req = required.map(check);
  const members = pool.map(check);
  const requiredRecovery = Math.max(0, ...req.map((p) => p.recovery));

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

  // Candidate starts: inside the hours of every required person, or of any pool member.
  let window: TimeSet | undefined;
  for (const p of req) window = window ? window.intersect(p.hours) : p.hours;
  const starts = new Set<number>();
  const sources = window ? [window] : members.map((m) => m.hours);
  for (const w of sources) for (const s of w.candidates(len, STEP)) starts.add(s);

  const out: OfferedTime[] = [];
  for (const s of [...starts].sort((a, b) => a - b)) {
    if (s < earliest || s >= latest) continue;
    const e = s + len;
    if (rules.maxPerDay !== null && (perDay.get(dayKey(s)) ?? 0) >= rules.maxPerDay) continue;
    if (rules.maxPerWeek !== null && (perWeek.get(weekKey(s)) ?? 0) >= rules.maxPerWeek) continue;
    const before = s - rules.bufferBeforeMinutes * MINUTE;
    // The recovery buffer after the slot uses the longest one among the people (rule 10).
    const passes = (p: Checked, recovery: number) =>
      p.startOk(s) &&
      p.hours.contains({ start: s, end: e }) &&
      !overlaps(p.blocking, before, e + Math.max(rules.bufferAfterMinutes, recovery) * MINUTE);
    const clear = (p: Checked) => !overlaps(p.all, s, e);
    if (members.length === 0) {
      if (!req.every((p) => passes(p, requiredRecovery))) continue;
      out.push({ start: s, end: e, preferred: req.every(clear) });
      continue;
    }
    const passing = members.filter((m) => {
      const recovery = Math.max(requiredRecovery, m.recovery);
      return passes(m, recovery) && req.every((p) => passes(p, recovery));
    });
    if (passing.length === 0) continue;
    out.push({
      start: s,
      end: e,
      preferred: req.every(clear) && passing.some(clear),
      pool: passing.map((m) => m.id),
    });
  }
  return out;
}

export interface PoolStats {
  id: string;
  preferred: boolean;
  /** Bookings of this link assigned to the member in the counting period. */
  bookings: number;
  /** When the member last got a booking of this link; null: never. */
  lastAssigned: number | null;
}

/** Round-robin assignment among the members who pass (booking-links-team.md rule 16). */
export function pickAssignee(candidates: PoolStats[]): string | undefined {
  const preferred = candidates.filter((c) => c.preferred);
  const pool = preferred.length > 0 ? preferred : candidates;
  return [...pool].sort(
    (a, b) =>
      a.bookings - b.bookings ||
      (a.lastAssigned ?? -1) - (b.lastAssigned ?? -1) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )[0]?.id;
}
