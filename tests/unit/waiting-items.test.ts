// Items whose calendar is on a disconnected account wait
// (docs/specs/accounts-login-emails-permissions.md rule 16): one plan run
// against an in-memory database and a fake provider that records writes.
//
// Ways it can fail:
// 1. A waiting item still takes planner time, so an item on a connected
//    calendar moves away from its ideal time for an event that is never written.
// 2. The main account is disconnected and items on the main calendar move to
//    an added account's calendar instead of waiting.
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { type Db, one, openDb, run } from "../../src/server/db.ts";
import { replanUser } from "../../src/server/planner/replan.ts";
import type {
  CalendarProvider,
  EventWrite,
  ProviderEvent,
} from "../../src/server/providers/types.ts";

const H = 3_600_000;
// Monday 2026-11-02, 06:00 UTC; work hours are 09:00-17:00 on weekdays.
const NOW = Date.UTC(2026, 10, 2, 6);
const TUE_9 = Date.UTC(2026, 10, 3, 9);

interface Write {
  account: string;
  calendar: string;
  event: EventWrite;
}

function fakeProvider(account: string, writes: Write[]): CalendarProvider {
  let n = 0;
  const fail = async (): Promise<never> => {
    throw new Error("not used");
  };
  return {
    listCalendars: fail,
    listEvents: fail,
    insertEvent: async (calendar: string, event: EventWrite) => {
      writes.push({ account, calendar, event });
      n++;
      const ev: ProviderEvent = {
        id: `${account}-${n}`,
        cancelled: false,
        etag: `"${n}"`,
        summary: event.summary,
        description: event.description,
        location: "",
        start: event.start,
        end: event.end,
        allDay: false,
        busy: event.busy,
        eventType: "default",
        selfResponse: null,
        attendeeCount: 0,
        attendees: [],
        organizerSelf: true,
        recurringId: null,
        colorId: null,
        updated: null,
        privateProps: event.privateProps ?? {},
        visibility: "default",
      };
      return ev;
    },
    updateEvent: fail,
    deleteEvent: fail,
    setColor: fail,
    editExternal: fail,
  } as unknown as CalendarProvider;
}

function setup(mainStatus: "ok" | "reauth_required", addedStatus: "ok" | "reauth_required") {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", NOW - 30 * 86_400_000);
  run(db, "UPDATE users SET time_zone = 'UTC', first_sign_in_at = ? WHERE id = ?", NOW, user.id);
  run(
    db,
    `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at, is_main, status)
     VALUES ('main', ?, 'caldav', 'a', 'owner@example.com', '', 0, 1, ?),
            ('added', ?, 'caldav', 'b', 'extra@example.com', '', 1, 0, ?)`,
    user.id,
    mainStatus,
    user.id,
    addedStatus,
  );
  run(
    db,
    `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability, writable)
     VALUES ('cal', 'main', 'cal', 'Work', 1, 1, 1), ('cal2', 'added', 'cal2', 'Work', 1, 1, 1)`,
  );
  return { db, userId: user.id };
}

function habit(db: Db, userId: string, id: string, level: number, calendarId: string | null) {
  const work = one<{ id: string }>(
    db,
    "SELECT id FROM hours_sets WHERE user_id = ? AND kind = 'work'",
    userId,
  );
  run(
    db,
    `INSERT INTO habits (id, user_id, title, level, hours_set_id, ideal_minute, min_minutes, max_minutes,
       frequency, defense, when_unplaceable, created_at, rules_changed_at, event_settings)
     VALUES (?, ?, ?, ?, ?, 540, 60, 60, '{"period":"daily"}', 'always-busy', 'remove', 0, 0, ?)`,
    id,
    userId,
    id,
    level,
    work?.id ?? "",
    JSON.stringify(calendarId ? { calendarId } : {}),
  );
}

async function plan(db: Db, userId: string) {
  const writes: Write[] = [];
  const result = await replanUser(
    {
      db,
      provider: (account) => fakeProvider(account, writes),
      now: NOW,
      baseUrl: "http://localhost",
    },
    userId,
  );
  return { writes, result };
}

describe("items of a disconnected account wait (accounts rule 16)", () => {
  it("a waiting habit takes no planner time from a habit on a connected calendar", async () => {
    const { db, userId } = setup("ok", "reauth_required");
    // Both want 09:00; the waiting one has the higher priority.
    habit(db, userId, "waiting", 1, "cal2");
    habit(db, userId, "own", 3, null);
    const { writes } = await plan(db, userId);
    expect(writes.filter((w) => w.account === "added")).toEqual([]);
    const own = writes.filter((w) => w.event.summary.includes("own"));
    expect(
      own.find((w) => w.event.start >= TUE_9 && w.event.start < TUE_9 + 24 * H)?.event.start,
    ).toBe(TUE_9);
    expect(writes.filter((w) => w.event.summary.includes("waiting"))).toEqual([]);
  });

  it("with the main account disconnected, items on the main calendar wait and do not move to an added account", async () => {
    const { db, userId } = setup("reauth_required", "ok");
    habit(db, userId, "own", 3, null);
    habit(db, userId, "theirs", 3, "cal2");
    const { writes, result } = await plan(db, userId);
    expect(result).not.toBeNull();
    expect(writes.filter((w) => w.event.summary.includes("own"))).toEqual([]);
    // Items on the connected added calendar still get their events.
    const theirs = writes.filter((w) => w.event.summary.includes("theirs"));
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.every((w) => w.account === "added")).toBe(true);
  });
});
