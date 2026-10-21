// The time-used action (planning-task-progress.md PRG-40 to PRG-44). Each plan
// run checks the open tasks that are time-used (isTimeUsed). The wait starts
// when the task became time-used: when its done work first reached the total,
// or at the user's last change of the total if that came later. After the wait
// days, "re-add" adds the first total again and "mark-done" marks the task
// done; each writes an entry to the item's change log. The run reads the
// setting each time, so a change also applies to tasks that were time-used
// before it (PRG-43). Manual start mode turns it off (PRG-44).
import { all, type Db, run } from "../db.ts";
import type { Settings } from "../settings.ts";
import { markTaskDone } from "../task-order.ts";
import { doneWork, isTimeUsed, type ProgressRow, reachedAt } from "./progress.ts";

const DAY = 24 * 60 * 60_000;

type TimeUsedSettings = Pick<
  Settings,
  "startMode" | "manualSince" | "timeUsedAction" | "timeUsedWaitDays"
>;

/** Applies the action to the tasks whose wait ended. Returns how many tasks changed. */
export function applyTimeUsed(db: Db, userId: string, now: number, s: TimeUsedSettings): number {
  if (s.startMode === "manual" || s.timeUsedAction === "nothing") return 0;
  const tasks = all<{
    id: string;
    total_minutes: number;
    logged_minutes: number;
    base_minutes: number | null;
    minutes_changed_at: number | null;
  }>(
    db,
    `SELECT id, total_minutes, logged_minutes, base_minutes, minutes_changed_at FROM tasks
     WHERE user_id = ? AND status = 'open'`,
    userId,
  );
  if (tasks.length === 0) return 0;
  const rows = all<ProgressRow>(
    db,
    `SELECT kind, source_id, start_ms, end_ms, event_id, started FROM managed_events
     WHERE user_id = ? AND kind = 'task'
       AND source_id IN (SELECT id FROM tasks WHERE user_id = ? AND status = 'open')`,
    userId,
    userId,
  );
  const ahead = new Map<string, number>();
  for (const r of rows)
    if (r.end_ms > now)
      ahead.set(r.source_id, (ahead.get(r.source_id) ?? 0) + (r.end_ms - r.start_ms) / 60_000);
  const done = doneWork(rows, now, s);
  let changed = 0;
  for (const t of tasks) {
    const work = done.get(t.id) ?? [];
    const used = t.logged_minutes + work.reduce((a, w) => a + w.minutes, 0);
    if (!isTimeUsed(t.total_minutes - used, ahead.get(t.id) ?? 0)) continue;
    const reached = reachedAt(work, t.total_minutes - t.logged_minutes);
    if (reached === null) continue;
    const since = Math.max(reached, t.minutes_changed_at ?? 0);
    if (now - since < s.timeUsedWaitDays * DAY) continue;
    if (s.timeUsedAction === "mark-done") markTaskDone(db, t.id, now);
    else {
      // PRG-41: the first total comes again, so exactly that much work is left.
      const base = t.base_minutes ?? t.total_minutes;
      run(
        db,
        `UPDATE tasks SET total_minutes = ?, base_minutes = ?, readds = readds + 1, rules_changed_at = ?
         WHERE id = ?`,
        Math.max(t.total_minutes, Math.ceil(used)) + base,
        base,
        now,
        t.id,
      );
    }
    run(
      db,
      `INSERT INTO item_changes (user_id, kind, item_id, demand_key, action, reason, at)
       VALUES (?, 'task', ?, ?, 'status', ?, ?)`,
      userId,
      t.id,
      `task:${t.id}`,
      s.timeUsedAction === "mark-done" ? "time-used-done" : "time-used-readd",
      now,
    );
    changed++;
  }
  return changed;
}
