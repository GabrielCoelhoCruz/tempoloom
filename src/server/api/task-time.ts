// Time on tasks: the timer with its stop dialog (planning-task-progress.md
// PRG-30 to PRG-32) and work blocks on request as a preview
// (planning-next-up.md NXT-50).
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { plan } from "../../scheduler/plan.ts";
import { MINUTE } from "../../shared/time.ts";
import type { AppEnv } from "../app.ts";
import { type Db, one, run } from "../db.ts";
import { jsonBody, notFound } from "../http.ts";
import { eventTitle, placementState } from "../planner/markers.ts";
import { openTasks } from "../planner/now.ts";
import { eventDescription, loadSnapshot, writeCalendar } from "../planner/replan.ts";
import {
  type LockedEvent,
  nextChunkIndex,
  writableCalendar,
  writableCalendars,
  writeLocked,
} from "../planner/write.ts";
import { getSettings } from "../settings.ts";
import type { SyncService } from "../sync/service.ts";
import { planningZone } from "../travel.ts";

type Kind = "task" | "habit";

interface Item {
  title: string;
  notes: string;
  hours_set_id: string;
}

const LOCKED = { locked: true, conflict: false, busy: true } as const;

export function taskTimeRoutes(
  db: Db,
  sync: SyncService,
  baseUrl: string,
  now: () => number,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  const item = (userId: string, kind: Kind, id: string) =>
    one<Item>(
      db,
      `SELECT title, notes, hours_set_id FROM ${kind === "task" ? "tasks" : "habits"} WHERE id = ? AND user_id = ?`,
      id,
      userId,
    );
  /** Task chunks go to the calendar of their hours set (TSK-50); the rest to the main calendar. */
  const defaultCalendar = (userId: string, kind: Kind, it: Item) => {
    const chosen =
      kind === "task"
        ? one<{ task_calendar_id: string | null }>(
            db,
            "SELECT task_calendar_id FROM hours_sets WHERE id = ?",
            it.hours_set_id,
          )?.task_calendar_id
        : null;
    return (
      (chosen ? writableCalendar(db, userId, chosen)?.id : undefined) ??
      writeCalendar(db, userId)?.id
    );
  };

  // ---------------------------------------------------------------- timer
  const timerOf = (userId: string) =>
    one<{ kind: Kind; item_id: string; started_at: number }>(
      db,
      "SELECT kind, item_id, started_at FROM item_timers WHERE user_id = ?",
      userId,
    );

  r.get("/timer", (c) => {
    const user = c.get("user");
    const t = timerOf(user.id);
    const it = t && item(user.id, t.kind, t.item_id);
    if (!t || !it) return c.json({ timer: null });
    return c.json({
      timer: {
        kind: t.kind,
        itemId: t.item_id,
        title: it.title,
        startedAt: t.started_at,
        minutes: Math.max(1, Math.round((now() - t.started_at) / MINUTE)),
        calendars: writableCalendars(db, user.id),
        calendarId: defaultCalendar(user.id, t.kind, it) ?? null,
      },
    });
  });

  r.post("/timer", async (c) => {
    const user = c.get("user");
    const body = await jsonBody(
      c,
      z.object({ kind: z.enum(["task", "habit"]), itemId: z.string() }),
    );
    if (!item(user.id, body.kind, body.itemId)) notFound(body.kind);
    if (timerOf(user.id))
      return c.json({ error: "timer_running", message: "Stop the running timer first." }, 409);
    run(
      db,
      "INSERT INTO item_timers (user_id, kind, item_id, started_at) VALUES (?, ?, ?, ?)",
      user.id,
      body.kind,
      body.itemId,
      now(),
    );
    return c.json({ ok: true }, 201);
  });

  /** PRG-31: discard the record. */
  r.delete("/timer", (c) => {
    const user = c.get("user");
    run(db, "DELETE FROM item_timers WHERE user_id = ?", user.id);
    return c.body(null, 204);
  });

  /** PRG-31, PRG-32: the user applies the record; it becomes a past event on the chosen calendar. */
  r.post("/timer/log", async (c) => {
    const user = c.get("user");
    const body = await jsonBody(
      c,
      z.object({
        minutes: z
          .number()
          .int()
          .min(1)
          .max(24 * 60),
        calendarId: z.string(),
        markDone: z.boolean().default(false),
      }),
    );
    const t = timerOf(user.id);
    if (!t) notFound("timer");
    const it = item(user.id, t.kind, t.item_id);
    if (!it) notFound(t.kind);
    if (!writableCalendar(db, user.id, body.calendarId)) notFound("calendar");
    const end = Math.floor(now() / MINUTE) * MINUTE;
    const event: LockedEvent = {
      key: `${t.kind}:${t.item_id}:log-${randomUUID().slice(0, 8)}`,
      kind: t.kind,
      sourceId: t.item_id,
      start: end - body.minutes * MINUTE,
      end,
      title: it.title,
      description: eventDescription(it.notes, baseUrl, t.kind, t.item_id),
    };
    await writeLocked(db, sync, user.id, body.calendarId, [event]);
    run(db, "DELETE FROM item_timers WHERE user_id = ?", user.id);
    if (body.markDone && t.kind === "task")
      run(
        db,
        "UPDATE tasks SET status = 'done', rules_changed_at = ? WHERE id = ?",
        now(),
        t.item_id,
      );
    sync.request(user.id, 0);
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- work blocks
  /** NXT-50: the blocks the scheduler would place for this task now; nothing is written. */
  r.post("/tasks/:id/blocks/preview", (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const task = openTasks(db, user.id, now()).find((t) => t.id === id);
    if (!task) notFound("task");
    const settings = getSettings(db, user.id);
    const last =
      one<{ planned_at: number }>(
        db,
        "SELECT planned_at FROM plan_reports WHERE user_id = ?",
        user.id,
      )?.planned_at ?? 0;
    const { snapshot } = loadSnapshot(
      db,
      user.id,
      planningZone(db, user.id),
      settings,
      now(),
      last,
    );
    snapshot.tasks = snapshot.tasks.map((t) =>
      t.id === id ? { ...t, remainingMinutes: task.remaining, changed: true } : t,
    );
    const fixed = new Set(snapshot.current.filter((p) => p.locked).map((p) => p.key));
    const blocks = plan(snapshot)
      .placements.filter((p) => p.kind === "task" && p.itemId === id && !fixed.has(p.key))
      .map((p) => ({ start: p.start, end: p.end }));
    return c.json({ title: task.title, blocks });
  });

  r.post("/tasks/:id/blocks", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const { blocks } = await jsonBody(
      c,
      z.object({
        blocks: z
          .array(z.object({ start: z.number().int(), end: z.number().int() }))
          .min(1)
          .max(20),
      }),
    );
    const it = item(user.id, "task", id);
    if (!it) notFound("task");
    const t = now();
    for (const b of blocks)
      if (b.end <= b.start || b.start < t - MINUTE || b.end - b.start > 24 * 60 * MINUTE)
        return c.json({ error: "invalid_block", message: "A block must lie in the future." }, 400);
    const calendarId = defaultCalendar(user.id, "task", it);
    if (!calendarId) notFound("calendar");
    const settings = getSettings(db, user.id);
    let n = nextChunkIndex(db, user.id, id);
    await writeLocked(
      db,
      sync,
      user.id,
      calendarId,
      blocks.map((b) => ({
        key: `task:${id}:${n++}`,
        kind: "task" as const,
        sourceId: id,
        start: b.start,
        end: b.end,
        title: eventTitle(settings.markers, {
          state: placementState("task", LOCKED),
          title: it.title,
        }),
        description: eventDescription(it.notes, baseUrl, "task", id),
      })),
    );
    return c.json({ ok: true }, 201);
  });

  return r;
}
