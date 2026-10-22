// Calendar mirroring policies (docs/specs/sync-calendar-mirroring.md rules
// 1-13, 29, 41-43, edge case 14): create, list, edit, turn off and on, delete.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { all, type Db, one, run, tx } from "../db.ts";
import { editBody, jsonBody, notFound, rawBody } from "../http.ts";
import { connectedCount, instanceLimit, limitMessage, limitRefusal } from "../limits.ts";
import type { SyncService } from "../sync/service.ts";
import { listedCalendars } from "./calendars.ts";

const COLOR_IDS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"] as const;

const policyInput = z.object({
  sourceCalendarId: z.string(),
  destCalendarId: z.string(),
  calendarType: z.enum(["personal", "business", "travel"]).default("personal"),
  visibility: z
    .enum(["label_only", "busy_only", "details_private", "details_default"])
    .default("label_only"),
  allDayMode: z.enum(["none", "busy_only", "all"]).default("none"),
  copyOutsideWorkHours: z.boolean().default(true),
  colorOverride: z.enum(COLOR_IDS).nullable().default(null),
  /** The library entry it came from (automations-library.md rule 4). */
  templateId: z.string().max(100).optional(),
});
type PolicyInput = z.infer<typeof policyInput>;

/** Library entries 38 and 39: one policy per ordered pair of these calendars. */
const meshInput = policyInput.omit({ sourceCalendarId: true, destCalendarId: true }).extend({
  calendarIds: z.array(z.string()).max(6),
});

export function mirrorRoutes(db: Db, sync: SyncService, now: () => number): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  /** The refusal of a policy, or null when it may be saved. */
  const problem = (userId: string, b: PolicyInput, policyId: string | null) => {
    const listed = listedCalendars(db, userId).filter((c) => c.provider !== "ics");
    const src = listed.find((c) => c.id === b.sourceCalendarId);
    const dst = listed.find((c) => c.id === b.destCalendarId);
    if (!src || !dst) notFound("calendar");
    if (src.id === dst.id)
      return { error: "same_calendar", message: "Choose two different calendars." };
    const twin = one(
      db,
      `SELECT 1 FROM mirror_policies WHERE user_id = ? AND source_calendar_id = ?
         AND dest_calendar_id = ? AND id <> ?`,
      userId,
      src.id,
      dst.id,
      policyId ?? "",
    );
    if (twin)
      return {
        error: "duplicate_policy",
        message: `A mirroring policy from ${src.name} to ${dst.name} already exists.`,
      };
    // Rule 4: never write copies into the main calendar of another Tempoloom account.
    const othersMain = one(
      db,
      `SELECT 1 FROM calendars c JOIN accounts a ON a.id = c.account_id
       WHERE a.user_id <> ? AND a.is_main = 1 AND c.is_primary = 1 AND a.provider = ?
         AND c.provider_id = ?`,
      userId,
      dst.provider,
      dst.provider_id,
    );
    if (othersMain)
      return {
        error: "main_calendar_of_other_account",
        message:
          "This calendar is the main calendar of another Tempoloom account. Choose another destination.",
      };
    // Both calendars become connected; they count toward the instance limit.
    const limit = instanceLimit(db, "max_connected_calendars");
    const added = [src, dst].filter((c) => !c.check_availability).length;
    if (limit !== null && added > 0 && connectedCount(db, userId) + added > limit)
      return {
        error: "limit_reached",
        message: limitMessage("max_connected_calendars", limit),
      };
    return null;
  };

  const insert = (userId: string, b: PolicyInput) => {
    const id = randomUUID();
    run(
      db,
      `INSERT INTO mirror_policies (id, user_id, source_calendar_id, dest_calendar_id, calendar_type, visibility,
         all_day_mode, copy_outside_work_hours, color_override, created_at, template_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      b.sourceCalendarId,
      b.destCalendarId,
      b.calendarType,
      b.visibility,
      b.allDayMode,
      b.copyOutsideWorkHours ? 1 : 0,
      b.colorOverride,
      now(),
      b.templateId ?? null,
    );
    // Calendars in a policy count for availability (connected calendars rule 3).
    connect(b);
    return id;
  };

  const connect = (b: PolicyInput) =>
    run(
      db,
      "UPDATE calendars SET check_availability = 1 WHERE id IN (?, ?)",
      b.sourceCalendarId,
      b.destCalendarId,
    );

  r.get("/mirrors", (c) => {
    const user = c.get("user");
    return c.json({
      mirrors: all(
        db,
        `SELECT p.*, s.name AS source_name, d.name AS dest_name, s.account_id AS source_account_id,
           d.account_id AS dest_account_id,
           (SELECT GROUP_CONCAT(a.email, ', ') FROM accounts a
            WHERE a.id IN (s.account_id, d.account_id) AND a.status <> 'ok') AS disconnected
         FROM mirror_policies p
           JOIN calendars s ON s.id = p.source_calendar_id JOIN calendars d ON d.id = p.dest_calendar_id
         WHERE p.user_id = ? ORDER BY p.created_at, p.id`,
        user.id,
      ),
      reconciledAt:
        one<{ at: number | null }>(
          db,
          "SELECT mirror_reconciled_at AS at FROM users WHERE id = ?",
          user.id,
        )?.at ?? null,
    });
  });

  r.post("/mirrors", async (c) => {
    const user = c.get("user");
    const b = await jsonBody(c, policyInput);
    const count =
      one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM mirror_policies WHERE user_id = ?", user.id)
        ?.n ?? 0;
    const refused = limitRefusal(db, "max_mirrors", count);
    if (refused) return c.json(refused, 409);
    const no = problem(user.id, b, null);
    if (no) return c.json(no, 400);
    const id = insert(user.id, b);
    sync.request(user.id, 0);
    return c.json({ id }, 201);
  });

  /**
   * Mirrors each calendar into each other one (library entries 38 and 39): one
   * policy per ordered pair, all in one save. A refused pair saves nothing.
   */
  r.post("/mirrors/mesh", async (c) => {
    const user = c.get("user");
    const { calendarIds: given, ...rest } = await jsonBody(c, meshInput);
    const calendarIds = [...new Set(given)];
    if (calendarIds.length < 2)
      return c.json({ error: "same_calendar", message: "Choose two different calendars." }, 400);
    const pairs = calendarIds.flatMap((from) =>
      calendarIds
        .filter((to) => to !== from)
        .map((to): PolicyInput => ({ ...rest, sourceCalendarId: from, destCalendarId: to })),
    );
    const count =
      one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM mirror_policies WHERE user_id = ?", user.id)
        ?.n ?? 0;
    const refused = limitRefusal(db, "max_mirrors", count + pairs.length - 1);
    if (refused) return c.json(refused, 409);
    const limit = instanceLimit(db, "max_connected_calendars");
    const added = listedCalendars(db, user.id).filter(
      (x) => calendarIds.includes(x.id) && !x.check_availability,
    ).length;
    if (limit !== null && added > 0 && connectedCount(db, user.id) + added > limit)
      return c.json(
        { error: "limit_reached", message: limitMessage("max_connected_calendars", limit) },
        400,
      );
    for (const b of pairs) {
      const no = problem(user.id, b, null);
      if (no) return c.json(no, 400);
    }
    const ids = tx(db, () => pairs.map((b) => insert(user.id, b)));
    sync.request(user.id, 0);
    return c.json({ ids }, 201);
  });

  /**
   * Saves new settings (rules 7, 43): the next run rewrites the copies; with a
   * new source or destination it deletes the old copies and makes new ones.
   */
  r.put("/mirrors/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const cur = one<{
      source_calendar_id: string;
      dest_calendar_id: string;
      calendar_type: string;
      visibility: string;
      all_day_mode: string;
      copy_outside_work_hours: number;
      color_override: string | null;
    }>(db, "SELECT * FROM mirror_policies WHERE id = ? AND user_id = ?", id, user.id);
    if (!cur) notFound("policy");
    // Fields the body leaves out keep their stored value (an edit sends only what it changed).
    const b = editBody(
      policyInput,
      {
        sourceCalendarId: cur.source_calendar_id,
        destCalendarId: cur.dest_calendar_id,
        calendarType: cur.calendar_type,
        visibility: cur.visibility,
        allDayMode: cur.all_day_mode,
        copyOutsideWorkHours: cur.copy_outside_work_hours === 1,
        colorOverride: cur.color_override,
      },
      await rawBody(c),
    );
    const no = problem(user.id, b, id);
    if (no) return c.json(no, 400);
    run(
      db,
      `UPDATE mirror_policies SET source_calendar_id = ?, dest_calendar_id = ?, calendar_type = ?,
         visibility = ?, all_day_mode = ?, copy_outside_work_hours = ?, color_override = ? WHERE id = ?`,
      b.sourceCalendarId,
      b.destCalendarId,
      b.calendarType,
      b.visibility,
      b.allDayMode,
      b.copyOutsideWorkHours ? 1 : 0,
      b.colorOverride,
      id,
    );
    connect(b);
    sync.request(user.id, 0);
    return c.json({ ok: true });
  });

  /** The status toggle (rules 8, 9, 41): turning a policy on runs a full reconcile. */
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
    if (enabled) run(db, "UPDATE users SET mirror_reconciled_at = NULL WHERE id = ?", user.id);
    sync.request(user.id, 0);
    return c.json({ ok: true });
  });

  r.delete("/mirrors/:id", (c) => {
    const user = c.get("user");
    run(db, "DELETE FROM mirror_policies WHERE id = ? AND user_id = ?", c.req.param("id"), user.id);
    sync.request(user.id, 0);
    return c.body(null, 204);
  });

  return r;
}
