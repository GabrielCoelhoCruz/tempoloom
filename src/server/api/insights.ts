// Personal stats panels by category, insights and calendar facts
// (docs/specs/analytics-personal-stats.md). Read-only (rule 11).
import { Hono } from "hono";
import { z } from "zod";
import { personalInsights } from "../analytics/personal.ts";
import type { AppEnv } from "../app.ts";
import type { Db } from "../db.ts";

export function insightRoutes(db: Db, now: () => number): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get("/stats/insights", (c) => {
    const q = z.object({ from: z.iso.date(), to: z.iso.date() }).safeParse(c.req.query());
    if (!q.success || q.data.to < q.data.from) return c.json({ error: "invalid_range" }, 400);
    if ((Date.parse(q.data.to) - Date.parse(q.data.from)) / 86_400_000 > 120)
      return c.json({ error: "range_too_long" }, 400);
    return c.json(personalInsights(db, c.get("user").id, q.data.from, q.data.to, now()));
  });
  return r;
}
