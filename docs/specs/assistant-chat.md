# Assistant chat

Spec id: SPEC-ASSIST-01
Evidence: E-0158 (ev_5682619fc975), E-0022 (ev_e1d1358af158), E-0183 (ev_000dae433420), E-0148 (ev_e7b99cd896e0), E-0043 (ev_d7b30359b03e), E-0023 (ev_dfeca2f754da), E-0012 (ev_a025d5e005ce), E-0003 (ev_fdf25af08b9c)
Status of evidence: public docs only

## Summary

Assistant chat is a chat panel in the planner. The user writes requests in
plain language: schedule something, find time with colleagues, fix
conflicts, review the week, change automations, or explain how Tempoloom
works. The assistant never changes the calendar on its own. It stages each
proposed change in preview mode, and the user approves what goes live.
Each night it reviews the coming days for problems and offers fixes in a
morning digest. It can remember the user's stated preferences.

## Concepts and inputs

### Chat message

| Field | Type | Notes |
|---|---|---|
| `text` | text | Free text. No command syntax needed. |
| `context` | planner state | The dates shown in the planner and the selected event, if any (proposal). |

### Proposed change (output of the assistant)

| Field | Type | Notes |
|---|---|---|
| `kind` | enum `create_event`, `move_event`, `resize_event`, `delete_event`, `rsvp`, `create_automation`, `edit_automation`, `disable_automation`, `edit_task` | Proposal for the full list. |
| `target` | event, automation or task id | Empty for create. |
| `after` | the new values | |
| `reason` | text | Short reason shown to the user. |

All proposed changes go to preview mode (`assistant-preview-mode.md`).

### Chat memory

| Field | Type | Default | Notes |
|---|---|---|---|
| `text` | text | | The preference in the user's words. |
| `people` | list of person refs | empty | Names or emails found in the text. |
| `created_at` | timestamp | now | |

### Settings

| Field | Type | Default | Notes |
|---|---|---|---|
| `assistant_chat_enabled` (team) | boolean | see `teams-settings-templates.md` | Team-wide. |
| `digest_channel`, `digest_time` (user) | as in `automations-meeting-quality.md` | `email`, 08:00 (proposals there) | Morning digest delivery. |

## Behavior

### Access

1. Assistant chat lives in a panel in the planner.

   Tempoloom decision: the operator connects any OpenAI-compatible chat
   completions endpoint with `TEMPOLOOM_LLM_BASE_URL`, `TEMPOLOOM_LLM_API_KEY`
   (optional) and `TEMPOLOOM_LLM_MODEL`. Without a base URL the panel says the
   assistant is not configured, and the server sends nothing. The chat uses the
   read and propose tools of the MCP server (`assistant-mcp-server.md`); it has
   no apply tool.
2. When the team switch is off, the panel shows the disabled notice
   described in `teams-settings-templates.md` rule 14, and sends nothing.

### Requests the assistant handles

3. Read the calendar and answer questions about it ("what is on
   Thursday").
4. Create, move, resize or delete events, and answer invitations.
5. Find a time with one or more colleagues. The assistant uses each
   colleague's free/busy and, for Tempoloom users, their meeting hours. It
   proposes the best slot and creates the event with them as attendees only
   after approval.
6. Detect and fix conflicts. Rearrange a day or move a group of meetings
   (for example all Monday morning meetings to Tuesday).
7. Create, edit or disable automations (focus time, habits, buffers,
   flexible meetings, meeting checks), with the same settings as the
   automation forms (`automations-library.md`, automation specs).
8. Suggest which tasks to work on today, and which existing events could
   become automations.
9. Answer questions about the user's stats (`analytics-personal-stats.md`)
   and, for analytics admins, organization analytics.
10. Answer questions about how Tempoloom works, using the Tempoloom user
    documentation as its source.
11. The user can give more detail, ask a second question, and ask for a
    different approach. The assistant keeps the conversation context.

### Approval

12. The assistant never writes to a calendar, an automation or a task
    without approval. Every change it proposes appears in preview mode.
13. For each proposed change the user can accept it, discard only that
    change, or reply in chat to request a different change.
14. Apply, final review and attendee notification follow
    `assistant-preview-mode.md`.

### Daily review and digest

15. Each night (proposed: 02:00 in the user's home time zone) the system
    reviews the user's upcoming schedule: the remaining days of this week and
    the start of the next week (proposed: the next 2 workdays of the next
    week).
16. The review collects the open issues of the meeting checks
    (`automations-meeting-quality.md`): conflicting events, invitations the
    user has not answered, meetings that have no video link, and
    attendees who are not available for meetings the user organized. For
    each issue, assistant chat prepares a proposed fix.
17. In the morning the system sends one digest of the findings at
    `digest_time` through `digest_channel` (email, chat app, or both). This
    is the same digest as in `automations-meeting-quality.md` rule 6; there
    is only one daily digest.
18. Opening the digest opens assistant chat with the recommended fixes
    already staged for review.
19. A "Recommendations" action in the chat panel runs the same review at
    any time.
20. To review another week, the user moves the planner to that week and
    runs Recommendations. The review then covers the dates shown in the
    planner.
21. The current-version issue list also covers days with too many
    meetings, a focus goal not met, habits that were skipped, and meetings
    with no agenda. Rules for these
    belong to the meeting check and meeting overload automations.

### Memories

22. When the user tells the assistant to remember something, the system
    stores it as a chat memory.
23. A bookmark icon in the chat panel opens the memory list. The user can
    read and delete each memory.
24. Memories shape suggestions only. A memory never triggers an action on
    its own. Example: a memory to accept invitations from a given person
    makes the assistant suggest accepting them; it does not accept them.
25. A memory can name people by name or by email.
26. A memory can name people by role (the user's manager, or the
    people who report to the user) only
    when directory provisioning gives the reporting tree
    (`admin-sso-provisioning.md`). Otherwise the assistant asks the user to
    use a name or an email.

### Usage limits

27. The reference limits chat usage per tier. Tempoloom: optional instance
    quota (`plans-feature-inventory.md`). When a user reaches it, the panel
    says so and when it resets (proposal).

    Tempoloom decision: `assistant_chat_quota` counts the messages a person
    sends per day in their home time zone; it resets at midnight there.

## Outputs

- Chat replies in the panel.
- Staged changes in preview mode.
- Morning digest by email or chat app.
- Memory list.
- Calendar events change only after the user applies changes.

## Edge cases

1. The request is ambiguous (two people named Alex): the assistant asks a
   question instead of staging a change.
2. No slot fits a find-time request in the asked range: the assistant says
   so and offers the closest options or a wider range.
3. A memory conflicts with a request ("keep Friday afternoons free" and
   "book Friday at 15:00"): the explicit request wins; the assistant
   mentions the memory before staging (proposal).
4. A staged change becomes stale because the calendar changed: see
   `assistant-preview-mode.md` edge cases.
5. The model provider is down: the panel shows an error and keeps the
   draft text.
6. A colleague outside the organization: the assistant cannot read their
   calendar and proposes slots from the user's side only, saying so.

## Observed API shapes

Not yet observed.

## Open questions

1. What exact time does the nightly review run, and at what time does the
   digest arrive?
2. How far into the next week does the daily review look?
3. Can the user turn off the digest or single issue types? The current FAQ
   asks this; the answer is not captured.
4. What model and what tools does the reference assistant use? Not needed
   for parity; Tempoloom chooses its own.
5. Does the assistant see other team members' event titles, or only
   free/busy?
6. What are the usage numbers per tier?

## Acceptance tests

Common setup: Google Workspace test domain. Team with assistant chat on.
Accounts U and V are members with work hours Mon to Fri 09:00 to 17:00 and
meeting hours 10:00 to 16:00. U's calendar tomorrow has a meeting 13:00 to
14:00.

### T1. Create an event through approval

- Setup: common setup.
- Action: U writes "Reserve two hours tomorrow morning for deep work". U
  checks Google Calendar. U accepts the staged change and selects review
  and apply, then confirms.
- Expected calendar state: before apply, U's Google calendar has no new
  event. After apply, it has one 2-hour event tomorrow that starts at or
  after 09:00 and ends at or before 12:00.
- Reload check: after reload of the planner and Google Calendar, the event
  is still there and preview mode has no staged change.

### T2. Discard one of two changes

- Setup: common setup, plus a second meeting tomorrow 13:30 to 14:30 that
  overlaps the first.
- Action: U writes "Fix my conflicts tomorrow". The assistant stages two
  changes. U discards one and applies the other.
- Expected calendar state: only the applied change shows on Google
  Calendar.
- Reload check: after reload, the discarded change is gone from preview
  mode.

### T3. Find time with a colleague

- Setup: common setup. V is busy next Tuesday 10:00 to 12:00.
- Action: U writes "Find 30 minutes with V on Tuesday next week" and applies
  the staged change.
- Expected calendar state: a 30-minute event appears on U's and V's Google
  calendars next Tuesday, inside 12:00 to 16:00, with V as attendee. V gets
  the invitation only after apply.
- Reload check: after reload, the event exists on both calendars.

### T4. Memory guides suggestions

- Setup: common setup.
- Action: U writes "Remember: nothing before 10:00". U opens the memory
  list. Then U writes "Find 30 minutes for a call tomorrow morning".
- Expected calendar state: the staged event starts at or after 10:00.
  Nothing is written until apply.
- Reload check: after reload, the memory list still has the memory. U
  deletes it; after another reload it is gone.

### T5. Recommendations find issues

- Setup: common setup. U organizes a meeting tomorrow at 15:00 with V and
  no video link. V is busy at 15:00. U has an unanswered invitation for
  Thursday.
- Action: U selects Recommendations.
- Expected calendar state: no calendar change before apply. The findings
  list the missing video link, V's unavailability and the unanswered
  invitation, each with a staged fix.
- Reload check: after reload, the findings and staged fixes remain until U
  applies or discards them.

### T6. Disabled by admin

- Setup: the team admin turns chat off.
- Action: U opens the chat panel and tries to type.
- Expected calendar state: no change.
- Reload check: after reload, the disabled notice shows with the admin
  link.
