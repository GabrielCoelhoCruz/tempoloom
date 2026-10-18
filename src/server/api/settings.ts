// Settings, hours sets and calendars.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { all, type Db, one, run } from "../db.ts";
import { jsonBody, notFound } from "../http.ts";
import { getSettings, updateSettings } from "../settings.ts";
import type { SyncService } from "../sync/service.ts";

const range = z
  .tuple([z.number().int().min(0).max(1439), z.number().int().min(1).max(1440)])
  .refine(([s, e]) => e > s, "A range must end after it starts");
const weekly = z.partialRecord(z.enum(["1", "2", "3", "4", "5", "6", "7"]), z.array(range).max(12));

export function settingsRoutes(db: Db, sync: SyncService, now: () => number): Hono<AppEnv> {
  const scopeChanges = new Map<string, number[]>();
  const r = new Hono<AppEnv>();

  r.get("/settings", (c) => c.json({ settings: getSettings(db, c.get("user").id) }));

  r.patch("/settings", async (c) => {
    const user = c.get("user");
    const body = await jsonBody(c, z.record(z.string(), z.unknown()));
    // Rule 11 of events-categories-and-colors.md: a scope change repaints many
    // events, so at most 2 changes per minute.
    if ("colorScope" in body && body.colorScope !== getSettings(db, user.id).colorScope) {
      const recent = (scopeChanges.get(user.id) ?? []).filter((t) => now() - t < 60_000);
      if (recent.length >= 2)
        return c.json(
          {
            error: "too_many_changes",
            message: "Wait a minute before you change the scope again.",
          },
          429,
        );
      scopeChanges.set(user.id, [...recent, now()]);
    }
    const parsed = (() => {
      try {
        return updateSettings(db, user.id, body);
      } catch (err) {
        return err as Error;
      }
    })();
    if (parsed instanceof Error)
      return c.json({ error: "invalid_body", message: parsed.message }, 400);
    sync.request(user.id);
    return c.json({ settings: parsed });
  });

  r.get("/hours", (c) =>
    c.json({
      hours: all<{
        id: string;
        kind: string;
        name: string;
        weekly: string;
        task_calendar_id: string | null;
      }>(
        db,
        "SELECT id, kind, name, weekly, task_calendar_id FROM hours_sets WHERE user_id = ? ORDER BY created_at",
        c.get("user").id,
      ).map((h) => ({ ...h, weekly: JSON.parse(h.weekly) })),
    }),
  );

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
    return c.json({ id }, 201);
  });

  r.put("/hours/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    if (!one(db, "SELECT 1 FROM hours_sets WHERE id = ? AND user_id = ?", id, user.id))
      notFound("hours set");
    const body = await jsonBody(
      c,
      z.object({
        name: z.string().trim().min(1).max(100).optional(),
        weekly,
        taskCalendarId: z.string().nullable().optional(),
      }),
    );
    run(
      db,
      "UPDATE hours_sets SET weekly = ?, name = COALESCE(?, name) WHERE id = ?",
      JSON.stringify(body.weekly),
      body.name ?? null,
      id,
    );
    if (body.taskCalendarId !== undefined) {
      run(db, "UPDATE hours_sets SET task_calendar_id = ? WHERE id = ?", body.taskCalendarId, id);
    }
    // HRS-7: a change applies to existing events; re-place everything that uses the set.
    const t = now();
    for (const table of ["tasks", "habits", "focus_goals"]) {
      run(
        db,
        `UPDATE ${table} SET rules_changed_at = ? WHERE user_id = ? AND hours_set_id = ?`,
        t,
        user.id,
        id,
      );
    }
    sync.request(user.id);
    return c.json({ ok: true });
  });

  r.get("/calendars", (c) =>
    c.json({
      calendars: all(
        db,
        `SELECT c.id, c.name, c.is_primary, c.writable, c.check_availability, a.provider, a.email
         FROM calendars c JOIN accounts a ON a.id = c.account_id WHERE a.user_id = ? ORDER BY a.created_at, c.is_primary DESC, c.name`,
        c.get("user").id,
      ),
    }),
  );

  /** Reads each account's calendar list again (new or removed calendars). */
  r.post("/calendars/refresh", async (c) => {
    const user = c.get("user");
    await sync.refreshCalendars(user.id);
    return c.json({ ok: true });
  });

  const policyInput = z.object({
    sourceCalendarId: z.string(),
    destCalendarId: z.string(),
    calendarType: z.enum(["personal", "business", "travel"]).default("personal"),
    visibility: z
      .enum(["label_only", "busy_only", "details_private", "details_default"])
      .default("label_only"),
    allDayMode: z.enum(["none", "busy_only", "all"]).default("none"),
    copyOutsideWorkHours: z.boolean().default(true),
  });
  const ownCalendar = (userId: string, id: string) =>
    one<{ id: string; writable: number }>(
      db,
      "SELECT c.id, c.writable FROM calendars c JOIN accounts a ON a.id = c.account_id WHERE c.id = ? AND a.user_id = ?",
      id,
      userId,
    );

  r.get("/mirrors", (c) =>
    c.json({
      mirrors: all(
        db,
        `SELECT p.*, s.name AS source_name, d.name AS dest_name FROM mirror_policies p
         JOIN calendars s ON s.id = p.source_calendar_id JOIN calendars d ON d.id = p.dest_calendar_id
         WHERE p.user_id = ? ORDER BY p.created_at`,
        c.get("user").id,
      ),
    }),
  );

  r.post("/mirrors", async (c) => {
    const user = c.get("user");
    const b = await jsonBody(c, policyInput);
    const src = ownCalendar(user.id, b.sourceCalendarId);
    const dst = ownCalendar(user.id, b.destCalendarId);
    if (!src || !dst) notFound("calendar");
    if (src.id === dst.id) return c.json({ error: "same_calendar" }, 400);
    if (!dst.writable) return c.json({ error: "destination_read_only" }, 400);
    const id = randomUUID();
    run(
      db,
      `INSERT INTO mirror_policies (id, user_id, source_calendar_id, dest_calendar_id, calendar_type, visibility,
         all_day_mode, copy_outside_work_hours, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      user.id,
      src.id,
      dst.id,
      b.calendarType,
      b.visibility,
      b.allDayMode,
      b.copyOutsideWorkHours ? 1 : 0,
      now(),
    );
    // Calendars in a policy count for availability (connected calendars spec).
    run(db, "UPDATE calendars SET check_availability = 1 WHERE id IN (?, ?)", src.id, dst.id);
    sync.request(user.id, 0);
    return c.json({ id }, 201);
  });

  r.patch("/mirrors/:id", async (c) => {
    const user = c.get("user");
    const { enabled } = await jsonBody(c, z.object({ enabled: z.boolean() }));
    run(
      db,
      "UPDATE mirror_policies SET enabled = ? WHERE id = ? AND user_id = ?",
      enabled ? 1 : 0,
      c.req.param("id"),
      user.id,
    );
    sync.request(user.id, 0);
    return c.json({ ok: true });
  });

  r.delete("/mirrors/:id", (c) => {
    const user = c.get("user");
    run(db, "DELETE FROM mirror_policies WHERE id = ? AND user_id = ?", c.req.param("id"), user.id);
    sync.request(user.id, 0);
    return c.body(null, 204);
  });

  r.patch("/calendars/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const body = await jsonBody(c, z.object({ checkAvailability: z.boolean() }));
    const owned = one(
      db,
      "SELECT 1 FROM calendars c JOIN accounts a ON a.id = c.account_id WHERE c.id = ? AND a.user_id = ?",
      id,
      user.id,
    );
    if (!owned) notFound("calendar");
    run(
      db,
      "UPDATE calendars SET check_availability = ? WHERE id = ?",
      body.checkAvailability ? 1 : 0,
      id,
    );
    sync.request(user.id);
    return c.json({ ok: true });
  });

  return r;
}
