# Google Calendar E2E run, 2026-10-19

The first full E2E run against Google Calendar. The parity table
(`docs/parity.md`) reads the result from `docs/e2e-google-run.tsv`: a row is
"done (Google)" when it is "done (CalDAV)" and every test that proves it
passed in this run.

- Date: 2026-10-19 (start 18:18:56 UTC, duration 30.2 minutes)
- Commit: `113bc6a969e121aa214dd2091f55bef214256023` (origin/main)
- Backend: Google user with OAuth. The owner's test account approved the
  access once in a browser; the helper revoked the token at exit.
- Command:

  ```bash
  TEMPOLOOM_E2E_GOOGLE_AUTH=oauth scripts/e2e-google.sh --reporter=line,json
  ```

  with the OAuth callback on port 8798.
- Playwright 1.64.1, 288 tests: **128 passed, 0 failed, 0 flaky, 160 skipped**.
  The skipped tests need several users, extra calendars, incoming
  invitations or the CalDAV server itself; the Google driver skips them.

`docs/e2e-google-run.tsv` starts with a line `# commit <sha>` (the commit
above), then lists every test of the run: status (`passed` or `skipped`), test
id (`file:line` at the commit above) and title.

To make the file again from the run's Playwright JSON report (a local file, not
committed):

```bash
node scripts/google-run-tsv.ts <report.json> <commit> > docs/e2e-google-run.tsv
python3 scripts/build-parity.py
```

Each test key in `scripts/build-parity.py` (`T`) is the exact title of one
test, so a key matches the line with that title. The build stops and names the
key when a key is not the title of a test in `tests/e2e`, or when it matches
more than one line. A key with no line was added after the run. A row is
"done (Google)" only when each of its keys matches a passed test whose
source did not change after the run.

The build compares the `test(...)` call of each passed test at the run commit
(`git show <commit>:<file>`, found at the test id) with the call that has the
same title in `tests/e2e` now. It ignores indent and blank lines. When the call
differs, the test "changed after the Google run" and its rows fall back to
"done (CalDAV)" with that reason, until a new Google run passes it. The check
needs the run commit in the clone, so the CI checkout fetches the full history
(`fetch-depth: 0`).

## Passed tests

- `tests/e2e/automations.spec.ts:47` the automation list groups every type by priority, filters by type, and keeps focus time in P4 (rules 1, 6-10; PRI-54)
- `tests/e2e/automations.spec.ts:113` dragging an automation changes its rank or its priority, and the scheduler follows the new order (rules 7, 14, 16; AT 2)
- `tests/e2e/automations.spec.ts:172` turning an automation off removes its future events and keeps its settings; remove asks first, then deletes it and its future events (rules 11-13; AT 4)
- `tests/e2e/automations.spec.ts:230` a library entry opens the shared form with its preset; Added follows the template, so a rename keeps it and a hand-made automation with the same name does not get it (rules 1-3; library rule 4)
- `tests/e2e/booking-emails.spec.ts:51` booking, reschedule and cancel email the booker and the organizer, each in their own time zone, with the actions for the booker only (rules 14, 16, 18; page rules 19-21)
- `tests/e2e/booking-emails.spec.ts:131` booking emails use the link's branding: the team logo with the homepage link, or no logo (page rules 23, 25, 31)
- `tests/e2e/booking-emails.spec.ts:183` the reminder email reaches the booker once at its time with the message; a booking made before the setting gets it, a cancelled one never (rule 21)
- `tests/e2e/booking-emails.spec.ts:278` the reminder names the location the booker chose, not the link's default (rule 21; page details form)
- `tests/e2e/booking-emails.spec.ts:305` CC guests get the booked, rescheduled and cancelled emails with the chosen location and without the booker's links; an organizer in CC gets no second copy (rule 14; page details form)
- `tests/e2e/booking-options.spec.ts:34` screening questions: the owner adds them, the booker must answer the required one, and the answers reach the event (questions, rules 12-14)
- `tests/e2e/booking-options.spec.ts:132` redirect after booking: the confirmation shows, then the browser opens the https page 7 seconds later; an http URL is refused (rule 15, edge case 8)
- `tests/e2e/booking-pages.spec.ts:29` a new booking page gets three starter links with their priorities and durations (booking-links rule 2)
- `tests/e2e/booking-page-view.spec.ts:87` URL parameters choose the time zone, duration, day and time; invalid or unavailable values are ignored (page rule 9, edge case 1)
- `tests/e2e/booking-settings-2.spec.ts:52` URL names: a title in use gets -2; the owner renames the URL, the old one stops working and a name in use is refused; up to 3 durations with a default that the page preselects (booking-links rules 4, 5; durations, defaultDuration)
- `tests/e2e/booking-settings-2.spec.ts:106` notice and range: no time inside the notice; the last day is a fixed date or today plus the rolling days; both survive a reload (booking-links rangeStart, rangeEnd; availability rule 6)
- `tests/e2e/booking-settings-2.spec.ts:159` buffers: times that leave no buffer before or after a busy event are not offered; at an address the travel time stays free while the link keeps it, and not after it is turned off (availability rule 10; booking-links rule 28)
- `tests/e2e/booking-settings-2.spec.ts:220` travel time follows the kind of the chosen location: an address keeps it free with or without commas, other text with commas does not, and a booker who picks the address is held to it (availability rule 10)
- `tests/e2e/booking-settings-2.spec.ts:431` placed focus time is offered by a P1 link only (availability notes on classes; focus-time rule 32)
- `tests/e2e/booking-settings-2.spec.ts:462` preferred times: a time with nothing else on the calendar has a green dot and the legend explains it; a time over a free event is offered without the dot (availability rule 15; page rule 5)
- `tests/e2e/booking.spec.ts:21` a visitor books a time without signing in; the event lands on the calendar and a task moves away (booking-links rules 10-13, 22-23)
- `tests/e2e/booking.spec.ts:79` link priority decides which managed time it offers (availability rule 12)
- `tests/e2e/booking.spec.ts:112` a daily limit closes the day after one booking; a hidden link is unlisted but works (rules 6, 9)
- `tests/e2e/booking.spec.ts:137` the visitor reschedules and then cancels from the manage page (rules 16-18)
- `tests/e2e/calendar.spec.ts:44` free events do not block; a busy all-day event blocks its whole day (SCH-22, SCH-25)
- `tests/e2e/calendar.spec.ts:67` #tl_free opens busy time to tasks; #tl_busy closes free time, in title or description (SCH-23, SCH-24, events-tags 1-12)
- `tests/e2e/calendar.spec.ts:101` moving a chunk in the calendar locks it there; the planner shows the lock (CED-1, LCK-4)
- `tests/e2e/calendar.spec.ts:128` lock and unlock from the planner details panel (LCK-10, LCK-41)
- `tests/e2e/calendar.spec.ts:172` a title edit of a chunk in the calendar is put back (CED-41)
- `tests/e2e/embeds.spec.ts:73` the share menu copies the URL and opens an email draft and the social networks' share pages with it (sharing rule 23)
- `tests/e2e/embeds.spec.ts:116` website embeds: script, object, iframe and URL load the booking page with its branding on another site; the script resizes its frame; a booking in the embed reaches the calendar (sharing rules 24, 26)
- `tests/e2e/embeds.spec.ts:197` embed redirect modes: none stays, top page sends the whole page to the redirect URL, frame moves only the frame; the last mode is remembered (sharing rule 25)
- `tests/e2e/event-content.spec.ts:58` task notes keep their markdown in the calendar, render in the planner and link back to the task (CNT-10 to CNT-14, AT-C1)
- `tests/e2e/event-content.spec.ts:97` a timer link in the focus time description and in habit notes reaches every event (tools-pomodoro-timer rule 19, T5)
- `tests/e2e/extras.spec.ts:11` a lowered external event is offered only by higher-priority booking links (events-external-priority rules 1-5, 9)
- `tests/e2e/extras.spec.ts:54` travel time wraps events at an address; flights get airport time instead (buffers-travel rules 1-6)
- `tests/e2e/focus-rules.spec.ts:46` focus blocks keep the shortest and longest length and stay in their hours set (rule 3; hours concept)
- `tests/e2e/focus-rules.spec.ts:155` moving a focus event in the calendar locks it; a new event over it does not move it (rule 20)
- `tests/e2e/focus-rules.spec.ts:188` focus time is placed after every other item, ranks in P4, and counts as P2 for booking links (rules 29-32)
- `tests/e2e/focus-rules.spec.ts:255` an event with the focus tag counts toward the weekly goal (counted time; #tl_focus)
- `tests/e2e/habit-rules.spec.ts:28` a habit uses a named hours set or its own window, and a change of hours moves its events (rules 9-10; hours concept)
- `tests/e2e/habit-rules.spec.ts:68` a custom frequency places a habit every N days, every N weeks on its days, or every N months (Frequency: custom)
- `tests/e2e/habit-rules.spec.ts:165` a weekly occurrence with no room on its day moves to the nearest other day of that week (rule 14)
- `tests/e2e/habit-rules.spec.ts:187` an adaptive habit is free while it has room and turns busy when the calendar fills (rules 21-22, DEF-20)
- `tests/e2e/habit-rules.spec.ts:227` lock and unlock one habit occurrence from the planner (rule 26, LCK-10)
- `tests/e2e/habit-rules.spec.ts:268` the stats page shows each habit's progress: done and planned occurrences and hours (habit analytics)
- `tests/e2e/habits.spec.ts:13` a weekly habit uses its days, its notes, and always-busy defense (SPEC-HABITS-01 rules 9-25)
- `tests/e2e/habits.spec.ts:47` an always-free habit stays transparent (DEF-21)
- `tests/e2e/habits.spec.ts:61` skip removes one day; a calendar delete finds another time; a calendar move locks (rules 26-31, CED-24)
- `tests/e2e/habits.spec.ts:101` turning a habit off removes its future events, on brings them back, delete removes it (rules 34-36)
- `tests/e2e/habits.spec.ts:134` with no room, one habit is kept as a marked conflict and another is removed (rule 17, CNT conflict marker)
- `tests/e2e/habits.spec.ts:171` keywords skip days with a matching event; a start date delays the first day (rules 16, 35)
- `tests/e2e/help.spec.ts:43` the help index groups common problems and links each to its fix (SPEC-SUPPORT-01 rules 1-6, 17-20)
- `tests/e2e/help.spec.ts:225` a new user sees the advice to turn off other scheduling tools until they dismiss it (SPEC-PLATFORM rule 17)
- `tests/e2e/hours-sets.spec.ts:33` deleting a custom set in use asks for a replacement and moves its items there (HRS-10, AT-H4)
- `tests/e2e/hours-sets.spec.ts:86` a habit can use item-specific hours that tasks and other items cannot pick (item-specific hours, AT-H6)
- `tests/e2e/hours-sets.spec.ts:135` the hours menu of an item editor previews the chosen hours and links to the hours page (HRS-11)
- `tests/e2e/hours-sets.spec.ts:170` a new user is asked once to review work, meeting and personal hours, and a change there moves events (HRS-15)
- `tests/e2e/library-entries.spec.ts:95` library habit entries 11, 35, 36, 43, 45, 46 add habits with their presets: wrap-up at the end of work hours, Lunch inside 11:30 to 14:00
- `tests/e2e/library-entries.spec.ts:200` library habit entries 40, 41, 42, 44 add habits with their presets: walk, exercise in personal hours, coding at P2, email at P4
- `tests/e2e/library-entries.spec.ts:435` library focus entries 7 and 23 place their weekly goal inside the 09:00 to 12:00 window, and the window stays on edit
- `tests/e2e/library-entries.spec.ts:491` focus time keeps item-specific hours of several ranges when the form saves other fields
- `tests/e2e/library-entries.spec.ts:534` library entries 32, 34 and 37: flexible meetings repeat at their period with the guests, and the priority link offers time over P3 and P4 habits
- `tests/e2e/library.spec.ts:29` a habit entry fills the habit form; saving places it and shows Added; a second use gets a suffix; delete clears the badge (rules 3-5, 9; T1, T4)
- `tests/e2e/library.spec.ts:85` buffer and focus entries add their automation as set; prompts offer no action (rule 4, entries 3, 21, 25)
- `tests/e2e/link-cards.spec.ts:16` link cards show title, durations and priority with their actions, grouped by page; the priority changes from the card and the booking page follows (rules 5, 6, 9)
- `tests/e2e/link-groups.spec.ts:37` a link group gets its own booking page with its links, and a booker books from it (sharing rules 1-3, 7, edge case 4)
- `tests/e2e/link-groups.spec.ts:97` editing a group warns before it breaks URLs; old URLs stop working; delete moves or removes the links (sharing rules 4-6)
- `tests/e2e/mcp.spec.ts:48` an MCP client with an API key reads the schedule, free time, the week summary and meeting context (SPEC-ASSIST-03 rules 1-3, T1, T2)
- `tests/e2e/mcp.spec.ts:255` the final list applies only what stays in it; attendees hear only at apply (SPEC-ASSIST-02 rules 6-9, T3)
- `tests/e2e/mcp.spec.ts:355` a staged change whose event moved after staging is skipped as stale (SPEC-ASSIST-02 rule 12, T5)
- `tests/e2e/mcp.spec.ts:399` a read-only server lists no write tools, refuses a write and stages nothing (SPEC-ASSIST-03 rule 9, T5; SPEC-PLANS-01 T3)
- `tests/e2e/oneoff-links.spec.ts:49` a one-off link has its own settings and prefilled invitee, stays unlisted, leaves the source unchanged, counts against its limits, and the creator edits it from its URL (sharing rules 8-13, 16, 31-32)
- `tests/e2e/oneoff-links.spec.ts:164` a one-off link expires 30 days after creation: its URL then shows an expired page with no times (sharing rule 14)
- `tests/e2e/oneoff-links.spec.ts:207` shared times: up to 5 dates, offered times as buttons or text, merged text ranges, time links that open the booking page, and the last template kept (sharing rules 17-22)
- `tests/e2e/planned-actual.spec.ts:26` planned time is the calendar when the day began and actual time is what stayed; only ended days count
- `tests/e2e/planner-now.spec.ts:26` the planner shows the current or next meeting and joins it in one click (PLN-7)
- `tests/e2e/planner-now.spec.ts:113` an event start flashes the tab title, and plays the chime when it is on (NTF-1 to NTF-3)
- `tests/e2e/planner-now.spec.ts:161` a chime the browser blocks shows a hint (NTF-2)
- `tests/e2e/planning.spec.ts:76` places a split task in work hours and keeps it after reload and restart (SPEC-PLANNING-01 AT 1)
- `tests/e2e/planning.spec.ts:118` moves a chunk away from a new meeting and never touches the meeting (SCH-1, SCH-55)
- `tests/e2e/planning.spec.ts:156` a drag in the planner moves the chunk and locks it there (CED-50, LCK-2)
- `tests/e2e/planning.spec.ts:201` mark done removes future chunks; delete removes the task (TSK-40, TSK-42)
- `tests/e2e/planning.spec.ts:235` deleting a chunk in the calendar places the work again later (CED-20, CED-23)
- `tests/e2e/planning.spec.ts:265` a habit sits at its ideal time each weekday and moves when blocked (SPEC-HABITS-01 AT 1, 2)
- `tests/e2e/planning.spec.ts:296` a recovery buffer follows a meeting with attendees (SPEC-BUFFERS-01)
- `tests/e2e/planning.spec.ts:333` focus time fills the weekly goal within daily limits (SPEC-FOCUS-01 AT 1)
- `tests/e2e/pomodoro-extras.spec.ts:43` background audio plays the chosen track during work sessions only (rule 14)
- `tests/e2e/pomodoro-extras.spec.ts:81` the mini window shows the running timer and controls it (rule 13)
- `tests/e2e/pomodoro-stats.spec.ts:35` the pomodoro timer plays the chosen alarm, resets a running session without counting it, and shows the stats view with streak, completion rate and a chart (rules 7, 9, 17; T3)
- `tests/e2e/preview.spec.ts:27` preview mode turned on by hand stages a drag; turning it off keeps it pending after reload; apply writes it (SPEC-ASSIST-02 rules 3, 10, 11)
- `tests/e2e/preview.spec.ts:92` with preview mode on, a new habit shows its calendar impact and writes nothing until apply; turning it off is staged too (SPEC-ASSIST-02 rule 2, T6)
- `tests/e2e/profile.spec.ts:20` the profile shows account fields read-only and saves job title, company, size and use case (PRF-1, PRF-4, PRF-8)
- `tests/e2e/settings.spec.ts:11` editing work hours moves existing events into the new hours (HRS-1, HRS-7)
- `tests/e2e/settings.spec.ts:36` a custom hours set can hold a task (HRS-8, HRS-9)
- `tests/e2e/settings.spec.ts:56` a shorter planning window leaves later work unplaced, with the reason (WIN-1, WIN-6)
- `tests/e2e/settings.spec.ts:80` pausing stops new placements; resuming plans again (pause spec)
- `tests/e2e/settings.spec.ts:101` a break keeps a gap between task and habit events (buffers-breaks rule 1)
- `tests/e2e/settings.spec.ts:121` work habits count toward focus time; a deleted focus block is not reused (SPEC-FOCUS-01 AT 2, rule 21)
- `tests/e2e/settings.spec.ts:185` changing the time zone moves the work day (timezones spec, HRS-13)
- `tests/e2e/task-flow.spec.ts:47` the New task form keeps open for the next task with Create another, and closes without it (TSK-5, TSK-6)
- `tests/e2e/task-flow.spec.ts:95` suggestions-only mode removes task events and lists tasks as Suggested now and At risk (TSK-70, NXT-30 to NXT-33)
- `tests/e2e/task-flow.spec.ts:169` the next-up task is the one in progress, else the earliest chunk, else scheduler order (NXT-20)
- `tests/e2e/task-flow.spec.ts:223` in suggestions mode, focus time lists the tasks to work on and tasks get no events (platform-current-version T1)
- `tests/e2e/task-flow.spec.ts:257` Block time proposes work blocks as a preview; Discard writes nothing, a moved block and Apply write locked events (NXT-50)
- `tests/e2e/tasks.spec.ts:9` a task with only a title gets P2, a due date in 3 days and work-hour chunks (TSK-1, AT-T3)
- `tests/e2e/tasks.spec.ts:39` a P1 task takes the first free slot ahead of a P4 task, and due dates order one level (PRI-1, PRI-4)
- `tests/e2e/tasks.spec.ts:71` start after delays the first chunk (TSK-15)
- `tests/e2e/tasks.spec.ts:88` a next-up task goes before other tasks of any level (PRI-6, SCH-67)
- `tests/e2e/tasks.spec.ts:113` work that misses its due date goes late, turns busy and shows why (TSK-21, DEF-12, CNT-1)
- `tests/e2e/tasks.spec.ts:136` a chunk with room to spare stays free; the last chance turns busy (DEF-10, DEF-11)
- `tests/e2e/tasks.spec.ts:168` add time places more work and reopens a done task; filters show each state (TSK-30, TSK-41)
- `tests/e2e/tasks.spec.ts:200` a chunk too long for any hours range is not placed and shows the reason (SCH-116)
- `tests/e2e/tasks.spec.ts:220` task notes go into the event description (CNT-10)
- `tests/e2e/tasks.spec.ts:237` a task on personal hours is placed in the evening (HRS-1)
- `tests/e2e/tasks.spec.ts:255` a title typed while the last task is still being planned is kept
- `tests/e2e/task-timer.spec.ts:108` time logged with the timer on a task and on a habit counts in stats (analytics-personal-stats rule 15)
- `tests/e2e/title-markers.spec.ts:39` an ended habit event gets the done marker; an ended task chunk gets the partly done marker until the task is done (marker table; rules 2, 5)
- `tests/e2e/title-markers.spec.ts:153` a template's emoji shows in the form and can be removed; the user's own emoji stays after the state marker (rules 3, 4)
- `tests/e2e/tools.spec.ts:6` the meeting cost calculator computes, rejects bad input and resets (tools-meeting-cost-calculator rules 1-6)
- `tests/e2e/tools.spec.ts:28` the pomodoro timer runs sessions and breaks, counts them and keeps them after reload (tools-pomodoro-timer)
- `tests/e2e/travel.spec.ts:58` a travel zone places habits in its local time on its dates; several entries are allowed, overlaps are refused, and delete returns home (rules 1-7, AT 1, 3, 4)
- `tests/e2e/travel.spec.ts:117` a booking link offers times in the travel zone on travel days (rule 3, AT 2)
- `tests/e2e/travel.spec.ts:158` the planner prompts for a travel zone when the browser is elsewhere, shows two time columns, and offers to end the trip back home (rules 8-10)
- `tests/e2e/travel.spec.ts:208` a browser that reports UTC gets a warning and never changes the home zone; an active trip shows on the hours page (planning-hours edge case 6, rules 11-12)
- `tests/e2e/webhooks.spec.ts:100` booking, reschedule and cancel send signed requests with custom data; a new secret signs the next one (rules 2-7, 16-18, 23)
- `tests/e2e/webhooks.spec.ts:214` a failing receiver gets retries with one request id and Retry-After; too much custom data is dropped; removed and deleted endpoints stop (rules 2, 6, 8-10, 20)
- `tests/e2e/weekly-report.spec.ts:146` with work hours Monday to Thursday 10:00 to 18:00 the weekly report goes out on Thursday between 10:00 and 11:00, and not on Friday
- `tests/e2e/weekly-report.spec.ts:179` the server sends the weekly report by its own clock in the first work hour of Friday
