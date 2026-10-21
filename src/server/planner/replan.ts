// One planning run for one user: snapshot from the database, plan(), and
// the push of the differences to the calendars.

import { categoryOf } from "../../scheduler/categories.ts";
import type { WeeklyHours } from "../../scheduler/hours.ts";
import type {
  BufferFilter,
  CurrentPlacement,
  ExternalEvent,
  HabitDependency,
  HabitItem,
  Level,
  OverloadItem,
  ReportEntry,
  Snapshot,
} from "../../scheduler/model.ts";
import { plan } from "../../scheduler/plan.ts";
import {
  defaultEventSettings,
  type EventSettings,
  readEventSettings,
} from "../../shared/event-settings.ts";
import {
  addDays,
  DAY,
  type LocalDate,
  localToUtc,
  schedulingWindowEnd,
  utcToLocal,
  weekdayOf,
} from "../../shared/time.ts";
import { isAnalyticsOnly } from "../analytics/seats.ts";
import { all, type Db, one, run } from "../db.ts";
import { fragmentationPreference } from "../policies/model.ts";
import type { CalendarProvider } from "../providers/types.ts";
import { getSettings, type Settings } from "../settings.ts";
import { planningZone } from "../travel.ts";
import { afterPush } from "./after-push.ts";
import { categoryContext, colorFor, externalPaints } from "./categories.ts";
import { externalEvents } from "./events.ts";
import { recordItemChanges } from "./item-log.ts";
import {
  eventTitle,
  markEnded,
  markFlights,
  PERSONAL_COPY_MARKER,
  placementState,
  TRAVEL_MARKER,
} from "./markers.ts";
import { recordMeetingChanges, recordMissedPeriods } from "./meeting-log.ts";
import { attendeeOccurrences, attendeesOf, meetingItems } from "./meetings.ts";
import { LABELS, mirrorCopies } from "./mirror.ts";
import { doneMinutes, endedUnstarted, nextIndexAfter } from "./progress.ts";
import { type DesiredEvent, type ManagedRow, type PushResult, pushSchedule } from "./push.ts";
import { type Paint, type PaintJob, repaintRequest } from "./repaint.ts";

export interface ReplanContext {
  db: Db;
  /** Provider for an account id. */
  provider: (accountId: string) => CalendarProvider;
  now: number;
  baseUrl: string;
  /** The full mirroring reconcile: copies are checked field by field (mirroring rule 39). */
  fullMirror?: boolean;
  /** Managed keys to repair: written again from the plan, compared field by field. */
  repair?: ReadonlySet<string>;
  /** Filled with the repair keys the push checked in full or wrote. */
  repaired?: Set<string>;
}

export interface ReplanResult {
  push: PushResult;
  report: ReportEntry[];
  /** Colors to write after the run (events-categories-and-colors.md rule 16). */
  paint: PaintJob;
}

interface CalendarInfo {
  id: string;
  account_id: string;
  provider_id: string;
  is_primary: number;
  writable: number;
  check_availability: number;
}

const FOOTER = "Planned by Tempoloom.";

/** Where new events go: the preferred calendar when the user can write to it, else the main one. */
export function writeCalendar(
  db: Db,
  userId: string,
  preferredId?: string | null,
  opts: { anyStatus?: boolean } = {},
): CalendarInfo | undefined {
  const pick = (only: string | null) =>
    one<CalendarInfo>(
      db,
      `SELECT c.id, c.account_id, c.provider_id, c.is_primary, c.writable, c.check_availability
       FROM calendars c JOIN accounts a ON a.id = c.account_id
       WHERE a.user_id = ? AND (? OR a.status = 'ok') AND c.writable = 1 AND (? IS NULL OR c.id = ?)
       ORDER BY a.is_main DESC, c.is_primary DESC, a.created_at, c.name LIMIT 1`,
      userId,
      opts.anyStatus ? 1 : 0,
      only,
      only,
    );
  if (!preferredId) return pick(null);
  const chosen = pick(preferredId);
  if (chosen) return chosen;
  console.warn(
    `calendar ${preferredId} is not writable for user ${userId}; using the main calendar`,
  );
  return pick(null);
}

function weekStartOf(zone: string, now: number, weekStart: 1 | 7): number {
  const today = utcToLocal(zone, now).date;
  const back = (weekdayOf(today) - weekStart + 7) % 7;
  return localToUtc(zone, addDays(today, -back), 0);
}

/** Builds the scheduler snapshot for a user from the database. */
export function loadSnapshot(
  db: Db,
  userId: string,
  zone: string,
  settings: Settings,
  now: number,
  lastPlannedAt: number,
): {
  snapshot: Snapshot;
  rows: ManagedRow[];
  notes: Map<string, string>;
  titles: Map<string, string>;
  /** Event settings of each automation, by `kind:id` (src/shared/event-settings.ts). */
  eventSettings: Map<string, EventSettings>;
  /** Manual start mode: ended chunks and habit events nobody started, to place again. */
  reopen: ManagedRow[];
} {
  const windowEnd = schedulingWindowEnd(zone, now, settings.schedulingWindowWeeks);
  const hoursRows = all<{ id: string; kind: string; weekly: string }>(
    db,
    "SELECT id, kind, weekly FROM hours_sets WHERE user_id = ?",
    userId,
  );
  const hours: Record<string, WeeklyHours> = Object.fromEntries(
    hoursRows.map((h) => [h.id, JSON.parse(h.weekly) as WeeklyHours]),
  );
  const overloadRows = all<{
    id: string;
    title: string;
    hours_set_id: string;
    daily_max_minutes: number | null;
    weekly_max_minutes: number | null;
    heavy_day_minutes: number | null;
    min_block_minutes: number;
    rank: number;
    created_at: number;
    rules_changed_at: number;
  }>(db, "SELECT * FROM meeting_overloads WHERE user_id = ? AND enabled = 1", userId);
  // A weekly meeting limit and a heavy previous workday look back into the past week.
  const lookBack = overloadRows.length > 0 ? 8 * DAY : DAY;
  const events = [
    ...externalEvents(db, userId, now - lookBack, windowEnd),
    ...attendeeOccurrences(db, userId, now, windowEnd),
  ];

  const rows = all<ManagedRow>(db, "SELECT * FROM managed_events WHERE user_id = ?", userId);
  // PRG-3, PRG-5: in manual start mode an ended chunk or habit event that nobody
  // started goes back to the plan (src/server/planner/progress.ts).
  const openItems = new Set([
    ...all<{ id: string }>(
      db,
      "SELECT id FROM tasks WHERE user_id = ? AND status = 'open'",
      userId,
    ).map((t) => `task:${t.id}`),
    ...all<{ id: string }>(
      db,
      "SELECT id FROM habits WHERE user_id = ? AND enabled = 1",
      userId,
    ).map((h) => `habit:${h.id}`),
  ]);
  const reopen = rows.filter(
    (r) => endedUnstarted(r, now, settings) && openItems.has(`${r.kind}:${r.source_id}`),
  );
  const reopened = new Set(reopen.map((r) => r.id));
  const toPlacement = (r: ManagedRow): CurrentPlacement => ({
    key: r.key,
    itemId: r.source_id,
    start: r.start_ms,
    end: r.end_ms,
    locked: r.locked === 1,
  });
  const current = rows.filter((r) => r.end_ms > now).map(toPlacement);
  const weekStart = weekStartOf(zone, now, settings.weekStart);
  // An ended habit occurrence is done for its date, also when the user moved it to an earlier week.
  const past = rows
    .filter(
      (r) =>
        r.end_ms <= now && (r.start_ms >= weekStart || r.kind === "habit") && !reopened.has(r.id),
    )
    .map(toPlacement);

  const exclusions = new Map<string, { start: number; end: number }[]>();
  for (const x of all<{ kind: string; item_id: string; start_ms: number; end_ms: number }>(
    db,
    "SELECT kind, item_id, start_ms, end_ms FROM item_exclusions WHERE user_id = ? AND end_ms > ?",
    userId,
    now,
  )) {
    const k = `${x.kind}:${x.item_id}`;
    exclusions.set(k, [...(exclusions.get(k) ?? []), { start: x.start_ms, end: x.end_ms }]);
  }
  const dismissed = all<{ key: string }>(
    db,
    "SELECT key FROM dismissed_keys WHERE user_id = ?",
    userId,
  ).map((d) => d.key);
  const notes = new Map<string, string>();
  const titles = new Map<string, string>();
  const today = utcToLocal(zone, now).date;
  const rescheduled = new Map<string, Partial<Record<LocalDate, number>>>();
  const snoozed = new Map<string, Partial<Record<LocalDate, number>>>();
  for (const r of all<{ habit_id: string; date: string; minute: number; not_before: number }>(
    db,
    "SELECT habit_id, date, minute, not_before FROM habit_reschedules WHERE user_id = ? AND date >= ?",
    userId,
    today,
  )) {
    const into = r.not_before ? snoozed : rescheduled;
    into.set(r.habit_id, { ...into.get(r.habit_id), [r.date]: r.minute });
  }
  const eventSettings = new Map<string, EventSettings>();
  const hoursKind = new Map(hoursRows.map((h) => [h.id, h.kind]));

  // PRG-1: ended chunks are done work. A new chunk never takes the key of an ended one.
  const consumed = doneMinutes(rows, now, settings);
  const nextIndex = new Map<string, number>();
  for (const r of rows) {
    if (r.kind === "task")
      nextIndex.set(r.source_id, nextIndexAfter(nextIndex.get(r.source_id) ?? 0, r));
  }
  const tasks = all<{
    id: string;
    title: string;
    notes: string;
    level: Level;
    total_minutes: number;
    logged_minutes: number;
    min_chunk_minutes: number;
    max_chunk_minutes: number;
    start_after: number;
    due_at: number | null;
    hours_set_id: string;
    next_up_rank: number | null;
    created_at: number;
    rules_changed_at: number;
  }>(db, "SELECT * FROM tasks WHERE user_id = ? AND status = 'open'", userId).map((t) => {
    notes.set(`task:${t.id}`, t.notes);
    titles.set(`task:${t.id}`, t.title);
    return {
      id: t.id,
      title: t.title,
      level: t.level,
      // TSK-70: in suggestions mode a task places nothing; its locked work blocks stay.
      remainingMinutes:
        settings.taskPlacement === "suggestions"
          ? 0
          : Math.max(0, t.total_minutes - t.logged_minutes - (consumed.get(t.id) ?? 0)),
      minChunkMinutes: t.min_chunk_minutes,
      maxChunkMinutes: t.max_chunk_minutes,
      startAfter: t.start_after,
      dueAt: t.due_at,
      hours: t.hours_set_id,
      nextUpRank: t.next_up_rank,
      createdAt: t.created_at,
      exclusions: exclusions.get(`task:${t.id}`) ?? [],
      changed: t.rules_changed_at > lastPlannedAt,
      nextIndex: nextIndex.get(t.id) ?? 0,
    };
  });

  const habits = all<{
    id: string;
    title: string;
    notes: string;
    level: Level;
    rank: number;
    hours_set_id: string;
    ideal_minute: number;
    min_minutes: number;
    max_minutes: number;
    frequency: string;
    starting: string | null;
    defense: HabitItem["defense"];
    when_unplaceable: HabitItem["whenUnplaceable"];
    reserved_words: string;
    event_settings: string;
    created_at: number;
    rules_changed_at: number;
    dependencies: string;
  }>(db, "SELECT * FROM habits WHERE user_id = ? AND enabled = 1", userId).map((h): HabitItem => {
    notes.set(`habit:${h.id}`, h.notes);
    titles.set(`habit:${h.id}`, h.title);
    const es = readEventSettings(
      h.event_settings,
      defaultEventSettings("habit", { personal: hoursKind.get(h.hours_set_id) === "personal" }),
    );
    eventSettings.set(`habit:${h.id}`, es);
    // A category chosen in the form decides focus counting; older habits count by their hours.
    const chosen = (JSON.parse(h.event_settings) as { category?: string }).category !== undefined;
    const skipPrefix = `habit:${h.id}:`;
    return {
      id: h.id,
      title: h.title,
      level: h.level,
      rank: h.rank,
      createdAt: h.created_at,
      hours: h.hours_set_id,
      idealMinute: h.ideal_minute,
      minMinutes: h.min_minutes,
      maxMinutes: h.max_minutes,
      frequency: JSON.parse(h.frequency) as HabitItem["frequency"],
      starting: h.starting,
      defense: h.defense,
      whenUnplaceable: h.when_unplaceable,
      reservedWords: JSON.parse(h.reserved_words) as string[],
      skips: dismissed
        .filter((k) => k.startsWith(skipPrefix))
        .map((k) => k.slice(skipPrefix.length) as LocalDate),
      exclusions: exclusions.get(`habit:${h.id}`) ?? [],
      changed: h.rules_changed_at > lastPlannedAt,
      ...(rescheduled.has(h.id) ? { rescheduled: rescheduled.get(h.id) ?? {} } : {}),
      ...(snoozed.has(h.id) ? { notBefore: snoozed.get(h.id) ?? {} } : {}),
      ...(h.dependencies !== "[]"
        ? { dependencies: JSON.parse(h.dependencies) as HabitDependency[] }
        : {}),
      ...(chosen ? { work: es.category === "work" } : {}),
    };
  });

  const buffers = all<{
    id: string;
    title: string;
    level: Level;
    rank: number;
    side: "before" | "after" | "both";
    minutes_before: number;
    minutes_after: number;
    busy: number;
    filter: string;
    on_conflict: "remove" | "keep_as_conflict";
    calendar_scope: string | null;
    event_settings: string;
    created_at: number;
    rules_changed_at: number;
  }>(db, "SELECT * FROM buffers WHERE user_id = ? AND enabled = 1", userId).map((b) => {
    titles.set(`buffer:${b.id}`, b.title);
    const filter = JSON.parse(b.filter) as BufferFilter;
    eventSettings.set(
      `buffer:${b.id}`,
      readEventSettings(
        b.event_settings,
        defaultEventSettings("buffer", { travel: Boolean(filter.travel || filter.flight) }),
      ),
    );
    return {
      id: b.id,
      title: b.title,
      level: b.level,
      rank: b.rank,
      createdAt: b.created_at,
      side: b.side,
      minutesBefore: b.minutes_before,
      minutesAfter: b.minutes_after,
      busy: b.busy === 1,
      filter,
      onConflict: b.on_conflict,
      changed: b.rules_changed_at > lastPlannedAt,
      calendarScope: b.calendar_scope,
    };
  });

  const focus = all<{
    id: string;
    title: string;
    hours_set_id: string;
    weekly_goal_minutes: number;
    daily_min_minutes: number;
    daily_max_minutes: number;
    min_block_minutes: number;
    max_block_minutes: number;
    busy: number;
    mode: "proactive" | "reactive";
    rank: number;
    event_settings: string;
    created_at: number;
    rules_changed_at: number;
    notes: string;
  }>(db, "SELECT * FROM focus_goals WHERE user_id = ? AND enabled = 1", userId).map((f) => {
    titles.set(`focus:${f.id}`, f.title);
    const es = readEventSettings(f.event_settings, defaultEventSettings("focus_time"));
    eventSettings.set(`focus:${f.id}`, es);
    notes.set(`focus:${f.id}`, es.description);
    return {
      id: f.id,
      title: f.title,
      rank: f.rank,
      createdAt: f.created_at,
      hours: f.hours_set_id,
      weeklyGoalMinutes: f.weekly_goal_minutes,
      dailyMinMinutes: f.daily_min_minutes,
      dailyMaxMinutes: f.daily_max_minutes,
      minBlockMinutes: f.min_block_minutes,
      maxBlockMinutes: f.max_block_minutes,
      busy: f.busy === 1,
      exclusions: exclusions.get(`focus:${f.id}`) ?? [],
      changed: f.rules_changed_at > lastPlannedAt,
      mode: f.mode,
    };
  });
  const overloads = overloadRows.map((o): OverloadItem => {
    titles.set(`focus:${o.id}`, o.title);
    return {
      id: o.id,
      title: o.title,
      rank: o.rank,
      createdAt: o.created_at,
      hours: o.hours_set_id,
      dailyMaxMinutes: o.daily_max_minutes,
      weeklyMaxMinutes: o.weekly_max_minutes,
      heavyDayMinutes: o.heavy_day_minutes,
      minBlockMinutes: o.min_block_minutes,
      exclusions: exclusions.get(`focus:${o.id}`) ?? [],
      changed: o.rules_changed_at > lastPlannedAt,
    };
  });

  const meetings = meetingItems(db, userId, now, windowEnd, lastPlannedAt, exclusions);
  const fragmentation = fragmentationPreference(db, userId);
  for (const m of meetings.rows) {
    notes.set(`meeting:${m.id}`, m.description);
    titles.set(`meeting:${m.id}`, m.title);
    eventSettings.set(
      `meeting:${m.id}`,
      readEventSettings(m.event_settings, defaultEventSettings("meeting")),
    );
  }

  const snapshot: Snapshot = {
    now,
    zone,
    weekStart: settings.weekStart,
    windowEnd,
    stepMinutes: 15,
    urgencyMode: settings.urgencyMode,
    chunkCooldown: settings.chunkCooldown,
    breakMinutes: settings.breakMinutes,
    hours,
    workHours: hoursRows.filter((h) => h.kind === "work").map((h) => h.id),
    events,
    current,
    past,
    dismissedKeys: dismissed,
    bufferLengths: Object.fromEntries(
      rows.flatMap((r) =>
        r.kind === "buffer" && r.kept_minutes !== null && r.end_ms > now
          ? [[r.key, r.kept_minutes]]
          : [],
      ),
    ),
    tasks,
    habits,
    meetings: meetings.items,
    buffers,
    focus,
    ...(overloads.length > 0 ? { overloads } : {}),
    ...(buffers.length > 0 ? { mirrorCopies: copyAnchors(db, userId, now) } : {}),
    ...(fragmentation ? { fragmentation } : {}),
  };
  return { snapshot, rows, notes, titles, eventSettings, reopen };
}

/**
 * Tempoloom's own mirror copies as their calendars show them (buffers-travel.md
 * rule 13), with the category their title and description give.
 */
export function copyAnchors(db: Db, userId: string, now: number): ExternalEvent[] {
  const userEmail =
    one<{ email: string }>(db, "SELECT email FROM users WHERE id = ?", userId)?.email ?? "";
  return all<{
    id: string;
    calendar_id: string;
    source_calendar_id: string;
    start_ms: number;
    end_ms: number;
    summary: string;
    description: string;
    location: string;
    all_day: number;
    busy: number;
  }>(
    db,
    `SELECT m.id, m.calendar_id, p.source_calendar_id, m.start_ms, m.end_ms, e.summary, e.description,
       e.location, e.all_day, e.busy
     FROM managed_events m JOIN mirror_policies p ON p.id = m.source_id
       JOIN events e ON e.calendar_id = m.calendar_id AND e.event_id = m.event_id
     WHERE m.user_id = ? AND m.kind = 'mirror' AND m.end_ms > ?`,
    userId,
    now,
  ).map((c) => ({
    id: `mirror:${c.id}`,
    start: c.start_ms,
    end: c.end_ms,
    allDay: c.all_day === 1,
    busy: c.busy === 1,
    title: c.summary,
    description: c.description,
    selfResponse: null,
    organizerSelf: true,
    attendeeCount: 0,
    location: c.location,
    eventType: "default",
    bookedViaLink: false,
    calendarId: c.calendar_id,
    mirrorSource: c.source_calendar_id,
    category: categoryOf(
      {
        title: c.summary,
        description: c.description,
        rsvpNote: "",
        start: c.start_ms,
        end: c.end_ms,
        eventType: "default",
        attendees: [],
        managedKind: null,
        personalCalendar: false,
        manual: null,
      },
      userEmail,
    ),
  }));
}

/** Calendar reminders and visibility of a managed event (planning-notifications.md table). */
function reminderFields(
  kind: string,
  es: EventSettings | undefined,
): Pick<DesiredEvent, "reminders" | "visibility"> {
  if (!es) return kind === "task" || kind === "meeting" ? { reminders: { useDefault: true } } : {};
  return {
    reminders:
      es.reminders === "default"
        ? { useDefault: true }
        : { minutes: es.reminders === "none" ? [] : es.reminders },
    visibility: es.visibility === "calendar_default" ? "default" : es.visibility,
  };
}

/** CNT-15: what a calendar edit does to each kind of event (planning-calendar-edits.md). */
export const EVENT_TIPS: Record<string, string> = {
  task: "Tempoloom tip: move this event to lock it at the new time; delete it to place the work again later.",
  habit:
    "Tempoloom tip: move this event to lock it at the new time; delete it and Tempoloom finds another time.",
  focus:
    "Tempoloom tip: move this event to lock it at the new time; delete it to skip this focus time.",
  meeting:
    "Tempoloom tip: to reschedule, decline this event and Tempoloom finds the next common time; the organizer deletes it to skip this time.",
};

/**
 * CNT-10: the notes, a tip when event tips are on (CNT-15), a link that opens
 * the item in the planner, and the footer. Meetings get no link: their events
 * go to guests.
 */
export function eventDescription(
  notes: string,
  baseUrl: string,
  kind: string,
  itemId: string,
  tips = false,
): string {
  const link =
    kind === "task" || kind === "habit" || kind === "focus"
      ? `Open in Tempoloom: ${baseUrl}/?item=${kind}:${itemId}`
      : "";
  const tip = tips ? (EVENT_TIPS[kind] ?? "") : "";
  return [notes, tip, link, FOOTER].filter(Boolean).join("\n\n");
}

/** The organizer, guests and location of a meeting occurrence (rules 35, 41). */
export function meetingGuests(
  m: { location: string; people: { email: string; required: boolean }[] } | undefined,
  organizer: string,
  userEmail: string,
) {
  const people = (m?.people ?? []).filter((a) => a.email !== organizer && a.email !== userEmail);
  return {
    organizer,
    attendees: people.filter((a) => a.required).map((a) => a.email),
    optionalAttendees: people.filter((a) => !a.required).map((a) => a.email),
    ...(m?.location ? { location: m.location } : {}),
  };
}

/** The guests of a habit occurrence: never the user, and written without notices. */
function habitGuestFields(guests: string[], organizer: string, userEmail: string) {
  const self = new Set([organizer, userEmail.toLowerCase()]);
  const attendees = guests.filter((g) => !self.has(g));
  return attendees.length > 0 ? { organizer, attendees, quietGuests: true } : {};
}

export async function replanUser(ctx: ReplanContext, userId: string): Promise<ReplanResult | null> {
  const { db, now } = ctx;
  const user = one<{ time_zone: string; email: string }>(
    db,
    "SELECT time_zone, email FROM users WHERE id = ?",
    userId,
  );
  if (!user) return null;
  const settings = getSettings(db, userId);
  if (settings.paused || isAnalyticsOnly(db, userId)) return null;
  // The main calendar, also while its account is disconnected: items that use
  // it then wait instead of moving to another account (accounts rule 16).
  const target = writeCalendar(db, userId, null, { anyStatus: true });
  if (!target) return null;
  const lastRun = one<{ planned_at: number; report: string }>(
    db,
    "SELECT planned_at, report FROM plan_reports WHERE user_id = ?",
    userId,
  );
  const last = lastRun?.planned_at ?? 0;
  const { snapshot, rows, notes, titles, eventSettings, reopen } = loadSnapshot(
    db,
    userId,
    planningZone(db, userId, user.time_zone),
    settings,
    now,
    last,
  );
  const taskCalendar = new Map(
    all<{ id: string; task_calendar_id: string | null }>(
      db,
      "SELECT id, task_calendar_id FROM hours_sets WHERE user_id = ?",
      userId,
    ).map((h) => [h.id, h.task_calendar_id]),
  );
  const calendars = new Map(
    all<CalendarInfo & { ok: number }>(
      db,
      `SELECT c.id, c.account_id, c.provider_id, c.is_primary, c.writable, c.check_availability,
         a.status = 'ok' AS ok
       FROM calendars c JOIN accounts a ON a.id = c.account_id WHERE a.user_id = ?`,
      userId,
    ).map((c) => [c.id, c]),
  );
  // A calendar chosen for an item, while its account works and it takes events.
  const writable = (id: string | null | undefined) => {
    const cal = id ? calendars.get(id) : undefined;
    return cal?.writable === 1 && cal.ok === 1 ? cal.id : undefined;
  };
  // A chosen calendar of a disconnected account stays chosen: the push writes
  // nothing to it, so the item gets no new events until reconnect (accounts rule 16).
  const chosen = (id: string | null | undefined) => {
    const cal = id ? calendars.get(id) : undefined;
    return cal?.writable === 1 ? cal.id : undefined;
  };
  const chosenCalendar = (es: EventSettings | undefined) => chosen(es?.calendarId);
  // Accounts rule 16: an item whose calendar is on a disconnected account
  // waits. Its new demands leave the plan, so they take no time from other
  // items. The events it has stay as they are on every calendar: the push
  // neither moves nor deletes them, and the busy ones block their time.
  const kept = new Set<string>();
  if ([...calendars.values()].some((c) => c.ok !== 1)) {
    const waits = (id: string | undefined) => calendars.get(id ?? target.id)?.ok !== 1;
    const left = new Set<string>();
    const keep =
      <T extends { id: string }>(kind: string, calendarOf: (i: T) => string | undefined) =>
      (i: T) => {
        if (!waits(calendarOf(i))) return true;
        left.add(`${kind}:${i.id}`);
        return false;
      };
    const settings = (kind: string) => (i: { id: string }) =>
      chosenCalendar(eventSettings.get(`${kind}:${i.id}`));
    snapshot.tasks = snapshot.tasks.filter(
      keep("task", (t: { id: string; hours: string }) => chosen(taskCalendar.get(t.hours))),
    );
    snapshot.habits = snapshot.habits.filter(keep("habit", settings("habit")));
    snapshot.meetings = snapshot.meetings.filter(keep("meeting", settings("meeting")));
    snapshot.buffers = snapshot.buffers.filter(keep("buffer", settings("buffer")));
    snapshot.focus = snapshot.focus.filter(keep("focus", settings("focus")));
    for (const r of rows) {
      if (r.end_ms <= now || !left.has(`${r.kind}:${r.source_id}`)) continue;
      kept.add(r.key);
      if (r.busy !== 1) continue;
      snapshot.events.push({
        id: `kept:${r.key}`,
        start: r.start_ms,
        end: r.end_ms,
        allDay: false,
        busy: true,
        title: r.title,
        description: "",
        selfResponse: null,
        organizerSelf: true,
        attendeeCount: 0,
        location: "",
        eventType: "default",
        bookedViaLink: false,
        calendarId: r.calendar_id,
      });
    }
  }
  const result = plan(snapshot);

  const rowByKey = new Map(rows.map((r) => [r.key, r]));
  const taskHours = new Map(snapshot.tasks.map((t) => [t.id, t.hours]));
  // CNT-20, CNT-24: chunks of a private task are private events.
  const privateTasks = new Set(
    all<{ id: string }>(
      db,
      "SELECT id FROM tasks WHERE user_id = ? AND visibility = 'private'",
      userId,
    ).map((t) => t.id),
  );
  // Guests and location of each flexible meeting (meetings-flexible.md rules 35, 41).
  const meetingRows = new Map(
    all<{ id: string; location: string }>(
      db,
      "SELECT id, location FROM meetings WHERE user_id = ?",
      userId,
    ).map((m) => [m.id, { location: m.location, people: attendeesOf(db, m.id) }]),
  );
  // The organizer of an occurrence is the account that owns its calendar.
  const accountEmail = new Map(
    all<{ id: string; email: string }>(
      db,
      "SELECT id, email FROM accounts WHERE user_id = ?",
      userId,
    ).map((a) => [a.id, a.email.toLowerCase()]),
  );
  const travelBuffers = new Set(
    snapshot.buffers.filter((b) => b.filter.travel || b.filter.flight).map((b) => b.id),
  );
  // Habit guests (habits concepts): attendees, with no availability check and no notices.
  const habitGuests = new Map(
    all<{ id: string; guests: string }>(
      db,
      "SELECT id, guests FROM habits WHERE user_id = ? AND guests <> '[]'",
      userId,
    ).map((h) => [h.id, JSON.parse(h.guests) as string[]]),
  );
  const desired: DesiredEvent[] = result.placements.map((p) => {
    const row = rowByKey.get(p.key);
    const itemKey = `${p.kind}:${p.itemId}`;
    const es = eventSettings.get(itemKey);
    // HRS-7, HRS-12: unlocked task chunks follow the calendar of their hours
    // set, also when it changes; they keep their times. A chunk on a calendar
    // that cannot be written now stays, and other events stay where they are.
    const taskCalendarId =
      p.kind === "task" && !row?.locked && (!row || writable(row.calendar_id))
        ? (chosen(taskCalendar.get(taskHours.get(p.itemId) ?? "")) ?? target.id)
        : undefined;
    const calendarId = taskCalendarId ?? row?.calendar_id ?? chosenCalendar(es) ?? target.id;
    const keepUserTitle = row?.user_edited === 1;
    const itemNotes = notes.get(itemKey) ?? "";
    const travel = p.kind === "buffer" && travelBuffers.has(p.itemId);
    return {
      key: p.key,
      kind: p.kind,
      sourceId: p.itemId,
      calendarId,
      start: p.start,
      end: p.end,
      title:
        keepUserTitle && row
          ? row.title
          : eventTitle(settings.markers, {
              ...(travel ? { typeMarker: TRAVEL_MARKER } : {}),
              state: placementState(p.kind, p),
              ...(es?.emoji ? { emoji: es.emoji } : {}),
              title: titles.get(itemKey) ?? p.kind,
            }),
      // A meeting gets each new form description (rule 23); push writes it only
      // when it changes, so the organizer's calendar edit stays until then.
      description:
        keepUserTitle && row && p.kind !== "meeting"
          ? row.description
          : eventDescription(itemNotes, ctx.baseUrl, p.kind, p.itemId, settings.eventTips),
      busy: p.busy || p.locked,
      colorId: null,
      ...(p.kind === "habit" && es?.location ? { location: es.location } : {}),
      ...reminderFields(p.kind, es),
      ...(p.kind === "habit" && habitGuests.has(p.itemId)
        ? habitGuestFields(
            habitGuests.get(p.itemId) ?? [],
            accountEmail.get(calendars.get(calendarId)?.account_id ?? "") ?? user.email,
            user.email,
          )
        : {}),
      ...(p.kind === "task" && privateTasks.has(p.itemId)
        ? { visibility: "private" as const }
        : {}),
      ...(p.kind === "meeting"
        ? meetingGuests(
            meetingRows.get(p.itemId),
            accountEmail.get(calendars.get(calendarId)?.account_id ?? "") ?? user.email,
            user.email,
          )
        : {}),
    };
  });

  // Calendar mirroring copies are managed events too (sync-calendar-mirroring.md).
  const work = one<{ weekly: string }>(
    db,
    "SELECT weekly FROM hours_sets WHERE user_id = ? AND kind = 'work' ORDER BY created_at LIMIT 1",
    userId,
  );
  desired.push(
    ...mirrorCopies(
      db,
      userId,
      user.time_zone,
      now,
      work ? (JSON.parse(work.weekly) as WeeklyHours) : null,
      settings.noReplyCopies === "busy",
      desired.filter((d) => d.kind === "buffer" && travelBuffers.has(d.sourceId)),
    ),
  );

  const policies = all<{ id: string; calendar_type: string; visibility: string }>(
    db,
    "SELECT id, calendar_type, visibility FROM mirror_policies WHERE user_id = ?",
    userId,
  );
  const mirrorTypes = new Map(policies.map((p) => [p.id, p.calendar_type]));
  // Marker table: a copy that shows the personal commitment label gets the house
  // marker; other labels of a personal policy (PTO, Travel, Flight) do not.
  const personalLabels = new Set(
    policies
      .filter((p) => p.visibility === "label_only" && p.calendar_type === "personal")
      .map((p) => p.id),
  );
  for (const d of desired) {
    if (d.kind === "mirror" && personalLabels.has(d.sourceId) && d.title === LABELS.personal) {
      d.title = `${PERSONAL_COPY_MARKER} ${d.title}`;
    }
  }

  // Each managed event gets the color of its category (events-categories-and-colors.md rule 6).
  const cats = categoryContext(db, userId);
  const taskColors = new Map(
    all<{ id: string; color: string }>(
      db,
      "SELECT id, color FROM tasks WHERE user_id = ? AND color <> 'category'",
      userId,
    ).map((t) => [t.id, t.color]),
  );
  const personalHabits = new Set(
    snapshot.habits
      .filter((h) => eventSettings.get(`habit:${h.id}`)?.category === "personal")
      .map((h) => h.id),
  );
  // A policy's color override paints all its copies (mirroring rule 29).
  const mirrorColors = new Map(
    all<{ id: string; color_override: string }>(
      db,
      "SELECT id, color_override FROM mirror_policies WHERE user_id = ? AND color_override IS NOT NULL",
      userId,
    ).map((p) => [p.id, p.color_override]),
  );
  /** The color of a managed event: its category color, or its item's own color (rule 9). */
  const colorOf = (
    kind: string,
    sourceId: string,
    text: { title: string; description: string; start: number; end: number },
    attendees: string[],
    manualKey: string | null,
  ): string | null => {
    const manual = manualKey ? (cats.manual.get(manualKey) ?? null) : null;
    const type = kind === "mirror" ? mirrorTypes.get(sourceId) : undefined;
    const category =
      type === "travel" && !manual
        ? "travel"
        : categoryOf(
            {
              ...text,
              rsvpNote: "",
              eventType: "default",
              attendees,
              managedKind: kind,
              personalHabit: personalHabits.has(sourceId),
              travelBuffer: travelBuffers.has(sourceId),
              personalCalendar: type === "personal",
              manual,
            },
            cats.userEmail,
          );
    const own =
      kind === "task" ? taskColors.get(sourceId) : eventSettings.get(`${kind}:${sourceId}`)?.color;
    if (own && own !== "category") return own === "calendar_default" ? null : own;
    return (
      (kind === "mirror" ? mirrorColors.get(sourceId) : undefined) ?? colorFor(settings, category)
    );
  };
  for (const d of desired) {
    const row = rowByKey.get(d.key);
    d.colorId = colorOf(
      d.kind,
      d.sourceId,
      d,
      [...(d.attendees ?? []), ...(d.optionalAttendees ?? [])],
      row?.event_id ? `${row.calendar_id}:${row.event_id}` : null,
    );
  }

  // SCH-119: what the push wrote is logged per item, also when a later write fails.
  const written = new Map<string, { start: number; end: number } | null>();
  const reportJson = JSON.stringify(result.report);
  // After a failed push only the writes are logged: the report is saved only
  // after a whole run, so its shortfalls are logged once, by the next whole run.
  const logChanges = (shortfalls: boolean) =>
    recordItemChanges(db, userId, {
      before: rows,
      written,
      prevReport: lastRun?.report ?? null,
      reportJson,
      shortfalls,
      snapshot,
      result,
      now,
    });
  let push: Awaited<ReturnType<typeof pushSchedule>>;
  try {
    push = await pushSchedule(
      {
        db,
        userId,
        now,
        fullCheck: ctx.fullMirror ?? false,
        reopen,
        ...(ctx.repair ? { repair: ctx.repair } : {}),
        ...(ctx.repaired ? { repaired: ctx.repaired } : {}),
        keep: kept,
        written,
        target: (calendarId) => {
          const c = calendars.get(calendarId);
          if (!c) throw new Error(`Unknown calendar ${calendarId}`);
          return { provider: ctx.provider(c.account_id), providerCalendarId: c.provider_id };
        },
      },
      desired,
    );
  } catch (err) {
    try {
      logChanges(false);
    } catch {
      // The push's own error is the one to report.
    }
    throw err;
  }
  logChanges(true);
  recordMeetingChanges(db, userId, rows, now, last);
  recordMissedPeriods(db, userId, result, now);
  // Rule 8: a new color also repaints managed events that ended, up to 90 days back.
  // Rule 12, "repaint all": every managed event gets its color again, also where
  // the user changed the color in the calendar. The run only lists the paints;
  // the sync service writes them after the run (rule 16).
  const requestedAt = repaintRequest(db, userId);
  const paints: Paint[] = [];
  for (const r of all<ManagedRow & { cached_color: string | null; attendees: string | null }>(
    db,
    `SELECT m.*, e.color_id AS cached_color, e.attendees FROM managed_events m
       JOIN calendars c ON c.id = m.calendar_id
       JOIN accounts a ON a.id = c.account_id
       LEFT JOIN events e ON e.calendar_id = m.calendar_id AND e.event_id = m.event_id
     WHERE m.user_id = ? AND a.status = 'ok' AND c.writable = 1
       AND m.event_id IS NOT NULL AND m.end_ms > ? AND m.end_ms <= ?`,
    userId,
    now - 90 * DAY,
    requestedAt === null ? now : Number.MAX_SAFE_INTEGER,
  )) {
    if (!r.event_id || (r.kind === "mirror" && r.end_ms <= now)) continue;
    const color = colorOf(
      r.kind,
      r.source_id,
      { title: r.title, description: r.description, start: r.start_ms, end: r.end_ms },
      // Only a meeting's category depends on its guests.
      r.kind === "meeting" ? (JSON.parse(r.attendees ?? "[]") as string[]) : [],
      `${r.calendar_id}:${r.event_id}`,
    );
    const current = requestedAt === null ? r.color_id : r.cached_color;
    if ((current ?? null) === color) continue;
    paints.push({
      calendarId: r.calendar_id,
      eventId: r.event_id,
      series: false,
      color,
      managedId: r.id,
    });
  }
  paints.push(...externalPaints(db, userId, settings, now, snapshot.windowEnd));
  await markEnded(db, userId, settings.markers, (accountId) => ctx.provider(accountId), now);
  await markFlights(db, userId, (accountId) => ctx.provider(accountId), now, snapshot.windowEnd);
  await afterPush(db, userId, (accountId) => ctx.provider(accountId), now);
  run(
    db,
    `INSERT INTO plan_reports (user_id, report, planned_at, task_order) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET report = excluded.report, planned_at = excluded.planned_at,
       task_order = excluded.task_order`,
    userId,
    reportJson,
    now,
    JSON.stringify(result.taskOrder),
  );
  return { push, report: result.report, paint: { paints, requestedAt } };
}
