// Tags in the user's own RSVP note (docs/specs/events-tags.md "Where Tempoloom
// looks"), read from the cached event row. The type of hasTag now makes every
// caller pass the note; mirroring is the one checked here.
//
// Ways it can fail:
// 1. Mirroring reads the title and the description only, so #tl_nosync in the
//    RSVP note still gets a copy, and #tl_trip in the note does not make the
//    copy's label Travel.
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { openDb, run } from "../../src/server/db.ts";
import { mirrorCopies } from "../../src/server/planner/mirror.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z");
const HOUR = 3_600_000;

function setup() {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", T0);
  run(
    db,
    `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at, is_main)
     VALUES ('acc', ?, 'caldav', 'owner', 'owner@example.com', '', ?, 1)`,
    user.id,
    T0,
  );
  for (const [id, primary] of [
    ["src", 1],
    ["dst", 0],
  ] as const)
    run(
      db,
      `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability)
       VALUES (?, 'acc', ?, ?, ?, 1)`,
      id,
      `/cal/${id}/`,
      id,
      primary,
    );
  run(
    db,
    `INSERT INTO mirror_policies (id, user_id, source_calendar_id, dest_calendar_id, calendar_type,
       visibility, all_day_mode, created_at) VALUES ('p', ?, 'src', 'dst', 'business', 'label_only', 'none', ?)`,
    user.id,
    T0,
  );
  const invitation = (id: string, note: string) =>
    run(
      db,
      `INSERT INTO events (calendar_id, event_id, summary, start_ms, end_ms, busy, self_response,
         organizer_self, attendee_count, attendees, rsvp_note)
       VALUES ('src', ?, 'Planning', ?, ?, 1, 'accepted', 0, 2, ?, ?)`,
      id,
      T0 + 24 * HOUR,
      T0 + 25 * HOUR,
      JSON.stringify(["boss@example.com", "owner@example.com"]),
      note,
    );
  return { db, user, invitation };
}

describe("tags in the RSVP note", () => {
  it("mirroring skips an invitation with #tl_nosync in the user's note", () => {
    const { db, user, invitation } = setup();
    invitation("a", "Will join #tl_nosync");
    invitation("b", "Will join");
    const copies = mirrorCopies(db, user.id, "UTC", T0, null);
    expect(copies.map((c) => c.key)).toEqual(["mirror:p:b"]);
  });

  it("a copy's label follows #tl_trip in the user's note", () => {
    const { db, user, invitation } = setup();
    invitation("a", "On the road #tl_trip");
    const copies = mirrorCopies(db, user.id, "UTC", T0, null);
    expect(copies.map((c) => c.title)).toEqual(["Travel"]);
  });
});
