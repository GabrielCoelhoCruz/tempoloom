// Assistant chat tools for automations, team policies and the schedule review
// (docs/specs/assistant-chat.md rules 6-7, 15-20; automations-overview.md
// rules 1, 5; teams-policies.md). Automation and policy changes stage the same
// API call that their forms send, as preview mode does for a form save
// (src/server/preview.ts guard): apply runs the call again as the user, so the
// API checks it twice, at staging (dry run) and at apply. The review reads the
// meeting check issues and the planner's recommendations of the dates shown;
// the model then stages one fix per issue with the propose tools.
import { z } from "zod";
import { hasVideoLink } from "../../shared/meeting-checks.ts";
import { addDays, localToUtc } from "../../shared/time.ts";
import type { User } from "../accounts.ts";
import { recommendations } from "../api/meeting-checks.ts";
import { all, type Db, one } from "../db.ts";
import { cached, isoOf } from "../mcp/reads.ts";
import { type Caller, type Tool, ToolError, tool } from "../mcp/rpc.ts";
import { openIssues } from "../meeting-checks.ts";
import { POLICY_TYPES } from "../policies/model.ts";
import { type Preview, type ReplayedRequest, userFormatsOf, when, zoneOf } from "../preview.ts";
import { membership } from "../teams.ts";

/** Automation types the chat can stage, with their API and table (automations-overview.md). */
const AUTOMATIONS = {
  habit: { path: "/api/habits", table: "habits", noun: "habit", edit: "PATCH" },
  focus_time: { path: "/api/focus", table: "focus_goals", noun: "focus goal", edit: "PATCH" },
  buffer: { path: "/api/buffers", table: "buffers", noun: "buffer", edit: "PATCH" },
  meeting_overload: {
    path: "/api/meeting-overloads",
    table: "meeting_overloads",
    noun: "meeting overload",
    edit: "PATCH",
  },
  flexible_meeting: {
    path: "/api/meetings",
    table: "meetings",
    noun: "flexible meeting",
    edit: "PUT",
  },
} as const;
type AutomationKind = keyof typeof AUTOMATIONS;

/** The plural of the preview guard's targets, so a later form save replaces a chat proposal. */
const TARGET_PREFIX: Record<AutomationKind, string> = {
  habit: "habits",
  focus_time: "focus",
  buffer: "buffers",
  meeting_overload: "meeting-overloads",
  flexible_meeting: "meetings",
};

const stagedOutput = z.object({
  id: z.string(),
  state: z.string(),
  summary: z.string(),
  calendar_impact: z.array(
    z.object({ op: z.string(), title: z.string(), start: z.string(), end: z.string() }),
  ),
  message: z.string(),
});

const STAGED =
  "Staged in preview mode. Nothing changes until the user approves and applies it in the planner.";

const date = z.iso.date();

/** The message of a failed API call: the first field error, else the error text. */
function apiError(body: unknown, status: number): string {
  const b = body as {
    message?: string;
    error?: string;
    issues?: { path?: string | (string | number)[]; message: string }[];
  } | null;
  const issue = b?.issues?.[0];
  if (issue) {
    const path = Array.isArray(issue.path) ? issue.path.join(".") : issue.path;
    return path ? `${path}: ${issue.message}` : issue.message;
  }
  return b?.message ?? b?.error ?? `HTTP ${status}`;
}

export interface ReviewToolDeps {
  db: Db;
  preview: Preview;
  now: () => number;
}

export function reviewTools(deps: ReviewToolDeps): Tool[] {
  const { db, preview, now } = deps;

  /**
   * Dry-runs the API call as the user (nothing is saved) and stages it with
   * the calendar impact. A call the API refuses is a tool error with the API's
   * message, so the model can correct it.
   */
  async function stageRequest(
    caller: Caller,
    request: ReplayedRequest,
    s: { target: string | null; before: unknown; summary: string; reason: string },
  ) {
    const dry = await preview.dryRun(caller.user.id, request);
    if (dry.status >= 400) throw new ToolError(apiError(dry.body, dry.status));
    const staged = preview.stage(caller.user.id, {
      source: caller.source ?? "mcp_client",
      client: caller.client,
      kind: "request",
      target: s.target,
      before: s.before,
      after: request,
      impact: dry.impact,
      summary: s.summary,
      reason: s.reason,
    });
    return {
      id: staged.id,
      state: staged.state,
      summary: staged.summary,
      calendar_impact: dry.impact.map((i) => ({
        op: i.op,
        title: i.title,
        start: isoOf(i.start),
        end: isoOf(i.end),
      })),
      message: STAGED,
    };
  }

  function isAdmin(user: User): boolean {
    try {
      return membership(db, user.id).role === "admin";
    } catch {
      return false;
    }
  }

  const automation = tool({
    name: "propose_automation",
    effect: "stage",
    title: "Propose an automation change",
    description: [
      "Stages a new automation, a change to one, or turns one off or on (ids and types from list_automations). It stages the same request as the automation's form; nothing changes until the user approves and applies it. The result lists the planned events it would add, move or remove.",
      "settings holds the form fields for create and edit (edit: only the fields to change). Times are HH:MM, lengths in minutes, weekdays 1 (Monday) to 7 (Sunday), level 1 (highest) to 4.",
      'habit: title, idealTime, minMinutes, maxMinutes, frequency ({"period":"daily"} or {"period":"weekly","days":[1,3]}), level, defense ("adaptive", "always-free", "always-busy").',
      "focus_time: title, weeklyGoalMinutes (multiple of 15), minBlockMinutes, maxBlockMinutes, dailyMaxMinutes, busy.",
      'buffer: title, side ("before", "after", "both"), minutesBefore, minutesAfter, filter ({"videoLink":true} and others).',
      "meeting_overload: title, dailyMaxMinutes, weeklyMaxMinutes (multiples of 30).",
      'flexible_meeting: title, durationMinutes, attendees ([{"email":"a@b.c","required":true}]), frequency, idealTime and the other meeting form fields.',
      'meeting_check (no id, action edit): checks ({conflict, attendee_availability, rsvp_reminder, video_link, agenda}: true or false), digest ("email" or "off"), digestTime.',
    ].join("\n"),
    input: z.object({
      action: z.enum(["create", "edit", "turn_off", "turn_on"]),
      type: z.enum([
        "habit",
        "focus_time",
        "buffer",
        "meeting_overload",
        "flexible_meeting",
        "meeting_check",
      ]),
      id: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("The automation id, for every action but create"),
      settings: z.record(z.string(), z.unknown()).optional(),
      reason: z.string().max(1000).optional().describe("Why, in one sentence, shown to the user"),
    }),
    output: stagedOutput,
    run: async (caller, a) => {
      const reason = a.reason ?? "";
      const settings = a.settings ?? {};
      if (a.type === "meeting_check") {
        if (a.action !== "edit")
          throw new ToolError("Meeting checks have no id: use action edit with settings.checks");
        if (Object.keys(settings).length === 0) throw new ToolError("Give the settings to change");
        const changed = Object.entries((settings.checks ?? {}) as Record<string, unknown>)
          .map(([k, v]) => `${k} ${v ? "on" : "off"}`)
          .join(", ");
        return stageRequest(
          caller,
          { method: "PATCH", path: "/api/meeting-prefs", body: JSON.stringify(settings) },
          {
            target: "meeting-prefs",
            before: null,
            summary: `Edit meeting checks${changed ? ` (${changed})` : ""}`,
            reason,
          },
        );
      }
      const kind = AUTOMATIONS[a.type];
      if (a.action === "create") {
        const title = typeof settings.title === "string" ? settings.title : kind.noun;
        return stageRequest(
          caller,
          { method: "POST", path: kind.path, body: JSON.stringify(settings) },
          { target: null, before: null, summary: `New ${kind.noun} “${title}”`, reason },
        );
      }
      if (!a.id) throw new ToolError("id is required: take it from list_automations");
      const cur = one<{ title: string; enabled: number; rules_changed_at: number }>(
        db,
        `SELECT title, enabled, rules_changed_at FROM ${kind.table} WHERE id = ? AND user_id = ?`,
        a.id,
        caller.user.id,
      );
      if (!cur) throw new ToolError(`You have no ${kind.noun} ${a.id}; call list_automations`);
      const target = `${TARGET_PREFIX[a.type]}:${a.id}`;
      // Apply skips the change when the automation changed after staging.
      const before = { table: kind.table, id: a.id, rulesChangedAt: cur.rules_changed_at };
      if (a.action === "edit") {
        if (Object.keys(settings).length === 0) throw new ToolError("Give the settings to change");
        return stageRequest(
          caller,
          { method: kind.edit, path: `${kind.path}/${a.id}`, body: JSON.stringify(settings) },
          { target, before, summary: `Edit ${kind.noun} “${cur.title}”`, reason },
        );
      }
      const on = a.action === "turn_on";
      const request: ReplayedRequest =
        a.type === "flexible_meeting"
          ? {
              method: "POST",
              path: `${kind.path}/${a.id}/enabled`,
              body: JSON.stringify({ enabled: on }),
            }
          : {
              method: kind.edit,
              path: `${kind.path}/${a.id}`,
              body: JSON.stringify({ enabled: on }),
            };
      return stageRequest(caller, request, {
        target,
        before,
        summary: `Turn ${on ? "on" : "off"} ${kind.noun} “${cur.title}”`,
        reason,
      });
    },
  });

  const policies = tool({
    name: "list_team_policies",
    effect: "read",
    title: "List team policies",
    description:
      "The scheduling policies of the user's team (team admins only): id, type, name, scope, goal and whether each is on.",
    input: z.object({}),
    output: z.object({
      policies: z.array(
        z.object({
          id: z.string(),
          type: z.string(),
          name: z.string(),
          enabled: z.boolean(),
          scope: z.array(z.object({ attribute: z.string(), value: z.string() })),
          goal: z.record(z.string(), z.unknown()),
        }),
      ),
    }),
    run: ({ user }) => {
      if (!isAdmin(user)) throw new ToolError("Only a team admin can read the team policies");
      const { team } = membership(db, user.id);
      return {
        policies: all<{
          id: string;
          type: string;
          name: string;
          enabled: number;
          scope: string;
          goal: string;
        }>(
          db,
          "SELECT id, type, name, enabled, scope, goal FROM team_policies WHERE team_id = ? ORDER BY created_at, id",
          team.id,
        ).map((p) => ({
          id: p.id,
          type: p.type,
          name: p.name,
          enabled: p.enabled === 1,
          scope: JSON.parse(p.scope) as { attribute: string; value: string }[],
          goal: JSON.parse(p.goal) as Record<string, unknown>,
        })),
      };
    },
  });

  const policy = tool({
    name: "propose_team_policy",
    effect: "stage",
    title: "Propose a team policy change",
    description: [
      "Team admins only. Stages a new team scheduling policy, a change to one, or its removal, with the same request as the policy form. Nothing changes for the team until the user approves and applies it.",
      "Goals by type: focus_time {weeklyGoalMinutes (60 to 2400, multiple of 30)}; buffers {minDailyBreakMinutes, prepBefore, followUpAfter, recoveryAfter: [{category one_on_one|team_meeting|external_meeting, minutes}]}; meeting_agendas {meetingTypes, strictness remind|adjust|auto_decline, leadMinutes}; fragmentation {targetReductionPercent, minUsableBlockMinutes, memberFlexibility low|medium|high}.",
      "scope: directory attribute rules [{attribute, value}]; empty means the whole team. enabled: true starts the policy.",
    ].join("\n"),
    input: z.object({
      action: z.enum(["create", "edit", "delete"]),
      id: z.string().min(1).max(200).optional().describe("The policy id, for edit and delete"),
      type: z.enum(POLICY_TYPES).optional().describe("For create"),
      name: z.string().trim().min(1).max(100).optional(),
      scope: z
        .array(z.object({ attribute: z.string(), value: z.string() }))
        .max(10)
        .optional(),
      goal: z.record(z.string(), z.unknown()).optional(),
      enabled: z.boolean().optional(),
      reason: z.string().max(1000).optional(),
    }),
    output: stagedOutput,
    run: async (caller, a) => {
      if (!isAdmin(caller.user))
        throw new ToolError(
          "Only a team admin can change team policies. Tell the user to ask a team admin.",
        );
      const reason = a.reason ?? "";
      const fields = {
        ...(a.name !== undefined ? { name: a.name } : {}),
        ...(a.scope !== undefined ? { scope: a.scope } : {}),
        ...(a.goal !== undefined ? { goal: a.goal } : {}),
        ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
      };
      if (a.action === "create") {
        if (!a.type) throw new ToolError("type is required to create a policy");
        if (!a.name) throw new ToolError("name is required to create a policy");
        return stageRequest(
          caller,
          {
            method: "POST",
            path: "/api/policies",
            body: JSON.stringify({ type: a.type, ...fields }),
          },
          {
            target: null,
            before: null,
            summary: `New team policy “${a.name}”${a.enabled ? " (on)" : ""}`,
            reason,
          },
        );
      }
      if (!a.id) throw new ToolError("id is required: take it from list_team_policies");
      const { team } = membership(db, caller.user.id);
      const cur = one<{ name: string }>(
        db,
        "SELECT name FROM team_policies WHERE id = ? AND team_id = ?",
        a.id,
        team.id,
      );
      if (!cur) throw new ToolError(`Your team has no policy ${a.id}; call list_team_policies`);
      if (a.action === "delete")
        return stageRequest(
          caller,
          { method: "DELETE", path: `/api/policies/${a.id}`, body: "" },
          {
            target: `policies:${a.id}`,
            before: null,
            summary: `Remove team policy “${cur.name}”`,
            reason,
          },
        );
      if (Object.keys(fields).length === 0) throw new ToolError("Give the fields to change");
      const switched = a.enabled === undefined ? "" : a.enabled ? " (turn on)" : " (turn off)";
      return stageRequest(
        caller,
        { method: "PATCH", path: `/api/policies/${a.id}`, body: JSON.stringify(fields) },
        {
          target: `policies:${a.id}`,
          before: null,
          summary: `Edit team policy “${cur.name}”${switched}`,
          reason,
        },
      );
    },
  });

  const review = tool({
    name: "review_schedule",
    effect: "read",
    title: "Review the schedule",
    description:
      "The open meeting check issues (conflicts, unanswered invitations, meetings without a video link, guests who are not free or declined, meetings without an agenda) of the events that start between from and to_exclusive, and the planner's recommendations (skipped habits, focus goals not met, tasks without time, days with too many meetings). Use the dates shown in the planner unless the user names others. Each issue has the event_id for the propose tools.",
    input: z.object({
      from: date.describe("First day, YYYY-MM-DD"),
      to_exclusive: date.describe("The day after the last day, YYYY-MM-DD; at most 31 days"),
    }),
    output: z.object({
      time_zone: z.string(),
      issues: z.array(
        z.object({
          check: z.string(),
          event_id: z.string(),
          title: z.string(),
          start: z.string(),
          end: z.string(),
          message: z.string(),
          organizer_self: z.boolean(),
          attendees: z.array(z.string()),
        }),
      ),
      recommendations: z.array(
        z.object({ kind: z.string(), date: z.string().nullable(), text: z.string() }),
      ),
    }),
    run: ({ user }, a) => {
      const zone = zoneOf(db, user.id);
      if (a.to_exclusive <= a.from) throw new ToolError("to_exclusive must be after from");
      if (a.to_exclusive > addDays(a.from, 31))
        throw new ToolError("The range is too long: at most 31 days per call");
      const from = localToUtc(zone, a.from, 0);
      const to = localToUtc(zone, a.to_exclusive, 0);
      const t = now();
      // Issues are of events still to come (automations-meeting-quality.md).
      const issues = to <= t ? [] : openIssues(db, user.id, Math.max(t, from), to);
      return {
        time_zone: zone,
        issues: issues.map((i) => {
          const ev = cached(db, user.id, `ext:${i.eventKey}`);
          return {
            check: i.checkId === "company" ? `company: ${i.company?.name ?? ""}` : i.checkId,
            event_id: `ext:${i.eventKey}`,
            title: i.title,
            start: isoOf(i.start),
            end: isoOf(i.end),
            message: i.message,
            organizer_self: ev?.organizer_self === 1,
            attendees: ev ? (JSON.parse(ev.attendees) as string[]) : [],
          };
        }),
        recommendations: recommendations(db, user.id, t).filter(
          (r) => r.date === null || (r.date >= a.from && r.date < a.to_exclusive),
        ),
      };
    },
  });

  const video = tool({
    name: "propose_video_link",
    effect: "stage",
    title: "Propose a video link for a meeting",
    description:
      "Stages adding a video link to the description of a meeting the user organizes (an event_id from list_events or review_schedule). Use a link the user gave you or one from the user's memories; never invent one. Nothing changes until the user approves and applies it.",
    input: z.object({
      event_id: z.string().min(1),
      link: z.url({ protocol: /^https$/ }).max(2000),
      reason: z.string().max(1000).optional(),
    }),
    output: z.object({
      id: z.string(),
      state: z.string(),
      summary: z.string(),
      message: z.string(),
    }),
    run: (caller, a) => {
      const ev = cached(db, caller.user.id, a.event_id);
      if (!ev) throw new ToolError(`No event ${a.event_id} on your calendars`);
      if ((JSON.parse(ev.private_props) as Record<string, string>).tl === "1")
        throw new ToolError("Tempoloom plans this event; it needs no video link");
      if (!ev.writable) throw new ToolError("This calendar is read-only");
      if (!ev.organizer_self)
        throw new ToolError("You do not organize this meeting; ask its organizer for a link");
      if (!hasVideoLink(a.link)) throw new ToolError("This is not a link of a known video service");
      const zone = zoneOf(db, caller.user.id);
      const description = ev.description.trim() ? `${ev.description.trim()}\n\n${a.link}` : a.link;
      const s = preview.stage(caller.user.id, {
        source: caller.source ?? "mcp_client",
        client: caller.client,
        kind: "event_update",
        target: a.event_id,
        before: { title: ev.summary, start: ev.start_ms, end: ev.end_ms },
        after: { start: ev.start_ms, end: ev.end_ms, description },
        impact: [],
        summary: `Add a video link to “${ev.summary}” · ${when(zone, ev.start_ms, ev.end_ms, userFormatsOf(db, caller.user.id))}`,
        reason: a.reason ?? "",
      });
      return { id: s.id, state: s.state, summary: s.summary, message: STAGED };
    },
  });

  return [automation, policies, policy, review, video];
}

/** The system prompt part of these tools (src/server/assistant/prompt.ts). */
export const REVIEW_RULES = [
  "Automations, policies and reviews:",
  "- To create, change, turn off or turn on an automation (habits, focus time, buffers, meeting overloads, flexible meetings, meeting checks), call list_automations for ids, then propose_automation. When the tool returns an error about a field, correct the field and call it again.",
  "- Team scheduling policies: only team admins can change them; call list_team_policies, then propose_team_policy. When the user is not an admin, say so.",
  "- When the user asks about problems or issues in the schedule, or asks for Recommendations, call review_schedule with the dates shown in the planner (planner_dates), unless the user names other dates. Then stage one fix for each issue you can fix: a conflict -> propose_update_event to move the user's own meeting to free time (find_free_time); an unanswered invitation -> propose_rsvp; a guest who is not free -> find_free_time with the guests, then propose_update_event; no video link -> propose_video_link only with a link from the user or the memories, else ask for one. Name the issues you cannot fix. Then list the issues and the staged fixes briefly.",
  "- To move a group of meetings (all meetings of a morning, a day or a week), call list_events for the dates, then propose_update_event once for each meeting the user organizes, keeping each length, at free times. For invitations from other people, offer propose_rsvp instead.",
].join("\n");
