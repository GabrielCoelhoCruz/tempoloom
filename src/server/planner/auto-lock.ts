// The auto-lock schedule per item kind (docs/specs/planning-locks.md LCK-30 to LCK-33).
import { addDays, localToUtc, utcToLocal, weekdayOf } from "../../shared/time.ts";
import { type Db, one, run } from "../db.ts";
import type { Settings } from "../settings.ts";

export const AUTO_LOCK_KINDS = ["meeting", "habit", "task", "focus"] as const;
export type AutoLockKind = (typeof AUTO_LOCK_KINDS)[number];

/** LCK-31: the lock run starts at 01:00 in the user's time zone. */
const RUN_MINUTE = 60;

/** The current day, or the current week from the user's first day of the week (LCK-33). */
function period(zone: string, now: number, mode: "day" | "week", weekStart: 1 | 7) {
  const today = utcToLocal(zone, now).date;
  const first = mode === "day" ? today : addDays(today, -((weekdayOf(today) - weekStart + 7) % 7));
  return {
    key: `${mode}:${first}`,
    from: localToUtc(zone, first, 0),
    to: localToUtc(zone, addDays(first, mode === "day" ? 1 : 7), 0),
  };
}

/**
 * LCK-30, LCK-32: once per day or week, from 01:00, locks every managed event
 * of a kind that starts in the current day or week and has not ended. An event
 * placed after that run stays unlocked. `force` lists kinds whose setting just
 * changed: they run at once, at any hour.
 */
export function autoLock(
  db: Db,
  userId: string,
  zone: string,
  settings: Pick<Settings, "autoLock" | "weekStart">,
  now: number,
  force: readonly AutoLockKind[] = [],
): void {
  const minute = utcToLocal(zone, now).minuteOfDay;
  for (const kind of AUTO_LOCK_KINDS) {
    const mode = settings.autoLock[kind];
    if (mode === "off") continue;
    const p = period(zone, now, mode, settings.weekStart);
    const last = one<{ period: string }>(
      db,
      "SELECT period FROM auto_lock_runs WHERE user_id = ? AND kind = ?",
      userId,
      kind,
    )?.period;
    if (!force.includes(kind) && (last === p.key || minute < RUN_MINUTE)) continue;
    run(
      db,
      `INSERT INTO auto_lock_runs (user_id, kind, period) VALUES (?, ?, ?)
       ON CONFLICT (user_id, kind) DO UPDATE SET period = excluded.period`,
      userId,
      kind,
      p.key,
    );
    run(
      db,
      `UPDATE managed_events SET locked = 1 WHERE user_id = ? AND kind = ? AND locked = 0
         AND event_id IS NOT NULL AND start_ms >= ? AND start_ms < ? AND end_ms > ?`,
      userId,
      kind,
      p.from,
      p.to,
      now,
    );
  }
}
