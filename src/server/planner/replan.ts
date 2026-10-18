// One planning run for one user: snapshot from the database, plan(), and
// the push of the differences to the calendars.

import { categoryOf } from "../../scheduler/categories.ts";
import type { WeeklyHours } from "../../scheduler/hours.ts";
import type {
  BufferFilter,
  CurrentPlacement,
  HabitItem,
  Level,
  Placement,
  ReportEntry,
  Snapshot,
} from "../../scheduler/model.ts";
import { plan } from "../../scheduler/plan.ts";
import {
  addDays,
  DAY,
  type LocalDate,
  localToUtc,
  utcToLocal,
  weekdayOf,
} from "../../shared/time.ts";
import { all, type Db, one, run } from "../db.ts";
import { fragmentationPreference } from "../policies/model.ts";
import type { CalendarProvider } from "../providers/types.ts";
import { getSettings, type Settings } from "../settings.ts";
import { categoryContext, colorFor, paintExternal } from "./categories.ts";
import { externalEvents } from "./events.ts";
import { attendeeOccurrences, attendeesOf, meetingItems } from "./meetings.ts";
import { mirrorCopies } from "./mirror.ts";
import { type DesiredEvent, type ManagedRow, type PushResult, pushSchedule } from "./push.ts";

export interface ReplanContext {
  db: Db;
  /** Provider for an account id. */
  provider: (accountId: string) => CalendarProvider;
  now: number;
  baseUrl: string;
}

export interface ReplanResult {
  push: PushResult;
  report: ReportEntry[];
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
     ORDER BY c.is_primary DESC, a.created_at, c.name LIMIT 1`,
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
  const events = [
    ...externalEvents(db, userId, now - DAY, windowEnd),
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
  const past = rows.filter((r) => r.end_ms <= now && r.start_ms >= weekStart).map(toPlacement);

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
      remainingMinutes: Math.max(0, t.total_minutes - t.logged_minutes - (consumed.get(t.id) ?? 0)),
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
    created_at: number;
    rules_changed_at: number;
  }>(db, "SELECT * FROM habits WHERE user_id = ? AND enabled = 1", userId).map((h): HabitItem => {
    notes.set(`habit:${h.id}`, h.notes);
    titles.set(`habit:${h.id}`, h.title);
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
    created_at: number;
    rules_changed_at: number;
  }>(db, "SELECT * FROM buffers WHERE user_id = ? AND enabled = 1", userId).map((b) => {
    titles.set(`buffer:${b.id}`, b.title);
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
      filter: JSON.parse(b.filter) as BufferFilter,
      onConflict: b.on_conflict,
      changed: b.rules_changed_at > lastPlannedAt,
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
    created_at: number;
    rules_changed_at: number;
  }>(db, "SELECT * FROM focus_goals WHERE user_id = ? AND enabled = 1", userId).map((f) => {
    titles.set(`focus:${f.id}`, f.title);
    return {
      id: f.id,
      title: f.title,
      rank: 0,
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
    ...(fragmentation ? { fragmentation } : {}),
  };
  return { snapshot, rows, notes, titles };
}

export function titleFor(settings: Settings, base: string, p: Placement): string {
  const m = settings.markers;
  const marker = p.conflict ? m.conflict : p.locked ? m.locked : p.busy ? m.busy : m.free;
  return marker ? `${marker} ${base}` : base;
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
  if (settings.paused) return null;
  const target = writeCalendar(db, userId);
  if (!target) return null;
  const last =
    one<{ planned_at: number }>(db, "SELECT planned_at FROM plan_reports WHERE user_id = ?", userId)
      ?.planned_at ?? 0;
  const { snapshot, rows, notes, titles } = loadSnapshot(
    db,
    userId,
    user.time_zone,
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
  const desired: DesiredEvent[] = result.placements.map((p) => {
    const row = rowByKey.get(p.key);
    const itemKey = `${p.kind}:${p.itemId}`;
    const calendarId =
      row?.calendar_id ??
      (p.kind === "task" ? taskCalendar.get(taskHours.get(p.itemId) ?? "") : undefined) ??
      target.id;
    const keepUserTitle = row?.user_edited === 1;
    const itemNotes = notes.get(itemKey) ?? "";
    return {
      key: p.key,
      kind: p.kind,
      sourceId: p.itemId,
      calendarId,
      start: p.start,
      end: p.end,
      title:
        keepUserTitle && row ? row.title : titleFor(settings, titles.get(itemKey) ?? p.kind, p),
      description:
        keepUserTitle && row ? row.description : itemNotes ? `${itemNotes}\n\n${FOOTER}` : FOOTER,
      busy: p.busy || p.locked,
      colorId: null,
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
    ),
  );

  // Each managed event gets the color of its category (events-categories-and-colors.md rule 6).
  const cats = categoryContext(db, userId);
  const personalHabits = new Set(
    all<{ id: string }>(
      db,
      `SELECT h.id FROM habits h JOIN hours_sets s ON s.id = h.hours_set_id
       WHERE h.user_id = ? AND s.kind = 'personal'`,
      userId,
    ).map((h) => h.id),
  );
  const travelBuffers = new Set(
    snapshot.buffers.filter((b) => b.filter.travel || b.filter.flight).map((b) => b.id),
  );
  const mirrorTypes = new Map(
    all<{ id: string; calendar_type: string }>(
      db,
      "SELECT id, calendar_type FROM mirror_policies WHERE user_id = ?",
      userId,
    ).map((p) => [p.id, p.calendar_type]),
  );
  for (const d of desired) {
    const row = rowByKey.get(d.key);
    const manual = row?.event_id
      ? (cats.manual.get(`${row.calendar_id}:${row.event_id}`) ?? null)
      : null;
    const type = d.kind === "mirror" ? mirrorTypes.get(d.sourceId) : undefined;
    const category =
      type === "travel" && !manual
        ? "travel"
        : categoryOf(
            {
              title: d.title,
              description: d.description,
              start: d.start,
              end: d.end,
              eventType: "default",
              attendees: [...(d.attendees ?? []), ...(d.optionalAttendees ?? [])],
              managedKind: d.kind,
              personalHabit: personalHabits.has(d.sourceId),
              travelBuffer: travelBuffers.has(d.sourceId),
              personalCalendar: type === "personal",
              manual,
            },
            cats.userEmail,
          );
    d.colorId = colorFor(settings, category);
  }

  const calendars = new Map(
    all<CalendarInfo>(
      db,
      `SELECT c.id, c.account_id, c.provider_id, c.is_primary, c.writable, c.check_availability
       FROM calendars c JOIN accounts a ON a.id = c.account_id WHERE a.user_id = ?`,
      userId,
    ).map((c) => [c.id, c]),
  );
  const push = await pushSchedule(
    {
      db,
      userId,
      now,
      target: (calendarId) => {
        const c = calendars.get(calendarId);
        if (!c) throw new Error(`Unknown calendar ${calendarId}`);
        return { provider: ctx.provider(c.account_id), providerCalendarId: c.provider_id };
      },
    },
    desired,
  );
  await paintExternal(
    db,
    userId,
    settings,
    (accountId) => ctx.provider(accountId),
    now,
    snapshot.windowEnd,
  );
  run(
    db,
    `INSERT INTO plan_reports (user_id, report, planned_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET report = excluded.report, planned_at = excluded.planned_at`,
    userId,
    JSON.stringify(result.report),
    now,
  );
  return { push, report: result.report };
}
