# Travel buffers and airport time

Spec id: SPEC-BUFFERS-02
Evidence: E-0052 (ev_3db8b91a422f), E-0049 (ev_6802f9e5e02c), E-0051 (ev_936bc1052a22), E-0207 (ev_b37f118a61e9), E-0203 (ev_6fcb5f8189d7), E-0085 (ev_afb3719f0f6f), E-0087 (ev_7a786863692c), E-0009 (ev_46057eca8fbd)
Status of evidence: public docs only

## Summary

A travel buffer is a busy managed event before and after an event that has a
physical location, so other meetings cannot fill the time the user needs to
travel to and from the place. Flights get a longer airport buffer. The user can force a
travel buffer, or a flight buffer, with an event tag. Travel buffers are
built on the buffer automation in `buffers-automation.md`; this spec adds the
location, flight and tag rules.

## Concepts and inputs

| Field | Type | Default | Allowed values and notes |
|---|---|---|---|
| `travel_enabled` | bool | `false` | Master switch. Tags work only when it is on (E-0207, E-0203). In the current version the switch is "a travel buffer automation exists and is enabled" (E-0051). |
| `travel_minutes` | int | Proposed default: 30 | The default travel length, used on both sides. 5 to 240, step 5 (Proposed range). The user sets it (E-0052, E-0049). |
| `flight_minutes_before` | int | 120 | Observed (E-0052, E-0207, E-0203). |
| `flight_minutes_after` | int | 60 | Observed (E-0052, E-0207, E-0203). |
| `title` | string | "Travel" (Proposed) | Event title. The travel marker is added (see Outputs). |
| `calendar_scope` | calendar id or `all` | primary calendar of the main account | Legacy scope is the primary calendar, including mirrored copies on it (E-0052). Current automations can choose one calendar or all (E-0051). |
| `priority`, `rank`, `on_conflict`, `reminders` | as in `buffers-automation.md` | same defaults | |

Tags used here (full rules in `events-tags.md`):

- `#tl_travel`: force a travel buffer on this event.
- `#tl_flight` (Proposed name): mark the event as a flight and add the airport buffer.

## Behavior

### Which events get travel time

1. An event gets travel buffers when it is an anchor (busy, not declined, not all-day, inside `calendar_scope`; see `buffers-automation.md` rule 7) and one of these is true:
   - its location looks like a physical address (rule 2);
   - its title, description or the user's RSVP note contains `#tl_travel` (E-0207, E-0203);
   - its category is flight, or it has `#tl_flight` (rule 5).
2. A location counts as a physical address only if it has two or more commas. "1 Oak Ave, Springfield, IL 62701" counts. "1 Oak Ave, Springfield" does not (legacy evidence, E-0052). A location that is only a URL never qualifies. Proposed: a location that is a known video-conference room name never qualifies.
3. Tempoloom never looks up the address in a map service and never computes real travel time. Every travel buffer uses `travel_minutes` (E-0052).
4. An event that matches both the address rule and the flight rule gets only the flight buffers.

### Flights

5. An event is a flight when one of these is true:
   - the user set its category to flight in the planner (E-0052);
   - it has `#tl_flight` (E-0207, E-0203);
   - Tempoloom detects it as a flight. Proposed detection: the event comes from a mail-generated flight reservation, or its title matches a flight-number pattern such as two letters and 1 to 4 digits (open question 1).
6. A flight gets a buffer of `flight_minutes_before` ending at the flight start and `flight_minutes_after` starting at the flight end (E-0052, E-0207).
7. `#tl_flight` also sets the event category to flight (E-0207, E-0203).

### Placement and updates

8. Travel buffers follow the placement, follow, conflict and edit rules of `buffers-automation.md` rules 8 to 17.
9. Tempoloom does not place a travel buffer where a busy event already blocks the range (E-0052).
10. When the anchor moves, its travel buffers move with it (E-0052).
11. When the user lengthens or shortens a travel buffer event, Tempoloom keeps the new length (E-0052).
12. When the anchor loses its address, tag and flight category, Tempoloom deletes its travel buffers.
13. On a mirrored copy whose mirroring policy hides title, location and description, Tempoloom cannot see the address or tags, so the copy gets no travel buffer from them (E-0207).

### Scheduler interaction

14. Travel buffers are buffers. They use the scheduler rules in `buffers-automation.md` rules 22 to 28.
15. Proposed default priority for the travel template: P2, so that habits and tasks of P3 and P4 move out of the way. Airport time: P1 (E-0051 recommends P1 for buffers that must not be lost).

## Outputs

- Travel buffer events: title `🚌 <title>` (E-0085), opaque, category travel and logistics (E-0087).
- Visibility: public on the primary calendar, so others see a travel event (E-0052). On a mirrored calendar, the visibility follows that mirroring policy (E-0052).
- Flight events: the planner shows the flight category, and Tempoloom adds the flight marker "✈️" to the flight event title when it may edit that event (E-0085). It does not edit events it may not change (see `events-categories-and-colors.md` edge cases).

## Edge cases

1. A location with two commas that is not a place, for example "Room 4, floor 2, HQ": it qualifies. The user can remove the buffer by deleting it (buffers rule 15) or by narrowing the filter.
2. A multi-day event with an address: Proposed: buffers before the start and after the end only.
3. An event on a calendar outside the scope: no buffer, even with `#tl_travel`.
4. `#tl_travel` while travel is off: no buffer (E-0207).
5. Two consecutive events at the same address: each gets its own buffers; the buffer between them is skipped when the gap is too small (buffers rule 10).
6. The user declines an event with an address: its buffers are deleted.

## Observed API shapes

Not yet observed.

## Open questions

1. How does the reference product detect flights automatically?
2. Is the two-comma address rule still used in the current version?
3. Can the user set different lengths before and after for normal travel?
4. Does the current travel template default to one calendar or all calendars?
5. What are the default priority and conflict setting of the travel and airport templates?

## Acceptance tests

Common setup: Google Calendar test account, home time zone America/New_York,
work hours Monday to Friday 09:00 to 17:00, travel template enabled with
`travel_minutes=30`, scope primary calendar. Test day is a weekday at least
2 days ahead.

1. **Address adds travel time.**
   Setup: empty test day.
   Action: create a busy event 13:00 to 14:00 with location "1 Oak Ave, Springfield, IL 62701".
   Expected: within 60 seconds, events "🚌 Travel" 12:30 to 13:00 and 14:00 to 14:30, opaque, public.
   Reload: both persist.

2. **Short address is ignored.**
   Action: create a busy event 10:00 to 11:00 with location "1 Oak Ave, Springfield".
   Expected: no travel buffers.
   Reload: still none.

3. **Tag forces travel.**
   Action: add `#tl_travel` to the description of the scenario 2 event.
   Expected: travel buffers 09:30 to 10:00 and 11:00 to 11:30.
   Reload: both persist.

4. **Flight tag.**
   Action: create a busy event "UA 123 to SFO #tl_flight" 15:00 to 17:00.
   Expected: buffers 13:00 to 15:00 and 17:00 to 18:00. The event shows the flight category in the planner.
   Reload: buffers and category persist.

5. **Buffers follow the event and keep a manual length.**
   Setup: scenario 1 done.
   Action: in Google Calendar, extend the first travel buffer to 12:15 to 13:00. Then move the anchor to 14:00 to 15:00.
   Expected: the travel buffers are 13:15 to 14:00 (45 minutes, kept) and 15:00 to 15:30.
   Reload: the same.

6. **Busy event blocks travel time.**
   Action: create a busy event 11:30 to 12:00, then a busy event with an address 12:00 to 13:00.
   Expected: no buffer before 12:00. One buffer 13:00 to 13:30.
   Reload: the same.

7. **Travel off.**
   Action: disable the travel template. Create an event with `#tl_travel`.
   Expected: no buffer. Earlier travel buffers in the future are deleted.
   Reload: the same.
