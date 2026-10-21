// Habit dependencies (habits-automation.md rule 18, meetings-flexible.md rule
// 22) and the snooze of one occurrence (rule 31) in the scheduler.
import { describe, expect, it } from "vitest";
import type {
  ExternalEvent,
  HabitItem,
  MeetingItem,
  Placement,
  Snapshot,
  TaskItem,
} from "../../src/scheduler/model.ts";
import { plan } from "../../src/scheduler/plan.ts";
import { addDays, localToUtc } from "../../src/shared/time.ts";

const ZONE = "Europe/Berlin";
const MON = "2026-11-09";
const day = (n: number) => addDays(MON, n);
const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return localToUtc(ZONE, date, h * 60 + m);
};
const hm = (t: number) =>
  new Date(t).toLocaleString("sv-SE", { timeZone: ZONE }).slice(0, 16).replace(" ", "T");
const WORK = {
  1: [[540, 1020]],
  2: [[540, 1020]],
  3: [[540, 1020]],
  4: [[540, 1020]],
  5: [[540, 1020]],
} as const;

const snapshot = (over: Partial<Snapshot>): Snapshot => ({
  now: at(day(-1), "12:00"),
  zone: ZONE,
  weekStart: 1,
  windowEnd: at(day(5), "00:00"),
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
});
const habit = (over: Partial<HabitItem> & { id: string }): HabitItem => ({
  title: over.id,
  level: 3,
  rank: 0,
  createdAt: 0,
  hours: "work",
  idealMinute: 720,
  minMinutes: 30,
  maxMinutes: 30,
  frequency: { period: "daily" },
  starting: MON,
  defense: "always-busy",
  whenUnplaceable: "remove",
  reservedWords: [],
  skips: [],
  exclusions: [],
  changed: false,
  ...over,
});
const meeting = (over: Partial<MeetingItem> & { id: string }): MeetingItem => ({
  title: over.id,
  level: 3,
  rank: 0,
  createdAt: 0,
  hours: "work",
  attendeeWindow: null,
  attendeeBusy: [],
  idealMinute: 600,
  frequency: { period: "weekly", everyWeeks: 1, idealDays: [2] },
  durationMinutes: 60,
  shortestMinutes: 60,
  starting: MON,
  defense: "busy",
  whenUnplaceable: "remove",
  leadMinutes: 0,
  exclusions: [],
  changed: false,
  ...over,
});
const busy = (start: number, end: number): ExternalEvent => ({
  id: `e${start}`,
  start,
  end,
  allDay: false,
  busy: true,
  title: "Busy",
  description: "",
  selfResponse: null,
  organizerSelf: true,
  attendeeCount: 0,
  location: "",
  eventType: "default",
  bookedViaLink: false,
});
const spans = (p: { placements: Placement[] }, id: string) =>
  p.placements
    .filter((x) => x.itemId === id)
    .sort((a, b) => a.start - b.start)
    .map((x) => `${hm(x.start)}/${hm(x.end).slice(11)}`);

describe("habit dependencies (rule 18)", () => {
  const standup = habit({
    id: "standup",
    idealMinute: 600,
    frequency: { period: "weekly", days: [1, 3] },
  });

  it("before: only on the target's days, ending before it, even when the habit has the higher priority", () => {
    const review = habit({
      id: "review",
      level: 1,
      idealMinute: 660,
      dependencies: [{ rule: "before", kind: "habit", id: "standup" }],
    });
    const p = plan(snapshot({ habits: [review, standup] }));
    expect(spans(p, "standup")).toEqual([`${day(0)}T10:00/10:30`, `${day(2)}T10:00/10:30`]);
    expect(spans(p, "review")).toEqual([`${day(0)}T09:30/10:00`, `${day(2)}T09:30/10:00`]);
  });

  it("without the rule the habit keeps its ideal time every day", () => {
    const p = plan(snapshot({ habits: [habit({ id: "review", idealMinute: 660 }), standup] }));
    expect(spans(p, "review")).toHaveLength(5);
    expect(spans(p, "review")[0]).toBe(`${day(0)}T11:00/11:30`);
  });

  it("not after: limits the target's days only", () => {
    const review = habit({
      id: "review",
      idealMinute: 660,
      dependencies: [{ rule: "not-after", kind: "habit", id: "standup" }],
    });
    const p = plan(snapshot({ habits: [review, standup] }));
    expect(spans(p, "review")).toEqual([
      `${day(0)}T09:30/10:00`,
      `${day(1)}T11:00/11:30`,
      `${day(2)}T09:30/10:00`,
      `${day(3)}T11:00/11:30`,
      `${day(4)}T11:00/11:30`,
    ]);
  });

  it("not on the same day: skips the target's days", () => {
    const gym = habit({
      id: "gym",
      dependencies: [{ rule: "not-same-day", kind: "habit", id: "standup" }],
    });
    const p = plan(snapshot({ habits: [gym, standup] }));
    expect(spans(p, "gym").map((s) => s.slice(0, 10))).toEqual([day(1), day(3), day(4)]);
  });

  it("before a flexible meeting: the habit goes before it on its day and never moves it", () => {
    const prep = habit({
      id: "prep",
      level: 1,
      idealMinute: 840,
      dependencies: [{ rule: "before", kind: "meeting", id: "sync" }],
    });
    const p = plan(snapshot({ habits: [prep], meetings: [meeting({ id: "sync" })] }));
    expect(spans(p, "sync")).toEqual([`${day(1)}T10:00/11:00`]);
    expect(spans(p, "prep")).toEqual([`${day(1)}T09:30/10:00`]);
  });

  it("no legal slot before the target: unplaced, never a conflict after it", () => {
    const prep = habit({
      id: "prep",
      whenUnplaceable: "keep_as_conflict",
      dependencies: [{ rule: "before", kind: "meeting", id: "sync" }],
    });
    const p = plan(
      snapshot({
        habits: [prep],
        meetings: [meeting({ id: "sync" })],
        events: [busy(at(day(1), "09:00"), at(day(1), "10:00"))],
      }),
    );
    expect(spans(p, "sync")).toEqual([`${day(1)}T10:00/11:00`]);
    const conflict = p.placements.find((x) => x.itemId === "prep");
    expect(conflict ? conflict.end <= at(day(1), "10:00") : true).toBe(true);
  });

  it("a target that is not planned (off or deleted) adds no rule", () => {
    const review = habit({
      id: "review",
      idealMinute: 660,
      dependencies: [{ rule: "before", kind: "habit", id: "gone" }],
    });
    expect(spans(plan(snapshot({ habits: [review] })), "review")).toHaveLength(5);
  });

  it("habits in a cycle are still placed", () => {
    const a = habit({ id: "a", dependencies: [{ rule: "not-after", kind: "habit", id: "b" }] });
    const b = habit({ id: "b", dependencies: [{ rule: "not-after", kind: "habit", id: "a" }] });
    const p = plan(snapshot({ habits: [a, b] }));
    expect(spans(p, "a")).toHaveLength(5);
    expect(spans(p, "b")).toHaveLength(5);
  });
});

describe("snooze one occurrence (rule 31)", () => {
  it("goes to the first legal start at or after the time, on the same day only", () => {
    const lunch = habit({ id: "lunch", notBefore: { [day(1)]: 780 } });
    const p = plan(
      snapshot({ habits: [lunch], events: [busy(at(day(1), "13:00"), at(day(1), "14:00"))] }),
    );
    expect(spans(p, "lunch").slice(0, 3)).toEqual([
      `${day(0)}T12:00/12:30`,
      `${day(1)}T14:00/14:30`,
      `${day(2)}T12:00/12:30`,
    ]);
  });

  it("no room after the time that day: unplaced, never earlier", () => {
    const lunch = habit({ id: "lunch", notBefore: { [day(1)]: 990 } });
    const p = plan(
      snapshot({ habits: [lunch], events: [busy(at(day(1), "16:30"), at(day(1), "17:00"))] }),
    );
    expect(spans(p, "lunch").filter((s) => s.startsWith(day(1)))).toEqual([]);
    expect(p.report.find((r) => r.demandKey === `habit:lunch:${day(1)}`)?.status).toBe("unplaced");
  });
});

const task = (over: Partial<TaskItem> & { id: string }): TaskItem => ({
  title: over.id,
  level: 2,
  remainingMinutes: 25 * 60,
  minChunkMinutes: 30,
  maxChunkMinutes: 120,
  startAfter: 0,
  dueAt: null,
  hours: "work",
  nextUpRank: null,
  createdAt: 0,
  exclusions: [],
  changed: false,
  ...over,
});
const days = (p: { placements: Placement[] }, id: string) => [
  ...new Set(spans(p, id).map((s) => s.slice(0, 10))),
];
const ALL = [day(0), day(1), day(2), day(3), day(4)];

describe("dependency cycles (rule 18)", () => {
  it("a before b and b before a: both habits are placed every day", () => {
    const a = habit({ id: "a", dependencies: [{ rule: "before", kind: "habit", id: "b" }] });
    const b = habit({ id: "b", dependencies: [{ rule: "before", kind: "habit", id: "a" }] });
    const p = plan(snapshot({ habits: [a, b] }));
    expect(days(p, "a")).toEqual(ALL);
    expect(days(p, "b")).toEqual(ALL);
  });

  it("a three-habit cycle places all three, and keeps the rules that close no cycle", () => {
    const a = habit({ id: "a", dependencies: [{ rule: "before", kind: "habit", id: "b" }] });
    const b = habit({ id: "b", dependencies: [{ rule: "before", kind: "habit", id: "c" }] });
    const c = habit({ id: "c", dependencies: [{ rule: "not-after", kind: "habit", id: "a" }] });
    const p = plan(snapshot({ habits: [a, b, c] }));
    for (const id of ["a", "b", "c"]) expect(days(p, id)).toEqual(ALL);
    // The kept rules: a before b, b before c.
    for (let i = 0; i < 5; i++) {
      const [pa, pb, pc] = ["a", "b", "c"].map(
        (id) =>
          p.placements.find((x) => x.itemId === id && hm(x.start).startsWith(day(i))) as Placement,
      ) as [Placement, Placement, Placement];
      expect(pa.end).toBeLessThanOrEqual(pb.start);
      expect(pb.end).toBeLessThanOrEqual(pc.start);
    }
  });
});

describe("dependencies keep the dependent's priority (rule 18, rule 43)", () => {
  it("a P1 habit not after a P3 habit loses no day to a P2 task", () => {
    const t = habit({ id: "t", level: 3, idealMinute: 660 });
    const d = habit({
      id: "d",
      level: 1,
      idealMinute: 600,
      dependencies: [{ rule: "not-after", kind: "habit", id: "t" }],
    });
    const p = plan(snapshot({ habits: [d, t], tasks: [task({ id: "big", level: 2 })] }));
    expect(days(p, "d")).toEqual(ALL);
    expect(days(p, "t")).toEqual(ALL);
  });

  it("without the rule the P3 habit loses days to the P2 task, and the P1 habit keeps all", () => {
    const t = habit({ id: "t", level: 3, idealMinute: 660 });
    const d = habit({ id: "d", level: 1, idealMinute: 600 });
    const p = plan(snapshot({ habits: [d, t], tasks: [task({ id: "big", level: 2 })] }));
    expect(days(p, "d")).toEqual(ALL);
    expect(days(p, "t").length).toBeLessThan(5);
  });

  it("a P1 habit before a P3 flexible meeting loses no day to a P2 task", () => {
    const prep = habit({
      id: "prep",
      level: 1,
      frequency: { period: "weekly", days: [2] },
      dependencies: [{ rule: "before", kind: "meeting", id: "sync" }],
    });
    const p = plan(
      snapshot({
        habits: [prep],
        meetings: [meeting({ id: "sync", level: 3 })],
        tasks: [task({ id: "big", level: 2 })],
      }),
    );
    expect(spans(p, "sync")).toHaveLength(1);
    expect(spans(p, "prep")).toHaveLength(1);
  });

  it("P1 habits in a cycle lose nothing to P4 tasks", () => {
    const a = habit({
      id: "a",
      level: 1,
      dependencies: [{ rule: "not-after", kind: "habit", id: "b" }],
    });
    const b = habit({
      id: "b",
      level: 1,
      dependencies: [{ rule: "not-after", kind: "habit", id: "a" }],
    });
    const p = plan(snapshot({ habits: [a, b], tasks: [task({ id: "big", level: 4 })] }));
    expect(days(p, "a")).toEqual(ALL);
    expect(days(p, "b")).toEqual(ALL);
  });
});

describe("snooze of an occurrence that has started (rule 31)", () => {
  const lunch = (notBefore?: number) =>
    habit({ id: "lunch", ...(notBefore ? { notBefore: { [day(0)]: notBefore } } : {}) });
  const current = [
    {
      key: `habit:lunch:${day(0)}`,
      itemId: "lunch",
      start: at(day(0), "12:00"),
      end: at(day(0), "12:30"),
      locked: false,
    },
  ];

  it("moves the started occurrence to the snooze time", () => {
    const p = plan(snapshot({ now: at(day(0), "12:05"), current, habits: [lunch(735)] }));
    expect(spans(p, "lunch")[0]).toBe(`${day(0)}T12:15/12:45`);
  });

  it("without a snooze the started occurrence stays", () => {
    const p = plan(snapshot({ now: at(day(0), "12:05"), current, habits: [lunch()] }));
    expect(spans(p, "lunch")[0]).toBe(`${day(0)}T12:00/12:30`);
  });

  it("a snooze time at or before the start keeps the started occurrence", () => {
    const p = plan(snapshot({ now: at(day(0), "12:05"), current, habits: [lunch(720)] }));
    expect(spans(p, "lunch")[0]).toBe(`${day(0)}T12:00/12:30`);
  });
});
