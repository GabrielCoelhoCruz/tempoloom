// The planner's "now" data: next-up task, current or next meeting, event
// starts for alerts, the running timer, task lists, conflicts and item links.
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { type Db, one } from "../db.ts";
import { notFound } from "../http.ts";
import {
  conflicts,
  focusSuggestions,
  itemEvent,
  nextMeeting,
  tasksPanel,
  upcomingStarts,
} from "../planner/now.ts";

const range = z.object({ from: z.coerce.number().int(), to: z.coerce.number().int() });

export function nowRoutes(db: Db, now: () => number): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/now", (c) => {
    const user = c.get("user");
    const t = now();
    const timer = one<{ kind: string; item_id: string; started_at: number; title: string }>(
      db,
      `SELECT t.kind, t.item_id, t.started_at, COALESCE(k.title, h.title) AS title FROM item_timers t
       LEFT JOIN tasks k ON t.kind = 'task' AND k.id = t.item_id
       LEFT JOIN habits h ON t.kind = 'habit' AND h.id = t.item_id
       WHERE t.user_id = ?`,
      user.id,
    );
    return c.json({
      now: t,
      nextUp: tasksPanel(db, user.id, t).nextUp,
      meeting: nextMeeting(db, user.id, t),
      starts: upcomingStarts(db, user.id, t),
      timer: timer
        ? {
            kind: timer.kind,
            itemId: timer.item_id,
            title: timer.title,
            startedAt: timer.started_at,
          }
        : null,
    });
  });

  r.get("/now/tasks", (c) => c.json(tasksPanel(db, c.get("user").id, now())));

  r.get("/now/conflicts", (c) => {
    const q = range.safeParse(c.req.query());
    if (!q.success || q.data.to <= q.data.from || q.data.to - q.data.from > 62 * 86_400_000)
      return c.json({ error: "invalid_range" }, 400);
    return c.json({ conflicts: conflicts(db, c.get("user").id, q.data.from, q.data.to) });
  });

  r.get("/now/focus/:eventId", (c) => {
    const tasks = focusSuggestions(db, c.get("user").id, c.req.param("eventId"), now());
    if (!tasks) notFound("focus event");
    return c.json({ tasks });
  });

  r.get("/now/item", (c) => {
    const ref = c.req.query("ref") ?? "";
    if (!/^(task|habit|focus):[\w-]+$/.test(ref)) return c.json({ error: "invalid_ref" }, 400);
    return c.json({ event: itemEvent(db, c.get("user").id, ref, now()) });
  });

  return r;
}
