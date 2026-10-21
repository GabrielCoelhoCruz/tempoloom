// The time-used action (planning-task-progress.md PRG-40 to PRG-46). Each plan
// run checks the open tasks for isTimeUsed. The first run that finds a task
// time-used records the time (time_used_since), the start of the wait; a run
// that finds it no longer time-used clears it (PRG-46). So the wait never
// starts in the past, whatever made the task time-used: done chunks, logged
// work with an old date, a longer past chunk or a lower total. After the wait
// days, "re-add" adds the first total again and "mark-done" marks the task
// done, each with an entry in the item's change log. The run reads the setting
// each time, so a change also applies to tasks that were time-used before it
// (PRG-43). Manual start mode turns the action off (PRG-44).
import { all, type Db, run, tx } from "../db.ts";
import type { Settings } from "../settings.ts";
import { markTaskDone } from "../task-order.ts";
import { doneMinutes, isTimeUsed, type ProgressRow } from "./progress.ts";

const DAY = 24 * 60 * 60_000;

type TimeUsedSettings = Pick<
  Settings,
  "startMode" | "manualSince" | "timeUsedAction" | "timeUsedWaitDays"
>;

/** Records the time-used times and applies the action to the tasks whose wait ended. Returns how many tasks it acted on. */
export function applyTimeUsed(db: Db, userId: string, now: number, s: TimeUsedSettings): number {
  const tasks = all<{
    id: string;
    total_minutes: number;
    logged_minutes: number;
    base_minutes: number | null;
    time_used_since: number | null;
  }>(
    db,
    `SELECT id, total_minutes, logged_minutes, base_minutes, time_used_since FROM tasks
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
  const done = doneMinutes(rows, now, s);
  const acts = s.startMode !== "manual" && s.timeUsedAction !== "nothing";
  let changed = 0;
  for (const t of tasks) {
    const used = t.logged_minutes + (done.get(t.id) ?? 0);
    if (!isTimeUsed(t.total_minutes - used, ahead.get(t.id) ?? 0)) {
      if (t.time_used_since !== null)
        run(db, "UPDATE tasks SET time_used_since = NULL WHERE id = ?", t.id);
      continue;
    }
    if (t.time_used_since === null) {
      run(db, "UPDATE tasks SET time_used_since = ? WHERE id = ?", now, t.id);
      continue;
    }
    if (!acts || now - t.time_used_since < s.timeUsedWaitDays * DAY) continue;
    tx(db, () => {
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
      run(db, "UPDATE tasks SET time_used_since = NULL WHERE id = ?", t.id);
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
    });
    changed++;
  }
  return changed;
}
