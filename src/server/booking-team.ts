// People of a booking link (docs/specs/booking-links-team.md): organizers and
// the round-robin pool, their inputs for availability, assignment, and the
// booked event on each person's own calendar.
//
// Radicale and most CalDAV servers deliver no invitations. So Tempoloom writes
// a copy of the booked event to the own calendar of each other organizer and
// of the assignee when that calendar is CalDAV. For other providers the host's
// invitation reaches them; the booking then blocks their time from the database
// (a "hold": a participant row without an event).
import { type PoolStats, pickAssignee } from "../scheduler/availability.ts";
import type { WeeklyHours } from "../scheduler/hours.ts";
import type { BufferFilter, ExternalEvent } from "../scheduler/model.ts";
import { matchesFilter } from "../scheduler/plan.ts";
import { all, type Db, one, run } from "./db.ts";
import { writeCalendar } from "./planner/replan.ts";
import type { EventWrite } from "./providers/types.ts";
import { cacheEvent } from "./sync/pull.ts";
import type { SyncService } from "./sync/service.ts";

export interface LinkPerson {
  userId: string;
  kind: "organizer" | "pool";
  /** null: the person's meeting hours. */
  hoursSetId: string | null;
  required: boolean;
  isHost: boolean;
  preferred: boolean;
}

export function linkPeople(db: Db, linkId: string): LinkPerson[] {
  return all<{
    user_id: string;
    kind: "organizer" | "pool";
    hours_set_id: string | null;
    required: number;
    is_host: number;
    preferred: number;
  }>(
    db,
    "SELECT * FROM booking_link_people WHERE link_id = ? ORDER BY kind, position, user_id",
    linkId,
  ).map((p) => ({
    userId: p.user_id,
    kind: p.kind,
    hoursSetId: p.hours_set_id,
    required: p.required === 1,
    isHost: p.is_host === 1,
    preferred: p.preferred === 1,
  }));
}

/** The hours chosen for a person on a link, else the person's meeting hours. */
export function hoursOf(db: Db, userId: string, hoursSetId: string | null): WeeklyHours {
  const row =
    (hoursSetId &&
      one<{ weekly: string }>(
        db,
        "SELECT weekly FROM hours_sets WHERE id = ? AND user_id = ?",
        hoursSetId,
        userId,
      )) ||
    one<{ weekly: string }>(
      db,
      "SELECT weekly FROM hours_sets WHERE user_id = ? AND kind = 'meeting' ORDER BY created_at LIMIT 1",
      userId,
    );
  return JSON.parse(row?.weekly ?? "{}") as WeeklyHours;
}

/**
 * The person's recovery buffer for a booked meeting: the longest "after" side of
 * their enabled buffer automations whose filter matches the meeting. Travel and
 * airport time are not recovery (availability rule 10).
 */
export function recoveryMinutes(db: Db, userId: string, meeting: ExternalEvent): number {
  let longest = 0;
  for (const b of all<{ minutes_after: number; filter: string }>(
    db,
    "SELECT minutes_after, filter FROM buffers WHERE user_id = ? AND enabled = 1 AND side IN ('after', 'both')",
    userId,
  )) {
    const f = JSON.parse(b.filter) as BufferFilter;
    if (f.travel || f.flight || !matchesFilter(f, meeting)) continue;
    longest = Math.max(longest, b.minutes_after);
  }
  return longest;
}

/**
 * The person's travel time for a booked meeting at an address: the longest
 * sides of their enabled travel buffer automations that match it (rule 10).
 * The caller decides that the location is an address from its option kind,
 * so the filter's own address test from the location text is skipped.
 */
export function travelMinutes(
  db: Db,
  userId: string,
  meeting: ExternalEvent,
): { travelBeforeMinutes: number; travelAfterMinutes: number } {
  let before = 0;
  let after = 0;
  for (const b of all<{
    side: string;
    minutes_before: number;
    minutes_after: number;
    filter: string;
  }>(
    db,
    "SELECT side, minutes_before, minutes_after, filter FROM buffers WHERE user_id = ? AND enabled = 1",
    userId,
  )) {
    const f = JSON.parse(b.filter) as BufferFilter;
    if (!f.travel || !matchesFilter({ ...f, travel: false }, meeting)) continue;
    if (b.side !== "after") before = Math.max(before, b.minutes_before);
    if (b.side !== "before") after = Math.max(after, b.minutes_after);
  }
  return { travelBeforeMinutes: before, travelAfterMinutes: after };
}

/** Rule 16 among the pool members who pass for the slot. */
export function assign(
  db: Db,
  linkId: string,
  passing: string[],
  preferred: Set<string>,
  now: number,
): string | undefined {
  // Proposed counting period: bookings that started in the past 30 days or start later.
  const stats = new Map(
    all<{ assignee_id: string; n: number; last: number | null }>(
      db,
      `SELECT assignee_id, COUNT(*) FILTER (WHERE status = 'booked' AND start_ms >= ?) AS n,
         MAX(assigned_at) AS last
       FROM bookings WHERE link_id = ? AND assignee_id IS NOT NULL GROUP BY assignee_id`,
      now - 30 * 86_400_000,
      linkId,
    ).map((s) => [s.assignee_id, s]),
  );
  return pickAssignee(
    passing.map(
      (id): PoolStats => ({
        id,
        preferred: preferred.has(id),
        bookings: stats.get(id)?.n ?? 0,
        lastAssigned: stats.get(id)?.last ?? null,
      }),
    ),
  );
}

/** Booked time of a user who takes part without a copy on their calendar. */
export function bookingHolds(
  db: Db,
  userId: string,
  from: number,
  to: number,
): { id: string; title: string; start: number; end: number }[] {
  return all<{ id: string; name: string; start_ms: number; end_ms: number }>(
    db,
    `SELECT b.id, b.name, b.start_ms, b.end_ms FROM booking_participants p JOIN bookings b ON b.id = p.booking_id
     WHERE p.user_id = ? AND p.event_id IS NULL AND b.status = 'booked' AND b.end_ms > ? AND b.start_ms < ?`,
    userId,
    from,
    to,
  ).map((b) => ({ id: b.id, title: `Booking with ${b.name}`, start: b.start_ms, end: b.end_ms }));
}

export interface Party {
  userId: string;
  optional: boolean;
}

export interface BookedEvent {
  summary: string;
  description: string;
  start: number;
  end: number;
  location: string;
  bookerEmail: string;
  /** Guests the booker added. */
  cc?: string[];
  /** The host's calendar for a new event; null or missing: the main calendar. */
  calendarId?: string | null;
}

export interface Placement {
  hostId: string;
  /** Everyone else who joins: other organizers and the assignee. */
  parties: Party[];
  event: BookedEvent;
}

interface Previous {
  hostId: string;
  calendarId: string | null;
  eventId: string | null;
}

const lower = (e: string) => e.toLowerCase();
const emailOf = (db: Db, userId: string) =>
  one<{ email: string }>(db, "SELECT email FROM users WHERE id = ?", userId)?.email ?? "";

/**
 * Brings the calendars in line with a booking: the event on the host's
 * calendar and the copies on the other participants' calendars. `next` null
 * cancels. Returns the host's event, or null after a cancel.
 */
export async function writeBookingEvents(
  db: Db,
  sync: SyncService,
  bookingId: string,
  prev: Previous | null,
  next: Placement | null,
  log: (msg: string, err: unknown) => void = (m, e) => console.error(m, e),
): Promise<{ calendarId: string; eventId: string } | null> {
  const touched = new Set<string>();
  const calendarOf = (id: string) =>
    one<{
      account_id: string;
      provider_id: string;
      provider: string;
      email: string;
      status: string;
    }>(
      db,
      `SELECT c.account_id, c.provider_id, a.provider, a.email, a.status FROM calendars c
       JOIN accounts a ON a.id = c.account_id WHERE c.id = ?`,
      id,
    );
  const remove = async (userId: string, calendarId: string, eventId: string) => {
    const cal = calendarOf(calendarId);
    if (cal) await sync.pool(userId).get(cal.account_id).deleteEvent(cal.provider_id, eventId);
    run(db, "DELETE FROM events WHERE calendar_id = ? AND event_id = ?", calendarId, eventId);
    touched.add(userId);
  };

  let write: EventWrite | null = null;
  if (next) {
    const host = emailOf(db, next.hostId);
    const booker = next.event.bookerEmail.toLowerCase();
    const others = next.parties.filter((p) => p.userId !== next.hostId);
    const guests = (optional: boolean) =>
      others
        .filter((p) => p.optional === optional)
        .map((p) => emailOf(db, p.userId))
        .filter((e) => e && e !== booker);
    // CC guests who are the booker or an organizer are invited once (edge case 6).
    const people = new Set([host, ...others.map((p) => emailOf(db, p.userId))].map(lower));
    const cc = (next.event.cc ?? []).filter((e) => e !== booker && !people.has(lower(e)));
    write = {
      summary: next.event.summary,
      description: next.event.description,
      start: next.event.start,
      end: next.event.end,
      busy: true,
      colorId: null,
      organizer: host,
      attendees: [booker, ...cc, ...guests(false)],
      optionalAttendees: guests(true),
      ...(next.event.location ? { location: next.event.location } : {}),
      privateProps: { tl_booking: "1", tl_booking_id: bookingId },
    };
  }

  // The host's event.
  let placed: { calendarId: string; eventId: string } | null = null;
  const sameHost = prev && next && prev.hostId === next.hostId && prev.calendarId && prev.eventId;
  if (prev?.calendarId && prev.eventId && !sameHost) {
    await remove(prev.hostId, prev.calendarId, prev.eventId);
  }
  // The old event's account was removed or is disconnected: the booking moves
  // to a new event, so the booker can still change it (connected calendars rule 19).
  const old = sameHost && prev?.calendarId ? calendarOf(prev.calendarId) : undefined;
  if (sameHost && prev?.calendarId && old?.status !== "ok") {
    run(
      db,
      "DELETE FROM events WHERE calendar_id = ? AND event_id = ?",
      prev.calendarId,
      prev.eventId,
    );
  }
  if (next && write) {
    // The account of the host's calendar sends the invitations (connected calendars rule 22).
    if (sameHost && prev?.calendarId && prev.eventId && old?.status === "ok") {
      const cal = old;
      write.organizer = cal.email;
      const ev = await sync
        .pool(next.hostId)
        .get(cal.account_id)
        .updateEvent(cal.provider_id, prev.eventId, write, null);
      cacheEvent(db, prev.calendarId, ev);
      placed = { calendarId: prev.calendarId, eventId: ev.id };
    } else {
      const target = writeCalendar(db, next.hostId, next.event.calendarId);
      if (!target) throw new Error("no_calendar");
      const sender = calendarOf(target.id)?.email;
      if (sender) write.organizer = sender;
      const ev = await sync
        .pool(next.hostId)
        .get(target.account_id)
        .insertEvent(target.provider_id, write);
      cacheEvent(db, target.id, ev);
      placed = { calendarId: target.id, eventId: ev.id };
    }
    touched.add(next.hostId);
  }

  // The other participants' copies or holds.
  const rows = new Map(
    all<{ user_id: string; calendar_id: string | null; event_id: string | null }>(
      db,
      "SELECT user_id, calendar_id, event_id FROM booking_participants WHERE booking_id = ?",
      bookingId,
    ).map((r) => [r.user_id, r]),
  );
  const wanted = new Set(
    (next?.parties ?? []).map((p) => p.userId).filter((id) => id !== next?.hostId),
  );
  for (const [userId, r] of rows) {
    if (wanted.has(userId)) continue;
    if (r.calendar_id && r.event_id) await remove(userId, r.calendar_id, r.event_id);
    run(
      db,
      "DELETE FROM booking_participants WHERE booking_id = ? AND user_id = ?",
      bookingId,
      userId,
    );
    touched.add(userId);
  }
  for (const userId of wanted) {
    if (!write) break;
    const r = rows.get(userId);
    touched.add(userId);
    try {
      if (r?.calendar_id && r.event_id) {
        const cal = calendarOf(r.calendar_id);
        if (!cal) continue;
        const ev = await sync
          .pool(userId)
          .get(cal.account_id)
          .updateEvent(cal.provider_id, r.event_id, write, null);
        cacheEvent(db, r.calendar_id, ev);
        continue;
      }
      if (r) continue; // a hold: the provider delivers the invitation
      const target = writeCalendar(db, userId);
      const cal = target ? calendarOf(target.id) : undefined;
      let copy: { calendarId: string; eventId: string } | null = null;
      if (target && cal?.provider === "caldav") {
        const ev = await sync.pool(userId).get(cal.account_id).insertEvent(cal.provider_id, write);
        cacheEvent(db, target.id, ev);
        copy = { calendarId: target.id, eventId: ev.id };
      }
      run(
        db,
        "INSERT INTO booking_participants (booking_id, user_id, calendar_id, event_id) VALUES (?, ?, ?, ?)",
        bookingId,
        userId,
        copy?.calendarId ?? null,
        copy?.eventId ?? null,
      );
    } catch (err) {
      // The copy failed: keep a hold so the booking still blocks the person's time.
      log(`booking ${bookingId}: copy for user ${userId} failed`, err);
      if (!r) {
        run(
          db,
          "INSERT OR IGNORE INTO booking_participants (booking_id, user_id) VALUES (?, ?)",
          bookingId,
          userId,
        );
      }
    }
  }
  // Each person's scheduler moves managed events away from the booking (team rule 25).
  for (const userId of touched) sync.request(userId, 0);
  return placed;
}
