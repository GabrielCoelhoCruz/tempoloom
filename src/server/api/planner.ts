import { Hono } from "hono";
import { z } from "zod";
import { CATEGORIES, type Category } from "../../scheduler/categories.ts";
import type { AppEnv } from "../app.ts";
import { logChange } from "../change-log.ts";
import { all, type Db, one, run } from "../db.ts";
import { jsonBody, notFound } from "../http.ts";
import { type CachedEvent, categoryContext, externalCategory } from "../planner/categories.ts";
import { stripMarker, withState } from "../planner/markers.ts";
import { mirrorKey, mirrorSource } from "../planner/mirror.ts";
import { MANAGED_PROP, type ManagedRow, rowWrite } from "../planner/push.ts";
import { getSettings } from "../settings.ts";
import { moveTaskStart } from "../sync/edits.ts";
import { cacheEvent } from "../sync/pull.ts";
import type { SyncService } from "../sync/service.ts";

export interface PlannerEvent {
  id: string;
  /** External events: the detected or chosen category (events-categories-and-colors.md). */
  category?: Category;
  /** The category the user chose for this event, if any (rule 4). */
  manualCategory: Category | null;
  /** External events: the stored priority (1 when never lowered). */
  level?: number;
  /** Why the priority of an external event cannot change; absent when it can. */
  levelFixed?: "booking-link" | "mirrored" | "other-calendar";
  recurring?: boolean;
  /** External events: the calendar and the calendars that hold its mirror copies (mirroring rule 33). */
  calendar?: CalendarRef;
  copies?: CalendarRef[];
  start: number;
  end: number;
  title: string;
  kind: string;
  busy: boolean;
  locked: boolean;
  movable: boolean;
  sourceId: string | null;
  /** Markdown notes of the event (planning-event-content.md CNT-12). */
  description: string;
}

/** A calendar by id, with its name for when the client has no calendar list. */
export interface CalendarRef {
  id: string;
  name: string;
}

const range = z.object({ from: z.coerce.number().int(), to: z.coerce.number().int() });

export function plannerEvents(db: Db, userId: string, from: number, to: number): PlannerEvent[] {
  const managed = all<ManagedRow>(
    db,
    `SELECT * FROM managed_events WHERE user_id = ? AND kind <> 'mirror' AND end_ms > ? AND start_ms < ?
     ORDER BY start_ms`,
    userId,
    from,
    to,
  );
  const external = all<
    CachedEvent & {
      busy: number;
      all_day: number;
      private_props: string;
      main: number;
      calendar_name: string;
    }
  >(
    db,
    `SELECT e.*, (a.is_main = 1 AND c.is_primary = 1) AS main, c.name AS calendar_name
     FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN accounts a ON a.id = c.account_id
     WHERE a.user_id = ? AND c.check_availability = 1 AND e.end_ms > ? AND e.start_ms < ?
     ORDER BY e.start_ms`,
    userId,
    from,
    to,
  );
  // The planner shows state with its own styles, so it drops the calendar title marker.
  const markers = getSettings(db, userId).markers;
  const plain = (title: string) => stripMarker(markers, title);
  const cats = categoryContext(db, userId);
  const out: PlannerEvent[] = managed.map((m) => ({
    id: m.id,
    manualCategory: cats.manual.get(`${m.calendar_id}:${m.event_id}`) ?? null,
    start: m.start_ms,
    end: m.end_ms,
    title: plain(m.title),
    kind: m.kind,
    busy: m.busy === 1,
    locked: m.locked === 1,
    movable: true,
    sourceId: m.source_id,
    description: m.description,
  }));
  const levels = new Map(
    all<{ calendar_id: string; target_id: string; level: number }>(
      db,
      "SELECT calendar_id, target_id, level FROM external_levels WHERE user_id = ?",
      userId,
    ).map((x) => [`${x.calendar_id}:${x.target_id}`, x.level]),
  );
  // Mirroring rule 33: the copies stay hidden; their source names where they are.
  const copiedTo = new Map<string, CalendarRef[]>();
  for (const m of all<{
    key: string;
    policy_id: string;
    source_calendar_id: string;
    dest_id: string;
    dest: string;
  }>(
    db,
    `SELECT m.key, p.id AS policy_id, p.source_calendar_id, d.id AS dest_id, d.name AS dest
     FROM managed_events m JOIN mirror_policies p ON p.id = m.source_id
       JOIN calendars d ON d.id = p.dest_calendar_id
     WHERE m.user_id = ? AND m.kind = 'mirror' AND m.event_id IS NOT NULL AND m.end_ms > ? AND m.start_ms < ?
     ORDER BY d.name`,
    userId,
    from,
    to,
  )) {
    const k = `${m.source_calendar_id}:${mirrorSource(m.key, m.policy_id)}`;
    copiedTo.set(k, [...(copiedTo.get(k) ?? []), { id: m.dest_id, name: m.dest }]);
  }
  for (const e of external) {
    if (e.all_day) continue;
    const props = JSON.parse(e.private_props) as Record<string, string>;
    if (props[MANAGED_PROP] === "1") continue;
    const copies = copiedTo.get(`${e.calendar_id}:${e.event_id}`) ?? [];
    out.push({
      id: `ext:${e.calendar_id}:${e.event_id}`,
      category: externalCategory(cats, e),
      manualCategory: cats.manual.get(`${e.calendar_id}:${e.event_id}`) ?? null,
      start: e.start_ms,
      end: e.end_ms,
      title: e.summary || "(busy)",
      kind: "external",
      busy: e.busy === 1,
      locked: true,
      movable: false,
      sourceId: null,
      description: e.description,
      level:
        levels.get(`${e.calendar_id}:${e.event_id}`) ??
        (e.recurring_id ? levels.get(`${e.calendar_id}:${e.recurring_id}`) : undefined) ??
        1,
      ...levelRule(e.main === 1, props, copies.length > 0),
      recurring: e.recurring_id !== null,
      calendar: { id: e.calendar_id, name: e.calendar_name },
      copies,
    });
  }
  return out.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

/**
 * External priority rule 4, booking rule 11 and mirroring rule 34: why the level
 * of an external event cannot change. A mirrored event is one item with its
 * copies (mirroring rule 33), and the copies stay P1, so its time stays P1.
 */
function levelRule(
  main: boolean,
  props: Record<string, string>,
  mirrored: boolean,
): Pick<PlannerEvent, "levelFixed"> {
  if (props.tl_booking === "1") return { levelFixed: "booking-link" };
  if (!main) return { levelFixed: "other-calendar" };
  if (mirrored) return { levelFixed: "mirrored" };
  return {};
}

export function plannerRoutes(db: Db, sync: SyncService, now: () => number): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/events", (c) => {
    const q = range.safeParse(c.req.query());
    if (!q.success || q.data.to <= q.data.from || q.data.to - q.data.from > 62 * 86_400_000) {
      return c.json({ error: "invalid_range" }, 400);
    }
    return c.json({ events: plannerEvents(db, c.get("user").id, q.data.from, q.data.to) });
  });

  r.get("/report", (c) => {
    const row = one<{ report: string; planned_at: number }>(
      db,
      "SELECT report, planned_at FROM plan_reports WHERE user_id = ?",
      c.get("user").id,
    );
    return c.json({
      report: row ? JSON.parse(row.report) : [],
      plannedAt: row?.planned_at ?? null,
    });
  });

  /** Plans now and answers when the calendars hold the new plan. */
  r.post("/sync", async (c) => {
    const user = c.get("user");
    await sync.runNow(user.id);
    await sync.idle(user.id);
    return c.json({ ok: true });
  });

  r.post("/events/:id/lock", async (c) => {
    const user = c.get("user");
    const { locked } = await jsonBody(c, z.object({ locked: z.boolean() }));
    const row = one<ManagedRow>(
      db,
      "SELECT * FROM managed_events WHERE id = ? AND user_id = ?",
      c.req.param("id"),
      user.id,
    );
    if (!row) notFound("event");
    run(
      db,
      "UPDATE managed_events SET locked = ?, user_edited = CASE WHEN ? = 0 THEN 0 ELSE user_edited END WHERE id = ?",
      locked ? 1 : 0,
      locked ? 1 : 0,
      row.id,
    );
    sync.request(user.id, 0);
    return c.json({ ok: true });
  });

  /** Rule 4: the user sets or clears the category of one event; its color follows. */
  r.post("/events/category", async (c) => {
    const user = c.get("user");
    const body = await jsonBody(
      c,
      z.object({ id: z.string(), category: z.enum(CATEGORIES).nullable() }),
    );
    let target: { calendar_id: string; event_id: string } | undefined;
    if (body.id.startsWith("ext:")) {
      const rest = body.id.slice(4);
      const cut = rest.indexOf(":");
      target = one(
        db,
        `SELECT e.calendar_id, e.event_id FROM events e JOIN calendars c ON c.id = e.calendar_id
           JOIN accounts a ON a.id = c.account_id
         WHERE a.user_id = ? AND e.calendar_id = ? AND e.event_id = ?`,
        user.id,
        rest.slice(0, cut),
        rest.slice(cut + 1),
      );
    } else {
      target = one(
        db,
        "SELECT calendar_id, event_id FROM managed_events WHERE id = ? AND user_id = ? AND event_id IS NOT NULL",
        body.id,
        user.id,
      );
    }
    if (!target) notFound("event");
    if (body.category) {
      run(
        db,
        `INSERT INTO event_categories (user_id, calendar_id, event_id, category) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, calendar_id, event_id) DO UPDATE SET category = excluded.category`,
        user.id,
        target.calendar_id,
        target.event_id,
        body.category,
      );
    } else {
      run(
        db,
        "DELETE FROM event_categories WHERE user_id = ? AND calendar_id = ? AND event_id = ?",
        user.id,
        target.calendar_id,
        target.event_id,
      );
    }
    sync.request(user.id, 0);
    return c.json({ ok: true });
  });

  /** Sets the priority of an external event on the main calendar (external priority rules 2-4, 7). */
  r.post("/external/:calendarId/:eventId/priority", async (c) => {
    const user = c.get("user");
    const { level, series } = await jsonBody(
      c,
      z.object({ level: z.number().int().min(1).max(4), series: z.boolean().default(false) }),
    );
    const ev = one<{ recurring_id: string | null; main: number; private_props: string }>(
      db,
      `SELECT e.recurring_id, e.private_props, (a.is_main = 1 AND c.is_primary = 1) AS main FROM events e JOIN calendars c ON c.id = e.calendar_id
       JOIN accounts a ON a.id = c.account_id WHERE a.user_id = ? AND e.calendar_id = ? AND e.event_id = ?`,
      user.id,
      c.req.param("calendarId"),
      c.req.param("eventId"),
    );
    const props = JSON.parse(ev?.private_props ?? "{}") as Record<string, string>;
    // Like the planner list: a managed event (a copy too) is not an external event.
    if (!ev || props[MANAGED_PROP] === "1") notFound("event");
    const mirrored = all<{ id: string }>(
      db,
      "SELECT id FROM mirror_policies WHERE user_id = ? AND source_calendar_id = ?",
      user.id,
      c.req.param("calendarId"),
    ).some((p) =>
      one(
        db,
        "SELECT 1 FROM managed_events WHERE user_id = ? AND key = ? AND event_id IS NOT NULL",
        user.id,
        mirrorKey(p.id, c.req.param("eventId")),
      ),
    );
    const fixed = levelRule(ev.main === 1, props, mirrored).levelFixed;
    if (fixed) return c.json({ error: "level_fixed", reason: fixed }, 400);
    const target = series && ev.recurring_id ? ev.recurring_id : c.req.param("eventId");
    run(
      db,
      `INSERT INTO external_levels (user_id, calendar_id, target_id, level) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, calendar_id, target_id) DO UPDATE SET level = excluded.level`,
      user.id,
      c.req.param("calendarId"),
      target,
      level,
    );
    if (series && ev.recurring_id) {
      // A series level replaces levels set on single events of that series.
      run(
        db,
        `DELETE FROM external_levels WHERE user_id = ? AND calendar_id = ? AND target_id IN
           (SELECT event_id FROM events WHERE calendar_id = ? AND recurring_id = ?)`,
        user.id,
        c.req.param("calendarId"),
        c.req.param("calendarId"),
        ev.recurring_id,
      );
    }
    return c.json({ ok: true });
  });

  /** CED-50: a drag in the planner moves the event and locks it there. */
  r.post("/events/:id/move", async (c) => {
    const { start } = await jsonBody(c, z.object({ start: z.number().int() }));
    const result = await moveManaged(db, sync, now, c.get("user").id, c.req.param("id"), start, {
      actor: c.get("actor")?.email ?? "",
      reason: "moved in the planner",
    });
    if (result === null) notFound("event");
    if (result === "started") return c.json({ error: "event_started" }, 409);
    return c.json({ ok: true });
  });

  return r;
}

/**
 * Moves a managed event to `to` with the same length and locks it there
 * (CED-50; focus-time.md rules 20 and 22). `to` is a start, or a function that
 * picks the start inside the user's exclusive section, so no plan run takes the
 * time between the choice and the move. Null: no such event; "started": it has
 * begun, so it does not move; "no_time": the function found no start.
 */
export function moveManaged(
  db: Db,
  sync: SyncService,
  now: () => number,
  userId: string,
  id: string,
  to: number | ((row: ManagedRow) => number | null),
  { actor, reason }: { actor: string; reason: string },
): Promise<"moved" | "started" | "no_time" | null> {
  const markers = getSettings(db, userId).markers;
  return sync.exclusive(userId, async (pool) => {
    const row = one<ManagedRow & { account_id: string; provider_id: string }>(
      db,
      `SELECT m.*, c.account_id, c.provider_id FROM managed_events m JOIN calendars c ON c.id = m.calendar_id
       WHERE m.id = ? AND m.user_id = ?`,
      id,
      userId,
    );
    if (!row?.event_id) return null;
    if (row.start_ms <= now()) return "started" as const;
    const start = typeof to === "number" ? to : to(row);
    if (start === null) return "no_time" as const;
    const end = start + (row.end_ms - row.start_ms);
    const title = row.user_edited ? row.title : withState(markers, row.title, "locked");
    // A meeting occurrence keeps the organizer's calendar edits (MEET-02 rule 22).
    const provider = pool.get(row.account_id);
    const ev =
      row.kind === "meeting"
        ? await provider.editExternal(
            row.provider_id,
            row.event_id,
            { start, end, summary: title, busy: true },
            row.etag,
          )
        : await provider.updateEvent(
            row.provider_id,
            row.event_id,
            rowWrite(userId, row, { start, end, title, busy: true }),
            row.etag,
          );
    cacheEvent(db, row.calendar_id, ev);
    logChange(
      db,
      userId,
      {
        calendarId: row.calendar_id,
        eventId: row.event_id,
        key: row.key,
        action: "update",
        item: `${row.kind}:${row.source_id}`,
        reason,
        title,
        start,
        end,
        actor: actor,
      },
      now(),
    );
    if (row.kind === "task") {
      run(
        db,
        "INSERT INTO item_exclusions (user_id, kind, item_id, start_ms, end_ms) VALUES (?, 'task', ?, ?, ?)",
        userId,
        row.source_id,
        row.start_ms,
        row.end_ms,
      );
      moveTaskStart(db, userId, row, start);
    }
    run(
      db,
      "UPDATE managed_events SET start_ms = ?, end_ms = ?, title = ?, busy = 1, locked = 1, etag = ? WHERE id = ?",
      start,
      end,
      title,
      ev.etag,
      row.id,
    );
    return "moved" as const;
  });
}
