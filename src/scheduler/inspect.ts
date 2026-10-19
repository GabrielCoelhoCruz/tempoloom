// The availability inspector (docs/specs/booking-links-availability.md rules
// 18-22): every candidate start of a link with each check that fails. It runs
// the same checks as teamOffers, all of them for each time, so organizers can
// see why a time is not offered. It never changes what is offered.
import { addDays, localToUtc, MINUTE, utcToLocal, weekdayOf } from "../shared/time.ts";
import type { Booking, CalendarItem, Person, TeamRules } from "./availability.ts";
import { hoursToTimeSet } from "./hours.ts";
import { type Interval, TimeSet } from "./timeset.ts";

export type Reason =
  | "past"
  | "beforeRangeStart"
  | "afterRangeEnd"
  | "limitReached"
  | "outsideHours"
  | "buffer"
  | "conflict"
  | "higherPriority";

export interface Failure {
  code: Reason;
  /** The person the check failed for; none for link-wide checks. */
  personId?: string;
  /** The blocking event, for buffer, conflict and higherPriority. */
  item?: CalendarItem;
}

export interface InspectedTime {
  start: number;
  end: number;
  offered: boolean;
  preferred: boolean;
  failures: Failure[];
}

const STEP = 15 * MINUTE;

interface Checked {
  id: string;
  hours: TimeSet;
  items: CalendarItem[];
  recovery: number;
}

/**
 * Every start from the beginning to the end of the people's hours on each day
 * (Tempoloom decision under rule 19), with the failed checks of each.
 */
export function inspectTimes(
  rules: TeamRules,
  required: Person[],
  pool: Person[],
  bookings: Booking[],
  now: number,
  from: number,
  to: number,
): InspectedTime[] {
  if (required.length === 0 && pool.length === 0) return [];
  const len = rules.durationMinutes * MINUTE;
  const today = utcToLocal(rules.zone, now).date;
  const rangeEnd = localToUtc(rules.zone, addDays(today, rules.rangeEndDays + 1), 0);
  const earliest = now + rules.noticeMinutes * MINUTE;
  const blocks = (i: CalendarItem) =>
    i.cls === "booked" ||
    i.cls === "fixed" ||
    (i.cls === "prioritized" && (i.level ?? 1) <= rules.level);
  const check = (p: Person): Checked => ({
    id: p.id,
    hours: hoursToTimeSet(p.hours, p.zone, from, to + len),
    items: p.items,
    recovery: p.recoveryMinutes,
  });
  const req = required.map(check);
  const members = pool.map(check);
  const requiredRecovery = Math.max(0, ...req.map((p) => p.recovery));

  const dayKey = (t: number) => utcToLocal(rules.zone, t).date;
  const weekKey = (t: number) => {
    const d = dayKey(t);
    return addDays(d, -((weekdayOf(d) - rules.weekStart + 7) % 7));
  };
  const perDay = new Map<string, number>();
  const perWeek = new Map<string, number>();
  for (const b of bookings) {
    perDay.set(dayKey(b.start), (perDay.get(dayKey(b.start)) ?? 0) + 1);
    perWeek.set(weekKey(b.start), (perWeek.get(weekKey(b.start)) ?? 0) + 1);
  }

  /** The checks of one person for the slot; empty when the person passes. */
  const personFailures = (p: Checked, s: number, e: number, recovery: number): Failure[] => {
    const out: Failure[] = [];
    if (!p.hours.contains({ start: s, end: e })) out.push({ code: "outsideHours", personId: p.id });
    const before = s - rules.bufferBeforeMinutes * MINUTE;
    const after = e + Math.max(rules.bufferAfterMinutes, recovery) * MINUTE;
    for (const i of p.items) {
      if (!blocks(i)) continue;
      if (i.start < e && i.end > s) {
        const code = i.cls === "prioritized" ? "higherPriority" : "conflict";
        out.push({ code, personId: p.id, item: i });
      } else if (i.start < after && i.end > before) {
        out.push({ code: "buffer", personId: p.id, item: i });
      }
    }
    return out;
  };
  const clear = (p: Checked, s: number, e: number) =>
    !p.items.some((i) => i.start < e && i.end > s);

  // Candidate starts: each day from the first start to the last end of anyone's hours.
  const union = TimeSet.from(
    [...req, ...members].flatMap((p) => p.hours.intervals() as Interval[]),
  );
  const starts: number[] = [];
  for (let date = dayKey(from); ; date = addDays(date, 1)) {
    const dayStart = localToUtc(rules.zone, date, 0);
    if (dayStart >= to) break;
    const dayEnd = localToUtc(rules.zone, addDays(date, 1), 0);
    const parts = union.clip(dayStart, dayEnd).intervals();
    const first = parts[0];
    const last = parts.at(-1);
    if (!first || !last) continue;
    for (let s = Math.ceil(first.start / STEP) * STEP; s < last.end; s += STEP) {
      if (s >= from && s < to) starts.push(s);
    }
  }

  return starts.map((s): InspectedTime => {
    const e = s + len;
    const failures: Failure[] = [];
    if (s < now) failures.push({ code: "past" });
    else if (s < earliest) failures.push({ code: "beforeRangeStart" });
    if (s >= rangeEnd) failures.push({ code: "afterRangeEnd" });
    if (
      (rules.maxPerDay !== null && (perDay.get(dayKey(s)) ?? 0) >= rules.maxPerDay) ||
      (rules.maxPerWeek !== null && (perWeek.get(weekKey(s)) ?? 0) >= rules.maxPerWeek)
    ) {
      failures.push({ code: "limitReached" });
    }
    for (const p of req) failures.push(...personFailures(p, s, e, requiredRecovery));
    let passing: Checked[] = [];
    if (members.length > 0) {
      // Round robin: one member must pass together with the required people (rule 17).
      const recoveryOf = (m: Checked) => Math.max(requiredRecovery, m.recovery);
      passing = members.filter(
        (m) =>
          personFailures(m, s, e, recoveryOf(m)).length === 0 &&
          req.every((p) => personFailures(p, s, e, recoveryOf(m)).length === 0),
      );
      if (passing.length === 0) {
        for (const m of members) {
          const own = personFailures(m, s, e, recoveryOf(m));
          failures.push(
            ...(own.length > 0 ? own : req.flatMap((p) => personFailures(p, s, e, recoveryOf(m)))),
          );
        }
      }
    }
    const offered = failures.length === 0;
    return {
      start: s,
      end: e,
      offered,
      preferred:
        offered &&
        req.every((p) => clear(p, s, e)) &&
        (members.length === 0 || passing.some((m) => clear(m, s, e))),
      failures,
    };
  });
}
