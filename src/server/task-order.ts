// The one rule for a change of the task order: a next-up queue move
// (planning-next-up.md NXT-2, NXT-5, NXT-10) or a level change
// (planning-priorities.md PRI-50, PRI-51, PRI-53), from any control.
import { type Db, one, run } from "./db.ts";

/**
 * Marks the tasks that the scheduler must place again after the order of one
 * task changed. The moved task always gets a new placement. When it goes down
 * in the order (out of the queue, later in the queue, a lower level), every
 * other open task also gets a new placement, so the tasks that now come first
 * take its time (NXT-10, acceptance test 4). When it goes up (into the queue,
 * earlier in the queue, a higher level), the other tasks keep their placements
 * (SCH-88); a task whose slot the moved task takes is placed again by the
 * scheduler. Locked and started chunks never move (NXT-4, edge case 2).
 */
export function taskOrderChanged(
  db: Db,
  userId: string,
  taskId: string,
  down: boolean,
  t: number,
): void {
  if (down)
    run(
      db,
      "UPDATE tasks SET rules_changed_at = ? WHERE user_id = ? AND status = 'open'",
      t,
      userId,
    );
  else run(db, "UPDATE tasks SET rules_changed_at = ? WHERE id = ?", t, taskId);
}

/** TSK-40 and NXT-11: the task is done and leaves the next-up queue. */
export function markTaskDone(db: Db, taskId: string, t: number): void {
  run(
    db,
    "UPDATE tasks SET status = 'done', next_up_rank = NULL, rules_changed_at = ? WHERE id = ?",
    t,
    taskId,
  );
}

/** The last rank in the next-up queue, -1 when it is empty; a new entry goes after it (NXT-9). */
export function lastQueueRank(db: Db, userId: string): number {
  return (
    one<{ r: number | null }>(
      db,
      "SELECT MAX(next_up_rank) AS r FROM tasks WHERE user_id = ? AND status = 'open'",
      userId,
    )?.r ?? -1
  );
}
