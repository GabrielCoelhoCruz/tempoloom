// The push never changes a managed event that has started (planning-scheduler.md
// SCH-60a). The one exception is a habit occurrence that the plan moves to a
// later start: only a snooze does that (habits-automation.md rule 31).
//
// Ways it can fail:
// 1. A started mirroring copy follows its source event to a later start: the
//    exception is not limited to habits.
// 2. A started habit occurrence that the plan moves later (a snooze) stays.
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { all, openDb, run } from "../../src/server/db.ts";
import { type DesiredEvent, pushSchedule } from "../../src/server/planner/push.ts";
import type { CalendarProvider, ProviderEvent } from "../../src/server/providers/types.ts";

const NOW = Date.parse("2026-11-09T12:05:00Z");
const MIN = 60_000;
const START = Date.parse("2026-11-09T12:00:00Z");

function setup(kind: "mirror" | "habit") {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", NOW);
  run(
    db,
    `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at)
     VALUES ('acc', ?, 'caldav', 'owner', 'owner@example.com', '', ?)`,
    user.id,
    NOW,
  );
  run(
    db,
    `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, writable)
     VALUES ('cal', 'acc', 'cal', 'Work', 1, 1)`,
  );
  const key = kind === "mirror" ? "mirror:p:e1" : "habit:h:2026-11-09";
  const source = kind === "mirror" ? "p" : "h";
  run(
    db,
    `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id,
       start_ms, end_ms, busy, title) VALUES ('m1', ?, 'cal', 'ev1', ?, ?, ?, ?, ?, 1, 'Busy')`,
    user.id,
    key,
    kind,
    source,
    START,
    START + 30 * MIN,
  );
  const calls: string[] = [];
  const provider = new Proxy({} as CalendarProvider, {
    get: (_t, name) => async (_cal: string, id: string, w: { start: number; end: number }) => {
      calls.push(String(name));
      return {
        id,
        cancelled: false,
        etag: "2",
        summary: "Busy",
        description: "",
        location: "",
        start: w.start,
        end: w.end,
        allDay: false,
        busy: true,
        eventType: "default",
        selfResponse: null,
        attendeeCount: 0,
        attendees: [],
        organizerSelf: true,
        recurringId: null,
        colorId: null,
        updated: null,
        privateProps: {},
        visibility: "default",
      } satisfies ProviderEvent;
    },
  });
  // The plan (or the copy's source) now starts 15 minutes later.
  const desired: DesiredEvent = {
    key,
    kind,
    sourceId: source,
    calendarId: "cal",
    start: START + 15 * MIN,
    end: START + 45 * MIN,
    title: "Busy",
    description: "",
    busy: true,
    colorId: null,
  };
  const push = () =>
    pushSchedule(
      { db, userId: user.id, now: NOW, target: (id) => ({ provider, providerCalendarId: id }) },
      [desired],
    );
  return { db, calls, push };
}

describe("a started event and a later start", () => {
  it("a started mirroring copy keeps its time (SCH-60a)", async () => {
    const { db, calls, push } = setup("mirror");
    await push();
    expect(calls).toEqual([]);
    expect(all(db, "SELECT start_ms FROM managed_events")).toEqual([{ start_ms: START }]);
  });

  it("a started habit occurrence moves to the later start (a snooze, rule 31)", async () => {
    const { db, calls, push } = setup("habit");
    await push();
    expect(calls).toEqual(["updateEvent"]);
    expect(all(db, "SELECT start_ms FROM managed_events")).toEqual([
      { start_ms: START + 15 * MIN },
    ]);
  });
});
