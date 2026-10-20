// Settings and hours sets. Calendars and mirroring: calendars.ts, mirrors.ts.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { all, type Db, one, run, tx } from "../db.ts";
import { jsonBody, notFound } from "../http.ts";
import { instanceLimit, limitMessage } from "../limits.ts";
import { autoLock, turnedOn } from "../planner/auto-lock.ts";
import { wakeOrganizers } from "../planner/meetings.ts";
import { requestRepaint } from "../planner/repaint.ts";
import { writeCalendar } from "../planner/replan.ts";
import { disconnectedEmail, writableCalendar, writableCalendars } from "../planner/write.ts";
import { getSettings, updateSettings } from "../settings.ts";
import type { SyncService } from "../sync/service.ts";
import { badRequest } from "./items.ts";

const range = z
  .tuple([z.number().int().min(0).max(1439), z.number().int().min(1).max(1440)])
  .refine(([s, e]) => e > s, "A range must end after it starts");
const weekly = z.partialRecord(z.enum(["1", "2", "3", "4", "5", "6", "7"]), z.array(range).max(12));

/**
 * At most `max` uses per key in any `windowMs` (events-categories-and-colors.md
 * rule 11). takeSlot returns false, and uses nothing, when the key is at the limit.
 */
export function slotLimiter(now: () => number, max: number, windowMs: number) {
  const uses = new Map<string, number[]>();
  return function takeSlot(key: string): boolean {
    const t = now();
    const recent = (uses.get(key) ?? []).filter((u) => t - u < windowMs);
    if (recent.length >= max) return false;
    uses.set(key, [...recent, t]);
    return true;
  };
}

type Weekly = Partial<Record<string, [number, number][]>>;

/** Two week patterns with the same ranges per day, whatever the key order or empty days. */
function sameWeek(a: Weekly, b: Weekly): boolean {
  const days = (w: Weekly) => ["1", "2", "3", "4", "5", "6", "7"].map((d) => w[d] ?? []);
  return JSON.stringify(days(a)) === JSON.stringify(days(b));
}

export function settingsRoutes(db: Db, sync: SyncService, now: () => number): Hono<AppEnv> {
  // Scope changes and "repaint all" share one limit of 2 a minute (rules 11, 12).
  const takeSlot = slotLimiter(now, 2, 60_000);
  const r = new Hono<AppEnv>();

  r.get("/settings", (c) =>
    c.json({
      settings: getSettings(db, c.get("user").id),
      // Instance limit on the planning window (plans-feature-inventory.md rule 3).
      windowLimit: instanceLimit(db, "max_scheduling_window_weeks"),
    }),
  );

  /** Rule 12: repaint all events in one step; it repaints as much as a scope change. */
  r.post("/settings/repaint", (c) => {
    const user = c.get("user");
    if (!takeSlot(user.id))
      return c.json(
        { error: "too_many_changes", message: "Wait a minute before you repaint again." },
        429,
      );
    requestRepaint(db, user.id, now());
    sync.request(user.id);
    return c.json({ ok: true });
  });

  r.patch("/settings", async (c) => {
    const user = c.get("user");
    const body = await jsonBody(c, z.record(z.string(), z.unknown()));
    // Rule 11 of events-categories-and-colors.md: a scope change repaints many
    // events, so at most 2 changes per minute.
    if (
      "colorScope" in body &&
      body.colorScope !== getSettings(db, user.id).colorScope &&
      !takeSlot(user.id)
    )
      return c.json(
        { error: "too_many_changes", message: "Wait a minute before you change the scope again." },
        429,
      );
    const windowLimit = instanceLimit(db, "max_scheduling_window_weeks");
    if (
      windowLimit !== null &&
      typeof body.schedulingWindowWeeks === "number" &&
      body.schedulingWindowWeeks > windowLimit
    ) {
      const message = limitMessage("max_scheduling_window_weeks", windowLimit);
      return c.json({ error: "limit_reached", message }, 400);
    }
    const before = getSettings(db, user.id).autoLock;
    const parsed = (() => {
      try {
        return updateSettings(db, user.id, body);
      } catch (err) {
        return err as Error;
      }
    })();
    if (parsed instanceof Error)
      return c.json({ error: "invalid_body", message: parsed.message }, 400);
    // LCK-32: a kind turned off and on again locks its current day or week at once.
    const on = turnedOn(before, parsed.autoLock);
    if (on.length > 0) autoLock(db, user.id, parsed, now(), on);
    sync.request(user.id);
    return c.json({ settings: parsed });
  });

  r.get("/hours", (c) => {
    const userId = c.get("user").id;
    const main = writeCalendar(db, userId)?.id;
    return c.json({
      hours: all<{
        id: string;
        kind: string;
        name: string;
        weekly: string;
        task_calendar_id: string | null;
      }>(
        db,
        "SELECT id, kind, name, weekly, task_calendar_id FROM hours_sets WHERE user_id = ? AND item_specific = 0 ORDER BY created_at",
        userId,
      ).map((h) => ({
        ...h,
        weekly: JSON.parse(h.weekly),
        // Accounts rule 16: task chunks wait while this calendar's account is disconnected.
        disconnected: disconnectedEmail(db, h.task_calendar_id),
      })),
      // HRS-12: the calendars that can take task chunks, besides the main one.
      taskCalendars: writableCalendars(db, userId).filter((cal) => cal.id !== main),
    });
  });

  r.post("/hours", async (c) => {
    const user = c.get("user");
    const body = await jsonBody(c, z.object({ name: z.string().trim().min(1).max(100), weekly }));
    const id = randomUUID();
    run(
      db,
      "INSERT INTO hours_sets (id, user_id, kind, name, weekly, created_at) VALUES (?, ?, 'custom', ?, ?, ?)",
      id,
      user.id,
      body.name,
      JSON.stringify(body.weekly),
      now(),
    );
    wakeOrganizers(db, sync, user.id);
    return c.json({ id }, 201);
  });

  r.put("/hours/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    // Read the body first: the set is read and written in one step below, so a
    // save that waits for its body never writes back ranges saved meanwhile.
    const body = await jsonBody(
      c,
      z.object({
        name: z.string().trim().min(1).max(100).optional(),
        weekly: weekly.optional(),
        taskCalendarId: z.string().min(1).nullable().optional(),
      }),
    );
    // HRS-12: task chunks go to a calendar of this user that takes events.
    if (body.taskCalendarId && !writableCalendar(db, user.id, body.taskCalendarId))
      badRequest("taskCalendarId", "Unknown calendar, or a calendar that takes no events");
    tx(db, () => {
      const set = one<{ weekly: string }>(
        db,
        "SELECT weekly FROM hours_sets WHERE id = ? AND user_id = ?",
        id,
        user.id,
      );
      if (!set) notFound("hours set");
      run(
        db,
        `UPDATE hours_sets SET weekly = COALESCE(?, weekly), name = COALESCE(?, name),
           task_calendar_id = CASE WHEN ? THEN ? ELSE task_calendar_id END
         WHERE id = ?`,
        body.weekly ? JSON.stringify(body.weekly) : null,
        body.name ?? null,
        body.taskCalendarId !== undefined ? 1 : 0,
        body.taskCalendarId ?? null,
        id,
      );
      // HRS-7: a change of ranges applies to existing events; re-place everything
      // that uses the set. A new name or task calendar places nothing again.
      if (!body.weekly || sameWeek(body.weekly, JSON.parse(set.weekly))) return;
      const t = now();
      for (const table of ["tasks", "habits", "focus_goals", "meetings"]) {
        run(
          db,
          `UPDATE ${table} SET rules_changed_at = ? WHERE user_id = ? AND hours_set_id = ?`,
          t,
          user.id,
          id,
        );
      }
    });
    wakeOrganizers(db, sync, user.id);
    sync.request(user.id);
    return c.json({ ok: true });
  });

  return r;
}
