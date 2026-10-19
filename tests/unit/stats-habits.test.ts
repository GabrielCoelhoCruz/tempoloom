// Habit progress on the stats page (analytics-personal-stats.md; habits
// analytics). The E2E test covers the page; these cover the clock and the
// events that a week of E2E data does not hold.
//
// Ways it can fail:
// 1. "Done" uses the wall clock instead of the clock the server was given.
// 2. A block of logged work counts as an occurrence.
// 3. A deleted habit's past occurrences vanish from the stats.
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { computeStats } from "../../src/server/api/stats.ts";
import { one, openDb, run } from "../../src/server/db.ts";

const HOUR = 3_600_000;
// A week far from the wall clock, so a test that reads Date.now() fails.
const MON = Date.parse("2031-03-03T00:00:00Z");

function setup() {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", MON - 30 * 24 * HOUR);
  run(db, "UPDATE users SET time_zone = 'UTC' WHERE id = ?", user.id);
  run(
    db,
    `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at, is_main)
     VALUES ('acc', ?, 'caldav', 'dav-1', 'owner@example.com', '', 0, 1)`,
    user.id,
  );
  run(
    db,
    `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability)
     VALUES ('cal', 'acc', '/cal/', 'Main', 1, 1)`,
  );
  const hours =
    one<{ id: string }>(
      db,
      "SELECT id FROM hours_sets WHERE user_id = ? AND kind = 'work'",
      user.id,
    )?.id ?? "";
  const habit = (id: string, title: string) =>
    run(
      db,
      `INSERT INTO habits (id, user_id, title, level, hours_set_id, ideal_minute, min_minutes, max_minutes,
         frequency, defense, when_unplaceable, created_at, rules_changed_at)
       VALUES (?, ?, ?, 3, ?, 720, 60, 60, '{"period":"daily"}', 'adaptive', 'remove', 0, 0)`,
      id,
      user.id,
      title,
      hours,
    );
  const event = (key: string, sourceId: string, title: string, start: number, minutes: number) =>
    run(
      db,
      `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id, start_ms, end_ms,
         busy, title) VALUES (?, ?, 'cal', ?, ?, 'habit', ?, ?, ?, 1, ?)`,
      key,
      user.id,
      key,
      key,
      sourceId,
      start,
      start + minutes * 60_000,
      title,
    );
  return { db, user, habit, event };
}

describe("habit progress", () => {
  it("counts done occurrences by the given clock, not logged work, and keeps deleted habits", () => {
    const { db, user, habit, event } = setup();
    habit("lunch", "Lunch");
    // Monday to Wednesday at noon; the clock is Tuesday 18:00.
    for (let d = 0; d < 3; d++)
      event(`habit:lunch:${d}`, "lunch", "Lunch", MON + d * 24 * HOUR + 12 * HOUR, 60);
    // Thirty minutes of logged work on Monday evening.
    event("habit:lunch:log-1a2b3c4d", "lunch", "Lunch", MON + 18 * HOUR, 30);
    // A habit deleted after its Monday occurrence: the row stays, the habit is gone.
    event("habit:gone:0", "gone", "✅ Stretch", MON + 9 * HOUR, 30);

    const now = MON + 24 * HOUR + 18 * HOUR;
    const stats = computeStats(db, user.id, "2031-03-03", "2031-03-09", now);
    expect(stats.habits).toEqual([
      { id: "lunch", title: "Lunch", events: 3, done: 2, minutes: 210 },
      { id: "gone", title: "Stretch", events: 1, done: 1, minutes: 30 },
    ]);
  });
});
