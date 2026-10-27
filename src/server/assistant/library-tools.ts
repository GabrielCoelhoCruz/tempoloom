// Chat tools that the library's prompt entries need (automations-library.md
// rule 7, entries 17 and 24): the team stats as the team stats page shows them,
// and a new priority for a task, staged in preview mode like every other change
// of the chat (assistant-chat.md rule 12).
import { z } from "zod";
import { utcToLocal } from "../../shared/time.ts";
import { type RangeProblem, rangeProblem, teamStatsOf } from "../api/analytics.ts";
import { one } from "../db.ts";
import { type Tool, ToolError, tool } from "../mcp/rpc.ts";
import { stagedOutput, stagedResult } from "../mcp/staged.ts";
import { zoneOf } from "../preview.ts";
import { taskLevelBefore } from "../preview-kinds.ts";
import type { ChatToolDeps } from "./tools.ts";

/** The tool's words for the range errors of the team stats page. */
const RANGE_WORDS: Record<RangeProblem, string> = {
  invalid_range: "end_date is before start_date",
  range_too_long: "The range is longer than the team stats page allows; ask for a shorter range",
  range_too_early:
    "The range starts earlier than the team stats page allows; ask for a later start",
};

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const weekday = (n: number | null) => (n === null ? null : (WEEKDAYS[n - 1] ?? null));
const round = (n: number) => Math.round(n);

/**
 * Stage tools here go through the chat's ref mapping in chatTools
 * (src/server/assistant/tools.ts), as the MCP stage tools do.
 */
export function libraryTools(deps: ChatToolDeps): Tool[] {
  const { db, preview, now } = deps;
  const teamStats = tool({
    name: "get_team_stats",
    effect: "read",
    title: "Team stats",
    description:
      "The user's team stats between two dates, as the team stats page shows them: each figure is the mean over the team members with a calendar, in minutes per 7-day period of the range (meetings, one-on-ones, team and external meetings, meetings outside work hours, deep and shallow work, breaks, focus time held). No member's own values and no names. Teams with fewer than 3 members with a calendar get no values.",
    input: z.object({ start_date: z.iso.date(), end_date: z.iso.date() }),
    output: z.object({
      enough: z.boolean().describe("False: fewer than 3 members with a calendar, so no values"),
      members_included: z.number(),
      members_without_calendar: z.number(),
      minutes_per_week: z.record(z.string(), z.number()).nullable(),
      heaviest_meeting_day: z.string().nullable(),
      lightest_meeting_day: z.string().nullable(),
      most_productive_day: z.string().nullable(),
      meeting_hours_per_week: z
        .object({ at_least_hours: z.array(z.number()), percent_of_members: z.array(z.number()) })
        .nullable(),
    }),
    run: ({ user }, a) => {
      const from = a.start_date;
      const to = a.end_date;
      const problem = rangeProblem(from, to, utcToLocal(zoneOf(db, user.id), now()).date);
      if (problem) throw new ToolError(RANGE_WORDS[problem]);
      const s = teamStatsOf(db, user.id, { from, to }, "week");
      const head = {
        enough: s.enough,
        members_included: s.included,
        members_without_calendar: s.withoutCalendar,
      };
      if (!s.enough)
        return {
          ...head,
          minutes_per_week: null,
          heaviest_meeting_day: null,
          lightest_meeting_day: null,
          most_productive_day: null,
          meeting_hours_per_week: null,
        };
      return {
        ...head,
        minutes_per_week: Object.fromEntries(
          Object.entries(s.averages).map(([k, v]) => [k, round(v)]),
        ),
        heaviest_meeting_day: weekday(s.meetingDays.heaviest),
        lightest_meeting_day: weekday(s.meetingDays.lightest),
        most_productive_day: weekday(s.focusDays.mostProductive),
        meeting_hours_per_week: {
          at_least_hours: s.distribution.thresholds,
          percent_of_members: s.distribution.percent,
        },
      };
    },
  });

  const taskPriority = tool({
    name: "propose_task_priority",
    effect: "stage",
    title: "Propose a new task priority",
    description:
      "Stages a new priority for one of the user's open tasks (an id from list_tasks); 1 is the highest. Tempoloom plans the task again after the user approves and applies it. Nothing changes until then.",
    input: z.object({
      task_id: z.string().min(1),
      priority: z.number().int().min(1).max(4),
      reason: z.string().max(1000).optional().describe("Why, in one sentence, shown to the user"),
    }),
    output: stagedOutput,
    run: async (caller, a) => {
      const { user } = caller;
      const task = one<{ title: string; level: number; status: string }>(
        db,
        "SELECT title, level, status FROM tasks WHERE id = ? AND user_id = ?",
        a.task_id,
        user.id,
      );
      if (!task) throw new ToolError(`No task ${a.task_id}`);
      if (task.status !== "open") throw new ToolError("The task is done");
      if (task.level === a.priority) throw new ToolError(`The task already has P${a.priority}`);
      const request = {
        method: "PATCH",
        path: `/api/tasks/${a.task_id}`,
        body: JSON.stringify({ level: a.priority }),
      };
      // The plan changes the new priority causes, as preview mode shows for automations.
      const dry = await preview.dryRun(user.id, request);
      if (dry.status >= 400) {
        const b = dry.body as { issues?: { message: string }[]; message?: string; error?: string };
        throw new ToolError(
          `Tempoloom cannot make this change: ${b?.issues?.[0]?.message ?? b?.message ?? b?.error ?? `HTTP ${dry.status}`}`,
        );
      }
      return stagedResult(
        deps,
        caller,
        {
          kind: "request",
          target: `tasks:${a.task_id}`,
          // Apply skips the change only when this task's priority or state changed
          // after it was staged (src/server/preview.ts).
          before: taskLevelBefore({ id: a.task_id, ...task }),
          after: request,
          impact: dry.impact,
          // The title is quoted as JSON, so it cannot change the words around it.
          summary: `New priority P${task.level} to P${a.priority} for task ${JSON.stringify(task.title)}`,
          reason: a.reason ?? "",
        },
        now(),
      );
    },
  });

  return [teamStats, taskPriority];
}
