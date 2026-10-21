// A focus goal's preferred window and a habit's ideal time at the end of its
// hours (focus-time.md `preferred_window`, habits-automation.md `ideal_at_end`;
// library entries 7, 11 and 23). The E2E tests cover the library journeys; these
// cover the scheduler rules.
// Failure modes, each covered below:
//  1. The window is treated as hard hours: focus stays out of free afternoons.
//  2. The window is ignored: focus goes to the largest gaps of the first days.
//  3. One day is filled to its maximum outside the window before other days use theirs.
//  4. The daily minimum skips the window, or the window breaks the daily minimum.
//  5. Reactive focus uses the window.
//  6. The end-of-hours ideal reads one end for every day, or ignores a later change.
//  7. A time the user picked for one date loses to the end-of-hours ideal.
//  8. A placed focus event outside the window moves into a free window on a
//     save of other fields (changed: false).
//  9. A snooze (rule 31) loses to the end-of-hours ideal.
import { describe, expect, it } from "vitest";
import type {
  ExternalEvent,
  FocusItem,
  HabitItem,
  Placement,
  Snapshot,
} from "../../src/scheduler/model.ts";
import { plan } from "../../src/scheduler/plan.ts";
import { addDays, localToUtc } from "../../src/shared/time.ts";

const ZONE = "Europe/Berlin";
const MON = "2026-11-02";
const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return localToUtc(ZONE, date, h * 60 + m);
};
const hm = (t: number) =>
  new Date(t).toLocaleString("sv-SE", { timeZone: ZONE }).slice(0, 16).replace(" ", "T");
const spans = (ps: Placement[]) => ps.map((p) => `${hm(p.start)}/${hm(p.end).slice(11)}`).sort();
const of = (r: ReturnType<typeof plan>, id: string) => r.placements.filter((p) => p.itemId === id);
const day = (n: number) => addDays(MON, n);
const range = (s: number, e: number) => [[s, e]] as [number, number][];
const WORK = {
  1: range(540, 1020),
  2: range(540, 1020),
  3: range(540, 1020),
  4: range(540, 1020),
  5: range(540, 1020),
};

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    now: at("2026-11-01", "08:00"),
    zone: ZONE,
    weekStart: 1,
    windowEnd: at(day(7), "00:00"),
    stepMinutes: 15,
    urgencyMode: "priority-only",
    chunkCooldown: "none",
    breakMinutes: 0,
    hours: { work: WORK },
    workHours: ["work"],
    events: [],
    current: [],
    tasks: [],
    habits: [],
    meetings: [],
    buffers: [],
    focus: [],
    ...over,
  };
}

let seq = 0;
const busy = (d: number, from: string, to: string): ExternalEvent => ({
  id: `ext-${++seq}`,
  start: at(day(d), from),
  end: at(day(d), to),
  allDay: false,
  busy: true,
  title: "Meetings",
  description: "",
  selfResponse: null,
  organizerSelf: true,
  attendeeCount: 0,
  location: "",
  eventType: "default",
  bookedViaLink: false,
});
const mornings = (days: number[]) => days.map((d) => busy(d, "09:00", "12:00"));

const goal = (over: Partial<FocusItem> = {}): FocusItem => ({
  id: "focus",
  title: "Focus",
  rank: 0,
  createdAt: 0,
  hours: "work",
  weeklyGoalMinutes: 480,
  dailyMinMinutes: 0,
  dailyMaxMinutes: 240,
  minBlockMinutes: 60,
  maxBlockMinutes: 240,
  busy: true,
  exclusions: [],
  changed: false,
  preferred: { from: 540, to: 720 },
  ...over,
});

describe("focus preferred window", () => {
  it("fills free mornings on every day first, then the largest other gaps", () => {
    const r = plan(snapshot({ focus: [goal()], events: mornings([0, 1, 2, 3]) }));
    expect(spans(of(r, "focus"))).toEqual([
      `${day(0)}T12:00/16:00`,
      `${day(1)}T12:00/13:00`,
      `${day(4)}T09:00/12:00`,
    ]);
    expect(r.report.filter((e) => e.itemKind === "focus")).toEqual([]);
  });

  it("without a window, uses the largest gaps of the first days; free mornings are enough", () => {
    const { preferred: _, ...noWindow } = goal();
    const plain = plan(snapshot({ focus: [noWindow], events: mornings([0, 1, 2, 3]) }));
    expect(spans(of(plain, "focus"))).toEqual([`${day(0)}T12:00/16:00`, `${day(1)}T12:00/16:00`]);
    // With free mornings, every block stays inside the window.
    const free = plan(snapshot({ focus: [goal({ weeklyGoalMinutes: 600 })] }));
    expect(spans(of(free, "focus"))).toEqual([
      ...[0, 1, 2].map((d) => `${day(d)}T09:00/12:00`),
      `${day(3)}T09:00/10:00`,
    ]);
  });

  it("gives each day its daily minimum inside the window before any day gets more", () => {
    const r = plan(
      snapshot({
        focus: [goal({ weeklyGoalMinutes: 600, dailyMinMinutes: 120 })],
        events: mornings([0]),
      }),
    );
    // Monday's morning is busy: its minimum comes from the afternoon; the other days
    // get 2 h in the window, then the window fills up, then Monday afternoon grows.
    const placed = spans(of(r, "focus"));
    expect(placed.filter((s) => s.startsWith(day(0)))).toEqual([`${day(0)}T12:00/14:00`]);
    for (const d of [1, 2, 3, 4]) {
      expect(
        placed
          .filter((s) => s.startsWith(day(d)))
          .every((s) => s.slice(11) >= "09:00" && s.slice(17) <= "12:00"),
      ).toBe(true);
    }
    expect(of(r, "focus").reduce((a, p) => a + (p.end - p.start), 0)).toBe(600 * 60_000);
  });

  it("keeps a placed event outside the window while it is legal, and moves it after a rules change", () => {
    const current = [
      {
        key: `focus:focus:${day(0)}:0`,
        itemId: "focus",
        start: at(day(0), "13:00"),
        end: at(day(0), "15:00"),
        locked: false,
      },
    ];
    const kept = plan(snapshot({ focus: [goal({ weeklyGoalMinutes: 120 })], current }));
    expect(spans(of(kept, "focus"))).toEqual([`${day(0)}T13:00/15:00`]);
    // The window is free: a changed goal (or no sticky rule) places it at 09:00.
    const moved = plan(
      snapshot({ focus: [goal({ weeklyGoalMinutes: 120, changed: true })], current }),
    );
    expect(spans(of(moved, "focus"))).toEqual([`${day(0)}T09:00/11:00`]);
  });

  it("is ignored in reactive mode", () => {
    const events = [...[0, 1, 2].map((d) => busy(d, "09:00", "17:00")), busy(3, "09:00", "15:00")];
    const r = plan(
      snapshot({ focus: [goal({ mode: "reactive", weeklyGoalMinutes: 600 })], events }),
    );
    expect(spans(of(r, "focus"))).toEqual([`${day(3)}T15:00/17:00`, `${day(4)}T09:00/17:00`]);
  });
});

const habit = (over: Partial<HabitItem> = {}): HabitItem => ({
  id: "wrap",
  title: "Wrap-up",
  level: 3,
  rank: 0,
  createdAt: 0,
  hours: "work",
  idealMinute: 990,
  minMinutes: 30,
  maxMinutes: 30,
  frequency: { period: "daily" },
  starting: null,
  defense: "always-busy",
  whenUnplaceable: "remove",
  reservedWords: [],
  skips: [],
  exclusions: [],
  changed: false,
  idealAtEnd: true,
  ...over,
});

describe("habit ideal time at the end of the hours", () => {
  // Friday ends at 15:00, Monday at 18:00, Wednesday has two ranges ending at 16:00.
  const hours = {
    work: {
      ...WORK,
      1: range(540, 1080),
      3: [
        [540, 720],
        [780, 960],
      ] as [number, number][],
      5: range(540, 900),
    },
  };

  it("reads the end of each day's last range", () => {
    const r = plan(snapshot({ hours, habits: [habit()] }));
    expect(spans(of(r, "wrap"))).toEqual([
      `${day(0)}T17:30/18:00`,
      `${day(1)}T16:30/17:00`,
      `${day(2)}T15:30/16:00`,
      `${day(3)}T16:30/17:00`,
      `${day(4)}T14:30/15:00`,
    ]);
    // A fixed ideal time (16:30) keeps Monday at 16:30.
    const fixed = plan(snapshot({ hours, habits: [habit({ idealAtEnd: false })] }));
    expect(spans(of(fixed, "wrap"))[0]).toBe(`${day(0)}T16:30/17:00`);
  });

  it("moves to the nearest free start when the end is busy, and a picked time wins", () => {
    const r = plan(
      snapshot({
        hours,
        habits: [habit({ rescheduled: { [day(1)]: 600 } })],
        events: [busy(0, "17:00", "18:00")],
      }),
    );
    const placed = spans(of(r, "wrap"));
    expect(placed[0]).toBe(`${day(0)}T16:30/17:00`);
    expect(placed[1]).toBe(`${day(1)}T10:00/10:30`);
  });

  it("a snooze wins: the first free start at or after the not-before time", () => {
    const r = plan(snapshot({ hours, habits: [habit({ notBefore: { [day(0)]: 600 } })] }));
    const placed = spans(of(r, "wrap"));
    // Monday's end-of-hours start is 17:30; the snooze to 10:00 places it at 10:00.
    expect(placed[0]).toBe(`${day(0)}T10:00/10:30`);
    expect(placed[1]).toBe(`${day(1)}T16:30/17:00`);
  });
});
