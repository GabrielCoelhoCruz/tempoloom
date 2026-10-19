// MCP server for AI tools (docs/specs/assistant-mcp-server.md) over the MCP
// Streamable HTTP transport: one endpoint, a JSON-RPC 2.0 message in each POST
// body, a JSON response. There is no server-sent stream and no session state.
// A client authenticates with a personal API key as a bearer token. Read tools
// read the signed-in user's calendar; write tools only stage changes in preview
// mode (docs/specs/assistant-preview-mode.md).
import { Hono } from "hono";
import { z } from "zod";
import { attends, blockingIntervals, hasTag, TAG_FOCUS } from "../scheduler/blocking.ts";
import { hoursToTimeSet, type WeeklyHours } from "../scheduler/hours.ts";
import type { ExternalEvent } from "../scheduler/model.ts";
import type { TimeSet } from "../scheduler/timeset.ts";
import { addDays, localToUtc, utcToLocal, weekdayOf } from "../shared/time.ts";
import { hashToken, type User } from "./accounts.ts";
import { plannerEvents } from "./api/planner.ts";
import { computeStats } from "./api/stats.ts";
import { apiKeyUser } from "./api-keys.ts";
import { all, type Db, one } from "./db.ts";
import { externalEvents } from "./planner/events.ts";
import { openChanges, type Preview, plainTitle, when, zoneOf } from "./preview.ts";

const DAY = 86_400_000;
const MAX_RANGE_DAYS = 31;
/** Protocol versions this server speaks, newest first. */
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export interface McpDeps {
  db: Db;
  preview: Preview;
  baseUrl: string;
  writeEnabled: boolean;
  now: () => number;
}

interface Caller {
  user: User;
  /** The API key's name: the label of this connection in preview mode. */
  client: string;
}

class ToolError extends Error {}

const datetime = z.iso.datetime({ offset: true });
const toMs = (s: string) => Date.parse(s);
const isoOf = (t: number) => new Date(t).toISOString();

function rangeOf(start: string | undefined, end: string | undefined, now: number) {
  const from = start ? toMs(start) : now;
  const to = end ? toMs(end) : from + 7 * DAY;
  if (to <= from) throw new ToolError("end must be after start");
  if (to - from > MAX_RANGE_DAYS * DAY)
    throw new ToolError(`The range is too long: at most ${MAX_RANGE_DAYS} days per call`);
  return { from, to };
}

const VIDEO =
  /https:\/\/[^\s<>"]*(zoom\.us|meet\.google\.com|teams\.microsoft\.com|whereby\.com|meet\.jit\.si)[^\s<>"]*/i;

interface CachedRow {
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

function cached(db: Db, userId: string, id: string): CachedRow | undefined {
  if (!id.startsWith("ext:")) return undefined;
  const rest = id.slice(4);
  const cut = rest.indexOf(":");
  return one<CachedRow>(
    db,
    `SELECT e.*, c.writable FROM events e JOIN calendars c ON c.id = e.calendar_id
     JOIN accounts a ON a.id = c.account_id WHERE a.user_id = ? AND e.calendar_id = ? AND e.event_id = ?`,
    userId,
    rest.slice(0, cut),
    rest.slice(cut + 1),
  );
}

const others = (attendees: string, self: string) =>
  (JSON.parse(attendees) as string[]).filter((a) => a !== self);

/** Monday of the week of an instant, for the planner link. */
function reviewUrl(baseUrl: string, zone: string, t: number): string {
  const d = utcToLocal(zone, t).date;
  return new URL(`/?week=${addDays(d, 1 - weekdayOf(d))}`, baseUrl).toString();
}

interface Tool {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject;
  write?: boolean;
  run: (caller: Caller, args: never) => unknown;
}

export function mcpRoutes(deps: McpDeps): Hono {
  const { db, preview, now } = deps;
  const origin = new URL(deps.baseUrl).origin;

  const tool = <S extends z.ZodObject>(t: {
    name: string;
    title: string;
    description: string;
    input: S;
    write?: boolean;
    run: (caller: Caller, args: z.infer<S>) => unknown;
  }): Tool => t as unknown as Tool;

  const tools: Tool[] = [
    tool({
      name: "list_events",
      title: "List events",
      description:
        "Events on the user's calendars between start and end (at most 31 days): title, time, guests, location, video link, and whether Tempoloom plans the event.",
      input: z.object({
        start: datetime.describe("Start of the range, ISO 8601 with an offset"),
        end: datetime.describe("End of the range, ISO 8601 with an offset"),
      }),
      run: ({ user }, a) => {
        const { from, to } = rangeOf(a.start, a.end, now());
        return { time_zone: zoneOf(db, user.id), events: listEvents(user, from, to) };
      },
    }),
    tool({
      name: "find_free_time",
      title: "Find free time",
      description:
        "Free slots of the given length inside the user's meeting hours where the user, and guests who use this Tempoloom server, have no busy event. Earliest first. Tasks, habits and focus time that Tempoloom plans do not count as busy: Tempoloom moves them.",
      input: z.object({
        duration_minutes: z.number().int().min(15).max(480),
        start: datetime.optional().describe("Default: now"),
        end: datetime.optional().describe("Default: 7 days after start; at most 31 days"),
        attendees: z.array(z.email()).max(20).optional(),
      }),
      run: ({ user }, a) => findFree(user, a),
    }),
    tool({
      name: "get_week_summary",
      title: "Week summary",
      description:
        "Hours of meetings, focus time, tasks, habits and other commitments per day of one week, in the user's time zone.",
      input: z.object({ week_start: z.iso.date().describe("First day of the week, YYYY-MM-DD") }),
      run: ({ user }, a) => weekSummary(user, a.week_start),
    }),
    tool({
      name: "get_meeting_context",
      title: "Meeting preparation",
      description:
        "Details of one event (an id from list_events), the earlier meetings with the same guests, and open tasks that look related.",
      input: z.object({ event_id: z.string().min(1) }),
      run: ({ user }, a) => meetingContext(user, a.event_id),
    }),
    tool({
      name: "get_stats",
      title: "Stats",
      description: "Where the user's time went between two dates: minutes per category and day.",
      input: z.object({ start_date: z.iso.date(), end_date: z.iso.date() }),
      run: ({ user }, a) => {
        if (a.end_date < a.start_date) throw new ToolError("end_date is before start_date");
        if ((Date.parse(a.end_date) - Date.parse(a.start_date)) / DAY > 120)
          throw new ToolError("The range is too long: at most 120 days");
        return computeStats(db, user.id, a.start_date, a.end_date, now());
      },
    }),
    tool({
      name: "list_tasks",
      title: "List tasks",
      description: "The user's tasks with priority (1 is highest), due date and state.",
      input: z.object({ status: z.enum(["open", "done"]).optional() }),
      run: ({ user }, a) => ({
        tasks: all<{
          id: string;
          title: string;
          level: number;
          total_minutes: number;
          due_at: number | null;
          status: string;
        }>(
          db,
          "SELECT * FROM tasks WHERE user_id = ? AND status = ? ORDER BY COALESCE(due_at, 9e15), created_at",
          user.id,
          a.status ?? "open",
        ).map((t) => ({
          id: t.id,
          title: t.title,
          priority: t.level,
          minutes: t.total_minutes,
          due: t.due_at === null ? null : isoOf(t.due_at),
          status: t.status,
        })),
      }),
    }),
    tool({
      name: "list_automations",
      title: "List automations",
      description:
        "Habits, focus time goals, buffers and flexible meetings, with type, priority and whether each is on.",
      input: z.object({}),
      run: ({ user }) => ({
        automations: [
          ...all<{ id: string; title: string; level: number; enabled: number }>(
            db,
            "SELECT id, title, level, enabled FROM habits WHERE user_id = ? ORDER BY level, rank",
            user.id,
          ).map((h) => ({ type: "habit", ...h, enabled: h.enabled === 1 })),
          ...all<{ id: string; title: string; enabled: number }>(
            db,
            "SELECT id, title, enabled FROM focus_goals WHERE user_id = ?",
            user.id,
          ).map((f) => ({ type: "focus_time", ...f, level: null, enabled: f.enabled === 1 })),
          ...all<{ id: string; title: string; level: number; enabled: number }>(
            db,
            "SELECT id, title, level, enabled FROM buffers WHERE user_id = ? ORDER BY level, rank",
            user.id,
          ).map((b) => ({ type: "buffer", ...b, enabled: b.enabled === 1 })),
          ...all<{ id: string; title: string; level: number; enabled: number }>(
            db,
            "SELECT id, title, level, enabled FROM meetings WHERE user_id = ? ORDER BY level, rank",
            user.id,
          ).map((m) => ({ type: "flexible_meeting", ...m, enabled: m.enabled === 1 })),
        ],
      }),
    }),
    tool({
      name: "list_staged_changes",
      title: "List staged changes",
      description:
        "Changes waiting in preview mode for the user to apply, with their source and summary.",
      input: z.object({}),
      run: ({ user }) => ({
        changes: openChanges(db, user.id, now()).map((c) => ({
          id: c.id,
          source: c.source,
          summary: c.summary,
          reason: c.reason,
          state: c.state,
          created_at: isoOf(c.createdAt),
        })),
      }),
    }),
    tool({
      name: "propose_create_event",
      title: "Propose a new event",
      description:
        "Stages a new event in Tempoloom's preview mode. Nothing is written and no guest is invited until the user applies the change in Tempoloom, or confirms it and you call apply_staged_changes.",
      write: true,
      input: z.object({
        title: z.string().trim().min(1).max(255),
        start: datetime,
        end: datetime,
        attendees: z.array(z.email()).max(50).optional(),
        description: z.string().max(10_000).optional(),
        location: z.string().max(1000).optional(),
        reason: z.string().max(1000).optional().describe("Why, in one sentence, shown to the user"),
      }),
      run: (caller, a) => {
        const start = toMs(a.start);
        const end = toMs(a.end);
        if (end <= start) throw new ToolError("end must be after start");
        if (end - start > DAY) throw new ToolError("An event can last at most 24 hours");
        const zone = zoneOf(db, caller.user.id);
        const attendees = [...new Set((a.attendees ?? []).map((x) => x.toLowerCase()))];
        return staged(
          caller,
          {
            kind: "event_create",
            after: {
              title: a.title,
              start,
              end,
              attendees,
              description: a.description ?? "",
              location: a.location ?? "",
            },
            impact: [{ op: "create", title: a.title, start, end }],
            summary: `Create “${a.title}” · ${when(zone, start, end)}${attendees.length ? ` · invites ${attendees.join(", ")}` : ""}`,
            reason: a.reason ?? "",
          },
          start,
        );
      },
    }),
    tool({
      name: "propose_update_event",
      title: "Propose a change to an event",
      description:
        "Stages a new time or title for an event the user organizes (an id from list_events). For events that Tempoloom plans, only the start can change. Nothing changes until the user applies it.",
      write: true,
      input: z.object({
        event_id: z.string().min(1),
        start: datetime.optional(),
        end: datetime.optional(),
        title: z.string().trim().min(1).max(255).optional(),
        reason: z.string().max(1000).optional(),
      }),
      run: (caller, a) => proposeUpdate(caller, a),
    }),
    tool({
      name: "propose_delete_event",
      title: "Propose to delete an event",
      description:
        "Stages the deletion of an event the user organizes. Guests hear about it only when the user applies the change.",
      write: true,
      input: z.object({ event_id: z.string().min(1), reason: z.string().max(1000).optional() }),
      run: (caller, a) => {
        const ev = editable(caller.user, a.event_id);
        const zone = zoneOf(db, caller.user.id);
        return staged(
          caller,
          {
            kind: "event_delete",
            target: a.event_id,
            before: { title: ev.summary, start: ev.start_ms, end: ev.end_ms },
            after: null,
            impact: [
              {
                op: "delete",
                title: ev.summary,
                start: ev.start_ms,
                end: ev.end_ms,
                eventId: a.event_id,
              },
            ],
            summary: `Delete “${ev.summary}” · ${when(zone, ev.start_ms, ev.end_ms)}`,
            reason: a.reason ?? "",
          },
          ev.start_ms,
        );
      },
    }),
    tool({
      name: "apply_staged_changes",
      title: "Apply staged changes",
      description:
        "Applies changes that this or another AI tool staged, after the user confirmed them in the conversation. Changes staged in Tempoloom itself must be applied there. Each result is applied, stale (the event changed since) or failed.",
      write: true,
      input: z.object({ ids: z.array(z.string()).min(1).max(100) }),
      run: async ({ user }, a) => {
        const mine = new Set(
          openChanges(db, user.id, now())
            .filter((c) => c.source === "mcp_client")
            .map((c) => c.id),
        );
        const refused = a.ids.filter((id) => !mine.has(id));
        const result = await preview.apply(
          user.id,
          a.ids.filter((id) => mine.has(id)),
        );
        return {
          results: [
            ...result.applied.map((r) => ({ id: r.id, result: "applied" })),
            ...result.stale.map((r) => ({ id: r.id, result: "stale", reason: r.reason })),
            ...result.failed.map((r) => ({ id: r.id, result: "failed", error: r.error })),
            ...refused.map((id) => ({
              id,
              result: "refused",
              reason: "Not a pending change staged by an AI tool; apply it in Tempoloom",
            })),
          ],
        };
      },
    }),
  ];

  function staged(
    caller: Caller,
    input: Omit<Parameters<Preview["stage"]>[1], "source" | "client">,
    at: number,
  ) {
    const s = preview.stage(caller.user.id, {
      ...input,
      source: "mcp_client",
      client: caller.client,
    });
    return {
      id: s.id,
      state: s.state,
      summary: s.summary,
      review_url: reviewUrl(deps.baseUrl, zoneOf(db, caller.user.id), at),
      message:
        "The change is staged in Tempoloom's preview mode. Nothing is written until the user applies it.",
    };
  }

  /** An event of the user's that Tempoloom may change for them (edge case 2). */
  function editable(user: User, id: string): CachedRow {
    const ev = cached(db, user.id, id);
    if (!ev) throw new ToolError(`No event ${id} on your calendars`);
    if ((JSON.parse(ev.private_props) as Record<string, string>).tl === "1")
      throw new ToolError("Tempoloom plans this event; change or turn off its automation instead");
    if (!ev.writable) throw new ToolError("This calendar is read-only");
    if (!ev.organizer_self)
      throw new ToolError(
        "You do not organize this event, so Tempoloom cannot change it. Answer the invitation instead.",
      );
    return ev;
  }

  function proposeUpdate(
    caller: Caller,
    a: {
      event_id: string;
      start?: string | undefined;
      end?: string | undefined;
      title?: string | undefined;
      reason?: string | undefined;
    },
  ) {
    const zone = zoneOf(db, caller.user.id);
    const managed = one<{ id: string; title: string; start_ms: number; end_ms: number }>(
      db,
      "SELECT id, title, start_ms, end_ms FROM managed_events WHERE id = ? AND user_id = ?",
      a.event_id,
      caller.user.id,
    );
    if (managed) {
      if (a.title)
        throw new ToolError("Change the title of Tempoloom's events in their automation");
      if (!a.start) throw new ToolError("start is required");
      const start = toMs(a.start);
      const end = start + (managed.end_ms - managed.start_ms);
      if (a.end && toMs(a.end) !== end)
        throw new ToolError(
          "Tempoloom keeps the length of the events it plans; change the start only",
        );
      const title = plainTitle(db, caller.user.id, managed.title);
      return staged(
        caller,
        {
          kind: "request",
          target: `managed:${managed.id}`,
          before: { start: managed.start_ms, end: managed.end_ms },
          after: {
            method: "POST",
            path: `/api/planner/events/${managed.id}/move`,
            body: JSON.stringify({ start }),
          },
          impact: [
            {
              op: "move",
              title,
              start,
              end,
              from: { start: managed.start_ms, end: managed.end_ms },
              eventId: managed.id,
            },
          ],
          summary: `Move “${title}” to ${when(zone, start, end)}`,
          reason: a.reason ?? "",
        },
        start,
      );
    }
    const ev = editable(caller.user, a.event_id);
    const start = a.start ? toMs(a.start) : ev.start_ms;
    const end = a.end ? toMs(a.end) : start + (ev.end_ms - ev.start_ms);
    if (end <= start) throw new ToolError("end must be after start");
    if (!a.start && !a.end && !a.title) throw new ToolError("Give a new start, end or title");
    const title = a.title ?? ev.summary;
    const moved = start !== ev.start_ms || end !== ev.end_ms;
    return staged(
      caller,
      {
        kind: "event_update",
        target: a.event_id,
        before: { title: ev.summary, start: ev.start_ms, end: ev.end_ms },
        after: { start, end, ...(a.title ? { title: a.title } : {}) },
        impact: [
          {
            op: "move",
            title,
            start,
            end,
            from: { start: ev.start_ms, end: ev.end_ms },
            eventId: a.event_id,
          },
        ],
        summary: moved
          ? `Move “${ev.summary}” to ${when(zone, start, end)}${a.title ? ` as “${a.title}”` : ""}`
          : `Rename “${ev.summary}” to “${title}”`,
        reason: a.reason ?? "",
      },
      start,
    );
  }

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

  // ---------------------------------------------------------------- JSON-RPC

  const visible = () => tools.filter((t) => deps.writeEnabled || !t.write);

  interface Message {
    jsonrpc?: unknown;
    id?: unknown;
    method?: unknown;
    params?: unknown;
  }

  const reply = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (id: unknown, code: number, message: string) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  async function handle(caller: Caller, m: Message): Promise<object | null> {
    const isRequest = m.id !== undefined && m.id !== null;
    if (m.jsonrpc !== "2.0" || typeof m.method !== "string") {
      // A response from the client, or a malformed message.
      if (m.jsonrpc === "2.0" && m.method === undefined && ("result" in m || "error" in m))
        return null;
      return fail(m.id ?? null, -32600, "Invalid request");
    }
    if (!isRequest) return null; // A notification: nothing to answer.
    const params = (m.params ?? {}) as Record<string, unknown>;
    switch (m.method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return reply(m.id, {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "tempoloom", title: "Tempoloom", version: "0.1.0" },
          instructions: deps.writeEnabled
            ? "Read the user's calendar with the read tools. Write tools only stage changes in Tempoloom's preview mode; the user applies them."
            : "This server gives AI tools read-only access: read tools only.",
        });
      }
      case "ping":
        return reply(m.id, {});
      case "tools/list":
        return reply(m.id, {
          tools: visible().map((t) => {
            const { $schema: _, ...inputSchema } = z.toJSONSchema(t.input) as Record<
              string,
              unknown
            >;
            return {
              name: t.name,
              title: t.title,
              description: t.description,
              inputSchema,
              annotations: { readOnlyHint: !t.write, destructiveHint: false, openWorldHint: false },
            };
          }),
        });
      case "tools/call": {
        const name = typeof params.name === "string" ? params.name : "";
        const t = tools.find((x) => x.name === name);
        if (!t) return fail(m.id, -32602, `Unknown tool: ${name}`);
        if (t.write && !deps.writeEnabled)
          return fail(
            m.id,
            -32602,
            `${name} is not available: this server gives AI tools read-only access`,
          );
        const args = t.input.safeParse(params.arguments ?? {});
        if (!args.success) {
          const issues = args.error.issues.map(
            (i) => `${i.path.join(".") || "arguments"}: ${i.message}`,
          );
          return reply(m.id, {
            content: [{ type: "text", text: issues.join("; ") }],
            isError: true,
          });
        }
        try {
          const data = (await t.run(caller, args.data as never)) as Record<string, unknown>;
          return reply(m.id, {
            content: [{ type: "text", text: JSON.stringify(data) }],
            structuredContent: data,
          });
        } catch (err) {
          if (!(err instanceof ToolError)) {
            console.error(`MCP tool ${name} failed`, err);
            return reply(m.id, {
              content: [{ type: "text", text: "The tool failed on the server" }],
              isError: true,
            });
          }
          return reply(m.id, { content: [{ type: "text", text: err.message }], isError: true });
        }
      }
      default:
        return fail(m.id, -32601, `Method not found: ${m.method}`);
    }
  }

  const r = new Hono();

  r.post("/", async (c) => {
    // DNS rebinding protection: browsers send Origin; only this server's own is allowed.
    const from = c.req.header("origin");
    if (from && from !== origin) return c.json(fail(null, -32600, "Origin not allowed"), 403);
    const auth = c.req.header("authorization");
    const user = apiKeyUser(db, auth, now());
    if (!user) {
      c.header("WWW-Authenticate", 'Bearer realm="tempoloom", error="invalid_token"');
      return c.json(
        fail(null, -32001, "Unauthorized: send a Tempoloom API key as a bearer token"),
        401,
      );
    }
    const version = c.req.header("mcp-protocol-version");
    if (version && !PROTOCOLS.includes(version))
      return c.json(fail(null, -32600, `Unsupported protocol version ${version}`), 400);
    const secret = /^Bearer (\S+)$/.exec(auth ?? "")?.[1] ?? "";
    const client =
      one<{ name: string }>(db, "SELECT name FROM api_keys WHERE token_hash = ?", hashToken(secret))
        ?.name ?? "";
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(fail(null, -32700, "Parse error"), 400);
    }
    const caller = { user, client };
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handle(caller, m as Message)))).filter(
        (x) => x !== null,
      );
      return out.length ? c.json(out) : c.body(null, 202);
    }
    if (typeof body !== "object" || body === null)
      return c.json(fail(null, -32600, "Invalid request"), 400);
    const out = await handle(caller, body as Message);
    return out ? c.json(out) : c.body(null, 202);
  });

  // No server-sent stream and no sessions (Streamable HTTP allows both choices).
  r.on(["GET", "DELETE"], "/", (c) => {
    c.header("Allow", "POST");
    return c.text("Method not allowed", 405);
  });

  return r;
}
