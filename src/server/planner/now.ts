// What the planner shows about "now": task suggestions and the next-up task
// (planning-next-up.md NXT-20, NXT-30 to NXT-33), the current or next meeting
// with its join link (planning-planner.md PLN-7), event starts for in-app
// alerts (planning-notifications.md NTF-1), and overlapping external events
// with a suggested fix (events-external-priority.md rule 8). Read-only.
import { attends } from "../../scheduler/blocking.ts";
import { hoursToTimeSet, type WeeklyHours } from "../../scheduler/hours.ts";
import type { ExternalEvent, ReportEntry } from "../../scheduler/model.ts";
import { addDays, DAY, HOUR, localToUtc, MINUTE, utcToLocal } from "../../shared/time.ts";
import { all, type Db, one } from "../db.ts";
import { getSettings } from "../settings.ts";
import { planningZone } from "../travel.ts";
import { externalEvents } from "./events.ts";

export interface OpenTask {
  id: string;
  title: string;
  level: number;
  due_at: number | null;
  start_after: number;
  next_up_rank: number | null;
  created_at: number;
  remaining: number;
}

/** Open tasks with the work they still need (planning-tasks.md derived values). */
export function openTasks(db: Db, userId: string, now: number): OpenTask[] {
  const used = new Map(
    all<{ source_id: string; m: number }>(
      db,
      `SELECT source_id, SUM(end_ms - start_ms) / 60000.0 AS m FROM managed_events
       WHERE user_id = ? AND kind = 'task' AND end_ms <= ? GROUP BY source_id`,
      userId,
      now,
    ).map((r) => [r.source_id, r.m]),
  );
  return all<OpenTask & { total_minutes: number; logged_minutes: number }>(
    db,
    "SELECT * FROM tasks WHERE user_id = ? AND status = 'open'",
    userId,
  ).map((t) => ({
    id: t.id,
    title: t.title,
    level: t.level,
    due_at: t.due_at,
    start_after: t.start_after,
    next_up_rank: t.next_up_rank,
    created_at: t.created_at,
    remaining: Math.max(0, t.total_minutes - t.logged_minutes - (used.get(t.id) ?? 0)),
  }));
}

/** The scheduler's task order without urgency lifts: queue rank, level, due date, work, age. */
export function schedulerOrder(a: OpenTask, b: OpenTask): number {
  const rank = (t: OpenTask) => t.next_up_rank ?? Number.POSITIVE_INFINITY;
  return (
    rank(a) - rank(b) ||
    a.level - b.level ||
    (a.due_at ?? Number.POSITIVE_INFINITY) - (b.due_at ?? Number.POSITIVE_INFINITY) ||
    b.remaining - a.remaining ||
    a.created_at - b.created_at ||
    a.id.localeCompare(b.id)
  );
}

const lite = (t: OpenTask) => ({
  id: t.id,
  title: t.title,
  level: t.level,
  dueAt: t.due_at,
  remainingMinutes: t.remaining,
});
export type TaskLite = ReturnType<typeof lite>;

/** NXT-32: tasks that may start now and need work, in scheduler order, first 5. */
export function suggestedAt(tasks: OpenTask[], at: number): TaskLite[] {
  return tasks
    .filter((t) => t.start_after <= at && t.remaining > 0)
    .sort(schedulerOrder)
    .slice(0, 5)
    .map(lite);
}

export interface TasksPanel {
  placement: "chunks" | "suggestions";
  suggestedNow: TaskLite[];
  atRisk: (TaskLite & { why: string })[];
  nextUp: TaskLite | null;
}

export function tasksPanel(db: Db, userId: string, now: number): TasksPanel {
  const placement = getSettings(db, userId).taskPlacement;
  const tasks = openTasks(db, userId, now);
  const suggestedNow = suggestedAt(tasks, now);
  const report = JSON.parse(
    one<{ report: string }>(db, "SELECT report FROM plan_reports WHERE user_id = ?", userId)
      ?.report ?? "[]",
  ) as ReportEntry[];
  const short = new Set(report.filter((r) => r.itemKind === "task").map((r) => r.itemId));
  // NXT-33: past due; short of time before the due date (chunks); due within 48 hours (suggestions).
  const why = (t: OpenTask): string | null => {
    if (t.due_at === null || t.remaining <= 0) return null;
    if (t.due_at < now) return "past due";
    if (placement === "chunks" && short.has(t.id)) return "not all placed before the due date";
    if (placement === "suggestions" && t.due_at - now <= 48 * HOUR) return "due within 48 hours";
    return null;
  };
  const atRisk = tasks
    .filter((t) => why(t) !== null)
    .sort(schedulerOrder)
    .map((t) => ({ ...lite(t), why: why(t) as string }));
  return { placement, suggestedNow, atRisk, nextUp: nextUpTask(db, userId, now, tasks, placement) };
}

/** NXT-20: the chunk in progress, else the earliest chunk today, else scheduler order. */
function nextUpTask(
  db: Db,
  userId: string,
  now: number,
  tasks: OpenTask[],
  placement: "chunks" | "suggestions",
): TaskLite | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  if (placement === "chunks") {
    const zone = planningZone(db, userId);
    const dayEnd = localToUtc(zone, addDays(utcToLocal(zone, now).date, 1), 0);
    const chunks = all<{ source_id: string; start_ms: number }>(
      db,
      `SELECT source_id, start_ms FROM managed_events
       WHERE user_id = ? AND kind = 'task' AND end_ms > ? AND start_ms < ? ORDER BY start_ms, id`,
      userId,
      now,
      dayEnd,
    ).filter((c) => byId.has(c.source_id));
    const pick = chunks.find((c) => c.start_ms <= now) ?? chunks[0];
    if (pick) return lite(byId.get(pick.source_id) as OpenTask);
    const first = [...tasks].filter((t) => t.remaining > 0).sort(schedulerOrder)[0];
    return first ? lite(first) : null;
  }
  return suggestedAt(tasks, now)[0] ?? null;
}

/** Suggestions inside a focus time block: tasks that may start by then (platform rule 9). */
export function focusSuggestions(db: Db, userId: string, eventId: string, now: number) {
  const block = one<{ start_ms: number; end_ms: number }>(
    db,
    "SELECT start_ms, end_ms FROM managed_events WHERE id = ? AND user_id = ? AND kind = 'focus'",
    eventId,
    userId,
  );
  if (!block) return null;
  return suggestedAt(openTasks(db, userId, now), Math.max(now, block.start_ms));
}

const URL_RE = /https?:\/\/[^\s<>"'()[\]]+/;
/** The conference link of an event: a link in its location, else the first one in its description. */
export function joinLink(location: string, description: string): string | null {
  return URL_RE.exec(location)?.[0] ?? URL_RE.exec(description)?.[0] ?? null;
}

const STEP = 15 * MINUTE;
const timed = (e: ExternalEvent) => !e.allDay && attends(e) && e.eventType !== "workingLocation";

/** PLN-7: the meeting in progress, else the next one within 7 days. */
export function nextMeeting(db: Db, userId: string, now: number) {
  const events = externalEvents(db, userId, now - DAY, now + 7 * DAY)
    .filter((e) => timed(e) && e.end > now)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const e = events.find((x) => x.start <= now) ?? events[0];
  if (!e) return null;
  return {
    title: e.title || "(busy)",
    start: e.start,
    end: e.end,
    current: e.start <= now,
    joinUrl: joinLink(e.location, e.description),
  };
}

/** NTF-1: starts of events in the next hours, external and managed, for the open page. */
export function upcomingStarts(db: Db, userId: string, now: number, hours = 6) {
  const to = now + hours * HOUR;
  const markers = Object.values(getSettings(db, userId).markers).filter(Boolean);
  const plain = (t: string) => {
    for (const m of markers) if (t.startsWith(`${m} `)) return t.slice(m.length + 1);
    return t;
  };
  const external = externalEvents(db, userId, now, to)
    .filter((e) => timed(e) && e.start >= now)
    .map((e) => ({ title: e.title || "(busy)", start: e.start }));
  const managed = all<{ title: string; start_ms: number }>(
    db,
    `SELECT title, start_ms FROM managed_events
     WHERE user_id = ? AND kind <> 'mirror' AND start_ms >= ? AND start_ms < ?`,
    userId,
    now,
    to,
  ).map((m) => ({ title: plain(m.title), start: m.start_ms }));
  return [...external, ...managed].sort((a, b) => a.start - b.start);
}

export interface Conflict {
  ids: [string, string];
  titles: [string, string];
  overlap: { start: number; end: number };
  /** Rule 8: a suggested time for the later event; Tempoloom never moves it. */
  fix: { title: string; start: number; end: number } | null;
}

/** Rule 8: accepted external events that overlap each other in [from, to). */
export function conflicts(db: Db, userId: string, from: number, to: number): Conflict[] {
  const events = externalEvents(db, userId, from, to)
    .filter((e) => timed(e) && e.busy && !e.id.startsWith("booking:"))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const zone = planningZone(db, userId);
  const work = JSON.parse(
    one<{ weekly: string }>(
      db,
      "SELECT weekly FROM hours_sets WHERE user_id = ? AND kind = 'work' ORDER BY created_at LIMIT 1",
      userId,
    )?.weekly ?? "{}",
  ) as WeeklyHours;
  const busyAround = externalEvents(db, userId, from, to + 7 * DAY).filter(
    (e) => timed(e) && e.busy,
  );
  const out: Conflict[] = [];
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i] as ExternalEvent;
      const b = events[j] as ExternalEvent;
      if (b.start >= a.end) break;
      const length = b.end - b.start;
      const searchFrom = a.end;
      const free = hoursToTimeSet(work, zone, searchFrom, searchFrom + 7 * DAY);
      for (const e of busyAround) if (e.id !== b.id) free.subtract(e);
      const start = free
        .intervals()
        .map((iv) => ({ at: Math.ceil(iv.start / STEP) * STEP, end: iv.end }))
        .find((iv) => iv.at + length <= iv.end)?.at;
      out.push({
        ids: [`ext:${a.id}`, `ext:${b.id}`],
        titles: [a.title || "(busy)", b.title || "(busy)"],
        overlap: { start: b.start, end: Math.min(a.end, b.end) },
        fix:
          start === undefined ? null : { title: b.title || "(busy)", start, end: start + length },
      });
    }
  }
  return out;
}

/** The event that a planner link (`?item=task:<id>`) opens: the next one, else the last one. */
export function itemEvent(db: Db, userId: string, ref: string, now: number) {
  const cut = ref.indexOf(":");
  const kind = ref.slice(0, cut);
  const id = ref.slice(cut + 1);
  const rows = all<{ id: string; start_ms: number; end_ms: number }>(
    db,
    "SELECT id, start_ms, end_ms FROM managed_events WHERE user_id = ? AND kind = ? AND source_id = ? ORDER BY start_ms",
    userId,
    kind,
    id,
  );
  const e = rows.find((r) => r.end_ms > now) ?? rows.at(-1);
  return e ? { id: e.id, start: e.start_ms } : null;
}
