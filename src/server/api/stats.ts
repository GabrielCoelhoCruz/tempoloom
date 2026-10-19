// Personal stats (docs/specs/analytics-personal-stats.md): where the time of a
// date range went, by category and day. Read-only (rule 11).
import { Hono } from "hono";
import { z } from "zod";
import { attends, hasTag, TAG_FOCUS } from "../../scheduler/blocking.ts";
import { hoursToTimeSet, type WeeklyHours } from "../../scheduler/hours.ts";
import { TimeSet } from "../../scheduler/timeset.ts";
import { defaultEventSettings, readEventSettings } from "../../shared/event-settings.ts";
import { addDays, localToUtc, utcToLocal } from "../../shared/time.ts";
import type { AppEnv } from "../app.ts";
import { all, type Db, one } from "../db.ts";
import { MANAGED_PROP } from "../planner/push.ts";

export const CATEGORIES = [
  "oneOnOne",
  "groupMeetings",
  "bookedMeetings",
  "soloEvents",
  "tasks",
  "workHabits",
  "personalHabits",
  "focus",
  "buffers",
] as const;
export type Category = (typeof CATEGORIES)[number];

type Minutes = Record<Category, number>;
const empty = (): Minutes => Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Minutes;

export function computeStats(db: Db, userId: string, from: string, to: string) {
  const zone =
    one<{ time_zone: string }>(db, "SELECT time_zone FROM users WHERE id = ?", userId)?.time_zone ??
    "UTC";
  const start = localToUtc(zone, from, 0);
  const end = localToUtc(zone, addDays(to, 1), 0);
  const spans: { cat: Category; start: number; end: number }[] = [];
  let bookings = 0;
  for (const e of all<{
    summary: string;
    description: string;
    start_ms: number;
    end_ms: number;
    all_day: number;
    busy: number;
    event_type: string;
    self_response: "needsAction" | "declined" | "tentative" | "accepted" | null;
    organizer_self: number;
    attendee_count: number;
    private_props: string;
  }>(
    db,
    `SELECT e.* FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN accounts a ON a.id = c.account_id
     WHERE a.user_id = ? AND c.check_availability = 1 AND e.end_ms > ? AND e.start_ms < ?`,
    userId,
    start,
    end,
  )) {
    const props = JSON.parse(e.private_props) as Record<string, string>;
    if (props[MANAGED_PROP] === "1" || e.all_day || !e.busy) continue;
    const ev = {
      title: e.summary,
      description: e.description,
      selfResponse: e.self_response,
      organizerSelf: e.organizer_self === 1,
    } as Parameters<typeof attends>[0];
    if (!attends(ev)) continue;
    let cat: Category;
    if (props.tl_booking === "1") {
      cat = "bookedMeetings";
      bookings++;
    } else if (e.event_type === "focusTime" || hasTag(ev, TAG_FOCUS)) cat = "focus";
    else if (e.attendee_count >= 3) cat = "groupMeetings";
    else if (e.attendee_count === 2) cat = "oneOnOne";
    else cat = "soloEvents";
    spans.push({ cat, start: e.start_ms, end: e.end_ms });
  }
  // A habit's category (work or personal) decides its group; it starts from its hours.
  const habitKind = new Map(
    all<{ id: string; kind: string; event_settings: string }>(
      db,
      `SELECT h.id, s.kind, h.event_settings FROM habits h JOIN hours_sets s ON s.id = h.hours_set_id
       WHERE h.user_id = ?`,
      userId,
    ).map((h) => [
      h.id,
      readEventSettings(
        h.event_settings,
        defaultEventSettings("habit", { personal: h.kind === "personal" }),
      ).category,
    ]),
  );
  // A flexible meeting is a one-to-one or a group meeting by its people (organizer included).
  const meetingPeople = new Map(
    all<{ id: string; n: number }>(
      db,
      `SELECT m.id, count(a.email) + 1 AS n FROM meetings m
         LEFT JOIN meeting_attendees a ON a.meeting_id = m.id WHERE m.user_id = ? GROUP BY m.id`,
      userId,
    ).map((m) => [m.id, m.n]),
  );
  for (const m of all<{ kind: string; source_id: string; start_ms: number; end_ms: number }>(
    db,
    "SELECT kind, source_id, start_ms, end_ms FROM managed_events WHERE user_id = ? AND kind <> 'mirror' AND end_ms > ? AND start_ms < ?",
    userId,
    start,
    end,
  )) {
    const cat: Category =
      m.kind === "meeting"
        ? (meetingPeople.get(m.source_id) ?? 2) >= 3
          ? "groupMeetings"
          : "oneOnOne"
        : m.kind === "task"
          ? "tasks"
          : m.kind === "habit"
            ? habitKind.get(m.source_id) === "personal"
              ? "personalHabits"
              : "workHabits"
            : m.kind === "focus"
              ? "focus"
              : "buffers";
    spans.push({ cat, start: m.start_ms, end: m.end_ms });
  }

  const days: { date: string; minutes: Minutes }[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push({ date: d, minutes: empty() });
  const index = new Map(days.map((d, i) => [d.date, i]));
  for (const s of spans) {
    for (let t = Math.max(s.start, start); t < Math.min(s.end, end); ) {
      const date = utcToLocal(zone, t).date;
      const dayEnd = localToUtc(zone, addDays(date, 1), 0);
      const until = Math.min(s.end, end, dayEnd);
      const day = days[index.get(date) ?? -1];
      if (day) day.minutes[s.cat] += (until - t) / 60_000;
      t = until;
    }
  }
  const totals = empty();
  for (const d of days) for (const c of CATEGORIES) totals[c] += d.minutes[c];

  // Work-life balance: meeting minutes outside work hours.
  const workWeekly = one<{ weekly: string }>(
    db,
    "SELECT weekly FROM hours_sets WHERE user_id = ? AND kind = 'work' ORDER BY created_at LIMIT 1",
    userId,
  );
  const work = hoursToTimeSet(
    JSON.parse(workWeekly?.weekly ?? "{}") as WeeklyHours,
    zone,
    start,
    end,
  );
  const meetings = TimeSet.from(
    spans.filter(
      (s) => s.cat === "oneOnOne" || s.cat === "groupMeetings" || s.cat === "bookedMeetings",
    ),
  ).clip(start, end);
  const outside = meetings.total() - meetings.intersect(work).total();
  return {
    from,
    to,
    days,
    totals,
    highlights: {
      meetingMinutes: totals.oneOnOne + totals.groupMeetings + totals.bookedMeetings,
      focusMinutes: totals.focus,
      bookings,
      meetingMinutesOutsideWorkHours: outside / 60_000,
    },
  };
}

export function statsRoutes(db: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get("/stats", (c) => {
    const q = z.object({ from: z.iso.date(), to: z.iso.date() }).safeParse(c.req.query());
    if (!q.success || q.data.to < q.data.from) return c.json({ error: "invalid_range" }, 400);
    const spanDays = (Date.parse(q.data.to) - Date.parse(q.data.from)) / 86_400_000;
    if (spanDays > 120) return c.json({ error: "range_too_long" }, 400);
    return c.json(computeStats(db, c.get("user").id, q.data.from, q.data.to));
  });
  return r;
}
