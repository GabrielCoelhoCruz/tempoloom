// Moving a booking whose event is on an account Tempoloom cannot reach
// (docs/specs/accounts-connected-calendars.md rules 19, 22).
//
// Ways it can fail:
// 1. The account is disconnected: the move writes a new event elsewhere and
//    leaves the old one on the provider calendar, so after reconnect the booking
//    shows twice (and the booker keeps the old invitation).
// 2. The account was removed: the move fails, so the booker cannot move it.
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { writeBookingEvents } from "../../src/server/booking-team.ts";
import { openDb, run } from "../../src/server/db.ts";
import type { EventWrite, ProviderEvent } from "../../src/server/providers/types.ts";
import type { SyncService } from "../../src/server/sync/service.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z");
const HOUR = 3_600_000;

const stored = (id: string, w: EventWrite): ProviderEvent => ({
  id,
  cancelled: false,
  etag: '"1"',
  summary: w.summary,
  description: w.description,
  location: "",
  start: w.start,
  end: w.end,
  allDay: false,
  busy: true,
  eventType: "default",
  selfResponse: null,
  attendeeCount: 1,
  attendees: ["bob@example.com"],
  organizerSelf: true,
  recurringId: null,
  colorId: null,
  updated: null,
  privateProps: {},
  visibility: "default",
});

function setup(sideStatus: "ok" | "reauth_required" | "removed") {
  const db = openDb(":memory:");
  const owner = ensureUser(db, "owner@acme.example", "Owner", T0);
  const account = (id: string, email: string, main: number, status: string) => {
    run(
      db,
      `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, status, created_at, is_main)
       VALUES (?, ?, 'caldav', ?, ?, '', ?, ?, ?)`,
      id,
      owner.id,
      id,
      email,
      status,
      T0,
      main,
    );
    run(
      db,
      `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability, writable)
       VALUES (?, ?, ?, 'Work', 1, 1, 1)`,
      `cal-${id}`,
      id,
      `cal-${id}`,
    );
  };
  account("main", "owner@acme.example", 1, "ok");
  if (sideStatus !== "removed") account("side", "owner@side.example", 0, sideStatus);
  const calls: string[] = [];
  const provider = {
    insertEvent: async (cal: string, w: EventWrite) => {
      calls.push(`insert ${cal}`);
      return stored("new-ev", w);
    },
    updateEvent: async (cal: string, id: string, w: EventWrite) => {
      calls.push(`update ${cal} ${id}`);
      return stored(id, w);
    },
    deleteEvent: async (cal: string, id: string) => {
      calls.push(`delete ${cal} ${id}`);
    },
  };
  const sync = { pool: () => ({ get: () => provider }), request() {} } as unknown as SyncService;
  const move = () =>
    writeBookingEvents(
      db,
      sync,
      "b1",
      { hostId: owner.id, calendarId: "cal-side", eventId: "old-ev" },
      {
        hostId: owner.id,
        parties: [],
        event: {
          summary: "Consult with Bob",
          description: "",
          start: T0 + 26 * HOUR,
          end: T0 + 26.5 * HOUR,
          location: "",
          bookerEmail: "bob@example.com",
          calendarId: sideStatus === "removed" ? "cal-side" : null,
        },
      },
      () => undefined,
    );
  return { calls, move };
}

describe("moving a booking whose account is lost", () => {
  it("refuses while the account is disconnected and writes nothing, so no second event appears after reconnect", async () => {
    const { calls, move } = setup("reauth_required");
    await expect(move()).rejects.toThrow("account_disconnected");
    expect(calls).toEqual([]);
  });

  it("moves to a new event on the main calendar when the account was removed", async () => {
    const { calls, move } = setup("removed");
    await expect(move()).resolves.toEqual({ calendarId: "cal-main", eventId: "new-ev" });
    expect(calls).toEqual(["insert cal-main"]);
  });

  it("updates the event in place when the account works", async () => {
    const { calls, move } = setup("ok");
    await expect(move()).resolves.toEqual({ calendarId: "cal-side", eventId: "old-ev" });
    expect(calls).toEqual(["update cal-side old-ev"]);
  });
});
