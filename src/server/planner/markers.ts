// Title markers and user emoji of managed events (docs/specs/events-title-emoji.md).
import { DAY } from "../../shared/time.ts";
import { all, type Db, one, run } from "../db.ts";
import type { CalendarProvider } from "../providers/types.ts";
import type { Settings } from "../settings.ts";
import { cacheEvent } from "../sync/pull.ts";
import { type CachedEvent, categoryContext, externalCategory } from "./categories.ts";
import { MANAGED_PROP, type ManagedRow } from "./push.ts";

/** Type markers (marker table): they come before the state marker (rule 2). */
export const TRAVEL_MARKER = "🚌";
export const FLIGHT_MARKER = "✈️";
export const PERSONAL_COPY_MARKER = "🏠";
const TYPE_MARKERS = [TRAVEL_MARKER, PERSONAL_COPY_MARKER];

type Markers = Settings["markers"];
export type MarkerState = keyof Markers | null;

/** Kinds that show the free and busy markers (marker table). */
const FREE_BUSY = new Set(["habit", "task", "meeting"]);

/** Rule 2: at most one state marker, the conflict first, then the lock, then free or busy. */
export function placementState(
  kind: string,
  p: { conflict: boolean; locked: boolean; busy: boolean },
): MarkerState {
  if (p.conflict) return "conflict";
  if (p.locked) return "locked";
  if (!FREE_BUSY.has(kind)) return null;
  return p.busy ? "busy" : "free";
}

/** Rules 1-3: `<type marker> <state marker> <emoji> <title>`, one space apart. */
export function eventTitle(
  m: Markers,
  parts: { typeMarker?: string; state: MarkerState; emoji?: string; title: string },
): string {
  return [parts.typeMarker, parts.state ? m[parts.state] : "", parts.emoji, parts.title]
    .filter(Boolean)
    .join(" ");
}

/** Rule 5: the same title with another state marker; type marker, emoji and title stay. */
export function withState(m: Markers, title: string, state: MarkerState): string {
  let rest = title;
  const typeMarker = TYPE_MARKERS.find((t) => rest.startsWith(`${t} `));
  if (typeMarker) rest = rest.slice(typeMarker.length + 1);
  const old = Object.values(m).find((s) => s && rest.startsWith(`${s} `));
  if (old) rest = rest.slice(old.length + 1);
  return eventTitle(m, { ...(typeMarker ? { typeMarker } : {}), state, title: rest });
}

/** How far back ended events get the done markers. */
const DONE_WINDOW = 7 * DAY;

/**
 * Marker table: habit, flexible meeting and task chunk events that ended get
 * the done marker; a chunk of a task with work left gets the partly done one.
 * Only the title changes. Events with a title the user wrote keep it.
 */
export async function markEnded(
  db: Db,
  userId: string,
  markers: Markers,
  provider: (accountId: string) => CalendarProvider,
  now: number,
): Promise<void> {
  const rows = all<ManagedRow & { account_id: string; provider_id: string }>(
    db,
    `SELECT m.*, c.account_id, c.provider_id FROM managed_events m JOIN calendars c ON c.id = m.calendar_id
     WHERE m.user_id = ? AND m.kind IN ('habit', 'meeting', 'task') AND m.event_id IS NOT NULL
       AND m.user_edited = 0 AND m.end_ms <= ? AND m.end_ms > ?`,
    userId,
    now,
    now - DONE_WINDOW,
  );
  const workLeft = new Map<string, boolean>();
  const hasWorkLeft = (taskId: string) => {
    let left = workLeft.get(taskId);
    if (left === undefined) {
      const t = one<{ status: string; total_minutes: number; logged_minutes: number }>(
        db,
        "SELECT status, total_minutes, logged_minutes FROM tasks WHERE id = ?",
        taskId,
      );
      const used =
        one<{ m: number | null }>(
          db,
          `SELECT SUM(end_ms - start_ms) / 60000.0 AS m FROM managed_events
           WHERE user_id = ? AND kind = 'task' AND source_id = ? AND end_ms <= ?`,
          userId,
          taskId,
          now,
        )?.m ?? 0;
      left = t !== undefined && t.status === "open" && t.total_minutes - t.logged_minutes > used;
      workLeft.set(taskId, left);
    }
    return left;
  };
  for (const row of rows) {
    const state = row.kind === "task" && hasWorkLeft(row.source_id) ? "partial" : "done";
    const title = withState(markers, row.title, state);
    if (title === row.title || !row.event_id) continue;
    try {
      const ev = await provider(row.account_id).editExternal(
        row.provider_id,
        row.event_id,
        { summary: title },
        row.etag,
      );
      cacheEvent(db, row.calendar_id, ev);
      run(db, "UPDATE managed_events SET title = ?, etag = ? WHERE id = ?", title, ev.etag, row.id);
    } catch {
      // The event changed or went away since the last read: the next run tries again.
    }
  }
}

/**
 * Rule 8: a flight that the user organizes on a writable calendar gets the
 * flight marker in front of its title, once. Invitations, series and events
 * the calendar generated from mail are never renamed.
 */
export async function markFlights(
  db: Db,
  userId: string,
  provider: (accountId: string) => CalendarProvider,
  now: number,
  windowEnd: number,
): Promise<void> {
  const rows = all<
    CachedEvent & {
      etag: string | null;
      private_props: string;
      account_id: string;
      provider_id: string;
    }
  >(
    db,
    `SELECT e.*, c.account_id, c.provider_id FROM events e
       JOIN calendars c ON c.id = e.calendar_id JOIN accounts a ON a.id = c.account_id
     WHERE a.user_id = ? AND a.status = 'ok' AND c.writable = 1 AND e.end_ms > ? AND e.start_ms < ?
       AND e.all_day = 0 AND e.recurring_id IS NULL AND e.organizer_self = 1 AND e.event_type = 'default'`,
    userId,
    now,
    windowEnd,
  );
  if (rows.length === 0) return;
  const ctx = categoryContext(db, userId);
  for (const e of rows) {
    const props = JSON.parse(e.private_props) as Record<string, string>;
    if (props[MANAGED_PROP] === "1" || props.tl_booking === "1") continue;
    // "✈" with or without the emoji variation selector.
    if (e.summary.startsWith("✈") || externalCategory(ctx, e) !== "flight") continue;
    try {
      const ev = await provider(e.account_id).editExternal(
        e.provider_id,
        e.event_id,
        { summary: `${FLIGHT_MARKER} ${e.summary}` },
        e.etag,
      );
      cacheEvent(db, e.calendar_id, ev);
    } catch {
      // The calendar refused the change: the flight keeps its title.
    }
  }
}
