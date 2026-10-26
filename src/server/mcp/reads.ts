// The read tools' queries of the MCP server (docs/specs/assistant-mcp-server.md).
import { attends, blockingIntervals, hasTag, TAG_FOCUS } from "../../scheduler/blocking.ts";
import { hoursToTimeSet, type WeeklyHours } from "../../scheduler/hours.ts";
import type { ExternalEvent } from "../../scheduler/model.ts";
import type { TimeSet } from "../../scheduler/timeset.ts";
import { addDays, localToUtc, utcToLocal } from "../../shared/time.ts";
import type { User } from "../accounts.ts";
import { plannerEvents } from "../api/planner.ts";
import { all, type Db, one } from "../db.ts";
import { extId } from "../event-ids.ts";
import { externalEvents } from "../planner/events.ts";
import { zoneOf } from "../preview.ts";
import { ToolError } from "./rpc.ts";

export const DAY = 86_400_000;
const MAX_RANGE_DAYS = 31;

export const toMs = (s: string) => Date.parse(s);
export const isoOf = (t: number) => new Date(t).toISOString();

export function rangeOf(start: string | undefined, end: string | undefined, now: number) {
  const from = start ? toMs(start) : now;
  const to = end ? toMs(end) : from + 7 * DAY;
  if (to <= from) throw new ToolError("end must be after start");
  if (to - from > MAX_RANGE_DAYS * DAY)
    throw new ToolError(`The range is too long: at most ${MAX_RANGE_DAYS} days per call`);
  return { from, to };
}

const VIDEO =
  /https:\/\/[^\s<>"]*(zoom\.us|meet\.google\.com|teams\.microsoft\.com|whereby\.com|meet\.jit\.si)[^\s<>"]*/i;

export interface CachedRow {
  calendar_id: string;
  event_id: string;
  summary: string;
  description: string;
  location: string;
  start_ms: number;
  end_ms: number;
  all_day: number;
  busy: number;
  attendees: string;
  organizer_self: number;
  self_response: ExternalEvent["selfResponse"];
  attendee_count: number;
  writable: number;
  private_props: string;
}

export function cached(db: Db, userId: string, id: string): CachedRow | undefined {
  const ref = extId(id);
  if (!ref) return undefined;
  return one<CachedRow>(
    db,
    `SELECT e.*, c.writable FROM events e JOIN calendars c ON c.id = e.calendar_id
     JOIN accounts a ON a.id = c.account_id WHERE a.user_id = ? AND e.calendar_id = ? AND e.event_id = ?`,
    userId,
    ref.calendarId,
    ref.eventId,
  );
}

export const others = (attendees: string, self: string) =>
  (JSON.parse(attendees) as string[]).filter((a) => a !== self);

/** The read queries of one server, on its database and clock. */
export function readers(db: Db, now: () => number) {
  function listEvents(user: User, from: number, to: number) {
    const details = new Map(
      all<CachedRow>(
        db,
        `SELECT e.*, c.writable FROM events e JOIN calendars c ON c.id = e.calendar_id
         JOIN accounts a ON a.id = c.account_id WHERE a.user_id = ? AND e.end_ms > ? AND e.start_ms < ?`,
        user.id,
        from,
        to,
      ).map((e) => [`ext:${e.calendar_id}:${e.event_id}`, e]),
    );
    return plannerEvents(db, user.id, from, to).map((e) => {
      const d = details.get(e.id);
      const text = `${d?.location ?? ""} ${d?.description ?? ""}`;
      return {
        id: e.id,
        title: e.title,
        start: isoOf(e.start),
        end: isoOf(e.end),
        managed: e.kind !== "external",
        kind: e.kind,
        busy: e.busy,
        attendees: d ? others(d.attendees, user.email) : [],
        location: d?.location ?? "",
        organizer_self: d ? d.organizer_self === 1 : true,
        video_link: VIDEO.exec(text)?.[0] ?? null,
      };
    });
  }

  function hoursOf(userId: string, from: number, to: number): TimeSet {
    const zone = zoneOf(db, userId);
    const row =
      one<{ weekly: string }>(
        db,
        "SELECT weekly FROM hours_sets WHERE user_id = ? AND kind = 'meeting' ORDER BY created_at LIMIT 1",
        userId,
      ) ??
      one<{ weekly: string }>(
        db,
        "SELECT weekly FROM hours_sets WHERE user_id = ? AND kind = 'work' ORDER BY created_at LIMIT 1",
        userId,
      );
    return hoursToTimeSet(JSON.parse(row?.weekly ?? "{}") as WeeklyHours, zone, from, to);
  }

  function findFree(
    user: User,
    a: {
      duration_minutes: number;
      start?: string | undefined;
      end?: string | undefined;
      attendees?: string[] | undefined;
    },
  ) {
    const t = now();
    const range = rangeOf(a.start, a.end, t);
    const from = Math.max(range.from, Math.ceil(t / (15 * 60_000)) * 15 * 60_000);
    const to = range.to;
    if (to <= from) return { slots: [], unknown_attendees: [] };
    const people = [user.id];
    const unknown: string[] = [];
    for (const email of a.attendees ?? []) {
      const u = one<{ id: string }>(
        db,
        "SELECT id FROM users WHERE email = ? AND deactivated_at IS NULL",
        email.toLowerCase(),
      );
      if (u) people.push(u.id);
      else unknown.push(email);
    }
    let free = hoursOf(user.id, from, to);
    for (const id of people) {
      if (id !== user.id) free = free.intersect(hoursOf(id, from, to));
      for (const b of blockingIntervals(externalEvents(db, id, from, to))) free.subtract(b);
    }
    const length = a.duration_minutes * 60_000;
    const step = 30 * 60_000;
    const slots: { start: string; end: string }[] = [];
    for (const i of free.intervals()) {
      for (let s = i.start; s + length <= i.end && slots.length < 20; s += step)
        slots.push({ start: isoOf(s), end: isoOf(s + length) });
    }
    return { slots, unknown_attendees: unknown };
  }

  function weekSummary(user: User, weekStart: string) {
    const zone = zoneOf(db, user.id);
    const from = localToUtc(zone, weekStart, 0);
    const to = localToUtc(zone, addDays(weekStart, 7), 0);
    const keys = ["meeting", "focus", "task", "habit", "other"] as const;
    type Key = (typeof keys)[number];
    const days = Array.from({ length: 7 }, (_, i) => ({
      date: addDays(weekStart, i),
      minutes: Object.fromEntries(keys.map((k) => [k, 0])) as Record<Key, number>,
      meetings: 0,
    }));
    const add = (key: Key, start: number, end: number) => {
      for (let s = Math.max(start, from); s < Math.min(end, to); ) {
        const date = utcToLocal(zone, s).date;
        const until = Math.min(end, to, localToUtc(zone, addDays(date, 1), 0));
        const day = days.find((d) => d.date === date);
        if (day) day.minutes[key] += (until - s) / 60_000;
        s = until;
      }
    };
    for (const e of externalEvents(db, user.id, from, to)) {
      if (e.allDay || !e.busy || !attends(e) || e.id.startsWith("booking:")) continue;
      const key: Key =
        e.attendeeCount >= 2 || e.bookedViaLink
          ? "meeting"
          : e.eventType === "focusTime" || hasTag(e, TAG_FOCUS)
            ? "focus"
            : "other";
      add(key, e.start, e.end);
      if (key === "meeting") {
        const day = days.find((d) => d.date === utcToLocal(zone, e.start).date);
        if (day) day.meetings++;
      }
    }
    for (const m of all<{ kind: string; start_ms: number; end_ms: number }>(
      db,
      "SELECT kind, start_ms, end_ms FROM managed_events WHERE user_id = ? AND kind <> 'mirror' AND end_ms > ? AND start_ms < ?",
      user.id,
      from,
      to,
    )) {
      const key: Key | null =
        m.kind === "task"
          ? "task"
          : m.kind === "habit"
            ? "habit"
            : m.kind === "focus"
              ? "focus"
              : m.kind === "meeting"
                ? "meeting"
                : null;
      if (key) add(key, m.start_ms, m.end_ms);
    }
    const hours = (m: number) => Math.round((m / 60) * 100) / 100;
    const out = days.map((d) => ({
      date: d.date,
      meeting_hours: hours(d.minutes.meeting),
      meetings: d.meetings,
      focus_hours: hours(d.minutes.focus),
      task_hours: hours(d.minutes.task),
      habit_hours: hours(d.minutes.habit),
      other_hours: hours(d.minutes.other),
    }));
    const sum = (k: Key) => hours(days.reduce((a, d) => a + d.minutes[k], 0));
    return {
      week_start: weekStart,
      time_zone: zone,
      days: out,
      totals: {
        meeting_hours: sum("meeting"),
        focus_hours: sum("focus"),
        task_hours: sum("task"),
        habit_hours: sum("habit"),
        other_hours: sum("other"),
      },
    };
  }

  function meetingContext(user: User, id: string) {
    const ev = cached(db, user.id, id);
    if (!ev) throw new ToolError(`No event ${id} on your calendars`);
    const guests = others(ev.attendees, user.email);
    const past =
      guests.length === 0
        ? []
        : all<CachedRow>(
            db,
            `SELECT e.*, c.writable FROM events e JOIN calendars c ON c.id = e.calendar_id
             JOIN accounts a ON a.id = c.account_id
             WHERE a.user_id = ? AND e.end_ms <= ? AND e.start_ms >= ? AND e.all_day = 0
             ORDER BY e.start_ms DESC`,
            user.id,
            Math.min(now(), ev.start_ms),
            now() - 84 * DAY,
          )
            .filter((p) => others(p.attendees, user.email).some((g) => guests.includes(g)))
            .slice(0, 10)
            .map((p) => ({
              id: `ext:${p.calendar_id}:${p.event_id}`,
              title: p.summary,
              start: isoOf(p.start_ms),
              end: isoOf(p.end_ms),
              attendees: others(p.attendees, user.email),
            }));
    const words = new Set(
      ev.summary
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 4),
    );
    const related = all<{
      id: string;
      title: string;
      notes: string;
      level: number;
      due_at: number | null;
    }>(
      db,
      "SELECT id, title, notes, level, due_at FROM tasks WHERE user_id = ? AND status = 'open'",
      user.id,
    )
      .filter(
        (t) =>
          t.title
            .toLowerCase()
            .split(/[^\p{L}\p{N}]+/u)
            .some((w) => words.has(w)) || guests.some((g) => t.notes.toLowerCase().includes(g)),
      )
      .map((t) => ({
        id: t.id,
        title: t.title,
        priority: t.level,
        due: t.due_at === null ? null : isoOf(t.due_at),
      }));
    const text = `${ev.location} ${ev.description}`;
    return {
      event: {
        id,
        title: ev.summary,
        start: isoOf(ev.start_ms),
        end: isoOf(ev.end_ms),
        attendees: guests,
        organizer_self: ev.organizer_self === 1,
        location: ev.location,
        description: ev.description,
        video_link: VIDEO.exec(text)?.[0] ?? null,
      },
      past_meetings: past,
      related_tasks: related,
    };
  }

  return { listEvents, findFree, weekSummary, meetingContext };
}
