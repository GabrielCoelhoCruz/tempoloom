// MCP server for AI tools (docs/specs/assistant-mcp-server.md) over the MCP
// Streamable HTTP transport: one endpoint, a JSON-RPC 2.0 message in each POST
// body, a JSON response. There is no server-sent stream and no session state.
// A client authenticates with a personal API key as a bearer token. Read tools
// read the signed-in user's calendar; write tools only stage changes in preview
// mode (docs/specs/assistant-preview-mode.md).
import { Hono } from "hono";
import { z } from "zod";
import { TAG_FOCUS } from "../scheduler/blocking.ts";
import { addDays, utcToLocal, weekdayOf } from "../shared/time.ts";
import { hashToken, type User } from "./accounts.ts";
import { AUTOMATION_TYPES, listAutomationsPage, listKeySchema } from "./api/automations.ts";
import { CATEGORIES, computeStats } from "./api/stats.ts";
import { apiKeyUser } from "./api-keys.ts";
import { all, type Db, one } from "./db.ts";
import { answerTools } from "./mcp/answers.ts";
import { cursorKey, cursorOf, cut, nextCursor, PAGE_SIZE, pageInput } from "./mcp/pages.ts";
import { type CachedRow, cached, DAY, isoOf, rangeOf, readers, toMs } from "./mcp/reads.ts";
import {
  type Caller,
  fail,
  type Message,
  PROTOCOLS,
  rpcHandler,
  type Tool,
  ToolError,
  tool,
} from "./mcp/rpc.ts";
import { oauthUser, resourceMetadataUrl } from "./oauth.ts";
import {
  allDayWhen,
  managedEventBefore,
  openChanges,
  openChangesPage,
  type Preview,
  plainTitle,
  SOURCES,
  type StageArgs,
  userFormatsOf,
  when,
  zoneOf,
} from "./preview.ts";

/** The sort key of a task without a due date: after every due date. */
const NO_DUE = 9e15;

/**
 * One page of list_tasks: due first, tasks without a due date last, after the
 * key (due key, created_at, id). The index tasks_due_page (migration 28) has
 * this due key expression; the first bound seeks in it, the row value breaks ties.
 */
export const TASKS_PAGE = `SELECT id, title, level, total_minutes, due_at, status, created_at FROM tasks
  WHERE user_id = ? AND status = ? AND COALESCE(due_at, ${NO_DUE}) >= ?
    AND (COALESCE(due_at, ${NO_DUE}), created_at, id) > (?, ?, ?)
  ORDER BY COALESCE(due_at, ${NO_DUE}), created_at, id LIMIT ?`;

export interface McpDeps {
  db: Db;
  preview: Preview;
  baseUrl: string;
  writeEnabled: boolean;
  now: () => number;
}

const datetime = z.iso.datetime({ offset: true });

// --------------------------------------------------------- output schemas

const instant = z.string().describe("ISO 8601 UTC");
const date = z.string().describe("YYYY-MM-DD");
export const stagedOutput = z.object({
  id: z.string(),
  state: z.string(),
  summary: z.string(),
  review_url: z.string(),
  message: z.string(),
});
const hourFields = {
  meeting_hours: z.number(),
  focus_hours: z.number(),
  task_hours: z.number(),
  habit_hours: z.number(),
  other_hours: z.number(),
};
const minutes = z.object(
  Object.fromEntries(CATEGORIES.map((c) => [c, z.number()])) as Record<
    (typeof CATEGORIES)[number],
    z.ZodNumber
  >,
);

const RSVP_WORDS = {
  accepted: "Accept",
  declined: "Decline",
  tentative: "Answer maybe to",
} as const;

/** Monday of the week of an instant, for the planner link. */
function reviewUrl(baseUrl: string, zone: string, t: number): string {
  const d = utcToLocal(zone, t).date;
  return new URL(`/?week=${addDays(d, 1 - weekdayOf(d))}`, baseUrl).toString();
}

/**
 * Stages a change in preview mode for the caller and gives a stage tool's
 * result (stagedOutput). Every stage tool of MCP and of assistant chat uses it.
 */
export function stagedResult(
  deps: Pick<McpDeps, "db" | "preview" | "baseUrl">,
  caller: Caller,
  input: StageArgs,
  at: number,
) {
  const s = deps.preview.stage(caller.user.id, {
    ...input,
    source: caller.source ?? "mcp_client",
    client: caller.client,
  });
  return {
    id: s.id,
    state: s.state,
    summary: s.summary,
    review_url: reviewUrl(deps.baseUrl, zoneOf(deps.db, caller.user.id), at),
    message:
      "The change is staged in Tempoloom's preview mode. Nothing is written until the user applies it.",
  };
}

/**
 * The tools of the MCP server. Assistant chat (src/server/assistant/tools.ts)
 * uses the same tools, so both stage changes through one code path.
 */
export function mcpTools(deps: Omit<McpDeps, "writeEnabled">): Tool[] {
  const { db, preview, now } = deps;
  const { listEvents, findFree, weekSummary, meetingContext } = readers(db, now);

  const tools: Tool[] = [
    tool({
      name: "list_events",
      effect: "read",
      title: "List events",
      description:
        "Events on the user's calendars between start and end (at most 31 days): title, time, guests, location, video link, and whether Tempoloom plans the event. All-day events have kind all_day.",
      input: z.object({
        start: datetime.describe("Start of the range, ISO 8601 with an offset"),
        end: datetime.describe("End of the range, ISO 8601 with an offset"),
      }),
      output: z.object({
        time_zone: z.string(),
        events: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            start: instant,
            end: instant,
            managed: z.boolean().describe("Tempoloom plans this event"),
            kind: z.string(),
            busy: z.boolean(),
            attendees: z.array(z.string()),
            location: z.string(),
            organizer_self: z.boolean(),
            video_link: z.string().nullable(),
          }),
        ),
      }),
      run: ({ user }, a) => {
        const { from, to } = rangeOf(a.start, a.end, now());
        return { time_zone: zoneOf(db, user.id), events: listEvents(user, from, to) };
      },
    }),
    tool({
      name: "find_free_time",
      effect: "read",
      title: "Find free time",
      description:
        "Free slots of the given length inside the user's meeting hours where the user, and guests who use this Tempoloom server, have no busy event. Earliest first. Tasks, habits and focus time that Tempoloom plans do not count as busy: Tempoloom moves them.",
      input: z.object({
        duration_minutes: z.number().int().min(15).max(480),
        start: datetime.optional().describe("Default: now"),
        end: datetime.optional().describe("Default: 7 days after start; at most 31 days"),
        attendees: z.array(z.email()).max(20).optional(),
      }),
      output: z.object({
        slots: z.array(z.object({ start: instant, end: instant })),
        unknown_attendees: z.array(z.string()).describe("Guests without an account on this server"),
      }),
      run: ({ user }, a) => findFree(user, a),
    }),
    tool({
      name: "get_week_summary",
      effect: "read",
      title: "Week summary",
      description:
        "Hours of meetings, focus time, tasks, habits and other commitments per day of one week, in the user's time zone.",
      input: z.object({ week_start: z.iso.date().describe("First day of the week, YYYY-MM-DD") }),
      output: z.object({
        week_start: date,
        time_zone: z.string(),
        days: z.array(z.object({ date, meetings: z.number(), ...hourFields })),
        totals: z.object(hourFields),
      }),
      run: ({ user }, a) => weekSummary(user, a.week_start),
    }),
    tool({
      name: "get_meeting_context",
      effect: "read",
      title: "Meeting preparation",
      description:
        "Details of one event (an id from list_events), the earlier meetings with the same guests, and open tasks that look related.",
      input: z.object({ event_id: z.string().min(1) }),
      output: z.object({
        event: z.object({
          id: z.string(),
          title: z.string(),
          start: instant,
          end: instant,
          attendees: z.array(z.string()),
          organizer_self: z.boolean(),
          location: z.string(),
          description: z.string(),
          video_link: z.string().nullable(),
        }),
        past_meetings: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            start: instant,
            end: instant,
            attendees: z.array(z.string()),
          }),
        ),
        related_tasks: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            priority: z.number(),
            due: instant.nullable(),
          }),
        ),
      }),
      run: ({ user }, a) => meetingContext(user, a.event_id),
    }),
    tool({
      name: "get_stats",
      effect: "read",
      title: "Stats",
      description: "Where the user's time went between two dates: minutes per category and day.",
      input: z.object({ start_date: z.iso.date(), end_date: z.iso.date() }),
      output: z.object({
        from: date,
        to: date,
        days: z.array(z.object({ date, minutes })),
        totals: minutes,
        highlights: z.object({
          meetingMinutes: z.number(),
          focusMinutes: z.number(),
          bookings: z.number(),
          meetingMinutesOutsideWorkHours: z.number(),
        }),
      }),
      run: ({ user }, a) => {
        if (a.end_date < a.start_date) throw new ToolError("end_date is before start_date");
        if ((Date.parse(a.end_date) - Date.parse(a.start_date)) / DAY > 120)
          throw new ToolError("The range is too long: at most 120 days");
        return computeStats(db, user.id, a.start_date, a.end_date, now());
      },
    }),
    tool({
      name: "list_tasks",
      effect: "read",
      title: "List tasks",
      description:
        "The user's tasks with priority (1 is highest), due date and state, due first. One page per call.",
      input: z.object({ status: z.enum(["open", "done"]).optional(), ...pageInput }),
      output: z.object({
        tasks: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            priority: z.number(),
            minutes: z.number(),
            due: instant.nullable(),
            status: z.enum(["open", "done"]),
          }),
        ),
        next_cursor: nextCursor,
      }),
      run: ({ user }, a) => {
        const status = a.status ?? "open";
        const limit = a.limit ?? PAGE_SIZE;
        // Due first, tasks without a due date last: due_at NULL sorts as NO_DUE.
        const after = cursorKey(
          "list_tasks",
          status,
          z.tuple([z.number(), z.number(), z.string()]),
          a.cursor,
        );
        const rows = all<{
          id: string;
          title: string;
          level: number;
          total_minutes: number;
          due_at: number | null;
          status: "open" | "done";
          created_at: number;
        }>(
          db,
          TASKS_PAGE,
          user.id,
          status,
          after?.[0] ?? -1,
          ...(after ?? [-1, -1, ""]),
          limit + 1,
        );
        const p = cut(rows, limit, "list_tasks", status, (t) => [
          t.due_at ?? NO_DUE,
          t.created_at,
          t.id,
        ]);
        return {
          tasks: p.rows.map((t) => ({
            id: t.id,
            title: t.title,
            priority: t.level,
            minutes: t.total_minutes,
            due: t.due_at === null ? null : isoOf(t.due_at),
            status: t.status,
          })),
          next_cursor: p.next_cursor,
        };
      },
    }),
    tool({
      name: "list_automations",
      effect: "read",
      title: "List automations",
      description:
        "Flexible meetings, buffers, habits, meeting overloads, focus time goals and meeting checks, with type, priority and whether each is on, in the order of the automation list. One page per call.",
      input: z.object(pageInput),
      output: z.object({
        automations: z.array(
          z.object({
            type: z.enum(AUTOMATION_TYPES),
            id: z.string(),
            title: z.string(),
            level: z.number().nullable().describe("Priority 1 to 4; meeting checks have none"),
            enabled: z.boolean(),
          }),
        ),
        next_cursor: nextCursor,
      }),
      run: ({ user }, a) => {
        const limit = a.limit ?? PAGE_SIZE;
        const after = cursorKey("list_automations", "", listKeySchema, a.cursor);
        const p = listAutomationsPage(db, user.id, after, limit);
        return {
          automations: p.rows.map((r) => ({
            type: r.type,
            id: r.id,
            title: r.name,
            level: r.level,
            enabled: r.enabled,
          })),
          next_cursor: p.next && cursorOf("list_automations", "", p.next),
        };
      },
    }),
    tool({
      name: "list_staged_changes",
      effect: "read",
      title: "List staged changes",
      description:
        "Changes waiting in preview mode for the user to apply, with their source and summary, oldest first. One page per call.",
      input: z.object(pageInput),
      output: z.object({
        changes: z.array(
          z.object({
            id: z.string(),
            source: z.enum(SOURCES),
            summary: z.string(),
            reason: z.string(),
            state: z.enum(["pending", "accepted"]),
            created_at: instant,
          }),
        ),
        next_cursor: nextCursor,
      }),
      run: ({ user }, a) => {
        const limit = a.limit ?? PAGE_SIZE;
        const after = cursorKey(
          "list_staged_changes",
          "",
          z.tuple([z.number(), z.number()]),
          a.cursor,
        );
        const p = cut(
          openChangesPage(db, user.id, now(), after, limit + 1),
          limit,
          "list_staged_changes",
          "",
          (c) => [c.createdAt, c.seq],
        );
        return {
          changes: p.rows.map((c) => ({
            id: c.id,
            source: c.source,
            summary: c.summary,
            reason: c.reason,
            state: c.state,
            created_at: isoOf(c.createdAt),
          })),
          next_cursor: p.next_cursor,
        };
      },
    }),
    tool({
      name: "propose_create_event",
      title: "Propose a new event",
      description:
        "Stages a new event in Tempoloom's preview mode. Nothing is written and no guest is invited until the user approves and applies the change in Tempoloom.",
      effect: "stage",
      input: z.object({
        title: z.string().trim().min(1).max(255),
        start: datetime,
        end: datetime,
        attendees: z.array(z.email()).max(50).optional(),
        description: z.string().max(10_000).optional(),
        location: z.string().max(1000).optional(),
        reason: z.string().max(1000).optional().describe("Why, in one sentence, shown to the user"),
      }),
      output: stagedOutput,
      run: (caller, a) => {
        const start = toMs(a.start);
        const end = toMs(a.end);
        if (end <= start) throw new ToolError("end must be after start");
        if (end - start > DAY) throw new ToolError("An event can last at most 24 hours");
        const zone = zoneOf(db, caller.user.id);
        const f = userFormatsOf(db, caller.user.id);
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
            summary: `Create “${a.title}” · ${when(zone, start, end, f)}${attendees.length ? ` · invites ${attendees.join(", ")}` : ""}`,
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
        "Stages a new time, title or description (for example an agenda or a prep plan) for an event the user organizes (an id from list_events), as one change. Give the whole new description; keep the parts of the current one that still apply. For events that Tempoloom plans, only the start can change. Nothing changes until the user approves and applies it.",
      effect: "stage",
      input: z.object({
        event_id: z.string().min(1),
        start: datetime.optional(),
        end: datetime.optional(),
        title: z.string().trim().min(1).max(255).optional(),
        description: z
          .string()
          .trim()
          .min(1, "To clear a description, write a short one instead; an empty one is refused")
          .max(10_000)
          .optional(),
        reason: z.string().max(1000).optional(),
      }),
      output: stagedOutput,
      run: (caller, a) => proposeUpdate(caller, a),
    }),
    tool({
      name: "propose_delete_event",
      title: "Propose to delete an event",
      description:
        "Stages the deletion of an event the user organizes. Guests hear about it only when the user approves and applies the change.",
      effect: "stage",
      input: z.object({ event_id: z.string().min(1), reason: z.string().max(1000).optional() }),
      output: stagedOutput,
      run: (caller, a) => {
        const ev = editable(caller.user, a.event_id);
        const zone = zoneOf(db, caller.user.id);
        const f = userFormatsOf(db, caller.user.id);
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
            summary: `Delete “${ev.summary}” · ${when(zone, ev.start_ms, ev.end_ms, f)}`,
            reason: a.reason ?? "",
          },
          ev.start_ms,
        );
      },
    }),
    tool({
      name: "propose_rsvp",
      title: "Propose an answer to an invitation",
      description:
        "Stages the user's answer (accepted, declined or tentative) to an invitation from someone else (an id from list_events). The organizer sees the answer only when the user approves and applies it.",
      effect: "stage",
      input: z.object({
        event_id: z.string().min(1),
        response: z.enum(["accepted", "declined", "tentative"]),
        reason: z.string().max(1000).optional(),
      }),
      output: stagedOutput,
      run: (caller, a) => {
        const ev = cached(db, caller.user.id, a.event_id);
        if (!ev) throw new ToolError(`No event ${a.event_id} on your calendars`);
        if (ev.organizer_self || ev.attendee_count === 0 || ev.self_response === null)
          throw new ToolError(
            "This event is not an invitation to you; change it with propose_update_event instead",
          );
        if (!ev.writable) throw new ToolError("This calendar is read-only");
        const zone = zoneOf(db, caller.user.id);
        const f = userFormatsOf(db, caller.user.id);
        return staged(
          caller,
          {
            kind: "event_rsvp",
            target: a.event_id,
            before: { title: ev.summary, start: ev.start_ms, end: ev.end_ms },
            after: { response: a.response },
            impact: [],
            summary: `${RSVP_WORDS[a.response]} “${ev.summary}” · ${when(zone, ev.start_ms, ev.end_ms, f)}`,
            reason: a.reason ?? "",
          },
          ev.start_ms,
        );
      },
    }),
    tool({
      name: "propose_focus_time",
      title: "Propose a focus time block",
      description:
        "Stages a busy focus time event of the given length in the first free time of the user's hours between start and end, for example two hours of deep work before noon. It counts as focus time in the stats. Nothing is written until the user approves and applies it.",
      effect: "stage",
      input: z.object({
        duration_minutes: z.number().int().min(15).max(480),
        start: datetime.optional().describe("Earliest start. Default: now"),
        end: datetime.optional().describe("Latest end. Default: 7 days after start"),
        title: z.string().trim().min(1).max(255).optional().describe("Default: Focus time"),
        reason: z.string().max(1000).optional(),
      }),
      output: stagedOutput,
      run: (caller, a) => {
        const [slot] = findFree(caller.user, {
          duration_minutes: a.duration_minutes,
          start: a.start,
          end: a.end,
        }).slots;
        if (!slot) throw new ToolError("No free time of that length in your hours in this range");
        const start = toMs(slot.start);
        const end = toMs(slot.end);
        const title = a.title ?? "Focus time";
        const zone = zoneOf(db, caller.user.id);
        const f = userFormatsOf(db, caller.user.id);
        return staged(
          caller,
          {
            kind: "event_create",
            after: {
              title,
              start,
              end,
              attendees: [],
              // The focus tag makes it focus time in stats and summaries (events-tags.md).
              description: TAG_FOCUS,
              location: "",
            },
            impact: [{ op: "create", title, start, end }],
            summary: `Focus time “${title}” · ${when(zone, start, end, f)}`,
            reason: a.reason ?? "",
          },
          start,
        );
      },
    }),
    tool({
      name: "propose_log_task_time",
      title: "Propose a work session on a task",
      description:
        "Stages a past work session on a task (an id from list_tasks): a locked task event from start for the given minutes on the task's calendar. Nothing is written until the user approves and applies it.",
      effect: "stage",
      input: z.object({
        task_id: z.string().min(1),
        start: datetime,
        minutes: z.number().int().min(1).max(720),
        reason: z.string().max(1000).optional(),
      }),
      output: stagedOutput,
      run: (caller, a) => {
        const task = one<{ title: string }>(
          db,
          "SELECT title FROM tasks WHERE id = ? AND user_id = ?",
          a.task_id,
          caller.user.id,
        );
        if (!task) throw new ToolError(`No task ${a.task_id}`);
        const start = toMs(a.start);
        const end = start + a.minutes * 60_000;
        if (end > now()) throw new ToolError("A work session cannot end in the future");
        const zone = zoneOf(db, caller.user.id);
        const f = userFormatsOf(db, caller.user.id);
        return staged(
          caller,
          {
            kind: "request",
            after: {
              method: "POST",
              path: `/api/tasks/${a.task_id}/sessions`,
              body: JSON.stringify({ start, minutes: a.minutes }),
            },
            impact: [{ op: "create", title: task.title, start, end }],
            summary: `Work session on “${task.title}” · ${a.minutes} min · ${when(zone, start, end, f)}`,
            reason: a.reason ?? "",
          },
          start,
        );
      },
    }),
    tool({
      name: "apply_staged_changes",
      title: "Apply staged changes",
      description:
        "Applies changes that this or another AI tool staged, after the user confirmed them in the conversation. Changes staged in Tempoloom itself must be applied there. Each result is applied, stale (the event changed since) or failed.",
      effect: "apply",
      input: z.object({ ids: z.array(z.string()).min(1).max(100) }),
      output: z.object({
        results: z.array(
          z.discriminatedUnion("result", [
            z.object({ id: z.string(), result: z.literal("applied") }),
            z.object({ id: z.string(), result: z.literal("stale"), reason: z.string() }),
            z.object({ id: z.string(), result: z.literal("failed"), error: z.string() }),
            z.object({ id: z.string(), result: z.literal("refused"), reason: z.string() }),
          ]),
        ),
      }),
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
            ...result.applied.map((r) => ({ id: r.id, result: "applied" as const })),
            ...result.stale.map((r) => ({ id: r.id, result: "stale" as const, reason: r.reason })),
            ...result.failed.map((r) => ({ id: r.id, result: "failed" as const, error: r.error })),
            ...refused.map((id) => ({
              id,
              result: "refused" as const,
              reason: "Not a pending change staged by an AI tool; apply it in Tempoloom",
            })),
          ],
        };
      },
    }),
    ...answerTools(deps),
  ];

  function staged(caller: Caller, input: StageArgs, at: number) {
    return stagedResult(deps, caller, input, at);
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
      description?: string | undefined;
      reason?: string | undefined;
    },
  ) {
    const zone = zoneOf(db, caller.user.id);
    const f = userFormatsOf(db, caller.user.id);
    const managed = one<{ id: string; title: string; start_ms: number; end_ms: number }>(
      db,
      "SELECT id, title, start_ms, end_ms FROM managed_events WHERE id = ? AND user_id = ?",
      a.event_id,
      caller.user.id,
    );
    if (managed) {
      if (a.title || a.description !== undefined)
        throw new ToolError(
          "Change the title and description of Tempoloom's events in their automation",
        );
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
          before: managedEventBefore(managed),
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
          summary: `Move “${title}” to ${when(zone, start, end, f)}`,
          reason: a.reason ?? "",
        },
        start,
      );
    }
    const ev = editable(caller.user, a.event_id);
    const start = a.start ? toMs(a.start) : ev.start_ms;
    const end = a.end ? toMs(a.end) : start + (ev.end_ms - ev.start_ms);
    if (end <= start) throw new ToolError("end must be after start");
    const moved = start !== ev.start_ms || end !== ev.end_ms;
    const renamed = a.title !== undefined && a.title !== ev.summary;
    const described = a.description !== undefined && a.description !== ev.description;
    const allDay = ev.all_day === 1;
    // A new time is an instant; on an all-day event it would make the event timed.
    if (allDay && moved)
      throw new ToolError(
        "Tempoloom cannot move all-day events yet. Change their title or description only.",
      );
    if (!moved && !renamed && !described)
      throw new ToolError(
        "Nothing changes: give a start, end, title or description that differs from the event's. Nothing was staged.",
      );
    const title = renamed ? (a.title as string) : ev.summary;
    const at = allDay
      ? allDayWhen(zone, ev.start_ms, ev.end_ms, f)
      : when(zone, ev.start_ms, ev.end_ms, f);
    const extra = [
      ...(moved && renamed ? [`renamed “${title}”`] : []),
      ...(described ? ["with a new description"] : []),
    ].join(" and ");
    const summary = moved
      ? `Move “${ev.summary}” to ${when(zone, start, end, f)}${extra ? `, ${extra}` : ""}`
      : renamed
        ? `Rename “${ev.summary}” to “${title}”${described ? " and set a new description" : ""} · ${at}`
        : `New description for “${ev.summary}” · ${at}`;
    // Only the fields that change: apply sends nothing else to the calendar, so an
    // all-day event stays all-day and the guests' answers stay (preview mode).
    return staged(
      caller,
      {
        kind: "event_update",
        target: a.event_id,
        before: {
          title: ev.summary,
          start: ev.start_ms,
          end: ev.end_ms,
          ...(described ? { description: ev.description } : {}),
        },
        after: {
          ...(moved ? { start, end } : {}),
          ...(renamed ? { title } : {}),
          ...(described ? { description: a.description } : {}),
        },
        impact: moved
          ? [
              {
                op: "move",
                title,
                start,
                end,
                from: { start: ev.start_ms, end: ev.end_ms },
                eventId: a.event_id,
              },
            ]
          : [],
        summary,
        reason: a.reason ?? "",
      },
      start,
    );
  }

  return tools;
}

export function mcpRoutes(deps: McpDeps): Hono {
  const { db, now } = deps;
  const origin = new URL(deps.baseUrl).origin;
  const handle = rpcHandler(mcpTools(deps), deps.writeEnabled);

  /** A personal API key as the bearer token; the key's name labels the client. */
  function keyCaller(auth: string | undefined): Caller | undefined {
    const user = apiKeyUser(db, auth, now());
    if (!user) return undefined;
    const secret = /^Bearer (\S+)$/.exec(auth ?? "")?.[1] ?? "";
    const client =
      one<{ name: string }>(db, "SELECT name FROM api_keys WHERE token_hash = ?", hashToken(secret))
        ?.name ?? "";
    return { user, client };
  }

  const r = new Hono();

  r.post("/", async (c) => {
    // DNS rebinding protection: browsers send Origin; only this server's own is allowed.
    const from = c.req.header("origin");
    if (from && from !== origin) return c.json(fail(null, -32600, "Origin not allowed"), 403);
    const auth = c.req.header("authorization");
    const caller = oauthUser(db, auth, now()) ?? keyCaller(auth);
    if (!caller) {
      // The MCP authorization spec: the 401 names the protected resource metadata.
      c.header(
        "WWW-Authenticate",
        `Bearer realm="tempoloom", error="invalid_token", resource_metadata="${resourceMetadataUrl(deps.baseUrl)}"`,
      );
      return c.json(
        fail(null, -32001, "Unauthorized: sign in with OAuth, or send a Tempoloom API key"),
        401,
      );
    }
    const version = c.req.header("mcp-protocol-version");
    if (version && !PROTOCOLS.includes(version))
      return c.json(fail(null, -32600, `Unsupported protocol version ${version}`), 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(fail(null, -32700, "Parse error"), 400);
    }
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
