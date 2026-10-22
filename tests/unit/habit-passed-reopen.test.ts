// A habit occurrence of a passed date whose event is on a later day (rule 14,
// or a move by hand), with no chosen time: full plan runs against an in-memory
// database and a fake provider (habits-automation.md rules 29, 31, 33).
//
// Ways it can fail:
// 1. The user deletes the event in the calendar (rule 29): the occurrence is
//    not placed again, because its date has passed and no event or choice
//    keeps the date open.
// 2. In manual start mode nobody starts the event (rule 33): the occurrence is
//    not placed again later that day, for the same reason.
// 3. The clean-up of old choices removes a choice that a live occurrence
//    still needs (a later day of the current period, or an event that has
//    not ended), or keeps choices whose day passed long ago.
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { all, type Db, one, openDb, run } from "../../src/server/db.ts";
import { replanUser } from "../../src/server/planner/replan.ts";
import type {
  CalendarProvider,
  EventWrite,
  ProviderEvent,
} from "../../src/server/providers/types.ts";
import { updateSettings } from "../../src/server/settings.ts";
import { applyCalendarEdits } from "../../src/server/sync/edits.ts";

// The habit is on Mondays. Monday 2026-11-09 had no room, so rule 14 put its
// occurrence on Tuesday 2026-11-10. The runs are on that Tuesday (zone UTC).
const MONDAY = "2026-11-09";
const KEY = `habit:h:${MONDAY}`;
const at = (iso: string) => Date.parse(`${iso}Z`);

interface Write {
  method: "insert" | "update" | "delete";
  start?: number;
  end?: number;
}

let n = 0;
function fakeProvider(writes: Write[]): CalendarProvider {
  const event = (id: string, e: EventWrite): ProviderEvent => ({
    id,
    cancelled: false,
    etag: `"${++n}"`,
    summary: e.summary,
    description: e.description,
    location: "",
    start: e.start,
    end: e.end,
    allDay: false,
    busy: e.busy,
    eventType: "default",
    selfResponse: null,
    attendeeCount: 0,
    attendees: [],
    organizerSelf: true,
    recurringId: null,
    colorId: null,
    updated: null,
    privateProps: e.privateProps ?? {},
    visibility: "default",
  });
  const fail = async (): Promise<never> => {
    throw new Error("not used");
  };
  return {
    listCalendars: fail,
    listEvents: fail,
    insertEvent: async (_cal: string, e: EventWrite) => {
      writes.push({ method: "insert", start: e.start, end: e.end });
      return event(`ev-${n + 1}`, e);
    },
    updateEvent: async (_cal: string, id: string, e: EventWrite) => {
      writes.push({ method: "update", start: e.start, end: e.end });
      return event(id, e);
    },
    deleteEvent: async () => {
      writes.push({ method: "delete" });
    },
    setColor: fail,
    editExternal: fail,
  } as unknown as CalendarProvider;
}

function setup() {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", at("2026-10-01T00:00:00"));
  run(db, "UPDATE users SET time_zone = 'UTC', first_sign_in_at = 0 WHERE id = ?", user.id);
  run(
    db,
    `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at, is_main, status)
     VALUES ('acc', ?, 'caldav', 'a', 'owner@example.com', '', 0, 1, 'ok')`,
    user.id,
  );
  run(
    db,
    `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability, writable)
     VALUES ('cal', 'acc', 'cal', 'Work', 1, 1, 1)`,
  );
  const work = one<{ id: string }>(
    db,
    "SELECT id FROM hours_sets WHERE user_id = ? AND kind = 'work'",
    user.id,
  );
  run(
    db,
    `INSERT INTO habits (id, user_id, title, level, hours_set_id, ideal_minute, min_minutes, max_minutes,
       frequency, defense, when_unplaceable, created_at, rules_changed_at, event_settings)
     VALUES ('h', ?, 'Lunch', 3, ?, 720, 30, 30, '{"period":"weekly","days":[1]}', 'always-busy',
       'remove', 0, 0, '{}')`,
    user.id,
    work?.id ?? "",
  );
  return { db, userId: user.id };
}

/** The occurrence's event, as rule 14 left it. */
function event(db: Db, userId: string, start: string, end: string, cached = true) {
  run(
    db,
    `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id,
       start_ms, end_ms, busy, title) VALUES ('m1', ?, 'cal', 'ev1', ?, 'habit', 'h', ?, ?, 1, 'Lunch')`,
    userId,
    KEY,
    at(start),
    at(end),
  );
  if (cached)
    run(
      db,
      `INSERT INTO events (calendar_id, event_id, summary, start_ms, end_ms)
       VALUES ('cal', 'ev1', 'Lunch', ?, ?)`,
      at(start),
      at(end),
    );
}

async function replan(db: Db, userId: string, now: number) {
  const writes: Write[] = [];
  await replanUser(
    { db, provider: () => fakeProvider(writes), now, baseUrl: "http://localhost" },
    userId,
  );
  // Later weeks get their own occurrences; only this week's writes count.
  return writes.filter((w) => w.start === undefined || w.start < at("2026-11-16T00:00:00"));
}

const occurrence = (db: Db) =>
  all<{ start_ms: number; end_ms: number }>(
    db,
    "SELECT start_ms, end_ms FROM managed_events WHERE key = ?",
    KEY,
  ).map((r) => [new Date(r.start_ms).toISOString(), new Date(r.end_ms).toISOString()]);

describe("a passed-date occurrence with no chosen time comes back (rules 29, 33)", () => {
  it("rule 29: after a delete in the calendar it is placed again on its event's day, not at the deleted slot", async () => {
    const { db, userId } = setup();
    event(db, userId, "2026-11-10T12:00:00", "2026-11-10T12:30:00", false);
    const now = at("2026-11-10T08:00:00");
    applyCalendarEdits(db, userId, ["cal"], "UTC", now);
    expect(occurrence(db)).toEqual([]);

    const writes = await replan(db, userId, now);
    const placed = occurrence(db);
    expect(placed).toHaveLength(1);
    const [start] = placed[0] as [string, string];
    expect(start.slice(0, 10)).toBe("2026-11-10");
    expect(start).not.toBe("2026-11-10T12:00:00.000Z");
    expect(writes.filter((w) => w.method === "insert")).toHaveLength(1);

    // A later run the same day keeps it (its event is now ahead).
    expect(await replan(db, userId, at("2026-11-10T09:00:00"))).toEqual([]);
    expect(occurrence(db)).toEqual(placed);
  });

  it("rule 33: in manual start mode a missed event is placed again later the same day", async () => {
    const { db, userId } = setup();
    updateSettings(db, userId, { startMode: "manual", manualSince: 0 });
    event(db, userId, "2026-11-10T09:00:00", "2026-11-10T09:30:00");
    const now = at("2026-11-10T10:00:00");

    const writes = await replan(db, userId, now);
    const placed = occurrence(db);
    expect(placed).toHaveLength(1);
    const [start] = placed[0] as [string, string];
    expect(start.slice(0, 10)).toBe("2026-11-10");
    expect(Date.parse(start)).toBeGreaterThanOrEqual(now);
    // The missed event moves (PRG-3); no second event is made.
    expect(writes.map((w) => w.method)).toEqual(["update"]);
  });

  it("a skipped occurrence stays gone after a delete", async () => {
    const { db, userId } = setup();
    run(db, "INSERT INTO dismissed_keys (user_id, key) VALUES (?, ?)", userId, KEY);
    event(db, userId, "2026-11-10T12:00:00", "2026-11-10T12:30:00", false);
    const now = at("2026-11-10T08:00:00");
    applyCalendarEdits(db, userId, ["cal"], "UTC", now);
    expect(await replan(db, userId, now)).toEqual([]);
    expect(occurrence(db)).toEqual([]);
  });
});

describe("clean-up of chosen times (habit_reschedules)", () => {
  it("a run removes only choices whose day passed and whose occurrence is gone or done", async () => {
    const { db, userId } = setup();
    const choose = (date: string, minute: number) =>
      run(
        db,
        "INSERT INTO habit_reschedules (user_id, habit_id, date, minute, not_before) VALUES (?, 'h', ?, ?, 0)",
        userId,
        date,
        minute,
      );
    choose("2026-10-26", 600); // an old week: gone
    choose("2026-11-02", 1440 + 600); // last week, chosen day Tuesday 11-03: gone
    choose(MONDAY, 2 * 1440 + 600); // this week, chosen day Wednesday: live
    choose("2026-10-19", 600); // an old date whose event the user moved to next week: live
    run(
      db,
      `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id,
         start_ms, end_ms, busy, title, locked) VALUES ('m2', ?, 'cal', 'ev2', 'habit:h:2026-10-19',
         'habit', 'h', ?, ?, 1, 'Lunch', 1)`,
      userId,
      at("2026-11-16T12:00:00"),
      at("2026-11-16T12:30:00"),
    );

    await replan(db, userId, at("2026-11-10T08:00:00"));
    expect(
      all(db, "SELECT date, minute FROM habit_reschedules ORDER BY date").map((r) => r),
    ).toEqual([
      { date: "2026-10-19", minute: 600 },
      { date: MONDAY, minute: 2 * 1440 + 600 },
    ]);
    // The live choice still places Monday's occurrence on Wednesday at 10:00.
    expect(occurrence(db)).toEqual([["2026-11-11T10:00:00.000Z", "2026-11-11T10:30:00.000Z"]]);
  });
});
