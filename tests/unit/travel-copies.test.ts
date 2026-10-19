// Copies of travel buffers on mirrored calendars (docs/specs/buffers-travel.md
// outputs; sync-calendar-mirroring.md rules 15, 27).
//
// Ways it can fail:
// 1. The copies come from the calendar cache, so a new travel buffer gets its
//    copy only one run later, after the next read of the calendar.
// 2. Other managed events (here: a buffer that is not a travel buffer) are
//    copied too.
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { openDb, run } from "../../src/server/db.ts";
import { replanUser } from "../../src/server/planner/replan.ts";
import type {
  CalendarProvider,
  EventWrite,
  ProviderEvent,
} from "../../src/server/providers/types.ts";

const NOW = Date.parse("2026-10-19T06:00:00Z");
const HOUR = 3_600_000;
const VISIT = Date.parse("2026-10-20T14:00:00Z");

/** A calendar that keeps what Tempoloom writes, by calendar. */
function fakeCalendar() {
  const written: { calendar: string; summary: string; start: number; end: number }[] = [];
  let n = 0;
  const toEvent = (id: string, w: EventWrite): ProviderEvent => ({
    id,
    cancelled: false,
    etag: `"${++n}"`,
    summary: w.summary,
    description: w.description,
    location: w.location ?? "",
    start: w.start,
    end: w.end,
    allDay: false,
    busy: w.busy,
    eventType: "default",
    selfResponse: null,
    attendeeCount: 0,
    attendees: [],
    organizerSelf: true,
    recurringId: null,
    colorId: w.colorId,
    updated: null,
    privateProps: w.privateProps,
  });
  const provider = {
    insertEvent: async (calendar: string, w: EventWrite) => {
      written.push({ calendar, summary: w.summary, start: w.start, end: w.end });
      return toEvent(`e${n}`, w);
    },
    updateEvent: async (_c: string, id: string, w: EventWrite) => toEvent(id, w),
    deleteEvent: async () => {},
  } as unknown as CalendarProvider;
  return { provider, written };
}

function setup() {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", NOW - 86_400_000);
  run(db, "UPDATE users SET first_sign_in_at = ? WHERE id = ?", NOW, user.id);
  run(
    db,
    `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at, is_main)
     VALUES ('acc', ?, 'caldav', 'owner', 'owner@example.com', '', ?, 1)`,
    user.id,
    NOW,
  );
  for (const [id, primary] of [
    ["work", 1],
    ["labels", 0],
  ] as const)
    run(
      db,
      `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability, writable)
       VALUES (?, 'acc', ?, ?, ?, ?, 1)`,
      id,
      id,
      id,
      primary,
      primary,
    );
  run(
    db,
    `INSERT INTO mirror_policies (id, user_id, source_calendar_id, dest_calendar_id, calendar_type,
       visibility, all_day_mode, created_at) VALUES ('p', ?, 'work', 'labels', 'business', 'label_only', 'none', ?)`,
    user.id,
    NOW,
  );
  const buffer = (id: string, title: string, filter: object) =>
    run(
      db,
      `INSERT INTO buffers (id, user_id, title, level, side, minutes_before, minutes_after, filter,
         on_conflict, created_at, rules_changed_at)
       VALUES (?, ?, ?, 2, 'both', 30, 30, ?, 'remove', ?, ?)`,
      id,
      user.id,
      title,
      JSON.stringify(filter),
      NOW,
      NOW,
    );
  buffer("travel", "Travel", { travel: true });
  buffer("decompress", "Decompress", { categories: ["team_meeting"] });
  run(
    db,
    `INSERT INTO events (calendar_id, event_id, summary, location, start_ms, end_ms, attendee_count,
       attendees, organizer_self, self_response)
     VALUES ('work', 'visit', 'Client visit', '1 Oak Ave, Springfield, IL 62701', ?, ?, 2, ?, 1, NULL)`,
    VISIT,
    VISIT + HOUR,
    JSON.stringify(["owner@example.com", "client@other.com"]),
  );
  run(
    db,
    `INSERT INTO events (calendar_id, event_id, summary, start_ms, end_ms, attendee_count,
       attendees, organizer_self, self_response)
     VALUES ('work', 'standup', 'Standup', ?, ?, 3, ?, 1, NULL)`,
    VISIT + 24 * HOUR - 4 * HOUR,
    VISIT + 24 * HOUR - 3 * HOUR,
    JSON.stringify(["owner@example.com", "a@example.com", "b@example.com"]),
  );
  return { db, userId: user.id };
}

describe("copies of travel buffers", () => {
  it("are written in the same run as the buffers, and other buffers get no copy", async () => {
    const { db, userId } = setup();
    const cal = fakeCalendar();
    await replanUser(
      { db, provider: () => cal.provider, now: NOW, baseUrl: "http://localhost" },
      userId,
    );
    const on = (c: string) =>
      cal.written
        .filter((w) => w.calendar === c)
        .map((w) => `${w.summary} ${new Date(w.start).toISOString().slice(11, 16)}`)
        .sort();
    expect(on("work")).toEqual(
      ["Decompress 09:30", "Decompress 11:00", "🚌 Travel 13:30", "🚌 Travel 15:00"].sort(),
    );
    expect(on("labels")).toEqual(
      ["Meeting 10:00", "Meeting 14:00", "Travel 13:30", "Travel 15:00"].sort(),
    );
  });
});
