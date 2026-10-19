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
- **PRF-7.** Hours sets use `timeZone` (E-0172; `planning-hours.md` HRS-13).
- **PRF-8.** `jobTitle`, `company`, `companySize` and `useCase` are saved when
  the user changes them (E-0199).
  Tempoloom decision: the user menu has "Profile". The page shows name,
  email, time zone and week start without inputs, with a note to change them
  in the calendar account, and the four fields, saved as each one changes.
  Choices: `companySize` 1, 2-10, 11-50, 51-200, 201-1000, 1001+; `useCase`
  work, personal, both (open question 2).

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
