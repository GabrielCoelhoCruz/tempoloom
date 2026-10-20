// Locked managed events written at once, outside a planning run: applied work
// blocks (planning-next-up.md NXT-50) and logged work (planning-task-progress.md
// PRG-22, PRG-31). The scheduler never moves or deletes a locked event.
import { randomUUID } from "node:crypto";
import { all, type Db, one, run } from "../db.ts";
import { cacheEvent } from "../sync/pull.ts";
import type { SyncService } from "../sync/service.ts";
import { KEY_PROP, MANAGED_PROP } from "./push.ts";

export interface LockedEvent {
  key: string;
  kind: "task" | "habit";
  sourceId: string;
  start: number;
  end: number;
  title: string;
  description: string;
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
 * The email of the disconnected account that holds a calendar, or null
 * (accounts-login-emails-permissions.md rule 16): items that write to it wait.
 */
export function disconnectedEmail(db: Db, calendarId: string | null | undefined): string | null {
  if (!calendarId) return null;
  return (
    one<{ email: string }>(
      db,
      `SELECT a.email FROM calendars c JOIN accounts a ON a.id = c.account_id
       WHERE c.id = ? AND a.status <> 'ok'`,
      calendarId,
    )?.email ?? null
  );
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
  const prefix = `task:${taskId}:`;
  return all<{ key: string }>(
    db,
    "SELECT key FROM managed_events WHERE user_id = ? AND kind = 'task' AND source_id = ?",
    userId,
    taskId,
  ).reduce((m, r) => {
    const n = Number(r.key.slice(prefix.length));
    return Number.isInteger(n) ? Math.max(m, n + 1) : m;
  }, 0);
}

/** Writes busy, locked managed events to one calendar, inside the user's sync queue. */
export async function writeLocked(
  db: Db,
  sync: SyncService,
  userId: string,
  calendarId: string,
  events: LockedEvent[],
): Promise<void> {
  const cal = writableCalendar(db, userId, calendarId);
  if (!cal) throw new Error(`Calendar ${calendarId} is not writable`);
  await sync.exclusive(userId, async (pool) => {
    for (const e of events) {
      const ev = await pool.get(cal.account_id).insertEvent(cal.provider_id, {
        summary: e.title,
        description: e.description,
        start: e.start,
        end: e.end,
        busy: true,
        colorId: null,
        privateProps: { [MANAGED_PROP]: "1", [KEY_PROP]: e.key, tl_user: userId },
      });
      cacheEvent(db, cal.id, ev);
      run(
        db,
        `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id, start_ms, end_ms,
           busy, title, description, color_id, locked, etag)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, 1, ?)`,
        randomUUID(),
        userId,
        cal.id,
        ev.id,
        e.key,
        e.kind,
        e.sourceId,
        e.start,
        e.end,
        e.title,
        e.description,
        ev.etag,
      );
    }
  });
}
