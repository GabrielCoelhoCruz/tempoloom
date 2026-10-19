// Saved task searches tied to focus time, habits and the meeting overload
// automation (docs/specs/planning-next-up.md NXT-40 to NXT-45). A search is a
// saved filter, not a snapshot; it never changes how events are placed.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { DAY } from "../../shared/time.ts";
import type { AppEnv } from "../app.ts";
import { all, type Db, one, run } from "../db.ts";
import { jsonBody, notFound } from "../http.ts";

export interface TaskSearch {
  id: string;
  name: string;
  keyword: string;
  due_within_days: number | null;
}

const searchInput = z.object({
  name: z.string().trim().min(1).max(100),
  keyword: z.string().trim().max(100).default(""),
  dueWithinDays: z.number().int().min(0).max(365).nullable().optional(),
});

/** The automation tables that can hold a search, by assignment kind. */
const TABLES = { habit: "habits", focus: "focus_goals", overload: "meeting_overloads" } as const;
type AssignKind = keyof typeof TABLES;

/** Open tasks that match a search, in the tasks page order (due date, then creation). */
export function matchingTasks(db: Db, userId: string, s: TaskSearch, now: number) {
  return all<{ id: string; title: string; due_at: number | null }>(
    db,
    `SELECT id, title, due_at FROM tasks WHERE user_id = ? AND status = 'open'
       AND instr(lower(title), lower(?)) > 0
       AND (? IS NULL OR (due_at IS NOT NULL AND due_at <= ?))
     ORDER BY COALESCE(due_at, 9e15), created_at`,
    userId,
    s.keyword,
    s.due_within_days,
    now + (s.due_within_days ?? 0) * DAY,
  );
}

/** The automation behind a managed event that can hold a search, and its search. */
export function assignmentOf(
  db: Db,
  userId: string,
  kind: string,
  sourceId: string,
): { kind: AssignKind; id: string; searchId: string | null } | null {
  const candidates: AssignKind[] =
    kind === "habit" ? ["habit"] : kind === "focus" ? ["focus", "overload"] : [];
  for (const k of candidates) {
    const row = one<{ task_search_id: string | null }>(
      db,
      `SELECT task_search_id FROM ${TABLES[k]} WHERE id = ? AND user_id = ?`,
      sourceId,
      userId,
    );
    if (row) return { kind: k, id: sourceId, searchId: row.task_search_id };
  }
  return null;
}

export function taskSearchRoutes(db: Db, now: () => number): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const searchOf = (userId: string, id: string) =>
    one<TaskSearch>(db, "SELECT * FROM task_searches WHERE id = ? AND user_id = ?", id, userId);

  r.get("/task-searches", (c) =>
    c.json({
      searches: all<TaskSearch>(
        db,
        "SELECT * FROM task_searches WHERE user_id = ? ORDER BY name, created_at",
        c.get("user").id,
      ),
    }),
  );

  r.post("/task-searches", async (c) => {
    const user = c.get("user");
    const body = await jsonBody(c, searchInput);
    const id = randomUUID();
    run(
      db,
      `INSERT INTO task_searches (id, user_id, name, keyword, due_within_days, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      user.id,
      body.name,
      body.keyword,
      body.dueWithinDays ?? null,
      now(),
    );
    return c.json({ search: searchOf(user.id, id) }, 201);
  });

  r.delete("/task-searches/:id", (c) => {
    run(
      db,
      "DELETE FROM task_searches WHERE id = ? AND user_id = ?",
      c.req.param("id"),
      c.get("user").id,
    );
    return c.body(null, 204);
  });

  r.get("/task-searches/:id/tasks", (c) => {
    const user = c.get("user");
    const s = searchOf(user.id, c.req.param("id"));
    if (!s) notFound("task search");
    return c.json({ tasks: matchingTasks(db, user.id, s, now()) });
  });

  /** NXT-40: one search per habit, one per focus time automation, one for meeting overload. */
  r.put("/task-searches/assign", async (c) => {
    const user = c.get("user");
    const body = await jsonBody(
      c,
      z.object({
        kind: z.enum(["habit", "focus", "overload"]),
        id: z.string(),
        searchId: z.string().nullable(),
      }),
    );
    if (body.searchId && !searchOf(user.id, body.searchId)) notFound("task search");
    const table = TABLES[body.kind];
    if (!one(db, `SELECT 1 FROM ${table} WHERE id = ? AND user_id = ?`, body.id, user.id))
      notFound(body.kind);
    run(db, `UPDATE ${table} SET task_search_id = ? WHERE id = ?`, body.searchId, body.id);
    return c.json({ ok: true });
  });

  /** NXT-42: the tasks of the search of the habit or focus event that runs now. */
  r.get("/task-searches/current", (c) => {
    const user = c.get("user");
    const t = now();
    for (const ev of all<{
      title: string;
      kind: string;
      source_id: string;
      start_ms: number;
      end_ms: number;
    }>(
      db,
      `SELECT title, kind, source_id, start_ms, end_ms FROM managed_events
       WHERE user_id = ? AND kind IN ('habit', 'focus') AND start_ms <= ? AND end_ms > ?
       ORDER BY start_ms, id`,
      user.id,
      t,
      t,
    )) {
      const a = assignmentOf(db, user.id, ev.kind, ev.source_id);
      const s = a?.searchId ? searchOf(user.id, a.searchId) : undefined;
      if (!s) continue;
      const title = one<{ title: string }>(
        db,
        `SELECT title FROM ${TABLES[a?.kind ?? "habit"]} WHERE id = ?`,
        ev.source_id,
      )?.title;
      return c.json({
        current: {
          title: title ?? ev.title,
          start: ev.start_ms,
          end: ev.end_ms,
          search: { id: s.id, name: s.name },
          tasks: matchingTasks(db, user.id, s, t),
        },
      });
    }
    return c.json({ current: null });
  });

  return r;
}
