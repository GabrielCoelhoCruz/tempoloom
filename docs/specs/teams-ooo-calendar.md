# Team out-of-office calendar

Spec id: SPEC-TEAMS-03
Evidence: E-0171 (ev_47c8d7282a8c), E-0023 (ev_dfeca2f754da), E-0014 (ev_6d4b05eba664), E-0148 (ev_e7b99cd896e0), E-0003 (ev_fdf25af08b9c), E-0182 (ev_80185208c432)
Status of evidence: public docs only

## Summary

A team out-of-office calendar is a shared Google or Outlook calendar that
shows who on the team is away and when. Each person adds time off to their
own calendar as usual. Tempoloom finds those events and copies them to the
shared calendar. Admins control who can create these calendars and which
events count as time away. In the reference, this feature is in the
large-team and enterprise tiers.

## Concepts and inputs

### Out-of-office calendar configuration

| Field | Type | Default | Notes |
|---|---|---|---|
| `name` | text | required | Display name in team settings, for example "Team OOO". |
| `owner` | team member | the creating user | |
| `target_calendar` | calendar id | required | An existing shared calendar in Google Calendar or Outlook. |
| `participants` | derived list of users | | Computed, not typed in. See rules 4 to 7. |

### Team-wide admin settings

| Field | Type | Default | Notes |
|---|---|---|---|
| `allow_member_created_calendars` | boolean | true | When false, only admins can create a configuration. |
| `include_all_day_busy` | boolean | open question (proposed false) | When true, all-day events marked busy count as time away. |
| `partial_day_display` | enum `exact_times`, `all_day` | open question (proposed `exact_times`) | How the copy of a partial-day absence looks. |

### Source events (what counts as time away)

- Full-day out-of-office events on a participant's own calendar.
- Partial-day out-of-office events on a participant's own calendar.
- All-day busy events, only when `include_all_day_busy` is true.

In Google Calendar, an out-of-office event is an event of the Google
"out of office" event type.

## Behavior

### Setup

1. Outside Tempoloom, a person creates a shared calendar (or uses an
   existing one) and shares it with teammates or groups with write access
   ("make changes to events" in Google, "can edit" in Outlook).
2. In team settings, an admin (or any member, when
   `allow_member_created_calendars` is true) selects "Add a calendar" and
   enters the name, the owner and the target calendar. Then they select
   "Create".
3. When `allow_member_created_calendars` is false, the add action is hidden
   or disabled for non-admins.

### Participants

4. The system reads the access list of the target calendar.
5. When the calendar is shared with a group (Google Group or Microsoft
   group), the system expands the group to its members.
6. A person is a participant when they have write access to the target
   calendar and have a Tempoloom account. The system activates them with no
   further action.
7. A person with read-only access, or with no Tempoloom account, is not a
   participant. The system does not track their time away.
8. The system updates the participant list when the access list or a group
   changes. (Interval not observed; see open questions.)
9. One person can be a participant in several out-of-office calendars. The
   system keeps each one up to date.

### Copying time away

10. When a participant creates a source event, the system creates one copy
    on the target calendar. The copy shows who is away and the time span.
11. With `partial_day_display = exact_times`, the copy of a partial-day
    absence has the same start and end as the source (for example 14:00 to
    16:00).
12. With `partial_day_display = all_day`, the copy of a partial-day absence
    is an all-day event on that date.
13. A full-day absence always gives an all-day copy (or a multi-day all-day
    copy for a multi-day absence).
14. When the source event changes time or date, the system updates the copy.
    When the source event is deleted, the system deletes the copy. (Inferred
    from the statement that the shared calendar stays in sync.)
15. The copy never includes the source event's description, attendees or
    location (proposal; privacy).

### Scheduling effects

16. A participant's own managed events and flexible meetings avoid their
    time away. The rules for this are in `events-out-of-office.md`. This
    spec adds no new rule.

## Outputs

- One event per absence on the target calendar.
  - Proposed title: "<Display name> out of office".
  - Time: as rules 11 to 13.
  - Free/busy: free (proposal), so the shared calendar does not block other
    people's availability.
  - Description: proposed "Copied by Tempoloom from <Display name>'s
    calendar."
- Team settings list of out-of-office calendars with name, owner, target
  calendar and participant count.

## Edge cases

1. A participant loses write access: the system stops copying new absences.
   Existing copies: open question.
2. A participant leaves the team: proposed, the system deletes their future
   copies and stops copying.
3. The owner leaves the team or disconnects the target calendar: proposed,
   the configuration shows an error state in team settings and copying
   stops until an admin picks a new owner.
4. A person is in two out-of-office calendars: each target calendar gets
   its own copy.
5. A source absence that crosses midnight in the participant's time zone:
   proposed, copy with exact times in the participant's time zone.
6. An admin changes `partial_day_display` after copies exist: proposed, the
   system rewrites future copies only.
7. An all-day busy event while `include_all_day_busy` is false: no copy.
8. A recurring out-of-office event: one copy per occurrence inside the
   scheduling window (proposal).

## Observed API shapes

Not yet observed.

## Open questions

1. Must a participant be a member of the same Tempoloom team, or is any
   Tempoloom account enough?
2. What are the defaults of `include_all_day_busy` and
   `partial_day_display`?
3. What is the exact title and free/busy state of a copy?
4. How fast does a copy appear after the source event is created?
   Proposed target: within 5 minutes.
5. How far into the future does the system copy absences?
6. What happens to existing copies when a participant loses access?
7. Marketing pages also list: chat-app status during time off, a custom
   chat-app auto-reply while away, an assistant chat answer to "who is away
   next week", time-away tracking in stats, and automatic enrollment of new
   teammates. None has a help page. Are they shipped?

## Acceptance tests

Common setup: Google Workspace test domain. Account A is team admin.
Accounts B and C are team members with Tempoloom accounts. In Google
Calendar, A creates a calendar "Team OOO" and shares it with B with "make
changes to events" and with C with "see all event details" (read-only).
In Tempoloom, A adds a configuration: name "Team OOO", owner A, target the
"Team OOO" calendar.

### T1. Participants come from write access

- Setup: common setup.
- Action: A opens the configuration.
- Expected calendar state: no events on "Team OOO" yet.
- Reload check: after reload, the participant list has A and B. C is not
  listed.

### T2. Full-day absence is copied

- Setup: common setup.
- Action: B creates a Google "out of office" event for all of next
  Wednesday on B's primary calendar.
- Expected calendar state: within 5 minutes, "Team OOO" has one all-day
  event on next Wednesday that names B.
- Reload check: refresh Google Calendar; the copy is still there. Reload
  Tempoloom; the configuration still lists B.

### T3. Partial-day absence, both display options

- Setup: common setup. `partial_day_display = exact_times`.
- Action: B creates an out-of-office event next Thursday 14:00 to 16:00.
  Then A sets `partial_day_display = all_day`. B creates another
  out-of-office event next Friday 10:00 to 11:00.
- Expected calendar state: "Team OOO" has a Thursday copy from 14:00 to
  16:00 and an all-day Friday copy.
- Reload check: after reload, both copies remain with those times, and the
  admin setting shows `all_day`.

### T4. Change and delete follow the source

- Setup: T2 done.
- Action: B moves the Wednesday absence to Tuesday. Then B deletes it.
- Expected calendar state: the copy moves to Tuesday, then disappears.
- Reload check: after reload of Google Calendar, "Team OOO" has no event for
  B on Tuesday or Wednesday.

### T5. Read-only person is not tracked

- Setup: common setup.
- Action: C creates a full-day out-of-office event next Monday.
- Expected calendar state: "Team OOO" has no copy for C.
- Reload check: same after reload.

### T6. All-day busy events

- Setup: common setup. `include_all_day_busy = false`.
- Action: B creates an all-day event "Dentist" marked busy next Tuesday.
  A sets `include_all_day_busy = true`. B creates another all-day busy event
  next Thursday.
- Expected calendar state: no copy for Tuesday. One all-day copy for
  Thursday.
- Reload check: same after reload; the admin setting shows true.

### T7. Member-created calendars switched off

- Setup: common setup. A sets `allow_member_created_calendars = false`.
- Action: B opens team settings and tries to add a configuration.
- Expected calendar state: no change.
- Reload check: after reload, B still has no add action; A still has it.
