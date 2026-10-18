// Invariants of plan() on random weeks. A failure prints the smallest
// counterexample found by fast-check.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { blocksPlanning } from "../../src/scheduler/blocking.ts";
import { hoursToTimeSet } from "../../src/scheduler/hours.ts";
import type {
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
});
const toTask = (t: ValueOf<typeof taskArb>, i: number): TaskItem => ({
  id: `t${i}`,
  title: `t${i}`,
  level: t.level as TaskItem["level"],
  remainingMinutes: t.remainingQ * 15,
  minChunkMinutes: t.minQ * 15,
  maxChunkMinutes: (t.minQ + t.extraQ) * 15,
  startAfter: t0,
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

const snapshotArb = fc
  .record({
    events: fc.array(event, { maxLength: 30 }),
    tasks: fc.array(taskArb, { maxLength: 8 }),
    habits: fc.array(habitArb, { maxLength: 3 }),
    breakMinutes: fc.constantFrom(0, 15),
  })
  .map(
    (r): Snapshot => ({
      now,
      zone: ZONE,
      weekStart: 1,
      windowEnd: end,
      stepMinutes: 15,
      urgencyMode: "due-date-and-work",
      chunkCooldown: "none",
      breakMinutes: r.breakMinutes,
      hours: { work, lunch },
      workHours: ["work"],
      events: r.events.map(toEvent),
      current: [],
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

describe("plan() invariants", () => {
  it("never overlaps blocking events or other placements, and keeps each item in its hours", () => {
    fc.assert(
      fc.property(snapshotArb, (s) => {
        const { placements } = plan(s);
        const blocking = s.events.filter(blocksPlanning);
        const workSet = hoursToTimeSet(work, ZONE, now, end);
        const lunchSet = hoursToTimeSet(lunch, ZONE, now, end);
        const ps = live(placements);
        for (const p of ps) {
          expect(p.end).toBeLessThanOrEqual(end);
          expect(p.start % (15 * MIN)).toBe(0);
          for (const b of blocking) expect(overlaps(p, b)).toBe(false);
          expect((p.kind === "task" ? workSet : lunchSet).contains(p)).toBe(true);
        }
        for (let i = 0; i < ps.length; i++) {
          for (let j = i + 1; j < ps.length; j++) {
            const a = ps[i] as Placement;
            const b = ps[j] as Placement;
            expect(overlaps(a, b)).toBe(false);
            if (s.breakMinutes > 0 && a.itemId !== b.itemId) {
              const gap = Math.max(b.start - a.end, a.start - b.end);
              expect(gap).toBeGreaterThanOrEqual(s.breakMinutes * MIN);
            }
          }
        }
      }),
      { numRuns: 150 },
    );
  });

  it("respects chunk bounds and never places more than the remaining work", () => {
    fc.assert(
      fc.property(snapshotArb, (s) => {
        const { placements } = plan(s);
        for (const t of s.tasks) {
          const chunks = placements.filter((p) => p.itemId === t.id);
          const total = chunks.reduce((a, c) => a + (c.end - c.start) / MIN, 0);
          expect(total).toBeLessThanOrEqual(t.remainingMinutes);
          for (const c of chunks) {
            const l = (c.end - c.start) / MIN;
            const stub = l < t.minChunkMinutes && l === t.remainingMinutes;
            expect(stub || (l >= t.minChunkMinutes && l <= t.maxChunkMinutes)).toBe(true);
          }
        }
      }),
      { numRuns: 150 },
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
              locked: false,
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
      { numRuns: 100 },
    );
  });
});
