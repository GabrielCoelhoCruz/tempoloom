// Categories and colors of events (docs/specs/events-categories-and-colors.md).
import { type Category, categoryOf } from "../../scheduler/categories.ts";
import { all, type Db, one, run } from "../db.ts";
import type { CalendarProvider } from "../providers/types.ts";
import type { Settings } from "../settings.ts";
import { cacheEvent } from "../sync/pull.ts";
import { MANAGED_PROP } from "./push.ts";

const DAY = 86_400_000;

export interface CategoryContext {
  userEmail: string;
  /** Manual categories by `calendarId:eventId` (rule 4). */
  manual: Map<string, Category>;
  /** Calendars whose events are personal: sources of a mirroring policy of type personal. */
  personalCalendars: Set<string>;
}

export function categoryContext(db: Db, userId: string): CategoryContext {
  return {
    userEmail:
      one<{ email: string }>(db, "SELECT email FROM users WHERE id = ?", userId)?.email ?? "",
    manual: new Map(
      all<{ calendar_id: string; event_id: string; category: Category }>(
        db,
        "SELECT calendar_id, event_id, category FROM event_categories WHERE user_id = ?",
        userId,
      ).map((m) => [`${m.calendar_id}:${m.event_id}`, m.category]),
    ),
    personalCalendars: new Set(
      all<{ source_calendar_id: string }>(
        db,
        "SELECT source_calendar_id FROM mirror_policies WHERE user_id = ? AND calendar_type = 'personal'",
        userId,
      ).map((p) => p.source_calendar_id),
    ),
  };
}

export interface CachedEvent {
  calendar_id: string;
  event_id: string;
  summary: string;
  description: string;
  start_ms: number;
  end_ms: number;
  event_type: string;
  attendees: string;
  recurring_id: string | null;
}

/** The category of an external event from the cache. */
export function externalCategory(ctx: CategoryContext, e: CachedEvent): Category {
  return categoryOf(
    {
      title: e.summary,
      description: e.description,
      start: e.start_ms,
      end: e.end_ms,
      eventType: e.event_type,
      attendees: JSON.parse(e.attendees) as string[],
      managedKind: null,
      personalCalendar: ctx.personalCalendars.has(e.calendar_id),
      manual:
        ctx.manual.get(`${e.calendar_id}:${e.event_id}`) ??
        (e.recurring_id ? ctx.manual.get(`${e.calendar_id}:${e.recurring_id}`) : undefined) ??
        null,
    },
    ctx.userEmail,
  );
}

/** The color id a category gets, or null for the calendar's own color. */
export function colorFor(settings: Settings, category: Category): string | null {
  const c = settings.categoryColors[category];
  return !c || c === "calendar_default" ? null : c;
}

/**
 * Rule 7: with the scope "all events", paints external events on the user's
 * writable calendars, from 90 days back to the end of the window. Only the
 * color changes. Events the server refuses are skipped (rule 10).
 */
export async function paintExternal(
  db: Db,
  userId: string,
  settings: Settings,
  provider: (accountId: string) => CalendarProvider,
  now: number,
  windowEnd: number,
): Promise<number> {
  if (settings.colorScope !== "all_events") return 0;
  const ctx = categoryContext(db, userId);
  const rows = all<
    CachedEvent & {
      color_id: string | null;
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
     ORDER BY e.start_ms`,
    userId,
    now - 90 * DAY,
    windowEnd,
  );
  const done = new Set<string>();
  let painted = 0;
  for (const e of rows) {
    const props = JSON.parse(e.private_props) as Record<string, string>;
    if (props[MANAGED_PROP] === "1" || props.tl_booking === "1") continue;
    const color = colorFor(settings, externalCategory(ctx, e));
    if ((e.color_id ?? null) === color) continue;
    // A series is painted once, as a whole.
    const target = e.recurring_id ?? e.event_id;
    if (done.has(`${e.calendar_id}:${target}`)) continue;
    done.add(`${e.calendar_id}:${target}`);
    try {
      const ev = await provider(e.account_id).setColor(
        e.provider_id,
        target,
        color,
        e.recurring_id ? null : e.etag,
      );
      if (e.recurring_id) {
        run(
          db,
          "UPDATE events SET color_id = ? WHERE calendar_id = ? AND recurring_id = ?",
          color,
          e.calendar_id,
          e.recurring_id,
        );
      } else cacheEvent(db, e.calendar_id, ev);
      painted++;
    } catch {
      // Rule 10: some events cannot change color; painting never stops a run (rule 16).
    }
  }
  return painted;
}
