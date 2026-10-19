// Flexible meetings in the scheduler snapshot (docs/specs/meetings-flexible.md).
// The organizer's run places the meeting; an attendee who is a user here gives
// hours and busy time (rules 11, 13), and sees each occurrence as fixed (rule 27).
import { attends, hasTag, TAG_FREE } from "../../scheduler/blocking.ts";
import { hoursToTimeSet, type WeeklyHours } from "../../scheduler/hours.ts";
import type { ExternalEvent, Level, MeetingItem } from "../../scheduler/model.ts";
import type { Interval, TimeSet } from "../../scheduler/timeset.ts";
import type { LocalDate } from "../../shared/time.ts";
import { all, type Db, one } from "../db.ts";
import { getPrefs } from "../meeting-prefs.ts";
import { externalEvents } from "./events.ts";

export interface MeetingRow {
  id: string;
  user_id: string;
  title: string;
  description: string;
  location: string;
  enabled: number;
  level: Level;
  rank: number;
  frequency: string;
  ideal_minute: number;
  duration_minutes: number;
  shortest_minutes: number;
  hours_mode: "everyone" | "organizer";
  hours_set_id: string;
  starting: string | null;
  defense: MeetingItem["defense"];
  when_unplaceable: MeetingItem["whenUnplaceable"];
  lead_minutes: number;
  created_at: number;
  rules_changed_at: number;
  auto_reschedule: AutoReschedule;
  series_calendar_id: string | null;
  series_event_id: string | null;
}

/** MEET-02 rule 9: automatic moves per rolling 24 hours. */
export const MOVE_LIMITS = { none: 0, conservative: 1, moderate: 3, aggressive: 5 } as const;
export type AutoReschedule = keyof typeof MOVE_LIMITS;

/** Automatic moves of a meeting in the 24 hours before `now` (the change log). */
export function recentMoves(db: Db, meetingId: string, now: number): number {
  return (
    one<{ n: number }>(
      db,
      `SELECT count(*) AS n FROM meeting_changes WHERE meeting_id = ? AND at > ?
         AND reason IN ('conflict', 'declined') AND new_start IS NOT NULL`,
      meetingId,
      now - 86_400_000,
    )?.n ?? 0
  );
}

export interface Attendee {
  email: string;
  required: boolean;
}

export interface InstanceUser {
  id: string;
  name: string;
  time_zone: string;
}

/** Class `user`: a user here with a connected calendar. Other emails are class `none`. */
export function instanceUser(db: Db, email: string): InstanceUser | undefined {
  return one<InstanceUser>(
    db,
    `SELECT u.id, u.name, u.time_zone FROM users u WHERE u.email = ?
       AND EXISTS (SELECT 1 FROM accounts a WHERE a.user_id = u.id AND a.status = 'ok')`,
    email.toLowerCase(),
  );
}

export function attendeesOf(db: Db, meetingId: string): Attendee[] {
  return all<{ email: string; required: number }>(
    db,
    "SELECT email, required FROM meeting_attendees WHERE meeting_id = ? ORDER BY email",
    meetingId,
  ).map((a) => ({ email: a.email, required: a.required === 1 }));
}

/**
 * Busy time of one attendee for a meeting (rule 13): busy events the attendee
 * attends, booking-link events, locked managed events, P1 managed events, and
 * occurrences of other meetings the attendee must join. Tags do not apply.
 */
function attendeeBusy(
  db: Db,
  user: InstanceUser,
  email: string,
  meetingId: string,
  from: number,
  to: number,
): Interval[] {
  const external = externalEvents(db, user.id, from, to)
    .filter((e) => e.bookedViaLink || (e.busy && attends(e)))
    .map((e) => ({ start: e.start, end: e.end }));
  const managed = all<{ start_ms: number; end_ms: number }>(
    db,
    `SELECT start_ms, end_ms FROM managed_events m WHERE m.user_id = ? AND m.end_ms > ? AND m.start_ms < ?
       AND m.kind <> 'mirror' AND (
         m.locked = 1
         OR (m.kind = 'task' AND m.source_id IN (SELECT id FROM tasks WHERE level = 1))
         OR (m.kind = 'habit' AND m.source_id IN (SELECT id FROM habits WHERE level = 1))
         OR (m.kind = 'meeting' AND m.source_id IN (SELECT id FROM meetings WHERE level = 1)))`,
    user.id,
    from,
    to,
  );
  const joined = all<{ start_ms: number; end_ms: number }>(
    db,
    `SELECT m.start_ms, m.end_ms FROM managed_events m
       JOIN meeting_attendees a ON a.meeting_id = m.source_id AND m.kind = 'meeting'
     WHERE a.email = ? AND a.required = 1 AND m.source_id <> ? AND m.end_ms > ? AND m.start_ms < ?`,
    email,
    meetingId,
    from,
    to,
  );
  return [
    ...external,
    ...[...managed, ...joined].map((r) => ({ start: r.start_ms, end: r.end_ms })),
  ];
}

function meetingHours(db: Db, userId: string): WeeklyHours {
  const row = one<{ weekly: string }>(
    db,
    `SELECT weekly FROM hours_sets WHERE user_id = ?
     ORDER BY CASE kind WHEN 'meeting' THEN 0 WHEN 'work' THEN 1 ELSE 2 END, created_at LIMIT 1`,
    userId,
  );
  return row ? (JSON.parse(row.weekly) as WeeklyHours) : {};
}

/** One meeting as a scheduler item, with its attendees' hours and busy time. */
export function meetingItem(
  db: Db,
  userId: string,
  m: MeetingRow,
  attendees: Attendee[],
  now: number,
  windowEnd: number,
  lastPlannedAt: number,
  exclusions: Map<string, Interval[]>,
): MeetingItem {
  let window: TimeSet | null = null;
  // The organizer's no-meeting time (events-tags.md rules 3, 8): a busy #tl_free
  // event they attend is free for tasks and habits, but never for meetings.
  const busy: Interval[] = externalEvents(db, userId, now, windowEnd)
    .filter((e) => e.busy && attends(e) && hasTag(e, TAG_FREE))
    .map((e) => ({ start: e.start, end: e.end }));
  for (const a of attendees) {
    if (!a.required) continue;
    const user = instanceUser(db, a.email);
    if (!user || user.id === userId) continue;
    busy.push(...attendeeBusy(db, user, a.email, m.id, now, windowEnd));
    if (m.hours_mode === "everyone") {
      const own = hoursToTimeSet(meetingHours(db, user.id), user.time_zone, now, windowEnd);
      window = window ? window.intersect(own) : own;
    }
  }
  return {
    id: m.id,
    title: m.title,
    level: m.level,
    rank: m.rank,
    createdAt: m.created_at,
    hours: m.hours_set_id,
    attendeeWindow: window ? [...window.intervals()] : null,
    attendeeBusy: busy,
    idealMinute: m.ideal_minute,
    frequency: JSON.parse(m.frequency) as MeetingItem["frequency"],
    durationMinutes: m.duration_minutes,
    shortestMinutes: m.shortest_minutes,
    starting: m.starting,
    defense: m.defense,
    whenUnplaceable: m.when_unplaceable,
    leadMinutes: m.lead_minutes,
    exclusions: exclusions.get(`meeting:${m.id}`) ?? [],
    changed: m.rules_changed_at > lastPlannedAt,
    moveLimit: MOVE_LIMITS[m.auto_reschedule] ?? MOVE_LIMITS.moderate,
    movesLeft:
      (MOVE_LIMITS[m.auto_reschedule] ?? MOVE_LIMITS.moderate) - recentMoves(db, m.id, now),
    startMinutes: getPrefs(db, userId).startMinutes,
    // An adopted series: only periods that have an instance of it.
    ...(m.series_event_id
      ? {
          periods: all<{ key: string }>(
            db,
            "SELECT key FROM managed_events WHERE user_id = ? AND kind = 'meeting' AND source_id = ?",
            userId,
            m.id,
          ).map((r) => r.key.slice(r.key.lastIndexOf(":") + 1) as LocalDate),
        }
      : {}),
  };
}

/** The organizer's enabled meetings as scheduler items. */
export function meetingItems(
  db: Db,
  userId: string,
  now: number,
  windowEnd: number,
  lastPlannedAt: number,
  exclusions: Map<string, Interval[]>,
): { items: MeetingItem[]; rows: MeetingRow[] } {
  const rows = all<MeetingRow>(
    db,
    "SELECT * FROM meetings WHERE user_id = ? AND enabled = 1",
    userId,
  );
  const items = rows.map((m) =>
    meetingItem(db, userId, m, attendeesOf(db, m.id), now, windowEnd, lastPlannedAt, exclusions),
  );
  return { items, rows };
}

/** Occurrences of other people's meetings that this user must join: fixed P1 time (rule 27). */
export function attendeeOccurrences(
  db: Db,
  userId: string,
  now: number,
  windowEnd: number,
): ExternalEvent[] {
  const email = one<{ email: string }>(db, "SELECT email FROM users WHERE id = ?", userId)?.email;
  if (!email) return [];
  return all<{ id: string; title: string; start_ms: number; end_ms: number }>(
    db,
    `SELECT m.id, mt.title, m.start_ms, m.end_ms FROM managed_events m
       JOIN meetings mt ON mt.id = m.source_id AND m.kind = 'meeting'
       JOIN meeting_attendees a ON a.meeting_id = mt.id
     WHERE a.email = ? AND a.required = 1 AND m.user_id <> ? AND m.end_ms > ? AND m.start_ms < ?`,
    email,
    userId,
    now,
    windowEnd,
  ).map((m) => ({
    id: `meeting:${m.id}`,
    start: m.start_ms,
    end: m.end_ms,
    allDay: false,
    busy: true,
    title: m.title,
    description: "",
    selfResponse: null,
    organizerSelf: true,
    attendeeCount: 2,
    location: "",
    eventType: "default",
    bookedViaLink: false,
  }));
}

/** Organizers whose meetings this user joins, and attendees (users here) of this user's meetings. */
export function meetingPeers(
  db: Db,
  userId: string,
): { organizers: string[]; attendees: string[] } {
  const email = one<{ email: string }>(db, "SELECT email FROM users WHERE id = ?", userId)?.email;
  const organizers = all<{ user_id: string }>(
    db,
    `SELECT DISTINCT m.user_id FROM meetings m JOIN meeting_attendees a ON a.meeting_id = m.id
     WHERE a.email = ? AND m.user_id <> ? AND m.enabled = 1`,
    email ?? "",
    userId,
  ).map((r) => r.user_id);
  const attendees = all<{ id: string }>(
    db,
    `SELECT DISTINCT u.id FROM meetings m JOIN meeting_attendees a ON a.meeting_id = m.id
       JOIN users u ON u.email = a.email
     WHERE m.user_id = ? AND u.id <> ?`,
    userId,
    userId,
  ).map((r) => r.id);
  return { organizers, attendees };
}
