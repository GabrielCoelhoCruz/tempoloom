import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { all, type Db, one, run } from "../db.ts";
import { jsonBody, notFound } from "../http.ts";
import { MANAGED_PROP, type ManagedRow } from "../planner/push.ts";
import { getSettings } from "../settings.ts";
import { cacheEvent } from "../sync/pull.ts";
import type { SyncService } from "../sync/service.ts";

export interface PlannerEvent {
  id: string;
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
  const external = all<{
    calendar_id: string;
    event_id: string;
    start_ms: number;
    end_ms: number;
    summary: string;
    busy: number;
    all_day: number;
    private_props: string;
  }>(
    db,
    `SELECT e.calendar_id, e.event_id, e.start_ms, e.end_ms, e.summary, e.busy, e.all_day, e.private_props
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
  const out: PlannerEvent[] = managed.map((m) => ({
    id: m.id,
    start: m.start_ms,
    end: m.end_ms,
    title: plain(m.title),
    kind: m.kind,
    busy: m.busy === 1,
    locked: m.locked === 1,
    movable: true,
    sourceId: m.source_id,
  }));
  for (const e of external) {
    if (e.all_day) continue;
    if ((JSON.parse(e.private_props) as Record<string, string>)[MANAGED_PROP] === "1") continue;
    out.push({
      id: `ext:${e.calendar_id}:${e.event_id}`,
      start: e.start_ms,
      end: e.end_ms,
      title: e.summary || "(busy)",
      kind: "external",
      busy: e.busy === 1,
      locked: true,
      movable: false,
      sourceId: null,
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
      const base = row.title.replace(/^\S+\s/, "");
      const title = row.user_edited ? row.title : `${markers.locked} ${base}`;
      const ev = await pool.get(row.account_id).updateEvent(
        row.provider_id,
        row.event_id,
        {
          summary: title,
          description: row.description,
          start,
          end,
          busy: true,
          colorId: row.color_id,
          privateProps: { [MANAGED_PROP]: "1", tl_key: row.key, tl_user: user.id },
        },
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
