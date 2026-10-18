# Priority of external events

Spec id: SPEC-EVENTS-05
Evidence: E-0104 (ev_173e10d4937f), E-0141 (ev_d12320a15a83), E-0090 (ev_4a54fa9f235a), E-0142 (ev_8d542e73bb87)
Status of evidence: public docs only

## Summary

Every external event has a priority. By default it is P1, so no managed item
ever takes its time. The user may lower the priority of an external event on
the primary calendar. A lowered event still never moves for tasks, habits,
focus, buffers or flexible meetings; it only lets a booking link of higher
priority offer that time to invitees. This gives important booking links more
availability. The general priority rules are `planning-priorities.md` PRI-30 to
PRI-45; this spec details the user-facing feature and agrees with them.

## Concepts and inputs

| Field | Type | Default | Notes |
|---|---|---|---|
| `priority` on an external event | P1 to P4 | P1 (E-0104, E-0141) | Settable only for events on the primary calendar of the main account (E-0104). |
| scope of a change | `this_event` or `all_events` | asked each time | For recurring events (E-0104). |

Events that come from calendar mirroring or from other connected calendars
are always P1. The user cannot change them (E-0104).

## Behavior

1. A new external event gets priority P1 (E-0104, E-0141). This includes events the user created and invitations the user accepted (E-0141).
2. In the planner, the user selects an external event on the primary calendar and sets a priority from the side panel (E-0104).
3. For a recurring event, the planner asks whether the change applies to this event or to all events in the series (E-0104).
4. For mirrored events and events on other connected calendars, the priority control is disabled with a note that these stay P1 (E-0104).
5. A booking link of priority P offers a slot that overlaps an external event of priority Q only when P is higher than Q (E-0104, E-0141). Example: a P1 link may offer the time of a P3 team standup; a P2 link may not.
6. When an invitee books such a slot, Tempoloom does not move or change the external event. The user now has an overlap, and the planner shows it as a conflict (Proposed; E-0141 says a conflict is flagged with a suggested fix).
7. Tempoloom never sends updates to the other attendees of an external event when its priority changes. The priority is stored only in Tempoloom. Proposed (open question 1).
8. When an accepted external event overlaps another fixed event, Tempoloom flags the conflict in the planner and suggests a fix. It moves neither event (E-0141).

### Scheduler interaction

9. An external event is fixed. No managed item (task chunk, habit, focus event, buffer, flexible meeting) may take its time, whatever the external event's priority or the item's priority (E-0104, E-0141, E-0142).
10. External event priority is an input only for booking-link availability (rule 5).
11. A meeting booked through a booking link is fixed and is never overbooked by any managed item, at any priority (E-0141, E-0090).

## Outputs

- No calendar changes.
- Planner: a priority control on external events, a scope prompt for series, and conflict notices.
- Booking pages: more offered slots when external events have lower priority.

## Edge cases

1. A lowered recurring event whose series later changes time: the priority stays with the series. Proposed.
2. An external event moved to another calendar: it keeps its stored priority if it stays on the primary calendar; else it becomes P1. Proposed.
3. An external event that is free: it does not block anything, whatever its priority.

## Observed API shapes

Not yet observed.

## Open questions

1. Does changing an external event's priority write anything to the event (for example an extended property) or notify attendees? The public FAQ title asks this, but its answer was not captured.
2. When an invitee books over a lowered external event, does the reference product move, decline or keep the external event?
3. Can the user lower the priority of events on secondary calendars in the current version?

## Acceptance tests

Common setup: Google Calendar test account, home time zone America/New_York,
work hours Monday to Friday 09:00 to 17:00. A P1 booking link "Urgent" and a
P2 booking link "Normal", both 30 minutes on work hours. A recurring external
event "Standup" every weekday 10:00 to 10:30, created by the test user, busy.

1. **Default protects the event.**
   Action: open both booking pages.
   Expected: neither offers 10:00 on any weekday.
   Reload: the same after reload.

2. **Lowered event opens time for higher links only.**
   Action: in the planner, set "Standup" to P3 for all events in the series.
   Expected: "Urgent" offers 10:00 on weekdays. "Normal" still does not.
   Reload: the priority and the offers persist.

3. **Managed items still avoid it.**
   Setup: scenario 2 done. A P1 habit "Prep" with a one-off window 10:00 to 10:30 on weekdays, 30 minutes, `when_unplaceable=remove`.
   Expected: "Prep" is not placed at 10:00 on any weekday.
   Reload: the same.

4. **Booking over a lowered event.**
   Setup: scenario 2 done.
   Action: book "Urgent" at 10:00 next Tuesday from a second account.
   Expected: the booked meeting is on the calendar at 10:00 to 10:30. "Standup" is unchanged. The planner shows a conflict on Tuesday 10:00.
   Reload: both events persist unchanged.

5. **Mirrored events stay P1.**
   Setup: a mirrored copy of an event from a second calendar.
   Action: open it in the planner.
   Expected: the priority control is disabled and shows P1.
   Reload: the same.
