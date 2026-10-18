// Writes the desired managed events to Google Calendar: creates, moves and
// deletes events so that the calendar matches the plan.
import { randomUUID } from "node:crypto";
import { all, type Db, one, run } from "../db.ts";
import {
  GoogleApiError,
  type GoogleCalendarApi,
  type GoogleEventInput,
} from "../google/calendar.ts";
import { applyWrittenEvent } from "../sync/pull.ts";

export interface DesiredEvent {
  key: string;
  kind: string;
  sourceId: string;
  calendarId: string;
  start: number;
  end: number;
  title: string;
  description: string;
  busy: boolean;
  colorId: string | null;
}

export interface ManagedRow {
  id: string;
  user_id: string;
  calendar_id: string;
  google_id: string | null;
  key: string;
  kind: string;
  source_id: string;
  start_ms: number;
  end_ms: number;
  busy: number;
  title: string;
  description: string;
  color_id: string | null;
  locked: number;
  etag: string | null;
}

export interface PushContext {
  db: Db;
  userId: string;
  zone: string;
  apiFor: (calendarId: string) => { api: GoogleCalendarApi; googleCalendarId: string };
  now: number;
}

export interface PushResult {
  created: number;
  updated: number;
  deleted: number;
  conflicts: number;
}

/** Private extended properties that mark an event as managed by Tempoloom. */
export const MANAGED_PROP = "tl";
export const KEY_PROP = "tl_key";

function body(userId: string, d: DesiredEvent): GoogleEventInput {
  return {
    summary: d.title,
    description: d.description,
    start: { dateTime: new Date(d.start).toISOString() },
    end: { dateTime: new Date(d.end).toISOString() },
    transparency: d.busy ? "opaque" : "transparent",
    ...(d.colorId ? { colorId: d.colorId } : {}),
    reminders: { useDefault: false },
    extendedProperties: { private: { [MANAGED_PROP]: "1", [KEY_PROP]: d.key, tl_user: userId } },
  };
}

const differs = (row: ManagedRow, d: DesiredEvent) =>
  row.start_ms !== d.start ||
  row.end_ms !== d.end ||
  row.title !== d.title ||
  row.description !== d.description ||
  Boolean(row.busy) !== d.busy ||
  (row.color_id ?? null) !== (d.colorId ?? null) ||
  row.calendar_id !== d.calendarId;

/**
 * Makes the user's future managed events equal to `desired`. Events that
 * have started are never changed. Locked events are never moved or deleted.
 */
export async function pushSchedule(ctx: PushContext, desired: DesiredEvent[]): Promise<PushResult> {
  const { db, userId, now } = ctx;
  const result: PushResult = { created: 0, updated: 0, deleted: 0, conflicts: 0 };
  const rows = all<ManagedRow>(
    db,
    "SELECT * FROM managed_events WHERE user_id = ? AND end_ms > ?",
    userId,
    now,
  );
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const wanted = new Set<string>();

  for (const d of desired) {
    wanted.add(d.key);
    const row = byKey.get(d.key);
    if (row && (row.locked || row.start_ms <= now || !differs(row, d))) continue;
    try {
      if (!row?.google_id || row.calendar_id !== d.calendarId) {
        if (row?.google_id) await deleteRemote(ctx, row);
        const { api, googleCalendarId } = ctx.apiFor(d.calendarId);
        const ev = await api.insertEvent(googleCalendarId, body(userId, d));
        applyWrittenEvent(db, d.calendarId, ctx.zone, ev);
        saveRow(db, userId, d, ev.id, ev.etag ?? null, row?.id);
        result.created++;
      } else {
        const { api, googleCalendarId } = ctx.apiFor(row.calendar_id);
        const ev = await api.patchEvent(googleCalendarId, row.google_id, body(userId, d), {
          ...(row.etag ? { etag: row.etag } : {}),
        });
        applyWrittenEvent(db, row.calendar_id, ctx.zone, ev);
        saveRow(db, userId, d, ev.id, ev.etag ?? null, row.id);
        result.updated++;
      }
    } catch (err) {
      // 412: the user changed the event in Google since our last read. The next
      // pull picks up their change; the plan adapts on the following run.
      if (err instanceof GoogleApiError && err.status === 412) {
        result.conflicts++;
        continue;
      }
      if (err instanceof GoogleApiError && (err.status === 404 || err.status === 410) && row) {
        run(db, "DELETE FROM managed_events WHERE id = ?", row.id);
        result.conflicts++;
        continue;
      }
      throw err;
    }
  }

  for (const row of rows) {
    if (wanted.has(row.key) || row.locked || row.start_ms <= now) continue;
    await deleteRemote(ctx, row);
    run(db, "DELETE FROM managed_events WHERE id = ?", row.id);
    result.deleted++;
  }
  return result;
}

async function deleteRemote(ctx: PushContext, row: ManagedRow): Promise<void> {
  if (!row.google_id) return;
  const { api, googleCalendarId } = ctx.apiFor(row.calendar_id);
  await api.deleteEvent(googleCalendarId, row.google_id);
  run(
    ctx.db,
    "DELETE FROM events WHERE calendar_id = ? AND google_id = ?",
    row.calendar_id,
    row.google_id,
  );
}

function saveRow(
  db: Db,
  userId: string,
  d: DesiredEvent,
  googleId: string,
  etag: string | null,
  existingId: string | undefined,
): void {
  run(
    db,
    `INSERT INTO managed_events (id, user_id, calendar_id, google_id, key, kind, source_id, start_ms, end_ms,
       busy, title, description, color_id, locked, etag)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT (user_id, key) DO UPDATE SET
       calendar_id = excluded.calendar_id, google_id = excluded.google_id, start_ms = excluded.start_ms,
       end_ms = excluded.end_ms, busy = excluded.busy, title = excluded.title,
       description = excluded.description, color_id = excluded.color_id, etag = excluded.etag`,
    existingId ?? randomUUID(),
    userId,
    d.calendarId,
    googleId,
    d.key,
    d.kind,
    d.sourceId,
    d.start,
    d.end,
    d.busy ? 1 : 0,
    d.title,
    d.description,
    d.colorId,
    etag,
  );
}

export function managedRow(db: Db, userId: string, key: string): ManagedRow | undefined {
  return one<ManagedRow>(
    db,
    "SELECT * FROM managed_events WHERE user_id = ? AND key = ?",
    userId,
    key,
  );
}
