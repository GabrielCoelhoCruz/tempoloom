// Scheduler edge cases of monthly habits, rescheduled occurrences, reactive
// focus, the meeting overload automation and buffer filters
// (docs/specs/habits-automation.md, focus-time.md, buffers-automation.md,
// buffers-travel.md). The E2E tests cover the user journeys; these cover the
// date and counting rules that a week of E2E data cannot reach.
// Failure modes, each covered below:
//  1. A monthly day past the month's end is skipped instead of using the last day.
//  2. "last" weekday or the 5th weekday picks the wrong date.
//  3. A blocked monthly occurrence moves more than 6 days, or into the next month.
//  4. A rescheduled occurrence goes to another day or ignores the busy time.
//  5. Reactive focus places focus while free time exceeds the missing goal, or not
//     when it equals it.
//  6. Meeting overload counts unanswered, declined, guest-less or managed time, or
//     misses tentative, organized, booked and flexible meetings.
//  7. Overlapping meetings are counted twice.
//  8. The weekly limit protects days before the day it is reached.
//  9. The heavy-day rule looks at a weekend day instead of the previous workday.
// 10. A run of meetings with a gap is treated as one run.
// 11. The people filter misses a domain or matches a part of an address.
// 12. A buffer scoped to one calendar uses anchors of another calendar.
// 13. A mirrored copy whose source is already an anchor gets a second buffer.
// 14. A later start date (a snooze) moves the cadence of a custom frequency.
// 15. Interval 1 is stored as a second form of the plain frequency, or a new
//     interval does not get an anchor, or an edit moves the anchor.
import { describe, expect, it } from "vitest";
import type {
  BufferItem,
  ExternalEvent,
  FocusItem,
  HabitItem,
  OverloadItem,
  Placement,
  Snapshot,
} from "../../src/scheduler/model.ts";
import { plan } from "../../src/scheduler/plan.ts";
import { withAnchor } from "../../src/server/api/habits.ts";
import { addDays, localToUtc } from "../../src/shared/time.ts";

const ZONE = "Europe/Berlin";
const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return localToUtc(ZONE, date, h * 60 + m);
};
const hm = (t: number) =>
  new Date(t).toLocaleString("sv-SE", { timeZone: ZONE }).slice(0, 16).replace(" ", "T");
const spans = (ps: Placement[]) => ps.map((p) => `${hm(p.start)}/${hm(p.end).slice(11)}`);
const of = (r: ReturnType<typeof plan>, id: string) => r.placements.filter((p) => p.itemId === id);

const WORK = {
  1: [[540, 1020]],
  2: [[540, 1020]],
  3: [[540, 1020]],
  4: [[540, 1020]],
  5: [[540, 1020]],
} as const;

function snapshot(now: string, over: Partial<Snapshot> = {}, weeks = 3): Snapshot {
  const date = now.slice(0, 10);
  return {
    now: at(date, now.slice(11)),
    zone: ZONE,
    weekStart: 1,
    windowEnd: at(addDays(date, weeks * 7), "00:00"),
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
const ext = (start: number, end: number, over: Partial<ExternalEvent> = {}): ExternalEvent => ({
  id: `ext-${++seq}`,
  start,
  end,
  allDay: false,
  busy: true,
  title: "Event",
  description: "",
  selfResponse: null,
  organizerSelf: true,
  attendeeCount: 0,
  location: "",
  eventType: "default",
  bookedViaLink: false,
  ...over,
});

const habit = (over: Partial<HabitItem> & { id: string }): HabitItem => ({
  title: over.id,
  level: 3,
  rank: 0,
  createdAt: 0,
  hours: "work",
  idealMinute: 600,
  minMinutes: 60,
  maxMinutes: 60,
  frequency: { period: "daily" },
  starting: null,
  defense: "always-busy",
  whenUnplaceable: "remove",
  reservedWords: [],
  skips: [],
  exclusions: [],
  changed: false,
  ...over,
});

describe("monthly habits", () => {
  it("uses the last day of a short month for day 31, and the last or 5th weekday", () => {
    // November 2026 has 30 days; its last Monday is the 30th, and it has no 5th Friday.
    const s = snapshot(
      "2026-11-02T08:00",
      {
        habits: [
          habit({ id: "d31", frequency: { period: "monthly", dayOfMonth: 31 } }),
          habit({
            id: "lastMon",
            idealMinute: 900,
            frequency: { period: "monthly", nth: "last", weekday: 1 },
          }),
          habit({ id: "fifthFri", frequency: { period: "monthly", nth: 5, weekday: 5 } }),
          habit({ id: "secondTue", frequency: { period: "monthly", nth: 2, weekday: 2 } }),
        ],
      },
      5,
    );
    const r = plan(s);
    expect(spans(of(r, "d31"))).toEqual(["2026-11-30T10:00/11:00"]);
    expect(spans(of(r, "lastMon"))).toEqual(["2026-11-30T15:00/16:00"]);
    expect(spans(of(r, "fifthFri"))).toEqual([]);
    expect(spans(of(r, "secondTue"))).toEqual(["2026-11-10T10:00/11:00"]);
  });

  it("moves a blocked occurrence up to 6 days later in the same month, never into the next", () => {
    const busyDays = (from: string, n: number) =>
      Array.from({ length: n }, (_, i) =>
        ext(at(addDays(from, i), "09:00"), at(addDays(from, i), "17:00")),
      );
    const r = plan(
      snapshot(
        "2026-11-02T08:00",
        {
          habits: [
            habit({ id: "mid", frequency: { period: "monthly", dayOfMonth: 10 } }),
            habit({ id: "end", frequency: { period: "monthly", dayOfMonth: 27 } }),
          ],
          // The 10th to the 12th are full; the 27th (a Friday) is full and the month ends on Monday the 30th.
          events: [...busyDays("2026-11-10", 3), ...busyDays("2026-11-27", 1)],
        },
        5,
      ),
    );
    expect(spans(of(r, "mid"))).toEqual(["2026-11-13T10:00/11:00"]);
    expect(spans(of(r, "end"))).toEqual(["2026-11-30T10:00/11:00"]);
    const late = plan(
      snapshot(
        "2026-11-02T08:00",
        {
          habits: [habit({ id: "end", frequency: { period: "monthly", dayOfMonth: 27 } })],
          events: [...busyDays("2026-11-27", 4)],
        },
        5,
      ),
    );
    expect(spans(of(late, "end"))).toEqual([]);
  });
});

describe("custom frequency", () => {
  const dates = (ps: Placement[]) => spans(ps).map((x) => x.slice(0, 10));
  it("counts every N weeks, days or months from the anchor, not from the start date", () => {
    const s = snapshot(
      "2026-11-02T08:00",
      {
        habits: [
          // Anchored on Monday 2 November; snoozed to the next week.
          habit({
            id: "weeks",
            frequency: { period: "weekly", days: [2], interval: 2, anchor: "2026-11-02" },
            starting: "2026-11-09",
          }),
          habit({
            id: "days",
            frequency: { period: "daily", interval: 3, anchor: "2026-11-02" },
            starting: "2026-11-04",
          }),
          habit({
            id: "months",
            frequency: { period: "monthly", dayOfMonth: 3, interval: 2, anchor: "2026-10-03" },
            starting: "2026-11-01",
          }),
        ],
      },
      9,
    );
    const r = plan(s);
    expect(dates(of(r, "weeks"))).toEqual(["2026-11-17", "2026-12-01", "2026-12-15", "2026-12-29"]);
    expect(dates(of(r, "days")).slice(0, 4)).toEqual([
      "2026-11-05",
      "2026-11-11",
      "2026-11-17",
      "2026-11-20",
    ]);
    // October is the anchor month: December is on the cadence, November is not.
    expect(dates(of(r, "months"))).toEqual(["2026-12-03"]);
  });

  it("drops interval 1, anchors a new interval once, and keeps that anchor", () => {
    const weekly = { period: "weekly" as const, days: [2] };
    expect(withAnchor({ ...weekly, interval: 1 }, null, null, "2026-11-02")).toEqual(weekly);
    expect(withAnchor({ ...weekly, interval: 2 }, null, null, "2026-11-02")).toEqual({
      ...weekly,
      interval: 2,
      anchor: "2026-11-02",
    });
    expect(withAnchor({ ...weekly, interval: 2 }, null, "2026-11-09", "2026-11-02").anchor).toBe(
      "2026-11-09",
    );
    const stored = { ...weekly, interval: 2, anchor: "2026-11-02" };
    expect(withAnchor({ ...weekly, interval: 3 }, stored, "2026-11-16", "2026-11-20")).toEqual({
      ...weekly,
      interval: 3,
      anchor: "2026-11-02",
    });
    // From plain to custom: the anchor is new.
    expect(withAnchor({ ...weekly, interval: 2 }, weekly, "2026-11-16", "2026-11-20").anchor).toBe(
      "2026-11-16",
    );
  });
});

describe("rescheduled occurrences", () => {
  it("stays on its day at the free slot nearest the chosen time", () => {
    const r = plan(
      snapshot(
        "2026-11-02T08:00",
        {
          habits: [
            habit({
              id: "lunch",
              idealMinute: 720,
              frequency: { period: "weekly", days: [3] },
              rescheduled: { "2026-11-04": 15 * 60 },
            }),
          ],
          events: [ext(at("2026-11-04", "15:00"), at("2026-11-04", "16:00"))],
        },
        1,
      ),
    );
    expect(spans(of(r, "lunch"))).toEqual(["2026-11-04T14:00/15:00"]);
  });

  // The Wednesday occurrence's event is on Thursday (rule 14, or a move by
  // hand). The chosen time counts from Wednesday: 1440 minutes on is Thursday.
  const moved = (over: Partial<HabitItem>) =>
    habit({ id: "lunch", idealMinute: 720, frequency: { period: "weekly", days: [3] }, ...over });

  it("a reschedule on the day the event moved to stays on that day", () => {
    const r = plan(
      snapshot(
        "2026-11-02T08:00",
        { habits: [moved({ rescheduled: { "2026-11-04": 1440 + 900 } })] },
        1,
      ),
    );
    expect(spans(of(r, "lunch"))).toEqual(["2026-11-05T15:00/16:00"]);
  });

  it("a snooze on the day the event moved to goes to the first free slot after it that day", () => {
    const r = plan(
      snapshot(
        "2026-11-02T08:00",
        {
          habits: [moved({ notBefore: { "2026-11-04": 1440 + 900 } })],
          events: [ext(at("2026-11-05", "15:00"), at("2026-11-05", "16:00"))],
        },
        1,
      ),
    );
    expect(spans(of(r, "lunch"))).toEqual(["2026-11-05T16:00/17:00"]);
  });

  it("a snooze moves a started occurrence on the day the event moved to, also an earlier day", () => {
    // The Wednesday occurrence runs on Tuesday: 1440 minutes back is Tuesday.
    const current = [
      {
        key: "habit:lunch:2026-11-04",
        itemId: "lunch",
        start: at("2026-11-03", "12:00"),
        end: at("2026-11-03", "13:00"),
        locked: false,
      },
    ];
    const r = plan(
      snapshot("2026-11-03T12:05", {
        current,
        habits: [moved({ notBefore: { "2026-11-04": -1440 + 735 } })],
      }),
    );
    expect(spans(of(r, "lunch"))[0]).toBe("2026-11-03T12:15/13:15");
  });

  // On the later day the occurrence's date has passed; the plan still has it.
  const onThursday = (start: string, end: string) => [
    {
      key: "habit:lunch:2026-11-04",
      itemId: "lunch",
      start: at("2026-11-05", start),
      end: at("2026-11-05", end),
      locked: false,
    },
  ];
  const wednesday = (r: ReturnType<typeof plan>) =>
    spans(of(r, "lunch").filter((p) => p.key === "habit:lunch:2026-11-04"));

  it("a reschedule to a later day stays there on runs on that day", () => {
    const lunch = moved({ rescheduled: { "2026-11-04": 1440 + 600 } });
    const before = plan(snapshot("2026-11-04T08:00", { habits: [lunch] }, 1));
    expect(wednesday(before)).toEqual(["2026-11-05T10:00/11:00"]);
    const after = plan(
      snapshot("2026-11-05T08:00", { habits: [lunch], current: onThursday("10:00", "11:00") }, 1),
    );
    expect(wednesday(after)).toEqual(["2026-11-05T10:00/11:00"]);
  });

  it("a snooze on the later day, on that day, moves the occurrence there", () => {
    const lunch = moved({ notBefore: { "2026-11-04": 1440 + 780 } });
    const r = plan(
      snapshot("2026-11-05T11:00", { habits: [lunch], current: onThursday("12:00", "13:00") }, 1),
    );
    expect(wednesday(r)).toEqual(["2026-11-05T13:00/14:00"]);
  });

  it("an occurrence placed on a later alternative day (rule 14) keeps it on that day", () => {
    const events = ["2026-11-03", "2026-11-04"].map((d) => ext(at(d, "09:00"), at(d, "17:00")));
    const lunch = moved({});
    const before = plan(snapshot("2026-11-02T08:00", { habits: [lunch], events }, 1));
    expect(wednesday(before)).toEqual(["2026-11-05T12:00/13:00"]);
    const after = plan(
      snapshot(
        "2026-11-05T08:00",
        { habits: [lunch], events, current: onThursday("12:00", "13:00") },
        1,
      ),
    );
    expect(wednesday(after)).toEqual(["2026-11-05T12:00/13:00"]);
  });

  it("an occurrence of a passed date with no event and no choice is not placed again", () => {
    const r = plan(snapshot("2026-11-05T08:00", { habits: [moved({})] }, 1));
    expect(wednesday(r)).toEqual([]);
  });
});

describe("reactive focus", () => {
  const goal = (over: Partial<FocusItem> = {}): FocusItem => ({
    id: "focus",
    title: "Focus",
    rank: 0,
    createdAt: 0,
    hours: "work",
    weeklyGoalMinutes: 600,
    dailyMinMinutes: 0,
    dailyMaxMinutes: 240,
    minBlockMinutes: 60,
    maxBlockMinutes: 120,
    busy: true,
    exclusions: [],
    changed: false,
    mode: "reactive",
    ...over,
  });
  const fullDays = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      ext(at(addDays("2026-11-02", i), "09:00"), at(addDays("2026-11-02", i), "17:00")),
    );

  it("waits while free time exceeds the missing goal and protects all of it when it does not", () => {
    // Monday to Wednesday full: 16 free hours, more than the 10-hour goal.
    const waits = plan(snapshot("2026-11-01T08:00", { focus: [goal()], events: fullDays(3) }, 1));
    expect(of(waits, "focus")).toEqual([]);
    expect(waits.report.filter((e) => e.itemKind === "focus")).toEqual([]);
    // Thursday 9 to 15 also busy: exactly 10 free hours, all protected, ignoring block and day limits.
    const events = [...fullDays(3), ext(at("2026-11-05", "09:00"), at("2026-11-05", "15:00"))];
    const fills = plan(snapshot("2026-11-01T08:00", { focus: [goal()], events }, 1));
    expect(spans(of(fills, "focus"))).toEqual(["2026-11-05T15:00/17:00", "2026-11-06T09:00/17:00"]);
  });
});

describe("meeting overload", () => {
  const cap = (over: Partial<OverloadItem> = {}): OverloadItem => ({
    id: "cap",
    title: "Cap",
    rank: 0,
    createdAt: 0,
    hours: "work",
    dailyMaxMinutes: 120,
    weeklyMaxMinutes: null,
    heavyDayMinutes: null,
    minBlockMinutes: 30,
    exclusions: [],
    changed: false,
    ...over,
  });
  const tue = "2026-11-03";
  const meet = (date: string, a: string, b: string, over: Partial<ExternalEvent> = {}) =>
    ext(at(date, a), at(date, b), {
      attendeeCount: 2,
      selfResponse: "accepted",
      organizerSelf: false,
      ...over,
    });

  it("counts only meetings the user attends, once per minute", () => {
    const run = (events: ExternalEvent[]) =>
      spans(of(plan(snapshot("2026-11-02T08:00", { overloads: [cap()], events }, 1)), "cap"));
    // An unanswered invitation, a declined one, and an own event without guests do not count.
    expect(
      run([
        meet(tue, "09:00", "10:00"),
        meet(tue, "10:00", "11:00", { selfResponse: "needsAction" }),
        meet(tue, "11:00", "12:00", { selfResponse: "declined" }),
        ext(at(tue, "12:00"), at(tue, "13:00")),
      ]),
    ).toEqual([]);
    // Overlapping meetings count once.
    expect(run([meet(tue, "09:00", "10:00"), meet(tue, "09:30", "10:30")])).toEqual([]);
    // Tentative, organized and booked meetings count.
    expect(
      run([
        meet(tue, "09:00", "09:30", { selfResponse: "tentative" }),
        meet(tue, "09:30", "10:00", { selfResponse: null, organizerSelf: true }),
        meet(tue, "10:00", "11:00", { bookedViaLink: true, selfResponse: null }),
      ]),
    ).toEqual([`${tue}T11:00/17:00`]);
  });

  it("counts a flexible meeting placed in the same run", () => {
    const r = plan(
      snapshot(
        "2026-11-02T08:00",
        {
          overloads: [cap()],
          events: [meet(tue, "09:00", "10:00")],
          meetings: [
            {
              id: "m",
              title: "1:1",
              level: 2,
              rank: 0,
              createdAt: 0,
              hours: "work",
              attendeeWindow: null,
              attendeeBusy: [],
              idealMinute: 600,
              frequency: { period: "weekly", everyWeeks: 1, idealDays: [2] },
              durationMinutes: 60,
              shortestMinutes: 60,
              starting: null,
              defense: "busy",
              whenUnplaceable: "remove",
              leadMinutes: 0,
              exclusions: [],
              changed: false,
            },
          ],
        },
        1,
      ),
    );
    expect(spans(of(r, "cap"))).toEqual([`${tue}T11:00/17:00`]);
  });

  it("protects from the day the weekly limit is reached, and only after a heavy workday", () => {
    const weekly = plan(
      snapshot(
        "2026-11-02T08:00",
        {
          overloads: [cap({ dailyMaxMinutes: null, weeklyMaxMinutes: 180 })],
          events: [meet("2026-11-02", "09:00", "11:00"), meet("2026-11-04", "09:00", "10:00")],
        },
        1,
      ),
    );
    expect(spans(of(weekly, "cap"))).toEqual([
      "2026-11-04T10:00/17:00",
      "2026-11-05T09:00/17:00",
      "2026-11-06T09:00/17:00",
    ]);
    // Friday is heavy, the weekend has no hours: Monday is the next workday.
    const heavy = plan(
      snapshot(
        "2026-11-05T08:00",
        {
          overloads: [cap({ heavyDayMinutes: 240 })],
          events: [
            meet("2026-11-06", "09:00", "13:00"),
            meet("2026-11-09", "09:00", "11:00"),
            meet("2026-11-10", "09:00", "11:00"),
          ],
        },
        1,
      ),
    );
    expect(spans(of(heavy, "cap"))).toEqual(["2026-11-09T11:00/17:00"]);
  });
});

describe("buffer filters", () => {
  const buffer = (over: Partial<BufferItem> = {}): BufferItem => ({
    id: "buf",
    title: "Buffer",
    level: 3,
    rank: 0,
    createdAt: 0,
    side: "after",
    minutesBefore: 0,
    minutesAfter: 15,
    busy: true,
    filter: {},
    onConflict: "remove",
    changed: false,
    ...over,
  });
  const tue = "2026-11-03";
  const meet = (a: string, b: string, over: Partial<ExternalEvent> = {}) =>
    ext(at(tue, a), at(tue, b), {
      attendeeCount: 2,
      attendees: ["me@x.test", "a@corp.example"],
      ...over,
    });

  it("puts one buffer after a run longer than the limit; a gap ends a run", () => {
    const r = plan(
      snapshot(
        "2026-11-02T08:00",
        {
          buffers: [
            buffer({ filter: { participants: { op: ">=", value: 2 }, runLongerThanMinutes: 90 } }),
          ],
          events: [
            meet("09:00", "10:00"),
            meet("10:00", "11:00"),
            meet("13:00", "14:00"),
            meet("14:05", "15:00"),
          ],
        },
        1,
      ),
    );
    expect(spans(of(r, "buf"))).toEqual([`${tue}T11:00/11:15`]);
  });

  it("matches people by address or domain, never by a part of an address", () => {
    const r = plan(
      snapshot(
        "2026-11-02T08:00",
        {
          buffers: [buffer({ filter: { people: ["A@corp.example", "@board.example"] } })],
          events: [
            meet("09:00", "10:00"),
            meet("11:00", "12:00", { attendees: ["me@x.test", "ceo@board.example"] }),
            meet("13:00", "14:00", { attendees: ["me@x.test", "ba@corp.example"] }),
          ],
        },
        1,
      ),
    );
    expect(spans(of(r, "buf"))).toEqual([`${tue}T10:00/10:15`, `${tue}T12:00/12:15`]);
  });

  it("uses only anchors of its calendar, and gives a copy no buffer when its source has one", () => {
    const events = [
      meet("09:00", "10:00", { calendarId: "work" }),
      meet("11:00", "12:00", { calendarId: "side" }),
    ];
    const copy = ext(at(tue, "11:00"), at(tue, "12:00"), {
      id: "mirror:c1",
      calendarId: "work",
      mirrorSource: "side",
      attendeeCount: 0,
    });
    const scoped = plan(
      snapshot(
        "2026-11-02T08:00",
        {
          buffers: [buffer({ calendarScope: "work" })],
          events,
          mirrorCopies: [copy],
        },
        1,
      ),
    );
    // The copy on the work calendar is an anchor there; the side meeting is not.
    expect(spans(of(scoped, "buf"))).toEqual([`${tue}T10:00/10:15`, `${tue}T12:00/12:15`]);
    const everywhere = plan(
      snapshot(
        "2026-11-02T08:00",
        {
          buffers: [buffer({ calendarScope: null, onConflict: "keep_as_conflict" })],
          events,
          mirrorCopies: [copy],
        },
        1,
      ),
    );
    // With all calendars the source itself is an anchor, so the copy adds no second buffer.
    expect(spans(of(everywhere, "buf"))).toEqual([`${tue}T10:00/10:15`, `${tue}T12:00/12:15`]);
  });
});
