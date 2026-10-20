// Writes to a meeting occurrence after its creation
// (docs/specs/meetings-flexible-rescheduling.md rules 21-23).
//
// Ways it can fail:
// 1. A move, a guest change or a visibility change in the meeting settings
//    rewrites the whole occurrence, so the organizer's calendar edits of
//    description, location, color, note and guests go.
// 2. A guest removal in Tempoloom also removes the guests the organizer added.
// 3. A description edit in the calendar is written over by the next plan run.
// 4. Free/busy or privacy drift is written back as a whole event.
// 5. After migration 34 each occurrence gets a write it does not need.
// 6. An instance of an adopted series gets a whole write.
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { type Db, openDb, run } from "../../src/server/db.ts";
import { type DesiredEvent, pushSchedule } from "../../src/server/planner/push.ts";
import type { CalendarProvider, ProviderEvent } from "../../src/server/providers/types.ts";
import { cacheEvent } from "../../src/server/sync/pull.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z");
const HOUR = 3_600_000;
const START = T0 + 26 * HOUR;
const EXTRA = {
  location: "",
  attendees: ["dana@example.com", "bob@example.com"],
  optional: [],
  organizer: "owner@example.com",
  visibility: "private",
};

function setup(eventId = "occ-1") {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", T0);
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
    `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id,
       start_ms, end_ms, busy, title, description, extra)
     VALUES ('m1', ?, 'cal', ?, 'meeting:r:1', 'meeting', 'r', ?, ?, 1, 'Review', 'Agenda', ?)`,
    user.id,
    eventId,
    START,
    START + HOUR / 2,
    JSON.stringify(EXTRA),
  );
  const calls: { name: string; args: unknown[] }[] = [];
  const provider = new Proxy({} as CalendarProvider, {
    get:
      (_t, name) =>
      async (...args: unknown[]) => {
        calls.push({ name: String(name), args });
        return calendarCopy(eventId, {});
      },
  });
  return { db, userId: user.id, calls, provider, eventId };
}

/** The organizer's copy in the calendar, as the last read gave it. */
const calendarCopy = (id: string, edit: Partial<ProviderEvent>): ProviderEvent => ({
  id,
  cancelled: false,
  etag: '"1"',
  summary: "Review",
  description: "Agenda",
  location: "",
  start: START,
  end: START + HOUR / 2,
  allDay: false,
  busy: true,
  eventType: "default",
  selfResponse: null,
  attendeeCount: 2,
  attendees: ["dana@example.com", "bob@example.com"],
  organizerSelf: true,
  recurringId: null,
  colorId: null,
  updated: null,
  privateProps: { tl: "1" },
  visibility: "private",
  ...edit,
});

const desired = (edit: Partial<DesiredEvent> = {}): DesiredEvent => ({
  key: "meeting:r:1",
  kind: "meeting",
  sourceId: "r",
  calendarId: "cal",
  start: START,
  end: START + HOUR / 2,
  title: "Review",
  description: "Agenda",
  busy: true,
  colorId: null,
  attendees: ["dana@example.com", "bob@example.com"],
  optionalAttendees: [],
  organizer: "owner@example.com",
  visibility: "private",
  ...edit,
});

async function push(
  s: ReturnType<typeof setup>,
  d: DesiredEvent,
  copy?: Partial<ProviderEvent>,
): Promise<{ name: string; change: unknown }[]> {
  if (copy) cacheEvent(s.db, "cal", calendarCopy(s.eventId, copy));
  await pushSchedule(
    {
      db: s.db as Db,
      userId: s.userId,
      now: T0,
      target: () => ({ provider: s.provider, providerCalendarId: "cal" }),
    },
    [d],
  );
  return s.calls.map((c) => ({ name: c.name, change: c.args[2] }));
}

describe("a meeting occurrence after its creation", () => {
  it("moves with its time alone (rules 22, 37)", async () => {
    const s = setup();
    const calls = await push(s, desired({ start: START + HOUR, end: START + 1.5 * HOUR }), {});
    expect(calls).toEqual([
      { name: "editExternal", change: { start: START + HOUR, end: START + 1.5 * HOUR } },
    ]);
  });

  it("loses only the guest removed in Tempoloom", async () => {
    const s = setup();
    const calls = await push(s, desired({ attendees: ["dana@example.com"] }), {});
    expect(calls).toEqual([
      { name: "editExternal", change: { guests: { add: [], remove: ["bob@example.com"] } } },
    ]);
  });

  it("gets a visibility change of the meeting settings alone", async () => {
    const s = setup();
    const calls = await push(s, desired({ visibility: "public" }), {});
    expect(calls).toEqual([{ name: "editExternal", change: { visibility: "public" } }]);
  });

  it("keeps the organizer's description: no write (rule 22)", async () => {
    const s = setup();
    expect(await push(s, desired(), { description: "Bring the Q3 numbers" })).toEqual([]);
  });

  it("gets a form description edit (rule 23)", async () => {
    const s = setup();
    const calls = await push(s, desired({ description: "Agenda v2" }), {
      description: "Bring the Q3 numbers",
    });
    expect(calls).toEqual([{ name: "editExternal", change: { description: "Agenda v2" } }]);
  });

  it("gets its free/busy and privacy back, and nothing else (rule 22)", async () => {
    const s = setup();
    const calls = await push(s, desired(), {
      busy: false,
      visibility: "public",
      description: "Bring the Q3 numbers",
      location: "Room 9",
    });
    expect(calls).toEqual([
      { name: "editExternal", change: { busy: true, visibility: "private" } },
    ]);
  });

  it("gets no write when its privacy was not read since migration 34", async () => {
    const s = setup();
    run(
      s.db,
      `INSERT INTO events (calendar_id, event_id, summary, description, start_ms, end_ms, busy, etag)
       VALUES ('cal', ?, 'Review', 'Agenda', ?, ?, 1, '"1"')`,
      s.eventId,
      START,
      START + HOUR / 2,
    );
    expect(await push(s, desired())).toEqual([]);
  });

  it("as an instance of an adopted series, also gets a change of its fields alone", async () => {
    const s = setup("/cal/series.ics#20261020T100000Z");
    const calls = await push(s, desired(), { busy: false });
    expect(calls).toEqual([{ name: "editExternal", change: { busy: true } }]);
  });
});
