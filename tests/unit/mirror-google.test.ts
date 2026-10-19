// Mirroring and calendar-list rules that only Google calendars can show, so
// the CalDAV E2E suite cannot reach them (docs/specs/sync-calendar-mirroring.md
// rules 17, 21.1; accounts-connected-calendars.md rule 4).
//
// Ways it can fail:
// 1. An event that Gmail made from an email (free on the source) gets no copy,
//    or a free copy, under a label-only policy.
// 2. An event that invites a Google secondary calendar by its calendar id gets
//    a copy on that calendar.
// 3. Google's holiday and birthday calendars are offered as calendars.
// 4. A calendar with free/busy-only or read-only access counts as writable.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { openDb, run } from "../../src/server/db.ts";
import type { GoogleCalendarApi } from "../../src/server/google/calendar.ts";
import { mirrorCopies } from "../../src/server/planner/mirror.ts";
import { GoogleProvider } from "../../src/server/providers/google.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z");
const HOUR = 3_600_000;

function setup() {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", T0);
  run(
    db,
    `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at, is_main)
     VALUES ('acc', ?, 'google', 'sub-1', 'owner@example.com', '', ?, 1)`,
    user.id,
    T0,
  );
  const calendar = (id: string, providerId: string, primary: number) =>
    run(
      db,
      `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability)
       VALUES (?, 'acc', ?, ?, ?, 1)`,
      id,
      providerId,
      id,
      primary,
    );
  calendar("src", "owner@example.com", 1);
  calendar("dst", "travel123@group.calendar.google.com", 0);
  run(
    db,
    `INSERT INTO mirror_policies (id, user_id, source_calendar_id, dest_calendar_id, calendar_type,
       visibility, all_day_mode, created_at) VALUES ('p', ?, 'src', 'dst', 'personal', 'label_only', 'none', ?)`,
    user.id,
    T0,
  );
  const event = (title: string, e: { busy: number; eventType?: string; attendees?: string[] }) =>
    run(
      db,
      `INSERT INTO events (calendar_id, event_id, summary, start_ms, end_ms, busy, event_type,
         attendee_count, attendees) VALUES ('src', ?, ?, ?, ?, ?, ?, ?, ?)`,
      randomUUID(),
      title,
      T0 + 24 * HOUR,
      T0 + 25 * HOUR,
      e.busy,
      e.eventType ?? "default",
      e.attendees?.length ?? 0,
      JSON.stringify(e.attendees ?? []),
    );
  return { db, user, event };
}

describe("mirroring of Google-only events", () => {
  it("copies an event that Gmail made from an email as busy, also when it is free (rule 21.1)", () => {
    const { db, user, event } = setup();
    event("Flight to Lisbon", { busy: 0, eventType: "fromGmail" });
    event("Free lunch", { busy: 0 });
    const copies = mirrorCopies(db, user.id, "UTC", T0, null);
    expect(copies.map((c) => [c.title, c.busy])).toEqual([["Personal commitment", true]]);
  });

  it("skips an event that invites the destination calendar by its id (rule 17)", () => {
    const { db, user, event } = setup();
    event("Trip planning", {
      busy: 1,
      attendees: ["owner@example.com", "travel123@group.calendar.google.com"],
    });
    event("Dentist", { busy: 1 });
    expect(mirrorCopies(db, user.id, "UTC", T0, null)).toHaveLength(1);
  });
});

describe("Google calendar list", () => {
  it("leaves out Google's holiday and birthday calendars and marks read-only ones (rule 4)", async () => {
    const api = {
      listCalendars: async () => [
        { id: "owner@example.com", summary: "Owner", primary: true, accessRole: "owner" },
        { id: "team@group.calendar.google.com", summary: "Team", accessRole: "writer" },
        { id: "boss@example.com", summary: "Boss", accessRole: "freeBusyReader" },
        {
          id: "en.usa#holiday@group.v.calendar.google.com",
          summary: "Holidays in United States",
          accessRole: "reader",
        },
        {
          id: "addressbook#contacts@group.v.calendar.google.com",
          summary: "Birthdays",
          accessRole: "reader",
        },
      ],
    } as unknown as GoogleCalendarApi;
    const list = await new GoogleProvider(api, "UTC").listCalendars();
    expect(list.map((c) => [c.name, c.writable])).toEqual([
      ["Owner", true],
      ["Team", true],
      ["Boss", false],
    ]);
  });
});
