// Writes the desired managed events to calendars: creates, moves and deletes
// events so that the calendars match the plan. Unchanged events get no write.
import { randomUUID } from "node:crypto";
import { logManaged, pruneChangeLog } from "../change-log.ts";
import { all, type Db, one, run } from "../db.ts";
import { type CalendarProvider, type EventWrite, ProviderError } from "../providers/types.ts";
import { cacheEvent } from "../sync/pull.ts";
import { ACTIVE } from "./mirror.ts";

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
  reminders?: EventWrite["reminders"];
  visibility?: EventWrite["visibility"];
  allDayDates?: EventWrite["allDayDates"];
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
  /** Buffers: the length the user gave this event in the calendar (buffers rule 14). */
  kept_minutes: number | null;
}

/** Guests, location, reminders and visibility as stored in `managed_events.extra`. */
const extraOf = (d: DesiredEvent) =>
  d.attendees || d.optionalAttendees || d.location || d.reminders || d.visibility || d.allDayDates
    ? JSON.stringify({
        location: d.location ?? "",
        attendees: d.attendees ?? [],
        optional: d.optionalAttendees ?? [],
        ...(d.organizer ? { organizer: d.organizer } : {}),
        ...(d.reminders ? { reminders: d.reminders } : {}),
        ...(d.visibility ? { visibility: d.visibility } : {}),
        ...(d.allDayDates ? { allDayDates: d.allDayDates } : {}),
      })
    : "";

/**
 * The write of a managed event as it is stored, with a new time, title or
 * status: for changes outside a plan run, such as a drag in the planner.
 */
export function rowWrite(
  userId: string,
  row: ManagedRow,
  change: { start: number; end: number; title: string; busy: boolean },
): EventWrite {
  const x = (row.extra ? JSON.parse(row.extra) : {}) as {
    location?: string;
    attendees?: string[];
    optional?: string[];
    organizer?: string;
    reminders?: DesiredEvent["reminders"];
    visibility?: DesiredEvent["visibility"];
    allDayDates?: DesiredEvent["allDayDates"];
  };
  return write(userId, {
    key: row.key,
    kind: row.kind,
    sourceId: row.source_id,
    calendarId: row.calendar_id,
    ...change,
    description: row.description,
    colorId: row.color_id,
    ...(x.location ? { location: x.location } : {}),
    ...(x.attendees?.length ? { attendees: x.attendees } : {}),
    ...(x.optional?.length ? { optionalAttendees: x.optional } : {}),
    ...(x.organizer ? { organizer: x.organizer } : {}),
    ...(x.reminders ? { reminders: x.reminders } : {}),
    ...(x.visibility ? { visibility: x.visibility } : {}),
    ...(x.allDayDates ? { allDayDates: x.allDayDates } : {}),
  });
}

export interface PushContext {
  db: Db;
  userId: string;
  /** Provider and provider calendar id for one of our calendar ids. */
  target: (calendarId: string) => { provider: CalendarProvider; providerCalendarId: string };
  now: number;
  /** Also compare the time and color of mirroring copies with the calendar (full reconcile). */
  fullCheck?: boolean;
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
    ...(d.reminders ? { reminders: d.reminders } : {}),
    ...(d.visibility ? { visibility: d.visibility } : {}),
    ...(d.allDayDates ? { allDayDates: d.allDayDates } : {}),
  };
}

interface Cached {
  summary: string;
  description: string;
  busy: number;
  etag: string | null;
  start_ms: number;
  end_ms: number;
  color_id: string | null;
  alerts: number;
  visibility: string;
}

/**
 * Whether a managed event needs a write: "plan" when Tempoloom's own values
 * changed, "drift" when only the calendar copy drifted (a user edit that does
 * not lock), or null.
 */
function differs(
  row: ManagedRow,
  cached: Cached | undefined,
  d: DesiredEvent,
  fullCheck: boolean,
): "plan" | "drift" | null {
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
    return "plan";
  }
  if (row.kind === "mirror" && cached) {
    // A copy never alerts (mirroring rule 30).
    if (cached.alerts) return "plan";
    // The full reconcile also puts back a copy's time and color (rules 38, 39).
    if (
      fullCheck &&
      (cached.start_ms !== d.start ||
        cached.end_ms !== d.end ||
        (cached.color_id ?? null) !== (d.colorId ?? null))
    )
      return "plan";
  }
  // The calendar copy drifted (a user edit that does not lock): write it back.
  // A meeting occurrence also gets its privacy back (MEET-02 rule 22).
  return cached !== undefined &&
    (cached.summary !== d.title ||
      cached.description !== d.description ||
      Boolean(cached.busy) !== d.busy ||
      (row.kind === "meeting" && d.visibility !== undefined && cached.visibility !== d.visibility))
    ? "drift"
    : null;
}

/**
 * Makes the user's future managed events equal to `desired`. Events that
 * have started are never changed. Locked events are never moved or deleted.
 * Writes run in the order deletes, updates, creates.
 */
export async function pushSchedule(
  ctx: PushContext,
  allDesired: DesiredEvent[],
): Promise<PushResult> {
  const { db, userId, now } = ctx;
  const result: PushResult = { created: 0, updated: 0, deleted: 0, conflicts: 0 };
  // Calendars of a disconnected account are neither read nor written
  // (accounts-login-emails-permissions.md rule 16): their events stay as they are.
  const frozen = new Set(
    all<{ id: string }>(
      db,
      `SELECT c.id FROM calendars c JOIN accounts a ON a.id = c.account_id
       WHERE a.user_id = ? AND a.status <> 'ok'`,
      userId,
    ).map((c) => c.id),
  );
  // Copies of a paused mirroring policy stay as they are too.
  const paused = new Set(
    all<{ id: string }>(
      db,
      `SELECT p.id FROM mirror_policies p WHERE p.user_id = ? AND NOT ${ACTIVE}`,
      userId,
    ).map((p) => p.id),
  );
  const rows = all<ManagedRow>(
    db,
    "SELECT * FROM managed_events WHERE user_id = ? AND end_ms > ?",
    userId,
    now,
  ).filter((r) => !frozen.has(r.calendar_id) && !(r.kind === "mirror" && paused.has(r.source_id)));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const wanted = new Set(allDesired.map((d) => d.key));
  const desired = allDesired.filter((d) => !frozen.has(d.calendarId));

  for (const row of rows) {
    if (wanted.has(row.key) || row.locked || row.start_ms <= now) continue;
    await deleteRemote(ctx, row);
    run(db, "DELETE FROM managed_events WHERE id = ?", row.id);
    if (row.event_id)
      logManaged(db, userId, managedRef(row, row.event_id), "delete", plain(row), now);
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
      `SELECT summary, description, busy, etag, start_ms, end_ms, color_id, alerts, visibility
       FROM events WHERE calendar_id = ? AND event_id = ?`,
      row.calendar_id,
      row.event_id,
    );
    const change = differs(row, cached, d, ctx.fullCheck ?? false);
    if (!change) continue;
    const { provider, providerCalendarId } = ctx.target(row.calendar_id);
    const etag = cached?.etag ?? row.etag;
    // A meeting occurrence that only drifted gets back its free/busy and privacy
    // alone: the organizer's other edits stay (MEET-02 rule 22). The title and
    // description are already Tempoloom's values (a title edit is kept on the row).
    const patch =
      change === "drift" &&
      row.kind === "meeting" &&
      !row.event_id.includes("#") &&
      cached?.summary === d.title &&
      cached.description === d.description;
    try {
      const ev = patch
        ? await provider.editExternal(
            providerCalendarId,
            row.event_id,
            { busy: d.busy, visibility: d.visibility ?? "default" },
            etag,
          )
        : await provider.updateEvent(providerCalendarId, row.event_id, write(userId, d), etag);
      cacheEvent(db, row.calendar_id, ev);
      saveRow(db, userId, d, ev.id, ev.etag, row.id);
      const moved = row.start_ms !== d.start || row.end_ms !== d.end;
      logManaged(db, userId, desiredRef(d, ev.id), "update", { ...d, moved }, now);
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
    logManaged(db, userId, desiredRef(d, ev.id), "create", d, now);
    result.created++;
  }
  pruneChangeLog(db, now);
  return result;
}

// Change log references (docs/specs/support-troubleshooting.md rule 12).
const managedRef = (r: ManagedRow, eventId: string) => ({
  calendarId: r.calendar_id,
  eventId,
  key: r.key,
  kind: r.kind,
  sourceId: r.source_id,
});
const desiredRef = (d: DesiredEvent, eventId: string) => ({ ...d, eventId });
const plain = (r: ManagedRow) => ({ title: r.title, start: r.start_ms, end: r.end_ms });

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
