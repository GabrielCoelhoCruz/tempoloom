// The buffer filter editor's live list of matching events
// (docs/specs/buffers-automation.md rule 3).
import { Hono } from "hono";
import { z } from "zod";
import type { BufferFilter } from "../../scheduler/model.ts";
import { bufferAnchors } from "../../scheduler/plan.ts";
import { DAY } from "../../shared/time.ts";
import type { AppEnv } from "../app.ts";
import { all, type Db } from "../db.ts";
import { jsonBody } from "../http.ts";
import { externalEvents } from "../planner/events.ts";
import { copyAnchors } from "../planner/replan.ts";
import { getSettings } from "../settings.ts";
import { bufferInput } from "./items.ts";

/** At most this many events are listed. */
const LIST_LIMIT = 50;

export function bufferFilterRoutes(db: Db, now: () => number): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  /** Upcoming events in the scheduling window that the filter matches, as anchors. */
  r.post("/buffers/matches", async (c) => {
    const user = c.get("user");
    const body = await jsonBody(
      c,
      z.object({
        filter: bufferInput.shape.filter.unwrap(),
        calendarScope: z.string().nullable().default(null),
      }),
    );
    const t = now();
    const to = t + getSettings(db, user.id).schedulingWindowWeeks * 7 * DAY;
    const names = new Map(
      all<{ id: string; name: string }>(
        db,
        `SELECT c.id, c.name FROM calendars c JOIN accounts a ON a.id = c.account_id WHERE a.user_id = ?`,
        user.id,
      ).map((x) => [x.id, x.name]),
    );
    const anchors = bufferAnchors(
      externalEvents(db, user.id, t, to),
      copyAnchors(db, user.id, t),
      { filter: body.filter as BufferFilter, calendarScope: body.calendarScope },
      t,
      to,
    );
    return c.json({
      total: anchors.length,
      events: anchors.slice(0, LIST_LIMIT).map((a) => ({
        id: a.id,
        title: a.title,
        start: a.start,
        end: a.end,
        calendar: names.get(a.calendarId ?? "") ?? "",
      })),
    });
  });

  return r;
}
