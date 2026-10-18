// Behavior of plan() (docs/specs/planning-scheduler.md and the item specs).
// Failure modes, each covered below:
//  1. A higher level loses a contested slot to a lower one.            (SCH-62, scenario 1)
//  2. An external event is overbooked, even after its level is lowered. (SCH-27, scenario 2)
//  3. Declined or unanswered invitations block; accepted ones do not.  (SCH-20/21)
//  3b. Free and tagged events are misread (#tl_busy, #tl_free).         (SCH-22..24)
//  4. Busy all-day events do not block their day.                       (SCH-25)
//  5. A locked or started event moves, or others overlap it.            (SCH-57, SCH-60a)
//  6. Unchanged input produces a different plan (churn).                (SCH-88, scenario 8)
//  7. A lower item that arrives later moves a higher item.              (scenario 9)
//  8. Chunks break their bounds, leave a stub, touch, or miss the total.(TSK-10..14)
//  9. once-per-day cooldown puts two chunks on one day.                 (TSK-14)
// 10. A chunk spans two hours ranges, or starts off the grid.           (HRS-2, SCH-49)
// 11. Wrong or missing reason codes.                                    (SCH-116)
// 12. Urgency does not lift a task that is about to miss its due date.  (SCH-79, scenario 14)
// 13. Next-up tasks are not placed after P1 automations and before others. (SCH-70, scenario 15)
// 14. A habit is not near its ideal time, does not shrink, moves day when daily,
//     ignores skips, reserved words, starting date or the unplaceable setting.
// 15. The break gap between task and habit events is not kept.          (buffers-breaks.md)
// 16. Buffers detach from their anchor, appear between back-to-back meetings,
//     or ignore their conflict setting and level.                       (buffers-automation.md)
// 17. Focus misses the weekly goal, breaks daily limits, ignores counted time,
//     or takes time before other items.                                 (focus-time.md, SCH-68)
// 18. Free/busy status is wrong for chunks, habits, focus and locked events. (DEF-*)
// 19. Input order changes the output (non-determinism).
import { describe, expect, it } from "vitest";
import type {
  BufferItem,
  ExternalEvent,
  FocusItem,
  HabitItem,
  Placement,
  Snapshot,
  TaskItem,
} from "../../src/scheduler/model.ts";
import { plan } from "../../src/scheduler/plan.ts";
import { addDays, localToUtc } from "../../src/shared/time.ts";

const ZONE = "Europe/Berlin";
const MON = "2026-11-09"; // week W, no DST change
const day = (offset: number) => addDays(MON, offset);
const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return localToUtc(ZONE, date, h * 60 + m);
};
const hm = (t: number) =>
  new Date(t).toLocaleString("sv-SE", { timeZone: ZONE }).slice(0, 16).replace(" ", "T");
const MIN = 60_000;

const WORK = {
  1: [[540, 1020]],
  2: [[540, 1020]],
  3: [[540, 1020]],
  4: [[540, 1020]],
  5: [[540, 1020]],
} as const;

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    now: at(day(-1), "12:00"),
    zone: ZONE,
    weekStart: 1,
    windowEnd: at(day(20), "00:00"),
    stepMinutes: 15,
    urgencyMode: "priority-only",
    chunkCooldown: "none",
    breakMinutes: 0,
    hours: {
      work: WORK,
      always: {
        1: [[0, 1440]],
        2: [[0, 1440]],
        3: [[0, 1440]],
        4: [[0, 1440]],
        5: [[0, 1440]],
        6: [[0, 1440]],
        7: [[0, 1440]],
      },
    },
    workHours: ["work"],
    events: [],
    current: [],
    tasks: [],
    habits: [],
    buffers: [],
    focus: [],
    ...over,
  };
}

let seq = 0;
const ext = (start: number, end: number, over: Partial<ExternalEvent> = {}): ExternalEvent => ({
  id: `ext-${++seq}`,
  start,
  end,
  allDay: false,
  busy: true,
  title: "Meeting",
  description: "",
  selfResponse: null,
  organizerSelf: true,
  attendeeCount: 0,
  location: "",
  eventType: "default",
  bookedViaLink: false,
  ...over,
});
const task = (over: Partial<TaskItem> & { id: string }): TaskItem => ({
  title: over.id,
  level: 2,
  remainingMinutes: 60,
  minChunkMinutes: 30,
  maxChunkMinutes: 120,
  startAfter: at(MON, "00:00"),
  dueAt: null,
  hours: "work",
  nextUpRank: null,
  createdAt: 0,
  exclusions: [],
  changed: false,
  ...over,
});
const habit = (over: Partial<HabitItem> & { id: string }): HabitItem => ({
  title: over.id,
  level: 3,
  rank: 0,
  createdAt: 0,
  hours: "work",
  idealMinute: 720,
  minMinutes: 60,
  maxMinutes: 60,
  frequency: { period: "daily" },
  starting: MON,
  defense: "adaptive",
  whenUnplaceable: "remove",
  reservedWords: [],
  skips: [],
  exclusions: [],
  changed: false,
  ...over,
});
const fill = (date: string, ...free: [string, string][]) => {
  // Busy external events over the whole work day except the given free ranges.
  const out: ExternalEvent[] = [];
  let cursor = at(date, "09:00");
  for (const [a, b] of free) {
    if (at(date, a) > cursor) out.push(ext(cursor, at(date, a)));
    cursor = at(date, b);
  }
  if (cursor < at(date, "17:00")) out.push(ext(cursor, at(date, "17:00")));
  return out;
};
const of = (p: { placements: Placement[] }, itemId: string) =>
  p.placements.filter((x) => x.itemId === itemId).sort((a, b) => a.start - b.start);
const spans = (ps: Placement[]) => ps.map((p) => `${hm(p.start)}/${hm(p.end).slice(11)}`);
describe("priorities and blocking", () => {
  it("gives a contested slot to the higher level and reports the loser (scenario 1)", () => {
    const tue = day(1);
    const result = plan(
      snapshot({
        events: [ext(at(tue, "09:00"), at(tue, "14:00")), ext(at(tue, "16:00"), at(tue, "17:00"))],
        habits: [
          habit({
            id: "walk",
            level: 3,
            hours: "walk",
            minMinutes: 60,
            maxMinutes: 60,
            idealMinute: 14 * 60,
            frequency: { period: "weekly", days: [2] },
            whenUnplaceable: "remove",
          }),
        ],
        hours: { ...snapshot().hours, walk: { 2: [[840, 900]] } },
        tasks: [
          task({
            id: "fix",
            level: 1,
            remainingMinutes: 120,
            minChunkMinutes: 120,
            maxChunkMinutes: 120,
            startAfter: at(tue, "00:00"),
            dueAt: at(tue, "16:00"),
          }),
        ],
      }),
    );
    expect(spans(of(result, "fix"))).toEqual([`${tue}T14:00/16:00`]);
    expect(of(result, "walk").filter((p) => p.start < at(day(2), "00:00"))).toEqual([]);
    expect(result.report).toContainEqual(
      expect.objectContaining({ itemId: "walk", status: "unplaced", reason: "no-space-priority" }),
    );
  });

  it("never overbooks external events and places late work after the due date (scenario 2)", () => {
    const result = plan(
      snapshot({
        events: [ext(at(MON, "09:00"), at(MON, "17:00"))],
        tasks: [task({ id: "t", level: 1, remainingMinutes: 60, dueAt: at(MON, "17:00") })],
      }),
    );
    const [chunk] = of(result, "t");
    expect(spans(of(result, "t"))).toEqual([`${day(1)}T09:00/10:00`]);
    expect(chunk?.busy).toBe(true);
    expect(chunk?.afterDue).toBe(true);
    expect(result.report).toContainEqual(
      expect.objectContaining({ itemId: "t", reason: "after-due" }),
    );
  });

  it("ignores declined and unanswered invitations but respects accepted ones", () => {
    const invite = (r: ExternalEvent["selfResponse"]) =>
      ext(at(MON, "09:00"), at(MON, "10:00"), {
        selfResponse: r,
        organizerSelf: false,
        attendeeCount: 2,
      });
    const first = (r: ExternalEvent["selfResponse"]) =>
      spans(of(plan(snapshot({ events: [invite(r)], tasks: [task({ id: "t" })] })), "t"));
    expect(first("needsAction")).toEqual([`${MON}T09:00/10:00`]);
    expect(first("declined")).toEqual([`${MON}T09:00/10:00`]);
    expect(first("accepted")).toEqual([`${MON}T10:00/11:00`]);
    expect(first("tentative")).toEqual([`${MON}T10:00/11:00`]);
  });

  it("reads free events and the #tl_busy and #tl_free tags (scenario 4)", () => {
    const result = plan(
      snapshot({
        events: [
          ext(at(MON, "09:00"), at(MON, "12:00"), { busy: false }),
          ext(at(MON, "12:00"), at(MON, "14:00"), { busy: false, title: "Hold #tl_busy" }),
          ext(at(MON, "14:00"), at(MON, "17:00"), { title: "No meetings #tl_free" }),
        ],
        tasks: [
          task({
            id: "t",
            remainingMinutes: 360,
            minChunkMinutes: 60,
            maxChunkMinutes: 120,
            dueAt: at(MON, "17:00"),
          }),
        ],
      }),
    );
    const monday = of(result, "t").filter((p) => p.end <= at(MON, "17:00"));
    expect(monday.length).toBeGreaterThan(0);
    for (const p of monday) {
      expect(p.start >= at(MON, "12:00") && p.start < at(MON, "14:00")).toBe(false);
      expect(p.end > at(MON, "12:00") && p.end <= at(MON, "14:00")).toBe(false);
    }
  });

  it("blocks the day of a busy all-day event but not of a free one (scenario 5)", () => {
    const result = plan(
      snapshot({
        events: [
          ext(at(MON, "00:00"), at(day(1), "00:00"), { allDay: true }),
          ext(at(day(1), "00:00"), at(day(2), "00:00"), { allDay: true, busy: false }),
        ],
        tasks: [task({ id: "t" })],
      }),
    );
    expect(spans(of(result, "t"))).toEqual([`${day(1)}T09:00/10:00`]);
  });

  it("keeps locked and started events and places around them (scenario 12)", () => {
    const now = at(MON, "09:30");
    const result = plan(
      snapshot({
        now,
        current: [
          {
            key: "task:small:0",
            itemId: "small",
            start: at(MON, "10:00"),
            end: at(MON, "11:00"),
            locked: true,
          },
          {
            key: "task:running:0",
            itemId: "running",
            start: at(MON, "09:00"),
            end: at(MON, "10:00"),
            locked: false,
          },
        ],
        tasks: [
          task({ id: "small", remainingMinutes: 60 }),
          task({ id: "running", remainingMinutes: 60, level: 4 }),
          task({
            id: "big",
            level: 1,
            remainingMinutes: 240,
            minChunkMinutes: 60,
            maxChunkMinutes: 240,
          }),
        ],
      }),
    );
    expect(spans(of(result, "small"))).toEqual([`${MON}T10:00/11:00`]);
    expect(of(result, "small")[0]?.locked).toBe(true);
    expect(of(result, "small")[0]?.busy).toBe(true);
    expect(spans(of(result, "running"))).toEqual([`${MON}T09:00/10:00`]);
    for (const p of of(result, "big")) {
      expect(p.start >= at(MON, "11:00") || p.end <= at(MON, "10:00")).toBe(true);
      expect(p.start).toBeGreaterThanOrEqual(at(MON, "09:30"));
    }
  });
});

describe("stability and determinism", () => {
  const base = () =>
    snapshot({
      events: [
        ext(at(MON, "11:00"), at(MON, "12:00")),
        ext(at(day(1), "09:00"), at(day(1), "13:00")),
      ],
      tasks: [
        task({
          id: "a",
          level: 1,
          remainingMinutes: 180,
          minChunkMinutes: 60,
          maxChunkMinutes: 120,
          dueAt: at(day(2), "17:00"),
        }),
        task({ id: "b", level: 2, remainingMinutes: 90, minChunkMinutes: 30, maxChunkMinutes: 60 }),
      ],
      habits: [
        habit({ id: "lunch", idealMinute: 720, minMinutes: 30, maxMinutes: 60, hours: "lunch" }),
      ],
      hours: {
        ...snapshot().hours,
        lunch: {
          1: [[690, 840]],
          2: [[690, 840]],
          3: [[690, 840]],
          4: [[690, 840]],
          5: [[690, 840]],
        },
      },
    });

  it("returns the same plan when its own output is fed back (no churn, scenario 8)", () => {
    const first = plan(base());
    const second = plan({
      ...base(),
      current: first.placements.map((p) => ({
        key: p.key,
        itemId: p.itemId,
        start: p.start,
        end: p.end,
        locked: false,
      })),
    });
    expect(second.placements).toEqual(first.placements);
  });

  it("does not move a higher item when a lower item arrives (scenario 9)", () => {
    const first = plan(
      snapshot({
        tasks: [
          task({ id: "a", remainingMinutes: 120, minChunkMinutes: 120, maxChunkMinutes: 120 }),
        ],
      }),
    );
    const current = first.placements.map((p) => ({
      key: p.key,
      itemId: p.itemId,
      start: p.start,
      end: p.end,
      locked: false,
    }));
    const second = plan(
      snapshot({
        current,
        tasks: [
          task({ id: "a", remainingMinutes: 120, minChunkMinutes: 120, maxChunkMinutes: 120 }),
        ],
        habits: [habit({ id: "h", level: 4, hours: "morning", idealMinute: 540 })],
        hours: { ...snapshot().hours, morning: { 1: [[540, 720]] } },
      }),
    );
    expect(of(second, "a")).toEqual(of(first, "a"));
    expect(spans(of(second, "h")).filter((s) => s.startsWith(MON))).toEqual([`${MON}T11:00/12:00`]);
  });

  it("gives the same plan for any input order", () => {
    const s = base();
    const shuffled = { ...s, tasks: [...s.tasks].reverse(), events: [...s.events].reverse() };
    expect(plan(shuffled)).toEqual(plan(s));
  });
});

describe("task chunks", () => {
  it("splits work within bounds, with gaps, no stub, and the full total (TSK-10..14)", () => {
    const result = plan(
      snapshot({
        events: [ext(at(MON, "12:00"), at(MON, "12:30"))],
        tasks: [
          task({ id: "t", remainingMinutes: 330, minChunkMinutes: 60, maxChunkMinutes: 120 }),
        ],
      }),
    );
    const chunks = of(result, "t");
    const lengths = chunks.map((c) => (c.end - c.start) / MIN);
    expect(lengths.reduce((a, b) => a + b, 0)).toBe(330);
    for (const l of lengths) expect(l >= 60 && l <= 120).toBe(true);
    for (let i = 1; i < chunks.length; i++) {
      expect((chunks[i]?.start ?? 0) - (chunks[i - 1]?.end ?? 0)).toBeGreaterThanOrEqual(15 * MIN);
    }
    for (const c of chunks) expect(c.start % (15 * MIN)).toBe(0);
  });

  it("places one chunk per day with the once-per-day cooldown", () => {
    const result = plan(
      snapshot({
        chunkCooldown: "once-per-day",
        tasks: [task({ id: "t", remainingMinutes: 180, minChunkMinutes: 60, maxChunkMinutes: 60 })],
      }),
    );
    expect(spans(of(result, "t"))).toEqual([
      `${MON}T09:00/10:00`,
      `${day(1)}T09:00/10:00`,
      `${day(2)}T09:00/10:00`,
    ]);
  });

  it("never spans two hours ranges (HRS-2)", () => {
    const result = plan(
      snapshot({
        hours: {
          split: {
            1: [
              [540, 600],
              [600, 660],
            ].map(([a, b]) => [a, b] as [number, number]),
          },
        },
        workHours: [],
        tasks: [
          task({
            id: "t",
            hours: "split",
            remainingMinutes: 120,
            minChunkMinutes: 120,
            maxChunkMinutes: 120,
          }),
        ],
      }),
    );
    // Touching ranges merge into one 09:00-11:00 range, so the chunk fits.
    expect(spans(of(result, "t"))).toEqual([`${MON}T09:00/11:00`]);
    const gapped = plan(
      snapshot({
        hours: {
          split: {
            1: [
              [540, 600],
              [615, 675],
            ],
          },
        },
        tasks: [
          task({
            id: "t",
            hours: "split",
            remainingMinutes: 120,
            minChunkMinutes: 120,
            maxChunkMinutes: 120,
          }),
        ],
      }),
    );
    expect(of(gapped, "t")).toEqual([]);
  });

  it("reports outside-window, too-long-for-hours, no-space-fixed and no-space-priority", () => {
    const outside = plan(
      snapshot({ tasks: [task({ id: "t", startAfter: at(day(30), "00:00") })] }),
    );
    expect(outside.report).toContainEqual(
      expect.objectContaining({ itemId: "t", reason: "outside-window" }),
    );

    const tooLong = plan(
      snapshot({
        tasks: [
          task({ id: "t", remainingMinutes: 600, minChunkMinutes: 600, maxChunkMinutes: 600 }),
        ],
      }),
    );
    expect(tooLong.report).toContainEqual(
      expect.objectContaining({ itemId: "t", reason: "too-long-for-hours" }),
    );

    const allBusy = [0, 1, 2, 3].flatMap((w) =>
      [0, 1, 2, 3, 4].flatMap((d) => fill(day(w * 7 + d))),
    );
    const fixed = plan(snapshot({ events: allBusy, tasks: [task({ id: "t" })] }));
    expect(fixed.report).toContainEqual(
      expect.objectContaining({ itemId: "t", reason: "no-space-fixed" }),
    );

    const oneSlot = [
      ...fill(MON, ["09:00", "10:00"]),
      ...[1, 2, 3, 4].flatMap((d) => fill(day(d))),
      ...[1, 2, 3].flatMap((w) => [0, 1, 2, 3, 4].flatMap((d) => fill(day(w * 7 + d)))),
    ];
    const prio = plan(
      snapshot({
        events: oneSlot,
        tasks: [task({ id: "hi", level: 1 }), task({ id: "lo", level: 3 })],
      }),
    );
    expect(spans(of(prio, "hi"))).toEqual([`${MON}T09:00/10:00`]);
    expect(prio.report).toContainEqual(
      expect.objectContaining({ itemId: "lo", reason: "no-space-priority" }),
    );
  });

  it("lifts a task that is about to miss its due date (scenario 14)", () => {
    const result = plan(
      snapshot({
        urgencyMode: "due-date-and-work",
        tasks: [
          task({
            id: "a",
            level: 2,
            remainingMinutes: 240,
            minChunkMinutes: 240,
            maxChunkMinutes: 240,
            dueAt: at(day(18), "17:00"),
          }),
          task({
            id: "b",
            level: 3,
            remainingMinutes: 360,
            minChunkMinutes: 60,
            maxChunkMinutes: 240,
            dueAt: at(MON, "17:00"),
          }),
        ],
      }),
    );
    const firstB = of(result, "b")[0];
    const firstA = of(result, "a")[0];
    expect(firstB && hm(firstB.start)).toBe(`${MON}T09:00`);
    expect((firstA?.start ?? 0) > (firstB?.start ?? 0)).toBe(true);
  });

  it("places next-up tasks after P1 automations and before other items (scenario 15)", () => {
    const result = plan(
      snapshot({
        hours: { ...snapshot().hours, lunch: { 1: [[720, 780]] }, walk: { 1: [[540, 600]] } },
        habits: [
          habit({
            id: "lunch",
            level: 1,
            hours: "lunch",
            idealMinute: 720,
            frequency: { period: "weekly", days: [1] },
          }),
          habit({
            id: "walk",
            level: 2,
            hours: "walk",
            idealMinute: 540,
            frequency: { period: "weekly", days: [1] },
          }),
        ],
        tasks: [
          task({
            id: "now",
            level: 4,
            nextUpRank: 0,
            remainingMinutes: 60,
            minChunkMinutes: 60,
            maxChunkMinutes: 60,
          }),
        ],
      }),
    );
    expect(spans(of(result, "lunch")).filter((s) => s.startsWith(MON))).toEqual([
      `${MON}T12:00/13:00`,
    ]);
    expect(spans(of(result, "now"))).toEqual([`${MON}T09:00/10:00`]);
    expect(spans(of(result, "walk")).filter((s) => s.startsWith(MON))).toEqual([]);
  });
});

describe("habits", () => {
  const lunchHours: Snapshot["hours"] = {
    ...snapshot().hours,
    lunch: { 1: [[690, 840]], 2: [[690, 840]], 3: [[690, 840]], 4: [[690, 840]], 5: [[690, 840]] },
  };
  const lunch = (over: Partial<HabitItem> = {}) =>
    habit({
      id: "lunch",
      hours: "lunch",
      idealMinute: 720,
      minMinutes: 30,
      maxMinutes: 60,
      ...over,
    });

  it("places each day at the ideal time and moves within the window when blocked", () => {
    const wed = day(2);
    const result = plan(
      snapshot({
        hours: lunchHours,
        habits: [lunch()],
        events: [ext(at(wed, "11:30"), at(wed, "13:00"))],
      }),
    );
    const week = spans(of(result, "lunch")).filter((s) => s < `${day(5)}`);
    expect(week).toEqual([
      `${MON}T12:00/13:00`,
      `${day(1)}T12:00/13:00`,
      `${wed}T13:00/14:00`,
      `${day(3)}T12:00/13:00`,
      `${day(4)}T12:00/13:00`,
    ]);
  });

  it("shrinks toward the minimum before it gives up the day", () => {
    const tue = day(1);
    const result = plan(
      snapshot({
        hours: lunchHours,
        habits: [lunch()],
        events: [ext(at(tue, "11:30"), at(tue, "13:30"))],
      }),
    );
    expect(spans(of(result, "lunch")).find((s) => s.startsWith(tue))).toBe(`${tue}T13:30/14:00`);
  });

  it("keeps or removes an occurrence with no room, by its setting", () => {
    const thu = day(3);
    const block = [ext(at(thu, "11:00"), at(thu, "14:30"))];
    const removed = plan(snapshot({ hours: lunchHours, habits: [lunch()], events: block }));
    expect(of(removed, "lunch").some((p) => hm(p.start).startsWith(thu))).toBe(false);
    expect(removed.report).toContainEqual(
      expect.objectContaining({
        itemId: "lunch",
        demandKey: `habit:lunch:${thu}`,
        status: "unplaced",
      }),
    );

    const kept = plan(
      snapshot({
        hours: lunchHours,
        habits: [lunch({ whenUnplaceable: "keep_as_conflict" })],
        events: block,
      }),
    );
    const conflict = of(kept, "lunch").find((p) => hm(p.start).startsWith(thu));
    expect(conflict).toMatchObject({ conflict: true });
    expect(kept.report).toContainEqual(
      expect.objectContaining({ demandKey: `habit:lunch:${thu}`, status: "conflict" }),
    );
  });

  it("moves a weekly occurrence to another day of the week but never a daily one", () => {
    const hours: Snapshot["hours"] = {
      ...snapshot().hours,
      am: { 1: [[540, 600]], 2: [[540, 600]], 3: [[540, 600]] },
    };
    const events = [ext(at(MON, "09:00"), at(MON, "10:00"))];
    const weekly = plan(
      snapshot({
        hours,
        events,
        habits: [
          habit({
            id: "h",
            hours: "am",
            idealMinute: 540,
            frequency: { period: "weekly", days: [1] },
          }),
        ],
      }),
    );
    expect(spans(of(weekly, "h")).filter((s) => s < day(7))).toEqual([`${day(1)}T09:00/10:00`]);
    const daily = plan(
      snapshot({ hours, events, habits: [habit({ id: "h", hours: "am", idealMinute: 540 })] }),
    );
    expect(spans(of(daily, "h")).filter((s) => s < day(7))).toEqual([
      `${day(1)}T09:00/10:00`,
      `${day(2)}T09:00/10:00`,
    ]);
  });

  it("honors skips, reserved words and the starting date", () => {
    const result = plan(
      snapshot({
        hours: lunchHours,
        events: [ext(at(day(2), "12:30"), at(day(2), "13:30"), { title: "Team Lunch" })],
        habits: [lunch({ skips: [MON], reservedWords: ["lunch"], starting: day(1) })],
      }),
    );
    const days = of(result, "lunch")
      .map((p) => hm(p.start).slice(0, 10))
      .filter((d) => d < day(5));
    expect(days).toEqual([day(1), day(3), day(4)]);
    expect(result.report).toContainEqual(
      expect.objectContaining({ demandKey: `habit:lunch:${day(2)}`, reason: "reserved-word" }),
    );
  });

  it("keeps the break gap between task and habit events", () => {
    const result = plan(
      snapshot({
        breakMinutes: 15,
        hours: { ...snapshot().hours, am: { 1: [[540, 720]] } },
        habits: [
          habit({
            id: "h",
            level: 1,
            hours: "am",
            idealMinute: 540,
            frequency: { period: "weekly", days: [1] },
          }),
        ],
        tasks: [task({ id: "t", remainingMinutes: 60, minChunkMinutes: 60, maxChunkMinutes: 60 })],
      }),
    );
    expect(spans(of(result, "h")).filter((s) => s.startsWith(MON))).toEqual([`${MON}T09:00/10:00`]);
    expect(spans(of(result, "t"))).toEqual([`${MON}T10:15/11:15`]);
  });
});

describe("buffers", () => {
  const recovery = (over: Partial<BufferItem> = {}): BufferItem => ({
    id: "rec",
    title: "Recovery",
    level: 1,
    rank: 0,
    createdAt: 0,
    side: "after",
    minutesBefore: 0,
    minutesAfter: 15,
    busy: true,
    filter: { participants: { op: ">=", value: 2 } },
    onConflict: "remove",
    changed: false,
    ...over,
  });
  const meeting = (a: string, b: string, d = MON) =>
    ext(at(d, a), at(d, b), { attendeeCount: 2, selfResponse: "accepted", organizerSelf: false });

  it("sits next to matching anchors, never between back-to-back meetings", () => {
    const result = plan(
      snapshot({
        buffers: [recovery()],
        events: [
          meeting("10:00", "11:00"),
          meeting("11:00", "12:00"),
          ext(at(MON, "14:00"), at(MON, "15:00")),
        ],
      }),
    );
    expect(spans(of(result, "rec"))).toEqual([`${MON}T12:00/12:15`]);
  });

  it("removes or keeps a buffer on conflict, by its setting", () => {
    const events = [meeting("10:00", "11:00"), ext(at(MON, "11:05"), at(MON, "11:30"))];
    expect(of(plan(snapshot({ buffers: [recovery()], events })), "rec")).toEqual([]);
    const kept = of(
      plan(snapshot({ buffers: [recovery({ onConflict: "keep_as_conflict" })], events })),
      "rec",
    );
    expect(kept).toEqual([
      expect.objectContaining({ start: at(MON, "11:00"), end: at(MON, "11:15"), conflict: true }),
    ]);
  });

  it("wins over a lower habit, which moves (buffer spec scenario 6)", () => {
    const result = plan(
      snapshot({
        buffers: [recovery()],
        events: [meeting("11:00", "12:00")],
        hours: { ...snapshot().hours, walk: { 1: [[720, 750]] } },
        habits: [
          habit({
            id: "walk",
            level: 3,
            hours: "walk",
            idealMinute: 720,
            minMinutes: 15,
            maxMinutes: 15,
            frequency: { period: "weekly", days: [1] },
          }),
        ],
      }),
    );
    expect(spans(of(result, "rec"))).toEqual([`${MON}T12:00/12:15`]);
    expect(spans(of(result, "walk")).filter((s) => s.startsWith(MON))).toEqual([
      `${MON}T12:15/12:30`,
    ]);
  });
});

describe("focus time", () => {
  const goal = (over: Partial<FocusItem> = {}): FocusItem => ({
    id: "focus",
    title: "Focus",
    rank: 0,
    createdAt: 0,
    hours: "work",
    weeklyGoalMinutes: 600,
    dailyMinMinutes: 120,
    dailyMaxMinutes: 240,
    minBlockMinutes: 60,
    maxBlockMinutes: 240,
    busy: true,
    exclusions: [],
    changed: false,
    ...over,
  });
  const weekOf = (ps: Placement[], weekMonday: string) =>
    ps.filter(
      (p) => p.start >= at(weekMonday, "00:00") && p.start < at(addDays(weekMonday, 7), "00:00"),
    );
  const minutesByDay = (ps: Placement[]) => {
    const out: Record<string, number> = {};
    for (const p of ps) {
      const d = hm(p.start).slice(0, 10);
      out[d] = (out[d] ?? 0) + (p.end - p.start) / MIN;
    }
    return out;
  };

  it("reaches the weekly goal within daily limits and block sizes (focus scenario 1)", () => {
    const week = weekOf(of(plan(snapshot({ focus: [goal()] })), "focus"), MON);
    const perDay = minutesByDay(week);
    expect(Object.values(perDay).reduce((a, b) => a + b, 0)).toBe(600);
    for (const m of Object.values(perDay)) expect(m >= 120 && m <= 240).toBe(true);
    for (const p of week) {
      const len = (p.end - p.start) / MIN;
      expect(len >= 60 && len <= 240).toBe(true);
      expect(p.busy).toBe(true);
    }
  });

  it("credits work habits and places focus after other items (focus scenario 2, SCH-68)", () => {
    const result = plan(
      snapshot({
        focus: [goal()],
        hours: { ...snapshot().hours, code: { 1: [[540, 660]], 2: [[540, 660]] } },
        habits: [
          habit({
            id: "code",
            level: 4,
            hours: "work",
            idealMinute: 540,
            minMinutes: 120,
            maxMinutes: 120,
            frequency: { period: "weekly", days: [1, 2] },
          }),
        ],
        tasks: [
          task({
            id: "late",
            level: 4,
            remainingMinutes: 120,
            minChunkMinutes: 120,
            maxChunkMinutes: 120,
            startAfter: at(day(2), "00:00"),
          }),
        ],
      }),
    );
    const perDay = minutesByDay(weekOf(of(result, "focus"), MON));
    expect(perDay[MON] ?? 0).toBe(0);
    expect(perDay[day(1)] ?? 0).toBe(0);
    expect(spans(of(result, "late"))).toEqual([`${day(2)}T09:00/11:00`]);
    // Counted: 2 h habit on Mon and Tue and the 2 h task on Wed; focus fills the rest.
    expect(Object.values(perDay).reduce((a, b) => a + b, 0) + 240 + 120).toBe(600);
  });
});

describe("free and busy status", () => {
  it("marks a chunk free while the task can still fit elsewhere before its due date", () => {
    const roomy = plan(snapshot({ tasks: [task({ id: "t", dueAt: at(day(4), "17:00") })] }));
    expect(of(roomy, "t")[0]?.busy).toBe(false);
    const tight = plan(
      snapshot({
        events: fill(MON, ["09:00", "10:00"]),
        tasks: [task({ id: "t", dueAt: at(MON, "17:00") })],
      }),
    );
    expect(of(tight, "t")[0]?.busy).toBe(true);
    const noDue = plan(snapshot({ tasks: [task({ id: "t" })] }));
    expect(of(noDue, "t")[0]?.busy).toBe(false);
  });

  it("marks an adaptive habit busy within 12 hours or when it is the last slot of its day", () => {
    const hours: Snapshot["hours"] = {
      ...snapshot().hours,
      lunch: {
        1: [[690, 840]],
        2: [[690, 840]],
        3: [[690, 840]],
        4: [[690, 840]],
        5: [[690, 840]],
      },
    };
    const result = plan(
      snapshot({
        now: at(MON, "06:00"),
        hours,
        events: [ext(at(day(2), "11:30"), at(day(2), "13:00"))],
        habits: [
          habit({ id: "lunch", hours: "lunch", idealMinute: 720, minMinutes: 60, maxMinutes: 60 }),
        ],
      }),
    );
    const byDay = new Map(of(result, "lunch").map((p) => [hm(p.start).slice(0, 10), p.busy]));
    expect(byDay.get(MON)).toBe(true);
    expect(byDay.get(day(1))).toBe(false);
    expect(byDay.get(day(2))).toBe(true);
    const free = plan(
      snapshot({ hours, habits: [habit({ id: "x", hours: "lunch", defense: "always-free" })] }),
    );
    expect(of(free, "x").every((p) => !p.busy)).toBe(true);
    const busy = plan(
      snapshot({ hours, habits: [habit({ id: "x", hours: "lunch", defense: "always-busy" })] }),
    );
    expect(of(busy, "x").every((p) => p.busy)).toBe(true);
  });
});
