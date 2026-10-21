// Copies calendars and events from a provider into the local event cache.
import { randomUUID } from "node:crypto";
import { DAY } from "../../shared/time.ts";
import { all, type Db, one, run, tx } from "../db.ts";
import { GOOGLE_SETTINGS_SCOPE } from "../google/oauth.ts";
import {
  type CalendarProvider,
  type ProviderCalendar,
  ProviderError,
  type ProviderEvent,
} from "../providers/types.ts";
import { updateSettings } from "../settings.ts";

/** Events from 12 weeks ago (the stats range) to 120 days ahead are cached. */
const WINDOW_PAST = 84 * DAY;
const WINDOW_FUTURE = 120 * DAY;
/** A full read runs again when less than this much future remains in the window. */
const WINDOW_REFRESH = 90 * DAY;
/**
 * Mirroring keeps copies 12 months ahead, longer than the planning window
 * (sync-calendar-mirroring.md rule 14; planning-scheduling-window.md WIN-7).
 */
export const MIRROR_WINDOW = 365 * DAY;
/** How far ahead the calendars of an enabled mirroring policy are read. */
export const MIRROR_READ_AHEAD = MIRROR_WINDOW + 15 * DAY;

export interface CalendarRow {
  id: string;
  account_id: string;
  provider_id: string;
  name: string;
  time_zone: string | null;
  writable: number;
  is_primary: number;
  check_availability: number;
  sync_token: string | null;
  window_start: number | null;
  window_end: number | null;
}

/** Accounts whose failed settings read is logged already: one line, not one per sync. */
const settingsFailureLogged = new Set<string>();

/**
 * Week start, time format and date format follow the user's main Google
 * account (settings-profile.md PRF-2, PRF-3): read with each calendar list
 * sync. A grant without the settings scope keeps the current values. The
 * Google week start is kept as googleWeekStart for the profile page only: the
 * planning week start does not change, so no weekly planner key changes.
 */
async function readProfileSettings(
  db: Db,
  provider: CalendarProvider,
  accountId: string,
  userId: string,
): Promise<void> {
  if (!provider.profileSettings) return;
  // Only a user's own Google login: a service account reads its own settings.
  const acc = one<{ scope: string }>(
    db,
    "SELECT scope FROM accounts WHERE id = ? AND is_main = 1 AND provider = 'google'",
    accountId,
  );
  if (!acc?.scope.split(" ").includes(GOOGLE_SETTINGS_SCOPE)) return;
  try {
    const { weekStart, ...formats } = await provider.profileSettings();
    settingsFailureLogged.delete(accountId);
    updateSettings(db, userId, { ...formats, googleWeekStart: weekStart ?? null });
  } catch (err) {
    if (settingsFailureLogged.has(accountId)) return;
    settingsFailureLogged.add(accountId);
    console.error("Reading the Google Calendar settings failed", err);
  }
}

export async function syncCalendarList(
  db: Db,
  provider: CalendarProvider,
  accountId: string,
  userId: string,
): Promise<void> {
  const listed = await provider.listCalendars();
  await readProfileSettings(db, provider, accountId, userId);
  // Keep the account's main calendar stable: a backend without a primary flag
  // (CalDAV) must not move the main calendar when calendars are added.
  const current = one<{ provider_id: string }>(
    db,
    "SELECT provider_id FROM calendars WHERE account_id = ? AND is_primary = 1",
    accountId,
  );
  const keep =
    current && listed.some((c) => c.id === current.provider_id) ? current.provider_id : null;
  const entries = keep ? listed.map((c) => ({ ...c, primary: c.id === keep })) : listed;
  tx(db, () => {
    for (const c of entries) {
      writeCalendar(db, accountId, c);
      if (c.primary && c.timeZone) {
        run(db, "UPDATE users SET time_zone = ? WHERE id = ?", c.timeZone, userId);
      }
    }
    const ids = new Set(entries.map((c) => c.id));
    for (const row of all<{ id: string; provider_id: string }>(
      db,
      "SELECT id, provider_id FROM calendars WHERE account_id = ?",
      accountId,
    )) {
      if (!ids.has(row.provider_id)) run(db, "DELETE FROM calendars WHERE id = ?", row.id);
    }
  });
}

/**
 * Makes `c` the account's only primary calendar, the one the planner writes
 * to, and the only one checked for availability (operator pin, src/server/cli.ts).
 * The sync keeps a primary that is still listed and adds new calendars unchecked.
 * Call it inside the caller's transaction.
 */
export function pinCalendar(db: Db, accountId: string, c: ProviderCalendar): void {
  writeCalendar(db, accountId, { ...c, primary: true });
  run(
    db,
    `UPDATE calendars SET is_primary = (provider_id = ?), check_availability = (provider_id = ?)
     WHERE account_id = ?`,
    c.id,
    c.id,
    accountId,
  );
}

/** Inserts or updates one listed calendar; a new primary calendar starts checked. */
function writeCalendar(db: Db, accountId: string, c: ProviderCalendar): void {
  run(
    db,
    `INSERT INTO calendars (id, account_id, provider_id, name, time_zone, writable, is_primary, color, check_availability)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (account_id, provider_id) DO UPDATE SET
       name = excluded.name, time_zone = excluded.time_zone, writable = excluded.writable,
       is_primary = excluded.is_primary, color = excluded.color`,
    randomUUID(),
    accountId,
    c.id,
    c.name,
    c.timeZone,
    c.writable ? 1 : 0,
    c.primary ? 1 : 0,
    c.color,
    c.primary ? 1 : 0,
  );
}

export function cacheEvent(db: Db, calendarId: string, e: ProviderEvent): void {
  if (e.cancelled) {
    run(db, "DELETE FROM events WHERE calendar_id = ? AND event_id = ?", calendarId, e.id);
    return;
  }
  // Alerts of Tempoloom's own events: a copy that someone gave an alert is
  // written again. Privacy of every event: a meeting occurrence with a new
  // privacy is written again (rule 22), and the planner's "view as" hides the
  // details of private events (PLN-6).
  run(
    db,
    `INSERT INTO events (calendar_id, event_id, summary, description, location, start_ms, end_ms,
       all_day, busy, event_type, self_response, attendee_count, organizer_self, recurring_id, color_id,
       etag, updated_ms, private_props, attendees, responses, conference, rsvp_note, alerts,
       own_visibility, organizer_email, series)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (calendar_id, event_id) DO UPDATE SET
       summary = excluded.summary, description = excluded.description, location = excluded.location,
       start_ms = excluded.start_ms, end_ms = excluded.end_ms, all_day = excluded.all_day,
       busy = excluded.busy, event_type = excluded.event_type, self_response = excluded.self_response,
       attendee_count = excluded.attendee_count, organizer_self = excluded.organizer_self,
       recurring_id = excluded.recurring_id, color_id = excluded.color_id, etag = excluded.etag,
       updated_ms = excluded.updated_ms, private_props = excluded.private_props,
       attendees = excluded.attendees, responses = excluded.responses,
       conference = excluded.conference, rsvp_note = excluded.rsvp_note, alerts = excluded.alerts,
       own_visibility = excluded.own_visibility, organizer_email = excluded.organizer_email,
       series = excluded.series`,
    calendarId,
    e.id,
    e.summary,
    e.description,
    e.location,
    e.start,
    e.end,
    e.allDay ? 1 : 0,
    e.busy ? 1 : 0,
    e.eventType,
    e.selfResponse,
    e.attendeeCount,
    e.organizerSelf ? 1 : 0,
    e.recurringId,
    e.colorId,
    e.etag,
    e.updated,
    JSON.stringify(e.privateProps),
    JSON.stringify(e.attendees),
    JSON.stringify(e.responses ?? {}),
    e.conference ?? "",
    e.rsvpNote ?? "",
    e.privateProps.tl === "1" && e.alerts ? 1 : 0,
    e.visibility,
    e.organizerEmail ?? "",
    e.series ? JSON.stringify(e.series) : "",
  );
}

/** Pulls changes for one calendar, `ahead` into the future. Returns the number of changed events. */
export async function pullEvents(
  db: Db,
  provider: CalendarProvider,
  calendarId: string,
  now: number,
  ahead = WINDOW_FUTURE,
): Promise<number> {
  const cal = one<CalendarRow>(db, "SELECT * FROM calendars WHERE id = ?", calendarId);
  if (!cal) return 0;
  const stale = (cal.window_end ?? 0) < now + ahead - (WINDOW_FUTURE - WINDOW_REFRESH);
  const windowStart = stale ? now - WINDOW_PAST : (cal.window_start as number);
  const windowEnd = stale ? now + ahead : (cal.window_end as number);
  const read = async (syncToken: string | null) =>
    provider.listEvents(cal.provider_id, { syncToken, timeMin: windowStart, timeMax: windowEnd });
  let changes: Awaited<ReturnType<typeof read>>;
  try {
    changes = await read(stale ? null : cal.sync_token);
  } catch (err) {
    if (!(err instanceof ProviderError && err.kind === "sync_token_expired")) throw err;
    changes = await read(null);
  }
  tx(db, () => {
    if (changes.full) run(db, "DELETE FROM events WHERE calendar_id = ?", cal.id);
    for (const e of changes.events) cacheEvent(db, cal.id, e);
    run(
      db,
      `UPDATE calendars SET sync_token = ?, window_start = ?, window_end = ?, synced_at = ? WHERE id = ?`,
      changes.nextSyncToken,
      windowStart,
      windowEnd,
      now,
      cal.id,
    );
  });
  return changes.events.length;
}
