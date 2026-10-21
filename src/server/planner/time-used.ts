// The time-used action (planning-task-progress.md PRG-40 to PRG-44). Each plan
// run checks the open tasks whose time is used: no work left and no chunk to
// come. A task is time-used since its last done work ended; after the wait
// days, "re-add" adds its first total again and "mark-done" marks it done.
// The run reads the setting each time, so a change also applies to tasks that
// were time-used before it (PRG-43). Manual start mode turns it off (PRG-44).
import { all, type Db, run } from "../db.ts";
import type { Settings } from "../settings.ts";
import { markTaskDone } from "../task-order.ts";
import { endedUnstarted, type ProgressRow } from "./progress.ts";

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
  }>(
    db,
    "SELECT id, total_minutes, logged_minutes, base_minutes FROM tasks WHERE user_id = ? AND status = 'open'",
    userId,
  );
  if (tasks.length === 0) return 0;
  const rows = all<ProgressRow>(
    db,
    "SELECT kind, source_id, start_ms, end_ms, event_id, started FROM managed_events WHERE user_id = ? AND kind = 'task'",
    userId,
  );
  const ahead = new Set<string>();
  const work = new Map<string, { minutes: number; lastEnd: number }>();
  for (const r of rows) {
    if (r.end_ms > now) ahead.add(r.source_id);
    else if (!endedUnstarted(r, now, s)) {
      const w = work.get(r.source_id) ?? { minutes: 0, lastEnd: 0 };
      w.minutes += (r.end_ms - r.start_ms) / 60_000;
      w.lastEnd = Math.max(w.lastEnd, r.end_ms);
      work.set(r.source_id, w);
    }
  }
  let changed = 0;
  for (const t of tasks) {
    const w = work.get(t.id);
    if (!w || ahead.has(t.id)) continue;
    const used = t.logged_minutes + w.minutes;
    if (t.total_minutes > used || now - w.lastEnd < s.timeUsedWaitDays * DAY) continue;
    if (s.timeUsedAction === "mark-done") markTaskDone(db, t.id, now);
    else {
      // PRG-41: the first total comes again, so exactly that much work is left.
      const base = t.base_minutes ?? t.total_minutes;
      run(
        db,
        "UPDATE tasks SET total_minutes = ?, base_minutes = ?, rules_changed_at = ? WHERE id = ?",
        Math.max(t.total_minutes, Math.ceil(used)) + base,
        base,
        now,
        t.id,
      );
    }
    changed++;
  }
  return changed;
}
