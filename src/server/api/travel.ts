// Travel time zones (docs/specs/timezones-home-and-travel.md rules 6, 7, 9, 12).
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { addDays, isValidTimeZone, utcToLocal } from "../../shared/time.ts";
import type { AppEnv } from "../app.ts";
import { type Db, one, run } from "../db.ts";
import { jsonBody, notFound } from "../http.ts";
import type { SyncService } from "../sync/service.ts";
import { activeTrip, homeZone, travelEntries, tripEnd, tripStart } from "../travel.ts";
import { badRequest } from "./items.ts";

const entry = z.object({
  tz: z.string().trim().refine(isValidTimeZone, "Unknown time zone"),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
});

export function travelRoutes(db: Db, sync: SyncService, now: () => number): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  /** Rules 5, 13: a zone change re-places every unlocked future event. */
  const replace = (userId: string) => {
    const t = now();
    for (const table of ["tasks", "habits", "focus_goals"])
      run(db, `UPDATE ${table} SET rules_changed_at = ? WHERE user_id = ?`, t, userId);
    sync.request(userId, 0);
  };

  r.get("/travel", (c) => {
    const user = c.get("user");
    const t = now();
    const trip = activeTrip(db, user.id, t);
    // Rule 12: active and future trips first, so a forgotten one is easy to find.
    const entries = travelEntries(db, user.id)
      .map((e) => ({ ...e, active: e.id === trip?.id, past: tripEnd(e) <= t }))
      .sort((a, b) => Number(a.past) - Number(b.past) || a.start_date.localeCompare(b.start_date));
    return c.json({ home: homeZone(db, user.id), active: trip, entries });
  });

  r.post("/travel", async (c) => {
    const user = c.get("user");
    const body = await jsonBody(c, entry);
    if (body.endDate < body.startDate) badRequest("endDate", "The trip ends before it starts.");
    const clash = travelEntries(db, user.id).find(
      (e) => e.start_date <= body.endDate && body.startDate <= e.end_date,
    );
    if (clash)
      badRequest(
        "startDate",
        `This trip overlaps the trip to ${clash.tz} (${clash.start_date} to ${clash.end_date}).`,
      );
    const id = randomUUID();
    run(
      db,
      "INSERT INTO travel_zones (id, user_id, tz, start_date, end_date, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      user.id,
      body.tz,
      body.startDate,
      body.endDate,
      now(),
    );
    replace(user.id);
    return c.json({ id }, 201);
  });

  r.delete("/travel/:id", (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    if (!one(db, "SELECT 1 FROM travel_zones WHERE id = ? AND user_id = ?", id, user.id))
      notFound("travel entry");
    run(db, "DELETE FROM travel_zones WHERE id = ?", id);
    replace(user.id);
    return c.body(null, 204);
  });

  /** Rule 9: back home early. The trip ends yesterday, or goes if it ended before it began. */
  r.post("/travel/:id/end", (c) => {
    const user = c.get("user");
    const e = travelEntries(db, user.id).find((x) => x.id === c.req.param("id"));
    if (!e) notFound("travel entry");
    const yesterday = addDays(utcToLocal(e.tz, now()).date, -1);
    if (yesterday < e.start_date || now() < tripStart(e))
      run(db, "DELETE FROM travel_zones WHERE id = ?", e.id);
    else run(db, "UPDATE travel_zones SET end_date = ? WHERE id = ?", yesterday, e.id);
    replace(user.id);
    return c.json({ ok: true });
  });

  return r;
}
