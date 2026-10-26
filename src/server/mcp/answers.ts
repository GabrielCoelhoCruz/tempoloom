// Read tools and the task proposal for AI tools and assistant chat
// (docs/specs/assistant-chat.md rules 8-10; planning-tasks.md TSK-5): what to
// work on, events that could become automations, who on the team is away,
// organization analytics for analytics admins, the help pages, and a new task.
// They are MCP tools (src/server/mcp.ts), so the chat gets them through
// chatTools like every other tool. Each read uses only data the caller may see
// in the app, and each result is bounded (`bounded`); the task is staged in
// preview mode through the MCP server's `staged`.
import { z } from "zod";
import { searchHelp } from "../../shared/help-pages.ts";
import { addDays, diffDays, utcToLocal } from "../../shared/time.ts";
import { COLUMNS, orgReport, rangeProblem } from "../analytics/org.ts";
import { taskInput } from "../api/items.ts";
import { all, type Db, one } from "../db.ts";
import { ownSeries } from "../meeting-series.ts";
import { type TaskLite, tasksPanel } from "../planner/now.ts";
import { type Preview, userFormatsOf, whenAt, zoneOf } from "../preview.ts";
import { membership } from "../teams.ts";
import { isoOf, toMs } from "./reads.ts";
import { type Caller, type Tool, ToolError, tool } from "./rpc.ts";

export const stagedOutput = z.object({
  id: z.string(),
  state: z.string(),
  summary: z.string(),
  review_url: z.string(),
  message: z.string(),
});

/** Stages a change as the caller (src/server/mcp.ts). */
export type Staged = (
  caller: Caller,
  input: Omit<Parameters<Preview["stage"]>[1], "source" | "client">,
  at: number,
) => z.input<typeof stagedOutput>;

/** Rows of one list in a result, at most. */
export const MAX_ROWS = 50;
/** Characters of one result's list, at most (the JSON of its rows). */
export const MAX_CHARS = 12_000;

/** The marker of a list cut by `bounded`: how many rows were left out. */
const truncated = z
  .number()
  .describe("Rows left out to keep the result short; 0 when the list is complete");

/**
 * The first rows of a list that fit MAX_ROWS and MAX_CHARS, and how many were
 * left out. The first row always stays, so a result is never empty by the cap.
 */
export function bounded<T>(rows: T[], maxRows = MAX_ROWS, maxChars = MAX_CHARS) {
  const out: T[] = [];
  let chars = 0;
  for (const r of rows) {
    if (out.length === maxRows) break;
    const size = JSON.stringify(r).length + 1;
    if (out.length > 0 && chars + size > maxChars) break;
    chars += size;
    out.push(r);
  }
  return { rows: out, truncated: rows.length - out.length };
}

const WEEKDAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

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
      at_risk_truncated: truncated,
    }),
    run: ({ user }) => {
      const p = tasksPanel(db, user.id, now());
      const risk = bounded(p.atRisk.map((t) => ({ ...taskOf(t), why: t.why })));
      return {
        next_up: p.nextUp && taskOf(p.nextUp),
        suggested_now: p.suggestedNow.map(taskOf),
        at_risk: risk.rows,
        at_risk_truncated: risk.truncated,
      };
    },
  });
}

/**
 * Rule 8: recurring events that could become automations, from one pass over
 * the user's series (ownSeries): a series with guests can become a flexible
 * meeting (the list of the daily email, NTF-30), a solo series a habit
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
      flexible_meetings_truncated: truncated,
      habits: z.array(
        z.object({
          title: z.string(),
          days: z.array(z.string()),
          time: z.string(),
          minutes: z.number(),
          link: z.string(),
        }),
      ),
      habits_truncated: truncated,
    }),
    run: ({ user }) => {
      const series = ownSeries(db, user.id, now());
      const habitTitles = new Set(
        all<{ title: string }>(db, "SELECT title FROM habits WHERE user_id = ?", user.id).map((h) =>
          h.title.toLowerCase(),
        ),
      );
      const flexible = bounded(
        series.guests.map((s) => ({
          title: s.title,
          attendees: s.attendees,
          repeats:
            s.everyWeeks === "daily"
              ? "every day"
              : `every ${s.everyWeeks === 1 ? "week" : `${s.everyWeeks} weeks`} on ${WEEKDAYS[s.idealDay]}`,
          time: s.idealTime,
          link: `/meetings?adopt=${s.key}`,
        })),
      );
      const habits = bounded(
        series.solo
          .filter((s) => !habitTitles.has(s.title.toLowerCase()))
          .map((s) => ({
            title: s.title,
            days: s.days.map((d) => WEEKDAYS[d] ?? ""),
            time: s.idealTime,
            minutes: s.minutes,
            link: `/habits?from=${encodeURIComponent(s.eventId)}`,
          })),
      );
      return {
        flexible_meetings: flexible.rows,
        flexible_meetings_truncated: flexible.truncated,
        habits: habits.rows,
        habits_truncated: habits.truncated,
      };
    },
  });
}

/**
 * Team out-of-office calendars (teams-ooo-calendar.md, open question 7): the
 * absences copied to the shared calendars of the caller's own team, with the
 * person and the span only (rule 15). Another team's absences never show.
 * Only current and future absences are kept (src/server/ooo.ts drops a copy's
 * record when its absence ends), so a range in the past is refused.
 */
function awayTool(db: Db, now: () => number): Tool {
  return tool({
    name: "list_team_time_away",
    effect: "read",
    title: "Who on the team is away",
    description:
      "Who on the user's team is away (out of office) between two dates, from the team's out-of-office calendars. Each absence has the person and the time span; all-day absences give dates. Only absences from today on are known: past absences are not kept.",
    input: z.object({
      start_date: z.iso
        .date()
        .optional()
        .describe("Default: today. A past date counts from today."),
      end_date: z.iso
        .date()
        .optional()
        .describe("Last day, inclusive. Default: 7 days after start"),
    }),
    output: z.object({
      from: z.string(),
      to: z.string(),
      out_of_office_calendars: z.number(),
      note: z.string().nullable(),
      absences: z.array(
        z.object({
          name: z.string(),
          email: z.string(),
          start: z.string().describe("YYYY-MM-DD for all-day absences, else ISO 8601 UTC"),
          end: z.string().describe("Last day for all-day absences, else ISO 8601 UTC"),
          all_day: z.boolean(),
        }),
      ),
      truncated,
    }),
    run: ({ user }, a) => {
      const zone = zoneOf(db, user.id);
      const today = utcToLocal(zone, now()).date;
      const asked = a.start_date ?? today;
      const to = a.end_date ?? addDays(asked, 6);
      if (to < asked) throw new ToolError("end_date is before start_date");
      if (to < today)
        throw new ToolError(
          "Past absences are not kept: Tempoloom knows who is away from today on only. Tell the user it cannot say who was away then.",
        );
      const from = asked < today ? today : asked;
      if (diffDays(from, to) > 62) throw new ToolError("The range is too long: at most 62 days");
      const { team } = membership(db, user.id);
      const calendars =
        one<{ n: number }>(db, "SELECT count(*) AS n FROM ooo_calendars WHERE team_id = ?", team.id)
          ?.n ?? 0;
      const seen = new Set<string>();
      const absences = all<{ name: string; email: string; written: string }>(
        db,
        `SELECT u.name, u.email, k.written FROM ooo_copies k
           JOIN ooo_calendars o ON o.id = k.ooo_id
           JOIN users u ON u.id = k.user_id AND u.deactivated_at IS NULL
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
      const b = bounded(absences);
      return {
        from,
        to,
        out_of_office_calendars: calendars,
        note:
          asked < today ? `Past absences are not kept; the list starts today (${today}).` : null,
        absences: b.rows,
        truncated: b.truncated,
      };
    },
  });
}

/**
 * The groupings of get_org_analytics in its own words (and the CSV's), and
 * orgReport's. Another word is a directory attribute.
 */
const GROUPINGS = new Map([
  ["company", ""],
  ["person", "person"],
  ["manager", "manager"],
  ["manager_line", "manager"],
]);
const ORG_NAMES = new Map([
  ["", "company"],
  ["person", "person"],
  ["manager", "manager"],
]);

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
      'Organization analytics of the user\'s team for analytics admins (team admins): per group and 7-day period, meeting, focus, free and travel hours per person, the deep work score and the meeting cost. The metric names come once in "metrics"; each group has one row of values per period, in the order of "periods" and "metrics" (null: no value). group_by: "company" (default), "person", "manager" (manager line) or a directory attribute such as "department". Groups under 3 people have no values. Long reports are cut: narrow the dates or the filters. Other users get an error.',
    input: z.object({
      start_date: z.iso.date(),
      end_date: z.iso.date(),
      group_by: z.string().trim().max(100).optional().describe('Default: "company"'),
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
      metrics: z.array(z.string()),
      periods: z.array(z.object({ start: z.string(), end: z.string() })),
      groups: z.array(
        z.object({
          label: z.string(),
          people: z.number(),
          without_calendar: z.number(),
          values: z
            .array(z.array(z.number().nullable()).nullable())
            .describe("One row per period, one value per metric; null: below the privacy guard"),
        }),
      ),
      truncated,
    }),
    run: ({ user }, a) => {
      const { team, role } = membership(db, user.id);
      if (role !== "admin")
        throw new ToolError(
          "Only analytics admins (team admins) can read organization analytics. Tell the user to ask a team admin.",
        );
      const problem = rangeProblem(
        a.start_date,
        a.end_date,
        utcToLocal(zoneOf(db, user.id), now()).date,
      );
      if (problem)
        throw new ToolError(
          {
            invalid_range: "end_date is before start_date",
            range_too_long: "The range is too long: at most 120 days",
            range_too_early: "The range starts more than 12 weeks ago",
          }[problem],
        );
      const asked = a.group_by || "company";
      const groupBy = GROUPINGS.get(asked) ?? asked;
      const r = orgReport(db, team.id, {
        from: a.start_date,
        to: a.end_date,
        groupBy,
        filters: Object.entries(a.filters ?? {}),
      });
      const groups = bounded(
        r.groups.map((g) => ({
          label: g.label,
          people: g.people,
          without_calendar: g.withoutCalendar,
          values: g.periods.map((m) =>
            m
              ? COLUMNS.map(([, f]) => {
                  const v = f(m);
                  return v === null ? null : Math.round(v * 100) / 100;
                })
              : null,
          ),
        })),
      );
      return {
        from: r.from,
        to: r.to,
        group_by: ORG_NAMES.get(groupBy) ?? groupBy,
        attributes: r.attributes,
        metrics: COLUMNS.map(([name]) => name),
        periods: r.periods,
        groups: groups.rows,
        truncated: groups.truncated,
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

/**
 * TSK-5: a new task, staged as the request of the New task form. A dry run of
 * that request checks it (POST /api/tasks refuses a bad body) and gives the
 * chunks the task would get.
 */
function createTaskTool(db: Db, preview: Preview, staged: Staged, now: () => number): Tool {
  return tool({
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
    output: stagedOutput,
    run: async (caller, a) => {
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
      const t = body.data;
      const request = { method: "POST", path: "/api/tasks", body: JSON.stringify(t) };
      const dry = await preview.dryRun(caller.user.id, request);
      if (dry.status >= 400) {
        const b = dry.body as {
          message?: string;
          error?: string;
          issues?: { message: string }[];
        } | null;
        throw new ToolError(
          b?.issues?.[0]?.message ?? b?.message ?? b?.error ?? "Tempoloom refused this task",
        );
      }
      const zone = zoneOf(db, caller.user.id);
      const f = userFormatsOf(db, caller.user.id);
      return staged(
        caller,
        {
          kind: "request",
          after: request,
          impact: dry.impact,
          summary: [
            `New task “${t.title}”`,
            ...(t.minutes ? [`${t.minutes} min`] : []),
            ...(t.level ? [`P${t.level}`] : []),
            ...(t.dueAt ? [`due ${whenAt(zone, t.dueAt, f)}`] : []),
          ].join(" · "),
          reason: a.reason ?? "",
        },
        t.startAfter ?? dry.impact[0]?.start ?? now(),
      );
    },
  });
}

/** The tools of this file, for mcpTools. */
export function answerTools(
  deps: { db: Db; preview: Preview; now: () => number },
  staged: Staged,
): Tool[] {
  const { db, now } = deps;
  return [
    suggestionsTool(db, now),
    automationIdeasTool(db, now),
    awayTool(db, now),
    orgTool(db, now),
    helpTool(),
    createTaskTool(db, deps.preview, staged, now),
  ];
}
