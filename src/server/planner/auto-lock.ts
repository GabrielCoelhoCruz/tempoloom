// The auto-lock schedule per item kind (docs/specs/planning-locks.md LCK-30 to LCK-33).
import { addDays, localToUtc, utcToLocal, weekdayOf } from "../../shared/time.ts";
import { all, type Db, one, run } from "../db.ts";
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

/** The auto_lock_runs key: a kind, or one flexible meeting with its own choice. */
export type LockKey = AutoLockKind | `meeting:${string}`;

/** A lock schedule: a kind, or one flexible meeting with its own choice (MEET-02 rule 14). */
interface Target {
  key: LockKey;
  kind: AutoLockKind;
  mode: Modes[AutoLockKind];
  /** The SQL filter on source_id, and its arguments. */
  where: string;
  args: string[];
}

/** The meetings with their own auto-lock choice; the others follow the setting. */
function targets(db: Db, userId: string, modes: Modes): Target[] {
  const own = all<{ id: string; auto_lock: Target["mode"] }>(
    db,
    "SELECT id, auto_lock FROM meetings WHERE user_id = ? AND auto_lock IS NOT NULL",
    userId,
  );
  const ids = own.map((m) => m.id);
  return [
    ...AUTO_LOCK_KINDS.map((kind) => ({
      key: kind,
      kind,
      mode: modes[kind],
      where:
        kind === "meeting" && ids.length > 0
          ? `AND source_id NOT IN (${ids.map(() => "?").join(", ")})`
          : "",
      args: kind === "meeting" ? ids : [],
    })),
    ...own.map((m) => ({
      key: `meeting:${m.id}` as const,
      kind: "meeting" as const,
      mode: m.auto_lock,
      where: "AND source_id = ?",
      args: [m.id],
    })),
  ];
}

/**
 * LCK-30 to LCK-32: locks every managed event of a kind that starts in the
 * current day or week and has not ended. The run happens once per period, in
 * the hour from 01:00 (for `week`, on the first day of the week), in the
 * planning zone of that date (home zone or travel zone). An event placed after
 * that run stays unlocked. A flexible meeting with its own choice has its own
 * run (MEET-02 rule 14); the setting for flexible meetings covers the others.
 * `force` lists keys (kinds, or `meeting:<id>`) that the user just turned on:
 * they run at once, at any hour. The first run of a key without a record only
 * records the current period, so a new server, user or meeting never locks
 * outside the hour; before the hour on the first day of the period it records
 * an empty period, so that hour still runs.
 */
export function autoLock(
  db: Db,
  userId: string,
  settings: Pick<Settings, "autoLock" | "weekStart">,
  now: number,
  force: readonly LockKey[] = [],
): void {
  const zone = planningZone(db, userId);
  const today = utcToLocal(zone, now).date;
  const runFrom = localToUtc(zone, today, RUN_MINUTE);
  const inHour = now >= runFrom && now < runFrom + RUN_HOUR_MS;
  for (const t of targets(db, userId, settings.autoLock)) {
    if (t.mode === "off") continue;
    const p = period(zone, today, t.mode, settings.weekStart);
    const last = one<{ period: string }>(
      db,
      "SELECT period FROM auto_lock_runs WHERE user_id = ? AND kind = ?",
      userId,
      t.key,
    )?.period;
    const forced = force.includes(t.key);
    if (!forced && last === p.key) continue;
    const due = forced || (last !== undefined && inHour && p.first === today);
    if (!due && last !== undefined) continue;
    // Before the hour on the first day: an empty record, so that hour runs.
    const waits = !due && p.first === today && now < runFrom;
    run(
      db,
      `INSERT INTO auto_lock_runs (user_id, kind, period) VALUES (?, ?, ?)
       ON CONFLICT (user_id, kind) DO UPDATE SET period = excluded.period`,
      userId,
      t.key,
      waits ? "" : p.key,
    );
    if (due) lockPeriod(db, userId, t, p, now);
  }
}

function lockPeriod(
  db: Db,
  userId: string,
  t: Pick<Target, "kind" | "where" | "args">,
  p: { from: number; to: number },
  now: number,
): void {
  run(
    db,
    `UPDATE managed_events SET locked = 1 WHERE user_id = ? AND kind = ? AND locked = 0
       AND event_id IS NOT NULL AND start_ms >= ? AND start_ms < ? AND end_ms > ? ${t.where}`,
    userId,
    t.kind,
    p.from,
    p.to,
    now,
    ...t.args,
  );
}

/** LCK-32 for one flexible meeting (MEET-02 rule 14): true when an edit turns its auto-lock from off to on. */
export function meetingTurnsOn(
  settings: Pick<Settings, "autoLock">,
  before: Modes["meeting"] | null,
  after: Modes["meeting"] | null,
): boolean {
  const mode = (m: Modes["meeting"] | null) => m ?? settings.autoLock.meeting;
  return mode(before) === "off" && mode(after) !== "off";
}

/**
 * LCK-32 for one flexible meeting: locks its current day or week at once. A
 * meeting with its own choice also records the run, so the hour from 01:00 does
 * not run again in that period; one that follows the setting is covered by the
 * setting's run from then on.
 */
export function lockMeetingNow(
  db: Db,
  userId: string,
  settings: Pick<Settings, "autoLock" | "weekStart">,
  choice: Modes["meeting"] | null,
  meetingId: string,
  now: number,
): void {
  const mode = choice ?? settings.autoLock.meeting;
  if (mode === "off") return;
  const zone = planningZone(db, userId);
  const p = period(zone, utcToLocal(zone, now).date, mode, settings.weekStart);
  lockPeriod(
    db,
    userId,
    { kind: "meeting", where: "AND source_id = ?", args: [meetingId] },
    p,
    now,
  );
  if (choice !== null)
    run(
      db,
      `INSERT INTO auto_lock_runs (user_id, kind, period) VALUES (?, ?, ?)
       ON CONFLICT (user_id, kind) DO UPDATE SET period = excluded.period`,
      userId,
      `meeting:${meetingId}`,
      p.key,
    );
}
