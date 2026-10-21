# Focus time and meeting overload

Spec id: SPEC-FOCUS-01
Evidence: E-0077 (ev_38c8b46b5b57), E-0070 (ev_d2afff8cfe08), E-0078 (ev_9a67805f6265), E-0071 (ev_3978ef1e6985), E-0095 (ev_c5c40e379d79), E-0083 (ev_fd7912136937), E-0170 (ev_d03324e8b6e1), E-0015 (ev_5930c31b8eb4), E-0017 (ev_58c1efde0962), E-0043 (ev_d7b30359b03e), E-0141 (ev_d12320a15a83), E-0090 (ev_4a54fa9f235a), E-0089 (ev_e7262cc4064c), E-0203 (ev_6fcb5f8189d7)
Status of evidence: public docs only

## Summary

Focus time keeps blocks free for deep work without a named task. Two
automations produce one shared kind of focus event. The focus goal automation works toward a
weekly number of hours. The meeting overload automation caps meeting hours per
day or week and protects the rest. Focus events fill the time left after all
other managed items, and are strongly protected once placed.

## Concepts and inputs

### Focus goal automation

| Field | Type | Default | Allowed values and notes |
|---|---|---|---|
| `title` | string | "Focus Time" (Proposed) | May contain emoji (E-0078). |
| `description` | markdown | empty | Copied to each focus event (E-0078). |
| `weekly_goal_hours` | number | Proposed default: 10 | 0.5 to 40, step 0.5 (Proposed range). |
| `daily_min_hours` | number | Proposed default: 0 | Hours to aim for on each allowed day (E-0077). |
| `daily_max_hours` | number | Proposed default: 4 | Upper limit per day (E-0077). |
| `min_block_minutes` | minutes | Proposed default: 60 | Shortest focus event (E-0077). 15 to 480, step 15. |
| `max_block_minutes` | minutes | Proposed default: 240 | Longest focus event (legacy evidence, E-0078; marketing "session ranges", E-0015). |
| `hours` | hours set id or one-off window | work hours | Where focus may be placed (E-0077). |
| `mode` | `proactive` or `reactive` | `proactive` | Legacy evidence (E-0078). Current marketing still lists both (E-0015). Current help maps reactive behavior to the meeting overload automation (E-0095). |
| `auto_decline` | `{enabled, message}` | off | Decline invitations that overlap a placed focus event (E-0077). |
| `offer_to_booking_links` | bool | `true` | Legacy setting "block meetings during focus" sets this to false (E-0078). |
| `target_calendar` | calendar id | primary calendar | Legacy evidence (E-0078). |
| `visibility` | `public`, `private`, `calendar_default` | `public` | Legacy default is public (E-0078). |
| `reminders` | list of minutes, or off | off (Proposed) | E-0043. |
| `preferred_window` | local time range (HH:MM to HH:MM), or none | none | Tempoloom decision, see below. The same range on each day. |

The focus goal automation has no priority field. Its priority is fixed at P4
(E-0077, E-0141).

Tempoloom decision: as for habits, the focus goal's target calendar is set at
creation only, its emoji goes before the title, and its color follows the
color rule unless the user picks one. A new focus goal is public with no
reminders. Focus events show no free or busy marker, only the lock marker
(answers open question 2 of `events-title-emoji.md`).

Tempoloom decision (library entry 7, "Ideal time mornings", and entry 23,
"Ideal window 09:00 to 12:00 (user can change)"): a focus goal may have a
`preferred_window`. Tempoloom reads "mornings" as 09:00 to 12:00, so both
entries add the window 09:00 to 12:00. It is a preference, not hard hours. In
proactive mode Tempoloom first places focus in the free time that is inside
both `hours` and the window, on each allowed day. Only when that time is full
does it use the other free time inside `hours`. Rules 3 to 6 apply as before;
for each daily limit pass (rule 5, then rule 4), the window goes first on all
days, then the rest of `hours`. A placed focus event outside the window stays
where it is while it is legal (no move only to reach the window). Reactive
mode ignores the window. The window must start before it ends.

### Meeting overload automation

| Field | Type | Default | Allowed values and notes |
|---|---|---|---|
| `title` | string | "Focus Time" (Proposed) | The user may rename it to tell the two automations apart (E-0070). |
| `daily_max_meeting_hours` | number or none | none | At least one of the two limits is required (E-0070). 0.5 to 24, step 0.5. |
| `weekly_max_meeting_hours` | number or none | none | 0.5 to 168, step 0.5. |
| `min_block_minutes` | minutes | Proposed default: 30 | E-0070. |
| `hours` | hours set id or one-off window | work hours | E-0070. |
| `auto_decline` | `{enabled, message}` | off | E-0070. |
| Other event fields | as above | as above | Title, description, visibility, reminders, target calendar. |

Its priority is also fixed at P4 (E-0070, E-0141).

### Counted time

"Counted time" for a day is the sum of these items inside `hours` on that day
(E-0078, E-0083, E-0095, E-0203):

- focus events from either automation;
- task chunks with work category;
- habit events with `category=work`;
- Google Calendar events of the native "focus time" type;
- any event, managed or external, with the focus tag in its title or description. Proposed tag name: `#tl_focus` (see `events-tags.md`).

## Behavior

### Focus goal automation, proactive mode

1. Tempoloom places focus events so that counted time in each week reaches `weekly_goal_hours`, as far as free time allows (E-0077).
2. It places focus even when the calendar has a lot of free time. This trades availability for protection (E-0078).
3. Each focus event is between `min_block_minutes` and `max_block_minutes` long.
4. Counted time per allowed day stays at or below `daily_max_hours`. Tempoloom adds no focus events on a day whose counted time already reaches `daily_max_hours`.
5. Tempoloom tries to give each allowed day at least `daily_min_hours` of counted time before it adds more on any other day. Proposed.
6. Proposed placement order inside a day: largest free gap first, so the week has fewer and longer blocks.
7. Tempoloom adds no focus event when counted time already meets the goal. Example: daily goal 2 hours, and 2 hours of work habits and tasks already exist that day: no focus event that day (E-0095).

### Focus goal automation, reactive mode (legacy evidence)

8. Tempoloom places no focus event while the free time left in the week, in blocks of at least `min_block_minutes`, is more than the goal still missing (E-0078, E-0071).
9. When the free time left falls to the missing goal or below, Tempoloom turns that free time into focus events.
10. In reactive mode the user sets `weekly_goal_hours`, `daily_min_hours` or both, and `min_block_minutes`. The other block and daily fields are not shown (E-0078).
    Tempoloom decision: "free time left" is the free time inside the goal's `hours` from now to the end of the week, after all other items, in gaps of at least `min_block_minutes`. When it is not more than the missing goal, each such gap becomes one focus event; `max_block_minutes` and `daily_max_hours` do not apply. While it is more, reactive mode places nothing and the planner shows no "goal not reached" notice.

### Meeting overload automation

11. Meeting hours for a day are the hours of events that are meetings: a busy event with at least one attendee other than the user, which the user organized, accepted or marked as maybe. Unanswered and declined invitations do not count. Booking-link meetings and flexible meetings count. Managed habits, tasks, focus events and buffers never count. Proposed definition (open question 2).
    Tempoloom decision: Tempoloom uses this definition. Meeting time that overlaps counts once. The meeting hours of a day are the meeting time on that local day, also outside `hours`.
12. When meeting hours on a day reach `daily_max_meeting_hours`, Tempoloom turns all remaining free time inside `hours` on that day into focus events, each at least `min_block_minutes` long (E-0070, E-0095).
13. When meeting hours in a week reach `weekly_max_meeting_hours`, Tempoloom does the same for every remaining day of that week (E-0070).
    Tempoloom decision: the protected days are the day on which the meeting hours since the start of the week reach the limit, and every later day of that week. On a protected day, each free gap inside `hours` from now on that is at least `min_block_minutes` long becomes one focus event; there is no longest block. Protection starts when a limit is reached, with no approach margin (open question 3).
    Tempoloom decision (library entry 8, "recovery day"): the automation may also set `heavy_day_meeting_hours`. Then the daily limit applies only on a workday (a day that `hours` allows) whose previous workday had at least that many meeting hours.
14. While no limit is reached, this automation places no focus event (E-0070, E-0095). The current help says protection grows "as you approach" the limit; the exact approach margin is open (open question 3).
15. When meetings are removed and meeting hours fall below the limit again, Tempoloom removes the focus events that this automation added and that the user did not lock. Proposed.
16. Both focus automations can run at the same time. Their events are the same type (E-0070).

### Behavior of placed focus events (both automations)

17. A placed focus event is busy and does not switch between free and busy (E-0089, E-0070). This matches `planning-defense.md` DEF-40, whose default for the automation's busy-or-free setting is busy.
18. When the user accepts an invitation, or creates an own busy event, that overlaps a focus event, Tempoloom moves the focus event to other free time and keeps working toward the goal (E-0077, E-0078, E-0071). Target latency: within 60 seconds. The legacy guide observed about 15 seconds (E-0071).
19. An invitation that the user has not answered does not move a focus event. Proposed (E-0078 says the move follows an accepted event).
20. When the user moves a focus event in the planner or in Google Calendar, Tempoloom locks it. A locked focus event does not move even when another event overlaps it (E-0077, E-0078).
21. When the user deletes a focus event, Tempoloom treats it as skipped. It places no focus event in that time range again (E-0077, E-0078). Proposed: the lost hours may be placed in another range of the same week.
22. Reschedule action: the user picks a minimum delay from now. Tempoloom moves the focus event to the first legal free range that starts at or after now plus that delay (E-0071).
    Tempoloom decision: the delays are 15 and 30 minutes, 1 to 4 hours and 1 day, and the start is on a quarter hour. A legal free range is in the goal's hours, has no blocking event and no other Tempoloom event, is not the event's old time, and is not a range where the user deleted an event of the goal (rule 21). The moved event is locked there like a move (rule 20). A focus event in progress is not offered the action.
23. When `auto_decline.enabled=true`, Tempoloom declines invitations that overlap a placed focus event, with the message as the decline note to the organizer (E-0077, E-0070). Without it, Tempoloom declines nothing; the busy event alone protects the time (E-0070).
    Tempoloom decision: auto-decline answers unanswered invitations from other organizers that overlap a placed focus event of that automation, after each run. Accepted and tentative invitations are not changed (an accepted one moves the focus event, rule 18). Tempoloom answers each invitation once, so the user may accept it again. On CalDAV the decline is `PARTSTAT=DECLINED` on the user's copy with the message as its `COMMENT`; on Google it is the attendee answer with the message as its comment. An empty message sends "Declined automatically: this time is protected for focus." One occurrence of a recurring invitation on CalDAV is not declined. The meeting overload automation has the same setting.
24. A focus event can carry a task list. The same list shows on every focus event of the week (E-0077).
    Tempoloom decision: the task list is the automation's saved task search (`planning-next-up.md` NXT-40). The details panel of every focus event of the automation shows the same search and its matching tasks. The list does not change the events.

### Team focus template and company focus policy

25. A team admin can recommend a focus template (mode and weekly goal) to new members. Each member may accept it, change it or turn it off (legacy evidence, E-0170). The template model and its UI are in `teams-settings-templates.md`.
26. An organization can set focus goals per company, department, team or role, applied from directory attributes (marketing evidence, E-0017). The policy model, scope and reports are in `teams-policies.md`.
27. Both features produce an ordinary focus goal automation on the member's account. From then on, every rule in this spec applies to it unchanged.
28. A member's own edits stay within the policy limits that `teams-policies.md` defines (E-0017).

### Scheduler interaction

29. Order: the scheduler places focus events after all habits, task chunks and flexible meetings, whatever their priority (E-0078, E-0090, E-0077). Focus uses only the free time left after them.
    Tempoloom decision: focus goals and meeting overloads then get that free time in their P4 rank order from the automation list (`automations-overview.md` rule 8). At one rank the meeting overload goes first.
30. A habit, task chunk or flexible meeting may take time from an unlocked focus event. The focus event then moves to other free time (E-0077).
31. Focus events never take time from any external event, booking-link meeting, locked event, habit, task chunk, flexible meeting or buffer.
32. For booking-link availability, a placed focus event counts as P2. Only a P1 booking link may offer that time. When `offer_to_booking_links=false`, no booking link offers it (E-0077, E-0141, E-0078).
33. Focus events respect `#tl_busy` blocks as busy. Proposed: focus may be placed inside a busy `#tl_free` block, like tasks and habits (open question 6).
34. The scheduler never moves a locked focus event or a past focus event.
35. When the goal cannot be reached, the planner shows "goal not reached" with the missing hours. Proposed text. It does not list one unplaced item per missing block.
    Tempoloom decision: above the week, the planner shows "<title>: X h of Y h this week." per focus goal, with the counted time of that week, and adds "Goal not reached: N h missing." when the last plan could not reach the goal for that week.

## Outputs

- Focus events on `target_calendar`: title from `title`, opaque (busy), visibility from the field, description from `description` plus the managed-event footer. Title markers follow `events-title-emoji.md`.
- Planner: weekly progress toward the goal (counted hours versus goal) and the "goal not reached" notice.
- Decline responses with a note, when auto-decline is on.
- Team settings: the team focus template and its status for each member.

## Edge cases

1. `daily_max_hours × allowed days` is less than `weekly_goal_hours`: the form warns that the goal cannot be reached. Proposed.
2. Free gaps are all shorter than `min_block_minutes`: no focus events. The planner shows "goal not reached" (E-0077).
3. A recurring external event in the wrong category inflates or hides counted time. The user fixes the category (E-0077).
4. The user deletes a locked focus event: rule 21 applies.
5. Two focus automations both want to protect the same free range: Tempoloom writes one focus event, not two. Proposed.
6. A day with an all-day busy or out-of-office event: no focus events that day. See `events-out-of-office.md`.
7. A native Google "focus time" event exists on the calendar: it counts toward the goal and Tempoloom does not change it.

## Observed API shapes

Not yet observed.

## Open questions

1. Does the current focus goal automation still offer a reactive mode, or does the meeting overload automation fully replace it?
2. Which events count as meetings for the meeting overload limits?
3. How early does the meeting overload automation start to protect time before a limit is reached?
4. After a focus event is deleted, are its hours re-placed elsewhere in the week?
5. Do focus events get the busy title marker, or a focus-specific marker?
6. May focus events be placed inside a `#tl_free` no-meeting block?
7. Which tasks count toward the goal: all work tasks, or only placed chunks?
8. Defaults for goal, daily limits and block sizes in the current version.
9. Does the focus goal automation have a target calendar in the current version?

## Acceptance tests

Common setup: Google Calendar test account, home time zone America/New_York,
work hours Monday to Friday 09:00 to 17:00, scheduling window 2 weeks, no
habits or tasks unless stated. Test week starts on a Monday at least 2 days
in the future.

1. **Weekly goal is placed.**
   Setup: empty calendar.
   Action: create a focus goal automation: weekly goal 10 hours, daily min 2, daily max 4, block 60 to 240 minutes. Apply the staged changes in preview mode.
   Expected: the test week has opaque "Focus Time" events totalling 10 hours, each 60 to 240 minutes long, no day above 4 hours, each weekday at least 2 hours.
   Reload: reload the planner and re-read Google Calendar. Same events. The planner shows 10 of 10 hours.

2. **Counted habits reduce focus.**
   Setup: scenario 1 done.
   Action: add a work habit "Coding" on Monday and Tuesday, 09:00 to 11:00, 120 minutes, P3.
   Expected: Monday and Tuesday have no focus events, because the habit gives each of them 2 counted hours. Wednesday, Thursday and Friday have 2 hours of focus each. Counted time for the week is 10 hours.
   Reload: totals persist.

3. **Accepted conflict moves focus.**
   Setup: scenario 1 done. Pick a Tuesday focus event F.
   Action: from a second test account, invite the test user to a meeting overlapping F. Accept it.
   Expected: within 60 seconds, F moves to other free time. The weekly total stays 10 hours.
   Reload: the new placement persists. The invitation stays accepted.

4. **Unanswered invite does not move focus.**
   Setup: scenario 1 done.
   Action: invite the test user to a meeting overlapping a focus event. Do not answer.
   Expected: the focus event stays in place.
   Reload: the same.

5. **Move locks, delete skips.**
   Setup: scenario 1 done.
   Action: in Google Calendar, move Wednesday's first focus event 1 hour later. Delete Thursday's first focus event.
   Expected: Wednesday's event stays at the new time and shows as locked. No focus event appears again in Thursday's deleted range.
   Reload: both states persist.

6. **Booking link priority.**
   Setup: scenario 1 done. Create a P2 booking link and a P1 booking link, both using work hours.
   Action: open each public booking page for the test week.
   Expected: the P2 link does not offer focus-event times. The P1 link offers them.
   Reload: reload both pages. Same result.

7. **Meeting overload limit.**
   Setup: no focus goal automation. Create a meeting overload automation with daily max 2 hours, block min 30 minutes.
   Action: on Tuesday, invite the test user to three 1-hour meetings at 09:00, 10:00 and 11:00 from a second account. Accept the first two only.
   Expected: after the second acceptance, Tuesday has 2 meeting hours. All free time on Tuesday from 11:00 to 17:00 that is at least 30 minutes long becomes opaque focus events. The third invitation overlaps a focus event. Other weekdays get no focus events.
   Reload: the focus events persist. Decline one accepted meeting. Expected: within 60 seconds, the Tuesday focus events from this automation are removed (Proposed rule 15).

8. **Auto-decline.**
   Setup: scenario 1 done with auto-decline on and message "In focus".
   Action: invite the test user to a meeting overlapping a focus event.
   Expected: the invitation is declined with note "In focus". The focus event does not move.
   Reload: the invitation stays declined.
