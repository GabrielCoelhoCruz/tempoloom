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
//    a period with no hours breaks or counts in the run; a period kept in
//    conflict does not count, or counts as held.
// 5. A previous occurrence on an ideal day pushes the next one off its ideal
//    day, and the meeting drifts for good (rule 18).
// 6. A boosted meeting spends its move budget twice in one plan.
// 7. A guest of a group meeting, or a stranger, acts on an occurrence; the
//    organizer skips an occurrence that started; the skipped list grows
//    without limit.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type {
  ExternalEvent,
  HabitItem,
  MeetingItem,
  Placement,
  Plan,
  Snapshot,
} from "../../src/scheduler/model.ts";
import { onIdealDay, plan } from "../../src/scheduler/plan.ts";
import { ensureUser, type User } from "../../src/server/accounts.ts";
import { meetingRoutes } from "../../src/server/api/meetings.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { all, one, openDb, run } from "../../src/server/db.ts";
import {
  meetingBoost,
  recordMissedPeriods,
  skippedPeriods,
} from "../../src/server/planner/meeting-log.ts";
import type { MeetingRow } from "../../src/server/planner/meetings.ts";
import type { SyncService } from "../../src/server/sync/service.ts";
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
  it("keeps an occurrence moved by hand, though it is less than half a period after the previous one", () => {
    // Last Friday 16:00; Wednesday to Friday are busy. Monday 10:00 is too close, so Tuesday.
    const s = snapshot({
      now: at(MON, "07:00"),
      windowEnd: at(addDays(MON, 7), "00:00"),
      meetings: [meeting({ previousStart: at("2026-10-30", "16:00") })],
      events: fullDays(addDays(MON, 2), 3),
    });
    expect(spans(of(plan(s), "m"))).toEqual(["2026-11-03T10:00/10:30"]);
    // "Another day" put it on Monday 10:00; the plan that follows keeps it there.
    const manual = plan({
      ...s,
      current: [occurrence(MON, MON)],
      meetings: [
        meeting({ previousStart: at("2026-10-30", "16:00"), manualKeys: [`meeting:m:${MON}`] }),
      ],
    });
    expect(spans(of(manual, "m"))).toEqual(["2026-11-02T10:00/10:30"]);
    // Without the move by hand, the same occurrence goes to Tuesday.
    const auto = plan({ ...s, current: [occurrence(MON, MON)] });
    expect(spans(of(auto, "m"))).toEqual(["2026-11-03T10:00/10:30"]);
  });

  it("reads an ideal day of a meeting every N months in the first month of its period", () => {
    const f: MeetingItem["frequency"] = { period: "monthly", everyMonths: 3, dayOfMonth: 25 };
    const m = meeting({ frequency: f, starting: "2026-11-01" });
    expect(onIdealDay(ZONE, 1, m, "2026-11-25")).toBe(true);
    // December and January are in the November period: the 25th there is not its ideal day.
    expect(onIdealDay(ZONE, 1, m, "2026-12-25")).toBe(false);
    expect(onIdealDay(ZONE, 1, m, "2027-01-25")).toBe(false);
    expect(onIdealDay(ZONE, 1, m, "2027-02-25")).toBe(true);
  });

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

  it("does not apply after an occurrence on an ideal day: a Mon/Fri meeting comes back to Monday", () => {
    const monFri: MeetingItem["frequency"] = { period: "weekly", everyWeeks: 1, idealDays: [1, 5] };
    const r = plan(
      snapshot({
        windowEnd: at(addDays(MON, 35), "00:00"),
        meetings: [meeting({ frequency: monFri })],
        events: fullDays(MON, 1),
      }),
    );
    expect(spans(of(r, "m"))).toEqual([
      "2026-11-06T10:00/10:30",
      "2026-11-09T10:00/10:30",
      "2026-11-16T10:00/10:30",
      "2026-11-23T10:00/10:30",
      "2026-11-30T10:00/10:30",
    ]);
    // The same from an earlier plan: last Friday was an ideal day.
    const fromDb = plan(
      snapshot({
        meetings: [meeting({ frequency: monFri, previousStart: at("2026-10-30", "10:00") })],
      }),
    );
    expect(spans(of(fromDb, "m"))[0]).toBe("2026-11-02T10:00/10:30");
  });
});

describe("move budget (MEET-02 rules 9-11)", () => {
  it("is spent once per plan by a boosted meeting, over its boosted and other periods", () => {
    const daily = { period: "daily" } as const;
    const current = ["2026-11-02", "2026-11-03"].map((d) => occurrence(d, d));
    const events = ["2026-11-02", "2026-11-03"].map((d) => busy(at(d, "10:00"), at(d, "10:30")));
    const r = plan(
      snapshot({
        meetings: [
          meeting({ frequency: daily, movesLeft: 1, boost: { period: "2026-11-03", level: 1 } }),
        ],
        events,
        current,
        windowEnd: at("2026-11-04", "00:00"),
      }),
    );
    const moved = of(r, "m").filter((p) => !p.conflict);
    expect(spans(moved)).toEqual(["2026-11-03T09:30/10:00"]);
    expect(r.report.filter((e) => e.itemId === "m").map((e) => [e.demandKey, e.reason])).toEqual([
      ["meeting:m:2026-11-02", "budget-reached"],
    ]);
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

  it("counts periods kept in conflict as missed, though their occurrence stays on the calendar", () => {
    const { db, user, m } = boostDb();
    for (const d of ["2026-11-02", "2026-11-03"]) {
      run(
        db,
        "INSERT INTO meeting_missed (meeting_id, period, status, reason, at) VALUES ('m1', ?, 'conflict', 'x', 0)",
        d,
      );
      heldRow(db, user.id, d);
    }
    expect(meetingBoost(db, user.id, m, at("2026-11-03", "06:00"))).toEqual({
      period: "2026-11-03",
      level: 2,
      missed: 1,
    });
    expect(meetingBoost(db, user.id, m, at("2026-11-04", "06:00"))).toEqual({
      period: "2026-11-04",
      level: 1,
      missed: 2,
    });
  });
});

const dailyJson = JSON.stringify({ period: "daily" });
function boostDb() {
  const db = openDb(":memory:");
  const user = ensureUser(db, "o@example.com", "O", 0);
  run(db, "PRAGMA foreign_keys = OFF");
  run(db, "UPDATE users SET time_zone = ? WHERE id = ?", ZONE, user.id);
  run(
    db,
    `INSERT INTO meetings (id, user_id, title, level, rank, frequency, ideal_minute, duration_minutes,
       shortest_minutes, hours_mode, hours_set_id, defense, when_unplaceable, created_at, rules_changed_at)
     VALUES ('m1', ?, 'M', 3, 0, ?, 600, 30, 30, 'organizer', 'x', 'busy', 'keep_as_conflict', 0, 0)`,
    user.id,
    dailyJson,
  );
  const m = { id: "m1", level: 3, frequency: dailyJson } as MeetingRow;
  return { db, user, m };
}
const heldRow = (db: ReturnType<typeof openDb>, userId: string, date: string) =>
  run(
    db,
    `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id,
       start_ms, end_ms, busy, title, description, locked, extra)
     VALUES (?, ?, 'c', ?, ?, 'meeting', 'm1', ?, ?, 1, 'M', '', 0, '')`,
    `e-${date}`,
    userId,
    `ev-${date}`,
    `meeting:m1:${date}`,
    at(date, "10:00"),
    at(date, "10:30"),
  );

describe("skipped periods (MEET-02 rule 34)", () => {
  it("keeps 90 days of history, or three periods when that is longer", () => {
    const { db, user, m } = boostDb();
    for (const d of ["2026-07-01", "2026-08-10", "2026-11-02"])
      run(
        db,
        "INSERT INTO meeting_missed (meeting_id, period, status, reason, at) VALUES ('m1', ?, 'unplaced', 'x', 0)",
        d,
      );
    const empty: Plan = { placements: [], report: [] } as unknown as Plan;
    recordMissedPeriods(db, user.id, empty, at("2026-11-04", "06:00"));
    expect(all(db, "SELECT period FROM meeting_missed ORDER BY period")).toEqual([
      { period: "2026-08-10" },
      { period: "2026-11-02" },
    ]);
    expect(skippedPeriods(db, m.id).map((p) => p.period)).toEqual(["2026-08-10", "2026-11-02"]);
  });
});

describe("occurrence actions through the API (MEET-02 rules 20, 26)", () => {
  const T = at("2026-11-02", "08:00");
  function setup() {
    const db = openDb(":memory:");
    const owner = ensureUser(db, "owner@example.com", "Owner", T);
    const guest = ensureUser(db, "guest@example.com", "Guest", T);
    const stranger = ensureUser(db, "stranger@example.com", "Stranger", T);
    const as = { user: owner as User };
    const sync = {
      request() {},
      exclusive: async () => "missing",
    } as unknown as SyncService;
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("user", as.user);
      await next();
    });
    app.route(
      "/api",
      meetingRoutes(db, sync, () => T),
    );
    const call = async (method: string, path: string, body?: unknown) =>
      app.request(`/api${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
    run(db, "PRAGMA foreign_keys = OFF");
    run(
      db,
      "INSERT INTO calendars (id, account_id, provider_id, name) VALUES ('cal', 'acc', 'p', 'Cal')",
    );
    let n = 0;
    const occurrenceOf = (meetingId: string, start: number) => {
      const id = `occ-${++n}`;
      run(
        db,
        `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id,
           start_ms, end_ms, busy, title, description, locked, extra)
         VALUES (?, ?, 'cal', ?, ?, 'meeting', ?, ?, ?, 1, 'M', '', 0, '')`,
        id,
        owner.id,
        `ev-${n}`,
        `meeting:${meetingId}:p${n}`,
        meetingId,
        start,
        start + 30 * 60_000,
      );
      return id;
    };
    return { db, owner, guest, stranger, as, call, occurrenceOf };
  }
  const create = async (
    call: (m: string, p: string, b?: unknown) => Promise<Response>,
    emails: string[],
  ) =>
    (
      (await (
        await call("POST", "/meetings", {
          title: "M",
          attendees: emails.map((email) => ({ email })),
          frequency: { period: "weekly", everyWeeks: 1, idealDays: [2] },
          idealTime: "10:00",
          durationMinutes: 30,
        })
      ).json()) as { id: string }
    ).id;

  it("gives 404 to a guest of a group meeting and to a stranger", async () => {
    const { owner, guest, stranger, as, call, occurrenceOf } = setup();
    as.user = owner;
    const oneOnOne = occurrenceOf(await create(call, [guest.email]), at("2026-11-03", "10:00"));
    const group = occurrenceOf(
      await create(call, [guest.email, "dana@example.com"]),
      at("2026-11-03", "14:00"),
    );
    const actions = ["reschedule", "skip"] as const;
    const body = { option: "otherDay" };
    for (const [who, eventId] of [
      [guest, group],
      [stranger, oneOnOne],
      [stranger, group],
    ] as const) {
      as.user = who;
      for (const a of actions)
        expect((await call("POST", `/meetings/occurrences/${eventId}/${a}`, body)).status).toBe(
          404,
        );
    }
    // The guest of the 1:1 may act.
    as.user = guest;
    expect((await call("POST", `/meetings/occurrences/${oneOnOne}/skip`)).status).toBe(200);
  });

  it("has one skip route, for organizer and guest, that refuses an occurrence that started", async () => {
    const { db, owner, guest, as, call, occurrenceOf } = setup();
    as.user = owner;
    const id = await create(call, [guest.email]);
    const started = occurrenceOf(id, T - 10 * 60_000);
    const future = occurrenceOf(id, at("2026-11-03", "10:00"));
    expect((await call("POST", `/meetings/${id}/skip`, { eventId: future })).status).toBe(404);
    for (const user of [owner, guest]) {
      as.user = user;
      expect((await call("POST", `/meetings/occurrences/${started}/skip`)).status).toBe(409);
    }
    as.user = owner;
    expect((await call("POST", `/meetings/occurrences/${future}/skip`)).status).toBe(200);
    const keys = all<{ key: string }>(
      db,
      "SELECT key FROM dismissed_keys WHERE user_id = ?",
      owner.id,
    );
    expect(keys.map((k) => k.key)).toEqual([
      one<{ key: string }>(db, "SELECT key FROM managed_events WHERE id = ?", future)?.key,
    ]);
  });
});
