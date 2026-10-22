// The life of Tempoloom's own meeting series after its first write
// (docs/specs/meetings-flexible.md rule 2; meetings-flexible-rescheduling.md
// rules 18, 22, 27-29). A fake calendar keeps each series as the iCalendar
// text Tempoloom writes and reads it back with the CalDAV parser.
//
// Ways it can fail:
// 1. A period at the end of the planning window gets an RDATE next to its
//    rule instance, which starts after the window: two events.
// 2. A series the organizer deleted in a calendar app stops every later plan
//    run of the user (an addInstance "not found" that nothing catches).
// 3. A missing read after the series write leaves no baseline, so the next
//    pull is a "first look" and the organizer's first series edit is lost.
// 4. A travel zone or a home zone change gives a rule in the wrong zone.
// 5. A series that Tempoloom ended counts as the organizer's split.
// 6. Delete, turn-off and a form edit read the meeting before the sync queue
//    ends, so a series written meanwhile is never ended, or its baseline and
//    id are written back with old values.
// 7. A form edit of title, guests, length or ideal time leaves the master as
//    it was, so the instances after the window keep old values and guests.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { meetingRoutes } from "../../src/server/api/meetings.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { all, type Db, one, openDb, run } from "../../src/server/db.ts";
import { meetingItems } from "../../src/server/planner/meetings.ts";
import { type DesiredEvent, pushSchedule } from "../../src/server/planner/push.ts";
import { readSeriesEdits } from "../../src/server/planner/series-edits.ts";
import { eventsFromObject, objectFromWrite } from "../../src/server/providers/caldav.ts";
import {
  type CalendarProvider,
  type EventWrite,
  type ExternalChange,
  ProviderError,
  type ProviderEvent,
} from "../../src/server/providers/types.ts";
import { cacheEvent } from "../../src/server/sync/pull.ts";
import type { SyncService } from "../../src/server/sync/service.ts";
import { localToUtc } from "../../src/shared/time.ts";

const ZONE = "Europe/Berlin";
const DAY = 86_400_000;
const T0 = Date.parse("2026-10-19T08:00:00Z"); // Monday 10:00 in Berlin
const at = (date: string, minute = 600, zone = ZONE) => localToUtc(zone, date, minute);

/** A calendar that keeps each series as the write that made it. */
function fakeCalendar(opts: { noFacts?: boolean } = {}) {
  const objects = new Map<string, EventWrite>();
  const calls: { name: string; id: string; w?: EventWrite; change?: ExternalChange }[] = [];
  let n = 0;
  const strip = (e: ProviderEvent) => {
    if (!opts.noFacts) return e;
    const { series: _facts, ...rest } = e;
    return rest as ProviderEvent;
  };
  const read = (id: string, w: EventWrite) =>
    eventsFromObject(objectFromWrite("u", w, T0), id, '"1"', T0 - 30 * DAY, T0 + 90 * DAY, ZONE, [
      "owner@example.com",
    ]).map(strip);
  const provider = {
    insertEvent: async (_cal: string, w: EventWrite) => {
      const id = `http://dav/${++n}.ics`;
      objects.set(id, w);
      calls.push({ name: "insert", id, w });
      const [first] = read(id, w);
      if (!first) throw new Error("no instance");
      return first;
    },
    seriesInstances: async (_cal: string, id: string, from: number, to: number) => {
      const w = objects.get(id);
      if (!w) throw new ProviderError("not_found", 404, "gone");
      return read(id, w).filter((e) => e.end > from && e.start < to);
    },
    addInstance: async (_cal: string, id: string, w: EventWrite) => {
      calls.push({ name: "addInstance", id, w });
      if (!objects.has(id)) throw new ProviderError("not_found", 404, "gone");
      return {
        ...(read(id, objects.get(id) as EventWrite)[0] as ProviderEvent),
        start: w.start,
        end: w.end,
      };
    },
    endSeries: async (_cal: string, id: string) => {
      calls.push({ name: "endSeries", id });
    },
    editExternal: async (_cal: string, id: string, change: ExternalChange) => {
      calls.push({ name: "edit", id, change });
      const series = id.split("#")[0] ?? id;
      const w = objects.get(series);
      // The series id names the master: the first instance stands for it.
      const base = w ? read(series, w).find((e) => e.id === id || !id.includes("#")) : undefined;
      if (!base) throw new ProviderError("not_found", 404, "gone");
      return {
        ...base,
        ...(change.start !== undefined && change.end !== undefined
          ? { start: change.start, end: change.end }
          : {}),
      };
    },
    deleteEvent: async (_cal: string, id: string) => {
      calls.push({ name: "delete", id });
    },
    notifiesGuests: async () => false,
  } as unknown as CalendarProvider;
  return { provider, calls, objects };
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
  run(
    db,
    "INSERT INTO meeting_attendees (meeting_id, email, required) VALUES ('m1', 'dana@example.com', 1)",
  );
  return { db, userId: user.id };
}

const occurrence = (period: string, date: string, minute = 600): DesiredEvent => ({
  key: `meeting:m1:${period}`,
  kind: "meeting",
  sourceId: "m1",
  calendarId: "cal",
  start: at(date, minute),
  end: at(date, minute + 30),
  title: "● Sync",
  description: "",
  busy: true,
  colorId: null,
  attendees: ["dana@example.com"],
  optionalAttendees: [],
  organizer: "owner@example.com",
});

const pusher = (s: ReturnType<typeof setup>, provider: CalendarProvider) => (d: DesiredEvent[]) =>
  pushSchedule(
    {
      db: s.db as Db,
      userId: s.userId,
      now: T0,
      target: () => ({ provider, providerCalendarId: "cal" }),
    },
    d,
  );

const meeting = (db: Db) =>
  one<{
    series_event_id: string | null;
    series_rule: string;
    enabled: number;
    duration_minutes: number;
  }>(
    db,
    "SELECT series_event_id, series_rule, enabled, duration_minutes FROM meetings WHERE id = 'm1'",
  );

describe("series at the window edge", () => {
  it("a period whose rule instance is after the window moves that instance: no RDATE, one event", async () => {
    const s = setup();
    const cal = fakeCalendar();
    const push = pusher(s, cal.provider);
    await push([occurrence("2026-10-19", "2026-10-20"), occurrence("2026-10-26", "2026-10-27")]);
    // The window now ends on Tuesday 3 Nov at 00:00: the plan holds that week on Monday.
    const edge = occurrence("2026-11-02", "2026-11-02");
    cal.calls.length = 0;
    await push([
      occurrence("2026-10-19", "2026-10-20"),
      occurrence("2026-10-26", "2026-10-27"),
      edge,
    ]);
    expect(cal.calls.map((c) => c.name)).toEqual(["edit"]);
    expect(cal.calls[0]?.id).toBe("http://dav/1.ics#2026-11-03T10:00:00");
    expect(cal.calls[0]?.change).toMatchObject({ start: edge.start, end: edge.end });
    const row = one<{ event_id: string }>(
      s.db,
      "SELECT event_id FROM managed_events WHERE key = 'meeting:m1:2026-11-02'",
    );
    expect(row?.event_id).toBe("http://dav/1.ics#2026-11-03T10:00:00");
  });
});

describe("a series the organizer deleted", () => {
  it("does not stop the plan run: other items are written, and the meeting forgets the series", async () => {
    const s = setup();
    run(
      s.db,
      "UPDATE meetings SET series_event_id = 'http://dav/gone.ics', series_calendar_id = 'cal' WHERE id = 'm1'",
    );
    const cal = fakeCalendar();
    const task: DesiredEvent = {
      ...occurrence("x", "2026-10-21"),
      key: "task:t1:0",
      kind: "task",
      sourceId: "t1",
      title: "Task",
    };
    await pusher(s, cal.provider)([occurrence("2026-10-26", "2026-10-27"), task]);
    expect(cal.calls.filter((c) => c.name === "insert").map((c) => c.w?.summary)).toContain("Task");
    // Spec edge case 5: the rules stay, the meeting is off, and the log says why.
    expect(meeting(s.db)).toMatchObject({ series_event_id: null, enabled: 0 });
    expect(
      all<{ reason: string }>(s.db, "SELECT reason FROM meeting_changes WHERE meeting_id = 'm1'"),
    ).toEqual([{ reason: "seriesDeleted" }]);
  });

  it("is found by a read of the series, also when the plan places nothing new: the meeting turns off", async () => {
    const s = setup();
    run(
      s.db,
      "UPDATE meetings SET series_event_id = 'http://dav/gone.ics', series_calendar_id = 'cal', series_rule = '{}' WHERE id = 'm1'",
    );
    await pusher(s, fakeCalendar().provider)([]);
    expect(meeting(s.db)).toMatchObject({ series_event_id: null, enabled: 0 });
  });

  it("a series with no instance in the pull window stays: an empty cache never means deleted", () => {
    const s = setup();
    // Every 8 months: the cached window (84 days back, 120 ahead) can hold no instance.
    run(
      s.db,
      "UPDATE meetings SET series_event_id = 'http://dav/far.ics', series_calendar_id = 'cal', series_rule = '{}' WHERE id = 'm1'",
    );
    readSeriesEdits(s.db, s.userId, ["cal"], T0);
    expect(meeting(s.db)).toMatchObject({ series_event_id: "http://dav/far.ics", enabled: 1 });
  });
});

/** The organizer's "all events" edit: the master's write with a change, as the next pull caches it. */
function editAll(
  s: ReturnType<typeof setup>,
  cal: ReturnType<typeof fakeCalendar>,
  edit: Partial<EventWrite>,
) {
  const id = "http://dav/1.ics";
  const w = { ...(cal.objects.get(id) as EventWrite), ...edit };
  cal.objects.set(id, w);
  run(s.db, "DELETE FROM events WHERE calendar_id = 'cal'");
  for (const e of eventsFromObject(
    objectFromWrite("u", w, T0),
    id,
    '"2"',
    T0 - 30 * DAY,
    T0 + 90 * DAY,
    ZONE,
    ["owner@example.com"],
  ))
    cacheEvent(s.db, "cal", e);
}

describe("the series baseline", () => {
  it("comes from the master Tempoloom wrote, so the first series edit is read also when the read after the write gives no facts", async () => {
    const s = setup();
    const cal = fakeCalendar({ noFacts: true });
    await pusher(
      s,
      cal.provider,
    )([occurrence("2026-10-19", "2026-10-20"), occurrence("2026-10-26", "2026-10-27")]);
    const rule = meeting(s.db)?.series_rule ?? "";
    expect(rule).not.toBe("");
    expect(JSON.parse(rule)).not.toBeNull();
    const w = cal.objects.get("http://dav/1.ics") as EventWrite;
    editAll(s, cal, { end: w.end + 15 * 60_000 });
    readSeriesEdits(s.db, s.userId, ["cal"], T0);
    expect(meeting(s.db)?.duration_minutes).toBe(45);
  });
});

describe("the zone of a series", () => {
  it("writes the rule in the home zone, also when the first period is in a trip", async () => {
    const s = setup();
    run(
      s.db,
      `INSERT INTO travel_zones (id, user_id, tz, start_date, end_date, created_at)
       VALUES ('trip', ?, 'America/Los_Angeles', '2026-10-19', '2026-10-25', ?)`,
      s.userId,
      T0,
    );
    const cal = fakeCalendar();
    await pusher(
      s,
      cal.provider,
    )([occurrence("2026-10-19", "2026-10-20"), occurrence("2026-10-26", "2026-10-27")]);
    expect(cal.calls.find((c) => c.name === "insert")?.w).toMatchObject({
      timeZone: ZONE,
      start: at("2026-10-20"),
      recurrence: "FREQ=WEEKLY;BYDAY=TU",
    });
  });

  it("starts a new series in the new home zone when the home zone changes", async () => {
    const s = setup();
    const cal = fakeCalendar();
    const push = pusher(s, cal.provider);
    const desired = [
      occurrence("2026-10-19", "2026-10-20"),
      occurrence("2026-10-26", "2026-10-27"),
    ];
    await push(desired);
    run(s.db, "UPDATE users SET time_zone = 'America/New_York' WHERE id = ?", s.userId);
    cal.calls.length = 0;
    await push(desired);
    expect(cal.calls.find((c) => c.name === "endSeries")?.id).toBe("http://dav/1.ics");
    expect(cal.calls.find((c) => c.name === "insert")?.w?.timeZone).toBe("America/New_York");
  });
});

describe("series edits read from the calendar", () => {
  it("never follows a series that Tempoloom ended", async () => {
    const s = setup();
    const cal = fakeCalendar();
    await pusher(
      s,
      cal.provider,
    )([occurrence("2026-10-19", "2026-10-20"), occurrence("2026-10-26", "2026-10-27")]);
    // An ended series of the same meeting, with a locked instance kept after its end.
    const ended = objectFromWrite(
      "e",
      {
        ...(cal.objects.get("http://dav/1.ics") as EventWrite),
        start: at("2026-11-10"),
        end: at("2026-11-10", 630),
        privateProps: { tl: "1", tl_meeting: "m1", tl_ended: "1" },
      },
      T0,
    );
    for (const e of eventsFromObject(ended, "http://dav/old.ics", null, T0, T0 + 60 * DAY, ZONE, [
      "owner@example.com",
    ]))
      cacheEvent(s.db, "cal", e);
    readSeriesEdits(s.db, s.userId, ["cal"], T0);
    expect(meeting(s.db)?.series_event_id).toBe("http://dav/1.ics");
  });

  it("an end the organizer gives the series (UNTIL) limits the plan to its instances and keeps the rows after it for the skip", async () => {
    const s = setup();
    const cal = fakeCalendar();
    await pusher(
      s,
      cal.provider,
    )([occurrence("2026-10-19", "2026-10-20"), occurrence("2026-10-26", "2026-10-27")]);
    editAll(s, cal, { recurrence: "FREQ=WEEKLY;BYDAY=TU;UNTIL=20261021T000000Z" });
    readSeriesEdits(s.db, s.userId, ["cal"], T0);
    expect(
      all<{ key: string }>(
        s.db,
        "SELECT key FROM managed_events WHERE source_id = 'm1' ORDER BY key",
      ).map((r) => r.key),
    ).toEqual(["meeting:m1:2026-10-19", "meeting:m1:2026-10-26"]);
    const { items } = meetingItems(s.db, s.userId, T0, T0 + 21 * DAY, 0, new Map());
    expect(items[0]?.periods).toBeDefined();
  });
});

/** The meetings API with a sync queue that runs `pending` (a plan run) before each wait ends. */
function api(pending: (db: Db) => void = () => undefined) {
  const s = setup();
  const calls: { name: string; args: unknown[] }[] = [];
  const spy =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push({ name, args });
      return { id: "x", etag: null };
    };
  const provider = {
    endSeries: spy("endSeries"),
    editExternal: spy("editExternal"),
    setSeriesProps: spy("setSeriesProps"),
  };
  const pool = { get: () => provider };
  const failCalendar = () => {
    for (const k of Object.keys(provider) as (keyof typeof provider)[])
      provider[k] = async () => {
        throw new ProviderError("other", 503, "offline");
      };
  };
  const clock = { t: T0, onRead: (): void => {} };
  const sync = {
    request() {},
    exclusive: async (_u: string, fn: (p: typeof pool) => Promise<unknown>) => {
      pending(s.db);
      return fn(pool);
    },
  } as unknown as SyncService;
  const owner = one<{ id: string; email: string }>(
    s.db,
    "SELECT * FROM users WHERE id = ?",
    s.userId,
  );
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", owner as never);
    await next();
  });
  app.route(
    "/api",
    meetingRoutes(s.db, sync, () => {
      clock.onRead();
      return clock.t;
    }),
  );
  const call = (method: string, path: string, body?: unknown) =>
    app.request(`/api${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return { ...s, calls, clock, call, failCalendar };
}

const form = (over: Record<string, unknown> = {}) => ({
  title: "Sync",
  attendees: [{ email: "dana@example.com" }],
  frequency: { period: "weekly", everyWeeks: 1, idealDays: [2] },
  idealTime: "10:00",
  durationMinutes: 30,
  defense: "busy",
  hoursMode: "organizer",
  ...over,
});

const written = (db: Db) =>
  run(
    db,
    `UPDATE meetings SET series_event_id = 'http://dav/s.ics', series_calendar_id = 'cal',
       series_rule = '{"start":0,"end":0,"rrule":"FREQ=WEEKLY;BYDAY=TU","summary":"● Sync","attendees":[],"optional":[],"own":false}'
     WHERE id = 'm1'`,
  );

describe("the meeting routes and the series", () => {
  it.each(["DELETE", "OFF"])(
    "%s reads the meeting after the queue: a series written meanwhile is ended",
    async (action) => {
      const s = api(written);
      const res =
        action === "DELETE"
          ? await s.call("DELETE", "/meetings/m1")
          : await s.call("POST", "/meetings/m1/enabled", { enabled: false });
      expect(res.status).toBeLessThan(300);
      expect(s.calls.find((c) => c.name === "endSeries")?.args[1]).toBe("http://dav/s.ics");
    },
  );

  it("a form edit never writes back the series id or baseline that a plan run wrote meanwhile", async () => {
    const s = api();
    // The plan run writes the series while the edit waits for its body.
    s.clock.onRead = () => written(s.db);
    const res = await s.call("PUT", "/meetings/m1", form({ description: "Notes" }));
    expect(res.status).toBe(200);
    expect(meeting(s.db)?.series_event_id).toBe("http://dav/s.ics");
    expect(meeting(s.db)?.series_rule).toContain("FREQ=WEEKLY");
  });

  it("a form edit is saved also when the calendar server is offline; the plan run writes the series", async () => {
    const s = api();
    written(s.db);
    s.failCalendar();
    const res = await s.call("PUT", "/meetings/m1", form({ title: "Weekly sync" }));
    expect(res.status).toBe(200);
    expect(one<{ title: string }>(s.db, "SELECT title FROM meetings WHERE id = 'm1'")?.title).toBe(
      "Weekly sync",
    );
  });
});

describe("form edits reach the series master in the plan run", () => {
  it("a new title, guest list, description, location or privacy is written to the master; a new length starts a new series", async () => {
    const s = setup();
    const cal = fakeCalendar();
    const push = pusher(s, cal.provider);
    const desired = (over: Partial<DesiredEvent> = {}) => [
      { ...occurrence("2026-10-19", "2026-10-20"), ...over },
      { ...occurrence("2026-10-26", "2026-10-27"), ...over },
    ];
    await push(desired());
    // The form saved a new title, guest, description, location and privacy.
    run(s.db, "UPDATE meetings SET title = 'Weekly sync' WHERE id = 'm1'");
    cal.calls.length = 0;
    const edited = {
      title: "● Weekly sync",
      description: "Agenda",
      location: "Room 9",
      visibility: "private" as const,
      attendees: ["erin@example.com"],
    };
    await push(desired(edited));
    const master = cal.calls.find((c) => c.name === "edit" && c.id === "http://dav/1.ics");
    expect(master?.change).toMatchObject({
      summary: "● Weekly sync",
      description: "Agenda",
      location: "Room 9",
      visibility: "private",
      guests: {
        add: [{ email: "erin@example.com", optional: false }],
        remove: ["dana@example.com"],
      },
    });
    cal.calls.length = 0;
    await push(desired(edited));
    expect(cal.calls.filter((c) => c.id === "http://dav/1.ics")).toEqual([]);
    // A new length is a new rule: the series ends and a new one is written.
    run(s.db, "UPDATE meetings SET duration_minutes = 45 WHERE id = 'm1'");
    cal.calls.length = 0;
    await push(desired({ ...edited, end: at("2026-10-20", 645) }));
    expect(cal.calls.find((c) => c.name === "endSeries")?.id).toBe("http://dav/1.ics");
    expect(cal.calls.find((c) => c.name === "insert")?.w?.end).toBe(
      (cal.calls.find((c) => c.name === "insert")?.w?.start ?? 0) + 45 * 60_000,
    );
  });
});
