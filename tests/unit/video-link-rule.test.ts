// One video link rule for the video_link meeting check
// (automations-meeting-quality.md) and the video-only buffer filter
// (buffers-automation.md has_video_link), and the conference data of the
// events that the server builds itself (mirror copies, booking holds).
// Failure modes, each covered below:
//  1. The meeting check and the buffer filter disagree on one event.
//  2. A mirror copy whose only video link is its conference data, or a booking
//     hold with a video link location, is not a video-only anchor.
import { describe, expect, it } from "vitest";
import { bufferAnchors } from "../../src/scheduler/plan.ts";
import { ensureUser } from "../../src/server/accounts.ts";
import { type Db, openDb, run } from "../../src/server/db.ts";
import { evaluate } from "../../src/server/meeting-checks.ts";
import { externalEvents } from "../../src/server/planner/events.ts";
import { copyAnchors } from "../../src/server/planner/replan.ts";

const NOW = Date.parse("2026-11-02T08:00:00Z");
const HOUR = 3_600_000;
const TO = NOW + 6 * 24 * HOUR;
const video = { filter: { videoLink: true }, calendarScope: null };

function setup(): { db: Db; userId: string } {
  const db = openDb(":memory:");
  const user = ensureUser(db, "o@example.com", "O", 0);
  run(
    db,
    `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at)
     VALUES ('acc', ?, 'caldav', 'x', 'o@example.com', '{}', 0)`,
    user.id,
  );
  for (const [id, check] of [
    ["cal", 1],
    ["dest", 0],
  ] as const)
    run(
      db,
      `INSERT INTO calendars (id, account_id, provider_id, name, writable, check_availability)
       VALUES (?, 'acc', ?, ?, 1, ?)`,
      id,
      id,
      id,
      check,
    );
  return { db, userId: user.id };
}

/** A meeting the user organizes with one guest, n hours after NOW. */
function meeting(
  db: Db,
  calendarId: string,
  n: number,
  title: string,
  e: { conference?: string; location?: string; description?: string },
) {
  run(
    db,
    `INSERT INTO events (calendar_id, event_id, summary, description, location, conference, start_ms, end_ms,
       busy, organizer_self, attendee_count, attendees)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 2, '["o@example.com","dana@example.com"]')`,
    calendarId,
    title,
    title,
    e.description ?? "",
    e.location ?? "",
    e.conference ?? "",
    NOW + n * HOUR,
    NOW + n * HOUR + HOUR,
  );
}

describe("the video link rule", () => {
  it("the meeting check and the video-only buffer filter agree on each event", () => {
    const { db, userId } = setup();
    meeting(db, "cal", 2, "Conference", { conference: "https://example.com/c/1" });
    meeting(db, "cal", 4, "Location", { location: "https://zoom.us/j/1" });
    meeting(db, "cal", 6, "Description", { description: "Join https://meet.jit.si/x" });
    meeting(db, "cal", 8, "None", {
      location: "Room 4",
      description: "Notes: https://docs.example.com/a",
    });
    const missing = evaluate(db, userId, NOW, TO)
      .filter((i) => i.checkId === "video_link")
      .map((i) => i.title);
    const anchors = bufferAnchors(externalEvents(db, userId, NOW, TO), [], video, NOW, TO).map(
      (e) => e.title,
    );
    expect(anchors).toEqual(["Conference", "Location", "Description"]);
    expect(missing).toEqual(["None"]);
  });

  it("a mirror copy with conference data and a booking hold with a video location are video anchors", () => {
    const { db, userId } = setup();
    run(db, "PRAGMA foreign_keys = OFF");
    meeting(db, "dest", 2, "Copy", { conference: "https://example.com/c/2" });
    meeting(db, "dest", 4, "Plain copy", {});
    run(
      db,
      `INSERT INTO mirror_policies (id, user_id, source_calendar_id, dest_calendar_id, calendar_type, visibility,
         all_day_mode, created_at) VALUES ('pol', ?, 'cal', 'dest', 'business', 'label_only', 'none', 0)`,
      userId,
    );
    for (const [n, title] of [
      [2, "Copy"],
      [4, "Plain copy"],
    ] as const)
      run(
        db,
        `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id, start_ms, end_ms,
           busy, title) VALUES (?, ?, 'dest', ?, ?, 'mirror', 'pol', ?, ?, 1, ?)`,
        title,
        userId,
        title,
        `mirror:${title}`,
        NOW + n * HOUR,
        NOW + n * HOUR + HOUR,
        title,
      );
    for (const [id, n, location] of [
      ["b1", 6, "https://zoom.us/j/2"],
      ["b2", 8, "Main St 1, Berlin, Germany"],
    ] as const) {
      run(
        db,
        `INSERT INTO bookings (id, user_id, start_ms, end_ms, name, email, token_hash, status, created_at,
           updated_at, location) VALUES (?, ?, ?, ?, ?, 'g@example.com', ?, 'booked', 0, 0, ?)`,
        id,
        userId,
        NOW + n * HOUR,
        NOW + n * HOUR + HOUR,
        id,
        id,
        location,
      );
      run(db, "INSERT INTO booking_participants (booking_id, user_id) VALUES (?, ?)", id, userId);
    }
    const anchors = bufferAnchors(
      externalEvents(db, userId, NOW, TO),
      copyAnchors(db, userId, NOW),
      video,
      NOW,
      TO,
    ).map((e) => e.title);
    expect(anchors).toEqual(["Copy", "Booking with b1"]);
  });
});
