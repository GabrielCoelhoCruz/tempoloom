// Scheduler and server rules of flexible meetings, part C
// (docs/specs/meetings-flexible.md rule 18; meetings-flexible-rescheduling.md
// rule 16). The E2E suite proves the journeys; these cases cover the counting.
//
// Ways it can fail:
// 1. The next occurrence stays at its ideal time close after a late one, or
//    leaves its ideal time when the previous one was far enough (rule 18).
// 2. The cadence empties a period when no spaced start exists.
// 3. A boosted period does not go before a higher-priority item, or the boost
//    spills into other periods (rule 16).
// 4. The boost counts a period that is not over, or survives a held period;
//    a period with no hours breaks or counts in the run.
import { describe, expect, it } from "vitest";
import type {
  ExternalEvent,
  HabitItem,
  MeetingItem,
  Placement,
  Snapshot,
} from "../../src/scheduler/model.ts";
import { plan } from "../../src/scheduler/plan.ts";
import { ensureUser } from "../../src/server/accounts.ts";
import { openDb, run } from "../../src/server/db.ts";
import { meetingBoost } from "../../src/server/planner/meeting-log.ts";
import type { MeetingRow } from "../../src/server/planner/meetings.ts";
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
const MON = "2026-11-02";
const WORK = Object.fromEntries([1, 2, 3, 4, 5].map((d) => [d, [[540, 1020]]]));

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    now: at(addDays(MON, -3), "08:00"),
    zone: ZONE,
    weekStart: 1,
    windowEnd: at(addDays(MON, 14), "00:00"),
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
const busy = (start: number, end: number): ExternalEvent => ({
  id: `ext-${++seq}`,
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
const meeting = (over: Partial<MeetingItem> = {}): MeetingItem => ({
  id: "m",
  title: "m",
  level: 3,
  rank: 0,
  createdAt: 0,
  hours: "work",
  attendeeWindow: null,
  attendeeBusy: [],
  idealMinute: 600,
  frequency: { period: "weekly", everyWeeks: 1, idealDays: [1] },
  durationMinutes: 30,
  shortestMinutes: 30,
  starting: MON,
  defense: "busy",
  whenUnplaceable: "remove",
  leadMinutes: 0,
  exclusions: [],
  changed: false,
  ...over,
});
const fullDays = (from: string, n: number) =>
  Array.from({ length: n }, (_, i) =>
    busy(at(addDays(from, i), "08:00"), at(addDays(from, i), "18:00")),
  );
const occurrence = (period: string, date: string) => ({
  key: `meeting:m:${period}`,
  itemId: "m",
  start: at(date, "10:00"),
  end: at(date, "10:30"),
  locked: false,
});

describe("cadence after a move (rule 18)", () => {
  it("keeps the next occurrence half a period after a late one, and only the next", () => {
    const r = plan(snapshot({ meetings: [meeting()], events: fullDays(MON, 4) }));
    expect(spans(of(r, "m"))).toEqual(["2026-11-06T10:00/10:30", "2026-11-10T10:00/10:30"]);
  });

  it("moves a kept occurrence that is too close, and keeps one that is far enough", () => {
    const current = [occurrence(MON, "2026-11-06"), occurrence("2026-11-09", "2026-11-09")];
    const r = plan(snapshot({ meetings: [meeting()], events: fullDays(MON, 4), current }));
    expect(spans(of(r, "m"))).toEqual(["2026-11-06T10:00/10:30", "2026-11-10T10:00/10:30"]);
    const far = plan(
      snapshot({ meetings: [meeting({ previousStart: at("2026-10-26", "10:00") })] }),
    );
    expect(spans(of(far, "m"))).toEqual(["2026-11-02T10:00/10:30", "2026-11-09T10:00/10:30"]);
  });

  it("counts from the last occurrence before now, and still places when no spaced start exists", () => {
    // The last one was Friday 16:00; Monday is the only day with room this week.
    const r = plan(
      snapshot({
        now: at(MON, "07:00"),
        windowEnd: at(addDays(MON, 7), "00:00"),
        meetings: [meeting({ previousStart: at("2026-10-30", "16:00") })],
        events: fullDays(addDays(MON, 1), 4),
      }),
    );
    expect(spans(of(r, "m"))).toEqual(["2026-11-02T10:00/10:30"]);
  });
});

describe("priority boost (MEET-02 rule 16)", () => {
  const habit: HabitItem = {
    id: "h",
    title: "h",
    level: 2,
    rank: 0,
    createdAt: 0,
    hours: "work",
    idealMinute: 600,
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
  };
  // Only 10:00 to 10:30 is free on every workday.
  const events = Array.from({ length: 14 }, (_, i) => addDays(MON, i)).flatMap((d) => [
    busy(at(d, "08:00"), at(d, "10:00")),
    busy(at(d, "10:30"), at(d, "18:00")),
  ]);
  const daily = { period: "daily" } as const;

  it("places the boosted period before a higher-priority item, and only that period", () => {
    const plain = plan(
      snapshot({ meetings: [meeting({ frequency: daily })], habits: [habit], events }),
    );
    expect(spans(of(plain, "m"))).toEqual([]);
    const boosted = plan(
      snapshot({
        meetings: [meeting({ frequency: daily, boost: { period: "2026-11-03", level: 1 } })],
        habits: [habit],
        events,
      }),
    );
    expect(spans(of(boosted, "m"))).toEqual(["2026-11-03T10:00/10:30"]);
    expect(spans(of(boosted, "h"))).not.toContain("2026-11-03T10:00/10:30");
  });

  it("counts ended periods with no time: one level up after one, P1 after two; a held period ends it", () => {
    const db = openDb(":memory:");
    const user = ensureUser(db, "o@example.com", "O", 0);
    // The boost reads only the keys of managed events: no calendar rows needed.
    run(db, "PRAGMA foreign_keys = OFF");
    run(db, "UPDATE users SET time_zone = ? WHERE id = ?", ZONE, user.id);
    run(
      db,
      `INSERT INTO meetings (id, user_id, title, level, rank, frequency, ideal_minute, duration_minutes,
         shortest_minutes, hours_mode, hours_set_id, defense, when_unplaceable, created_at, rules_changed_at)
       VALUES ('m1', ?, 'M', 3, 0, ?, 600, 30, 30, 'organizer', 'x', 'busy', 'remove', 0, 0)`,
      user.id,
      JSON.stringify(daily),
    );
    const m = { id: "m1", level: 3, frequency: JSON.stringify(daily) } as MeetingRow;
    const miss = (period: string) =>
      run(
        db,
        "INSERT INTO meeting_missed (meeting_id, period, status, reason, at) VALUES ('m1', ?, 'unplaced', 'x', 0)",
        period,
      );
    const boost = (date: string) => meetingBoost(db, user.id, m, at(date, "06:00"));
    const held = (date: string) =>
      run(
        db,
        `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id,
           start_ms, end_ms, busy, title, description, locked, extra)
         VALUES (?, ?, 'c', ?, ?, 'meeting', 'm1', ?, ?, 1, 'M', '', 0, '')`,
        `e-${date}`,
        user.id,
        `ev-${date}`,
        `meeting:m1:${date}`,
        at(date, "10:00"),
        at(date, "10:30"),
      );
    miss("2026-11-02");
    miss("2026-11-03");
    // Not over yet: no boost.
    expect(boost("2026-11-02")).toBeUndefined();
    expect(boost("2026-11-03")).toEqual({ period: "2026-11-03", level: 2, missed: 1 });
    expect(boost("2026-11-04")).toEqual({ period: "2026-11-04", level: 1, missed: 2 });
    // Wednesday and Thursday are held, Friday has no time; the weekend has no time and no record; Monday is boosted once.
    for (const d of ["2026-11-04", "2026-11-05"]) held(d);
    miss("2026-11-06");
    expect(boost("2026-11-09")).toEqual({ period: "2026-11-09", level: 2, missed: 1 });
    // A held period after the misses ends the boost.
    held("2026-11-09");
    expect(boost("2026-11-10")).toBeUndefined();
  });
});
