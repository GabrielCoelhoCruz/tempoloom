// Chat tools that the library's prompt entries need (automations-library.md
// rule 7, entries 17 and 24): the team stats as the team stats page shows them,
// and a new priority for a task, staged in preview mode like every other change
// of the chat (assistant-chat.md rule 12).
import { z } from "zod";
import { addDays, diffDays, type LocalDate, utcToLocal } from "../../shared/time.ts";
import { HISTORY_DAYS, MAX_SPAN_DAYS, teamStatsOf } from "../api/analytics.ts";
import { one } from "../db.ts";
import { ToolError, tool } from "../mcp/rpc.ts";
import { reviewUrl } from "../mcp.ts";
import { zoneOf } from "../preview.ts";
import type { ChatTool, ChatToolDeps } from "./tools.ts";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const weekday = (n: number | null) => (n === null ? null : (WEEKDAYS[n - 1] ?? null));
const round = (n: number) => Math.round(n);

export function libraryTools({ db, preview, baseUrl, now }: ChatToolDeps): ChatTool[] {
  const teamStats: ChatTool = {
    tool: tool({
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
        const from = a.start_date as LocalDate;
        const to = a.end_date as LocalDate;
        if (to < from) throw new ToolError("end_date is before start_date");
        if (diffDays(from, to) > MAX_SPAN_DAYS)
          throw new ToolError(`The range is too long: at most ${MAX_SPAN_DAYS} days`);
        const today = utcToLocal(zoneOf(db, user.id), now()).date;
        if (from < addDays(today, -HISTORY_DAYS))
          throw new ToolError(`Team stats start at most ${HISTORY_DAYS} days before today`);
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
    }),
  };

  const taskPriority: ChatTool = {
    tool: tool({
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
      output: z.object({
        id: z.string(),
        state: z.string(),
        summary: z.string(),
        review_url: z.string(),
        message: z.string(),
      }),
      run: async ({ user, source, client }, a) => {
        const task = one<{
          title: string;
          level: number;
          status: string;
          rules_changed_at: number;
        }>(
          db,
          "SELECT title, level, status, rules_changed_at FROM tasks WHERE id = ? AND user_id = ?",
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
        if (dry.status >= 400) throw new ToolError("Tempoloom cannot make this change");
        const s = preview.stage(user.id, {
          source: source ?? "mcp_client",
          client,
          kind: "request",
          target: `tasks:${a.task_id}`,
          // Apply skips the change when the task changed after it was staged.
          before: { table: "tasks", id: a.task_id, rulesChangedAt: task.rules_changed_at },
          after: request,
          impact: dry.impact,
          summary: `Priority of task “${task.title}”: P${task.level} to P${a.priority}`,
          reason: a.reason ?? "",
        });
        return {
          id: s.id,
          state: s.state,
          summary: s.summary,
          review_url: reviewUrl(baseUrl, zoneOf(db, user.id), now()),
          message:
            "The change is staged in Tempoloom's preview mode. Nothing changes until the user applies it.",
        };
      },
    }),
    ref: (data) => (typeof data.id === "string" ? { kind: "proposal", id: data.id } : undefined),
  };

  return [teamStats, taskPriority];
}
