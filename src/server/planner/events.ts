// External events of a user, read from the event cache in scheduler form.
import type { ExternalEvent } from "../../scheduler/model.ts";
import { bookingHolds } from "../booking-team.ts";
import { all, type Db } from "../db.ts";
import { categoryContext, externalCategory } from "./categories.ts";
import { MANAGED_PROP } from "./push.ts";

/** Events on the user's availability calendars in [from, to), without Tempoloom's own. */
export function externalEvents(db: Db, userId: string, from: number, to: number): ExternalEvent[] {
  let ctx: ReturnType<typeof categoryContext> | undefined;
  const events = all<{
    event_id: string;
    calendar_id: string;
    summary: string;
    description: string;
    location: string;
    start_ms: number;
    end_ms: number;
    all_day: number;
    busy: number;
    event_type: string;
    self_response: ExternalEvent["selfResponse"];
    attendee_count: number;
    organizer_self: number;
    private_props: string;
    attendees: string;
    recurring_id: string | null;
  }>(
    db,
    `SELECT e.* FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN accounts a ON a.id = c.account_id
     WHERE a.user_id = ? AND a.status = 'ok' AND c.check_availability = 1 AND e.end_ms > ? AND e.start_ms < ?`,
    userId,
    from,
    to,
  ).flatMap((e): ExternalEvent[] => {
    ctx ??= categoryContext(db, userId);
    const props = JSON.parse(e.private_props) as Record<string, string>;
    if (props[MANAGED_PROP] === "1") return [];
    return [
      {
        id: `${e.calendar_id}:${e.event_id}`,
        start: e.start_ms,
        end: e.end_ms,
        allDay: e.all_day === 1,
        busy: e.busy === 1,
        title: e.summary,
        description: e.description,
        selfResponse: e.self_response,
        organizerSelf: e.organizer_self === 1,
        attendeeCount: e.attendee_count,
        location: e.location,
        eventType: e.event_type,
        bookedViaLink: props.tl_booking === "1",
        category: externalCategory(ctx, e),
        calendarId: e.calendar_id,
        attendees: JSON.parse(e.attendees) as string[],
      },
    ];
  });
  // Bookings the user joins whose invitation the provider delivers (booking-links-team rule 25).
  for (const h of bookingHolds(db, userId, from, to)) {
    events.push({
      id: `booking:${h.id}`,
      start: h.start,
      end: h.end,
      allDay: false,
      busy: true,
      title: h.title,
      description: "",
      selfResponse: null,
      organizerSelf: false,
      attendeeCount: 2,
      location: "",
      eventType: "default",
      bookedViaLink: true,
    });
  }
  return events;
}
