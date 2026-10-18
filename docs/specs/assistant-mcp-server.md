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
10. Each connection appears in the user's settings with client name and last
   use time. The user can revoke a connection (proposal).

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
