// Team stats for every member (docs/specs/analytics-team-stats.md) and
// organization analytics for team admins, the analytics admins
// (analytics-organization.md). Read-only for calendars.
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { addDays, diffDays, type LocalDate, utcToLocal } from "../../shared/time.ts";
import { loadMemberDays } from "../analytics/member.ts";
import { teamStats } from "../analytics/metrics.ts";
import {
  MIN_GROUP,
  orgReport,
  reportCsv,
  salaries,
  saveSalaries,
  teamPeople,
} from "../analytics/org.ts";
import { isAnalyticsOnly, setAnalyticsOnly } from "../analytics/seats.ts";
import type { AppEnv } from "../app.ts";
import { all, type Db, one } from "../db.ts";
import { jsonBody } from "../http.ts";
import { membership } from "../teams.ts";

/** Personal stats rule 10: the earliest start is 12 weeks before today. */
export const HISTORY_DAYS = 84;
export const MAX_SPAN_DAYS = 120;

const range = z.object({ from: z.iso.date(), to: z.iso.date() });

export type Range = { from: LocalDate; to: LocalDate };

/** Parses and checks a range in the user's zone; returns an error response or the range. */
function parseRange(c: Context<AppEnv>, now: number): Range | Response {
  const q = range.safeParse(c.req.query());
  if (!q.success || q.data.to < q.data.from) return c.json({ error: "invalid_range" }, 400);
  if (diffDays(q.data.from, q.data.to) > MAX_SPAN_DAYS)
    return c.json({ error: "range_too_long" }, 400);
  const today = utcToLocal(c.get("user").time_zone, now).date;
  if (q.data.from < addDays(today, -HISTORY_DAYS)) return c.json({ error: "range_too_early" }, 400);
  return q.data;
}

const LEVEL_LABEL = (groupBy: string) =>
  groupBy === "" ? "company" : groupBy === "manager" ? "manager_line" : groupBy;

/**
 * Team stats of the user's team (rules 1-6), as the team stats page shows
 * them; assistant chat reads the same (src/server/assistant/library-tools.ts).
 */
export function teamStatsOf(db: Db, userId: string, range: Range, grouping: "day" | "week") {
  const people = teamPeople(db, membership(db, userId).team.id);
  const included = people.filter((p) => p.hasCalendar);
  const head = {
    included: included.length,
    withoutCalendar: people.length - included.length,
    analyticsOnly: isAnalyticsOnly(db, userId),
  };
  // Edge case 1 (proposed): fewer than 3 members show no values.
  if (included.length < MIN_GROUP) return { enough: false as const, ...head };
  const days = included.map((p) => loadMemberDays(db, p.userId, range.from, range.to));
  return { enough: true as const, ...head, ...teamStats(days, grouping) };
}

export function analyticsRoutes(db: Db, now: () => number): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const admin = (c: Context<AppEnv>) => {
    const m = membership(db, c.get("user").id);
    return m.role === "admin" ? m.team : null;
  };
  const forbidden = (c: Context<AppEnv>) => c.json({ error: "forbidden" }, 403);

  r.get("/stats/team", (c) => {
    const parsed = parseRange(c, now());
    if (parsed instanceof Response) return parsed;
    const grouping = c.req.query("grouping") === "week" ? "week" : "day";
    return c.json(teamStatsOf(db, c.get("user").id, parsed, grouping));
  });

  const orgQuery = (c: Context<AppEnv>, parsed: Range) => ({
    ...parsed,
    groupBy: c.req.query("groupBy") ?? "",
    filters: (c.req.queries("filter") ?? []).flatMap((f): [string, string][] => {
      const i = f.indexOf("=");
      return i > 0 ? [[f.slice(0, i), f.slice(i + 1)]] : [];
    }),
  });

  r.get("/analytics/org", (c) => {
    const team = admin(c);
    if (!team) return forbidden(c);
    const parsed = parseRange(c, now());
    if (parsed instanceof Response) return parsed;
    return c.json(orgReport(db, team.id, orgQuery(c, parsed)));
  });

  r.get("/analytics/org.csv", (c) => {
    const team = admin(c);
    if (!team) return forbidden(c);
    const parsed = parseRange(c, now());
    if (parsed instanceof Response) return parsed;
    const q = orgQuery(c, parsed);
    return c.body(reportCsv(orgReport(db, team.id, q), LEVEL_LABEL(q.groupBy)), 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="organization-analytics-${parsed.from}-${parsed.to}.csv"`,
    });
  });

  r.get("/analytics/settings", (c) => {
    const team = admin(c);
    if (!team) return forbidden(c);
    return c.json(salaries(db, team.id));
  });

  r.put("/analytics/settings", async (c) => {
    const team = admin(c);
    if (!team) return forbidden(c);
    const salary = z.number().int().min(1).max(10_000_000);
    const body = await jsonBody(
      c,
      z.object({ defaultSalary: salary, byDepartment: z.record(z.string().max(200), salary) }),
    );
    saveSalaries(db, team.id, body);
    return c.json({ ok: true });
  });

  r.get("/analytics/seats", (c) => {
    const team = admin(c);
    if (!team) return forbidden(c);
    return c.json(
      all<{ userId: string; name: string; email: string; analyticsOnly: number }>(
        db,
        `SELECT u.id AS userId, u.name, u.email,
           EXISTS (SELECT 1 FROM analytics_seats s WHERE s.user_id = u.id AND s.team_id = m.team_id) AS analyticsOnly
         FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? ORDER BY u.email`,
        team.id,
      ).map((s) => ({ ...s, analyticsOnly: s.analyticsOnly === 1 })),
    );
  });

  r.put("/analytics/seats/:userId", async (c) => {
    const team = admin(c);
    if (!team) return forbidden(c);
    const userId = c.req.param("userId");
    if (!one(db, "SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?", team.id, userId))
      return c.json({ error: "not_found" }, 404);
    const { analyticsOnly } = await jsonBody(c, z.object({ analyticsOnly: z.boolean() }));
    setAnalyticsOnly(db, team.id, userId, analyticsOnly, now());
    return c.json({ ok: true });
  });

  return r;
}
