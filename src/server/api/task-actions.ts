// Actions on tasks from the task list: bulk edit (planning-tasks.md TSK-45)
// and snooze (TSK-24).
import { Hono } from "hono";
import { z } from "zod";
import type { WeeklyHours } from "../../scheduler/hours.ts";
import type { AppEnv } from "../app.ts";
import { all, type Db, one, run, tx } from "../db.ts";
import { jsonBody, notFound } from "../http.ts";
import { getSettings } from "../settings.ts";
import { SNOOZE_CHOICES, snoozeUntil } from "../snooze.ts";
import type { SyncService } from "../sync/service.ts";
import { markTaskDone, taskOrderChanged } from "../task-order.ts";
import { deleteTask } from "../tasks.ts";
import { planningZone } from "../travel.ts";
import { badRequest, type TaskRow } from "./items.ts";

const level = z.number().int().min(1).max(4);

export function taskActionRoutes(db: Db, sync: SyncService, now: () => number): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  /**
   * TSK-45: one change to several tasks. Bulk priority skips tasks from
   * integrations (TSK-46); all tasks are Tempoloom's. Bulk start keeps locked
   * chunks where they are (TSK-23 places only unlocked chunks again).
   */
  r.post("/tasks/bulk", async (c) => {
    const user = c.get("user");
    const body = await jsonBody(
      c,
      z.object({
        ids: z.array(z.string()).min(1).max(500),
        change: z.discriminatedUnion("action", [
          z.object({ action: z.literal("level"), level }),
          z.object({ action: z.literal("start"), startAfter: z.number().int() }),
          z.object({ action: z.literal("due"), dueAt: z.number().int().nullable() }),
          z.object({ action: z.literal("done") }),
          z.object({ action: z.literal("delete") }),
        ]),
      }),
    );
    const rows = all<TaskRow>(
      db,
      `SELECT * FROM tasks WHERE user_id = ? AND id IN (${body.ids.map(() => "?").join(", ")})`,
      user.id,
      ...body.ids,
    );
    const ch = body.change;
    if (rows.length === 0) return c.json({ ok: true, count: 0 });
    if (ch.action === "delete") {
      for (const task of rows) await deleteTask(db, sync, user.id, task.id);
      return c.json({ ok: true, count: rows.length });
    }
    // Edge case 6: the due date stays after the start date.
    if (ch.action === "start" || ch.action === "due")
      for (const task of rows) {
        const startAfter = ch.action === "start" ? ch.startAfter : task.start_after;
        const dueAt = ch.action === "due" ? ch.dueAt : task.due_at;
        if (dueAt !== null && dueAt <= startAfter)
          badRequest("dueAt", `Due date must be after the start date (${task.title})`);
      }
    const t = now();
    if (ch.action === "done") {
      // TSK-40 and NXT-11: a done task leaves the next-up queue.
      tx(db, () => {
        for (const task of rows) markTaskDone(db, task.id, t);
      });
      sync.request(user.id);
      return c.json({ ok: true, count: rows.length });
    }
    const [column, value] =
      ch.action === "level"
        ? ["level", ch.level]
        : ch.action === "start"
          ? ["start_after", ch.startAfter]
          : ["due_at", ch.dueAt];
    tx(db, () => {
      // PRI-50: a level change is a task order change.
      if (ch.action === "level")
        for (const task of rows) taskOrderChanged(db, user.id, task.id, ch.level > task.level, t);
      run(
        db,
        `UPDATE tasks SET ${column} = ?, rules_changed_at = ? WHERE id IN (${rows.map(() => "?").join(", ")})`,
        value,
        t,
        ...rows.map((r) => r.id),
      );
    });
    sync.request(user.id);
    return c.json({ ok: true, count: rows.length });
  });

  /**
   * TSK-24: snooze moves the whole task later. It sets the start date,
   * unlocks the future chunks ("snoozed chunks are not locked"; a started
   * chunk stays), and the next plan places them again. When the new start
   * reaches the due date, the due date moves too and keeps its distance from
   * the start (edge case 6: the start is never after the due date).
   */
  r.post("/tasks/:id/snooze", async (c) => {
    const user = c.get("user");
    const body = await jsonBody(
      c,
      z.union([
        z.object({ choice: z.enum(SNOOZE_CHOICES) }),
        z.object({ until: z.number().int() }),
      ]),
    );
    const task = one<TaskRow>(
      db,
      "SELECT * FROM tasks WHERE id = ? AND user_id = ?",
      c.req.param("id"),
      user.id,
    );
    if (!task) notFound("task");
    if (task.status === "done") badRequest("id", "A done task cannot be snoozed");
    const t = now();
    let until: number;
    if ("until" in body) until = body.until;
    else {
      const weekly = JSON.parse(
        one<{ weekly: string }>(db, "SELECT weekly FROM hours_sets WHERE id = ?", task.hours_set_id)
          ?.weekly ?? "{}",
      ) as WeeklyHours;
      until = snoozeUntil(
        body.choice,
        t,
        planningZone(db, user.id),
        weekly,
        getSettings(db, user.id).weekStart,
      );
    }
    if (until <= t) badRequest("until", "Pick a later time");
    const dueAt =
      task.due_at !== null && task.due_at <= until
        ? until + (task.due_at - task.start_after)
        : task.due_at;
    tx(db, () => {
      run(
        db,
        "UPDATE tasks SET start_after = ?, due_at = ?, rules_changed_at = ? WHERE id = ?",
        until,
        dueAt,
        t,
        task.id,
      );
      run(
        db,
        `UPDATE managed_events SET locked = 0, user_edited = 0
         WHERE user_id = ? AND kind = 'task' AND source_id = ? AND start_ms > ?`,
        user.id,
        task.id,
        t,
      );
    });
    sync.request(user.id);
    return c.json({ task: one<TaskRow>(db, "SELECT * FROM tasks WHERE id = ?", task.id) });
  });

  return r;
}
