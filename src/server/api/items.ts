// Tasks, buffer automations and focus goals (habits: habits.ts).
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { CATEGORIES } from "../../scheduler/categories.ts";
import {
  defaultEventSettings,
  ITEM_COLORS,
  readEventSettings,
} from "../../shared/event-settings.ts";
import { utcToLocal } from "../../shared/time.ts";
import type { AppEnv } from "../app.ts";
import { all, type Db, one, run, tx } from "../db.ts";
import { editedEventSettings, eventSettingsInput, newEventSettings } from "../event-settings.ts";
import { jsonBody, notFound } from "../http.ts";
import { createItemHours, dropItemHours, itemHoursSchema, saveItemHours } from "../item-hours.ts";
import { automationCount, limitRefusal } from "../limits.ts";
import { itemChanges } from "../planner/item-log.ts";
import { isTimeUsed, taskDoneMinutes } from "../planner/progress.ts";
import { when, zoneOf } from "../preview.ts";
import { getSettings } from "../settings.ts";
import type { SyncService } from "../sync/service.ts";
import { markTaskDone, taskOrderChanged } from "../task-order.ts";
import { createTask, deleteTask } from "../tasks.ts";
import { endRank, insertRank } from "./automations.ts";

export const level = z.number().int().min(1).max(4);
export const minutes = z
  .number()
  .int()
  .min(15)
  .max(24 * 60 * 14)
  .multipleOf(15);
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const taskInput = z.object({
  title: z.string().trim().min(1).max(255),
  notes: z.string().max(10_000).optional(),
  minutes: minutes.optional(),
  level: level.optional(),
  splitUp: z.boolean().optional(),
  minChunkMinutes: minutes.optional(),
  maxChunkMinutes: minutes.optional(),
  startAfter: z.number().int().optional(),
  dueAt: z.number().int().nullable().optional(),
  hoursSetId: z.string().optional(),
  nextUp: z.boolean().optional(),
  /** events-categories-and-colors.md rule 9: overrides the category color. */
  color: z.enum(ITEM_COLORS).optional(),
  /** planning-event-content.md CNT-20. */
  visibility: z.enum(["calendar_default", "private"]).optional(),
});
export type TaskInput = z.infer<typeof taskInput>;

export const bufferInput = z.object({
  title: z.string().trim().min(1).max(255),
  enabled: z.boolean().optional(),
  level: level.optional(),
  side: z.enum(["before", "after", "both"]),
  minutesBefore: z.number().int().min(0).max(240).optional(),
  minutesAfter: z.number().int().min(0).max(240).optional(),
  busy: z.boolean().optional(),
  filter: z
    .object({
      text: z
        .object({
          values: z.array(z.string().min(1)).min(1),
          fields: z.array(z.enum(["title", "description", "location"])),
        })
        .optional(),
      participants: z
        .object({
          op: z.enum([">=", "<=", "=", ">", "<"]),
          value: z.number().int().min(1),
        })
        .optional(),
      length: z
        .object({
          op: z.enum([">=", "<=", "=", ">", "<"]),
          minutes: z.number().int().min(1),
        })
        .optional(),
      exactTitle: z.string().optional(),
      tags: z.array(z.string().min(1)).optional(),
      travel: z.boolean().optional(),
      flight: z.boolean().optional(),
      categories: z.array(z.enum(CATEGORIES)).min(1).optional(),
      people: z.array(z.string().trim().min(1).max(320)).max(50).optional(),
      runLongerThanMinutes: z.number().int().min(1).max(1440).optional(),
    })
    .optional(),
  onConflict: z.enum(["remove", "keep_as_conflict"]).optional(),
  /** One calendar id, or null for all calendars. */
  calendarScope: z.string().nullable().optional(),
  eventSettings: eventSettingsInput.optional(),
  templateId: z.string().max(100).optional(),
});

const focusInput = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  enabled: z.boolean().optional(),
  hoursSetId: z.string().optional(),
  weeklyGoalMinutes: minutes,
  dailyMinMinutes: z.number().int().min(0).multipleOf(15).optional(),
  dailyMaxMinutes: minutes.optional(),
  minBlockMinutes: minutes.optional(),
  maxBlockMinutes: minutes.optional(),
  busy: z.boolean().optional(),
  eventSettings: eventSettingsInput.optional(),
  templateId: z.string().max(100).optional(),
  /** A one-off window instead of a named set (focus-time.md `hours`). */
  itemHours: itemHoursSchema.optional(),
  /** focus-time.md `preferred_window`; null clears it. */
  preferredWindow: z.object({ from: hhmm, to: hhmm }).nullable().optional(),
});

/** The preferred window in minutes of the day, or null; undefined when not given. */
function preferredWindow(
  w: { from: string; to: string } | null | undefined,
): [number | null, number | null] | undefined {
  if (w === undefined) return undefined;
  if (w === null) return [null, null];
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  if (m(w.from) >= m(w.to))
    badRequest("preferredWindow", "The preferred window ends before it begins");
  return [m(w.from), m(w.to)];
}

export function badRequest(field: string, message: string): never {
  throw new HTTPException(400, {
    res: Response.json(
      { error: "invalid_body", issues: [{ path: field, message }] },
      { status: 400 },
    ),
  });
}

export function hoursSetId(
  db: Db,
  userId: string,
  requested: string | undefined,
  kind: string,
): string {
  const id =
    requested ??
    one<{ id: string }>(
      db,
      "SELECT id FROM hours_sets WHERE user_id = ? AND kind = ? ORDER BY created_at LIMIT 1",
      userId,
      kind,
    )?.id;
  if (
    !id ||
    !one(
      db,
      "SELECT 1 FROM hours_sets WHERE id = ? AND user_id = ? AND item_specific = 0",
      id,
      userId,
    )
  ) {
    badRequest("hoursSetId", "Unknown hours set");
  }
  return id;
}

export interface TaskRow {
  id: string;
  title: string;
  notes: string;
  level: number;
  total_minutes: number;
  logged_minutes: number;
  min_chunk_minutes: number;
  max_chunk_minutes: number;
  start_after: number;
  due_at: number | null;
  hours_set_id: string;
  next_up_rank: number | null;
  status: "open" | "done";
  created_at: number;
  color: string;
  visibility: "calendar_default" | "private";
}

export function itemRoutes(db: Db, sync: SyncService, now: () => number): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const changed = (userId: string) => sync.request(userId);

  // ---------------------------------------------------------------- tasks
  r.get("/tasks", (c) => {
    const user = c.get("user");
    const status = c.req.query("status") === "done" ? "done" : "open";
    const tasks = all<TaskRow>(
      db,
      "SELECT * FROM tasks WHERE user_id = ? AND status = ? ORDER BY COALESCE(due_at, 9e15), created_at",
      user.id,
      status,
    );
    const last = one<{ report: string; task_order: string }>(
      db,
      "SELECT report, task_order FROM plan_reports WHERE user_id = ?",
      user.id,
    );
    const report = JSON.parse(last?.report ?? "[]") as {
      itemKind: string;
      itemId: string;
      status: string;
      reason: string;
    }[];
    // TSK-61: the order the last plan processed the tasks, urgency lifts included.
    const ranks = new Map(
      (JSON.parse(last?.task_order ?? "[]") as string[]).map((id, i) => [id, i]),
    );
    const t = now();
    const done = taskDoneMinutes(db, user.id, t);
    const manual = getSettings(db, user.id).startMode === "manual";
    return c.json({
      tasks: tasks.map((task) => {
        const chunks = all<{
          start_ms: number;
          end_ms: number;
          started: number;
        }>(
          db,
          "SELECT start_ms, end_ms, started FROM managed_events WHERE user_id = ? AND kind = 'task' AND source_id = ?",
          user.id,
          task.id,
        );
        const used = done.get(task.id) ?? 0;
        const scheduled = chunks
          .filter((ch) => ch.end_ms > t)
          .reduce((a, ch) => a + (ch.end_ms - ch.start_ms) / 60_000, 0);
        const remaining = Math.max(0, task.total_minutes - task.logged_minutes - used);
        const issue = report.find((x) => x.itemKind === "task" && x.itemId === task.id);
        const state =
          task.status === "done"
            ? "done"
            : isTimeUsed(remaining, scheduled)
              ? "time-used"
              : scheduled > 0
                ? "scheduled"
                : "unscheduled";
        return {
          ...task,
          // PRG-10, PRG-11: a chunk is running now, so Stop applies.
          // In manual start mode only a started chunk is in progress (PRG-3).
          inProgress: chunks.some(
            (ch) => ch.start_ms <= t && ch.end_ms > t && (!manual || ch.started === 1),
          ),
          schedulingRank: ranks.get(task.id) ?? null,
          scheduledMinutes: scheduled,
          remainingMinutes: remaining,
          state,
          issue: issue ?? null,
        };
      }),
    });
  });

  r.post("/tasks", async (c) => {
    const user = c.get("user");
    const body = await jsonBody(c, taskInput);
    const id = createTask(db, user, body, now());
    changed(user.id);
    return c.json({ task: one<TaskRow>(db, "SELECT * FROM tasks WHERE id = ?", id) }, 201);
  });

  r.patch("/tasks/:id", async (c) => {
    const user = c.get("user");
    const task = one<TaskRow>(
      db,
      "SELECT * FROM tasks WHERE id = ? AND user_id = ?",
      c.req.param("id"),
      user.id,
    );
    if (!task) notFound("task");
    const body = await jsonBody(c, taskInput.partial());
    const total = body.minutes ?? task.total_minutes;
    const minutesChanged = total !== task.total_minutes;
    const split = body.splitUp ?? task.min_chunk_minutes !== task.max_chunk_minutes;
    const min = split ? (body.minChunkMinutes ?? Math.min(task.min_chunk_minutes, total)) : total;
    const max = split
      ? (body.maxChunkMinutes ?? Math.min(Math.max(task.max_chunk_minutes, min), total))
      : total;
    if (min > max) badRequest("minChunkMinutes", "Minimum chunk is longer than maximum chunk");
    const startAfter = body.startAfter ?? task.start_after;
    const dueAt = body.dueAt === undefined ? task.due_at : body.dueAt;
    if (dueAt !== null && dueAt <= startAfter)
      badRequest("dueAt", "Due date must be after the start date");
    taskOrderChanged(db, user.id, task.id, (body.level ?? task.level) > task.level, now());
    run(
      db,
      `UPDATE tasks SET title = ?, notes = ?, level = ?, total_minutes = ?, min_chunk_minutes = ?, max_chunk_minutes = ?,
         start_after = ?, due_at = ?, hours_set_id = ?, rules_changed_at = ?, color = ?, visibility = ?,
         base_minutes = CASE WHEN ? AND readds = 0 AND base_minutes IS NOT NULL
           THEN MIN(?, MAX(15, ? - (total_minutes - base_minutes))) ELSE base_minutes END WHERE id = ?`,
      body.title ?? task.title,
      body.notes ?? task.notes,
      body.level ?? task.level,
      total,
      min,
      max,
      startAfter,
      dueAt,
      body.hoursSetId ? hoursSetId(db, user.id, body.hoursSetId, "work") : task.hours_set_id,
      now(),
      body.color ?? task.color,
      body.visibility ?? task.visibility,
      // PRG-45: before the first re-add, a minutes edit changes the first total
      // by the same amount; the minutes that "Add N min" added stay out of it.
      // (NULL: the first total is the total, so it follows the edit.)
      minutesChanged ? 1 : 0,
      total,
      total,
      task.id,
    );
    changed(user.id);
    return c.json({
      task: one<TaskRow>(db, "SELECT * FROM tasks WHERE id = ?", task.id),
    });
  });

  r.post("/tasks/:id/done", (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    if (!one(db, "SELECT 1 FROM tasks WHERE id = ? AND user_id = ?", id, user.id)) notFound("task");
    markTaskDone(db, id, now());
    changed(user.id);
    return c.json({ ok: true });
  });

  r.post("/tasks/:id/add-time", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const { minutes: add } = await jsonBody(c, z.object({ minutes }));
    const task = one<TaskRow>(db, "SELECT * FROM tasks WHERE id = ? AND user_id = ?", id, user.id);
    if (!task) notFound("task");
    // A task that is not split keeps one chunk, so the chunk grows with the total.
    // The first total is frozen first, so the added minutes never come again by
    // "re-add" (PRG-41).
    const single =
      task.min_chunk_minutes === task.max_chunk_minutes &&
      task.max_chunk_minutes >= task.total_minutes;
    const total = task.total_minutes + add;
    run(
      db,
      `UPDATE tasks SET total_minutes = ?, min_chunk_minutes = ?, max_chunk_minutes = ?, status = 'open',
         rules_changed_at = ?, base_minutes = COALESCE(base_minutes, total_minutes) WHERE id = ?`,
      total,
      single ? total : task.min_chunk_minutes,
      single ? total : task.max_chunk_minutes,
      now(),
      id,
    );
    changed(user.id);
    return c.json({ ok: true });
  });

  r.delete("/tasks/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    if (!one(db, "SELECT 1 FROM tasks WHERE id = ? AND user_id = ?", id, user.id)) notFound("task");
    await deleteTask(db, sync, user.id, id);
    return c.body(null, 204);
  });

  /** SCH-119: the change log of one item, newest first, with times in the user's zone. */
  r.get("/items/:kind/:id/changes", (c) => {
    const kind = c.req.param("kind");
    if (!["task", "habit", "focus", "buffer", "meeting"].includes(kind)) notFound("item kind");
    const userId = c.get("user").id;
    const zone = zoneOf(db, userId);
    const range = (s: number | null, e: number | null) =>
      s !== null && e !== null ? when(zone, s, e) : "";
    return c.json({
      changes: itemChanges(db, userId, kind, c.req.param("id"), now()).map((x) => ({
        at: when(zone, x.at),
        action: x.action,
        from: range(x.old_start, x.old_end),
        to: range(x.new_start, x.new_end),
        // A skipped period is named by the first day in its demand key (also of a chunk key).
        period: /\d{4}-\d{2}-\d{2}/.exec(x.demand_key)?.[0] ?? "",
        reason: x.reason,
      })),
    });
  });

  // ---------------------------------------------------------------- buffers
  r.get("/buffers", (c) =>
    c.json({
      buffers: all(
        db,
        "SELECT * FROM buffers WHERE user_id = ? ORDER BY level, rank",
        c.get("user").id,
      ),
    }),
  );

  r.post("/buffers", async (c) => {
    const user = c.get("user");
    const full = limitRefusal(db, "max_automations_per_user", automationCount(db, user.id));
    if (full) return c.json(full, 409);
    const b = await jsonBody(c, bufferInput);
    const lvl = b.level ?? 3;
    if (
      b.calendarScope &&
      !one(
        db,
        `SELECT 1 FROM calendars c JOIN accounts a ON a.id = c.account_id WHERE c.id = ? AND a.user_id = ?`,
        b.calendarScope,
        user.id,
      )
    ) {
      badRequest("calendarScope", "Unknown calendar");
    }
    const id = randomUUID();
    const t = now();
    const es = newEventSettings(db, user.id, "buffer", b.eventSettings, {
      travel: Boolean(b.filter?.travel || b.filter?.flight),
    });
    tx(db, () =>
      run(
        db,
        `INSERT INTO buffers (id, user_id, title, enabled, level, rank, side, minutes_before, minutes_after, busy, filter,
         on_conflict, created_at, rules_changed_at, event_settings, template_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        user.id,
        b.title,
        b.enabled === false ? 0 : 1,
        lvl,
        insertRank(db, "buffer", user.id, lvl),
        b.side,
        b.minutesBefore ?? (b.side === "after" ? 0 : 15),
        b.minutesAfter ?? (b.side === "before" ? 0 : 15),
        b.busy === false ? 0 : 1,
        JSON.stringify(b.filter ?? {}),
        b.onConflict ?? "remove",
        t,
        t,
        JSON.stringify(es),
        b.templateId ?? null,
      ),
    );
    if (b.calendarScope) {
      run(db, "UPDATE buffers SET calendar_scope = ? WHERE id = ?", b.calendarScope, id);
    }
    changed(user.id);
    return c.json({ buffer: one(db, "SELECT * FROM buffers WHERE id = ?", id) }, 201);
  });

  r.patch("/buffers/:id", async (c) => {
    const user = c.get("user");
    const cur = one<BufferRow>(
      db,
      "SELECT * FROM buffers WHERE id = ? AND user_id = ?",
      c.req.param("id"),
      user.id,
    );
    if (!cur) notFound("buffer");
    const b = await jsonBody(c, bufferInput.partial());
    const filter = b.filter ?? (JSON.parse(cur.filter) as NonNullable<typeof b.filter>);
    const es = editedEventSettings(
      readEventSettings(
        cur.event_settings,
        defaultEventSettings("buffer", {
          travel: Boolean(filter.travel || filter.flight),
        }),
      ),
      b.eventSettings,
    );
    const side = b.side ?? cur.side;
    run(
      db,
      `UPDATE buffers SET title = ?, enabled = ?, level = ?, rank = ?, side = ?, minutes_before = ?, minutes_after = ?,
         busy = ?, filter = ?, on_conflict = ?, event_settings = ?, rules_changed_at = ? WHERE id = ?`,
      b.title ?? cur.title,
      b.enabled === undefined ? cur.enabled : b.enabled ? 1 : 0,
      b.level ?? cur.level,
      b.level !== undefined && b.level !== cur.level ? endRank(db, user.id, b.level) : cur.rank,
      side,
      side === "after" ? 0 : (b.minutesBefore ?? (cur.minutes_before || 15)),
      side === "before" ? 0 : (b.minutesAfter ?? (cur.minutes_after || 15)),
      b.busy === undefined ? cur.busy : b.busy ? 1 : 0,
      JSON.stringify(filter),
      b.onConflict ?? cur.on_conflict,
      JSON.stringify(es),
      now(),
      cur.id,
    );
    changed(user.id);
    return c.json({
      buffer: one(db, "SELECT * FROM buffers WHERE id = ?", cur.id),
    });
  });

  r.delete("/buffers/:id", (c) => {
    const user = c.get("user");
    run(db, "DELETE FROM buffers WHERE id = ? AND user_id = ?", c.req.param("id"), user.id);
    changed(user.id);
    return c.body(null, 204);
  });

  // ---------------------------------------------------------------- focus
  r.get("/focus", (c) =>
    c.json({
      focus: all(
        db,
        `SELECT f.*, CASE WHEN s.item_specific = 1 THEN s.weekly END AS item_hours
         FROM focus_goals f JOIN hours_sets s ON s.id = f.hours_set_id WHERE f.user_id = ?`,
        c.get("user").id,
      ),
    }),
  );

  r.post("/focus", async (c) => {
    const user = c.get("user");
    const full = limitRefusal(db, "max_automations_per_user", automationCount(db, user.id));
    if (full) return c.json(full, 409);
    const f = await jsonBody(c, focusInput);
    const min = f.minBlockMinutes ?? 60;
    const max = f.maxBlockMinutes ?? 240;
    if (min > max) badRequest("minBlockMinutes", "Minimum block is longer than maximum block");
    const id = randomUUID();
    const t = now();
    const es = newEventSettings(db, user.id, "focus_time", f.eventSettings);
    const [prefFrom, prefTo] = preferredWindow(f.preferredWindow) ?? [null, null];
    const hours = f.itemHours
      ? createItemHours(db, user.id, f.title ?? "Focus time", f.itemHours)
      : hoursSetId(db, user.id, f.hoursSetId, "work");
    run(
      db,
      `INSERT INTO focus_goals (id, user_id, title, enabled, hours_set_id, weekly_goal_minutes, daily_min_minutes,
         daily_max_minutes, min_block_minutes, max_block_minutes, busy, created_at, rules_changed_at,
         event_settings, template_id, rank, preferred_from, preferred_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      user.id,
      f.title ?? "Focus time",
      f.enabled === false ? 0 : 1,
      hours,
      f.weeklyGoalMinutes,
      f.dailyMinMinutes ?? 0,
      f.dailyMaxMinutes ?? 240,
      min,
      max,
      f.busy === false ? 0 : 1,
      t,
      t,
      JSON.stringify(es),
      f.templateId ?? null,
      (one<{ r: number | null }>(
        db,
        "SELECT MAX(rank) AS r FROM focus_goals WHERE user_id = ?",
        user.id,
      )?.r ?? -1) + 1,
      prefFrom,
      prefTo,
    );
    changed(user.id);
    return c.json({ focus: one(db, "SELECT * FROM focus_goals WHERE id = ?", id) }, 201);
  });

  r.patch("/focus/:id", async (c) => {
    const user = c.get("user");
    const cur = one<FocusRow>(
      db,
      "SELECT * FROM focus_goals WHERE id = ? AND user_id = ?",
      c.req.param("id"),
      user.id,
    );
    if (!cur) notFound("focus goal");
    const f = await jsonBody(c, focusInput.partial());
    const min = f.minBlockMinutes ?? cur.min_block_minutes;
    const max = f.maxBlockMinutes ?? cur.max_block_minutes;
    if (min > max) badRequest("minBlockMinutes", "Minimum block is longer than maximum block");
    const [prefFrom, prefTo] = preferredWindow(f.preferredWindow) ?? [
      cur.preferred_from,
      cur.preferred_to,
    ];
    const es = editedEventSettings(
      readEventSettings(cur.event_settings, defaultEventSettings("focus_time")),
      f.eventSettings,
    );
    const hours = f.itemHours
      ? saveItemHours(db, user.id, cur.hours_set_id, f.title ?? cur.title, f.itemHours)
      : f.hoursSetId
        ? hoursSetId(db, user.id, f.hoursSetId, "work")
        : cur.hours_set_id;
    run(
      db,
      `UPDATE focus_goals SET title = ?, enabled = ?, hours_set_id = ?, weekly_goal_minutes = ?, daily_min_minutes = ?,
         daily_max_minutes = ?, min_block_minutes = ?, max_block_minutes = ?, busy = ?, event_settings = ?,
         rules_changed_at = ?, preferred_from = ?, preferred_to = ? WHERE id = ?`,
      f.title ?? cur.title,
      f.enabled === undefined ? cur.enabled : f.enabled ? 1 : 0,
      hours,
      f.weeklyGoalMinutes ?? cur.weekly_goal_minutes,
      f.dailyMinMinutes ?? cur.daily_min_minutes,
      f.dailyMaxMinutes ?? cur.daily_max_minutes,
      min,
      max,
      f.busy === undefined ? cur.busy : f.busy ? 1 : 0,
      JSON.stringify(es),
      now(),
      prefFrom,
      prefTo,
      cur.id,
    );
    if (hours !== cur.hours_set_id) dropItemHours(db, cur.hours_set_id);
    changed(user.id);
    return c.json({
      focus: one(db, "SELECT * FROM focus_goals WHERE id = ?", cur.id),
    });
  });

  r.delete("/focus/:id", (c) => {
    const user = c.get("user");
    const own = one<{ hours_set_id: string }>(
      db,
      "SELECT hours_set_id FROM focus_goals WHERE id = ? AND user_id = ?",
      c.req.param("id"),
      user.id,
    );
    run(db, "DELETE FROM focus_goals WHERE id = ? AND user_id = ?", c.req.param("id"), user.id);
    if (own) dropItemHours(db, own.hours_set_id);
    changed(user.id);
    return c.body(null, 204);
  });

  return r;
}

interface BufferRow {
  id: string;
  title: string;
  enabled: number;
  level: number;
  rank: number;
  side: "before" | "after" | "both";
  minutes_before: number;
  minutes_after: number;
  busy: number;
  filter: string;
  on_conflict: "remove" | "keep_as_conflict";
  event_settings: string;
}

interface FocusRow {
  id: string;
  title: string;
  enabled: number;
  hours_set_id: string;
  weekly_goal_minutes: number;
  daily_min_minutes: number;
  daily_max_minutes: number;
  min_block_minutes: number;
  max_block_minutes: number;
  busy: number;
  event_settings: string;
  preferred_from: number | null;
  preferred_to: number | null;
}
