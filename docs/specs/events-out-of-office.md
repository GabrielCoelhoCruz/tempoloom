# Out of office, vacation and holidays

Spec id: SPEC-EVENTS-02
Evidence: E-0111 (ev_da4073591415), E-0023 (ev_dfeca2f754da), E-0201 (ev_182273bc4ff5), E-0203 (ev_6fcb5f8189d7), E-0015 (ev_5930c31b8eb4)
Status of evidence: public docs only

## Summary

The user marks time away in Google Calendar the normal way: a busy all-day
event, or a Google out-of-office event. Tempoloom then keeps tasks, habits,
flexible meetings and focus out of that time, and records it as vacation or
a personal commitment in stats. A tag keeps tasks and habits on those days
when the user wants. A company holiday calendar works when its events are
busy and the user accepts them.

## Concepts and inputs

An "away event" is one of these, on a calendar that Tempoloom reads for
availability (E-0111):

- an all-day event marked busy;
- a Google Calendar event of the out-of-office type (created in Google
  Calendar, for example by typing "OOO" in the title of an all-day event);
- a timed out-of-office event.

Readable calendars: the primary calendar of the main account, and other
calendars whose events are mirrored into it with the mirroring option that
copies all-day events turned on (E-0111; the option name is in the
`sync-calendar-mirroring.md`).

| Derived value | Rule |
|---|---|
| Away category | An out-of-office span shorter than 8 hours is a personal commitment. A span longer than 8 hours is vacation (E-0111). Exactly 8 hours: Proposed vacation. |

## Behavior

1. During an away event, the scheduler treats the time as busy for every managed item: task chunks, habit occurrences, flexible meetings, focus events and buffers (E-0111, E-0023).
2. Habit occurrences on a fully away day are skipped for that day. Tempoloom does not keep them as conflicts, whatever `when_unplaceable` says. Proposed (E-0111 says "skip or reschedule").
3. Task chunks and flexible meetings that were on the away time move to other free time by their own rules (E-0111).
4. Focus goals do not count away days as allowed days. Proposed: the weekly goal is not reduced (open question 2).
5. An all-day event marked free has no effect on scheduling (E-0111). The planner shows it, but the scheduler ignores it.
6. When an away event carries `#tl_free` in its title, tasks and habits may still be placed in its time. Other people still see the user as away. Flexible meetings and booking links still treat it as busy (E-0111, E-0201, E-0203).
7. Stats record away time as vacation or personal commitment by the 8-hour rule (E-0111).
8. When the chat app integration is on, Tempoloom sets the user's chat status to away during an out-of-office event and can send an auto-reply message when someone mentions the user in a public channel. Details are in `integrations-slack.md` (E-0111).

### Company holidays

9. Tempoloom ignores free all-day holiday events, as in rule 5 (E-0111).
10. A company can share a holiday calendar whose all-day events are busy and that invites a company mailing list. When the user answers yes or maybe, the holiday is an away event for that user (E-0111).
11. Tempoloom does not read Google's built-in public holiday calendars. The user can subscribe to a custom holiday feed and add it as a calendar that Tempoloom reads (E-0111).

### Scheduler interaction

12. Away events are fixed, busy, P1 external events. They are never moved and never overbooked by any managed item.
13. Locked managed events that fall inside an away event stay where they are. Proposed: the planner shows them as conflicts.
14. A booking link never offers away time, whatever its priority. Proposed.

## Outputs

- No new calendar events.
- Moved or removed managed events, by the rules above.
- Stats: away time under vacation or personal commitment.
- Planner: away days are shaded. Proposed.

## Edge cases

1. An away event created on a secondary calendar that is not mirrored and not read: no effect (E-0111).
2. A multi-day out-of-office event: each covered day is away. Partial first and last days are away only for the covered hours.
3. The user deletes the away event: the next run places items on those days again.
4. An out-of-office event with `#tl_free` in the description only: no effect, because Google out-of-office events have no description (E-0203). Tempoloom reads only the title for them.

## Observed API shapes

Not yet observed.

## Open questions

1. Does a skipped habit occurrence on an away day try another day in the same week?
2. Does the weekly focus goal shrink for away days?
3. Does a timed busy event (not out-of-office type) of more than 8 hours count as vacation?
4. Which mirroring option makes all-day events count, and what is its default?
5. Team out-of-office calendar (E-0023): which events does it copy, and to which calendar? This belongs to `teams-ooo-calendar.md`.

## Acceptance tests

Common setup: Google Calendar test account, home time zone America/New_York,
work hours Monday to Friday 09:00 to 17:00. A habit "Lunch" every weekday
11:30 to 14:00, 30 to 60 minutes, ideal 12:00. A task "Draft" of 2 hours due
on Friday of the test week. Test week starts on a Monday at least 2 days
ahead.

1. **All-day busy event.**
   Action: create an all-day busy event "Vacation" on Tuesday.
   Expected: Tuesday has no "Lunch" and no "Draft" chunk. "Draft" is placed on other days of the test week, by its due date.
   Reload: the same.

2. **Free all-day event is ignored.**
   Action: create an all-day free event "Holiday" on Wednesday.
   Expected: Wednesday keeps "Lunch" at 12:00 to 13:00.
   Reload: the same.

3. **Google out-of-office event.**
   Action: create a Google out-of-office event Thursday 09:00 to 17:00.
   Expected: Thursday has no "Lunch" and no "Draft" chunk. Stats show 8 hours of vacation for Thursday (Proposed for exactly 8 hours).
   Reload: the same.

4. **Out of office with `#tl_free`.**
   Action: change the Thursday out-of-office title to "OOO #tl_free".
   Expected: within 60 seconds, Thursday gets "Lunch" again. The out-of-office event is unchanged for other people.
   Reload: the same.

5. **Short out-of-office.**
   Action: create a Google out-of-office event Friday 14:00 to 16:00.
   Expected: no managed item is placed 14:00 to 16:00 on Friday. Stats show 2 hours of personal commitment.
   Reload: the same.
