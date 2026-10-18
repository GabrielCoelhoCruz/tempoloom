# Event tags and no-meeting days

Spec id: SPEC-EVENTS-01
Evidence: E-0203 (ev_6fcb5f8189d7), E-0201 (ev_182273bc4ff5), E-0161 (ev_e23f32e22a66), E-0207 (ev_b37f118a61e9), E-0111 (ev_da4073591415), E-0078 (ev_9a67805f6265), E-0083 (ev_fd7912136937), E-0052 (ev_3db8b91a422f)
Status of evidence: public docs only

## Summary

An event tag is a short marker that the user types into a calendar event.
It tells Tempoloom how to treat that event without opening the app. Tags
let the user block meetings but keep time for tasks and habits (a no-meeting
day), keep time open for meetings but closed to tasks and habits, force
travel time, mark flights and travel, count time toward focus, and skip
calendar mirroring.

## Concepts and inputs

### Tag list

| Tag | Function | Reference status |
|---|---|---|
| `#tl_free` | The event stays busy for other people, but Tempoloom treats its time as free for tasks and habits. | Observed function (E-0203, E-0201, E-0111). |
| `#tl_busy` | The event stays free for other people, but Tempoloom treats its time as busy for tasks and habits. | Observed function (E-0203, E-0161). |
| `#tl_travel` | Add travel buffers before and after the event. Needs travel on. | Observed function (E-0203, E-0207, E-0052). |
| `#tl_flight` | Mark the event as a flight and add airport buffers (120 minutes before, 60 after). | Observed function (E-0203, E-0207). Proposed name. |
| `#tl_trip` | Mark the event itself as travel and logistics. No buffer. | Observed function (E-0203, E-0207). Proposed name. |
| `#tl_focus` | Count the event toward the focus goal. | Observed function (E-0203, E-0078, E-0083). Proposed name. |
| `#tl_nosync` | Do not copy this event with calendar mirroring. | Observed function (E-0203). Full rules in `sync-calendar-mirroring.md`. |

### Where Tempoloom looks

Tempoloom reads tags in three places (E-0203, E-0207):

1. the event title;
2. the event description;
3. the user's own RSVP note on an invitation.

An out-of-office event has no description field, so its tag must be in the
title (E-0203).

### Match rule

Proposed: a tag matches when the text contains the tag as a whole token,
case-insensitive. The character after the tag must be the end of the text,
whitespace or punctuation other than `_`. So `#TL_FREE` matches and
`#tl_freedom` does not.

## Behavior

### `#tl_free` and no-meeting days

1. When a busy event carries `#tl_free`, Tempoloom leaves it busy on the calendar. Other people and booking links see the time as unavailable (E-0201, E-0203).
2. For placing task chunks and habit occurrences, the scheduler treats the event's time as free (E-0201, E-0203).
3. The scheduler does not place flexible meetings inside the event. Proposed: a no-meeting day blocks all meetings.
4. A booking link does not offer the event's time, whatever the link priority. Proposed (open question 2).
5. On an all-day busy event, `#tl_free` makes a full no-meeting day. On a timed busy event, it makes a no-meeting block for that time (E-0201).
6. On a recurring event, the tag in the series applies to every occurrence, including future ones (E-0201).
7. A no-meeting day does not delete or move meetings that already exist that day (E-0201).
8. Team no-meeting day: a user creates the tagged busy event, puts the tag in the description, and invites team members or a team mailing list. For each invitee, the event acts as a no-meeting day once the invitee answers yes or maybe (E-0201). A shared calendar of tagged events that invites the team works the same way (E-0201).
9. The tag has no effect on an event that is already free. Proposed.
10. On an out-of-office event, `#tl_free` in the title lets tasks and habits stay on those days while others see the user as away (E-0111). See `events-out-of-office.md`.

### `#tl_busy`

11. When a free event carries `#tl_busy`, Tempoloom leaves it free on the calendar. Other people and booking links see the time as available (E-0161).
12. The scheduler places no task chunk and no habit occurrence inside the event (E-0161, E-0203).
13. Flexible meetings may be placed inside the event (E-0203).
14. Quick block: when the user creates an event whose whole title is `#tl_busy` and the event is busy, Tempoloom changes the event to free within one scheduler run (E-0161).
15. Proposed: on a busy event, `#tl_busy` keeps the event busy and still blocks tasks and habits (no extra effect).

### Travel, flight and trip tags

16. `#tl_travel` adds travel buffers as in `buffers-travel.md`. It has no effect while travel is off (E-0207).
17. `#tl_flight` sets the event category to flight and adds airport buffers (E-0207, E-0203).
18. `#tl_trip` sets the event category to travel and logistics. It adds no buffer (E-0207, E-0203). Use: an errand such as giving a friend a ride.
19. On a mirrored copy whose mirroring policy hides title and description, the source event's travel tags have no effect on the copy (E-0207).

### `#tl_focus`

20. An event with `#tl_focus` in its title or description counts toward the focus goal, whether Tempoloom created it or not (E-0203, E-0078). See `focus-time.md`.

### Scheduler interaction

21. The scheduler reads tags on every event it loads, in every run. Adding or removing a tag triggers a run.
22. `#tl_free` changes only the scheduler's free/busy view for tasks and habits. All other parts (booking links, flexible meetings, meeting limits, other people) see the event as busy.
23. `#tl_busy` is a hard block for tasks and habits at every priority. A P1 task or habit never uses that time.
24. Tags never change an event's priority (see `events-external-priority.md`).

## Outputs

- No new events from `#tl_free`, `#tl_busy` or `#tl_focus`.
- `#tl_busy` quick block: the event's transparency changes from busy to free.
- `#tl_travel` and `#tl_flight`: buffer events, see `buffers-travel.md`.
- `#tl_flight` and `#tl_trip`: category change, so the color follows the color rule.
- Planner: a tagged event shows a small badge with the tag function. Proposed.

## Edge cases

1. An event with both `#tl_free` and `#tl_busy`: Proposed: `#tl_busy` wins, since it is the safer choice for meeting time.
2. An event with `#tl_travel` and `#tl_flight`: only the flight buffers (see `buffers-travel.md` rule 4).
3. A tag inside a URL or a word, such as `x#tl_free`: Proposed: does not match; the character before the tag must be the start of the text, whitespace or punctuation.
4. The user removes a tag: the effect ends in the next run. Buffers from travel tags are deleted.
5. A tag in someone else's RSVP note: ignored. Only the user's own note counts.
6. Others can read tags if they can see event details (E-0203). The settings page states this.

## Observed API shapes

Not yet observed.

## Open questions

1. Does the reference product match tags case-insensitively and as whole words?
2. Do booking links of P1 offer time inside a `#tl_free` event?
3. May focus events or flexible meetings be placed inside a `#tl_free` event?
4. For a team no-meeting day, does an unanswered invitation already count?
5. What names should Tempoloom use for the flight, trip and focus tags? This spec proposes `#tl_flight`, `#tl_trip` and `#tl_focus`.

## Acceptance tests

Common setup: Google Calendar test account, home time zone America/New_York,
work hours Monday to Friday 09:00 to 17:00. A habit "Coding" every weekday,
one-off window 09:00 to 17:00, 120 minutes, ideal 10:00, P3. A P1 booking
link on work hours. Test day is a Wednesday at least 2 days ahead.

1. **No-meeting day.**
   Action: create an all-day busy event "No meetings #tl_free" on the test day.
   Expected: the event stays busy. "Coding" stays on the test day at 10:00 to 12:00. The booking page shows no slots on the test day.
   Reload: the event is still busy, "Coding" is still placed, and the booking page still shows no slots.

2. **Weekly no-meeting day.**
   Action: change the event in scenario 1 to repeat weekly.
   Expected: next Wednesday also keeps "Coding", and the booking page shows no slots there.
   Reload: the same.

3. **Busy for tasks and habits, free for people.**
   Action: create a free event "Office hours #tl_busy" on the test day 09:00 to 13:00.
   Expected: within 60 seconds, "Coding" moves out of 09:00 to 13:00 (to 13:00 to 15:00). The event stays free. The booking page offers slots inside 09:00 to 13:00.
   Reload: the same.

4. **Quick block.**
   Action: create a busy event with title exactly `#tl_busy` on Thursday 14:00 to 16:00.
   Expected: within 60 seconds, the event becomes free. No habit is placed in 14:00 to 16:00.
   Reload: the event is still free.

5. **Tag in the RSVP note.**
   Setup: travel template enabled with 30 minutes.
   Action: from a second account, invite the test user to a Thursday meeting 10:00 to 11:00 with no location. Accept it with the RSVP note `#tl_travel`.
   Expected: travel buffers 09:30 to 10:00 and 11:00 to 11:30.
   Reload: buffers persist.

6. **Focus tag.**
   Setup: a focus goal automation with weekly goal 4 hours and no other work items.
   Action: create an own busy event "Design review prep #tl_focus" Monday 09:00 to 11:00.
   Expected: the planner shows 2 counted hours from the tagged event. Tempoloom places 2 more hours of focus events, not 4.
   Reload: the totals persist.
