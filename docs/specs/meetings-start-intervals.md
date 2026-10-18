# Meeting start-time intervals

Spec id: SPEC-MEET-03
Evidence: E-0167 (ev_a812e5ee818f), E-0198 (ev_b7863b5cff36)
Status of evidence: public docs only

## Summary

The user chooses at which minutes of the hour meetings may start: on the
hour, at quarter past, at half past, or at quarter to. Tempoloom uses this
setting when it places flexible meetings and when it lists the times a
booker can pick on a booking link. More intervals give more possible times;
fewer intervals give a more regular calendar.

## Concepts and inputs

| Field | Type | Default | Allowed values | Evidence |
|---|---|---|---|---|
| `meetingStartMinutes` | set of integers, per user | Proposed: {0, 15, 30, 45} | non-empty subset of {0, 15, 30, 45} | E-0167 |

The setting is per user. It is not per meeting or per link.

## Behavior

1. The user must keep at least one interval selected. The settings form
   refuses to save an empty set (E-0167).
2. Flexible meetings: Tempoloom places and moves an occurrence only at a
   start whose minute is in the organizer's set (E-0167). Whose set applies
   for attendees is an open question in SPEC-MEET-01.
3. Booking links: the booking page offers a start time only when its minute
   is in the set of every required organizer of the link (E-0167, E-0198).
4. Rule 3 applies to every priority level and to every duration option of
   the link (E-0167).
5. The minute is evaluated in each owner's calendar time zone (Proposed).
   In a zone with an offset of 30 or 45 minutes from UTC, the same instant
   can match for one organizer and not for another.
6. A change of the set applies only to meetings placed or booked after the
   change. Tempoloom does not move existing occurrences or booked events
   because of it (E-0167).
7. The setting does not apply to buffers, focus time, habits or tasks.

### Scheduler and other calendars

8. For flexible meetings the set is a hard constraint of placement, checked
   before free/busy and priority (SPEC-MEET-01 rule 12).
9. For booking links a failed check gives the availability reason
   `startInterval` (`booking-links-availability.md`).

## Outputs

- Settings page: four checkboxes (:00, :15, :30, :45) with a short note that
  existing meetings do not move.
- Flexible meeting occurrences and booking page slots start only at allowed
  minutes.

## Edge cases

1. A team link where organizer X allows only :00 and organizer Y allows only
   :30: the link offers no start times. The availability inspector shows
   reason `startInterval` on every time (E-0198).
2. A round-robin pool member with a different set: the check runs per pool
   member; a start is offered when at least one eligible member allows it
   (Proposed, consistent with `booking-links-team.md`).
3. A duration of 45 minutes with only :00 selected: meetings start on the
   hour and end at :45; the end minute is not checked.

## Observed API shapes

Not yet observed.

## Open questions

1. What is the default set for a new user?
2. For flexible meetings, do attendees' sets also apply?
3. Is the minute evaluated in the organizer's time zone or in UTC?

## Acceptance tests

Test accounts: A is a Tempoloom user with meeting hours Monday to Friday
09:00 to 17:00 and an empty calendar next Tuesday. B is a second Google test
account that shares free/busy with A and has an empty calendar.

1. Booking link offers only allowed starts
   - Setup: A sets the intervals to {0}. A has a booking link with duration
     30 and priority P4.
   - Action: open the booking page for next Tuesday in a private browser
     window.
   - Expected: the listed starts are 09:00, 10:00, ... 16:00 only.
   - Reload: after A adds :30 and the page reloads, 09:30, 10:30, ... also
     show.
2. Flexible meeting placed on an allowed start
   - Setup: intervals {0}. A has an external busy event on Tuesday 09:00 to
     10:15. A creates a weekly flexible meeting with B, ideal Tuesday 10:00,
     30 minutes.
   - Action: save.
   - Expected: the occurrence is on Tuesday 11:00 to 11:30, not 10:15.
   - Reload: same time in Google Calendar after reload.
3. Change does not move existing meetings
   - Setup: test 2 done, then A sets intervals to {15}.
   - Action: sync.
   - Expected: next Tuesday's occurrence stays at 11:00.
   - Reload: same after reload.
