# Profile and locale settings

Spec id: SPEC-SETTINGS-01
Evidence: E-0172 (ev_d2989bf32eaf), E-0199 (ev_9b5fb0c6b1ba), E-0222 (ev_ab1116c8b050)
Status of evidence: public docs only

## Summary

Tempoloom takes the user's name, picture, time zone, week start and time
format from the Google account, and keeps them in step when they change in
Google. The user edits a few other profile fields in Tempoloom.

## Concepts and inputs

| Field | Source | Editable in Tempoloom |
|---|---|---|
| `name` | Google account | no |
| `avatarUrl` | Google account profile picture | no |
| `timeZone` | Google Calendar setting | no (change it in Google) |
| `weekStart` | Google Calendar setting | no |
| `timeFormat` | Google setting, 12 or 24 hours | no |
| `dateFormat` | Google setting, for example `dd/mm/yyyy` | no |
| `jobTitle` | user | yes |
| `company` | user | yes |
| `companySize` | user | yes |
| `useCase` | user | yes |

## Behavior

- **PRF-1.** The profile page opens from the user menu at the top right
  (E-0199).
- **PRF-2.** Tempoloom reads `name`, `avatarUrl`, `timeZone`, `weekStart`,
  `timeFormat` and `dateFormat` from Google at sign-in (E-0199).
- **PRF-3.** When one of these changes in Google, Tempoloom updates it.
  Proposed default: Tempoloom checks at each sign-in and at least once a day.
  For `timeZone`, the evidence says it updates when it changes (E-0199).
- **PRF-4.** The profile page shows a note next to each Google-sourced field:
  change it in the Google account (E-0199).
- **PRF-5.** Booking links show `avatarUrl`. If the user hides the profile
  picture from other people in Google privacy settings, Tempoloom cannot read
  it and shows no picture (E-0199).
- **PRF-6.** The planner, hours page and all date displays use `timeFormat`,
  `dateFormat` and `weekStart` (E-0199).
  Tempoloom decision: one set of rules writes every time and date that the
  user reads in the app (src/shared/formats.ts, src/web/lib/format.ts).
  `timeFormat` 24h writes "14:30", 12h writes "2:30 PM" (hour labels of the
  planner grid "2 PM"). `dateFormat` writes numeric dates as `2026-11-09`
  (YMD), `09/11/2026` (DMY) or `11/09/2026` (MDY); a time with its day is
  "Mon 09/11/2026 2:30 PM". Dates written with a month name ("9 Nov" in the
  Pomodoro and analytics charts) have no field order to choose and stay so.
  The display week (see "Which week each feature uses") sets the first day of
  the planner week, the "Today" and week links, the day order of the hours
  page, the hours previews and the item-specific days, and the Pomodoro week.
  Values of form inputs (time and date pickers) stay in the browser's format.
  Mail keeps the default formats: guests read most of it, and they have
  their own settings. Without a Google account (CalDAV) the values are the
  defaults (24h, YMD, week from Monday) until they are set.
- **PRF-7.** Hours sets use `timeZone` (E-0172; `planning-hours.md` HRS-13).
- **PRF-8.** `jobTitle`, `company`, `companySize` and `useCase` are saved when
  the user changes them (E-0199).
  Tempoloom decision: the user menu has "Profile". The page shows name,
  email, time zone and week start without inputs, with a note to change them
  in the calendar account, and the four fields, saved as each one changes.
  Choices: `companySize` 1, 2-10, 11-50, 51-200, 201-1000, 1001+; `useCase`
  work, personal, both (open question 2).

### Which week each feature uses

Tempoloom decision. Two week starts exist, and each feature uses one:

| Week | Value | Features |
|---|---|---|
| Display week | `weekStart` of the Google account (`googleWeekStart`), else the planning week start | planner week view (first day, "Today", week links, "weekdays only" stays Monday to Friday), hours page day order, hours previews, item-specific days, Pomodoro week counts |
| Planning period | the planning week start set in Tempoloom (`weekStart`, default Monday) | weekly habit periods, flexible meeting periods, cadence, skips and missed periods (`meetings-flexible.md`), meeting series, focus goals and focus progress, weekly auto-lock (LCK-30, LCK-33), policy reports, the meeting availability map, booking link weekly limits, "next week" snooze of a task |
| Calendar week | Monday to Sunday | the weekly report mail and its share page (`analytics-weekly-reports.md`), not changed here |

The planner's focus progress shows the planning week that holds most of
the days shown (the display week's Thursday).

The Google week start does not change the planning period. A period key
(for example `meeting:<id>:<week start>`) names each placed, skipped,
missed or done period. A new week start moves every key, and a switch must
move each of them with no gap and no double period: placed occurrences,
skips, pending declines and guest mail, and the cadence phase of meetings
that repeat every 2 or more weeks. A first attempt (PR 47) failed on these
points: a skipped week came back, this week's meeting was cancelled when
last Sunday held one, and a biweekly meeting anchored on a Sunday changed
its cadence. Until period keys do not depend on the week start, the
planning week stays the one set in Tempoloom, and the profile page shows
both values ("Planning week starts on", "Week start in your Google
calendar (planner and dates)").

## Outputs

- Profile page with Google fields read-only and the other fields editable.
- Date and time formats across the UI.

## Edge cases

1. The Google profile has no picture: Tempoloom shows initials. Proposed
   default.
2. The browser time zone differs from `timeZone`: Tempoloom asks whether the
   user is travelling; it never replaces `timeZone` without confirmation
   (E-0222; time zone spec owns travel zones).
3. The week start changes from Monday to Sunday: weekly goals and weekly
   auto-lock use the new start from the next week on. Proposed default.
   Tempoloom decision: this applies to the planning week start set in
   Tempoloom. A change of the Google week start changes only the display
   week, at the next calendar list sync ("Which week each feature uses").

## Observed API shapes

Not yet observed.

## Open questions

1. Time zone source conflict: Google Calendar setting (E-0172, E-0199) or
   browser (E-0222). See `planning-hours.md` open question 2.
2. Which choices exist for `companySize` and `useCase`?

## Acceptance tests

1. **Google fields are read-only.** Setup: test account with name "TL Test"
   and time zone Europe/Berlin. Action: open the profile page. Expected: name
   "TL Test" and Europe/Berlin are shown and cannot be edited; job title can
   be edited. Reload: same.
2. **24-hour format.** Setup: Google time format 24 hours. Expected: the
   planner shows "14:00", not "2pm". Action: switch Google to 12 hours and
   sign in again. Expected: the planner shows "2pm" style times.
3. **Editable field persists.** Action: set job title to "Tester". Reload:
   the field shows "Tester".
