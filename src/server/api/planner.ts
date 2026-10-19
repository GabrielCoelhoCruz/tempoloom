import { Hono } from "hono";
import { z } from "zod";
import { CATEGORIES, type Category } from "../../scheduler/categories.ts";
import type { AppEnv } from "../app.ts";
import { all, type Db, one, run } from "../db.ts";
import { jsonBody, notFound } from "../http.ts";
import { type CachedEvent, categoryContext, externalCategory } from "../planner/categories.ts";
import { withState } from "../planner/markers.ts";
import { MANAGED_PROP, type ManagedRow, rowWrite } from "../planner/push.ts";
import { getSettings } from "../settings.ts";
import { cacheEvent } from "../sync/pull.ts";
import type { SyncService } from "../sync/service.ts";

export interface PlannerEvent {
  id: string;
  /** External events: the detected or chosen category (events-categories-and-colors.md). */
  category?: Category;
  /** The category the user chose for this event, if any (rule 4). */
  manualCategory: Category | null;
  /** External events: the stored priority (1 when never lowered) and whether it can change. */
  level?: number;
  levelEditable?: boolean;
  recurring?: boolean;
  start: number;
  end: number;
  title: string;
  kind: string;
  busy: boolean;
  locked: boolean;
  movable: boolean;
  sourceId: string | null;
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
      is_primary: number;
    }
  >(
    db,
    `SELECT e.*, c.is_primary
     FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN accounts a ON a.id = c.account_id
     WHERE a.user_id = ? AND c.check_availability = 1 AND e.end_ms > ? AND e.start_ms < ?
     ORDER BY e.start_ms`,
    userId,
    from,
    to,
  );
  // The planner shows state with its own styles, so it drops the calendar title marker.
  const markers = Object.values(getSettings(db, userId).markers).filter(Boolean);
  const plain = (title: string) => {
    for (const m of markers) if (title.startsWith(`${m} `)) return title.slice(m.length + 1);
    return title;
  };
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
  }));
  const levels = new Map(
    all<{ calendar_id: string; target_id: string; level: number }>(
      db,
      "SELECT calendar_id, target_id, level FROM external_levels WHERE user_id = ?",
      userId,
    ).map((x) => [`${x.calendar_id}:${x.target_id}`, x.level]),
  );
  for (const e of external) {
    if (e.all_day) continue;
    if ((JSON.parse(e.private_props) as Record<string, string>)[MANAGED_PROP] === "1") continue;
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
      level:
        levels.get(`${e.calendar_id}:${e.event_id}`) ??
        (e.recurring_id ? levels.get(`${e.calendar_id}:${e.recurring_id}`) : undefined) ??
        1,
      levelEditable:
        e.is_primary === 1 &&
        (JSON.parse(e.private_props) as Record<string, string>).tl_booking !== "1",
      recurring: e.recurring_id !== null,
    });
  }
  return out.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
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
    const ev = one<{ recurring_id: string | null; is_primary: number }>(
      db,
      `SELECT e.recurring_id, c.is_primary FROM events e JOIN calendars c ON c.id = e.calendar_id
       JOIN accounts a ON a.id = c.account_id WHERE a.user_id = ? AND e.calendar_id = ? AND e.event_id = ?`,
      user.id,
      c.req.param("calendarId"),
      c.req.param("eventId"),
    );
    if (!ev) notFound("event");
    if (!ev.is_primary) return c.json({ error: "not_main_calendar" }, 400);
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
    const user = c.get("user");
    const { start } = await jsonBody(c, z.object({ start: z.number().int() }));
    const id = c.req.param("id");
    const markers = getSettings(db, user.id).markers;
    const result = await sync.exclusive(user.id, async (pool) => {
      const row = one<ManagedRow & { account_id: string; provider_id: string }>(
        db,
        `SELECT m.*, c.account_id, c.provider_id FROM managed_events m JOIN calendars c ON c.id = m.calendar_id
         WHERE m.id = ? AND m.user_id = ?`,
        id,
        user.id,
      );
      if (!row?.event_id) return null;
      if (row.start_ms <= now()) return "started" as const;
      const end = start + (row.end_ms - row.start_ms);
      const title = row.user_edited ? row.title : withState(markers, row.title, "locked");
      const ev = await pool
        .get(row.account_id)
        .updateEvent(
          row.provider_id,
          row.event_id,
          rowWrite(user.id, row, { start, end, title, busy: true }),
          row.etag,
        );
      cacheEvent(db, row.calendar_id, ev);
      if (row.kind === "task") {
        run(
          db,
          "INSERT INTO item_exclusions (user_id, kind, item_id, start_ms, end_ms) VALUES (?, 'task', ?, ?, ?)",
          user.id,
          row.source_id,
          row.start_ms,
          row.end_ms,
        );
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
    if (result === null) notFound("event");
    if (result === "started") return c.json({ error: "event_started" }, 409);
    return c.json({ ok: true });
  });

  return r;
}
