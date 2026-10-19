// What a signed-in person sees on a booking page besides the offered times
// (booking-links-booking-page.md rules 6, 10, 11 and 33): their calendar's
// zone, whether they organize the link, and their own events for the overlay.
import { Hono } from "hono";
import { z } from "zod";
import { type Failure, inspectTimes, type Reason } from "../../scheduler/inspect.ts";
import { addDays, localToUtc, utcToLocal } from "../../shared/time.ts";
import type { AppEnv } from "../app.ts";
import { linkPeople } from "../booking-team.ts";
import { all, type Db, one } from "../db.ts";
import { notFound } from "../http.ts";
import { sameTeam } from "../teams.ts";
import { type LinkRow, linkInputs, resolveLink } from "./booking.ts";

const MAX_SPAN = 16 * 86_400_000;

/** True when the user owns the link or is one of its people in the owner's team (team rule 22). */
export function organizes(db: Db, link: LinkRow, userId: string): boolean {
  if (link.user_id === userId) return true;
  return (
    sameTeam(db, link.user_id, userId) && linkPeople(db, link.id).some((p) => p.userId === userId)
  );
}

const RANGE: Reason[] = ["past", "beforeRangeStart", "afterRangeEnd"];

/** The settings that control a failed check, as links for the viewer (rule 21). */
function settingsFor(f: Failure, linkId: string, own: boolean, zone: string) {
  const edit = `/links?edit=${linkId}`;
  const planner =
    f.item && own
      ? [{ label: "Open in the planner", href: `/?week=${utcToLocal(zone, f.item.start).date}` }]
      : [];
  if (RANGE.includes(f.code)) return [{ label: "Change the range", href: edit }];
  if (f.code === "limitReached") return [{ label: "Change the limits", href: edit }];
  if (f.code === "outsideHours") return own ? [{ label: "Change hours", href: "/settings" }] : [];
  if (f.code === "buffer") return [{ label: "Change the buffers", href: edit }];
  if (f.code === "higherPriority")
    return [...planner, { label: "Change the link priority", href: edit }];
  return planner;
}

export function bookingViewerRoutes(db: Db, now: () => number): Hono<AppEnv> {
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

  /**
   * The availability inspector, for organizers only (availability rules 18-22):
   * every candidate start from today to the range end plus 14 days.
   */
  r.get("/inspect", (c) => {
    const user = c.get("user");
    const q = z
      .object({
        page: z.string(),
        link: z.string(),
        duration: z.coerce.number().int(),
        from: z.coerce.number().int(),
        to: z.coerce.number().int(),
      })
      .safeParse(c.req.query());
    if (!q.success) notFound("link");
    const link = resolveLink(db, q.data.page, q.data.link);
    if (!link || !organizes(db, link, user.id)) notFound("link");
    if (!(JSON.parse(link.durations) as number[]).includes(q.data.duration)) notFound("duration");
    const at = now();
    const zone =
      one<{ time_zone: string }>(db, "SELECT time_zone FROM users WHERE id = ?", link.user_id)
        ?.time_zone ?? "UTC";
    const today = utcToLocal(zone, at).date;
    const until = localToUtc(zone, addDays(today, link.range_end_days + 1 + 14), 0);
    const from = Math.max(q.data.from, localToUtc(zone, today, 0));
    const to = Math.min(q.data.to, from + MAX_SPAN, until);
    const inputs = to > from ? linkInputs(db, link, q.data.duration, from, to, at) : null;
    const people = new Map(
      all<{ id: string; name: string; email: string }>(
        db,
        "SELECT u.id, u.name, u.email FROM booking_link_people p JOIN users u ON u.id = p.user_id WHERE p.link_id = ?",
        link.id,
      ).map((p) => [p.id, p]),
    );
    const times = inputs
      ? inspectTimes(inputs.rules, inputs.required, inputs.pool, inputs.bookings, at, from, to)
      : [];
    return c.json({
      until,
      times: times.map((t) => ({
        start: t.start,
        end: t.end,
        offered: t.offered,
        preferred: t.preferred,
        failures: t.failures.map((f) => {
          // Event titles only for the viewer's own events (rule 21).
          const own = f.personId === user.id;
          const person = f.personId ? people.get(f.personId) : undefined;
          return {
            code: f.code,
            person: person ? { name: person.name, email: person.email } : null,
            event: f.item ? { title: own ? (f.item.title ?? "") : null } : null,
            settings: settingsFor(f, link.id, own, user.time_zone),
          };
        }),
      })),
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
