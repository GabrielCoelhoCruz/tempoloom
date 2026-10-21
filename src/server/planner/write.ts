// Locked managed events written at once, outside a planning run: applied work
// blocks (planning-next-up.md NXT-50) and logged work (planning-task-progress.md
// PRG-22, PRG-31). The scheduler never moves or deletes a locked event.
import { randomUUID } from "node:crypto";
import { all, type Db, one, run } from "../db.ts";
import type { ProviderPool } from "../providers/index.ts";
import { cacheEvent } from "../sync/pull.ts";
import type { SyncService } from "../sync/service.ts";
import { nextIndexAfter } from "./progress.ts";
import { KEY_PROP, MANAGED_PROP } from "./push.ts";

export interface LockedEvent {
  /** Omitted for a task chunk: the next free chunk key, chosen inside the sync queue. */
  key?: string;
  kind: "task" | "habit";
  sourceId: string;
  start: number;
  end: number;
  title: string;
  description: string;
  /** The user started this work or logged it (PRG-3, PRG-20); a work block is not started. */
  started?: boolean;
  visibility?: "private";
}

/** A calendar of the user that Tempoloom may write to, or undefined. */
export function writableCalendar(db: Db, userId: string, calendarId: string) {
  return one<{ id: string; account_id: string; provider_id: string; name: string }>(
    db,
    `SELECT c.id, c.account_id, c.provider_id, c.name FROM calendars c JOIN accounts a ON a.id = c.account_id
     WHERE c.id = ? AND a.user_id = ? AND a.status = 'ok' AND c.writable = 1`,
    calendarId,
    userId,
  );
}

/**
 * For the user's items: the email of the disconnected account that holds a
 * chosen calendar, or the main calendar when none is chosen, else null
 * (accounts rule 16). One read for a whole list.
 */
export function waitingCalendars(db: Db, userId: string) {
  const rows = all<{ id: string; email: string; ok: number; main: number }>(
    db,
    `SELECT c.id, a.email, a.status = 'ok' AS ok, a.is_main AS main FROM calendars c
       JOIN accounts a ON a.id = c.account_id
     WHERE a.user_id = ? AND c.writable = 1
     ORDER BY a.is_main DESC, c.is_primary DESC, a.created_at, c.name`,
    userId,
  );
  const main = rows[0];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return (calendarId: string | null | undefined): string | null => {
    const cal = (calendarId ? byId.get(calendarId) : undefined) ?? main;
    return cal && cal.ok !== 1 ? cal.email : null;
  };
}

export function writableCalendars(db: Db, userId: string) {
  return all<{ id: string; name: string }>(
    db,
    `SELECT c.id, c.name FROM calendars c JOIN accounts a ON a.id = c.account_id
     WHERE a.user_id = ? AND a.status = 'ok' AND c.writable = 1 AND a.grant_team_id IS NULL
     ORDER BY c.is_primary DESC, a.created_at, c.name`,
    userId,
  );
}

/** The next free chunk index of a task, so new keys never meet old ones. */
export function nextChunkIndex(db: Db, userId: string, taskId: string): number {
  return all<{ key: string; source_id: string }>(
    db,
    "SELECT key, source_id FROM managed_events WHERE user_id = ? AND kind = 'task' AND source_id = ?",
    userId,
    taskId,
  ).reduce(nextIndexAfter, 0);
}

/** Writes busy, locked managed events to one calendar, inside the user's sync queue. */
export async function writeLocked(
  db: Db,
  sync: SyncService,
  userId: string,
  calendarId: string,
  events: LockedEvent[],
): Promise<void> {
  await sync.exclusive(userId, (pool) => insertLocked(db, pool, userId, calendarId, events));
}

/** writeLocked for a caller that already holds the user's sync queue. */
export async function insertLocked(
  db: Db,
  pool: ProviderPool,
  userId: string,
  calendarId: string,
  events: LockedEvent[],
): Promise<void> {
  const cal = writableCalendar(db, userId, calendarId);
  if (!cal) throw new Error(`Calendar ${calendarId} is not writable`);
  for (const e of events) {
    // A plan run before this one may have taken the next key of a task.
    const key = e.key ?? `task:${e.sourceId}:${nextChunkIndex(db, userId, e.sourceId)}`;
    const ev = await pool.get(cal.account_id).insertEvent(cal.provider_id, {
      summary: e.title,
      description: e.description,
      start: e.start,
      end: e.end,
      busy: true,
      colorId: null,
      ...(e.visibility ? { visibility: e.visibility } : {}),
      privateProps: { [MANAGED_PROP]: "1", [KEY_PROP]: key, tl_user: userId },
    });
    cacheEvent(db, cal.id, ev);
    run(
      db,
      `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id, start_ms, end_ms,
         busy, title, description, color_id, locked, etag, started)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, 1, ?, ?)`,
      randomUUID(),
      userId,
      cal.id,
      ev.id,
      key,
      e.kind,
      e.sourceId,
      e.start,
      e.end,
      e.title,
      e.description,
      ev.etag,
      e.started ? 1 : 0,
    );
  }
}
