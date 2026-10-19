// Categories and colors of events (docs/specs/events-categories-and-colors.md).
import { type Category, categoryOf } from "../../scheduler/categories.ts";
import { all, type Db, one } from "../db.ts";
import type { Settings } from "../settings.ts";
import { MANAGED_PROP } from "./push.ts";
import type { Paint } from "./repaint.ts";

const DAY = 86_400_000;

export interface CategoryContext {
  userEmail: string;
  /** Manual categories by `calendarId:eventId` (rule 4). */
  manual: Map<string, Category>;
  /**
   * Calendars whose events are personal: connected calendars of category
   * personal, and sources of a mirroring policy of type personal.
   */
  personalCalendars: Set<string>;
  /** Connected calendars of category travel (accounts-connected-calendars.md rule 8). */
  travelCalendars: Set<string>;
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
        `SELECT source_calendar_id FROM mirror_policies WHERE user_id = ? AND calendar_type = 'personal'
         UNION SELECT c.id FROM calendars c JOIN accounts a ON a.id = c.account_id
         WHERE a.user_id = ? AND c.category = 'personal'`,
        userId,
        userId,
      ).map((p) => p.source_calendar_id),
    ),
    travelCalendars: new Set(
      all<{ id: string }>(
        db,
        `SELECT c.id FROM calendars c JOIN accounts a ON a.id = c.account_id
         WHERE a.user_id = ? AND c.category = 'travel'`,
        userId,
      ).map((c) => c.id),
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
  rsvp_note: string;
}

/** The category of an external event from the cache. */
export function externalCategory(ctx: CategoryContext, e: CachedEvent): Category {
  const category = categoryOf(
    {
      title: e.summary,
      description: e.description,
      rsvpNote: e.rsvp_note,
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
  // A travel calendar makes its events travel, except flights and set categories.
  return ctx.travelCalendars.has(e.calendar_id) &&
    category !== "flight" &&
    !ctx.manual.has(`${e.calendar_id}:${e.event_id}`)
    ? "travel"
    : category;
}

/** The color id a category gets, or null for the calendar's own color. */
export function colorFor(settings: Settings, category: Category): string | null {
  const c = settings.categoryColors[category];
  return !c || c === "calendar_default" ? null : c;
}

/**
 * Rule 7: with the scope "all events", the external events on the user's
 * writable calendars, from 90 days back to the end of the window, whose color
 * is not their category color. A series is painted once, as a whole.
 */
export function externalPaints(
  db: Db,
  userId: string,
  settings: Settings,
  now: number,
  windowEnd: number,
): Paint[] {
  if (settings.colorScope !== "all_events") return [];
  const ctx = categoryContext(db, userId);
  const rows = all<CachedEvent & { color_id: string | null; private_props: string }>(
    db,
    `SELECT e.* FROM events e
       JOIN calendars c ON c.id = e.calendar_id JOIN accounts a ON a.id = c.account_id
     WHERE a.user_id = ? AND a.status = 'ok' AND c.writable = 1 AND e.end_ms > ? AND e.start_ms < ?
     ORDER BY e.start_ms`,
    userId,
    now - 90 * DAY,
    windowEnd,
  );
  const done = new Set<string>();
  const out: Paint[] = [];
  for (const e of rows) {
    const props = JSON.parse(e.private_props) as Record<string, string>;
    if (props[MANAGED_PROP] === "1" || props.tl_booking === "1") continue;
    const color = colorFor(settings, externalCategory(ctx, e));
    if ((e.color_id ?? null) === color) continue;
    const target = e.recurring_id ?? e.event_id;
    if (done.has(`${e.calendar_id}:${target}`)) continue;
    done.add(`${e.calendar_id}:${target}`);
    out.push({ calendarId: e.calendar_id, eventId: target, series: !!e.recurring_id, color });
  }
  return out;
}
