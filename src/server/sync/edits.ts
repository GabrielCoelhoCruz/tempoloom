// Reads user edits of managed events from the event cache after a pull
// (docs/specs/planning-calendar-edits.md).
import { addDays, chosenMinute, localToUtc, utcToLocal } from "../../shared/time.ts";
import { all, type Db, one, run, tx } from "../db.ts";
import type { ManagedRow } from "../planner/push.ts";
import { planningZone } from "../travel.ts";

/**
 * `habit_reschedules.not_before` of a stored event day, not a chosen time:
 * the occurrence's event on that day was deleted (habits rule 29), and the
 * occurrence's date has passed. The plan places it again on that day.
 */
export const REOPENED_CHOICE = 2;

/**
 * Habits rule 29 for an occurrence whose date has passed: its event's day
 * keeps it in the plan (see passedOpen in plan.ts). A choice of the user wins.
 */
function keepDeletedOccurrence(db: Db, userId: string, row: ManagedRow, zone: string, now: number) {
  const date = row.key.slice(`habit:${row.source_id}:`.length);
  const day = utcToLocal(zone, row.start_ms).date;
  const today = utcToLocal(zone, now).date;
  if (date >= today || day < today) return;
  run(
    db,
    `INSERT INTO habit_reschedules (user_id, habit_id, date, minute, not_before) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (habit_id, date) DO UPDATE SET minute = excluded.minute WHERE not_before = ?`,
    userId,
    row.source_id,
    date,
    chosenMinute(date, day, 0),
    REOPENED_CHOICE,
    REOPENED_CHOICE,
  );
}

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
 * CED-11: when the user moves the task's first chunk, its new start becomes the
 * task's start. Later chunks then go after it; an earlier move starts the task sooner.
 */
export function moveTaskStart(db: Db, userId: string, row: ManagedRow, start: number): void {
  if (row.kind !== "task") return;
  const earlier = one(
    db,
    "SELECT 1 FROM managed_events WHERE user_id = ? AND kind = 'task' AND source_id = ? AND id <> ? AND start_ms < ?",
    userId,
    row.source_id,
    row.id,
    row.start_ms,
  );
  if (earlier) return;
  run(
    db,
    "UPDATE tasks SET start_after = ? WHERE id = ? AND user_id = ?",
    start,
    row.source_id,
    userId,
  );
}

/**
 * Applies the user's calendar edits to managed events of the given calendars:
 * a moved or resized event locks at its new time (CED-1, CED-2), except a
 * buffer resized at its free edge, which keeps the new length and still
 * follows its anchor (buffers rule 14); a moved task
 * chunk leaves an exclusion at its old time (CED-10); a deleted event leaves an
 * exclusion or a dismissed key by kind (CED-20, CED-24, CED-25); a deleted past
 * chunk gives its minutes back and reopens a done task (CED-21, CED-22); a move
 * of a task's first chunk sets the task's start (CED-11); a title edit of a
 * non-task event locks it (CED-40). Other edits of a meeting occurrence
 * need nothing here: push never writes them over (MEET-02 rule 22).
 * An event outside the calendar's read window is not in the cache because it
 * was not read, not because it was deleted: its row stays as it is, so done
 * and logged work of old chunks still counts.
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
  // CED-22 needs a delete that the calendar reports: a chunk that ended before
  // the start of the last read window is missing from the cache because the
  // read did not ask for it, not because the user deleted it.
  const windows = new Map(
    all<{ id: string; window_start: number | null; window_end: number | null }>(
      db,
      `SELECT id, window_start, window_end FROM calendars WHERE id IN (${marks})`,
      ...calendarIds,
    ).map((c) => [c.id, c]),
  );
  const outsideWindow = (row: ManagedRow) => {
    const w = windows.get(row.calendar_id);
    if (!w || w.window_start === null || w.window_end === null) return false;
    return row.end_ms <= w.window_start || row.start_ms >= w.window_end;
  };
  let zoneOfPlan: string | undefined;
  const planZone = () => (zoneOfPlan ??= planningZone(db, userId, zone));
  tx(db, () => {
    for (const row of rows) {
      const cached = one<{
        start_ms: number;
        end_ms: number;
        summary: string;
        etag: string | null;
      }>(
        db,
        "SELECT start_ms, end_ms, summary, etag FROM events WHERE calendar_id = ? AND event_id = ?",
        row.calendar_id,
        row.event_id,
      );
      if (!cached && outsideWindow(row)) continue;
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
            if (row.kind === "habit") keepDeletedOccurrence(db, userId, row, planZone(), now);
          }
        } else if (
          row.kind === "task" &&
          row.end_ms > (windows.get(row.calendar_id)?.window_start ?? 0)
        ) {
          // "This work did not happen": the minutes go back to the task, which is open again.
          run(
            db,
            "UPDATE tasks SET status = 'open', rules_changed_at = ? WHERE id = ? AND user_id = ? AND status = 'done'",
            now,
            row.source_id,
            userId,
          );
        }
        run(db, "DELETE FROM managed_events WHERE id = ?", row.id);
        summary.deleted++;
        continue;
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
        if (cached.start_ms !== row.start_ms) moveTaskStart(db, userId, row, cached.start_ms);
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
