# Automation library

Spec id: SPEC-AUTOLIB-01
Evidence: E-0001 (ev_034166f1e6c8), E-0043 (ev_d7b30359b03e), E-0003 (ev_fdf25af08b9c), E-0148 (ev_e7b99cd896e0), E-0183 (ev_000dae433420)
Status of evidence: public docs only

## Summary

The automation library is a catalog of ready-made starting points. Some
entries are automation templates (a habit, focus time, buffer, flexible
meeting, meeting check, meeting cap, no-meeting day, calendar mirror or
booking link with preset values). Others are prompts for assistant chat
that analyze the calendar or stage changes. The user picks an entry, checks
the prefilled settings, and saves; the resulting calendar changes show in preview
mode first. The reference lists 46 entries on a public page; only their
titles are captured, so all preset values below are proposals.

## Concepts and inputs

### Library entry

| Field | Type | Notes |
|---|---|---|
| `id` | stable slug | Tempoloom's own slug. |
| `name` | text | Display name. |
| `kind` | enum `habit`, `focus_time`, `buffer`, `meeting_check`, `meeting_overload`, `flexible_meeting`, `no_meeting_day`, `calendar_mirroring`, `booking_link`, `chat_prompt` | |
| `group` | enum `habits`, `buffers`, `focus_time`, `flexible_meetings`, `meeting_checks`, `other`, `prompts` | Library tabs. The reference in-app library groups by habits, buffers, focus time, flexible meetings and meeting checks. `other` and `prompts` are Tempoloom groups for the remaining entries. |
| `preset` | settings of the target kind | Prefilled form values. For `chat_prompt`: the prompt text. |
| `added` | derived boolean | True when the user has an automation made from this entry. |

### Entries

The preset column is a proposal for every row. Field names follow the
specs of each automation kind. "Ext. meeting" means an event of category
`external_meeting` (`events-categories-and-colors.md`). Focus time and
meeting load cap automations have a fixed priority (P4) and meeting checks
have none (`automations-overview.md`), so their presets set no priority.

| # | Name | Kind | Proposed preset |
|---|---|---|---|
| 1 | Recovery after large meetings | buffer | Recovery buffer 15 min after meetings with 6 or more attendees. P3. Busy. |
| 2 | Prep before executive meetings | buffer | Prep buffer 15 min before meetings that include anyone on a user-chosen list of people. P2. |
| 3 | Prep before interviews | buffer | Prep buffer 15 min before events whose title contains "interview". P2. |
| 4 | Agenda drafts for my meetings | meeting_check | For meetings the user organizes in the next 7 days with an empty description, draft an agenda and stage a description update. |
| 5 | Back-plan work from due dates | chat_prompt | "Look at my open tasks with due dates and propose work time before each due date." |
| 6 | What to do now | chat_prompt | "Which task should I start now, and why?" |
| 7 | Executive weekly focus | focus_time | Weekly goal 8 h. Proactive. Ideal time mornings. |
| 8 | Recovery day after heavy meeting days | meeting_overload | When a workday has 5 h or more of meetings, cap new meetings at 2 h on the next workday. |
| 9 | Flag meeting problems | meeting_check | Check daily for conflicts, missing RSVPs, missing video links and unavailable attendees. |
| 10 | Airport travel time | buffer | Travel buffer 120 min before and 60 min after flight events. |
| 11 | End-of-day wrap-up | habit | 30 min, Mon to Fri, ideal time the last 30 min of work hours. P3. |
| 12 | Customer onboarding meeting plan | chat_prompt | "Plan onboarding meetings with this customer: a 60 min kickoff, a 30 min check-in after 1 week and a 30 min review after 30 days." |
| 13 | Prep before customer meetings | buffer | Prep buffer 15 min before ext. meetings. P2. |
| 14 | Work rhythm review | chat_prompt | "Over the last 4 weeks, when do I do deep work and when do I meet? Suggest a better weekly rhythm." |
| 15 | Cross-team meeting time | chat_prompt | "Find the best time this week for a meeting with these colleagues: …" |
| 16 | Burnout risk review | chat_prompt | "Check my last 4 weeks for burnout signs: meetings outside work hours, few breaks, little time off, little focus time." |
| 17 | Team meeting health review | chat_prompt | "Summarize my team's meeting load and one-on-one time from team stats." |
| 18 | Urgent review meeting | chat_prompt | "Find the earliest slot this week for an urgent review with these people. You may move my lower-priority items." |
| 19 | Break after long meetings | buffer | Recovery buffer 10 min after any meeting of 60 min or more. |
| 20 | Adaptive workday | chat_prompt | "My day changed: I now work from … to …. Rearrange my flexible items for today." |
| 21 | Conflict fixes | chat_prompt | Runs Recommendations for the dates in view. |
| 22 | Plan my day | chat_prompt | "Plan my day: place my top tasks in free focus time and add short breaks." |
| 23 | Peak-energy focus | focus_time | Weekly goal 10 h. Proactive. Ideal window 09:00 to 12:00 (user can change). |
| 24 | Task re-ranking | chat_prompt | "Re-rank my open tasks by due date and remaining work, and propose new priorities." |
| 25 | Deep work protection | focus_time | Weekly goal 10 h. Proactive. Minimum block 2 h. |
| 26 | Meeting load cap | meeting_overload | Cap meetings at 20 h per week and 5 h per day. |
| 27 | Breaks after meeting runs | buffer | Recovery buffer 15 min after each run of back-to-back meetings longer than 90 min. |
| 28 | Travel for external meetings | buffer | Travel buffer 30 min before and after ext. meetings that have a location. |
| 29 | Focus before customer meetings | buffer | Solo prep block 30 min before ext. meetings. P2. |
| 30 | Sales call prep and debrief | buffer | Prep 10 min before and follow-up 10 min after ext. meetings. |
| 31 | Prep task suggestions | chat_prompt | "For my meetings in the next 7 days, suggest prep tasks due before each meeting." |
| 32 | Recurring client meetings | flexible_meeting | Ext. attendees, every 2 weeks, 30 min, P2. |
| 33 | Weekly no-meeting day | no_meeting_day | One weekday per week, default Wednesday, whole day. Mechanism as in `events-tags.md` (an all-day busy event tagged `#tl_free`). |
| 34 | One-on-ones | flexible_meeting | One other attendee, weekly, 30 min, P2. |
| 35 | Weekly writing time | habit | 60 min, 3 times per week. P3. |
| 36 | Weekly reading time | habit | 45 min, 2 times per week. P4. |
| 37 | Priority booking link | booking_link | 30 min, priority P2, so it offers times over P3 and P4 items. |
| 38 | Mirror calendars after a merger or role change | calendar_mirroring | Two-way mirror between the old and the new work calendar. Copies show busy only. |
| 39 | Mirror calendars across several jobs | calendar_mirroring | Mirror each job calendar into each other one. Copies show busy only. |
| 40 | Daily walk | habit | 30 min, Mon to Fri, ideal 12:30. |
| 41 | Exercise | habit | 60 min, 3 times per week, personal hours. |
| 42 | Coding time | habit | 120 min, 4 times per week, work hours. P2. |
| 43 | Weekly planning | habit | 60 min, once per week, ideal Monday 09:00. |
| 44 | Email catch-up | habit | 30 min, Mon to Fri, ideal 16:00. P4. |
| 45 | Meditation | habit | 15 min, daily, personal hours. |
| 46 | Lunch | habit | 60 min, daily on workdays, window 11:30 to 14:00, ideal 12:00. |

## Behavior

1. Automations live in a sidebar of the planner. The shared automation
   model, the sidebar and priority ordering are in `automations-overview.md`.
   This spec covers only the library catalog.
2. The user opens the library from an "Add" action at the top of the
   automation sidebar, or from a "Create" action in the top navigation.
3. The library has one tab per `group`. The user can browse all entries or
   one group.
4. An entry whose `added` value is true shows an "Added" badge.
   Tempoloom decision: a habit, focus time or buffer automation remembers the
   entry it came from, so the badge stays after a rename and does not show for
   a hand-made automation with the entry's name. Flexible meetings, booking
   links and mirroring still match the entry by name.
5. Selecting an automation entry opens the form of its kind, filled with the
   preset. The user can change any value, including the name.
   Tempoloom decision: focus time and buffer entries open the shared
   automation form (`automations-overview.md`); habit entries open the habit
   form. An entry's emoji fills the form's Emoji field. After a habit from an
   entry is saved, the habit form is blank again.
6. Saving the form stages the automation and the calendar changes it causes in preview
   mode (`assistant-preview-mode.md`). Nothing changes on the calendar
   until the user applies.
7. Selecting a `chat_prompt` entry opens assistant chat with the prompt text
   in the input box. The user can edit the text, then send. Results follow
   `assistant-chat.md`.
8. The user can also ask assistant chat to create any library automation by
   name.
9. Adding an entry again when it already shows "Added" is allowed
   (`automations-overview.md` rule 3). The new automation gets the name with
   a number suffix (" 2") (proposal).
10. When the user is at the automation count limit (instance setting,
    `plans-feature-inventory.md`), saving is refused with the limit message.
11. Tempoloom decision: meeting check entries (4 and 9) open the meeting
    checks page with their checks on (entry 9 also sets the daily digest to
    email); they show "Added" once saved while their checks stay on. Entry 33
    opens the weekly no-meeting day on the Settings page and shows "Added"
    while that day exists.

## Outputs

- Library view with tabs, entries and badges.
- Prefilled automation forms.
- Prefilled chat input.
- Staged changes, then managed events after apply.

## Edge cases

1. A buffer entry needs a person list (entry 2) and the list is empty: the
   form asks for at least one person before save.
   Tempoloom decision: entry 2 opens the buffer form, and saving with no
   person shows "Add at least one person."
2. A mirroring entry needs two connected calendars and the user has one:
   the form explains this and links to calendar connection.
3. A flexible meeting entry needs attendees: the form asks for at least one.
4. The user deletes the automation made from an entry: the badge goes away.
5. A prompt entry with a placeholder ("…"): the input box selects the
   placeholder so the user types over it (proposal).

## Observed API shapes

Not yet observed.

## Open questions

1. What preset values does each reference template carry?
2. Which reference entries are automation templates and which are chat
   prompts? The public page calls them "prompts and workflows" without a
   split.
3. Does the in-app library contain all 46 public entries?
4. Can the user add the same template twice?
5. What do "adapt workdays automatically" and "schedule meeting recovery
   days" do in the reference?

## Acceptance tests

Common setup: Google test account U with work hours Mon to Fri 09:00 to
17:00, no automations, assistant chat on.

### T1. Add a habit from the library

- Setup: common setup.
- Action: U opens the library, selects "Lunch", keeps the preset, saves,
  then applies in preview mode.
- Expected calendar state: before apply, no lunch events on Google
  Calendar. After apply, each workday in the scheduling window has one
  60-minute "Lunch" event between 11:30 and 14:00.
- Reload check: after reload, "Lunch" shows the "Added" badge and the
  automation is in the sidebar.

### T2. Buffer before external meetings

- Setup: common setup. U adds "Prep before customer meetings" and applies.
- Action: an account on another domain invites U to a meeting tomorrow
  15:00 to 15:30; U accepts.
- Expected calendar state: a 15-minute prep managed event appears tomorrow
  14:45 to 15:00 on U's Google calendar.
- Reload check: after refreshing Google Calendar and the planner, the prep
  event is still there.

### T3. Prompt entry fills chat

- Setup: common setup.
- Action: U selects "Plan my day". The chat input shows the prompt. U sends
  it.
- Expected calendar state: no change before apply; staged changes appear in
  preview mode.
- Reload check: after reload, the staged changes are still pending.

### T4. Group tabs and badge after delete

- Setup: T1 done.
- Action: U opens the habits tab, then deletes the "Lunch" automation and
  applies.
- Expected calendar state: the "Lunch" managed events are removed from
  Google Calendar.
- Reload check: after reload, the habits tab lists "Lunch" without the
  badge.
