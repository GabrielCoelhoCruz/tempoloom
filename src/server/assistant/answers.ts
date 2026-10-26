// Read tools and the task proposal of assistant chat (docs/specs/assistant-chat.md
// rules 8-10): what to work on, events that could become automations, who on
// the team is away, organization analytics for analytics admins, the help
// pages, and a new task (planning-tasks.md TSK-5). Each read uses only data
// the caller may see in the app; the task is staged in preview mode.
import { z } from "zod";
import { searchHelp } from "../../shared/help-pages.ts";
import { addDays, diffDays, utcToLocal, weekdayOf } from "../../shared/time.ts";
import { COLUMNS, orgReport } from "../analytics/org.ts";
import { taskInput } from "../api/items.ts";
import { all, type Db } from "../db.ts";
import { isoOf, toMs } from "../mcp/reads.ts";
import { type Tool, ToolError, tool } from "../mcp/rpc.ts";
import { adoptableSeries } from "../meeting-series.ts";
import { type TaskLite, tasksPanel } from "../planner/now.ts";
import { userFormatsOf, whenAt, zoneOf } from "../preview.ts";
import { membership } from "../teams.ts";
import { planningZone } from "../travel.ts";
import type { ChatTool, ChatToolDeps } from "./tools.ts";

const WEEKDAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (minuteOfDay: number) =>
  `${pad(Math.floor(minuteOfDay / 60))}:${pad(minuteOfDay % 60)}`;

const taskOut = z.object({
  id: z.string(),
  title: z.string(),
  priority: z.number(),
  remaining_minutes: z.number(),
  due: z.string().nullable().describe("ISO 8601 UTC"),
  next_up: z.boolean(),
});
const taskOf = (t: TaskLite) => ({
  id: t.id,
  title: t.title,
  priority: t.level,
  remaining_minutes: t.remainingMinutes,
  due: t.dueAt === null ? null : isoOf(t.dueAt),
  next_up: t.nextUp,
});

/** Rule 8, NXT-34: the planner's next-up task and its suggestions, the same data as the tasks panel. */
function suggestionsTool(db: Db, now: () => number): Tool {
  return tool({
    name: "get_task_suggestions",
    effect: "read",
    title: "Task suggestions",
    description:
      "What the user should work on now: the next-up task, the tasks suggested now (in the planner's order, the first is the best choice) and the tasks at risk with the reason. The same lists as the planner's tasks panel.",
    input: z.object({}),
    output: z.object({
      next_up: taskOut.nullable(),
      suggested_now: z.array(taskOut),
      at_risk: z.array(taskOut.extend({ why: z.string() })),
    }),
    run: ({ user }) => {
      const p = tasksPanel(db, user.id, now());
      return {
        next_up: p.nextUp && taskOf(p.nextUp),
        suggested_now: p.suggestedNow.map(taskOf),
        at_risk: p.atRisk.map((t) => ({ ...taskOf(t), why: t.why })),
      };
    },
  });
}

/**
 * Rule 8: recurring events that could become automations. A series with
 * guests that the user organizes can become a flexible meeting (the same list
 * as the daily email, NTF-30); a solo series can become a habit
 * (planning-habits rule 8), unless a habit has its title.
 */
function automationIdeasTool(db: Db, now: () => number): Tool {
  return tool({
    name: "suggest_automations",
    effect: "read",
    title: "Events that could become automations",
    description:
      "Recurring events on the user's calendars that could become automations: series with guests that the user organizes could become flexible meetings, solo series could become habits. Each comes with the page where the user makes it.",
    input: z.object({}),
    output: z.object({
      flexible_meetings: z.array(
        z.object({
          title: z.string(),
          attendees: z.array(z.string()),
          repeats: z.string(),
          time: z.string(),
          link: z.string(),
        }),
      ),
      habits: z.array(
        z.object({
          title: z.string(),
          days: z.array(z.string()),
          time: z.string(),
          minutes: z.number(),
          link: z.string(),
        }),
      ),
    }),
    run: ({ user }) => {
      const t = now();
      const zone = planningZone(db, user.id);
      const flexible = adoptableSeries(db, user.id, t).map((s) => ({
        title: s.title,
        attendees: s.attendees,
        repeats:
          s.everyWeeks === "daily"
            ? "every day"
            : `every ${s.everyWeeks === 1 ? "week" : `${s.everyWeeks} weeks`} on ${WEEKDAYS[s.idealDay]}`,
        time: s.idealTime,
        link: `/meetings?adopt=${s.key}`,
      }));
      const mine = new Set(
        [
          user.email,
          ...all<{ email: string }>(
            db,
            "SELECT email FROM accounts WHERE user_id = ?",
            user.id,
          ).map((a) => a.email),
        ].map((e) => e.toLowerCase()),
      );
      const habitTitles = new Set(
        all<{ title: string }>(db, "SELECT title FROM habits WHERE user_id = ?", user.id).map((h) =>
          h.title.toLowerCase(),
        ),
      );
      const rows = all<{
        calendar_id: string;
        event_id: string;
        recurring_id: string;
        summary: string;
        start_ms: number;
        end_ms: number;
        attendees: string;
        private_props: string;
      }>(
        db,
        `SELECT e.calendar_id, e.event_id, e.recurring_id, e.summary, e.start_ms, e.end_ms, e.attendees, e.private_props
         FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN accounts a ON a.id = c.account_id
         WHERE a.user_id = ? AND a.status = 'ok' AND c.writable = 1 AND e.recurring_id IS NOT NULL
           AND e.all_day = 0 AND e.end_ms > ? AND e.start_ms < ?
         ORDER BY e.start_ms`,
        user.id,
        t,
        t + 28 * DAY,
      );
      const series = new Map<string, typeof rows>();
      for (const r of rows) {
        if ((JSON.parse(r.private_props) as Record<string, string>).tl === "1") continue;
        const others = (JSON.parse(r.attendees) as string[]).filter(
          (a) => !mine.has(a.toLowerCase()),
        );
        if (others.length > 0 || habitTitles.has(r.summary.toLowerCase())) continue;
        const k = `${r.calendar_id}\n${r.recurring_id}`;
        series.set(k, [...(series.get(k) ?? []), r]);
      }
      const habits = [...series.values()].flatMap((list) => {
        const [first] = list;
        if (!first) return [];
        const days = [...new Set(list.map((o) => weekdayOf(utcToLocal(zone, o.start_ms).date)))]
          .sort((a, b) => a - b)
          .map((d) => WEEKDAYS[d] ?? "");
        return [
          {
            title: first.summary,
            days,
            time: hhmm(utcToLocal(zone, first.start_ms).minuteOfDay),
            minutes: Math.round((first.end_ms - first.start_ms) / 60_000),
            link: `/habits?from=${encodeURIComponent(`ext:${first.calendar_id}:${first.event_id}`)}`,
          },
        ];
      });
      return { flexible_meetings: flexible, habits };
    },
  });
}

/**
 * Team out-of-office calendars (teams-ooo-calendar.md, open question 7): the
 * absences copied to the shared calendars of the caller's own team, with the
 * person and the span only (rule 15). Another team's absences never show.
 */
function awayTool(db: Db, now: () => number): Tool {
  return tool({
    name: "list_team_time_away",
    effect: "read",
    title: "Who on the team is away",
    description:
      "Who on the user's team is away (out of office) between two dates, from the team's out-of-office calendars. Each absence has the person and the time span; all-day absences give dates.",
    input: z.object({
      start_date: z.iso.date().optional().describe("Default: today"),
      end_date: z.iso
        .date()
        .optional()
        .describe("Last day, inclusive. Default: 7 days after start"),
    }),
    output: z.object({
      from: z.string(),
      to: z.string(),
      out_of_office_calendars: z.number(),
      absences: z.array(
        z.object({
          name: z.string(),
          email: z.string(),
          start: z.string().describe("YYYY-MM-DD for all-day absences, else ISO 8601 UTC"),
          end: z.string().describe("Last day for all-day absences, else ISO 8601 UTC"),
          all_day: z.boolean(),
        }),
      ),
    }),
    run: ({ user }, a) => {
      const zone = zoneOf(db, user.id);
      const from = a.start_date ?? utcToLocal(zone, now()).date;
      const to = a.end_date ?? addDays(from, 6);
      if (to < from) throw new ToolError("end_date is before start_date");
      if (diffDays(from, to) > 62) throw new ToolError("The range is too long: at most 62 days");
      const { team } = membership(db, user.id);
      const calendars = all<{ id: string }>(
        db,
        "SELECT id FROM ooo_calendars WHERE team_id = ?",
        team.id,
      ).length;
      const seen = new Set<string>();
      const absences = all<{ name: string; email: string; written: string }>(
        db,
        `SELECT u.name, u.email, k.written FROM ooo_copies k
           JOIN ooo_calendars o ON o.id = k.ooo_id
           JOIN users u ON u.id = k.user_id
           JOIN team_members m ON m.user_id = k.user_id AND m.team_id = o.team_id
         WHERE o.team_id = ? AND k.mode <> 'skip' AND k.event_id IS NOT NULL`,
        team.id,
      )
        .flatMap((r) => {
          const [, start, end, dates] = JSON.parse(r.written) as [
            string,
            number,
            number,
            { start: string; end: string } | null,
          ];
          const item = dates
            ? { start: dates.start, end: addDays(dates.end, -1), all_day: true }
            : { start: isoOf(start), end: isoOf(end), all_day: false };
          const inRange = dates
            ? dates.start <= to && dates.end > from
            : utcToLocal(zone, start).date <= to && utcToLocal(zone, end - 1).date >= from;
          // One absence on two shared calendars is listed once.
          const key = `${r.email}|${item.start}|${item.end}`;
          if (!inRange || seen.has(key)) return [];
          seen.add(key);
          return [{ name: r.name, email: r.email, ...item }];
        })
        .sort((x, y) => x.start.localeCompare(y.start) || x.email.localeCompare(y.email));
      return { from, to, out_of_office_calendars: calendars, absences };
    },
  });
}

/** Personal stats rule 10 and the organization page: history of 12 weeks, at most 120 days. */
const HISTORY_DAYS = 84;
const MAX_SPAN_DAYS = 120;

/**
 * Organization analytics rules 9-11: the same report as the organization page,
 * for analytics admins only. Groups under the privacy guard have no values.
 */
function orgTool(db: Db, now: () => number): Tool {
  return tool({
    name: "get_org_analytics",
    effect: "read",
    title: "Organization analytics",
    description:
      "Organization analytics of the user's team for analytics admins (team admins): per group and 7-day period, meeting, focus, free and travel hours per person, the deep work score and the meeting cost. Group by the company (default), person, manager line or a directory attribute such as department. Groups under 3 people have no values. Other users get an error.",
    input: z.object({
      start_date: z.iso.date(),
      end_date: z.iso.date(),
      group_by: z
        .string()
        .max(100)
        .optional()
        .describe(
          '"" or omitted: the company; "person"; "manager"; or an attribute such as "department"',
        ),
      filters: z
        .record(z.string().max(100), z.string().max(200))
        .optional()
        .describe("Directory attribute values that each person must have"),
    }),
    output: z.object({
      from: z.string(),
      to: z.string(),
      group_by: z.string(),
      attributes: z.array(z.object({ key: z.string(), values: z.array(z.string()) })),
      groups: z.array(
        z.object({
          label: z.string(),
          people: z.number(),
          without_calendar: z.number(),
          periods: z.array(
            z.object({
              start: z.string(),
              end: z.string(),
              metrics: z.record(z.string(), z.number().nullable()).nullable(),
            }),
          ),
        }),
      ),
    }),
    run: ({ user }, a) => {
      const { team, role } = membership(db, user.id);
      if (role !== "admin")
        throw new ToolError(
          "Only analytics admins (team admins) can read organization analytics. Tell the user to ask a team admin.",
        );
      if (a.end_date < a.start_date) throw new ToolError("end_date is before start_date");
      if (diffDays(a.start_date, a.end_date) > MAX_SPAN_DAYS)
        throw new ToolError(`The range is too long: at most ${MAX_SPAN_DAYS} days`);
      const today = utcToLocal(zoneOf(db, user.id), now()).date;
      if (a.start_date < addDays(today, -HISTORY_DAYS))
        throw new ToolError("The range starts more than 12 weeks ago");
      const r = orgReport(db, team.id, {
        from: a.start_date,
        to: a.end_date,
        groupBy: a.group_by ?? "",
        filters: Object.entries(a.filters ?? {}),
      });
      return {
        from: r.from,
        to: r.to,
        group_by: r.groupBy || "company",
        attributes: r.attributes,
        groups: r.groups.map((g) => ({
          label: g.label,
          people: g.people,
          without_calendar: g.withoutCalendar,
          periods: r.periods.map((p, i) => {
            const m = g.periods[i];
            return {
              start: p.start,
              end: p.end,
              metrics: m
                ? Object.fromEntries(
                    COLUMNS.map(([name, f]) => {
                      const v = f(m);
                      return [name, v === "" ? null : Number(v)];
                    }),
                  )
                : null,
            };
          }),
        })),
      };
    },
  });
}

/** Rule 10: answers about Tempoloom come from its user documentation, the help pages. */
function helpTool(): Tool {
  return tool({
    name: "search_help",
    effect: "read",
    title: "Search the Tempoloom help",
    description:
      "Searches Tempoloom's user documentation (the help pages) for a question about how Tempoloom works. Returns the best pages with their full text and link; answer from them only.",
    input: z.object({ query: z.string().trim().min(1).max(500) }),
    output: z.object({
      pages: z.array(z.object({ title: z.string(), link: z.string(), text: z.string() })),
    }),
    run: (_caller, a) => ({
      pages: searchHelp(a.query).map((p) => ({
        title: p.title,
        link: `/help/${p.slug}`,
        text: p.text,
      })),
    }),
  });
}

/** TSK-5: a new task from the chat, staged as the request of the New task form. */
function createTaskTool(deps: ChatToolDeps): ChatTool {
  const { db, preview, now } = deps;
  return {
    tool: tool({
      name: "propose_create_task",
      effect: "stage",
      title: "Propose a new task",
      description:
        "Proposes a new task for Tempoloom to plan. Fields left out take the user's task defaults. Nothing is created until the user approves and applies it in Tempoloom.",
      input: z.object({
        title: z.string().trim().min(1).max(255),
        minutes: z
          .number()
          .int()
          .min(15)
          .max(24 * 60 * 14)
          .optional()
          .describe("Time the task needs, rounded up to 15 minutes"),
        priority: z.number().int().min(1).max(4).optional().describe("1 is highest"),
        due: z.iso.datetime({ offset: true }).optional(),
        start_after: z.iso.datetime({ offset: true }).optional().describe("Earliest start"),
        notes: z.string().max(10_000).optional(),
        next_up: z.boolean().optional().describe("Put it in the next-up queue"),
        reason: z.string().max(1000).optional(),
      }),
      output: z.object({
        id: z.string(),
        state: z.string(),
        summary: z.string(),
        message: z.string(),
      }),
      run: async ({ user, client, source }, a) => {
        const body = taskInput.safeParse({
          title: a.title,
          ...(a.minutes !== undefined ? { minutes: Math.ceil(a.minutes / 15) * 15 } : {}),
          ...(a.priority !== undefined ? { level: a.priority } : {}),
          ...(a.due ? { dueAt: toMs(a.due) } : {}),
          ...(a.start_after ? { startAfter: toMs(a.start_after) } : {}),
          ...(a.notes ? { notes: a.notes } : {}),
          ...(a.next_up !== undefined ? { nextUp: a.next_up } : {}),
        });
        if (!body.success) throw new ToolError(body.error.issues.map((i) => i.message).join("; "));
        const { dueAt, startAfter } = body.data;
        if (dueAt != null && dueAt <= (startAfter ?? now()))
          throw new ToolError("The due date must be after the start");
        const request = { method: "POST", path: "/api/tasks", body: JSON.stringify(body.data) };
        // The chunks the task would get, without saving anything (preview mode rule 2).
        const dry = await preview.dryRun(user.id, request);
        if (dry.status >= 400) {
          const b = dry.body as { message?: string; error?: string } | null;
          throw new ToolError(b?.message ?? b?.error ?? "Tempoloom refused this task");
        }
        const zone = zoneOf(db, user.id);
        const f = userFormatsOf(db, user.id);
        const parts = [
          `New task “${a.title}”`,
          ...(body.data.minutes ? [`${body.data.minutes} min`] : []),
          ...(body.data.level ? [`P${body.data.level}`] : []),
          ...(body.data.dueAt ? [`due ${whenAt(zone, body.data.dueAt, f)}`] : []),
        ];
        const s = preview.stage(user.id, {
          source: source ?? "mcp_client",
          client,
          kind: "request",
          after: request,
          impact: dry.impact,
          summary: parts.join(" · "),
          reason: a.reason ?? "",
        });
        return {
          id: s.id,
          state: s.state,
          summary: s.summary,
          message:
            "The task is proposed in preview mode. It is created only when the user approves and applies it.",
        };
      },
    }),
    ref: (data) => (typeof data.id === "string" ? { kind: "proposal", id: data.id } : undefined),
  };
}

/** The tools of this file, for chatTools. */
export function answerTools(deps: ChatToolDeps): ChatTool[] {
  const { db, now } = deps;
  return [
    ...[
      suggestionsTool(db, now),
      automationIdeasTool(db, now),
      awayTool(db, now),
      orgTool(db, now),
      helpTool(),
    ].map((t) => ({ tool: t })),
    createTaskTool(deps),
  ];
}

/** The system prompt's part for these tools (src/server/assistant/prompt.ts). */
export const ANSWERS_PROMPT = [
  "Answers:",
  "- What to work on (which task next, a short task, another choice): call get_task_suggestions and suggest from its lists, the first suggested task first. Say why a task is at risk.",
  "- Events that could become automations: call suggest_automations and name each event with what it could become and its link.",
  "- Stats (where the time went, meetings, focus): call get_stats for the dates and answer with its numbers only. For advice on more focus time, read get_stats (and list_automations), name the numbers your advice comes from, and offer to stage focus time with propose_focus_time.",
  "- Who is away: call list_team_time_away for the dates. When the team has no out-of-office calendar, say so.",
  "- Organization analytics: call get_org_analytics and answer with its numbers. When it refuses, tell the user that only analytics admins can read them.",
  "- Questions about how Tempoloom works: call search_help and answer from the pages it returns, with their links. When it finds nothing, say that the help does not cover it; do not guess.",
  "- To add a task, call propose_create_task; ask for the title when the user gives none.",
].join("\n");
