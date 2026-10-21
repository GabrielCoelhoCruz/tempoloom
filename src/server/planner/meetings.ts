// Flexible meetings in the scheduler snapshot (docs/specs/meetings-flexible.md).
// The organizer's run places the meeting; an attendee who is a user here gives
// hours and busy time (rules 11, 13), and sees each occurrence as fixed (rule 27).
import { attends, hasTag, TAG_FREE } from "../../scheduler/blocking.ts";
import { hoursToTimeSet, type WeeklyHours } from "../../scheduler/hours.ts";
import type { ExternalEvent, Level, MeetingItem } from "../../scheduler/model.ts";
import { type Interval, TimeSet } from "../../scheduler/timeset.ts";
import type { LocalDate } from "../../shared/time.ts";
import { all, type Db, one, run } from "../db.ts";
import { getPrefs } from "../meeting-prefs.ts";
import type { CalendarProvider } from "../providers/types.ts";
import { externalEvents, OFF_MAIN_TASK_CHUNK } from "./events.ts";
import { meetingBoost } from "./meeting-log.ts";

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
  /** JSON event settings: visibility, reminders, calendar (src/shared/event-settings.ts). */
  event_settings: string;
  /** The attendees' hours the last plan used (attendeeHoursKey); '' before the first plan. */
  attendee_hours: string;
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
  /** Rule 7: the organizer's hours for this guest, in the guest's zone; null: their own. */
  hoursOverride?: WeeklyHours | null;
}

export interface InstanceUser {
  id: string;
  name: string;
  time_zone: string;
}

/** Guests per Google free/busy request; Google refuses longer lists. */
export const GUEST_FREE_BUSY_BATCH = 50;
/** At most this many guests are asked per run; the rest are unknown. */
const GUEST_FREE_BUSY_MAX = 4 * GUEST_FREE_BUSY_BATCH;
/** A run waits this long for Google; after that the guests are unknown. */
const GUEST_FREE_BUSY_TIMEOUT = 5_000;
/** Runs this close together use the same answer (each sync tick and edit plans again). */
export const GUEST_FREE_BUSY_TTL = 5 * 60_000;

const guestCache = new WeakMap<
  Db,
  Map<string, { emails: string; at: number; busy: Map<string, Interval[]> }>
>();

/**
 * Class `freebusy`: busy time of required guests who are not users here, read
 * with Google free/busy from the organizer's Google account (concepts, attendee
 * class). A guest with no data, a failed or slow query, or an organizer without
 * a Google account gives no entry: class `none`, availability unknown.
 */
export async function guestFreeBusy(
  db: Db,
  provider: (accountId: string) => CalendarProvider,
  userId: string,
  from: number,
  to: number,
): Promise<Map<string, Interval[]>> {
  const google = one<{ id: string }>(
    db,
    `SELECT id FROM accounts WHERE user_id = ? AND provider = 'google' AND status = 'ok'
     ORDER BY is_main DESC, created_at LIMIT 1`,
    userId,
  );
  if (!google) return new Map();
  const emails = all<{ email: string }>(
    db,
    `SELECT DISTINCT a.email FROM meeting_attendees a JOIN meetings m ON m.id = a.meeting_id
     WHERE m.user_id = ? AND m.enabled = 1 AND a.required = 1 ORDER BY a.email`,
    userId,
  )
    .map((r) => r.email)
    .filter((email) => !instanceUser(db, email))
    .slice(0, GUEST_FREE_BUSY_MAX);
  const source = provider(google.id);
  if (emails.length === 0 || !source.freeBusy) return new Map();
  const cache = guestCache.get(db) ?? new Map();
  guestCache.set(db, cache);
  const key = emails.join(",");
  const hit = cache.get(userId);
  if (hit && hit.emails === key && from - hit.at < GUEST_FREE_BUSY_TTL && from >= hit.at)
    return hit.busy;
  const batches: string[][] = [];
  for (let i = 0; i < emails.length; i += GUEST_FREE_BUSY_BATCH)
    batches.push(emails.slice(i, i + GUEST_FREE_BUSY_BATCH));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const busy = await Promise.race([
    Promise.all(batches.map((b) => source.freeBusy?.(b, from, to) ?? new Map())).then(
      (maps) => new Map(maps.flatMap((m) => [...m])),
    ),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out")), GUEST_FREE_BUSY_TIMEOUT);
    }),
  ])
    .catch((err: unknown) => {
      console.error("Google free/busy failed; guest availability is unknown", err);
      return new Map<string, Interval[]>();
    })
    .finally(() => clearTimeout(timer));
  // A failed query is kept too, so a slow or refusing Google is not asked on every run.
  cache.set(userId, { emails: key, at: from, busy });
  return busy;
}

/** Busy time minus the meeting's own placed occurrences (the guest's copy of its invitation). */
function withoutOwnOccurrences(
  db: Db,
  userId: string,
  meetingId: string,
  busy: Interval[],
): Interval[] {
  if (busy.length === 0) return busy;
  const set = TimeSet.from(busy);
  for (const o of all<Interval>(
    db,
    `SELECT start_ms AS start, end_ms AS end FROM managed_events
     WHERE user_id = ? AND kind = 'meeting' AND source_id = ?`,
    userId,
    meetingId,
  ))
    set.subtract(o);
  return [...set.intervals()];
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
  return all<{ email: string; required: number; hours_override: string | null }>(
    db,
    "SELECT email, required, hours_override FROM meeting_attendees WHERE meeting_id = ? ORDER BY email",
    meetingId,
  ).map((a) => ({
    email: a.email,
    required: a.required === 1,
    hoursOverride: a.hours_override ? (JSON.parse(a.hours_override) as WeeklyHours) : null,
  }));
}

/**
 * Busy time of one attendee for a meeting (rule 13): busy events the attendee
 * attends, booking-link events, locked managed events, P1 managed events, and
 * occurrences of other meetings the attendee must join. Tags do not apply.
 * Unlocked task chunks on a calendar other than the main calendar do not count
 * (DEF-50); a locked one never moves (LCK-2), so it counts as any locked event.
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
       AND m.kind <> 'mirror' AND NOT (m.locked = 0 AND ${OFF_MAIN_TASK_CHUNK}) AND (
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

/** The hours set that limits other people's meetings with this user: meeting hours, else work hours. */
export function meetingHoursJson(db: Db, userId: string): string {
  return (
    one<{ weekly: string }>(
      db,
      `SELECT weekly FROM hours_sets WHERE user_id = ? AND item_specific = 0
       ORDER BY CASE kind WHEN 'meeting' THEN 0 WHEN 'work' THEN 1 ELSE 2 END, created_at LIMIT 1`,
      userId,
    )?.weekly ?? "{}"
  );
}

/**
 * Rule 11: the hours and time zones of the required attendees that limit a
 * meeting in mode `everyone`. A change of any of them places it again.
 */
function attendeeHoursKey(db: Db, userId: string, m: MeetingRow, attendees: Attendee[]): string {
  if (m.hours_mode !== "everyone") return "-";
  const parts: string[] = [];
  for (const a of attendees) {
    const user = a.required ? instanceUser(db, a.email) : undefined;
    if (user && user.id !== userId)
      parts.push(`${user.id} ${user.time_zone} ${guestHoursJson(db, user.id, a)}`);
  }
  return parts.join("\n") || "-";
}

/** Rule 11: a guest's hours for a meeting: the organizer's choice (rule 7), else meeting hours. */
export const guestHoursJson = (db: Db, userId: string, a: Attendee): string =>
  a.hoursOverride ? JSON.stringify(a.hoursOverride) : meetingHoursJson(db, userId);

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
  guestBusy: Map<string, Interval[]> = new Map(),
): MeetingItem {
  const boost = meetingBoost(db, userId, m, now);
  let window: TimeSet | null = null;
  // The organizer's no-meeting time (events-tags.md rules 3, 8): a busy #tl_free
  // event they attend is free for tasks and habits, but never for meetings.
  const busy: Interval[] = externalEvents(db, userId, now, windowEnd)
    .filter((e) => e.busy && attends(e) && hasTag(e, TAG_FREE))
    .map((e) => ({ start: e.start, end: e.end }));
  for (const a of attendees) {
    if (!a.required) continue;
    const user = instanceUser(db, a.email);
    if (!user) busy.push(...withoutOwnOccurrences(db, userId, m.id, guestBusy.get(a.email) ?? []));
    if (!user || user.id === userId) continue;
    busy.push(...attendeeBusy(db, user, a.email, m.id, now, windowEnd));
    if (m.hours_mode === "everyone") {
      const hours = JSON.parse(guestHoursJson(db, user.id, a)) as WeeklyHours;
      const own = hoursToTimeSet(hours, user.time_zone, now, windowEnd);
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
    ...lastStart(db, userId, m.id, now),
    ...manualKeys(db, m.id, now),
    ...(boost ? { boost: { period: boost.period, level: boost.level } } : {}),
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

/** MEET-02 rule 19: future occurrences whose last logged change is a move by hand. */
function manualKeys(db: Db, meetingId: string, now: number) {
  const keys = all<{ key: string }>(
    db,
    `SELECT occurrence_key AS key FROM meeting_changes c WHERE meeting_id = ? AND reason = 'manualMove'
       AND new_start > ? AND id = (SELECT max(id) FROM meeting_changes
         WHERE meeting_id = c.meeting_id AND occurrence_key = c.occurrence_key)`,
    meetingId,
    now,
  ).map((r) => r.key);
  return keys.length > 0 ? { manualKeys: keys } : {};
}

/** Rule 18: the start of the meeting's last occurrence before now. */
function lastStart(db: Db, userId: string, meetingId: string, now: number) {
  const t = one<{ t: number | null }>(
    db,
    `SELECT max(start_ms) AS t FROM managed_events
     WHERE user_id = ? AND kind = 'meeting' AND source_id = ? AND start_ms < ?`,
    userId,
    meetingId,
    now,
  )?.t;
  return t === null || t === undefined ? {} : { previousStart: t };
}

/** The organizer's enabled meetings as scheduler items. */
export function meetingItems(
  db: Db,
  userId: string,
  now: number,
  windowEnd: number,
  lastPlannedAt: number,
  exclusions: Map<string, Interval[]>,
  guestBusy: Map<string, Interval[]> = new Map(),
): { items: MeetingItem[]; rows: MeetingRow[] } {
  const rows = all<MeetingRow>(
    db,
    "SELECT * FROM meetings WHERE user_id = ? AND enabled = 1",
    userId,
  );
  const items = rows.map((m) => {
    const attendees = attendeesOf(db, m.id);
    const key = attendeeHoursKey(db, userId, m, attendees);
    if (key !== m.attendee_hours) {
      // Not on the first plan of a meeting: nothing was placed with older hours.
      if (m.attendee_hours !== "") m.rules_changed_at = now;
      run(
        db,
        "UPDATE meetings SET attendee_hours = ?, rules_changed_at = ? WHERE id = ?",
        key,
        m.rules_changed_at,
        m.id,
      );
    }
    return meetingItem(
      db,
      userId,
      m,
      attendees,
      now,
      windowEnd,
      lastPlannedAt,
      exclusions,
      guestBusy,
    );
  });
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

/**
 * Organizers whose meetings this user joins, and attendees (users here) of this
 * user's meetings, matched as instanceUser matches attendees.
 */
export function meetingPeers(
  db: Db,
  userId: string,
): { organizers: string[]; attendees: string[] } {
  const email = one<{ email: string }>(db, "SELECT email FROM users WHERE id = ?", userId)?.email;
  const organizers = all<{ user_id: string }>(
    db,
    `SELECT DISTINCT m.user_id FROM meetings m JOIN meeting_attendees a ON a.meeting_id = m.id
     WHERE a.email = ? AND m.user_id <> ? AND m.enabled = 1`,
    (email ?? "").toLowerCase(),
    userId,
  ).map((r) => r.user_id);
  const attendees = all<{ id: string }>(
    db,
    `SELECT DISTINCT u.id FROM meetings m JOIN meeting_attendees a ON a.meeting_id = m.id
       JOIN users u ON u.email = a.email
     WHERE m.user_id = ? AND u.id <> ?
       AND EXISTS (SELECT 1 FROM accounts x WHERE x.user_id = u.id AND x.status = 'ok')`,
    userId,
    userId,
  ).map((r) => r.id);
  return { organizers, attendees };
}

/**
 * Rule 11: this user's meeting hours or time zone may have changed. The
 * organizers of meetings this user joins plan again; each run compares the
 * hours it uses with the last ones (attendeeHoursKey) and places again on a change.
 */
export function wakeOrganizers(
  db: Db,
  sync: { request(userId: string): void },
  userId: string,
): void {
  for (const id of meetingPeers(db, userId).organizers) sync.request(id);
}
