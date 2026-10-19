# Notifications and reminders

Spec id: SPEC-PLANNING-11
Evidence: E-0043 (ev_d7b30359b03e), E-0051 (ev_936bc1052a22), E-0052 (ev_3db8b91a422f), E-0125 (ev_c3865619996c), E-0158 (ev_5682619fc975)
Status of evidence: public docs only

## Summary

Tempoloom tells the user about upcoming events in the browser and controls
the calendar reminders of managed events. It can also send change notices to
attendees of flexible meetings. Reminders on managed events follow the
calendar's default reminders, with fixed exceptions by event kind.

## Concepts and inputs

### General settings (E-0125)

| Setting | Values | Default |
|---|---|---|
| `tabAlert` | on, off | Proposed default: on |
| `startChime` | on, off | Proposed default: off |
| `weeklyReport` | on, off | stats spec |

### Flexible meeting settings (E-0125)

| Setting | Values | Default |
|---|---|---|
| `meetingChangeEmails` | on, off | Proposed default: on |
| `meetingChangeDaysAhead` | integer days | Proposed default: 7; range 0 to 30 (Proposed default) |

### Reminders on managed events (E-0125)

| Event kind | Calendar reminders |
|---|---|
| Calendar mirroring copies | always off |
| Habit events | on (calendar default) |
| Flexible meeting events | on (calendar default) |
| Task chunks, including tasks from integrations | on (calendar default) |
| Travel buffer events | always on |
| Recovery buffer events | always off |
| Break buffers | always off (they are not events, E-0052) |

Current reference: each automation has a reminders setting in its event
settings; the user can change or turn off reminders per automation (E-0043,
E-0051).

## Behavior

### In-app alerts

- **NTF-1.** With `tabAlert` on, when an event starts, the browser tab title
  of the open Tempoloom page flashes the event name (E-0125).
  Tempoloom decision: at the start of a timed event that the user attends,
  or of a managed event, the tab title shows "▶ " and the event name, and
  changes back and forth every second for 30 seconds. Each start alerts once
  per tab, also after a reload. Both settings are under "Alerts" in Settings.
- **NTF-2.** With `startChime` on, the open Tempoloom page plays a short
  sound when the next event starts. The browser may need permission to play
  sound; Tempoloom shows a hint when playback is blocked (E-0125).
  Tempoloom decision: the chime is two short notes made in the browser (no
  audio file). When the browser blocks sound, a hint asks the user to click
  the page, and the next click allows it. With several tabs, the tab focused
  last plays it (edge case 1).
- **NTF-3.** In-app alerts work only while a Tempoloom page is open.
  Proposed default.

### Calendar reminders

- **NTF-10.** "On (calendar default)" means Tempoloom creates the event with
  the calendar's default reminders. The user changes those defaults in Google
  Calendar settings for that calendar (E-0125). Google's own default is
  10 minutes before.
- **NTF-11.** "Always off" means Tempoloom creates the event with no
  reminders. "Always on" means Tempoloom creates the event with the
  calendar's default reminders and does not allow a per-item override.
  Proposed default for "always on".
- **NTF-12.** Habit and flexible meeting events are recurring series in
  Google Calendar. The user can turn off reminders for one series by editing
  the series in Google Calendar; Tempoloom keeps that change (E-0125).
- **NTF-13.** To give task chunks other reminders than the primary calendar,
  the user sends chunks to another calendar with other default reminders
  (`planning-hours.md` HRS-12) (E-0125).
- **NTF-14.** Current reference: in each automation's event settings, the
  user sets reminders: calendar default, custom minutes, or none (E-0043,
  E-0051). Proposed default: the per-kind table above is the initial value.
- **NTF-15.** Tempoloom never deletes the user's reminders on external
  events. Proposed default.

### Flexible meeting change notices

- **NTF-20.** With `meetingChangeEmails` on, when Tempoloom moves, reschedules
  or cancels a flexible meeting occurrence, Google sends its standard update
  email to attendees (E-0125). Implementation: the Google Calendar API
  `sendUpdates` parameter.
- **NTF-21.** Tempoloom sends these notices only for occurrences that start
  within `meetingChangeDaysAhead` days. Changes further out are silent
  (E-0125).
- **NTF-22.** With `meetingChangeEmails` off, Tempoloom changes the events
  without update emails (E-0125).
- **NTF-23.** For Outlook calendars the notices cannot be turned off (E-0125).
  Tempoloom targets Google Calendar first; Outlook is out of scope here.

### Planned notices (not yet in the reference)

- **NTF-30.** The reference announces two notices that do not exist yet: a
  daily summary of flexible meetings that may fail to get a slot within two
  weeks, and an email listing new recurring meetings that could become
  flexible meetings (E-0125). Tempoloom does not need them for parity.
- **NTF-31.** The current reference sends a morning review digest by email,
  chat app or both (E-0158). Assistant chat spec owns it.

## Outputs

- Browser tab title flash and sound.
- Google events with `reminders.useDefault` true, or with an empty override
  list, per the table.
- Google update emails to attendees for flexible meetings.

## Edge cases

1. The user has two Tempoloom tabs open: only one plays the chime. Proposed
   default: the tab that was focused last.
2. A flexible meeting is moved twice in one hour: each move sends a notice if
   it is inside `meetingChangeDaysAhead`. Proposed default.
3. The calendar has no default reminders: "on" events get no reminders.
4. The user sets `meetingChangeDaysAhead` to 0: no change emails are sent.
   Proposed default.

## Observed API shapes

Not yet observed.

## Open questions

1. Default values of `tabAlert`, `startChime`, `meetingChangeEmails` and
   `meetingChangeDaysAhead` are not in the evidence.
2. Are reminders of focus time events on or off by default?
3. Does a user reminder change on one chunk survive the next chunk move?

## Acceptance tests

Fixture F0 from `planning-scheduler.md`. Primary calendar default reminder:
popup 10 minutes.

1. **Task chunk uses calendar defaults.** Action: create task "AT-NT1",
   60 minutes. Expected: the Google event has `reminders.useDefault` true.
   Reload: same.
2. **Recovery buffer has no reminder.** Setup: recovery buffer automation
   15 minutes after meetings; an accepted external meeting Monday W 10:00 to
   11:00. Expected: the buffer event at 11:00 has `useDefault` false and no
   overrides. Reload: same.
3. **Change notice inside the threshold.** Setup: `meetingChangeEmails` on,
   `meetingChangeDaysAhead` 7; a flexible meeting with a second test account
   as attendee, next occurrence in 2 days. Action: create a P1 external event
   over the occurrence. Expected within 60 s: the occurrence moves and the
   attendee mailbox receives a Google update email. Reload: same.
4. **No notice outside the threshold.** Setup: as test 3 with
   `meetingChangeDaysAhead` 1 and the occurrence in 5 days. Action: as test 3.
   Expected: the occurrence moves; no update email arrives within 5 minutes.
5. **Tab alert.** Setup: `tabAlert` on; task "AT-NT5" chunk starting in
   2 minutes (hours AT-Always). Action: keep the planner open. Expected: at
   the start time the tab title shows "AT-NT5".
