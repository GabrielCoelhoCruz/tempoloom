// The auto-lock schedule per item kind (docs/specs/planning-locks.md LCK-30 to LCK-33).
import { addDays, localToUtc, utcToLocal, weekdayOf } from "../../shared/time.ts";
import { type Db, one, run } from "../db.ts";
import type { Settings } from "../settings.ts";
import { planningZone } from "../travel.ts";

export const AUTO_LOCK_KINDS = ["meeting", "habit", "task", "focus"] as const;
export type AutoLockKind = (typeof AUTO_LOCK_KINDS)[number];
type Modes = Settings["autoLock"];

/** LCK-31: the lock run has one hour from 01:00 in the user's time zone. */
const RUN_MINUTE = 60;
const RUN_HOUR_MS = 3_600_000;

/** The current day, or the current week from the user's first day of the week (LCK-33). */
function period(zone: string, today: string, mode: "day" | "week", weekStart: 1 | 7) {
  const first = mode === "day" ? today : addDays(today, -((weekdayOf(today) - weekStart + 7) % 7));
  return {
    first,
    key: `${mode}:${first}`,
    from: localToUtc(zone, first, 0),
    to: localToUtc(zone, addDays(first, mode === "day" ? 1 : 7), 0),
  };
}

/** LCK-32: the kinds that the user turned on (off to day or week). They lock at once. */
export function turnedOn(before: Modes, after: Modes): AutoLockKind[] {
  return AUTO_LOCK_KINDS.filter((k) => before[k] === "off" && after[k] !== "off");
}

/**
 * LCK-30 to LCK-32: locks every managed event of a kind that starts in the
 * current day or week and has not ended. The run happens once per period, in
 * the hour from 01:00 (for `week`, on the first day of the week), in the
 * planning zone of that date (home zone or travel zone). An event placed after
 * that run stays unlocked. `force` lists kinds that the user just turned on:
 * they run at once, at any hour. The first run of a kind without a record
 * only records the current period, so a new server or a new user never locks
 * outside the hour.
 */
export function autoLock(
  db: Db,
  userId: string,
  settings: Pick<Settings, "autoLock" | "weekStart">,
  now: number,
  force: readonly AutoLockKind[] = [],
): void {
  const zone = planningZone(db, userId);
  const today = utcToLocal(zone, now).date;
  const runFrom = localToUtc(zone, today, RUN_MINUTE);
  const inHour = now >= runFrom && now < runFrom + RUN_HOUR_MS;
  for (const kind of AUTO_LOCK_KINDS) {
    const mode = settings.autoLock[kind];
    if (mode === "off") continue;
    const p = period(zone, today, mode, settings.weekStart);
    const last = one<{ period: string }>(
      db,
      "SELECT period FROM auto_lock_runs WHERE user_id = ? AND kind = ?",
      userId,
      kind,
    )?.period;
    const forced = force.includes(kind);
    if (!forced && last === p.key) continue;
    const due = forced || (last !== undefined && inHour && p.first === today);
    if (!due && last !== undefined) continue;
    run(
      db,
      `INSERT INTO auto_lock_runs (user_id, kind, period) VALUES (?, ?, ?)
       ON CONFLICT (user_id, kind) DO UPDATE SET period = excluded.period`,
      userId,
      kind,
      p.key,
    );
    if (!due) continue;
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
