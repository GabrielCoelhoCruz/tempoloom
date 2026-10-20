// Creating and deleting a task (docs/specs/planning-tasks.md). The task routes,
// the bulk edit and the planner range pick share these.
import { randomUUID } from "node:crypto";
import { addLocalDays, MINUTE } from "../shared/time.ts";
import { badRequest, hoursSetId, type TaskInput } from "./api/items.ts";
import { all, type Db, one, run, tx } from "./db.ts";
import { getSettings } from "./settings.ts";
import type { SyncService } from "./sync/service.ts";

/**
 * Creates a task, every empty field from the user task defaults at this time
 * (planning-tasks.md TSK-1 to TSK-3). Returns the new task's id.
 */
export function createTask(
  db: Db,
  user: { id: string; time_zone: string },
  body: TaskInput,
  t: number,
): string {
  const d = getSettings(db, user.id).taskDefaults;
  const total = body.minutes ?? d.minutes;
  const split = body.splitUp ?? d.splitUp;
  const min = split ? (body.minChunkMinutes ?? Math.min(d.minChunkMinutes, total)) : total;
  const max = split
    ? (body.maxChunkMinutes ?? Math.min(Math.max(d.maxChunkMinutes, min), total))
    : total;
  if (min > max) badRequest("minChunkMinutes", "Minimum chunk is longer than maximum chunk");
  const startAfter = body.startAfter ?? t + d.startDelayMinutes * MINUTE;
  // The default due date is never before the task's time after its start (edge
  // case 6): a due-in saved before Settings checked it, or a short DST day.
  const dueAt =
    body.dueAt === undefined
      ? d.dueInDays === null
        ? null
        : Math.max(addLocalDays(t, d.dueInDays, user.time_zone), startAfter + total * MINUTE)
      : body.dueAt;
  if (dueAt !== null && dueAt <= startAfter)
    badRequest("dueAt", "Due date must be after the start date");
  const id = randomUUID();
  // A default hours set that was deleted falls back to work hours.
  const defaultSet =
    d.hoursSetId &&
    one(
      db,
      "SELECT 1 FROM hours_sets WHERE id = ? AND user_id = ? AND item_specific = 0",
      d.hoursSetId,
      user.id,
    )
      ? d.hoursSetId
      : undefined;
  const hours = hoursSetId(db, user.id, body.hoursSetId ?? defaultSet, "work");
  const rank =
    (body.nextUp ?? d.nextUp)
      ? (one<{ r: number | null }>(
          db,
          "SELECT MAX(next_up_rank) AS r FROM tasks WHERE user_id = ?",
          user.id,
        )?.r ?? -1) + 1
      : null;
  run(
    db,
    `INSERT INTO tasks (id, user_id, title, notes, level, total_minutes, min_chunk_minutes, max_chunk_minutes,
       start_after, due_at, hours_set_id, next_up_rank, created_at, rules_changed_at, color, visibility)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    user.id,
    body.title,
    body.notes ?? "",
    body.level ?? d.level,
    total,
    min,
    max,
    startAfter,
    dueAt,
    hours,
    rank,
    t,
    t,
    body.color ?? "category",
    body.visibility ?? d.visibility,
  );
  return id;
}

/** TSK-42: deletes every chunk of the task, past and future, then the task. */
export async function deleteTask(
  db: Db,
  sync: SyncService,
  userId: string,
  id: string,
): Promise<void> {
  await sync.exclusive(userId, async (pool) => {
    const rows = all<{
      id: string;
      calendar_id: string;
      event_id: string | null;
      account_id: string;
      provider_id: string;
    }>(
      db,
      `SELECT m.id, m.calendar_id, m.event_id, c.account_id, c.provider_id FROM managed_events m
       JOIN calendars c ON c.id = m.calendar_id WHERE m.user_id = ? AND m.kind = 'task' AND m.source_id = ?`,
      userId,
      id,
    );
    for (const row of rows) {
      if (row.event_id) await pool.get(row.account_id).deleteEvent(row.provider_id, row.event_id);
      run(
        db,
        "DELETE FROM events WHERE calendar_id = ? AND event_id = ?",
        row.calendar_id,
        row.event_id,
      );
      run(db, "DELETE FROM managed_events WHERE id = ?", row.id);
    }
    tx(db, () => {
      run(
        db,
        "DELETE FROM item_exclusions WHERE user_id = ? AND kind = 'task' AND item_id = ?",
        userId,
        id,
      );
      run(db, "DELETE FROM tasks WHERE id = ?", id);
    });
  });
}
