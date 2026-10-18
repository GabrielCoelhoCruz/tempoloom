# Raycast extension

Spec id: SPEC-INT-11
Evidence: E-0152 (ev_15215a75fbbb), E-0034 (ev_2e66d179324e), E-0137 (ev_2dae93b7631b), E-0040 (ev_b03e2564a184), E-0062 (ev_6a4045895d23), E-0166 (ev_b9b1c0dd7702), E-0210 (ev_653ff766226f)
Status of evidence: public docs only

## Summary

Raycast is a command launcher for macOS. With the Tempoloom Raycast
extension, the user creates tasks, copies booking links and sees today's
events in the macOS menu bar. The user can also join meetings and start or
finish work on tasks and habits without the web app. The extension is a
macOS-only client of the Tempoloom API.

## Concepts and inputs

### Scope and evidence

Most detail comes from legacy evidence; the current pages confirm the same
command set.

### Fields

Authentication:

- Current version: the user signs in from the extension, which opens the
  Tempoloom OAuth consent in the browser. (The reference only says that the
  extension guides the user through sign-in.)
- Legacy evidence: the user pastes a personal API key
  (`integrations-api-keys-zapier.md`) into the extension preferences, or
  when a command first asks for it.

Extension preferences:

| Field | Type | Default | Notes |
|---|---|---|---|
| `instance_url` | URL | none | Tempoloom server base URL. Needed because Tempoloom is self-hosted. (Proposed.) |
| `api_key` | secret | none | Legacy flow only. |
| `upcoming_events_count` | integer 1 to 20 | 5 (Proposed default) | Events shown in the menu bar list. |
| `default_booking_link` | booking link id or none | none | Current version mentions default booking links. |
| `menu_bar_auto_refresh` | bool | true | Raycast's own background refresh. |

Commands:

| Command | Purpose |
|---|---|
| Calendar Menu Bar | Next event and today's events in the macOS menu bar. |
| My Calendar | List of upcoming events with free or busy state. |
| Create Task | Task form. |
| Quick Task | One-line task text. |
| Booking Links | List, copy and share booking links. |

Create Task form fields: title; priority; time needed (total duration);
minimum chunk duration; maximum chunk duration; hours set; starting
(start-after); due date; notes (markdown); "send to next up" toggle.

## Behavior

### Install and sign in

1. The user installs the extension from the Raycast Store and runs any of
   its commands. The extension asks for the instance URL, then signs in.
2. Legacy flow: the user creates an API key in Tempoloom, then pastes it in
   the extension preferences or when a command asks for it. To replace the
   key, the user creates a new key in Tempoloom and pastes it in the
   extension preferences.

### Calendar Menu Bar

3. The user activates the Calendar Menu Bar command once. The menu bar then
   shows the current or next event title and the time left until it starts,
   updated every second.
4. Clicking it expands a list of the next `upcoming_events_count` events of
   today.
5. Each event in the list offers, on hover: join meeting (when it has a
   conference link), start or complete (task chunks and habit events), and
   open in Google Calendar.
6. The menu also has "Open Tempoloom" (the web app) and "Open Raycast".
7. The menu refreshes in the background. The user can also refresh it by
   running the command again.
8. The user deactivates the command in the Raycast preferences.

### My Calendar

9. Lists upcoming events. Each shows its free or busy state. Actions: start
   or stop a task chunk or habit event, and join a meeting.

### Create Task

10. Opens the task form with the fields above. Submit with the form button
    or Command+Enter.
11. Tempoloom creates the task and the scheduler places it like any task
    (`planning-tasks.md`).
12. After creation, the extension copies a link to the new task to the
    clipboard and shows a confirmation.

### Quick Task

13. The user types one line in this form:
    `<work|personal> task <title> (for <duration>, by <due>, snooze <not before>)`.
    The type and title are required. The parenthesized part is optional and
    each item in it is optional.
14. `for` sets the total duration. `by` sets the due date and time. `snooze`
    sets the start-after as a duration from now (such as `1hr`) or as a date.
    Durations and dates use the task sync spec grammar.
15. The extension then opens the task form, filled with the parsed values.
    The user submits it as in rule 10.
16. Example: `work task Prep board slides (for 4h, by 10am Monday, snooze
    1hr)` gives a 4-hour work-hours task, due Monday 10:00, that starts no
    earlier than 1 hour from now.

### Booking Links

17. Lists the user's booking links. The detail pane shows hours set,
    organizers and duration.
18. Enter copies the selected link URL to the clipboard.
19. The action "Personalize and share" (Command+K menu) opens the web app's
    one-off link form for that booking link. One-off links expire after 30
    days (`booking-links-sharing.md`).

### Hotkeys

20. Raycast lets the user set a hotkey for any command. This is a Raycast
    feature; the extension needs no code for it.

### Uninstall

21. The user uninstalls the extension in the Raycast preferences. Proposed
    default: Tempoloom lists the extension's OAuth grant (or API key) in
    account settings, where the user can revoke it. Tasks, habits, booking
    links and events stay.

## Outputs

- Tasks created through the API, with their chunks.
- Start, stop and complete actions on task chunks and habit events (same
  effect as in the Planner).
- Clipboard content: task link, booking link URL.

## Edge cases

1. The menu bar has no room (too many items, or the camera notch): macOS
   hides the item. The extension cannot detect this; documentation tells the
   user to rearrange items with Command-drag.
2. No events left today: the menu bar shows "No more events today".
   (Proposed text.)
3. The API key expired or was revoked: commands show "Sign in again" and
   open the sign-in flow.
4. Quick Task without a type word: show an error under the input and do not
   create a task.
5. The user has no booking links: the command shows an empty state with a
   link to create one in the web app.

## Observed API shapes

Not yet observed. The extension needs these API operations: list today's
and upcoming events with free or busy state and conference link; start,
stop and complete a task chunk or habit event; create a task; list booking
links with details; get a booking link URL.

## Open questions

1. How does the current extension authenticate: OAuth or API key?
2. Which "task behavior" preferences does the current extension have?
3. Does the current extension still have Quick Task and My Calendar?
4. Does the menu bar show events from all calendars, or only the main one?

## Acceptance tests

Common setup: macOS machine with Raycast and the extension signed in to a
Tempoloom user with a Google Calendar test account.

1. Create a task from the form.
   - Action: run Create Task; title "Prep slides", time needed 2 hours,
     priority P2, due in 3 work days; submit.
   - Expected: a task appears in the web app with those values. Chunks
     totaling 2 hours appear in Google Calendar before the due date. The
     clipboard holds the task link.
   - Reload: reload the web app and Google Calendar; values remain.
2. Quick Task.
   - Action: run Quick Task with `work task Prep board slides (for 4h, by
     10am Monday, snooze 1hr)`; submit the filled form.
   - Expected: a 4-hour task due Monday 10:00 in work hours, with no chunk
     earlier than 1 hour after creation.
   - Reload: same after reload.
3. Menu bar next event.
   - Setup: a busy event starts in 20 minutes.
   - Action: activate Calendar Menu Bar.
   - Expected: the menu bar shows the event title and a countdown near 20
     minutes. The list shows today's next events.
   - Reload: run the command again; the same event shows.
4. Start a task chunk from the menu bar.
   - Setup: a task chunk is the current event.
   - Action: hover the chunk in the menu bar list and choose Start.
   - Expected: the task shows as in progress in the web app, as if started
     in the Planner.
   - Reload: reload the web app; the state remains.
5. Copy a booking link.
   - Action: run Booking Links, select a link, press Enter.
   - Expected: the clipboard holds the link URL; opening it shows the
     booking page.
   - Reload: not applicable; no calendar change.
