// A past task chunk that leaves the synced event window is not a delete
// (docs/specs/planning-calendar-edits.md CED-21, CED-22).
//
// Ways it can fail:
// 1. A stale pull reads the window again from now - 84 days and drops older
//    events; the edit pass reads the missing chunk as a delete and reopens a
//    task the user finished months ago (and gives its minutes back).
// 2. The guard is too wide, so a real delete of a past chunk in the window
//    no longer reopens the task.
// (What happens to the managed row of an aged-out chunk is not checked here.)
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { type Db, one, openDb, run } from "../../src/server/db.ts";
import type { CalendarProvider } from "../../src/server/providers/types.ts";
import { applyCalendarEdits } from "../../src/server/sync/edits.ts";
import { pullEvents } from "../../src/server/sync/pull.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 2, 12);

function setup(): { db: Db; userId: string; chunk: (id: string, daysAgo: number) => void } {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", NOW - 400 * DAY);
  run(
    db,
    `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at, is_main)
     VALUES ('acc', ?, 'caldav', 'x', 'owner@example.com', '', 0, 1)`,
    user.id,
  );
  // The last full read was 31 days ago, so this pull is stale and reads all again.
  run(
    db,
    `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability, writable,
       sync_token, window_start, window_end)
     VALUES ('cal', 'acc', 'cal', 'Work', 1, 1, 1, 'tok', ?, ?)`,
    NOW - 31 * DAY - 84 * DAY,
    NOW - 31 * DAY + 120 * DAY,
  );
  run(
    db,
    "INSERT INTO hours_sets (id, user_id, kind, name, weekly, created_at) VALUES ('h', ?, 'work', 'Work', '{}', 0)",
    user.id,
  );
  const chunk = (id: string, daysAgo: number) => {
    const start = NOW - daysAgo * DAY;
    run(
      db,
      `INSERT INTO tasks (id, user_id, title, level, total_minutes, min_chunk_minutes, max_chunk_minutes,
         start_after, hours_set_id, status, created_at, rules_changed_at)
       VALUES (?, ?, ?, 2, 60, 60, 60, 0, 'h', 'done', 0, 0)`,
      id,
      user.id,
      id,
    );
    run(
      db,
      `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id, start_ms, end_ms, busy, title)
       VALUES (?, ?, 'cal', ?, ?, 'task', ?, ?, ?, 1, ?)`,
      id,
      user.id,
      `ev-${id}`,
      `task:${id}`,
      id,
      start,
      start + 3_600_000,
      id,
    );
    // Cached by the earlier read.
    run(
      db,
      "INSERT INTO events (calendar_id, event_id, summary, start_ms, end_ms) VALUES ('cal', ?, ?, ?, ?)",
      `ev-${id}`,
      id,
      start,
      start + 3_600_000,
    );
  };
  return { db, userId: user.id, chunk };
}

/** The calendar holds no event in the new window: the old chunk aged out, the recent one was deleted. */
const empty = {
  listEvents: async () => ({ events: [], nextSyncToken: "tok2", full: true }),
} as unknown as CalendarProvider;

const status = (db: Db, id: string) =>
  one<{ status: string }>(db, "SELECT status FROM tasks WHERE id = ?", id)?.status;
const hasRow = (db: Db, id: string) =>
  one(db, "SELECT 1 FROM managed_events WHERE id = ?", id) !== undefined;

describe("a past chunk outside the synced window", () => {
  it("is not read as a delete after the window moves on; a delete inside the window still reopens", async () => {
    const { db, userId, chunk } = setup();
    chunk("old", 100);
    chunk("recent", 10);
    await pullEvents(db, empty, "cal", NOW);
    applyCalendarEdits(db, userId, ["cal"], "Europe/Berlin", NOW);
    expect(status(db, "old")).toBe("done");
    expect(status(db, "recent")).toBe("open");
    expect(hasRow(db, "recent")).toBe(false);
  });
});
