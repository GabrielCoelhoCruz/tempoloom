# Personal stats and time tracking

Spec id: SPEC-ANALYTICS-01
Evidence: E-0180 (ev_fca85fcae16d), E-0011 (ev_eeadbdf09079), E-0183 (ev_000dae433420), E-0148 (ev_e7b99cd896e0), E-0215 (ev_91f415d61c95), E-0074 (ev_b5ca2d13ca39), E-0076 (ev_b70225a1a49a), E-0003 (ev_fdf25af08b9c)
Status of evidence: public docs only

## Summary

Stats show a user how their calendar time splits across meetings, solo
work, breaks, travel, personal time and time off. The user picks a date
range, past or future, and a grouping by day or week. In the current
version the reference calls this view "insights" and adds patterns such as
days full of meetings and focus time split into short pieces. Users can
also ask assistant
chat about their stats. The detailed panel list comes from legacy docs.

## Concepts and inputs

### Report controls

| Field | Type | Default | Allowed |
|---|---|---|---|
| `view` | enum `mine`, `team` | `mine` | `team` is in `analytics-team-stats.md`. |
| `range` | date range | last 2 weeks (proposal) | Quick picks: last 2 weeks, last 4 weeks, last 12 weeks. Custom start and end. Future dates allowed. History back to 12 weeks (legacy evidence). |
| `grouping` | enum `auto`, `day`, `week` | `auto` | `week` groups by work week. `auto` picks day for ranges up to 2 weeks and week for longer ranges (proposal). |

### Time categories

Stats use the event categories of `events-categories-and-colors.md`. That
spec owns the detection rules; stats must not add their own. Each minute of
calendar time inside the range counts in at most one stats bucket:

| Stats bucket | Source |
|---|---|
| One-on-one meetings | category `one_on_one` |
| Team meetings | category `team_meeting` |
| External meetings | category `external_meeting` |
| Solo work (split into deep and shallow) | category `solo_work` |
| Personal | categories `personal` and `personal_commitment` |
| Travel | categories `travel` and `flight`, except recovery buffers |
| Breaks | recovery buffers and break buffers (by managed event type, whatever their category) |
| Vacation | category `vacation` |
| Free | time inside work hours with no event |

The breaks bucket follows the legacy stats, which count breaks between
meetings on their own. The legacy weekly report uses three wider buckets:
meetings (all three meeting categories), solo work and personal.

### Deep work and shallow work

| Term | Rule |
|---|---|
| Solo session | A run of solo work time with no gap. Two solo events that touch form one session (proposal). |
| Deep work | A solo session of 2 hours or more. |
| Shallow work | A solo session shorter than 2 hours. |

The legacy evidence says "over 2 hours" and "under 2 hours". A session of
exactly 120 minutes counts as deep work (proposal).

## Behavior

### Report panels (legacy evidence unless marked)

1. Time breakdown: average hours per day or per week (per `grouping`) for
   one-on-ones, team meetings, external meetings, deep work, shallow work,
   breaks, travel and vacation. Hover shows the hour value of each part.
2. Time breakdown trend: one stacked bar per day or week over the range.
   Hover shows the hours of each category in that bar.
3. Work habits and tasks: hours of work-tagged habit events and task
   events per day or week.
4. Focus time: deep work hours and shallow work hours. A weekday heat map
   colors each weekday by its average solo work time. The weekday with the
   most solo work time is highlighted as the most productive day.

   Tempoloom decision: the stats page shows a "Time by category" panel with
   the buckets of the category table (deep and shallow work apart, time away
   as "Time away"), next to the earlier time breakdown. Time away counts the
   work hours it covers. Breaks are all buffers except travel and airport
   buffers, which count as travel. The chosen range stays in the page
   address (`/stats?from=&to=`), so a reload keeps it.
5. Work-life balance: hours of personal habits, hours of meetings that fall
   outside the user's work hours, and vacation hours.
6. People met (personal view only): a list of people the user met in the
   range, each with the total meeting time together, sorted by time,
   largest first.

   Tempoloom decision: a person counts with the full length of each meeting
   the user attends with them (flexible meetings included); people with the
   same time are sorted by email.
7. Meeting breakdown: average time in team meetings, external meetings and
   one-on-ones. The weekday with the most meeting time and the weekday with
   the least are highlighted.

   Tempoloom decision: the weekday with the least meeting time is chosen
   among weekdays with work hours; on a tie, the earlier weekday.
8. Highlights: total hours of focus time that managed events held, number
   of meetings booked through booking links, hours of break buffers between
   meetings, and hours of travel buffers.

### Ranges

9. The user can choose a past range, a future range, or a range that spans
   today. Future ranges use the events on the calendar now, including
   managed events. This supports capacity planning.
10. The earliest start date is 12 weeks before today (legacy evidence). A
    custom range that starts earlier is refused with a message.
11. Stats are read-only. Opening stats never changes a calendar event.

### Current-version insights

12. The current version presents stats as "insights". Insights must at
    least show: meetings versus focus time, workload spread across the
    week, days with many meetings, focus time in short pieces, and repeat scheduling
    patterns and routines.
13. Fragmented focus time is solo work time in sessions shorter than
    2 hours (proposal; same threshold as shallow work).

    Tempoloom decision: the insights panel shows meetings against solo work,
    the average busy time per weekday, the days with many meetings (3 or
    more, or 4 hours or more), solo work in pieces shorter than 2 hours, and
    repeat events (the same series or title twice or more in the range).
14. The user can ask assistant chat questions about their own stats (for
    example where their meeting time went last week). Chat answers use the
    same numbers as the stats view (`assistant-chat.md`).

### Time tracking

15. The time a task or habit actually took comes from its managed events
    and from time the user logs by hand. Logging rules belong to the task
    spec (`planning-task-progress.md`). In legacy evidence, the user logs time by clicking an empty slot
    in the planner and picking a task or habit, and "mark done" on an event
    records its time.
16. Marketing pages also list "planned versus actual" and per-event-type
    time. Proposed: planned time is the managed event time that was on the
    calendar at the start of the day; actual time is the event time at the
    end of the day plus logged time.

    Tempoloom decision: planned time is rebuilt from Tempoloom's change log
    (`support-troubleshooting.md` rule 12), per kind of item; actual time is
    the managed event time still on the calendar for that day. Only days
    that have ended count. Logged time is not added yet: logged minutes are
    stored per task, not per day.

## Outputs

- Stats page with the panels above.
- No calendar events are created or changed.

## Edge cases

1. An event the user declined does not count.
2. An event marked free (for example a managed event set to free) still
   counts in its category; free/busy does not change the category
   (proposal).
3. Two overlapping events: count each minute once, in the category of the
   event that started first; on a tie, the longer event (proposal).
4. All-day events other than vacation do not count toward hours (proposal).
5. A range with no events shows zeros, not an error.
6. Time zone: the report uses the user's home time zone for day boundaries.
7. A meeting outside work hours counts in its meeting category and also in
   the work-life balance "outside work hours" figure.

## Observed API shapes

Not yet observed.

## Open questions

1. What panels does the current insights view show, and is the 12-week
   history limit still in place?
2. Do recovery buffers count as breaks or as travel? The category spec
   puts them under travel; the legacy stats show breaks between meetings
   as their own figure. This spec counts them as breaks.
3. Do two touching solo events form one deep work session?
4. Do declined, tentative and free events count?
5. Is personal stats gated in the current version? The pricing page puts
   "productivity stats and time tracking" in paid tiers and weekly reports in
   all tiers.
6. Marketing pages promise AI advice on how to get more focus. What does
   it produce, and where?

## Acceptance tests

Common setup: Google test account U on domain `example-a.test`, home time
zone fixed, work hours Mon to Fri 09:00 to 17:00. In the week before last
(week W), U's Google calendar has:

- Mon 10:00 to 11:00: one-on-one with V (same domain).
- Mon 13:00 to 13:30: team meeting with three same-domain colleagues.
- Tue 15:00 to 15:45: meeting with one attendee at `example-b.test`.
- Wed 09:00 to 11:30: event "Write spec", no attendees (150 minutes).
- Wed 14:00 to 15:00: event "Email", no attendees (60 minutes).
- Thu 18:00 to 19:00: team meeting with three same-domain colleagues.
- Fri: all-day Google out-of-office event.

### T1. Weekly totals

- Setup: common setup.
- Action: U opens stats, range = week W, grouping = week.
- Expected calendar state: no event on U's calendar changes.
- Reload check: after reload, the report shows one-on-one 1.0 h, team
  meetings 1.5 h, external 0.75 h, deep work 2.5 h, shallow work 1.0 h,
  vacation equal to one workday (8 h, proposal), meetings outside work
  hours 1.0 h. People met lists V with 1.0 h.

### T2. Daily grouping and highlights

- Setup: common setup.
- Action: U sets grouping = day for week W.
- Expected calendar state: no change.
- Reload check: after reload, the trend has five bars; Wednesday is the most
  productive day; Monday is the heaviest meeting day with 1.5 h (Thursday
  has 1.0 h, Tuesday 0.75 h).

### T3. Future range

- Setup: common setup, plus a team meeting next Tuesday 10:00 to 11:00.
- Action: U picks a custom range covering next week.
- Expected calendar state: no change.
- Reload check: after reload, next week shows team meetings 1.0 h.

### T4. History limit

- Setup: common setup.
- Action: U enters a custom start date 13 weeks ago.
- Expected calendar state: no change.
- Reload check: the range is refused with a message; after reload the
  previous valid range is shown.
