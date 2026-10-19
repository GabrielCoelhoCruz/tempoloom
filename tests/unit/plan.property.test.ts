// Invariants of plan() on random weeks. A failure prints the smallest
// counterexample found by fast-check.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { blocksPlanning } from "../../src/scheduler/blocking.ts";
import { hoursToTimeSet, type WeeklyHours } from "../../src/scheduler/hours.ts";
import type {
  CurrentPlacement,
  ExternalEvent,
  HabitItem,
  Placement,
  Snapshot,
  TaskItem,
} from "../../src/scheduler/model.ts";
import { plan } from "../../src/scheduler/plan.ts";
import { localToUtc } from "../../src/shared/time.ts";

const ZONE = "America/New_York";
const MIN = 60_000;
const t0 = localToUtc(ZONE, "2026-11-02", 0); // Monday after the DST change
const now = t0 - 12 * 60 * MIN;
const end = t0 + 7 * 24 * 60 * MIN;
const work = {
  1: [[540, 1020]],
  2: [[540, 1020]],
  3: [[540, 1020]],
  4: [[540, 1020]],
  5: [[540, 1020]],
} as const;
const lunch = {
  1: [[660, 840]],
  2: [[660, 840]],
  3: [[660, 840]],
  4: [[660, 840]],
  5: [[660, 840]],
} as const;
// Task hours that cross midnight (night) or have no gaps (always): a chunk
// can end at 24:00 and the next day starts at once (TSK-14).
const everyDay = (ranges: [number, number][]) =>
  Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [d, ranges])) as WeeklyHours;
const night = everyDay([
  [0, 240],
  [1200, 1440],
]);
const always = everyDay([[0, 1440]]);
const TASK_HOURS = { day: work, night, always } as const;

const event = fc.record({
  day: fc.integer({ min: 0, max: 6 }),
  startQ: fc.integer({ min: 28, max: 76 }),
  lenQ: fc.integer({ min: 1, max: 12 }),
  busy: fc.boolean(),
  response: fc.constantFrom(null, "accepted", "declined", "needsAction", "tentative"),
  tag: fc.constantFrom("", " #tl_free", " #tl_busy"),
});
const toEvent = (e: ValueOf<typeof event>, i: number): ExternalEvent => ({
  id: `e${i}-${e.day}-${e.startQ}`,
  start: t0 + e.day * 1440 * MIN + e.startQ * 15 * MIN,
  end: t0 + e.day * 1440 * MIN + (e.startQ + e.lenQ) * 15 * MIN,
  allDay: false,
  busy: e.busy,
  title: `Event${e.tag}`,
  description: "",
  selfResponse: e.response as ExternalEvent["selfResponse"],
  organizerSelf: e.response === null,
  attendeeCount: e.response === null ? 0 : 2,
  location: "",
  eventType: "default",
  bookedViaLink: false,
});

const taskArb = fc.record({
  level: fc.constantFrom(1, 2, 3, 4),
  remainingQ: fc.integer({ min: 1, max: 24 }),
  minQ: fc.integer({ min: 1, max: 4 }),
  extraQ: fc.integer({ min: 0, max: 8 }),
  dueDay: fc.option(fc.integer({ min: 0, max: 6 })),
  nextUp: fc.boolean(),
  startQ: fc.integer({ min: 0, max: 191 }),
  // Chunks of an earlier plan (SCH-88). Some are not valid for the task.
  // Some are locked (SCH-57): the plan keeps them as they are.
  sticky: fc.array(
    fc.record({
      day: fc.integer({ min: 0, max: 4 }),
      startQ: fc.integer({ min: 36, max: 64 }),
      lenQ: fc.integer({ min: 1, max: 8 }),
      locked: fc.constantFrom(false, false, false, true),
    }),
    { maxLength: 3 },
  ),
});
const toCurrent = (t: ValueOf<typeof taskArb>, i: number): CurrentPlacement[] =>
  t.sticky.map((c, n) => ({
    key: `task:t${i}:${n}`,
    itemId: `t${i}`,
    start: t0 + c.day * 1440 * MIN + c.startQ * 15 * MIN,
    end: t0 + c.day * 1440 * MIN + (c.startQ + c.lenQ) * 15 * MIN,
    locked: c.locked,
  }));
const toTask = (t: ValueOf<typeof taskArb>, i: number): TaskItem => ({
  id: `t${i}`,
  title: `t${i}`,
  level: t.level as TaskItem["level"],
  remainingMinutes: t.remainingQ * 15,
  minChunkMinutes: t.minQ * 15,
  maxChunkMinutes: (t.minQ + t.extraQ) * 15,
  startAfter: t0 + t.startQ * 15 * MIN,
  dueAt: t.dueDay === null ? null : t0 + t.dueDay * 1440 * MIN + 17 * 60 * MIN,
  hours: "work",
  nextUpRank: t.nextUp ? i : null,
  createdAt: i,
  exclusions: [],
  changed: false,
});

const habitArb = fc.record({
  level: fc.constantFrom(1, 2, 3, 4),
  idealQ: fc.integer({ min: 44, max: 55 }),
  minQ: fc.integer({ min: 1, max: 4 }),
  extraQ: fc.integer({ min: 0, max: 4 }),
  defense: fc.constantFrom("adaptive", "always-free", "always-busy"),
  keep: fc.boolean(),
});
const toHabit = (h: ValueOf<typeof habitArb>, i: number): HabitItem => ({
  id: `h${i}`,
  title: `h${i}`,
  level: h.level as HabitItem["level"],
  rank: i,
  createdAt: i,
  hours: "lunch",
  idealMinute: h.idealQ * 15,
  minMinutes: h.minQ * 15,
  maxMinutes: (h.minQ + h.extraQ) * 15,
  frequency: { period: "daily" },
  starting: null,
  defense: h.defense as HabitItem["defense"],
  whenUnplaceable: h.keep ? "keep_as_conflict" : "remove",
  reservedWords: [],
  skips: [],
  exclusions: [],
  changed: false,
});

const inputArb = fc.record({
  events: fc.array(event, { maxLength: 30 }),
  tasks: fc.array(taskArb, { maxLength: 8 }),
  habits: fc.array(habitArb, { maxLength: 3 }),
  breakMinutes: fc.constantFrom(0, 15),
  taskHours: fc.constantFrom<(keyof typeof TASK_HOURS)[]>("day", "day", "night", "always"),
  chunkCooldown: fc.constantFrom<Snapshot["chunkCooldown"][]>(
    "none",
    "once-per-day",
    "30m",
    "1h",
    "2h",
    "4h",
  ),
});
const snapshotArb = inputArb.map(
  (r): Snapshot => ({
    now,
    zone: ZONE,
    weekStart: 1,
    windowEnd: end,
    stepMinutes: 15,
    urgencyMode: "due-date-and-work",
    chunkCooldown: r.chunkCooldown,
    breakMinutes: r.breakMinutes,
    hours: { work: TASK_HOURS[r.taskHours], lunch },
    workHours: ["work"],
    events: r.events.map(toEvent),
    current: r.tasks.flatMap(toCurrent),
    tasks: r.tasks.map(toTask),
    habits: r.habits.map(toHabit),
    meetings: [],
    buffers: [],
    focus: [],
  }),
);

type ValueOf<A> = A extends fc.Arbitrary<infer T> ? T : never;
const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  a.start < b.end && b.start < a.end;
const live = (ps: Placement[]) => ps.filter((p) => !p.conflict);
// Locked chunks come from the input as they are: they can overlap events,
// each other, or break the chunk bounds. The checks below apply to the
// chunks the plan places and to their relation with locked ones.
const GAP: Record<Snapshot["chunkCooldown"], number> = {
  none: 15,
  "once-per-day": 15,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
};
const localDate = (t: number) => new Date(t).toLocaleDateString("sv-SE", { timeZone: ZONE });
// PLAN_RUNS=3000 PLAN_SEED=<n> raise the run count and fix the seed. The
// overlap test spends most of its time in its pairwise expect() calls (about
// 1.3 ms per run; plan() takes about 0.2 ms), so long runs get a long timeout.
const runs = (n: number) => ({
  numRuns: Number(process.env.PLAN_RUNS) || n,
  ...(process.env.PLAN_SEED ? { seed: Number(process.env.PLAN_SEED) } : {}),
});

describe("plan() invariants", { timeout: process.env.PLAN_RUNS ? 300_000 : 5_000 }, () => {
  it("never overlaps blocking events or other placements, and keeps each item in its hours", () => {
    fc.assert(
      fc.property(snapshotArb, (s) => {
        const { placements } = plan(s);
        const blocking = s.events.filter(blocksPlanning);
        const workSet = hoursToTimeSet(s.hours.work ?? {}, ZONE, now, end);
        const lunchSet = hoursToTimeSet(lunch, ZONE, now, end);
        const ps = live(placements);
        for (const p of ps) {
          if (p.locked) continue;
          expect(p.end).toBeLessThanOrEqual(end);
          expect(p.start % (15 * MIN)).toBe(0);
          for (const b of blocking) expect(overlaps(p, b)).toBe(false);
          expect((p.kind === "task" ? workSet : lunchSet).contains(p)).toBe(true);
        }
        for (let i = 0; i < ps.length; i++) {
          for (let j = i + 1; j < ps.length; j++) {
            const a = ps[i] as Placement;
            const b = ps[j] as Placement;
            if (a.locked && b.locked) continue;
            expect(overlaps(a, b)).toBe(false);
            if (s.breakMinutes > 0 && a.itemId !== b.itemId) {
              const gap = Math.max(b.start - a.end, a.start - b.end);
              expect(gap).toBeGreaterThanOrEqual(s.breakMinutes * MIN);
            }
          }
        }
      }),
      runs(150),
    );
  });

  it("respects chunk bounds and never places more than the remaining work", () => {
    fc.assert(
      fc.property(snapshotArb, (s) => {
        const { placements } = plan(s);
        for (const t of s.tasks) {
          const mine = placements.filter((p) => p.itemId === t.id);
          const sum = (cs: Placement[]) => cs.reduce((a, c) => a + (c.end - c.start) / MIN, 0);
          const lockedTotal = sum(mine.filter((c) => c.locked));
          const chunks = mine.filter((c) => !c.locked);
          const total = sum(chunks);
          expect(total + lockedTotal).toBeLessThanOrEqual(
            Math.max(t.remainingMinutes, lockedTotal),
          );
          // TSK-14: chunks of one task keep the cooldown from each other and
          // from locked chunks; once-per-day keeps them on different days.
          for (const c of chunks) {
            for (const o of mine) {
              if (o === c) continue;
              const gap = Math.max(o.start - c.end, c.start - o.end);
              expect(gap).toBeGreaterThanOrEqual(GAP[s.chunkCooldown] * MIN);
              if (s.chunkCooldown === "once-per-day") {
                expect(localDate(o.start)).not.toBe(localDate(c.start));
              }
            }
          }
          // TSK-13 applied to the rest: a chunk shorter than the minimum is
          // allowed only when no split of the remaining work R (the work not
          // in locked chunks) fits the bounds (ceil(R / max) * min > R). Then
          // there is at most one, and the chunks add up to R (TSK-12).
          const r = Math.max(0, t.remainingMinutes - lockedTotal);
          const noSplit = Math.ceil(r / t.maxChunkMinutes) * t.minChunkMinutes > r;
          const short = chunks.filter((c) => (c.end - c.start) / MIN < t.minChunkMinutes);
          expect(short.length).toBeLessThanOrEqual(noSplit ? 1 : 0);
          if (short.length > 0) expect(total).toBe(r);
          for (const c of chunks) {
            const l = (c.end - c.start) / MIN;
            expect(l).toBeLessThanOrEqual(t.maxChunkMinutes);
          }
        }
      }),
      runs(3000),
    );
  });

  it("is idempotent and independent of input order", () => {
    fc.assert(
      fc.property(snapshotArb, (s) => {
        const first = plan(s);
        const again = plan({
          ...s,
          current: first.placements
            .filter((p) => !p.conflict)
            .map((p) => ({
              key: p.key,
              itemId: p.itemId,
              start: p.start,
              end: p.end,
              locked: p.locked,
            })),
        });
        expect(live(again.placements)).toEqual(live(first.placements));
        const shuffled = plan({
          ...s,
          events: [...s.events].reverse(),
          tasks: [...s.tasks].reverse(),
          habits: [...s.habits].reverse(),
        });
        expect(shuffled).toEqual(first);
      }),
      runs(100),
    );
  });
});
