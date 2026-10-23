// Reads user edits of managed events from the event cache after a pull
// (docs/specs/planning-calendar-edits.md).
import { chosenDaySql, HabitChoice } from "../../shared/habit-choice.ts";
import { addDays, chosenMinute, localToUtc, utcToLocal } from "../../shared/time.ts";
import { all, type Db, one, run, tx } from "../db.ts";
import type { ManagedRow } from "../planner/push.ts";
import { planningZone } from "../travel.ts";
import { READ_BY_LAST_PULL_SQL } from "./pull.ts";

/** A managed row with its cached event: c_id is null, with all c_ columns, when the cache has none. */
type EditRow = ManagedRow &
  (
    | { c_id: null }
    | { c_id: string; c_start: number; c_end: number; c_summary: string; c_etag: string | null }
  );

/**
 * Habits rule 29 for an occurrence whose date has passed: its event's day
 * keeps it in the plan (see passedOpen in plan.ts). A choice of the user wins
 * while its day is today or later; an older choice is no longer read, so the
 * event's day replaces it.
 */
function keepDeletedOccurrence(db: Db, userId: string, row: ManagedRow, zone: string, now: number) {
  const date = row.key.slice(`habit:${row.source_id}:`.length);
  const day = utcToLocal(zone, row.start_ms).date;
  const today = utcToLocal(zone, now).date;
  if (date >= today || day < today) return;
  run(
    db,
    `INSERT INTO habit_reschedules (user_id, habit_id, date, minute, not_before) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (habit_id, date) DO UPDATE SET minute = excluded.minute, not_before = excluded.not_before
       WHERE habit_reschedules.not_before = ? OR ${chosenDaySql("habit_reschedules")} < ?`,
    userId,
    row.source_id,
    date,
    chosenMinute(date, day, 0),
    HabitChoice.eventDay,
    HabitChoice.eventDay,
    today,
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
  setTaskStart(db, userId, row.source_id, start);
}

function setTaskStart(db: Db, userId: string, taskId: string, start: number): void {
  run(db, "UPDATE tasks SET start_after = ? WHERE id = ? AND user_id = ?", start, taskId, userId);
}

/**
 * CED-11 for one edit pass: the start of each moved task's first chunk, from
 * the rows as they were before the pass, so the order in which the pass reads
 * the rows does not change the result. A chunk that the pass deletes is placed
 * again later (CED-20), so it is not the first chunk.
 */
function firstChunkStarts(db: Db, userId: string, rows: EditRow[]): Map<string, number> {
  const first = new Map<string, number>();
  const tasks = new Set(
    rows
      .filter((r) => r.kind === "task" && r.c_id !== null && r.c_start !== r.start_ms)
      .map((r) => r.source_id),
  );
  if (tasks.size === 0) return first;
  const gone = new Set(rows.filter((r) => r.c_id === null).map((r) => r.id));
  for (const r of all<{ id: string; source_id: string; start_ms: number }>(
    db,
    `SELECT id, source_id, start_ms FROM managed_events
     WHERE user_id = ? AND kind = 'task' AND source_id IN (${[...tasks].map(() => "?").join(",")})`,
    userId,
    ...tasks,
  )) {
    if (gone.has(r.id)) continue;
    first.set(r.source_id, Math.min(first.get(r.source_id) ?? r.start_ms, r.start_ms));
  }
  return first;
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
 * and logged work of old chunks still counts (READ_BY_LAST_PULL_SQL in pull.ts).
 * Known limit: a provider cancel for an event that ended before window_start
 * is not applied (a Google sync token reports it, the row stays), so a delete
 * of a chunk older than the window gives no minutes back (CED-21, CED-22).
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
  // One read for the pass: each row with its cached event, if any. A row that
  // is not in the cache and was not read by the last pull (CED-22 needs a
  // delete that the calendar reports) is not read here, so it stays as it is.
  const rows = all<EditRow>(
    db,
    `SELECT m.*, e.event_id AS c_id, e.start_ms AS c_start, e.end_ms AS c_end, e.summary AS c_summary, e.etag AS c_etag
     FROM managed_events m
     JOIN calendars c ON c.id = m.calendar_id
     LEFT JOIN events e ON e.calendar_id = m.calendar_id AND e.event_id = m.event_id
     WHERE m.user_id = ? AND m.event_id IS NOT NULL AND m.calendar_id IN (${marks})
       AND (e.event_id IS NOT NULL OR ${READ_BY_LAST_PULL_SQL})
     ORDER BY m.calendar_id, m.event_id`,
    userId,
    ...calendarIds,
  );
  const firstStart = firstChunkStarts(db, userId, rows);
  let zoneOfPlan: string | undefined;
  const planZone = () => (zoneOfPlan ??= planningZone(db, userId, zone));
  tx(db, () => {
    for (const row of rows) {
      const cached =
        row.c_id === null
          ? undefined
          : { start_ms: row.c_start, end_ms: row.c_end, summary: row.c_summary, etag: row.c_etag };
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
        } else if (row.kind === "task") {
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
        if (cached.start_ms !== row.start_ms && row.start_ms === firstStart.get(row.source_id)) {
          setTaskStart(db, userId, row.source_id, cached.start_ms);
        }
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
