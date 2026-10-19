// Tempoloom's record of each write it makes to a calendar event
// (docs/specs/support-troubleshooting.md rule 12). Entries outlive the event and
// are deleted after the retention period.
import { all, type Db, run } from "./db.ts";

const DAY = 86_400_000;
export const RETENTION_DAYS = 90;

export type ChangeAction = "create" | "update" | "delete";

export interface ChangeEntry {
  calendarId: string;
  eventId: string;
  /** The managed event key, so an event that gets a new id keeps its history. */
  key?: string;
  action: ChangeAction;
  /** The item or policy, as "<kind>:<id>". */
  item?: string;
  reason: string;
  title?: string;
  start?: number;
  end?: number;
  /** The person who acted, when it was not the owner (a delegate). */
  actor?: string;
}

export function logChange(db: Db, userId: string, e: ChangeEntry, now: number): void {
  run(
    db,
    `INSERT INTO change_log (user_id, calendar_id, event_id, event_key, action, item, reason, title,
       start_ms, end_ms, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    userId,
    e.calendarId,
    e.eventId,
    e.key ?? "",
    e.action,
    e.item ?? "",
    e.reason,
    e.title ?? "",
    e.start ?? null,
    e.end ?? null,
    e.actor ?? "",
    now,
  );
}

/** Deletes entries older than the retention period. */
export function pruneChangeLog(db: Db, now: number): void {
  run(db, "DELETE FROM change_log WHERE created_at < ?", now - RETENTION_DAYS * DAY);
}

export interface LoggedChange {
  action: ChangeAction;
  item: string;
  reason: string;
  title: string;
  start: number | null;
  end: number | null;
  actor: string;
  at: number;
}

/** Entries of one event, newest first: by its id, or by its managed key. */
export function changesOf(
  db: Db,
  userId: string,
  calendarId: string,
  eventId: string,
  key: string | null,
): LoggedChange[] {
  return all<LoggedChange>(
    db,
    `SELECT action, item, reason, title, start_ms AS start, end_ms AS end, actor, created_at AS at
     FROM change_log WHERE user_id = ? AND ((calendar_id = ? AND event_id = ?) OR (? <> '' AND event_key = ?))
     ORDER BY created_at DESC, id DESC LIMIT 200`,
    userId,
    calendarId,
    eventId,
    key ?? "",
    key ?? "",
  );
}

/** Why the planner wrote a managed event, in words (rule 12 examples). */
export function pushReason(
  kind: string,
  action: ChangeAction,
  how: { restored?: boolean; moved?: boolean } = {},
): string {
  const mirror = kind === "mirror";
  if (action === "create") {
    if (how.restored) return mirror ? "copy restored" : "event restored";
    return mirror ? "source copied" : "placed";
  }
  if (action === "delete") return mirror ? "source removed" : "no longer planned";
  if (how.moved) return mirror ? "source moved" : "moved";
  return mirror ? "source changed" : "details changed";
}

/** Logs a planner write of a managed event (planner/push.ts). */
export function logManaged(
  db: Db,
  userId: string,
  e: { calendarId: string; eventId: string; key: string; kind: string; sourceId: string },
  action: ChangeAction,
  values: { title: string; start: number; end: number; moved?: boolean },
  now: number,
): void {
  const restored =
    action === "create" &&
    all(
      db,
      "SELECT 1 FROM change_log WHERE user_id = ? AND event_key = ? AND action = 'create' LIMIT 1",
      userId,
      e.key,
    ).length > 0;
  logChange(
    db,
    userId,
    {
      calendarId: e.calendarId,
      eventId: e.eventId,
      key: e.key,
      action,
      item: `${e.kind}:${e.sourceId}`,
      reason: pushReason(e.kind, action, { restored, moved: values.moved ?? false }),
      title: values.title,
      start: values.start,
      end: values.end,
    },
    now,
  );
}
