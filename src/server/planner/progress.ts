// Done work of tasks (planning-task-progress.md PRG-1 to PRG-5). One rule for
// the planner run, the task list, the "now" panels and the progress markers:
// an ended task chunk is done work, except in manual start mode when nobody
// started it (Start, Stop, the timer and logged work start an event; a lock or
// a drag does not). Events from before the switch to manual mode keep counting.
import { all, type Db } from "../db.ts";
import { getSettings, type Settings } from "../settings.ts";

export interface ProgressRow {
  kind: string;
  source_id: string;
  start_ms: number;
  end_ms: number;
  event_id: string | null;
  started: number;
}

type StartSettings = Pick<Settings, "startMode" | "manualSince">;

/** PRG-3, PRG-5: the event ended, and in manual mode nobody started it. */
export function endedUnstarted(r: ProgressRow, now: number, s: StartSettings): boolean {
  return (
    s.startMode === "manual" &&
    r.end_ms <= now &&
    r.started === 0 &&
    r.event_id !== null &&
    r.start_ms >= (s.manualSince ?? Number.POSITIVE_INFINITY)
  );
}

/** Minutes of done work per task id, from managed rows (PRG-1). */
export function doneMinutes(
  rows: Iterable<ProgressRow>,
  now: number,
  s: StartSettings,
): Map<string, number> {
  const done = new Map<string, number>();
  for (const r of rows) {
    if (r.kind !== "task" || r.end_ms > now || endedUnstarted(r, now, s)) continue;
    done.set(r.source_id, (done.get(r.source_id) ?? 0) + (r.end_ms - r.start_ms) / 60_000);
  }
  return done;
}

/** PRG-40: an open task is time-used when no work is left and no chunk is to come. */
export const isTimeUsed = (remainingMinutes: number, scheduledMinutes: number): boolean =>
  remainingMinutes <= 0 && scheduledMinutes <= 0;

/** Minutes of done work per task of one user, or of one task. */
export function taskDoneMinutes(
  db: Db,
  userId: string,
  now: number,
  taskId?: string,
): Map<string, number> {
  const rows = all<ProgressRow>(
    db,
    `SELECT kind, source_id, start_ms, end_ms, event_id, started FROM managed_events
     WHERE user_id = ? AND kind = 'task' AND end_ms <= ?${taskId ? " AND source_id = ?" : ""}`,
    userId,
    now,
    ...(taskId ? [taskId] : []),
  );
  return doneMinutes(rows, now, getSettings(db, userId));
}

/**
 * The next free chunk index of a task after one of its rows: chunk keys are
 * `task:<id>:<n>`; other keys (logged work, `task:<id>:log-…`) do not count.
 */
export function nextIndexAfter(next: number, r: { key: string; source_id: string }): number {
  const n = Number(r.key.slice(`task:${r.source_id}:`.length));
  return Number.isInteger(n) ? Math.max(next, n + 1) : next;
}
