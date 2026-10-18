# Team policies

Spec id: SPEC-TEAMS-04
Evidence: E-0017 (ev_58c1efde0962), E-0018 (ev_28527173bd6f), E-0019 (ev_2718e098a9ce), E-0020 (ev_35bf2e8ddf95), E-0021 (ev_4fa8057a844a), E-0014 (ev_6d4b05eba664), E-0170 (ev_d03324e8b6e1), E-0003 (ev_fdf25af08b9c)
Status of evidence: public docs only (marketing pages; no help docs)

## Summary

A team policy is an organization-wide rule that an admin sets once and
that the system applies to many members. The reference markets five
policies: focus time, buffers, meeting agendas, calendar fragmentation and
chat-app notifications. A policy has a goal, a scope (whole organization,
department, team or role), and per-member automations that it creates or
tunes. Members can personalize within the policy. Reports show progress
against the goal. The evidence is marketing text only, so most rules below
are proposals.

## Concepts and inputs

### Policy (common shape)

| Field | Type | Default | Notes |
|---|---|---|---|
| `type` | enum `focus_time`, `buffers`, `meeting_agendas`, `fragmentation`, `chat_status` | required | |
| `scope` | list of scope rules | whole team | A scope rule matches members by team, or by a directory attribute such as department, title, role or level. |
| `goal` | type-specific | type-specific | See below. |
| `strictness` | type-specific enum | type-specific | Only for some types. |
| `enabled` | boolean | false | |

Directory attributes come from directory provisioning
(`admin-sso-provisioning.md`). Without provisioning, scope can only be the
whole team (proposal).

### Focus time policy goal

| Field | Type | Default | Allowed |
|---|---|---|---|
| `weekly_goal_hours` | number | Proposed default: 10 | 1 to 40 |
| `allowed_modes` | set of `proactive`, `reactive` | both | Member picks one. |

### Buffer policy goal

| Field | Type | Default | Notes |
|---|---|---|---|
| `min_daily_break_minutes` | integer | Proposed default: 30 | Minimum break time per workday. |
| `recovery_after` | list of (event category, minutes) | empty | For example after a focus session. |
| `prep_before` | list of (meeting category, minutes) | empty | For example before one-on-ones or leadership meetings. |
| `follow_up_after` | list of (meeting category, minutes) | empty | Time after meetings to act on outcomes. |

### Meeting agenda policy goal

| Field | Type | Default | Allowed |
|---|---|---|---|
| `meeting_types` | set of meeting categories | all | Categories as in `events-categories-and-colors.md`. |
| `strictness` | enum `remind`, `adjust`, `auto_decline` | `remind` | See rules 13 to 16. |

### Fragmentation policy goal

| Field | Type | Default | Notes |
|---|---|---|---|
| `target_reduction_percent` | integer | Proposed default: 25 | Against the baseline. |
| `min_usable_block_minutes` | integer | Proposed default: 60 | A gap shorter than this between two busy events counts as fragmented time. |
| `member_flexibility` | enum `low`, `medium`, `high` | `medium` | How much each member lets the system move their flexible meetings. Members can change it. |

### Chat status policy goal

| Field | Type | Default | Notes |
|---|---|---|---|
| `status_by_event_kind` | map of event kind to status text and emoji | system defaults | Event kinds: meeting, focus time, travel, between events. |
| `dnd_during` | set of event kinds | focus time | Do-not-disturb on during these kinds. |
| `hide_titles` | boolean | true | Status never shows the event title (privacy). |

## Behavior

### All policies

1. Only team admins can create, change, enable or disable a policy.
2. When a policy is enabled, the system applies it to every member that
   matches the scope.
3. When a member's directory attributes change (new team, new role, new
   department), the system re-evaluates the scope and applies the matching
   policy. No admin action is needed.
4. A new member who matches the scope gets the policy at join time.
5. Two policies of the same type can match one member. Proposed rule: the
   policy with the narrower scope wins (role over team over department over
   organization). On a tie, the most recently changed policy wins.
6. Existing meetings stay where they are when a policy starts. The policy
   affects only scheduling decisions made after it starts.
7. Members can personalize the automations a policy creates (rule 9, 12,
   18, 21). The policy report counts the member's actual values.
8. Each policy has a report with its goal, a baseline (the 4 weeks before
   the policy started, proposal) and a week-over-week trend. Reports use
   group averages only, as in `analytics-team-stats.md`.

### Focus time policy

9. For each member in scope, the system creates or updates a focus time
   automation with the policy's weekly goal. The member picks proactive or
   reactive mode among the allowed modes, and can change the goal.
10. Focus time placement, conflicts and rescheduling follow
    `focus-time.md`. The policy adds no placement rule.
11. The report shows focus hours scheduled and focus hours kept per week,
    next to meeting hours, against the goal.

### Buffer policy

12. For each member in scope, the system creates break, recovery, prep and
    follow-up buffer automations from the goal. Each buffer respects the
    member's own work hours and time zone. The member can change lengths.
13. Placement follows `buffers-automation.md` and `buffers-breaks.md`. The report shows buffer coverage
    (share of meetings that got the policy buffer), keep rate (share of
    placed buffers that were not overridden), and override count.

### Meeting agenda policy

14. The system checks meetings in scope that the member organizes. A
    meeting "has an agenda" when its description has at least 1 line of
    text other than conferencing details (proposal).
15. `remind`: before the invitation goes out, or as soon as the system sees
    the meeting, it reminds the organizer to add an agenda and offers an
    AI-drafted agenda. Delivery channel: open question.
16. `adjust`: in addition, the system may propose to shorten, move or lower
    the priority of a meeting without an agenda. Changes go to preview mode
    first (`assistant-preview-mode.md`) unless the member allowed automatic
    changes.
17. `auto_decline`: in addition, for members in scope who are invited (not
    organizers), the system declines invitations to meetings in scope that
    still have no agenda at a lead time before the start. Proposed lead
    time: 24 hours.
18. Meetings are never blocked by default. The default strictness is
    `remind`.
19. The system offers agenda templates per meeting type. Admins can add
    custom templates.
20. The report shows the share of meetings with an agenda, average meeting
    length, and focus time kept.

### Fragmentation policy

21. The system computes fragmented time per member per workday: the sum of
    gaps between busy events inside work hours that are shorter than
    `min_usable_block_minutes`.
22. Before enabling, the admin sees a baseline report of fragmented time
    per group.
23. When enabled, the system prefers placements of flexible meetings and
    managed events that reduce fragmented time. The member's
    `member_flexibility` limits how far the system moves flexible meetings.
    The detailed scoring belongs to the scheduler spec
    (`planning-scheduler.md`).
24. The report shows usable time versus fragmented time, average
    uninterrupted block length, and meeting density, per group, week over
    week.

### Chat status policy

25. For each member in scope who connected the chat app, the system sets the
    chat-app status from the current calendar event kind, using the policy
    map. It turns do-not-disturb on during the listed kinds.
26. When an event moves, shortens or ends, the status changes at the new
    time. A status never stays after its event ended.
27. Chat-app connection, commands and status details follow
    `integrations-slack.md`.

## Outputs

- Per-member automations created or tuned by a policy, marked in the
  member's automation list as coming from a team policy (proposal).
- Organizer reminders and AI-drafted agendas (meeting agenda policy).
- Declined invitations (meeting agenda policy with `auto_decline`).
- Chat-app status and do-not-disturb changes (chat status policy).
- Policy reports for admins.

## Edge cases

1. A member is in scope of a focus policy and lowers their goal to 0: the
   system keeps the member's choice; the report shows the gap (proposal).
2. A member has no work hours that fit the policy buffers: the buffers that
   do not fit are skipped and counted as not covered.
3. An `auto_decline` meeting gets an agenda after the decline: proposed, the
   system does not accept again automatically; it notifies the member.
4. The organizer of a meeting is outside the organization: the agenda
   policy still applies to invited members in scope.
5. A directory attribute is missing for a member: the member matches only
   whole-team policies.
6. Two policies of different types act on the same time slot (for example
   focus time and a buffer): normal priority rules decide.

## Observed API shapes

Not yet observed.

## Open questions

1. Is a policy a separate object in the reference, or only the same team
   templates plus sales services? The pages describe a guided rollout and a
   pilot of 20 to 100 people, which are services, not product.
2. Where does an admin create a policy, and what does the form contain?
3. What benchmark targets does the reference show, and per which roles?
4. How does the reference define fragmented time and the minimum usable
   block?
5. The agenda page promises that meeting topics are mapped to company
   workstreams. What does it measure, and where do workstreams come from?
6. Which channel carries agenda reminders (email, chat app, in-app)?
7. Is "company focus time goal" (enterprise tier) the same as the team
   focus template in `teams-settings-templates.md`?
8. What happens to a member's personal changes when the admin changes the
   policy goal?

## Acceptance tests

Common setup: Google Workspace test domain. Account A is team admin.
Accounts B and C are members. B has directory attribute
`department = Engineering`, C has `department = Sales` (provisioned per
`admin-sso-provisioning.md`). All three have work hours Mon to Fri 09:00 to
17:00 and no focus automation.

### T1. Focus policy by department

- Setup: common setup.
- Action: A creates a focus time policy, scope `department = Engineering`,
  weekly goal 8 hours, and enables it.
- Expected calendar state: B's Google calendar gets focus time managed
  events that total 8 hours this week (or as much as fits). C's calendar
  gets no focus events.
- Reload check: after reload, B's automation list shows a focus automation
  marked as from a team policy with goal 8 hours. C has none.

### T2. Attribute change moves the policy

- Setup: T1 done.
- Action: the directory changes C to `department = Engineering`.
- Expected calendar state: within one sync cycle, C's calendar gets focus
  events that total 8 hours for the week.
- Reload check: after reload, C's automation list shows the policy focus
  automation.

### T3. Agenda policy, auto-decline

- Setup: common setup. A creates a meeting agenda policy, whole team,
  strictness `auto_decline`, lead time 24 hours.
- Action: an outside account invites B to a meeting 3 days from now with an
  empty description. A second outside meeting at the same lead time has a
  description "1. Roadmap 2. Risks".
- Expected calendar state: 24 hours before the first meeting, B's RSVP on
  it is "declined". B's RSVP on the second meeting is unchanged.
- Reload check: refresh Google Calendar; RSVP states stay the same.

### T4. Agenda policy, remind only

- Setup: common setup. Strictness `remind`.
- Action: B creates a meeting with C for tomorrow with an empty
  description.
- Expected calendar state: the meeting stays at its time with no RSVP
  change. B receives a reminder with a drafted agenda.
- Reload check: after reload, the reminder is still listed for B until B
  adds an agenda or dismisses it.

### T5. Fragmentation baseline

- Setup: common setup. B's last 4 weeks each have meetings on Tuesday at
  10:00 to 10:30, 11:00 to 11:30 and 14:00 to 14:30.
- Action: A opens the fragmentation baseline report for Engineering with
  `min_usable_block_minutes = 60`.
- Expected calendar state: no calendar change.
- Reload check: after reload, the report shows 30 minutes of fragmented
  time on each Tuesday for B's group (the 10:30 to 11:00 gap).
