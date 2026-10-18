// Failure modes of team and round-robin availability and assignment
// (docs/specs/booking-links-team.md, booking-links-availability.md rules 10, 16-17):
//  1. A time is offered while one required person is outside their own hours,
//     read in their own time zone.                                       (rules 8, 16)
//  2. A time is offered while one required person has a blocking event.     (rule 16)
//  3. A round-robin time is offered when no pool member passes, or the list
//     of passing members includes one who fails.                          (rule 17)
//  4. Required people are not checked on a round-robin link.          (team rule 14)
//  5. A link with no required people and no pool offers times.     (edge case 1)
//  6. The recovery check uses one person's buffer instead of the longest.   (rule 10)
//  7. "Preferred" ignores the pool member's calendar.                       (rule 15)
//  8. A rescheduled booking blocks itself on another person's calendar.
//  9. Assignment: preferred is not checked first, load is not compared, the
//     tie-break is not the oldest assignment, then the lowest id.     (team rule 16)
import { describe, expect, it } from "vitest";
import {
  type CalendarItem,
  type Person,
  pickAssignee,
  type TeamRules,
  teamOffers,
} from "../../src/scheduler/availability.ts";
import { localToUtc } from "../../src/shared/time.ts";

const ZONE = "Europe/Berlin";
const TUE = "2026-11-10";
const at = (hhmm: string, zone = ZONE) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return localToUtc(zone, TUE, h * 60 + m);
};
const hm = (t: number) => new Date(t).toLocaleString("sv-SE", { timeZone: ZONE }).slice(11, 16);
const NINE_TO_FIVE = { 2: [[540, 1020]] } as const;
const ONE_TO_FIVE = { 2: [[780, 1020]] } as const;

const rules: TeamRules = {
  durationMinutes: 30,
  level: 4,
  zone: ZONE,
  weekStart: 1,
  noticeMinutes: 0,
  rangeEndDays: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  maxPerDay: null,
  maxPerWeek: null,
};
const person = (id: string, over: Partial<Person> = {}): Person => ({
  id,
  hours: NINE_TO_FIVE,
  zone: ZONE,
  items: [],
  recoveryMinutes: 0,
  ...over,
});
const now = localToUtc(ZONE, "2026-11-08", 20 * 60);
const from = localToUtc(ZONE, TUE, 0);
const to = localToUtc(ZONE, "2026-11-11", 0);
const busy = (a: string, b: string, extra: Partial<CalendarItem> = {}): CalendarItem => ({
  start: at(a),
  end: at(b),
  cls: "fixed",
  ...extra,
});
const offer = (required: Person[], pool: Person[] = [], resched?: string) =>
  teamOffers(rules, required, pool, [], now, from, to, resched);
const starts = (required: Person[], pool: Person[] = []) =>
  offer(required, pool).map((t) => hm(t.start));

describe("teamOffers", () => {
  it("offers only times inside every required person's hours, in their own zone", () => {
    const s = starts([person("a"), person("c", { hours: ONE_TO_FIVE })]);
    expect(s[0]).toBe("13:00");
    expect(s.at(-1)).toBe("16:30");
    // London is one hour behind Berlin: 09:00 to 17:00 London is 10:00 to 18:00 here.
    const london = starts([person("a"), person("l", { zone: "Europe/London" })]);
    expect(london[0]).toBe("10:00");
    expect(london.at(-1)).toBe("16:30");
  });

  it("does not offer a time when one required person has a blocking event", () => {
    const s = starts([person("a"), person("c", { items: [busy("10:00", "11:00")] })]);
    expect(s).toContain("09:30");
    expect(s).not.toContain("10:00");
    expect(s).not.toContain("10:30");
    expect(s).toContain("11:00");
  });

  it("offers a round-robin time when at least one pool member passes, and lists only those", () => {
    const a = person("a", { items: [busy("15:00", "16:00")] });
    const c = person("c", { hours: ONE_TO_FIVE });
    const times = offer([], [a, c]);
    const byStart = new Map(times.map((t) => [hm(t.start), t.pool]));
    expect(byStart.get("09:00")).toEqual(["a"]);
    expect(byStart.get("14:00")).toEqual(["a", "c"]);
    expect(byStart.get("15:00")).toEqual(["c"]);
    const both = person("c", { hours: ONE_TO_FIVE, items: [busy("15:00", "16:00")] });
    expect(offer([], [a, both]).map((t) => hm(t.start))).not.toContain("15:00");
  });

  it("checks the required people of a round-robin link too", () => {
    const d = person("d", { items: [busy("09:00", "10:00")] });
    const s = starts([d], [person("a"), person("c")]);
    expect(s).not.toContain("09:00");
    expect(s).toContain("10:00");
  });

  it("offers nothing without required people and without a pool", () => {
    expect(starts([], [])).toEqual([]);
  });

  it("keeps the longest recovery buffer among the people free on each calendar", () => {
    const a = person("a", { recoveryMinutes: 15 });
    const c = person("c", { items: [busy("14:00", "15:00")] });
    const s = starts([a, c]);
    expect(s).toContain("13:15");
    expect(s).not.toContain("13:30");
    // In a pool, the required people's buffer applies to each member, and each
    // member's own buffer applies to the required people.
    const fromRequired = offer([person("o", { recoveryMinutes: 15 })], [person("p"), c]);
    expect(fromRequired.find((t) => hm(t.start) === "13:30")?.pool).toEqual(["p"]);
    const busyO = person("o", { items: [busy("14:00", "15:00")] });
    const fromMember = offer([busyO], [person("p", { recoveryMinutes: 15 }), person("q")]);
    expect(fromMember.find((t) => hm(t.start) === "13:30")?.pool).toEqual(["q"]);
  });

  it("marks a round-robin time preferred only when a passing pool member has nothing there", () => {
    const free: CalendarItem = { ...busy("09:00", "10:00"), cls: "free" };
    const times = offer([], [person("a", { items: [free] }), person("c", { hours: ONE_TO_FIVE })]);
    expect(times.find((t) => hm(t.start) === "09:00")?.preferred).toBe(false);
    expect(times.find((t) => hm(t.start) === "13:00")?.preferred).toBe(true);
  });

  it("ignores the booking being rescheduled on every person's calendar", () => {
    const copy = busy("10:00", "10:30", { cls: "booked", bookingId: "b1" });
    const s = offer([person("a", { items: [copy] }), person("c", { items: [copy] })], [], "b1");
    expect(s.map((t) => hm(t.start))).toContain("10:00");
  });
});

describe("pickAssignee", () => {
  it("prefers preferred members, even with more bookings", () => {
    expect(
      pickAssignee([
        { id: "a", preferred: true, bookings: 3, lastAssigned: 5 },
        { id: "c", preferred: false, bookings: 0, lastAssigned: null },
      ]),
    ).toBe("a");
  });

  it("then takes the member with the fewest bookings", () => {
    expect(
      pickAssignee([
        { id: "a", preferred: false, bookings: 2, lastAssigned: 1 },
        { id: "c", preferred: false, bookings: 1, lastAssigned: 9 },
      ]),
    ).toBe("c");
  });

  it("breaks ties by the oldest last assignment (never counts as oldest), then the lowest id", () => {
    expect(
      pickAssignee([
        { id: "a", preferred: false, bookings: 1, lastAssigned: 9 },
        { id: "c", preferred: false, bookings: 1, lastAssigned: 4 },
      ]),
    ).toBe("c");
    expect(
      pickAssignee([
        { id: "c", preferred: false, bookings: 0, lastAssigned: null },
        { id: "b", preferred: false, bookings: 0, lastAssigned: null },
        { id: "a", preferred: false, bookings: 0, lastAssigned: 1 },
      ]),
    ).toBe("b");
  });

  it("returns nothing for an empty list", () => {
    expect(pickAssignee([])).toBeUndefined();
  });
});
