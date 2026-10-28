# Home and travel time zones

Spec id: SPEC-TZ-01
Evidence: E-0107 (ev_a77c88cdf915), E-0222 (ev_ab1116c8b050), E-0172 (ev_d2989bf32eaf), E-0013 (ev_0aa48b4c7229)
Status of evidence: public docs only

## Summary

Tempoloom plans in one active time zone. By default this is the user's home
time zone. The user can add travel time zones with start and end dates, so
that hours sets, managed events and booking-link availability follow the
user's local time while away and return to normal after the trip. The
planner warns when the browser time zone differs from the active zone.

## Concepts and inputs

| Field | Type | Default | Allowed values and notes |
|---|---|---|---|
| `home_tz` | IANA time zone name | the browser time zone at sign-up (E-0107) | Any IANA zone. |
| `travel_tzs` | list of `{tz, start_date, end_date}` | empty | Several entries allowed (E-0107). Dates are inclusive calendar dates. |

The active zone for an instant T is the `tz` of the travel entry whose date
range contains T's date, else `home_tz`. Proposed: the date of T is read in
`home_tz`, a travel range starts at 00:00 of `start_date` in the travel zone
and ends at 24:00 of `end_date` in the travel zone (open question 2).

Tempoloom decision: the instants decide. A trip runs from 00:00 of
`start_date` to 24:00 of `end_date`, both in the travel zone; the active zone
at an instant is the zone of the trip that holds it, else `home_tz`. Local
times jump at those instants, as at a daylight saving change: the day a trip
starts ends when the trip starts, and hours stop there. Adding, deleting or
ending an entry places all unlocked future managed events again.

## Behavior

1. Tempoloom reads hours sets (work, personal, meeting, custom and one-off windows) as local times in the active zone (E-0107). Example: work hours 09:00 to 17:00 mean 09:00 to 17:00 in Tokyo while a Tokyo travel entry is active.
2. Habits, task chunks, flexible meetings and focus events are placed in the active zone of their date (E-0107).
3. Booking links offer availability in the active zone of each date. During a travel range, the offered times follow the travel zone (E-0107).
   Tempoloom decision: the organizer's hours, day limits and the booking range use the active zone; the booking page still shows the times in the visitor's zone.
4. After `end_date`, scheduling returns to `home_tz`. Managed events after the trip are placed by home hours (E-0107).
5. The user can change `home_tz` in settings. The next scheduler run re-places unlocked future managed events (E-0107).
6. The user can add, edit and delete travel entries in the hours settings (E-0107).
7. Two travel entries must not overlap. Save fails with a field error. Proposed.
8. When the browser reports a zone that differs from the active zone, the planner shows a prompt to add a travel entry for the browser zone (E-0107).
9. When a travel entry is active and the browser reports `home_tz`, the planner shows a prompt to end the travel entry early (E-0107). Ending early sets `end_date` to yesterday, or deletes the entry if it has not started.
   Tempoloom decision: the prompts show in the notices at the top of the planner's right column (above the week at 1180 px and below). "Add travel time zone" adds an entry for the browser zone from today to a chosen date (default 6 days later). "End trip" sets `end_date` to yesterday, or deletes the entry when that date is before `start_date`. "Not now" hides a prompt for that pair of zones until the tab closes.
10. When the browser zone differs from the active zone, or a travel entry is active, the planner shows two time columns: the browser zone and the active zone (E-0107).
    Tempoloom decision: the week stays in `home_tz`. The second column shows the hours of the other zone: the travel zone while a trip is active, else the browser zone. Each column head names its city. The second column reads the hours of today, or of the first day shown.
11. When the browser reports UTC and `home_tz` is not UTC, the prompt in rule 8 says that an extension or a privacy option in the browser can make it report a wrong zone. Proposed (E-0222 lists this cause).
12. The settings page lists active and future travel entries first, so that a forgotten entry is easy to find (E-0222 lists a stale entry as a cause of wrong hours). Proposed.

### Scheduler interaction

13. Every scheduler rule that uses a local time (hours sets, ideal time, daily limits, day boundaries for daily habits, focus daily goals and meeting limits) uses the active zone of that date.
14. Locked events and external events keep their absolute instants when the zone changes. They never move because of a zone change.
15. On a day when the active zone changes, the day boundary is midnight in the zone active at the start of that day. Proposed.

## Outputs

- No calendar events of their own.
- Re-placed managed events after a zone change.
- Planner: one or two time columns, and the prompts in rules 8 and 9.
- Booking pages: availability in the active zone.

## Edge cases

1. A daylight saving change inside a travel range: local hours stay the same wall-clock times.
2. A travel entry with `end_date` before `start_date`: save fails.
3. Travel to a zone with the same offset as home: no visible change.
4. An hours range that crosses midnight after conversion: Proposed: it stays within the local day as defined in the active zone.

## Observed API shapes

Not yet observed.

## Open questions

1. Is `home_tz` taken from the browser or from the Google Calendar setting? E-0107 says browser; E-0172 says hours use the Google Calendar zone.
2. At which instant does a travel entry start and end?
3. Can a travel entry carry its own hours set?
4. Do flexible meetings with other attendees also shift to the travel zone?

## Acceptance tests

Common setup: Google Calendar test account, `home_tz` America/New_York, work
hours Monday to Friday 09:00 to 17:00, a habit "Standup prep" every weekday
09:00 to 10:00, 30 minutes, ideal 09:00. A booking link on work hours. Test
week starts on a Monday at least 2 days ahead.

1. **Travel zone shifts placement.**
   Action: add a travel entry Asia/Tokyo for Tuesday to Thursday of the test week.
   Expected: on Tuesday to Thursday, "Standup prep" starts at 09:00 Tokyo time (20:00 New York time on the previous day). Monday and Friday stay at 09:00 New York time.
   Reload: the same instants in Google Calendar.

2. **Booking link follows travel.**
   Setup: scenario 1 done.
   Action: open the booking page.
   Expected: on Tuesday to Thursday, offered slots fall between 09:00 and 17:00 Tokyo time.
   Reload: the same.

3. **Delete travel entry.**
   Setup: scenario 1 done.
   Action: delete the travel entry.
   Expected: within 60 seconds, Tuesday to Thursday "Standup prep" returns to 09:00 New York time.
   Reload: the same.

4. **Overlap is rejected.**
   Action: add two travel entries with overlapping dates.
   Expected: the second save fails with a field error. Nothing changes on the calendar.
   Reload: only the first entry exists.
