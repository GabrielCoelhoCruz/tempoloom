// Invariants of plan() on random weeks. A failure prints the smallest
// counterexample found by fast-check.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { blocksPlanning } from "../../src/scheduler/blocking.ts";
import { hoursToTimeSet, type WeeklyHours } from "../../src/scheduler/hours.ts";
import type {
  CurrentPlacement,
  ExternalEvent,
  HabitDependency,
  HabitItem,
  MeetingItem,
  Placement,
  Snapshot,
  TaskItem,
} from "../../src/scheduler/model.ts";
import { plan } from "../../src/scheduler/plan.ts";
import { addDays, localToUtc } from "../../src/shared/time.ts";

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
  // With no answer: the user's own event, or an invitation sent only to a mailing list.
  listOnly: fc.boolean(),
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
  organizerSelf: e.response === null && !e.listOnly,
  attendeeCount: e.response === null && !e.listOnly ? 0 : 2,
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
  // Rule 18: targets h0 to h3, so a rule can name the habit itself, a habit
  // that is not in the plan, or close a cycle.
  deps: fc.array(
    fc.record({
      target: fc.integer({ min: 0, max: 3 }),
      rule: fc.constantFrom("before", "not-after", "not-same-day"),
    }),
    { maxLength: 2 },
  ),
  // Rule 31: a snooze of one occurrence, sometimes after the lunch hours.
  snooze: fc.option(
    fc.record({ day: fc.integer({ min: 0, max: 4 }), q: fc.integer({ min: 44, max: 57 }) }),
  ),
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
  dependencies: h.deps.map((d) => ({
    rule: d.rule as HabitDependency["rule"],
    kind: "habit",
    id: `h${d.target}`,
  })),
  ...(h.snooze ? { notBefore: { [addDays("2026-11-02", h.snooze.day)]: h.snooze.q * 15 } } : {}),
});

// Flexible meetings in the lunch hours: daily or weekly, with a previous
// occurrence for the cadence (rule 18), a boosted period (MEET-02 rule 16),
// a move budget (rules 9-11) and occurrences of an earlier plan.
const MON = "2026-11-02";
const meetingArb = fc.record({
  level: fc.constantFrom(1, 2, 3, 4),
  daily: fc.boolean(),
  idealDays: fc.subarray([1, 2, 3, 4, 5], { minLength: 1 }),
  idealQ: fc.integer({ min: 44, max: 55 }),
  durQ: fc.integer({ min: 1, max: 4 }),
  shortQ: fc.integer({ min: 0, max: 3 }),
  keep: fc.boolean(),
  prevDay: fc.option(fc.integer({ min: 1, max: 7 })),
  prevQ: fc.integer({ min: 36, max: 68 }),
  boostDay: fc.option(fc.integer({ min: 0, max: 6 })),
  boostLevel: fc.constantFrom(1, 2, 3),
  movesLeft: fc.option(fc.integer({ min: 0, max: 2 })),
  sticky: fc.array(
    fc.record({ day: fc.integer({ min: 0, max: 6 }), startQ: fc.integer({ min: 44, max: 54 }) }),
    { maxLength: 3 },
  ),
});
const periodOf = (m: ValueOf<typeof meetingArb>, day: number) =>
  m.daily ? addDays(MON, day) : MON;
const toMeetingCurrent = (m: ValueOf<typeof meetingArb>, i: number): CurrentPlacement[] => {
  const byKey = new Map<string, CurrentPlacement>();
  for (const c of m.sticky) {
    const key = `meeting:m${i}:${periodOf(m, c.day)}`;
    const start = t0 + c.day * 1440 * MIN + c.startQ * 15 * MIN;
    if (!byKey.has(key))
      byKey.set(key, {
        key,
        itemId: `m${i}`,
        start,
        end: start + m.durQ * 15 * MIN,
        locked: false,
      });
  }
  return [...byKey.values()];
};
const toMeeting = (m: ValueOf<typeof meetingArb>, i: number): MeetingItem => ({
  id: `m${i}`,
  title: `m${i}`,
  level: m.level as MeetingItem["level"],
  rank: i,
  createdAt: i,
  hours: "lunch",
  attendeeWindow: null,
  attendeeBusy: [],
  idealMinute: m.idealQ * 15,
  frequency: m.daily
    ? { period: "daily" }
    : { period: "weekly", everyWeeks: 1, idealDays: m.idealDays },
  durationMinutes: m.durQ * 15,
  shortestMinutes: Math.max(1, m.durQ - m.shortQ) * 15,
  starting: null,
  defense: "busy",
  whenUnplaceable: m.keep ? "keep_as_conflict" : "remove",
  leadMinutes: 0,
  exclusions: [],
  changed: false,
  ...(m.movesLeft === null ? {} : { movesLeft: m.movesLeft }),
  ...(m.prevDay === null
    ? {}
    : { previousStart: t0 - m.prevDay * 1440 * MIN + m.prevQ * 15 * MIN }),
  ...(m.boostDay === null || m.boostLevel >= m.level
    ? {}
    : {
        boost: {
          period: periodOf(m, m.boostDay),
          level: m.boostLevel as MeetingItem["level"],
        },
      }),
});

const inputArb = fc.record({
  events: fc.array(event, { maxLength: 30 }),
  tasks: fc.array(taskArb, { maxLength: 8 }),
  habits: fc.array(habitArb, { maxLength: 3 }),
  meetings: fc.array(meetingArb, { maxLength: 3 }),
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
    current: [...r.tasks.flatMap(toCurrent), ...r.meetings.flatMap(toMeetingCurrent)],
    tasks: r.tasks.map(toTask),
    habits: r.habits.map(toHabit),
    meetings: r.meetings.map(toMeeting),
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
const dayFormat = new Intl.DateTimeFormat("sv-SE", { timeZone: ZONE });
const localDate = (t: number) => dayFormat.format(t);
// TSK-14 for one task: each placed (not locked) chunk keeps the cooldown
// from every other chunk of the task and, with once-per-day, has its local
// day to itself. Linear after a sort: the nearest chunk before c is the
// largest end among chunks that start no later; the nearest after is the
// next start. Returns the chunks that break the rule.
const cooldownBreaks = (mine: Placement[], cooldown: Snapshot["chunkCooldown"]) => {
  const sorted = [...mine].sort((a, b) => a.start - b.start);
  const days = new Map<string, number>();
  const dayOf = sorted.map((c) => localDate(c.start));
  for (const d of dayOf) days.set(d, (days.get(d) ?? 0) + 1);
  const gap = GAP[cooldown] * MIN;
  const bad: Placement[] = [];
  let maxEnd = -Infinity;
  sorted.forEach((c, i) => {
    const next = sorted[i + 1];
    const tooClose = c.start - maxEnd < gap || (next !== undefined && next.start - c.end < gap);
    const sameDay = cooldown === "once-per-day" && (days.get(dayOf[i] as string) ?? 0) > 1;
    if (!c.locked && (tooClose || sameDay)) bad.push(c);
    maxEnd = Math.max(maxEnd, c.end);
  });
  return bad;
};
// PLAN_RUNS=3000 PLAN_SEED=<n> raise the run count and fix the seed. The
// overlap test spends most of its time in its pairwise expect() calls (about
// 1.3 ms per run; plan() takes about 0.2 ms), so long runs get a long timeout.
// The chunk-bounds test takes about 1.3 s at its 3000 default runs on a dev
// host (plan() is about 0.3 ms per run) and about 1.5x that on CI: the
// default timeout keeps a wide margin.
const runs = (n: number) => ({
  numRuns: Number(process.env.PLAN_RUNS) || n,
  ...(process.env.PLAN_SEED ? { seed: Number(process.env.PLAN_SEED) } : {}),
});

describe("plan() invariants", { timeout: process.env.PLAN_RUNS ? 300_000 : 15_000 }, () => {
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
            // Breaks pad task and habit neighbours only (SCH-89).
            const padded = (p: Placement) => p.kind === "task" || p.kind === "habit";
            if (s.breakMinutes > 0 && a.itemId !== b.itemId && padded(a) && padded(b)) {
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
          expect(cooldownBreaks(mine, s.chunkCooldown)).toEqual([]);
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

  it("places each meeting period once and keeps each meeting's move budget", () => {
    fc.assert(
      fc.property(snapshotArb, (s) => {
        const { placements } = plan(s);
        const current = new Map(s.current.map((c) => [c.key, c]));
        for (const m of s.meetings) {
          const mine = placements.filter((p) => p.itemId === m.id);
          expect(new Set(mine.map((p) => p.key)).size).toBe(mine.length);
          const moved = live(mine).filter((p) => {
            const c = current.get(p.key);
            return c && (c.start !== p.start || c.end !== p.end);
          });
          expect(moved.length).toBeLessThanOrEqual(m.movesLeft ?? Number.POSITIVE_INFINITY);
        }
      }),
      runs(1000),
    );
  });

  it("keeps the dependency rules of an acyclic set and every snooze (rules 18, 31)", () => {
    fc.assert(
      fc.property(snapshotArb, (s) => {
        const { placements } = plan(s);
        const ids = new Set(s.habits.map((h) => h.id));
        const rules = s.habits.flatMap((h) =>
          (h.dependencies ?? [])
            .filter((d) => ids.has(d.id) && d.id !== h.id)
            .map((d) => ({ from: h.id, ...d })),
        );
        // A cycle drops one of its rules (the scheduler's choice), so the
        // rules are checked only when they form no cycle.
        const leadsTo = (from: string, to: string, seen = new Set<string>()): boolean => {
          if (from === to) return true;
          if (seen.has(from)) return false;
          seen.add(from);
          return rules.some((r) => r.from === from && leadsTo(r.id, to, seen));
        };
        if (!rules.some((r) => leadsTo(r.id, r.from))) {
          for (const r of rules) {
            for (const p of placements.filter((x) => x.itemId === r.from)) {
              const day = localDate(p.start);
              const target = placements
                .filter((x) => x.itemId === r.id && localDate(x.start) === day)
                .map((x) => x.start);
              const first = Math.min(...target);
              if (r.rule === "not-same-day") expect(target).toEqual([]);
              else if (r.rule === "before") expect(p.end).toBeLessThanOrEqual(first);
              else if (target.length > 0) expect(p.end).toBeLessThanOrEqual(first);
            }
          }
        }
        for (const h of s.habits) {
          for (const [date, minute] of Object.entries(h.notBefore ?? {})) {
            const p = placements.find((x) => x.key === `habit:${h.id}:${date}`);
            if (p) expect(p.start).toBeGreaterThanOrEqual(localToUtc(ZONE, date, minute ?? 0));
          }
        }
      }),
      runs(1000),
    );
  });

  it("is idempotent and independent of input order", () => {
    fc.assert(
      fc.property(snapshotArb, (s) => {
        const first = plan(s);
        // The server counts the moves of the first run against the budget (recentMoves).
        const before = new Map(s.current.map((c) => [c.key, c]));
        const movedBy = (id: string) =>
          live(first.placements).filter((p) => {
            const c = p.itemId === id && before.get(p.key);
            return c && (c.start !== p.start || c.end !== p.end);
          }).length;
        const again = plan({
          ...s,
          meetings: s.meetings.map((m) =>
            m.movesLeft === undefined ? m : { ...m, movesLeft: m.movesLeft - movedBy(m.id) },
          ),
          // A meeting kept in conflict stays on the calendar (MEET-02 rules 11, 13).
          current: first.placements
            .filter((p) => !p.conflict || p.kind === "meeting")
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
          meetings: [...s.meetings].reverse(),
        });
        expect(shuffled).toEqual(first);
      }),
      runs(100),
    );
  });
});
