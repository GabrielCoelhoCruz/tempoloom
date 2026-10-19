// Settings and hours sets. Calendars and mirroring: calendars.ts, mirrors.ts.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { all, type Db, one, run } from "../db.ts";
import { jsonBody, notFound } from "../http.ts";
import { instanceLimit, limitMessage } from "../limits.ts";
import { getSettings, updateSettings } from "../settings.ts";
import type { SyncService } from "../sync/service.ts";

const range = z
  .tuple([z.number().int().min(0).max(1439), z.number().int().min(1).max(1440)])
  .refine(([s, e]) => e > s, "A range must end after it starts");
const weekly = z.partialRecord(z.enum(["1", "2", "3", "4", "5", "6", "7"]), z.array(range).max(12));

export function settingsRoutes(db: Db, sync: SyncService, now: () => number): Hono<AppEnv> {
  const scopeChanges = new Map<string, number[]>();
  const r = new Hono<AppEnv>();

  r.get("/settings", (c) =>
    c.json({
      settings: getSettings(db, c.get("user").id),
      // Instance limit on the planning window (plans-feature-inventory.md rule 3).
      windowLimit: instanceLimit(db, "max_scheduling_window_weeks"),
    }),
  );

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
    const windowLimit = instanceLimit(db, "max_scheduling_window_weeks");
    if (
      windowLimit !== null &&
      typeof body.schedulingWindowWeeks === "number" &&
      body.schedulingWindowWeeks > windowLimit
    ) {
      const message = limitMessage("max_scheduling_window_weeks", windowLimit);
      return c.json({ error: "limit_reached", message }, 400);
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
        "SELECT id, kind, name, weekly, task_calendar_id FROM hours_sets WHERE user_id = ? AND item_specific = 0 ORDER BY created_at",
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
    // Rule 19 of accounts-connected-calendars.md: tasks go only to a writable calendar of the user.
    if (
      body.taskCalendarId &&
      !one(
        db,
        `SELECT 1 FROM calendars c JOIN accounts a ON a.id = c.account_id
         WHERE c.id = ? AND a.user_id = ? AND c.writable = 1 AND a.provider <> 'ics'`,
        body.taskCalendarId,
        user.id,
      )
    )
      notFound("calendar");
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

  return r;
}
