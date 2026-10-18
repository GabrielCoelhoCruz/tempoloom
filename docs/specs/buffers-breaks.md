# Break buffers between tasks and habits

Spec id: SPEC-BUFFERS-03
Evidence: E-0052 (ev_3db8b91a422f), E-0049 (ev_6802f9e5e02c), E-0009 (ev_46057eca8fbd)
Status of evidence: public docs only

## Summary

A break buffer keeps a gap between task and habit events so that Tempoloom
does not place them back to back. The gap is empty time, not a calendar event.
The user picks one gap length for the account. The detailed rules are legacy
evidence; current marketing still lists breaks between tasks and habits
(E-0009).

## Concepts and inputs

| Field | Type | Default | Allowed values and notes |
|---|---|---|---|
| `break_minutes` | int or `none` | `none` (Proposed) | Chosen from a list (E-0052). Proposed list: none, 5, 10, 15, 20, 30. |

The setting sits in the user's buffer settings, next to recovery and travel
(E-0052).

## Behavior

1. When `break_minutes` is set, Tempoloom keeps at least `break_minutes` of empty time between the end of one task chunk or habit event and the start of the next task chunk or habit event (legacy evidence, E-0052).
2. The gap is not an event. Tempoloom writes nothing to the calendar for it (E-0052).
3. The gap applies only between two managed task or habit events. It does not apply between a task or habit and an external event, a flexible meeting, a focus event or a buffer. Proposed (open question 1).
4. The gap does not apply between two chunks of the same task when the scheduler would merge them into one event. Proposed.
5. A locked task or habit event keeps its time even when the gap to its neighbor is too short. Tempoloom then moves the unlocked neighbor, if it can.
6. When a task chunk or habit occurrence cannot fit with the gap, the scheduler treats it as having no slot there. It does not drop the gap to make it fit. Proposed (open question 2).

### Scheduler interaction

7. The break gap is a hard spacing constraint inside the scheduler: for any two placed task or habit events A and B on the same day, `B.start - A.end >= break_minutes` or `A.start - B.end >= break_minutes`.
8. The constraint applies in every scheduler run and to every priority.
9. Changing `break_minutes` triggers a scheduler run. Unlocked task and habit events may move.
10. The gap does not count as busy time for booking links, focus goals or meeting limits.

## Outputs

- No calendar events.
- Planner: the gap shows as empty time between task and habit events.

## Edge cases

1. A habit with `duration_min` equal to its window length next to a task: the task moves away; the habit keeps its slot if its priority is higher.
2. Two events on different calendars (work and personal): the gap still applies. Proposed.
3. `break_minutes` larger than every free gap of a day: tasks and habits that need that day may become unplaced. The planner shows them as unplaced with reason "no room".

## Observed API shapes

Not yet observed.

## Open questions

1. Does the gap also apply between tasks or habits and focus events, flexible meetings or external meetings?
2. Can the scheduler drop the gap on a full day to keep a task or habit on the calendar?
3. Which lengths does the list offer, and does the current version keep this setting or replace it with a buffer automation template?

## Acceptance tests

Common setup: Google Calendar test account, home time zone America/New_York,
work hours Monday to Friday 09:00 to 17:00. Test day is a weekday at least
2 days ahead.

1. **Gap between habit and task.**
   Setup: `break_minutes=15`. An external busy event on the test day from 10:45 to 17:00. Habit "Email": one-off window 09:00 to 12:00 on the test day, 30 minutes, ideal 09:00, P2. Task "Report": 60 minutes, minimum chunk 60 minutes, P3, due at the end of the test day.
   Action: let the scheduler run.
   Expected: "Email" 09:00 to 09:30. "Report" 09:45 to 10:45. No event exists for the gap.
   Reload: the same times.

2. **Gap blocks a fit, and turning it off frees it.**
   Setup: as scenario 1, but the external busy event starts at 10:30.
   Action A: let the scheduler run. Action B: set `break_minutes` to none.
   Expected after A: "Email" 09:00 to 09:30. "Report" is not placed on the test day, because 30 + 15 + 60 minutes do not fit in 90 minutes.
   Expected after B: within 60 seconds, "Report" is at 09:30 to 10:30.
   Reload: the state after B persists.

3. **Gap not applied to external events.**
   Setup: `break_minutes=15`. External busy event 10:00 to 11:00. Habit "Walk" one-off window 11:00 to 11:30, 30 minutes.
   Action: let the scheduler run.
   Expected: "Walk" is at 11:00 to 11:30, directly after the external event.
   Reload: the same.
