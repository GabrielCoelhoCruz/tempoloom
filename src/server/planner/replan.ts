// One planning run for one user: snapshot from the database, plan(), and
// the push of the differences to the calendars.

import { categoryOf } from "../../scheduler/categories.ts";
import type { WeeklyHours } from "../../scheduler/hours.ts";
import type {
  BufferFilter,
  CurrentPlacement,
  ExternalEvent,
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
import {
  eventTitle,
  markEnded,
  markFlights,
  PERSONAL_COPY_MARKER,
  placementState,
  TRAVEL_MARKER,
} from "./markers.ts";
import { recordMeetingChanges } from "./meeting-log.ts";
import { attendeeOccurrences, attendeesOf, meetingItems } from "./meetings.ts";
import { LABELS, mirrorCopies } from "./mirror.ts";
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

export function writeCalendar(db: Db, userId: string): CalendarInfo | undefined {
  return one<CalendarInfo>(
    db,
    `SELECT c.id, c.account_id, c.provider_id, c.is_primary, c.writable, c.check_availability
     FROM calendars c JOIN accounts a ON a.id = c.account_id
     WHERE a.user_id = ? AND a.status = 'ok' AND c.writable = 1
     ORDER BY a.is_main DESC, c.is_primary DESC, a.created_at, c.name LIMIT 1`,
    userId,
  );
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
} {
  const windowEnd = localToUtc(
    zone,
    addDays(utcToLocal(zone, now).date, settings.schedulingWindowWeeks * 7 + 1),
    0,
  );
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
    .filter((r) => r.end_ms <= now && (r.start_ms >= weekStart || r.kind === "habit"))
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
  for (const r of all<{ habit_id: string; date: string; minute: number }>(
    db,
    "SELECT habit_id, date, minute FROM habit_reschedules WHERE user_id = ? AND date >= ?",
    userId,
    today,
  )) {
    rescheduled.set(r.habit_id, { ...rescheduled.get(r.habit_id), [r.date]: r.minute });
  }
  const eventSettings = new Map<string, EventSettings>();
  const hoursKind = new Map(hoursRows.map((h) => [h.id, h.kind]));

  const consumed = new Map<string, number>();
  for (const r of rows) {
    if (r.kind === "task" && r.end_ms <= now) {
      consumed.set(
        r.source_id,
        (consumed.get(r.source_id) ?? 0) + (r.end_ms - r.start_ms) / 60_000,
      );
    }
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
    tasks,
    habits,
    meetings: meetings.items,
    buffers,
    focus,
    ...(overloads.length > 0 ? { overloads } : {}),
    ...(buffers.length > 0 ? { mirrorCopies: copyAnchors(db, userId, now) } : {}),
    ...(fragmentation ? { fragmentation } : {}),
  };
  return { snapshot, rows, notes, titles, eventSettings };
}

/** Tempoloom's own mirror copies as their calendars show them (buffers-travel.md rule 13). */
export function copyAnchors(db: Db, userId: string, now: number): ExternalEvent[] {
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

/**
 * CNT-10: the notes, a link that opens the item in the planner, and the
 * footer. Meetings get no link: their events go to guests.
 */
export function eventDescription(
  notes: string,
  baseUrl: string,
  kind: string,
  itemId: string,
): string {
  const link =
    kind === "task" || kind === "habit" || kind === "focus"
      ? `Open in Tempoloom: ${baseUrl}/?item=${kind}:${itemId}`
      : "";
  return [notes, link, FOOTER].filter(Boolean).join("\n\n");
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
  const target = writeCalendar(db, userId);
  if (!target) return null;
  const last =
    one<{ planned_at: number }>(db, "SELECT planned_at FROM plan_reports WHERE user_id = ?", userId)
      ?.planned_at ?? 0;
  const { snapshot, rows, notes, titles, eventSettings } = loadSnapshot(
    db,
    userId,
    planningZone(db, userId, user.time_zone),
    settings,
    now,
    last,
  );
  const result = plan(snapshot);

  const rowByKey = new Map(rows.map((r) => [r.key, r]));
  const taskCalendar = new Map(
    all<{ id: string; task_calendar_id: string | null }>(
      db,
      "SELECT id, task_calendar_id FROM hours_sets WHERE user_id = ?",
      userId,
    ).map((h) => [h.id, h.task_calendar_id]),
  );
  const taskHours = new Map(snapshot.tasks.map((t) => [t.id, t.hours]));
  // Guests and location of each flexible meeting (meetings-flexible.md rules 35, 41).
  const guests = new Map(
    all<{ id: string; location: string }>(
      db,
      "SELECT id, location FROM meetings WHERE user_id = ?",
      userId,
    ).map((m) => {
      const people = attendeesOf(db, m.id).filter((a) => a.email !== user.email);
      return [
        m.id,
        {
          organizer: user.email,
          attendees: people.filter((a) => a.required).map((a) => a.email),
          optionalAttendees: people.filter((a) => !a.required).map((a) => a.email),
          ...(m.location ? { location: m.location } : {}),
        },
      ];
    }),
  );
  const calendars = new Map(
    all<CalendarInfo>(
      db,
      `SELECT c.id, c.account_id, c.provider_id, c.is_primary, c.writable, c.check_availability
       FROM calendars c JOIN accounts a ON a.id = c.account_id WHERE a.user_id = ?`,
      userId,
    ).map((c) => [c.id, c]),
  );
  // The calendar chosen in an automation's event settings, while it can take events.
  const chosenCalendar = (es: EventSettings | undefined) =>
    es?.calendarId && calendars.get(es.calendarId)?.writable === 1 ? es.calendarId : undefined;
  const travelBuffers = new Set(
    snapshot.buffers.filter((b) => b.filter.travel || b.filter.flight).map((b) => b.id),
  );
  const desired: DesiredEvent[] = result.placements.map((p) => {
    const row = rowByKey.get(p.key);
    const itemKey = `${p.kind}:${p.itemId}`;
    const es = eventSettings.get(itemKey);
    const calendarId =
      row?.calendar_id ??
      (p.kind === "task" ? taskCalendar.get(taskHours.get(p.itemId) ?? "") : undefined) ??
      chosenCalendar(es) ??
      target.id;
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
      description:
        keepUserTitle && row
          ? row.description
          : eventDescription(itemNotes, ctx.baseUrl, p.kind, p.itemId),
      busy: p.busy || p.locked,
      colorId: null,
      ...(p.kind === "habit" && es?.location ? { location: es.location } : {}),
      ...reminderFields(p.kind, es),
      ...(p.kind === "meeting" ? guests.get(p.itemId) : {}),
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

  const push = await pushSchedule(
    {
      db,
      userId,
      now,
      fullCheck: ctx.fullMirror ?? false,
      target: (calendarId) => {
        const c = calendars.get(calendarId);
        if (!c) throw new Error(`Unknown calendar ${calendarId}`);
        return { provider: ctx.provider(c.account_id), providerCalendarId: c.provider_id };
      },
    },
    desired,
  );
  recordMeetingChanges(db, userId, rows, now, last);
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
    `INSERT INTO plan_reports (user_id, report, planned_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET report = excluded.report, planned_at = excluded.planned_at`,
    userId,
    JSON.stringify(result.report),
    now,
  );
  return { push, report: result.report, paint: { paints, requestedAt } };
}
