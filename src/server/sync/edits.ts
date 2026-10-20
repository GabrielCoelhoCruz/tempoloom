// Reads user edits of managed events from the event cache after a pull
// (docs/specs/planning-calendar-edits.md).
import { addDays, localToUtc, utcToLocal } from "../../shared/time.ts";
import { all, type Db, one, run, tx } from "../db.ts";
import type { ManagedRow } from "../planner/push.ts";

export interface EditSummary {
  moved: number;
  deleted: number;
  locked: number;
}

function exclude(db: Db, userId: string, kind: string, itemId: string, start: number, end: number) {
  run(
    db,
    "INSERT INTO item_exclusions (user_id, kind, item_id, start_ms, end_ms) VALUES (?, ?, ?, ?, ?)",
    userId,
    kind,
    itemId,
    start,
    end,
  );
}

/**
 * Applies the user's calendar edits to managed events of the given calendars:
 * a moved or resized event locks at its new time (CED-1, CED-2), except a
 * buffer resized at its free edge, which keeps the new length and still
 * follows its anchor (buffers rule 14); a moved task
 * chunk leaves an exclusion at its old time (CED-10); a deleted event leaves an
 * exclusion or a dismissed key by kind (CED-20, CED-24, CED-25); a title edit
 * of a non-task event locks it (CED-40); the description edit of a meeting
 * occurrence is kept without a lock (MEET-02 rule 22).
 */
export function applyCalendarEdits(
  db: Db,
  userId: string,
  calendarIds: string[],
  zone: string,
  now: number,
): EditSummary {
  const summary: EditSummary = { moved: 0, deleted: 0, locked: 0 };
  if (calendarIds.length === 0) return summary;
  const marks = calendarIds.map(() => "?").join(",");
  const rows = all<ManagedRow>(
    db,
    `SELECT * FROM managed_events WHERE user_id = ? AND event_id IS NOT NULL AND calendar_id IN (${marks})`,
    userId,
    ...calendarIds,
  );
  tx(db, () => {
    for (const row of rows) {
      const cached = one<{
        start_ms: number;
        end_ms: number;
        summary: string;
        description: string;
        etag: string | null;
      }>(
        db,
        "SELECT start_ms, end_ms, summary, description, etag FROM events WHERE calendar_id = ? AND event_id = ?",
        row.calendar_id,
        row.event_id,
      );
      if (row.kind === "mirror") {
        // The source event is the source of truth (mirroring rule 38): a deleted
        // or edited copy is written again by the next push, and never locks.
        if (!cached) run(db, "DELETE FROM managed_events WHERE id = ?", row.id);
        else if (
          cached.start_ms !== row.start_ms ||
          cached.end_ms !== row.end_ms ||
          cached.summary !== row.title
        ) {
          run(
            db,
            "UPDATE managed_events SET start_ms = ?, end_ms = ?, title = ?, etag = ? WHERE id = ?",
            cached.start_ms,
            cached.end_ms,
            cached.summary,
            cached.etag,
            row.id,
          );
        }
        continue;
      }
      if (!cached) {
        if (row.end_ms > now) {
          if (row.kind === "task") {
            // "Later": place the work again from the next day on.
            const nextDay = localToUtc(zone, addDays(utcToLocal(zone, row.start_ms).date, 1), 0);
            exclude(db, userId, "task", row.source_id, Math.min(row.start_ms, now), nextDay);
          } else if (row.kind === "buffer" || row.kind === "meeting") {
            // A deleted meeting occurrence skips its period (MEET-02 rule 20).
            run(
              db,
              "INSERT OR IGNORE INTO dismissed_keys (user_id, key) VALUES (?, ?)",
              userId,
              row.key,
            );
          } else {
            exclude(db, userId, row.kind, row.source_id, row.start_ms, row.end_ms);
          }
        }
        run(db, "DELETE FROM managed_events WHERE id = ?", row.id);
        summary.deleted++;
        continue;
      }
      // The organizer's description of a meeting occurrence is kept (MEET-02 rule 22).
      if (row.kind === "meeting" && cached.description !== row.description) {
        run(
          db,
          "UPDATE managed_events SET description = ?, user_edited = 1, etag = ? WHERE id = ?",
          cached.description,
          cached.etag,
          row.id,
        );
      }
      const moved = cached.start_ms !== row.start_ms || cached.end_ms !== row.end_ms;
      const retitled = row.kind !== "task" && cached.summary !== row.title;
      if (!moved && !retitled) continue;
      // Buffers rule 14: a new length with the anchored edge in place (the end of
      // a before-buffer, the start of an after-buffer) is kept on the row, and
      // the buffer still follows its anchor. Any other move locks (CED-1, CED-2).
      const anchoredEdge = row.key.endsWith(":before")
        ? cached.end_ms === row.end_ms
        : cached.start_ms === row.start_ms;
      if (
        row.kind === "buffer" &&
        moved &&
        anchoredEdge &&
        !retitled &&
        cached.end_ms > cached.start_ms
      ) {
        run(
          db,
          "UPDATE managed_events SET start_ms = ?, end_ms = ?, etag = ?, kept_minutes = ? WHERE id = ?",
          cached.start_ms,
          cached.end_ms,
          cached.etag,
          Math.round((cached.end_ms - cached.start_ms) / 60_000),
          row.id,
        );
        summary.moved++;
        continue;
      }
      if (moved && row.kind === "task") {
        exclude(db, userId, "task", row.source_id, row.start_ms, row.end_ms);
      }
      run(
        db,
        `UPDATE managed_events SET locked = 1, start_ms = ?, end_ms = ?, title = ?, etag = ?,
           user_edited = MAX(user_edited, ?) WHERE id = ?`,
        cached.start_ms,
        cached.end_ms,
        cached.summary,
        cached.etag,
        retitled ? 1 : 0,
        row.id,
      );
      if (moved) summary.moved++;
      summary.locked++;
    }
  });
  return summary;
}
