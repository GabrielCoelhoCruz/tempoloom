// Failure modes of the availability inspector (docs/specs/booking-links-availability.md
// rules 18-22):
//  1. The inspector offers a time the booking page does not, or the reverse:
//     it must only explain availability, never change it.                     (rule 22)
//  2. A failed check is missing from the reasons, or a time lists a reason that
//     did not fail (past, range, limit, hours, buffer, conflict, priority).    (rules 5-12, 20)
//  3. The inspector stops at the first failure instead of listing them all.    (rule 4)
//  4. A reason does not name the person it applies to, or the blocking event.  (rule 21)
//  5. Times not offered are left out of the list; the night is listed.        (rule 19, decision)
//  6. A round-robin time lists the pool members' reasons when one member is free.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type CalendarItem,
  type Person,
  type TeamRules,
  teamOffers,
} from "../../src/scheduler/availability.ts";
import { inspectTimes } from "../../src/scheduler/inspect.ts";
import { localToUtc } from "../../src/shared/time.ts";

const ZONE = "Europe/Berlin";
const MON = "2026-11-09";
const TUE = "2026-11-10";
const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return localToUtc(ZONE, date, h * 60 + m);
};
const NINE_TO_FIVE = { 1: [[540, 1020]], 2: [[540, 1020]], 3: [[540, 1020]] } as const;

const rules = (over: Partial<TeamRules> = {}): TeamRules => ({
  durationMinutes: 30,
  level: 3,
  zone: ZONE,
  weekStart: 1,
  noticeMinutes: 0,
  rangeEndDays: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  maxPerDay: null,
  maxPerWeek: null,
  ...over,
});
const person = (id: string, items: CalendarItem[] = [], hours = NINE_TO_FIVE): Person => ({
  id,
  hours,
  zone: ZONE,
  items,
  recoveryMinutes: 0,
});
const now = at("2026-11-08", "20:00");
const from = at(MON, "00:00");
const to = at("2026-11-11", "00:00");
const codes = (list: ReturnType<typeof inspectTimes>, t: number) =>
  list.find((x) => x.start === t)?.failures.map((f) => f.code) ?? null;

describe("inspectTimes", () => {
  it("lists every quarter hour from the start to the end of the day's hours, offered or not", () => {
    const list = inspectTimes(rules(), [person("a")], [], [], now, from, at(TUE, "00:00"));
    expect(list[0]?.start).toBe(at(MON, "09:00"));
    expect(list.at(-1)?.start).toBe(at(MON, "16:45"));
    expect(list).toHaveLength(32);
    // A slot that starts inside the hours and ends after them (edge case 3).
    expect(codes(list, at(MON, "16:45"))).toEqual(["outsideHours"]);
    expect(list.find((x) => x.start === at(MON, "16:45"))?.failures[0]?.personId).toBe("a");
    expect(codes(list, at(MON, "16:30"))).toEqual([]);
  });

  it("names each failed check with its person and blocking event", () => {
    const board: CalendarItem = {
      start: at(MON, "10:00"),
      end: at(MON, "11:00"),
      cls: "fixed",
      title: "Board",
    };
    const habit: CalendarItem = {
      start: at(MON, "13:00"),
      end: at(MON, "14:00"),
      cls: "prioritized",
      level: 2,
      title: "Habit",
    };
    const low: CalendarItem = {
      start: at(MON, "15:00"),
      end: at(MON, "16:00"),
      cls: "prioritized",
      level: 4,
    };
    const free: CalendarItem = { start: at(MON, "09:00"), end: at(MON, "09:30"), cls: "free" };
    const list = inspectTimes(
      rules({ bufferBeforeMinutes: 15 }),
      [person("a", [board, habit, low, free])],
      [],
      [],
      now,
      from,
      at(TUE, "00:00"),
    );
    expect(codes(list, at(MON, "09:00"))).toEqual([]);
    expect(codes(list, at(MON, "10:15"))).toEqual(["conflict"]);
    const conflict = list.find((x) => x.start === at(MON, "10:15"))?.failures[0];
    expect(conflict?.personId).toBe("a");
    expect(conflict?.item?.title).toBe("Board");
    expect(codes(list, at(MON, "11:00"))).toEqual(["buffer"]);
    expect(list.find((x) => x.start === at(MON, "11:00"))?.failures[0]?.item?.title).toBe("Board");
    expect(codes(list, at(MON, "13:30"))).toEqual(["higherPriority"]);
    expect(codes(list, at(MON, "15:00"))).toEqual([]);
  });

  it("lists every failed check of a time, not only the first", () => {
    const board: CalendarItem = { start: at(MON, "16:30"), end: at(MON, "17:30"), cls: "fixed" };
    const list = inspectTimes(
      rules({ maxPerDay: 1 }),
      [person("a", [board])],
      [],
      [{ id: "b1", start: at(MON, "09:00"), end: at(MON, "09:30") }],
      now,
      from,
      at(TUE, "00:00"),
    );
    expect(codes(list, at(MON, "16:45"))?.sort()).toEqual(
      ["conflict", "limitReached", "outsideHours"].sort(),
    );
  });

  it("marks the past, too little notice and the range end", () => {
    const mid = at(MON, "12:00");
    const list = inspectTimes(
      rules({ noticeMinutes: 120, rangeEndDays: 0 }),
      [person("a")],
      [],
      [],
      mid,
      from,
      to,
    );
    expect(codes(list, at(MON, "11:00"))).toEqual(["past"]);
    expect(codes(list, at(MON, "13:00"))).toEqual(["beforeRangeStart"]);
    expect(codes(list, at(MON, "14:00"))).toEqual([]);
    expect(codes(list, at(TUE, "10:00"))).toEqual(["afterRangeEnd"]);
  });

  it("gives a round-robin time the pool's reasons only when no member is free", () => {
    const busy = (s: string, e: string): CalendarItem => ({
      start: at(MON, s),
      end: at(MON, e),
      cls: "fixed",
    });
    const list = inspectTimes(
      rules(),
      [],
      [person("p1", [busy("10:00", "12:00")]), person("p2", [busy("11:00", "12:00")])],
      [],
      now,
      from,
      at(TUE, "00:00"),
    );
    expect(codes(list, at(MON, "10:00"))).toEqual([]);
    const both = list.find((x) => x.start === at(MON, "11:00"));
    expect(both?.offered).toBe(false);
    expect(both?.failures.map((f) => f.personId).sort()).toEqual(["p1", "p2"]);
  });

  it("offers exactly the times the booking page offers (property)", () => {
    const slot = fc
      .tuple(fc.integer({ min: 0, max: 47 }), fc.integer({ min: 1, max: 8 }))
      .map(([q, len]) => ({ start: from + q * 30 * 60_000, end: from + (q + len) * 30 * 60_000 }));
    const item = fc
      .tuple(
        slot,
        fc.constantFrom("free", "booked", "fixed", "prioritized"),
        fc.integer({ min: 1, max: 4 }),
      )
      .map(
        ([s, cls, level]): CalendarItem =>
          cls === "prioritized" ? { ...s, cls, level: level as 1 | 2 | 3 | 4 } : { ...s, cls },
      );
    fc.assert(
      fc.property(
        fc.array(item, { maxLength: 6 }),
        fc.array(item, { maxLength: 6 }),
        fc.integer({ min: 1, max: 4 }),
        fc.constantFrom(0, 15, 30),
        fc.constantFrom(30, 60),
        fc.boolean(),
        (aItems, bItems, level, buffer, duration, pool) => {
          const r = rules({
            level: level as 1 | 2 | 3 | 4,
            bufferBeforeMinutes: buffer,
            bufferAfterMinutes: buffer,
            durationMinutes: duration,
          });
          const a = person("a", aItems);
          const b = person("b", bItems);
          const required = pool ? [] : [a, b];
          const members = pool ? [a, b] : [];
          const offered = teamOffers(r, required, members, [], now, from, to).map((t) => t.start);
          const inspected = inspectTimes(r, required, members, [], now, from, to);
          expect(inspected.filter((t) => t.offered).map((t) => t.start)).toEqual(offered);
          for (const t of inspected) expect(t.offered).toBe(t.failures.length === 0);
        },
      ),
      { numRuns: 200 },
    );
  });
});
