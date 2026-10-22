// Auto-lock per flexible meeting and the flag of a locked occurrence in conflict
// (docs/specs/meetings-flexible-rescheduling.md rules 7, 14, 15; acceptance
// test 9). The E2E suite proves the journey; these cases cover the edges.
//
// Ways it can fail:
// 1. A meeting's own choice is ignored, or the setting for flexible meetings
//    also locks the meetings that have their own choice.
// 2. A meeting made before the hour from 01:00 waits a day for its first run.
// 3. An edit from off to on does not lock at once, or one from day to week does;
//    a meeting that follows the setting locks the other meetings too.
// 4. A locked occurrence in conflict moves, or keeps its time with no flag and
//    no suggested times; one with no conflict, or in the past, is flagged.
import { describe, expect, it } from "vitest";
import type { ExternalEvent, MeetingItem, Snapshot } from "../../src/scheduler/model.ts";
import { plan } from "../../src/scheduler/plan.ts";
import { ensureUser } from "../../src/server/accounts.ts";
import { all, type Db, openDb, run } from "../../src/server/db.ts";
import { autoLock, meetingTurnedOn } from "../../src/server/planner/auto-lock.ts";
import { settingsSchema } from "../../src/server/settings.ts";
import { localToUtc } from "../../src/shared/time.ts";

const ZONE = "Europe/Berlin";
const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return localToUtc(ZONE, date, h * 60 + m);
};
// Sunday 2026-11-01 to Saturday 2026-11-07; the week starts on Sunday.
const SUN = "2026-11-01";
const MON = "2026-11-02";
const TUE = "2026-11-03";

function setup(): {
  db: Db;
  userId: string;
  add: (key: string, meeting: string, date: string) => void;
} {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", at(SUN, "00:00") - 86_400_000);
  run(db, "UPDATE users SET time_zone = ? WHERE id = ?", ZONE, user.id);
  run(
    db,
    `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at, is_main)
     VALUES ('acc', ?, 'caldav', 'x', 'owner@example.com', '', 0, 1)`,
    user.id,
  );
  run(
    db,
    `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability, writable)
     VALUES ('cal', 'acc', 'cal', 'Work', 1, 1, 1)`,
  );
  run(
    db,
    "INSERT INTO hours_sets (id, user_id, name, kind, weekly, created_at) VALUES ('hs', ?, 'Work', 'meeting', '{}', 0)",
    user.id,
  );
  for (const id of ["w", "d", "o", "s"])
    run(
      db,
      `INSERT INTO meetings (id, user_id, title, level, frequency, ideal_minute, duration_minutes,
         shortest_minutes, hours_mode, hours_set_id, defense, when_unplaceable, created_at,
         rules_changed_at, auto_lock)
       VALUES (?, ?, ?, 2, '{"period":"daily"}', 600, 30, 30, 'everyone', 'hs', 'busy',
         'keep_as_conflict', 0, 0, ?)`,
      id,
      user.id,
      id,
      { w: "week", d: "day", o: "off", s: null }[id] ?? null,
    );
  const add = (key: string, meeting: string, date: string) =>
    run(
      db,
      `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id, start_ms, end_ms, busy, title)
       VALUES (?, ?, 'cal', ?, ?, 'meeting', ?, ?, ?, 1, ?)`,
      key,
      user.id,
      key,
      key,
      meeting,
      at(date, "10:00"),
      at(date, "10:30"),
      key,
    );
  return { db, userId: user.id, add };
}

const lockedKeys = (db: Db) =>
  all<{ key: string }>(db, "SELECT key FROM managed_events WHERE locked = 1 ORDER BY key").map(
    (r) => r.key,
  );
const settings = (meeting: "off" | "day" | "week") =>
  settingsSchema.parse({ weekStart: 7, autoLock: { meeting } });

describe("auto-lock per meeting (MEET-02 rule 14)", () => {
  it("each meeting's own choice wins over the setting; 'as in settings' follows it", () => {
    const { db, userId, add } = setup();
    for (const m of ["w", "d", "o", "s"]) {
      add(`${m}-mon`, m, MON);
      add(`${m}-tue`, m, TUE);
    }
    const s = settings("week");
    autoLock(db, userId, s, at("2026-10-31", "15:00"));
    // Sunday 01:30, the first day of the week: the week locks for w and s only.
    autoLock(db, userId, s, at(SUN, "01:30"));
    expect(lockedKeys(db)).toEqual(["s-mon", "s-tue", "w-mon", "w-tue"]);
    // Tuesday 01:30: d locks its day; o never locks.
    autoLock(db, userId, s, at(TUE, "01:30"));
    expect(lockedKeys(db)).toEqual(["d-tue", "s-mon", "s-tue", "w-mon", "w-tue"]);
  });

  it("a meeting made before the hour from 01:00 runs in that hour; one made after waits", () => {
    const { db, userId, add } = setup();
    add("d-tue", "d", TUE);
    add("d-wed", "d", "2026-11-04");
    const s = settings("off");
    autoLock(db, userId, s, at(TUE, "00:30"));
    expect(lockedKeys(db)).toEqual([]);
    autoLock(db, userId, s, at(TUE, "01:10"));
    expect(lockedKeys(db)).toEqual(["d-tue"]);
    // A first run after the hour (rule 15) records only.
    const other = setup();
    other.add("d-tue", "d", TUE);
    autoLock(other.db, other.userId, s, at(TUE, "03:00"));
    autoLock(other.db, other.userId, s, at(TUE, "04:00"));
    expect(lockedKeys(other.db)).toEqual([]);
  });

  it("an edit from off to on locks the current period at once, only for that meeting", () => {
    const { db, userId, add } = setup();
    for (const m of ["d", "o", "s"]) add(`${m}-tue`, m, TUE);
    const NOW = at(TUE, "08:00");
    const before = NOW - 3_600_000;
    add("o-late", "o", TUE);
    run(
      db,
      "UPDATE managed_events SET start_ms = ?, end_ms = ? WHERE key = 'o-late'",
      NOW + 60_000,
      NOW + 1_860_000,
    );
    // Day to week: no lock at once.
    meetingTurnedOn(db, userId, settings("day"), "day", "week", "d", NOW);
    expect(lockedKeys(db)).toEqual([]);
    // Off to week (own choice, saved first): Tuesday is in the current week.
    run(db, "UPDATE meetings SET auto_lock = 'week' WHERE id = 'o'");
    meetingTurnedOn(db, userId, settings("day"), "off", "week", "o", NOW);
    expect(lockedKeys(db)).toEqual(["o-late", "o-tue"]);
    // Off to "as in settings" (day): only that meeting locks.
    run(db, "UPDATE meetings SET auto_lock = NULL WHERE id = 'd'");
    meetingTurnedOn(db, userId, settings("day"), "off", null, "d", before);
    expect(lockedKeys(db)).toEqual(["d-tue", "o-late", "o-tue"]);
    expect(lockedKeys(db)).not.toContain("s-tue");
  });
});

const WORK = Object.fromEntries([1, 2, 3, 4, 5].map((d) => [d, [[540, 1020]]]));
const snapshot = (over: Partial<Snapshot>): Snapshot => ({
  now: at(MON, "08:00"),
  zone: ZONE,
  weekStart: 1,
  windowEnd: at(TUE, "00:00"),
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
const busy = (start: number, end: number): ExternalEvent => ({
  id: `ext-${start}`,
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
const meeting: MeetingItem = {
  id: "m",
  title: "m",
  level: 3,
  rank: 0,
  createdAt: 0,
  hours: "work",
  attendeeWindow: null,
  attendeeBusy: [],
  idealMinute: 600,
  frequency: { period: "daily" },
  durationMinutes: 30,
  shortestMinutes: 30,
  starting: MON,
  defense: "busy",
  whenUnplaceable: "keep_as_conflict",
  leadMinutes: 0,
  exclusions: [],
  changed: false,
};
const current = (locked: boolean) => [
  { key: `meeting:m:${MON}`, itemId: "m", start: at(MON, "10:00"), end: at(MON, "10:30"), locked },
];

describe("a locked occurrence in conflict (MEET-02 rule 7, acceptance test 9)", () => {
  const flags = (r: ReturnType<typeof plan>) =>
    r.report.map((e) => [e.reason, e.suggestions?.length ?? 0]);
  const at10 = (r: ReturnType<typeof plan>) =>
    r.placements
      .filter((p) => p.itemId === "m")
      .map((p) => [p.start === at(MON, "10:00"), p.conflict]);

  it("keeps its time and is flagged with up to 3 suggested times", () => {
    const ext = { start: at(MON, "10:00"), end: at(MON, "11:00") };
    const guest = { start: at(MON, "10:15"), end: at(MON, "10:45") };
    const cases: [Partial<Snapshot>, { start: number; end: number }][] = [
      [{ events: [busy(ext.start, ext.end)] }, ext],
      [{ meetings: [{ ...meeting, attendeeBusy: [guest] }] }, guest],
    ];
    for (const [over, block] of cases) {
      const r = plan(snapshot({ meetings: [meeting], current: current(true), ...over }));
      expect(at10(r)).toEqual([[true, true]]);
      expect(flags(r)).toEqual([["locked-conflict", 3]]);
      const s = r.report[0]?.suggestions ?? [];
      expect(s.filter((t) => t.start < block.end && t.end > block.start)).toEqual([]);
    }
  });

  it("is not flagged without a conflict or once started; an unlocked one moves", () => {
    const quiet = plan(snapshot({ meetings: [meeting], current: current(true) }));
    expect([at10(quiet), flags(quiet)]).toEqual([[[true, false]], []]);
    const ev = [busy(at(MON, "10:00"), at(MON, "11:00"))];
    const started = plan(
      snapshot({ meetings: [meeting], current: current(true), events: ev, now: at(MON, "10:05") }),
    );
    expect(flags(started)).toEqual([]);
    const open = plan(snapshot({ meetings: [meeting], current: current(false), events: ev }));
    expect([at10(open), flags(open)]).toEqual([[[false, false]], []]);
  });
});
