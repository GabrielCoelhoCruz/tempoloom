# Booking link availability

Spec id: SPEC-LINK-02
Evidence: E-0198 (ev_b7863b5cff36), E-0163 (ev_aa5715921a1a), E-0165 (ev_24e80a7bfae3), E-0063 (ev_1f870480468c), E-0066 (ev_e85176d32a5d), E-0065 (ev_02ad624a317c), E-0217 (ev_cec6f530162a), E-0167 (ev_a812e5ee818f), E-0173 (ev_cc5ae996c9b1), E-0007 (ev_e10aa7cec1e9), E-0141 (ev_d12320a15a83), E-0104 (ev_173e10d4937f), E-0090 (ev_4a54fa9f235a), E-0201 (ev_182273bc4ff5)
Status of evidence: public docs only

## Summary

This spec defines which start times a booking link offers to a booker, for
each duration. A time is offered only when it passes a fixed list of checks:
the booking range, the per-day and per-week limits, start intervals, hours,
buffers, conflicts, and the priority rule. The priority rule lets a
higher-priority link offer time that lower-priority flexible events use.
Organizers can open an availability inspector that shows, for any time, each
check that failed.

## Concepts and inputs

Inputs of one availability request:

| Input | Source |
|---|---|
| link settings | SPEC-LINK-01 |
| `duration` | the duration the booker picked (one of the link's durations) |
| `from`, `to` | the date range the page asks for |
| `now` | server time |
| required organizers | link `organizers` with `required` true; round-robin pool members per SPEC-LINK-04 |
| each organizer's events | all connected calendars of that organizer (SPEC-LINK-01 open question 2) |
| each organizer's hours | the hours chosen for that organizer on the link (E-0063, E-0066) |
| each organizer's start minutes | SPEC-MEET-03 |
| each organizer's buffer settings | `buffers-automation.md`, `buffers-travel.md` |
| bookings of this link | for the limits |

Event classes used by the checks (for one organizer):

| Class | Members | Blocks a time? |
|---|---|---|
| Free | any event whose free/busy is free, including a free event with `#tl_busy` | never (E-0165, E-0217) |
| Booked | events created by any booking link | always (E-0165, E-0141) |
| Fixed | busy external events at their default priority P1; away (out-of-office) time; locked managed events; focus events with `offer_to_booking_links` false | always (E-0165, E-0141, E-0104; `events-out-of-office.md` rule 14; `planning-priorities.md` PRI-32; `focus-time.md` rule 32) |
| Prioritized | busy managed events (tasks, habits, flexible meetings, focus time) and busy external events whose priority the user lowered | when their priority is equal to or higher than the link priority (E-0165, E-0163; `planning-priorities.md` PRI-30) |
| Buffer | managed travel, recovery and prep buffer events | when their priority is equal to or higher than the link priority (`buffers-automation.md` rule 25); legacy evidence treats them as always blocking (E-0198) |

Notes on classes:

- A busy event with `#tl_free` is busy for meetings, so it is Fixed
  (E-0201; `events-tags.md` rule 4).
- External events copied from other calendars, or on calendars other than
  the primary, stay P1 (E-0104).
- Placed focus time counts as P2 for links. So only a P1 link can offer it
  (E-0141, E-0090; `focus-time.md` rule 32).
- Locked managed events are Fixed, because they cannot move (Proposed in
  `planning-priorities.md` PRI-32).
- An invitation the organizer declined does not block. Proposed: an
  invitation with no answer blocks (a booking is final, so the check is
  strict).

### Reason codes

| Code | Meaning | Evidence |
|---|---|---|
| `past` | the start is before `now` | E-0198 |
| `beforeRangeStart` | the start is before the link's earliest bookable time | E-0198 |
| `afterRangeEnd` | the start is after the link's latest bookable date | E-0198 |
| `limitReached` | the day or week already has the maximum number of bookings of this link | E-0198 |
| `startInterval` | the start minute is not allowed for one required organizer | E-0198, E-0167 |
| `outsideHours` | the slot is not fully inside the hours of one required organizer | E-0198 |
| `buffer` | the slot overlaps a buffer event, or leaves no room for a needed buffer | E-0198, E-0063 |
| `conflict` | the slot overlaps a Booked or Fixed event of one required organizer | E-0198 |
| `higherPriority` | the slot overlaps a Prioritized event whose priority is equal to or higher than the link priority | E-0198 |

## Behavior

### Candidate times

1. Tempoloom builds candidate starts every 15 minutes, aligned to the hour
   in UTC, between `from` and `to` (Proposed). Rule 7 then removes starts
   whose minute is not allowed.
2. Each candidate is the slot from the start to start plus `duration`.
3. Each duration of the link has its own list of times (E-0217).
4. A candidate is offered when no check below fails. Tempoloom evaluates
   all checks for the inspector, and stops at the first failure for the
   booking page (Proposed, for speed).

### Checks

5. `past`: the start is earlier than `now`.
6. Range (E-0063, E-0198):
   - `beforeRangeStart`: the start is earlier than the range start.
     `rolling`: `now` plus the amount. `nextDay`: 00:00 of the first day
     after today that has hours for all required organizers. `nextWeek`:
     00:00 of the first day of next week. `date`: 00:00 of that date. Days
     and weeks use the main organizer's time zone and week start (Proposed).
   - `afterRangeEnd`: the start date is after the range end. `rolling`:
     today plus N days, N at most 100. `date`: that date.
7. `startInterval`: the start minute, read in each required organizer's
   time zone, is not in that organizer's start minutes (E-0167, E-0198).
8. `outsideHours`: the slot is not fully inside the link hours of each
   required organizer (E-0063, E-0198). Optional organizers are not checked
   (E-0063, E-0066, E-0163).
9. `limitReached`: the count of non-cancelled bookings of this link on the
   start's day is at least `maxPerDay`, or in the start's week at least
   `maxPerWeek`. Day and week use the host's time zone (E-0063, E-0198).
   When a week is full, every time of that week fails (E-0198).
10. `buffer` (E-0063, E-0198):
    - the slot overlaps a Buffer event of a required organizer whose
      priority is equal to or higher than the link priority; or
    - `bufferBefore` minutes before the slot, or `bufferAfter` minutes after
      it, are not free for each required organizer; or
    - `useRecoveryBuffer` is on and the organizer's recovery buffer after
      the slot is not free; with several organizers, Tempoloom uses the
      longest recovery buffer among them (E-0063); or
    - `useTravelBuffer` is on, the chosen or default location is an
      address, and the organizer's travel time before the slot, or after
      it, is not free (E-0063).
    "Free" here uses the same class rules as rules 11 and 12.
11. `conflict`: the slot overlaps a Booked or Fixed event of a
    required organizer (E-0198, E-0165, E-0141).
12. `higherPriority`: the slot overlaps a Prioritized event of a required
    organizer whose priority is equal to or higher than the link priority
    (E-0198, E-0165, E-0163). So:
    - a P1 link offers time over P2, P3 and P4 events;
    - a P2 link offers time over P3 and P4 events;
    - a P3 link offers time over P4 events;
    - a P4 link offers only time with no busy event (E-0165, E-0163).
13. Free events never fail a check (E-0165).
14. The check uses the calendar state at request time. When the calendar
    changes, the next request shows the change (E-0007).

### Preferred times

15. An offered time is preferred when no event of any class, including free
    events, overlaps it on any required organizer's calendars (E-0066,
    E-0217). The page marks preferred times with a green dot
    (SPEC-LINK-03).

### Team and round-robin links

16. Team link: every check runs for every required organizer; the time is
    offered only when all pass. The link priority is the same for all
    organizers (E-0066, E-0163).
17. Round-robin link: the checks for the required organizers must pass, and
    at least one pool member must pass the same checks. Details are in
    SPEC-LINK-04 (E-0065, E-0163).

### Availability inspector

18. A logged-in user who is an organizer or co-organizer of the link sees an
    "inspect availability" switch on the booking page. Bookers who are not
    logged in, and other users, do not see it (E-0198, E-0173).
19. With the switch on, the date picker allows every date from today to
    the link's range end plus 14 days (Proposed range), and each day lists
    every candidate start, including the ones that are not offered (E-0198).
    Tempoloom decision: a day lists every 15-minute start from the first
    start to the last end of the hours of all the link's people on that day,
    so the night is not listed; a day without hours lists no times.
20. Each time that is not offered shows one colored dot per failed check
    (E-0198). Proposed colors: grey for `past`, `beforeRangeStart`,
    `afterRangeEnd`; orange for `limitReached`, `startInterval`,
    `outsideHours`; purple for `buffer`; red for `conflict`; blue for
    `higherPriority`.
21. A click on a time expands it. For each failed check it shows the reason
    text, the organizer it applies to, the blocking event title when the
    viewer may see it, and a link to the setting that controls the check
    (E-0198, E-0173). Setting links: link range, link limits, the
    organizer's start minutes, the organizer's hours, buffer settings, the
    blocking event's Planner entry (to lower its priority), the link
    priority.
    Tempoloom decision: the viewer sees event titles only of their own
    events; another organizer's event shows as "a busy event". Setting
    links: range, limits and buffers open the link editor; hours open the
    viewer's Settings (own hours only); a conflict or higher-priority event
    of the viewer opens the Planner week of that event; higher priority also
    links the link editor (link priority). Past times are marked `past`
    only, not also `beforeRangeStart`. The switch state is kept in the URL
    (`inspect=1`).
22. The inspector never changes availability. It only shows it.

### Scheduler and other calendars

23. Availability reads the current managed events from the scheduler's last
    saved schedule. It does not run the scheduler (Proposed, for speed).
24. Offering a time over a Prioritized managed event is a promise: when
    someone books it, the scheduler moves that event (SPEC-LINK-01 rule 23).
25. An external event with lowered priority is never moved. A booking only
    overlaps it (E-0104).
26. Organizers' calendars are read with each organizer's stored tokens.
    Co-organizers must be Tempoloom users in the same team (E-0066, E-0163).

## Outputs

- `GET` availability response for one link, one duration and one date
  range: the list of offered starts, each with a `preferred` flag.
- Inspector response (organizers only): every candidate start with the list
  of failed reason codes, the organizer each code applies to, and the
  blocking event id when there is one.
- No calendar writes.

## Edge cases

1. A link with no required organizers and an empty round-robin pool: no
   time is offered (Proposed).
2. An organizer with hours in another time zone: hours are read in that
   organizer's zone; a slot can pass for one organizer and fail for another.
3. A slot that starts inside the hours and ends after them: `outsideHours`.
4. A slot that ends exactly when a busy event starts: offered (intervals are
   half-open).
5. A Prioritized event at P2 on a P2 link: not offered (equal priority
   blocks).
6. Daylight-saving gap: a local time that does not exist is not a candidate.
7. `rangeEnd` rolling 100 days and `maxPerWeek` reached in some weeks: only
   those weeks are empty.
8. A recurring external event where one instance's priority was lowered and
   the series was not: only that instance is Prioritized (E-0104).
9. All-day events: they follow their free/busy value. Google writes most
   all-day events as free, so they do not block (Proposed).

## Observed API shapes

Not yet observed.

## Open questions

1. Can a booking link offer the time of a locked managed event? This spec
   follows the Proposed answer of `planning-priorities.md` PRI-32 (no).
2. Does an unanswered invitation block a booking-link time?
3. How does `nextDay` treat a day with no hours: skip to the next day with
   hours, or use the next calendar day?
4. Is `rangeEnd` checked against the start or against the end of the slot?
5. What step does the reference use for candidate starts when all four start
   minutes are allowed?
6. Does away time block every link? This spec follows the Proposed rule
   of `events-out-of-office.md` rule 14 (yes, always).
7. What are the reason labels and colors in the reference inspector? The
   public page shows only the descriptions.

## Acceptance tests

Test accounts: A is a Tempoloom user, meeting hours Monday to Friday 09:00 to
17:00, start minutes :00 and :30. C is a second Tempoloom user in A's team,
meeting hours 13:00 to 17:00. The booker uses a private browser window. All
dates are in the next calendar week.

1. Priority rule
   - Setup: A has a busy external event "Standup" Tuesday 10:00 to 11:00
     whose priority A lowered to P3, and a busy external event "Review"
     Tuesday 11:00 to 12:00 at the default P1. Links L1 (P1), L2 (P2), L4
     (P4), each 30 minutes.
   - Action: open each booking page for Tuesday.
   - Expected: L1 offers 10:00 and 10:30 but not 11:00 or 11:30. L2 offers
     10:00 and 10:30. L4 offers neither 10:00 nor 10:30.
   - Reload: after A sets "Standup" to P2 and the pages reload, L2 no
     longer offers 10:00 and 10:30; L1 still does.
2. Booked events always block
   - Setup: a booking from link L4 exists Tuesday 15:00 to 15:30.
   - Action: open L1 for Tuesday.
   - Expected: L1 does not offer 15:00.
   - Reload: same after reload.
3. Range and limits
   - Setup: link with `rangeEnd` rolling 7 days and `maxPerDay` 1. Book one
     slot on Wednesday.
   - Action: open the page.
   - Expected: no time on Wednesday; no time after today plus 7 days.
   - Reload: after the Wednesday booking is cancelled and the page reloads,
     Wednesday offers times again.
4. Team link hours
   - Setup: team link with A and C both required, 30 minutes.
   - Action: open the page for Tuesday.
   - Expected: only 13:00 to 16:30 starts are offered.
   - Reload: after C is marked optional and the page reloads, 09:00 to 16:30
     starts are offered.
5. Inspector
   - Setup: test 1 setup. A is logged in.
   - Action: open L4 for Tuesday, switch on the inspector, click 10:00.
   - Expected: 10:00 shows `higherPriority` with the title "Standup" and a
     link to its Planner entry. 11:00 shows `conflict`. 08:00 shows
     `outsideHours`. In a private window the switch is absent.
   - Reload: after reload the switch is off by default (Proposed).
6. Preferred times
   - Setup: A has a free external event Tuesday 09:00 to 10:00 and nothing
     else on Tuesday. Link L4.
   - Action: open the page for Tuesday.
   - Expected: 09:00 and 09:30 are offered without the preferred dot; 10:00
     and later have the dot.
   - Reload: same after reload.
7. Travel buffer
   - Setup: link with one `address` location and `useTravelBuffer` on. A's
     travel buffer is 30 minutes. A has a busy external event Tuesday 09:00
     to 10:00.
   - Action: open the page for Tuesday.
   - Expected: 10:00 is not offered; 10:30 is offered.
   - Reload: same after reload.
