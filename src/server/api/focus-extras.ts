// Focus time options and progress, and the meeting overload automation
// (docs/specs/focus-time.md rules 1-16, 23, 35, Outputs).
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { hasTag, TAG_FOCUS, tagText } from "../../scheduler/blocking.ts";
import { hoursToTimeSet, type WeeklyHours } from "../../scheduler/hours.ts";
import type { ReportEntry } from "../../scheduler/model.ts";
import { TimeSet } from "../../scheduler/timeset.ts";
import { addDays, type LocalDate, localToUtc, weekdayOf } from "../../shared/time.ts";
import type { AppEnv } from "../app.ts";
import { all, type Db, one, run } from "../db.ts";
import { jsonBody, notFound } from "../http.ts";
import { getSettings } from "../settings.ts";
import type { SyncService } from "../sync/service.ts";
import { badRequest, hoursSetId } from "./items.ts";

const decline = z.object({ enabled: z.boolean(), message: z.string().trim().max(500) });
const optionsInput = z.object({
  mode: z.enum(["proactive", "reactive"]).optional(),
  autoDecline: decline.optional(),
  taskSearchId: z.string().nullable().optional(),
});

const hours = (max: number) =>
  z
    .number()
    .int()
    .min(30)
    .max(max * 60)
    .multipleOf(30)
    .nullable();
const overloadInput = z.object({
  title: z.string().trim().min(1).max(255),
  enabled: z.boolean().optional(),
  dailyMaxMinutes: hours(24).optional(),
  weeklyMaxMinutes: hours(168).optional(),
  heavyDayMinutes: hours(24).optional(),
  minBlockMinutes: z.number().int().min(15).max(480).multipleOf(15).optional(),
  hoursSetId: z.string().optional(),
  autoDecline: decline.optional(),
  taskSearchId: z.string().nullable().optional(),
});

export interface FocusProgress {
  id: string;
  title: string;
  mode: string;
  goalMinutes: number;
  countedMinutes: number;
  /** From the last plan: minutes the scheduler could not place this week, or 0. */
  missingMinutes: number;
}

/**
 * Counted time of one focus goal in one week (focus-time.md "Counted time"):
 * focus events of both automations, work task chunks and work habits, and
 * events of the focus type or with #tl_focus, inside the goal's hours.
 */
function countedMinutes(
  db: Db,
  userId: string,
  zone: string,
  weekly: WeeklyHours,
  from: number,
  to: number,
): number {
  const work = all<{ id: string }>(
    db,
    "SELECT id FROM hours_sets WHERE user_id = ? AND kind = 'work'",
    userId,
  ).map((h) => h.id);
  const marks = work.map(() => "?").join(",") || "''";
  const managed = all<{ start_ms: number; end_ms: number }>(
    db,
    `SELECT m.start_ms, m.end_ms FROM managed_events m
     WHERE m.user_id = ? AND m.end_ms > ? AND m.start_ms < ? AND (
       m.kind = 'focus'
       OR (m.kind = 'task' AND m.source_id IN (SELECT id FROM tasks WHERE hours_set_id IN (${marks})))
       OR (m.kind = 'habit' AND m.source_id IN (SELECT id FROM habits WHERE hours_set_id IN (${marks}))))`,
    userId,
    from,
    to,
    ...work,
    ...work,
  );
  const tagged = all<{
    start_ms: number;
    end_ms: number;
    summary: string;
    description: string;
    event_type: string;
    private_props: string;
    rsvp_note: string;
  }>(
    db,
    `SELECT e.start_ms, e.end_ms, e.summary, e.description, e.event_type, e.private_props, e.rsvp_note
     FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN accounts a ON a.id = c.account_id
     WHERE a.user_id = ? AND c.check_availability = 1 AND e.all_day = 0 AND e.end_ms > ? AND e.start_ms < ?`,
    userId,
    from,
    to,
  ).filter(
    (e) =>
      (JSON.parse(e.private_props) as Record<string, string>).tl !== "1" &&
      (e.event_type === "focusTime" || hasTag(tagText(e), TAG_FOCUS)),
  );
  const ranges = [...managed, ...tagged].map((x) => ({ start: x.start_ms, end: x.end_ms }));
  return hoursToTimeSet(weekly, zone, from, to).intersect(TimeSet.from(ranges)).total() / 60_000;
}

export function focusExtraRoutes(db: Db, sync: SyncService, now: () => number): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const changed = (userId: string) => sync.request(userId);

  r.patch("/focus/:id/options", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const cur = one<{ mode: string }>(
      db,
      "SELECT mode FROM focus_goals WHERE id = ? AND user_id = ?",
      id,
      user.id,
    );
    if (!cur) notFound("focus goal");
    const body = await jsonBody(c, optionsInput);
    if (body.mode && body.mode !== cur.mode) {
      run(
        db,
        "UPDATE focus_goals SET mode = ?, rules_changed_at = ? WHERE id = ?",
        body.mode,
        now(),
        id,
      );
    }
    if (body.autoDecline) {
      run(
        db,
        "UPDATE focus_goals SET decline_enabled = ?, decline_message = ? WHERE id = ?",
        body.autoDecline.enabled ? 1 : 0,
        body.autoDecline.message,
        id,
      );
    }
    if (body.taskSearchId !== undefined) {
      if (
        body.taskSearchId &&
        !one(
          db,
          "SELECT 1 FROM task_searches WHERE id = ? AND user_id = ?",
          body.taskSearchId,
          user.id,
        )
      ) {
        notFound("task search");
      }
      run(db, "UPDATE focus_goals SET task_search_id = ? WHERE id = ?", body.taskSearchId, id);
    }
    changed(user.id);
    return c.json({ focus: one(db, "SELECT * FROM focus_goals WHERE id = ?", id) });
  });

  /** Outputs: weekly progress toward each goal and the "goal not reached" notice (rule 35). */
  r.get("/focus/progress", (c) => {
    const user = c.get("user");
    const week = z.iso.date().safeParse(c.req.query("week"));
    if (!week.success) return c.json({ error: "invalid_week" }, 400);
    const zone =
      one<{ time_zone: string }>(db, "SELECT time_zone FROM users WHERE id = ?", user.id)
        ?.time_zone ?? "UTC";
    const ws: LocalDate = addDays(
      week.data,
      -((weekdayOf(week.data) - getSettings(db, user.id).weekStart + 7) % 7),
    );
    const from = localToUtc(zone, ws, 0);
    const to = localToUtc(zone, addDays(ws, 7), 0);
    const report = JSON.parse(
      one<{ report: string }>(db, "SELECT report FROM plan_reports WHERE user_id = ?", user.id)
        ?.report ?? "[]",
    ) as ReportEntry[];
    const goals = all<{
      id: string;
      title: string;
      mode: string;
      weekly_goal_minutes: number;
      weekly: string;
    }>(
      db,
      `SELECT f.id, f.title, f.mode, f.weekly_goal_minutes, s.weekly FROM focus_goals f
       JOIN hours_sets s ON s.id = f.hours_set_id WHERE f.user_id = ? AND f.enabled = 1 ORDER BY f.created_at`,
      user.id,
    );
    const progress: FocusProgress[] = goals.map((g) => {
      const entry = report.find(
        (e) => e.itemKind === "focus" && e.demandKey === `focus:${g.id}:${ws}`,
      );
      return {
        id: g.id,
        title: g.title,
        mode: g.mode,
        goalMinutes: g.weekly_goal_minutes,
        countedMinutes: countedMinutes(
          db,
          user.id,
          zone,
          JSON.parse(g.weekly) as WeeklyHours,
          from,
          to,
        ),
        missingMinutes: entry && to > now() ? entry.missingMinutes : 0,
      };
    });
    return c.json({ progress });
  });

  // ---------------------------------------------------------------- meeting overload
  const overloadRow = (id: string) =>
    one<Record<string, unknown>>(db, "SELECT * FROM meeting_overloads WHERE id = ?", id);

  r.get("/meeting-overloads", (c) =>
    c.json({
      overloads: all(
        db,
        "SELECT * FROM meeting_overloads WHERE user_id = ? ORDER BY created_at",
        c.get("user").id,
      ),
    }),
  );

  r.post("/meeting-overloads", async (c) => {
    const user = c.get("user");
    const body = await jsonBody(c, overloadInput);
    const daily = body.dailyMaxMinutes ?? null;
    const weekly = body.weeklyMaxMinutes ?? null;
    if (daily === null && weekly === null) {
      badRequest("dailyMaxMinutes", "Set a daily or a weekly meeting limit");
    }
    if (
      body.taskSearchId &&
      !one(
        db,
        "SELECT 1 FROM task_searches WHERE id = ? AND user_id = ?",
        body.taskSearchId,
        user.id,
      )
    ) {
      notFound("task search");
    }
    const id = randomUUID();
    const t = now();
    run(
      db,
      `INSERT INTO meeting_overloads (id, user_id, title, enabled, hours_set_id, daily_max_minutes, weekly_max_minutes,
         heavy_day_minutes, min_block_minutes, decline_enabled, decline_message, task_search_id, created_at,
         rules_changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      user.id,
      body.title,
      body.enabled === false ? 0 : 1,
      hoursSetId(db, user.id, body.hoursSetId, "work"),
      daily,
      weekly,
      body.heavyDayMinutes ?? null,
      body.minBlockMinutes ?? 30,
      body.autoDecline?.enabled ? 1 : 0,
      body.autoDecline?.message ?? "",
      body.taskSearchId ?? null,
      t,
      t,
    );
    changed(user.id);
    return c.json({ overload: overloadRow(id) }, 201);
  });

  /** Turns it off or on, or changes any field of the form (the editor of the automation list's Edit). */
  r.patch("/meeting-overloads/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const cur = one<{ daily_max_minutes: number | null; weekly_max_minutes: number | null }>(
      db,
      "SELECT daily_max_minutes, weekly_max_minutes FROM meeting_overloads WHERE id = ? AND user_id = ?",
      id,
      user.id,
    );
    if (!cur) notFound("meeting overload");
    const body = await jsonBody(c, overloadInput.partial());
    const daily = body.dailyMaxMinutes === undefined ? cur.daily_max_minutes : body.dailyMaxMinutes;
    const weekly =
      body.weeklyMaxMinutes === undefined ? cur.weekly_max_minutes : body.weeklyMaxMinutes;
    if (daily === null && weekly === null) {
      badRequest("dailyMaxMinutes", "Set a daily or a weekly meeting limit");
    }
    if (
      body.taskSearchId &&
      !one(
        db,
        "SELECT 1 FROM task_searches WHERE id = ? AND user_id = ?",
        body.taskSearchId,
        user.id,
      )
    ) {
      notFound("task search");
    }
    const set: Record<string, string | number | null | undefined> = {
      title: body.title,
      enabled: body.enabled === undefined ? undefined : body.enabled ? 1 : 0,
      hours_set_id:
        body.hoursSetId === undefined
          ? undefined
          : hoursSetId(db, user.id, body.hoursSetId, "work"),
      daily_max_minutes: body.dailyMaxMinutes,
      weekly_max_minutes: body.weeklyMaxMinutes,
      heavy_day_minutes: body.heavyDayMinutes,
      min_block_minutes: body.minBlockMinutes,
      decline_enabled:
        body.autoDecline === undefined ? undefined : body.autoDecline.enabled ? 1 : 0,
      decline_message: body.autoDecline?.message,
      task_search_id: body.taskSearchId,
      rules_changed_at: now(),
    };
    const cols = Object.entries(set).filter(
      (e): e is [string, string | number | null] => e[1] !== undefined,
    );
    run(
      db,
      `UPDATE meeting_overloads SET ${cols.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`,
      ...cols.map(([, v]) => v),
      id,
    );
    changed(user.id);
    return c.json({ overload: overloadRow(id) });
  });

  r.delete("/meeting-overloads/:id", (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    run(
      db,
      "DELETE FROM item_exclusions WHERE user_id = ? AND kind = 'focus' AND item_id = ?",
      user.id,
      id,
    );
    run(db, "DELETE FROM meeting_overloads WHERE id = ? AND user_id = ?", id, user.id);
    changed(user.id);
    return c.body(null, 204);
  });

  return r;
}
