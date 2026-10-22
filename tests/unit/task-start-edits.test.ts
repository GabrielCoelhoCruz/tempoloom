// CED-11 when one edit pass sees edits of two chunks of one task
// (docs/specs/planning-calendar-edits.md). The task's first chunk is the
// chunk with the earliest start before the edits, among the chunks that the
// pass keeps: a deleted chunk is placed again later (CED-20), so it is not
// the first chunk. Only a move of that chunk sets the task's start.
//
// Ways it can fail:
// 1. The pass reads the other chunks from the table that it changes, so the
//    result depends on the order of the rows (calendar and event ids).
// 2. A later chunk that moves before the first chunk sets the start.
// 3. A deleted first chunk keeps the next chunk from setting the start.
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { all, one, openDb, run } from "../../src/server/db.ts";
import { applyCalendarEdits } from "../../src/server/sync/edits.ts";

const T0 = Date.parse("2026-10-19T09:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Edit = "move" | "delete";

/**
 * Chunk A on day 1 (the first chunk) and chunk B on day 2, on two calendars.
 * `aFirst` puts A in the calendar and event id that the pass reads first.
 */
function pass(aFirst: boolean, a: Edit, aTo: number, b: Edit, bTo: number) {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", T0 - 30 * DAY);
  run(
    db,
    `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, status, created_at, is_main)
     VALUES ('acc', ?, 'caldav', 'acc', 'owner@example.com', '', 'ok', ?, 1)`,
    user.id,
    T0,
  );
  for (const cal of ["cal-1", "cal-2"])
    run(
      db,
      `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability, writable,
         window_start, window_end)
       VALUES (?, 'acc', ?, ?, 0, 1, 1, ?, ?)`,
      cal,
      cal,
      cal,
      T0 - 84 * DAY,
      T0 + 120 * DAY,
    );
  const hours = one<{ id: string }>(
    db,
    "SELECT id FROM hours_sets WHERE user_id = ? AND kind = 'work'",
    user.id,
  )?.id;
  run(
    db,
    `INSERT INTO tasks (id, user_id, title, level, total_minutes, min_chunk_minutes, max_chunk_minutes,
       start_after, hours_set_id, created_at, rules_changed_at)
     VALUES ('t', ?, 'Report', 2, 120, 60, 60, ?, ?, ?, ?)`,
    user.id,
    T0,
    hours as string,
    T0,
    T0,
  );
  const chunks: [string, number, Edit, number][] = [
    ["A", T0 + DAY, a, aTo],
    ["B", T0 + 2 * DAY, b, bTo],
  ];
  for (const [name, start, edit, to] of chunks) {
    const read = (name === "A") === aFirst;
    const cal = read ? "cal-1" : "cal-2";
    const eventId = read ? "aa" : "zz";
    run(
      db,
      `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id,
         start_ms, end_ms, busy, title) VALUES (?, ?, ?, ?, ?, 'task', 't', ?, ?, 1, 'Report')`,
      `m-${name}`,
      user.id,
      cal,
      eventId,
      `task:t:${name}`,
      start,
      start + HOUR,
    );
    if (edit === "move")
      run(
        db,
        `INSERT INTO events (calendar_id, event_id, summary, start_ms, end_ms, busy)
         VALUES (?, ?, 'Report', ?, ?, 1)`,
        cal,
        eventId,
        to,
        to + HOUR,
      );
  }
  const summary = applyCalendarEdits(db, user.id, ["cal-1", "cal-2"], "UTC", T0);
  const startAfter = one<{ start_after: number }>(
    db,
    "SELECT start_after FROM tasks WHERE id = 't'",
  )?.start_after;
  const exclusions = all(db, "SELECT start_ms, end_ms FROM item_exclusions ORDER BY start_ms");
  return { summary, startAfter, exclusions };
}

describe("CED-11 with two edited chunks of one task in one pass", () => {
  for (const aFirst of [true, false]) {
    const order = aFirst ? "first chunk read first" : "first chunk read last";

    it(`both moved: the first chunk's new start is the task start (${order})`, () => {
      const r = pass(aFirst, "move", T0 + 3 * DAY, "move", T0);
      expect(r.summary).toEqual({ moved: 2, deleted: 0, locked: 2 });
      expect(r.startAfter).toBe(T0 + 3 * DAY);
    });

    it(`first deleted, second moved: the moved chunk is now first (${order})`, () => {
      const r = pass(aFirst, "delete", 0, "move", T0 - DAY / 2);
      expect(r.summary).toEqual({ moved: 1, deleted: 1, locked: 1 });
      expect(r.startAfter).toBe(T0 - DAY / 2);
    });

    it(`both deleted: the task start stays and both leave an exclusion (${order})`, () => {
      const r = pass(aFirst, "delete", 0, "delete", 0);
      expect(r.summary).toEqual({ moved: 0, deleted: 2, locked: 0 });
      expect(r.startAfter).toBe(T0);
      expect(r.exclusions).toHaveLength(2);
    });
  }
});
