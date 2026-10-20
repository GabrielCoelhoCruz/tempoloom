// Bookings on a calendar of a disconnected account
// (docs/specs/accounts-login-emails-permissions.md rule 16): the check runs on
// the calendar the host's event actually goes to, before any write.
//
// Ways it can fail:
// 1. The check looks at the link owner's calendar, so a team link that a
//    connected member hosts is refused.
// 2. A member host's main account is disconnected and the event silently goes
//    to the member's other account.
// 3. A chosen calendar on a disconnected account falls back to the main one.
// 4. A reschedule or cancel of a booking on a disconnected calendar calls the
//    provider and fails with an auth error instead of the clear refusal.
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { type BookedEvent, writeBookingEvents } from "../../src/server/booking-team.ts";
import { type Db, openDb, run } from "../../src/server/db.ts";
import type {
  CalendarProvider,
  EventWrite,
  ProviderEvent,
} from "../../src/server/providers/types.ts";
import type { SyncService } from "../../src/server/sync/service.ts";

const NOW = Date.UTC(2026, 10, 2, 6);
const H = 3_600_000;

interface Call {
  method: string;
  account: string;
  calendar: string;
}

function setup(memberMain: "ok" | "reauth_required") {
  const db = openDb(":memory:");
  const owner = ensureUser(db, "owner@example.com", "Owner", NOW).id;
  const member = ensureUser(db, "member@example.com", "Member", NOW).id;
  const account = (id: string, user: string, email: string, main: number, status: string) =>
    run(
      db,
      `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at, is_main, status)
       VALUES (?, ?, 'caldav', ?, ?, '', ?, ?, ?)`,
      id,
      user,
      id,
      email,
      main ? 0 : 1,
      main,
      status,
    );
  const calendar = (id: string, accountId: string) =>
    run(
      db,
      `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability, writable)
       VALUES (?, ?, ?, 'Work', 1, 1, 1)`,
      id,
      accountId,
      id,
    );
  account("o-main", owner, "owner@example.com", 1, "ok");
  account("o-added", owner, "owner-extra@example.com", 0, "reauth_required");
  account("m-main", member, "member@example.com", 1, memberMain);
  account("m-added", member, "member-extra@example.com", 0, "ok");
  calendar("o-cal", "o-main");
  calendar("o-cal2", "o-added");
  calendar("m-cal", "m-main");
  calendar("m-cal2", "m-added");
  const calls: Call[] = [];
  const provider = (accountId: string): CalendarProvider =>
    ({
      insertEvent: async (calendar: string, e: EventWrite): Promise<ProviderEvent> => {
        calls.push({ method: "insert", account: accountId, calendar });
        return {
          id: `ev-${calls.length}`,
          cancelled: false,
          etag: null,
          summary: e.summary,
          description: e.description,
          location: "",
          start: e.start,
          end: e.end,
          allDay: false,
          busy: true,
          eventType: "default",
          selfResponse: null,
          attendeeCount: 1,
          attendees: [],
          organizerSelf: true,
          recurringId: null,
          colorId: null,
          updated: null,
          privateProps: e.privateProps ?? {},
          visibility: "default",
        };
      },
      updateEvent: async (calendar: string) => {
        calls.push({ method: "update", account: accountId, calendar });
        throw new Error("401 from the provider");
      },
      deleteEvent: async (calendar: string) => {
        calls.push({ method: "delete", account: accountId, calendar });
        throw new Error("401 from the provider");
      },
    }) as unknown as CalendarProvider;
  const sync = {
    pool: () => ({ get: (accountId: string) => provider(accountId) }),
    request: () => {},
  } as unknown as SyncService;
  return { db, owner, member, calls, sync };
}

const event = (calendarId: string | null): BookedEvent => ({
  summary: "Chat",
  description: "",
  start: NOW + 26 * H,
  end: NOW + 27 * H,
  location: "",
  bookerEmail: "ann@example.com",
  calendarId,
});

const book = (db: Db, sync: SyncService, hostId: string, calendarId: string | null) =>
  writeBookingEvents(db, sync, "bk", null, { hostId, parties: [], event: event(calendarId) });

describe("bookings and disconnected accounts (accounts rule 16)", () => {
  it("a connected member hosts a team booking while the owner's chosen calendar is disconnected", async () => {
    const { db, member, calls, sync } = setup("ok");
    // The route passes the link's calendar only when the owner hosts.
    const placed = await book(db, sync, member, null);
    expect(placed?.calendarId).toBe("m-cal");
    expect(calls).toEqual([{ method: "insert", account: "m-main", calendar: "m-cal" }]);
  });

  it("a member host whose main account is disconnected gets the refusal; no event goes to another calendar", async () => {
    const { db, member, calls, sync } = setup("reauth_required");
    await expect(book(db, sync, member, null)).rejects.toThrow("calendar_disconnected");
    expect(calls).toEqual([]);
  });

  it("an owner host whose chosen calendar is disconnected gets the refusal, not the main calendar", async () => {
    const { db, owner, calls, sync } = setup("ok");
    await expect(book(db, sync, owner, "o-cal2")).rejects.toThrow("calendar_disconnected");
    expect(calls).toEqual([]);
  });

  it("a reschedule or cancel of a booking on a disconnected calendar gets the refusal before any provider call", async () => {
    const { db, owner, calls, sync } = setup("ok");
    const prev = { hostId: owner, calendarId: "o-cal2", eventId: "e1" };
    await expect(
      writeBookingEvents(db, sync, "bk", prev, {
        hostId: owner,
        parties: [],
        event: event("o-cal2"),
      }),
    ).rejects.toThrow("calendar_disconnected");
    await expect(writeBookingEvents(db, sync, "bk", prev, null)).rejects.toThrow(
      "calendar_disconnected",
    );
    expect(calls).toEqual([]);
  });
});
