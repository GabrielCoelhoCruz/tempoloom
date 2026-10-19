// What a signed-in person sees on a booking page besides the offered times
// (booking-links-booking-page.md rules 6, 10, 11 and 33): their calendar's
// zone, whether they organize the link, and their own events for the overlay.
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { linkPeople } from "../booking-team.ts";
import { all, type Db } from "../db.ts";
import { notFound } from "../http.ts";
import { sameTeam } from "../teams.ts";
import { type LinkRow, resolveLink } from "./booking.ts";

const MAX_SPAN = 16 * 86_400_000;

/** True when the user owns the link or is one of its people in the owner's team (team rule 22). */
export function organizes(db: Db, link: LinkRow, userId: string): boolean {
  if (link.user_id === userId) return true;
  return (
    sameTeam(db, link.user_id, userId) && linkPeople(db, link.id).some((p) => p.userId === userId)
  );
}

export function bookingViewerRoutes(db: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/viewer", (c) => {
    const user = c.get("user");
    const { page, link } = c.req.query();
    const found = page && link ? resolveLink(db, page, link) : undefined;
    return c.json({
      zone: user.time_zone,
      organizer: found ? organizes(db, found, user.id) : false,
      linkId: found && organizes(db, found, user.id) ? found.id : null,
    });
  });

  /** The signed-in booker's own events, never stored with a booking (rule 33). */
  r.get("/overlay", (c) => {
    const q = z
      .object({ from: z.coerce.number().int(), to: z.coerce.number().int() })
      .safeParse(c.req.query());
    if (!q.success || q.data.to <= q.data.from || q.data.to - q.data.from > MAX_SPAN)
      notFound("range");
    const events = all<{ summary: string; start_ms: number; end_ms: number; all_day: number }>(
      db,
      `SELECT DISTINCT e.summary, e.start_ms, e.end_ms, e.all_day FROM events e
       JOIN calendars c ON c.id = e.calendar_id JOIN accounts a ON a.id = c.account_id
       WHERE a.user_id = ? AND e.end_ms > ? AND e.start_ms < ? ORDER BY e.start_ms`,
      c.get("user").id,
      q.data.from,
      q.data.to,
    );
    return c.json({
      events: events.map((e) => ({
        title: e.summary,
        start: e.start_ms,
        end: e.end_ms,
        allDay: e.all_day === 1,
      })),
    });
  });
  return r;
}
