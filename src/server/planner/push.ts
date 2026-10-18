// Writes the desired managed events to calendars: creates, moves and deletes
// events so that the calendars match the plan. Unchanged events get no write.
import { randomUUID } from "node:crypto";
import { all, type Db, one, run } from "../db.ts";
import { type CalendarProvider, type EventWrite, ProviderError } from "../providers/types.ts";
import { cacheEvent } from "../sync/pull.ts";

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
  location?: string;
  attendees?: string[];
  optionalAttendees?: string[];
  organizer?: string;
}

export interface ManagedRow {
  id: string;
  user_id: string;
  calendar_id: string;
  event_id: string | null;
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
  user_edited: number;
  etag: string | null;
  extra: string;
}

/** Guests and location as stored in `managed_events.extra`. */
const extraOf = (d: DesiredEvent) =>
  d.attendees || d.optionalAttendees || d.location
    ? JSON.stringify({
        location: d.location ?? "",
        attendees: d.attendees ?? [],
        optional: d.optionalAttendees ?? [],
      })
    : "";

export interface PushContext {
  db: Db;
  userId: string;
  /** Provider and provider calendar id for one of our calendar ids. */
  target: (calendarId: string) => { provider: CalendarProvider; providerCalendarId: string };
  now: number;
}

export interface PushResult {
  created: number;
  updated: number;
  deleted: number;
  conflicts: number;
}

/** Private properties that mark an event as managed by Tempoloom. */
export const MANAGED_PROP = "tl";
export const KEY_PROP = "tl_key";

function write(userId: string, d: DesiredEvent): EventWrite {
  return {
    summary: d.title,
    description: d.description,
    start: d.start,
    end: d.end,
    busy: d.busy,
    colorId: d.colorId,
    privateProps: { [MANAGED_PROP]: "1", [KEY_PROP]: d.key, tl_user: userId },
    ...(d.location ? { location: d.location } : {}),
    ...(d.attendees ? { attendees: d.attendees } : {}),
    ...(d.optionalAttendees ? { optionalAttendees: d.optionalAttendees } : {}),
    ...(d.organizer ? { organizer: d.organizer } : {}),
  };
}

interface Cached {
  summary: string;
  description: string;
  busy: number;
  etag: string | null;
}

function differs(row: ManagedRow, cached: Cached | undefined, d: DesiredEvent): boolean {
  if (
    row.start_ms !== d.start ||
    row.end_ms !== d.end ||
    row.title !== d.title ||
    row.description !== d.description ||
    Boolean(row.busy) !== d.busy ||
    (row.color_id ?? null) !== (d.colorId ?? null) ||
    row.calendar_id !== d.calendarId ||
    row.extra !== extraOf(d)
  ) {
    return true;
  }
  // The calendar copy drifted (a user edit that does not lock): write it back.
  return (
    cached !== undefined &&
    (cached.summary !== d.title ||
      cached.description !== d.description ||
      Boolean(cached.busy) !== d.busy)
  );
}

/**
 * Makes the user's future managed events equal to `desired`. Events that
 * have started are never changed. Locked events are never moved or deleted.
 * Writes run in the order deletes, updates, creates.
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
  const wanted = new Set(desired.map((d) => d.key));

  for (const row of rows) {
    if (wanted.has(row.key) || row.locked || row.start_ms <= now) continue;
    await deleteRemote(ctx, row);
    run(db, "DELETE FROM managed_events WHERE id = ?", row.id);
    result.deleted++;
  }

  const creates: DesiredEvent[] = [];
  for (const d of desired) {
    const row = byKey.get(d.key);
    if (!row?.event_id || row.calendar_id !== d.calendarId) {
      creates.push(d);
      continue;
    }
    // Never change a started event; a locked event may get a new title or
    // status but never a new time.
    if (row.start_ms <= now) continue;
    if (row.locked && (row.start_ms !== d.start || row.end_ms !== d.end)) continue;
    const cached = one<Cached>(
      db,
      "SELECT summary, description, busy, etag FROM events WHERE calendar_id = ? AND event_id = ?",
      row.calendar_id,
      row.event_id,
    );
    if (!differs(row, cached, d)) continue;
    const { provider, providerCalendarId } = ctx.target(row.calendar_id);
    try {
      const ev = await provider.updateEvent(
        providerCalendarId,
        row.event_id,
        write(userId, d),
        cached?.etag ?? row.etag,
      );
      cacheEvent(db, row.calendar_id, ev);
      saveRow(db, userId, d, ev.id, ev.etag, row.id);
      result.updated++;
    } catch (err) {
      // precondition_failed: the user changed the event since our last read. The
      // next pull reads their change; the plan adapts on the following run.
      if (err instanceof ProviderError && err.kind === "precondition_failed") {
        result.conflicts++;
        continue;
      }
      if (err instanceof ProviderError && err.kind === "not_found") {
        run(db, "DELETE FROM managed_events WHERE id = ?", row.id);
        result.conflicts++;
        continue;
      }
      throw err;
    }
  }

  for (const d of creates) {
    const row = byKey.get(d.key);
    if (row && (row.locked || row.start_ms <= now)) continue;
    if (row?.event_id) await deleteRemote(ctx, row);
    const { provider, providerCalendarId } = ctx.target(d.calendarId);
    const ev = await provider.insertEvent(providerCalendarId, write(userId, d));
    cacheEvent(db, d.calendarId, ev);
    saveRow(db, userId, d, ev.id, ev.etag, row?.id);
    result.created++;
  }
  return result;
}

async function deleteRemote(ctx: PushContext, row: ManagedRow): Promise<void> {
  if (!row.event_id) return;
  const { provider, providerCalendarId } = ctx.target(row.calendar_id);
  await provider.deleteEvent(providerCalendarId, row.event_id);
  run(
    ctx.db,
    "DELETE FROM events WHERE calendar_id = ? AND event_id = ?",
    row.calendar_id,
    row.event_id,
  );
}

function saveRow(
  db: Db,
  userId: string,
  d: DesiredEvent,
  eventId: string,
  etag: string | null,
  existingId: string | undefined,
): void {
  run(
    db,
    `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id, start_ms, end_ms,
       busy, title, description, color_id, locked, etag, extra)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT (user_id, key) DO UPDATE SET
       calendar_id = excluded.calendar_id, event_id = excluded.event_id, start_ms = excluded.start_ms,
       end_ms = excluded.end_ms, busy = excluded.busy, title = excluded.title,
       description = excluded.description, color_id = excluded.color_id, etag = excluded.etag,
       extra = excluded.extra`,
    existingId ?? randomUUID(),
    userId,
    d.calendarId,
    eventId,
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
    extraOf(d),
  );
}
