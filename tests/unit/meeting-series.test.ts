// Tempoloom's own series for a meeting made from the form
// (docs/specs/meetings-flexible.md rule 2; meetings-flexible-rescheduling.md
// rules 18, 22). The E2E suite proves the Radicale objects; these cases need
// a DST change, other frequencies, or a meeting saved before series existed.
//
// Ways it can fail:
// 1. The series repeats in UTC, so its local time moves by an hour after DST.
// 2. The RRULE gives more or fewer than one instance per period (every N
//    weeks, day 31 in a short month, the last weekday of a month).
// 3. A meeting saved before series gets a series next to its single events:
//    a period then has two events (no EXDATE), or its event is deleted.
// 4. A series rule from the calendar becomes a frequency a meeting cannot keep.
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { all, type Db, one, openDb, run } from "../../src/server/db.ts";
import { type DesiredEvent, pushSchedule } from "../../src/server/planner/push.ts";
import { seriesRrule } from "../../src/server/planner/series.ts";
import { frequencyOf } from "../../src/server/planner/series-edits.ts";
import { eventsFromObject, objectFromWrite } from "../../src/server/providers/caldav.ts";
import type {
  CalendarProvider,
  EventWrite,
  ExternalChange,
  ProviderEvent,
} from "../../src/server/providers/types.ts";
import { vtimezone } from "../../src/server/providers/vtimezone.ts";
import { localToUtc, utcToLocal } from "../../src/shared/time.ts";

const ZONE = "Europe/Berlin";
const DAY = 86_400_000;
const T0 = Date.parse("2026-10-19T08:00:00Z"); // Monday 10:00 in Berlin
const local = (t: number) => {
  const l = utcToLocal(ZONE, t);
  return `${l.date} ${String(Math.floor(l.minuteOfDay / 60)).padStart(2, "0")}:${String(l.minuteOfDay % 60).padStart(2, "0")}`;
};

/** The instances a calendar app reads from a series that `w` writes. */
function instances(w: EventWrite, from: number, to: number): ProviderEvent[] {
  return eventsFromObject(objectFromWrite("u1", w, T0), "http://dav/u1.ics", null, from, to, ZONE, [
    "owner@example.com",
  ]);
}

const weekly = (rrule: string, start: number): EventWrite => ({
  summary: "Sync",
  description: "",
  start,
  end: start + 30 * 60_000,
  busy: true,
  colorId: null,
  privateProps: { tl: "1" },
  recurrence: rrule,
  timeZone: ZONE,
});

describe("series rule", () => {
  it("keeps the local time across the DST change, with a VTIMEZONE the object carries", () => {
    // Tuesday 10:00 in Berlin, every week from October to April.
    const start = localToUtc(ZONE, "2026-10-20", 600);
    const w = weekly("FREQ=WEEKLY;BYDAY=TU", start);
    const ics = objectFromWrite("u1", w, T0);
    expect(ics).toContain("BEGIN:VTIMEZONE");
    expect(ics).toContain("DTSTART;TZID=Europe/Berlin:20261020T100000");
    const times = instances(w, start, start + 26 * 7 * DAY).map((e) => local(e.start).slice(11));
    expect(times).toHaveLength(26);
    expect(new Set(times)).toEqual(new Set(["10:00"]));
  });

  it("writes the transitions of a zone, and one fixed offset for a zone without DST", () => {
    const berlin = vtimezone(ZONE, 2026);
    expect(berlin).toContain(
      "BEGIN:DAYLIGHT\r\nDTSTART:20260329T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
    );
    expect(berlin).toContain("TZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100");
    const tokyo = vtimezone("Asia/Tokyo", 2026);
    expect(tokyo).toContain("TZOFFSETFROM:+0900\r\nTZOFFSETTO:+0900");
    expect(tokyo).not.toContain("DAYLIGHT");
  });

  it.each([
    [
      { period: "weekly", everyWeeks: 2, idealDays: [2, 4] },
      "2026-10-20",
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU",
    ],
    [{ period: "daily", everyDays: 3 }, "2026-10-20", "FREQ=DAILY;INTERVAL=3"],
    [{ period: "monthly", dayOfMonth: 15 }, "2026-10-15", "FREQ=MONTHLY;BYMONTHDAY=15"],
    [{ period: "monthly", dayOfMonth: 31 }, "2026-10-31", "FREQ=MONTHLY;BYMONTHDAY=-1"],
    [
      { period: "monthly", everyMonths: 2, nth: "last", weekday: 5 },
      "2026-10-30",
      "FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR",
    ],
  ] as const)("gives one instance per period: %j", (f, date, rule) => {
    expect(seriesRrule(f as never, date)).toBe(rule);
  });

  it("puts day 31 on the last day of a shorter month, as the planner does", () => {
    const start = localToUtc(ZONE, "2026-10-31", 600);
    const days = instances(
      weekly("FREQ=MONTHLY;BYMONTHDAY=-1", start),
      start,
      start + 130 * DAY,
    ).map((e) => local(e.start).slice(0, 10));
    expect(days).toEqual(["2026-10-31", "2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28"]);
  });

  it("reads a calendar's rule as a meeting frequency, and refuses rules a meeting cannot keep", () => {
    expect(frequencyOf("FREQ=WEEKLY;BYDAY=TH", "2026-10-22")).toEqual({
      period: "weekly",
      everyWeeks: 1,
      idealDays: [4],
    });
    expect(frequencyOf("FREQ=WEEKLY;INTERVAL=2", "2026-10-21")).toEqual({
      period: "weekly",
      everyWeeks: 2,
      idealDays: [3],
    });
    expect(frequencyOf("FREQ=MONTHLY;BYDAY=-1FR", "2026-10-30")).toMatchObject({
      period: "monthly",
      nth: "last",
      weekday: 5,
    });
    expect(frequencyOf("FREQ=WEEKLY;BYDAY=MO,WE", "2026-10-19")).toBeNull();
    expect(frequencyOf("FREQ=YEARLY", "2026-10-19")).toBeNull();
  });
});

const START = (date: string) => localToUtc(ZONE, date, 600);

/** A single event that Tempoloom wrote for an occurrence before series existed. */
const single = (id: string): ProviderEvent => ({
  id,
  cancelled: false,
  etag: '"1"',
  summary: "● Sync",
  description: "",
  location: "",
  start: START("2026-11-03"),
  end: START("2026-11-03") + 30 * 60_000,
  allDay: false,
  busy: true,
  eventType: "default",
  selfResponse: null,
  attendeeCount: 1,
  attendees: ["dana@example.com"],
  organizerSelf: true,
  recurringId: null,
  colorId: null,
  updated: null,
  privateProps: { tl: "1", tl_key: "meeting:m1:2026-11-02" },
  visibility: "default",
});

/** A calendar that keeps each series as iCalendar text, as a CalDAV server reads it back. */
function fakeCalendar() {
  const objects = new Map<string, EventWrite>();
  const writes: { name: string; id: string; w?: EventWrite; change?: ExternalChange }[] = [];
  let n = 0;
  const read = (id: string, w: EventWrite) =>
    eventsFromObject(objectFromWrite("u", w, T0), id, '"1"', T0 - 30 * DAY, T0 + 90 * DAY, ZONE, [
      "owner@example.com",
    ]);
  const provider = {
    insertEvent: async (_cal: string, w: EventWrite) => {
      const id = `http://dav/${++n}.ics`;
      objects.set(id, w);
      writes.push({ name: "insert", id, w });
      const [first] = read(id, w);
      if (!first) throw new Error("no instance");
      return first;
    },
    seriesInstances: async (_cal: string, id: string, from: number, to: number) =>
      read(id, objects.get(id) as EventWrite).filter((e) => e.end > from && e.start < to),
    editExternal: async (_cal: string, id: string, change: ExternalChange) => {
      writes.push({ name: "edit", id, change });
      const series = id.split("#")[0] ?? id;
      const w = objects.get(series);
      const base = (w ? read(series, w).find((e) => e.id === id) : undefined) ?? single(id);
      return {
        ...base,
        ...(change.start !== undefined && change.end !== undefined
          ? { start: change.start, end: change.end }
          : {}),
      };
    },
    deleteEvent: async (_cal: string, id: string) => {
      writes.push({ name: "delete", id });
    },
    notifiesGuests: async () => false,
  } as unknown as CalendarProvider;
  return { provider, writes };
}

function setup() {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", T0);
  run(db, "UPDATE users SET time_zone = ? WHERE id = ?", ZONE, user.id);
  run(
    db,
    `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, status, created_at, is_main)
     VALUES ('acc', ?, 'caldav', 'acc', 'owner@example.com', '', 'ok', ?, 1)`,
    user.id,
    T0,
  );
  run(
    db,
    `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability, writable)
     VALUES ('cal', 'acc', 'cal', 'Work', 1, 1, 1)`,
  );
  run(
    db,
    `INSERT INTO meetings (id, user_id, title, level, rank, frequency, ideal_minute, duration_minutes,
       shortest_minutes, hours_mode, hours_set_id, defense, when_unplaceable, created_at,
       rules_changed_at, series_owned)
     VALUES ('m1', ?, 'Sync', 2, 0, ?, 600, 30, 30, 'organizer',
       (SELECT id FROM hours_sets WHERE user_id = ? LIMIT 1), 'busy', 'keep_as_conflict', ?, ?, 1)`,
    user.id,
    JSON.stringify({ period: "weekly", everyWeeks: 1, idealDays: [2] }),
    user.id,
    T0,
    T0,
  );
  return { db, userId: user.id };
}

const occurrence = (period: string, date: string, minute = 600): DesiredEvent => ({
  key: `meeting:m1:${period}`,
  kind: "meeting",
  sourceId: "m1",
  calendarId: "cal",
  start: localToUtc(ZONE, date, minute),
  end: localToUtc(ZONE, date, minute + 30),
  title: "● Sync",
  description: "",
  busy: true,
  colorId: null,
  attendees: ["dana@example.com"],
  optionalAttendees: [],
  organizer: "owner@example.com",
});

describe("a meeting saved before series", () => {
  it("gets one series; the period with its own event keeps it and gets an EXDATE, so no period has two events", async () => {
    const s = setup();
    // Next week's occurrence, a single event as Tempoloom wrote it before.
    run(
      s.db,
      `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id,
         start_ms, end_ms, busy, title, description, extra)
       VALUES ('old', ?, 'cal', 'http://dav/old.ics', 'meeting:m1:2026-11-02', 'meeting', 'm1', ?, ?, 1, '● Sync', '', ?)`,
      s.userId,
      START("2026-11-03"),
      START("2026-11-03") + 30 * 60_000,
      JSON.stringify({
        location: "",
        attendees: ["dana@example.com"],
        optional: [],
        organizer: "owner@example.com",
      }),
    );
    const cal = fakeCalendar();
    const desired = [
      occurrence("2026-10-26", "2026-10-27"),
      // Next week moves to 11:00: its single event moves, no second event.
      occurrence("2026-11-02", "2026-11-03", 660),
      occurrence("2026-11-09", "2026-11-10"),
    ];
    const push = () =>
      pushSchedule(
        {
          db: s.db as Db,
          userId: s.userId,
          now: T0,
          target: () => ({ provider: cal.provider, providerCalendarId: "cal" }),
        },
        desired,
      );
    await push();
    const inserts = cal.writes.filter((w) => w.name === "insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.w).toMatchObject({
      recurrence: "FREQ=WEEKLY;BYDAY=TU",
      timeZone: ZONE,
      start: START("2026-10-27"),
      exdates: [START("2026-11-03")],
      privateProps: { tl: "1", tl_meeting: "m1" },
    });
    expect(cal.writes.filter((w) => w.name === "delete")).toEqual([]);
    const rows = all<{ key: string; event_id: string; start_ms: number }>(
      s.db,
      "SELECT key, event_id, start_ms FROM managed_events WHERE source_id = 'm1' ORDER BY key",
    );
    expect(rows.map((r) => [r.key.slice(-10), r.event_id, local(r.start_ms)])).toEqual([
      ["2026-10-26", "http://dav/1.ics#2026-10-27T10:00:00", "2026-10-27 10:00"],
      ["2026-11-02", "http://dav/old.ics", "2026-11-03 11:00"],
      ["2026-11-09", "http://dav/1.ics#2026-11-10T10:00:00", "2026-11-10 10:00"],
    ]);
    // The single event moved in place; the series has no instance on that day.
    expect(cal.writes.filter((w) => w.name === "edit").map((w) => w.id)).toEqual([
      "http://dav/old.ics",
    ]);
    const days = await cal.provider.seriesInstances?.("cal", "http://dav/1.ics", T0, T0 + 30 * DAY);
    expect(days?.map((e) => local(e.start).slice(0, 10))).toEqual([
      "2026-10-27",
      "2026-11-10",
      "2026-11-17",
    ]);
    expect(
      one<{ id: string }>(s.db, "SELECT series_event_id AS id FROM meetings WHERE id = 'm1'")?.id,
    ).toBe("http://dav/1.ics");

    // The next run writes nothing more: one series, no new events.
    cal.writes.length = 0;
    await push();
    expect(cal.writes).toEqual([]);
  });
});
