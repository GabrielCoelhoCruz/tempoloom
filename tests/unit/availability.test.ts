// Failure modes of booking-link availability (docs/specs/booking-links-availability.md):
//  1. A time before now plus the notice, or after the range end, is offered.   (rules 5, 6)
//  2. A slot that is only partly inside the link hours is offered.              (rule 8)
//  3. A slot over a booked or fixed event is offered.                           (rule 11)
//  4. A free event blocks a time.                                               (rule 13)
//  5. Link priority is compared the wrong way with managed events.              (rule 12)
//  6. The per-day or per-week limit is not enforced.                            (rule 9)
//  7. The buffers before and after the slot are not checked.                    (rule 10)
//  8. "Preferred" is set while some event overlaps the time.                    (rule 15)
//  9. In reschedule mode, the booking being moved blocks its own time.         (booking-links rule 17)
// 10. Starts are not on the quarter hour.                                       (rule 1)
import { describe, expect, it } from "vitest";
import {
  type CalendarItem,
  type LinkRules,
  offeredTimes,
} from "../../src/scheduler/availability.ts";
import { localToUtc } from "../../src/shared/time.ts";

const ZONE = "Europe/Berlin";
const MON = "2026-11-09";
const TUE = "2026-11-10";
const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return localToUtc(ZONE, date, h * 60 + m);
};
const hm = (t: number) =>
  new Date(t).toLocaleString("sv-SE", { timeZone: ZONE }).slice(0, 16).replace(" ", "T");
const MEETING = { 1: [[540, 720]], 2: [[540, 720]] } as const;

const rules = (over: Partial<LinkRules> = {}): LinkRules => ({
  durationMinutes: 60,
  level: 2,
  hours: MEETING,
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
const now = at("2026-11-08", "20:00");
const from = at(MON, "00:00");
const to = at("2026-11-11", "00:00");
const starts = (
  r: LinkRules,
  items: CalendarItem[] = [],
  bookings: { id: string; start: number; end: number }[] = [],
  n = now,
) => offeredTimes(r, items, bookings, n, from, to).map((t) => hm(t.start));

describe("offeredTimes", () => {
  it("offers quarter-hour starts that fit inside the hours", () => {
    expect(starts(rules()).filter((s) => s.startsWith(MON))).toEqual([
      `${MON}T09:00`,
      `${MON}T09:15`,
      `${MON}T09:30`,
      `${MON}T09:45`,
      `${MON}T10:00`,
      `${MON}T10:15`,
      `${MON}T10:30`,
      `${MON}T10:45`,
      `${MON}T11:00`,
    ]);
  });

  it("respects the notice and the range end", () => {
    const n = at(MON, "10:10");
    const withNotice = starts(rules({ noticeMinutes: 60, durationMinutes: 30 }), [], [], n);
    expect(withNotice[0]).toBe(`${MON}T11:15`);
    const short = offeredTimes(rules({ rangeEndDays: 0 }), [], [], at(MON, "08:00"), from, to).map(
      (t) => hm(t.start),
    );
    expect(short.every((s) => s.startsWith(MON))).toBe(true);
    expect(short.length).toBeGreaterThan(0);
  });

  it("never offers time over booked or fixed events, but ignores free events", () => {
    const items: CalendarItem[] = [
      { start: at(MON, "09:00"), end: at(MON, "10:00"), cls: "fixed" },
      { start: at(MON, "10:00"), end: at(MON, "11:00"), cls: "booked" },
      { start: at(TUE, "09:00"), end: at(TUE, "12:00"), cls: "free" },
    ];
    const s = starts(rules(), items);
    expect(s.filter((x) => x.startsWith(MON))).toEqual([`${MON}T11:00`]);
    expect(s.filter((x) => x.startsWith(TUE))).toHaveLength(9);
  });

  it("offers time over lower-priority managed events only (P1 is highest)", () => {
    const task: CalendarItem = {
      start: at(MON, "09:00"),
      end: at(MON, "12:00"),
      cls: "prioritized",
      level: 2,
    };
    const p1 = starts(rules({ level: 1 }), [task]).filter((x) => x.startsWith(MON));
    const p2 = starts(rules({ level: 2 }), [task]).filter((x) => x.startsWith(MON));
    const p3 = starts(rules({ level: 3 }), [task]).filter((x) => x.startsWith(MON));
    expect(p1).toHaveLength(9);
    expect(p2).toEqual([]);
    expect(p3).toEqual([]);
  });

  it("enforces the per-day and per-week limits", () => {
    const booked = [{ id: "b1", start: at(MON, "09:00"), end: at(MON, "10:00") }];
    const items: CalendarItem[] = [
      { start: at(MON, "09:00"), end: at(MON, "10:00"), cls: "booked", bookingId: "b1" },
    ];
    const perDay = starts(rules({ maxPerDay: 1 }), items, booked);
    expect(perDay.some((x) => x.startsWith(MON))).toBe(false);
    expect(perDay.some((x) => x.startsWith(TUE))).toBe(true);
    expect(starts(rules({ maxPerWeek: 1 }), items, booked)).toEqual([]);
  });

  it("needs free buffer time before and after the slot", () => {
    const items: CalendarItem[] = [
      { start: at(MON, "11:00"), end: at(MON, "11:30"), cls: "fixed" },
    ];
    const s = starts(rules({ bufferBeforeMinutes: 15, bufferAfterMinutes: 15 }), items).filter(
      (x) => x.startsWith(MON),
    );
    // 09:45 ends at 10:45; with its 15-minute buffer it ends exactly at 11:00, which is allowed.
    expect(s).toEqual([`${MON}T09:00`, `${MON}T09:15`, `${MON}T09:30`, `${MON}T09:45`]);
  });

  it("marks a time preferred only when nothing overlaps it, not even a free event", () => {
    const items: CalendarItem[] = [
      { start: at(MON, "09:00"), end: at(MON, "09:30"), cls: "free" },
      { start: at(MON, "10:00"), end: at(MON, "10:30"), cls: "prioritized", level: 4 },
    ];
    const times = offeredTimes(rules(), items, [], now, from, to).filter((t) =>
      hm(t.start).startsWith(MON),
    );
    const pref = new Map(times.map((t) => [hm(t.start).slice(11), t.preferred]));
    expect(pref.get("09:00")).toBe(false);
    expect(pref.get("10:15")).toBe(false);
    expect(pref.get("10:30")).toBe(true);
  });

  it("ignores the booking being rescheduled, for conflicts and limits", () => {
    const booked = [{ id: "b1", start: at(MON, "09:00"), end: at(MON, "10:00") }];
    const items: CalendarItem[] = [
      { start: at(MON, "09:00"), end: at(MON, "10:00"), cls: "booked", bookingId: "b1" },
    ];
    const s = offeredTimes(rules({ maxPerDay: 1 }), items, booked, now, from, to, "b1").map((t) =>
      hm(t.start),
    );
    expect(s).toContain(`${MON}T09:00`);
  });
});
