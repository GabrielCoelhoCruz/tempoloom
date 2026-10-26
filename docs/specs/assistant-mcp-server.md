# MCP server for AI tools

Spec id: SPEC-ASSIST-03
Evidence: E-0133 (ev_05d15af3feda), E-0022 (ev_e1d1358af158), E-0183 (ev_000dae433420), E-0148 (ev_e7b99cd896e0), E-0003 (ev_fdf25af08b9c)
Status of evidence: public docs only

## Summary

Tempoloom runs a Model Context Protocol (MCP) server. Any AI tool that
speaks MCP can connect to it, read the user's schedule, find free time,
get summaries of meetings and workload, and propose scheduling changes. The
proposed changes do not go live at once. Tempoloom holds them in preview
mode, and the user applies them. Dedicated setup for specific AI
products (ChatGPT, Claude, Cursor) belongs to the integration specs.

## Concepts and inputs

### Server

| Field | Type | Default | Notes |
|---|---|---|---|
| Server URL | URL on the instance | proposed `https://<instance>/mcp` | One URL for all clients. |
| Transport | MCP streamable HTTP | | Proposal; current MCP standard transport. |
| Authorization | OAuth 2.1 as in the MCP authorization spec | | Proposal. The reference says setup differs per client. |
| `mcp_write_enabled` | boolean | true | Instance setting (`plans-feature-inventory.md`). When false, only read tools exist. |

Tempoloom decision: the server URL is `<BASE_URL>/mcp`. The transport is
Streamable HTTP with one JSON-RPC 2.0 message per POST and a JSON response;
the server offers no server-sent stream and no sessions, so GET and DELETE
answer 405. A client signs in with OAuth 2.1 (`integrations-ai-tools.md`,
"Authorization" decision), or sends a personal API key
(`integrations-api-keys-zapier.md`) as a bearer token. `mcp_write_enabled` is
the environment variable `MCP_WRITE_ENABLED`.

### Tools (proposed set)

The evidence names use cases, not tool names. Proposed tools, each scoped
to the signed-in user:

| Tool | Kind | Input | Output |
|---|---|---|---|
| `list_events` | read | `start`, `end` | Events with title, time, attendees, free/busy, managed or external, video link |
| `get_week_summary` | read | `week_start` | Meeting hours, focus hours, task load, other commitments per day |
| `find_free_time` | read | `duration_minutes`, `attendees`, `start`, `end` | Ranked slots |
| `get_meeting_context` | read | `event_id` | Event details, past meetings with the same attendees, related tasks |
| `get_stats` | read | `range` | Numbers from `analytics-personal-stats.md` |
| `list_automations` | read | none | Automations with type, priority, enabled |
| `list_tasks` | read | filters | Tasks with priority, due date, state |
| `propose_create_event` | write (staged) | event fields | Staged change id |
| `propose_update_event` | write (staged) | `event_id`, changes | Staged change id |
| `propose_delete_event` | write (staged) | `event_id` | Staged change id |
| `propose_automation_change` | write (staged) | automation fields | Staged change id |
| `propose_rsvp` | write (staged) | `event_id`, `response` (`accepted`, `declined`, `tentative`) | Staged change id |
| `propose_log_task_time` | write (staged) | `task_id`, `start`, `minutes` | Staged change id |
| `list_staged_changes` | read | none | Pending staged changes of the user, with source and summary |
| `apply_staged_changes` | write | list of staged change ids | Result per id: applied, stale or failed |

Tempoloom decision: the server has all tools above except
`propose_automation_change`, and also `propose_focus_time`.
Times are ISO 8601 with an offset. `find_free_time` returns slots of the
given length, every 30 minutes and earliest first, inside the user's meeting
hours (work hours when there are none), where the user, and guests who use
the same instance, have no event that blocks planning; Tempoloom's own tasks,
habits and focus time do not count as busy, because the planner moves them.
`get_meeting_context` lists the meetings of the last 12 weeks that share a
guest, and open tasks that share a word of four letters or more with the
title. `propose_update_event` on an event that Tempoloom plans can change
its start only; the move locks the event, as a drag in the planner does.
A tool's input that does not match its schema gives a tool result with
`isError`, so the model can correct it.

Tempoloom decision: the tools as built. `tools/list` gives each tool an
`inputSchema`, an `outputSchema` (JSON Schema 2020-12, objects without other
keys) and annotations. Every successful result has `structuredContent` that
matches the `outputSchema` and the same JSON as text; a result that would not
match is a tool error ("The tool failed on the server"), never a result.
A stage or apply tool can fail on the server after its change was staged or
applied. Its tool error says so and tells the client to call
`list_staged_changes` (and, after `apply_staged_changes`, `list_events`)
before it tries again, so a retry does not stage the change twice.

| Tool | Annotations | Input | Output (`structuredContent`) |
|---|---|---|---|
| `list_events` | read | `start`, `end` (at most 31 days) | `time_zone`; `events`: `id`, `title`, `start`, `end`, `managed`, `kind`, `busy`, `attendees`, `location`, `organizer_self`, `video_link` |
| `find_free_time` | read | `duration_minutes` (15 to 480); optional `start` (default now), `end` (default 7 days after start), `attendees` (at most 20) | `slots` (`start`, `end`; at most 20); `unknown_attendees` |
| `get_week_summary` | read | `week_start` (`YYYY-MM-DD`) | `week_start`, `time_zone`; `days`: `date`, `meetings`, `meeting_hours`, `focus_hours`, `task_hours`, `habit_hours`, `other_hours`; `totals` of the hours |
| `get_meeting_context` | read | `event_id` | `event`; `past_meetings` (at most 10); `related_tasks` |
| `get_stats` | read | `start_date`, `end_date` (at most 120 days) | `from`, `to`; `days` (`date`, `minutes` per category); `totals`; `highlights` |
| `list_tasks` | read | optional `status` (`open` default, or `done`), `limit`, `cursor` | `tasks`: `id`, `title`, `priority`, `minutes`, `due`, `status`; `next_cursor` |
| `list_automations` | read | optional `limit`, `cursor` | `automations`: `type`, `id`, `title`, `level` (null for meeting checks), `enabled`; `next_cursor` |
| `list_staged_changes` | read | optional `limit`, `cursor` | `changes`: `id`, `source`, `summary`, `reason`, `state` (`pending` or `accepted`), `created_at`; `next_cursor` |
| `propose_create_event` | stage | `title`, `start`, `end` (at most 24 hours); optional `attendees` (at most 50), `description`, `location`, `reason` | `id`, `state`, `summary`, `review_url`, `message` |
| `propose_update_event` | stage | `event_id`; optional `start`, `end`, `title`, `reason` | as `propose_create_event` |
| `propose_delete_event` | stage | `event_id`; optional `reason` | as `propose_create_event` |
| `propose_rsvp` | stage | `event_id` of an invitation from someone else, `response` (`accepted`, `declined`, `tentative`); optional `reason` | as `propose_create_event` |
| `propose_focus_time` | stage | `duration_minutes` (15 to 480); optional `start`, `end` (the range, as `find_free_time`), `title` (default "Focus time"), `reason`. The first free slot of `find_free_time` becomes a busy event with the `#tl_focus` tag, so it counts as focus time | as `propose_create_event` |
| `propose_log_task_time` | stage | `task_id`, `start`, `minutes` (1 to 720); the session must end before now. At apply it is a locked task event on the task's calendar, as a timer log | as `propose_create_event` |
| `get_task_suggestions` | read | none | `next_up`; `suggested_now` (at most 5); `at_risk` with `why`; each task `id`, `title`, `priority`, `remaining_minutes`, `due`, `next_up` (the planner's tasks panel, `planning-next-up.md` NXT-30 to NXT-33) |
| `suggest_automations` | read | none | `flexible_meetings` (series with guests that the user organizes: `title`, `attendees`, `repeats`, `time`, `link`); `habits` (solo series: `title`, `days`, `time`, `minutes`, `link`) |
| `list_team_time_away` | read | optional `start_date` (default today; a past date counts from today), `end_date` (default 7 days after the start; at most 62 days; a range that ends before today is refused) | `from`, `to`, `out_of_office_calendars`, `note`; `absences`: `name`, `email`, `start`, `end`, `all_day` |
| `get_org_analytics` | read | `start_date`, `end_date` (as the organization page: at most 120 days, from 12 weeks ago); optional `group_by` (`company` default, `person`, `manager` or `manager_line`, or a directory attribute), `filters` | `from`, `to`, `group_by`, `attributes`, `metrics` (names), `periods`; `groups`: `label`, `people`, `without_calendar`, `values` (one row per period, null below the privacy guard) |
| `search_help` | read | `query` | `pages`: `title`, `link`, `text` of the best help pages (at most 3) |
| `propose_create_task` | stage | `title`; optional `minutes`, `priority`, `due`, `start_after`, `notes`, `next_up`, `reason`. A dry run of `POST /api/tasks` checks it and gives the chunks it would place | as `propose_create_event` |
| `apply_staged_changes` | apply | `ids` (1 to 100) | `results`: `id` and `result` `applied`, `stale` (with `reason`), `failed` (with `error`) or `refused` (with `reason`: not a pending change of an AI tool) |

Tempoloom decision: two tools return team data, `list_team_time_away` and
`get_org_analytics`. Each returns only what the caller can already see in
the web app, under the same role checks: the absences that the out-of-office
calendars of the caller's own team copied, with the person and the span only
(any member sees them in team settings and on the shared calendar;
`teams-ooo-calendar.md`), and the organization report for team admins only,
the analytics admins (`analytics-organization.md` rule 9); another caller
gets a tool error. Every other tool reads the caller's own data. A list in a
result has at most 50 rows and 12 000 characters; a `truncated` count says
how many rows were left out. Assistant chat uses the same tools
(`assistant-chat.md`).

Annotations: a read tool has `readOnlyHint` and `idempotentHint` true. A
stage tool has both false and `destructiveHint` false: it writes nothing to
the calendar. `apply_staged_changes` has `destructiveHint` true, because it
runs staged deletes. All tools have `openWorldHint` false.

`list_automations` lists flexible meetings, buffers, habits, meeting
overloads (always P4), focus time goals (always P4) and meeting checks, in
the order of the automation list (`automations-overview.md`): priority,
rank, type, age; the meeting checks, without priority, last: the built-in
checks, then the company checks, oldest first.

Pages: the three list tools return one page per call, in this order:
tasks by due date (none last), then age; automations as above; staged
changes oldest first and, at the same time, in the order they were staged:
the order of the preview panel. `limit` is 50 by default and at most 100. When more
rows exist, the result has `next_cursor`; the client passes it as `cursor`
for the next page. The cursor is the sort key of the last row, so a row
added between two calls is not repeated and does not shift the others. A
cursor works only for the same tool and the same `status`; another cursor,
or a `limit` above 100, gives a tool error. A task page seeks in an index on
the due key; tasks with the same due key before the cursor, such as many
done tasks without a due date, are still read and skipped. An automation
page reads the whole automation list of the user, which is small.

## Behavior

1. A user connects an MCP client by giving it the server URL and completing
   the authorization flow with their Tempoloom account.
2. After connection, the client can call the read tools with natural
   language requests from the user, without the user opening Tempoloom.
3. Supported use cases: meeting preparation (calendar context and past
   interactions), finding time, a summary of the week (meetings, focus time,
   workload, other commitments), and questions on how the user meets, what
   needs follow-up, how loaded they are and where their time goes.
4. Every `propose_*` tool creates a staged change in preview mode
   (`assistant-preview-mode.md`; the integration specs call it the change
   preview) with `source = mcp_client`. It never writes to the calendar
   directly.
5. The tool result tells the client that the change is staged and gives a
   link to the planner where the user can review it.
6. The user can apply staged changes in two ways: in the Tempoloom planner,
   or by confirming in the AI tool's conversation, after which the client
   calls `apply_staged_changes` with the ids the user confirmed (proposal,
   shared with `integrations-ai-tools.md` rule 3).
7. `apply_staged_changes` accepts only ids of changes staged by MCP clients
   for the same user. Changes staged by assistant chat or by automation
   edits must be applied in the planner (proposal).
8. Apply runs the validity checks of `assistant-preview-mode.md` rules 12
   and 13. Attendees are notified only at apply time.
9. When `mcp_write_enabled` is false, the server does not list the
   `propose_*` tools or `apply_staged_changes`, and calls to them fail with
   a clear error.

   Tempoloom decision: such a call gets the JSON-RPC error -32602 with a
   message that says the server gives AI tools read-only access. The Account
   page says the same.
10. Each connection appears in the user's settings with client name and last
   use time. The user can revoke a connection (proposal).

   Tempoloom decision: the Account page lists each AI tool connected with
   OAuth (client name, connected, last use) with a Revoke action, and the API
   keys with their name and last use; deleting a key disconnects a tool that
   uses it. The planner names the client or the key in each change it staged.

## Outputs

- MCP tool results (JSON content).
- Staged changes in preview mode.
- Connection list in user settings.
- Calendar events change only when the user applies staged changes.

## Edge cases

1. Expired or revoked token: the server returns an authorization error; the
   client must reconnect.
2. A write tool targets an event the user cannot edit (an external meeting
   the user does not organize): the tool returns an error, and nothing is
   staged. Exception: RSVP changes are allowed (proposal).
3. A very large range for `list_events`: proposed limit of 31 days per call;
   larger ranges return an error that states the limit.
4. Many staged changes from one client: subject to preview mode limits
   (open in that spec).
5. Delegated access: a delegate's MCP connection acts on the delegate's own
   account only (proposal).

## Observed API shapes

Not yet observed. The reference publishes one server URL for all clients;
tool names and schemas were not captured.

## Open questions

1. What tools and schemas does the reference MCP server expose?
2. How does a generic MCP client authenticate with the reference?
3. What does "read-only" mean for free-tier AI tools: read tools only, or
   also no staging?
4. Can the user see in the planner which AI tool staged a change?
5. Are there rate limits per connection?

## Acceptance tests

Common setup: Google test account U with events tomorrow: 10:00 to 11:00
"Design review" with attendee V, and 14:00 to 15:00 "Lunch and learn". An
MCP test client (for example the MCP Inspector) connected to the Tempoloom
MCP server for U.

### T1. Read tomorrow's schedule

- Setup: common setup.
- Action: the client calls `list_events` for tomorrow.
- Expected calendar state: no change on U's Google calendar.
- Reload check: the result lists both events with the same titles and times
  as Google Calendar after a refresh.

### T2. Find free time

- Setup: common setup; U's work hours 09:00 to 17:00.
- Action: the client calls `find_free_time` for 60 minutes tomorrow.
- Expected calendar state: no change.
- Reload check: every returned slot lies inside 09:00 to 17:00 and overlaps
  neither event.

### T3. Write is staged, not written

- Setup: common setup.
- Action: the client calls `propose_create_event` for "Write report"
  tomorrow 15:30 to 16:30.
- Expected calendar state: no "Write report" event on Google Calendar.
- Reload check: after U reloads the planner, preview mode shows the staged
  event with source "AI tool".

### T4. Apply in the app

- Setup: T3 done.
- Action: U applies the staged change in the planner.
- Expected calendar state: "Write report" exists tomorrow 15:30 to 16:30 on
  Google Calendar.
- Reload check: same after reload; preview mode is empty.

### T5. Read-only instance

- Setup: `mcp_write_enabled = false`.
- Action: the client lists tools, then calls `propose_create_event`.
- Expected calendar state: no change and nothing staged.
- Reload check: the tool list has no write tools; the call returns an
  error; after reload the planner has no staged change.
