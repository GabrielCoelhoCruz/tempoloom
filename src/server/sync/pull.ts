// Mirrors Google calendars and events into the local database.
import { randomUUID } from "node:crypto";
import { DAY, localToUtc } from "../../shared/time.ts";
import { all, type Db, one, run, tx } from "../db.ts";
import {
  type GoogleCalendarApi,
  type GoogleEvent,
  type GoogleEventTime,
  SyncTokenExpiredError,
} from "../google/calendar.ts";

/** Events from 7 days ago to 120 days ahead are mirrored. */
const WINDOW_PAST = 7 * DAY;
const WINDOW_FUTURE = 120 * DAY;
/** A full sync runs again when less than this much future remains in the window. */
const WINDOW_REFRESH = 90 * DAY;

export interface CalendarRow {
  id: string;
  account_id: string;
  google_id: string;
  summary: string;
  time_zone: string | null;
  access_role: string;
  is_primary: number;
  check_availability: number;
  sync_token: string | null;
  window_start: number | null;
  window_end: number | null;
}

export async function syncCalendarList(
  db: Db,
  api: GoogleCalendarApi,
  accountId: string,
  userId: string,
): Promise<void> {
  const entries = await api.listCalendars();
  tx(db, () => {
    for (const c of entries) {
      run(
        db,
        `INSERT INTO calendars (id, account_id, google_id, summary, time_zone, access_role, is_primary, color, check_availability)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, google_id) DO UPDATE SET
           summary = excluded.summary, time_zone = excluded.time_zone,
           access_role = excluded.access_role, is_primary = excluded.is_primary, color = excluded.color`,
        randomUUID(),
        accountId,
        c.id,
        c.summary,
        c.timeZone ?? null,
        c.accessRole,
        c.primary ? 1 : 0,
        c.backgroundColor ?? null,
        c.primary ? 1 : 0,
      );
      if (c.primary && c.timeZone) {
        run(db, "UPDATE users SET time_zone = ? WHERE id = ?", c.timeZone, userId);
      }
    }
    const ids = new Set(entries.map((c) => c.id));
    for (const row of all<{ id: string; google_id: string }>(
      db,
      "SELECT id, google_id FROM calendars WHERE account_id = ?",
      accountId,
    )) {
      if (!ids.has(row.google_id)) run(db, "DELETE FROM calendars WHERE id = ?", row.id);
    }
  });
}

function toInstant(t: GoogleEventTime | undefined, zone: string): { ms: number; allDay: boolean } {
  if (t?.dateTime) return { ms: Date.parse(t.dateTime), allDay: false };
  if (t?.date) return { ms: localToUtc(t.timeZone ?? zone, t.date, 0), allDay: true };
  throw new Error("Event time has neither dateTime nor date");
}

function upsertEvent(db: Db, calendarId: string, zone: string, e: GoogleEvent): void {
  if (e.status === "cancelled" || !e.start || !e.end) {
    run(db, "DELETE FROM events WHERE calendar_id = ? AND google_id = ?", calendarId, e.id);
    return;
  }
  const start = toInstant(e.start, zone);
  const end = toInstant(e.end, zone);
  const self = e.attendees?.find((a) => a.self);
  run(
    db,
    `INSERT INTO events (calendar_id, google_id, status, summary, description, location, start_ms, end_ms,
       all_day, busy, event_type, self_response, attendee_count, organizer_self, recurring_id, color_id,
       etag, updated_ms, private_props)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (calendar_id, google_id) DO UPDATE SET
       status = excluded.status, summary = excluded.summary, description = excluded.description,
       location = excluded.location, start_ms = excluded.start_ms, end_ms = excluded.end_ms,
       all_day = excluded.all_day, busy = excluded.busy, event_type = excluded.event_type,
       self_response = excluded.self_response, attendee_count = excluded.attendee_count,
       organizer_self = excluded.organizer_self, recurring_id = excluded.recurring_id,
       color_id = excluded.color_id, etag = excluded.etag, updated_ms = excluded.updated_ms,
       private_props = excluded.private_props`,
    calendarId,
    e.id,
    e.status,
    e.summary ?? "",
    e.description ?? "",
    e.location ?? "",
    start.ms,
    end.ms,
    start.allDay ? 1 : 0,
    e.transparency === "transparent" ? 0 : 1,
    e.eventType ?? "default",
    self?.responseStatus ?? null,
    e.attendees?.filter((a) => !a.resource).length ?? 0,
    e.organizer?.self === false ? 0 : 1,
    e.recurringEventId ?? null,
    e.colorId ?? null,
    e.etag ?? null,
    e.updated ? Date.parse(e.updated) : null,
    JSON.stringify(e.extendedProperties?.private ?? {}),
  );
}

/** Applies a single event returned by a write, so the mirror is current without a poll. */
export function applyWrittenEvent(db: Db, calendarId: string, zone: string, e: GoogleEvent): void {
  upsertEvent(db, calendarId, zone, e);
}

/** Pulls changes for one calendar. Returns the number of changed events. */
export async function pullEvents(
  db: Db,
  api: GoogleCalendarApi,
  calendarId: string,
  userZone: string,
  now = Date.now(),
): Promise<number> {
  const cal = one<CalendarRow>(db, "SELECT * FROM calendars WHERE id = ?", calendarId);
  if (!cal) return 0;
  const zone = cal.time_zone ?? userZone;
  const needsFull = !cal.sync_token || (cal.window_end ?? 0) < now + WINDOW_REFRESH;
  if (!needsFull && cal.sync_token) {
    try {
      const page = await api.listEvents(cal.google_id, { syncToken: cal.sync_token });
      tx(db, () => {
        for (const e of page.events) upsertEvent(db, cal.id, zone, e);
        run(
          db,
          "UPDATE calendars SET sync_token = ?, synced_at = ? WHERE id = ?",
          page.nextSyncToken,
          now,
          cal.id,
        );
      });
      return page.events.length;
    } catch (err) {
      if (!(err instanceof SyncTokenExpiredError)) throw err;
    }
  }
  const windowStart = now - WINDOW_PAST;
  const windowEnd = now + WINDOW_FUTURE;
  const page = await api.listEvents(cal.google_id, { timeMin: windowStart, timeMax: windowEnd });
  tx(db, () => {
    run(db, "DELETE FROM events WHERE calendar_id = ?", cal.id);
    for (const e of page.events) upsertEvent(db, cal.id, zone, e);
    run(
      db,
      `UPDATE calendars SET sync_token = ?, window_start = ?, window_end = ?, synced_at = ? WHERE id = ?`,
      page.nextSyncToken,
      windowStart,
      windowEnd,
      now,
      cal.id,
    );
  });
  return page.events.length;
}
