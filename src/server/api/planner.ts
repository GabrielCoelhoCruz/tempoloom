import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { all, type Db } from "../db.ts";
import { MANAGED_PROP } from "../planner/push.ts";

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

const range = z.object({
  from: z.coerce.number().int(),
  to: z.coerce.number().int(),
});

export function plannerEvents(db: Db, userId: string, from: number, to: number): PlannerEvent[] {
  const managed = all<{
    id: string;
    kind: string;
    source_id: string;
    start_ms: number;
    end_ms: number;
    title: string;
    busy: number;
    locked: number;
  }>(
    db,
    `SELECT id, kind, source_id, start_ms, end_ms, title, busy, locked FROM managed_events
     WHERE user_id = ? AND end_ms > ? AND start_ms < ? ORDER BY start_ms`,
    userId,
    from,
    to,
  );
  const external = all<{
    calendar_id: string;
    google_id: string;
    start_ms: number;
    end_ms: number;
    summary: string;
    busy: number;
    all_day: number;
    private_props: string;
  }>(
    db,
    `SELECT e.calendar_id, e.google_id, e.start_ms, e.end_ms, e.summary, e.busy, e.all_day, e.private_props
     FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN google_accounts a ON a.id = c.account_id
     WHERE a.user_id = ? AND c.check_availability = 1 AND e.end_ms > ? AND e.start_ms < ?
     ORDER BY e.start_ms`,
    userId,
    from,
    to,
  );
  const out: PlannerEvent[] = managed.map((m) => ({
    id: m.id,
    start: m.start_ms,
    end: m.end_ms,
    title: m.title,
    kind: m.kind,
    busy: m.busy === 1,
    locked: m.locked === 1,
    movable: true,
    sourceId: m.source_id,
  }));
  for (const e of external) {
    if (e.all_day) continue;
    const props = JSON.parse(e.private_props) as Record<string, string>;
    if (props[MANAGED_PROP] === "1") continue;
    out.push({
      id: `ext:${e.calendar_id}:${e.google_id}`,
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

export function plannerRoutes(db: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get("/events", (c) => {
    const q = range.safeParse(c.req.query());
    if (!q.success || q.data.to <= q.data.from || q.data.to - q.data.from > 62 * 86_400_000) {
      return c.json({ error: "invalid_range" }, 400);
    }
    return c.json({ events: plannerEvents(db, c.get("user").id, q.data.from, q.data.to) });
  });
  return r;
}
