# Google Calendar E2E run, 2026-10-28

A full E2E run against Google Calendar. The parity table
(`docs/parity.md`) reads the result from `docs/e2e-google-run.tsv`: a row is
"done (Google)" when it is "done (CalDAV)" and every test that proves it
passed in this run.

- Date: 2026-10-28 (start 06:10:36 UTC, duration 75.1 minutes)
- Commit: `6ef5f06424e991b4521f6988db24487d1620a2cd` (origin/main)
- Backend: Google user with OAuth. The owner's test account approved the
  access once in a browser; the helper revoked the token at exit. The test
  account uses the settings in `tests/e2e/README.md` (week starts on Monday,
  dates as 2026-12-31, times as 13:00).
- Command: the steps of `scripts/e2e-google.sh` with
  `TEMPOLOOM_E2E_GOOGLE_AUTH=oauth` (`scripts/google-oauth-login.ts`, then
  `npx playwright test`), with the OAuth callback on port 8798. Two local
  steps were added around the suite: a check of the account settings before
  it, and a delete of the driver's test calendar after it.
- Playwright 1.64.1, 534 tests: **228 passed, 3 failed, 0 flaky, 303 skipped**.
  The skipped tests need several users, extra calendars, incoming
  invitations or the CalDAV server itself; the Google driver skips them.

`docs/e2e-google-run.tsv` starts with a line `# commit <sha>` (the commit
above), then lists every test of the run: status (`passed`, `failed` or
`skipped`), test id (`file:line` at the commit above) and title.

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
`test(...)` call did not change after the run.

The build compares the `test(...)` call of each passed test at the run commit
(`git show <commit>:<file>`, found at the test id) with the call that has the
same title in `tests/e2e` now. It ignores indent and blank lines. When the call
differs, the test "changed after the Google run" and its rows fall back to
"done (CalDAV)" with that reason, until a new Google run passes it. The check
needs the run commit in the clone, so the CI checkout fetches the full history
(`fetch-depth: 0`).

Limit: the check compares the `test(...)` call only. It does not compare the
helpers the test calls (for example `addTask` in `tests/e2e/helpers.ts`), hooks
and file-level calls (`test.beforeEach`, `test.use`, `test.skip`), fixtures, or
the product code. When one of these changes after the run and the call does not,
the test keeps its Google claim. Only a new Google run proves those changes on
Google.

The build reads each `test("...")` call with a small JavaScript tokenizer
(`scan()` in `scripts/build-parity.py`): it skips strings, template literals,
comments and regular expressions, so a `test("...")` in a comment is not a test.
When it cannot read a file (for example an unclosed bracket), the build stops
with the file and line. Its tests are in `scripts/test_build_parity.py`:

```bash
python3 -B -m unittest discover -s scripts -p "test_*.py"
```

## Failed tests

Their rows stay "done (CalDAV)" until a Google run passes them.

- `tests/e2e/assistant-C5.spec.ts:450` an agenda on an all-day event keeps it all-day; a move and an agenda for one event are one change, and both apply (assistant-chat; agendas and prep plans): the proposal shows the all-day "Offsite" event as 2026-11-05–2026-11-06 (all day), one day too far at the end.
- `tests/e2e/event-tips.spec.ts:52` event tips sit between the notes and the planner link on task, habit, focus and meeting events, and turning them off removes them from future events (CNT-15; AT 3): `page.waitForResponse` waited 15 s for a response that did not come.
- `tests/e2e/focus-buffer-extras.spec.ts:22` with offer to booking links off, focus time is hidden from every booking link, also a P1 link (rule 32; offer_to_booking_links): 4 more focus events than the test expects (2026-11-03 to 2026-11-06).

## Passed tests

- `tests/e2e/assistant-C3.spec.ts:176` a task asked for in the chat is proposed with its fields and created only after approval; the scheduler then places it (planning-tasks TSK-5; assistant-chat rule 12)
- `tests/e2e/assistant-C3.spec.ts:271` the chat answers about the user's own stats with the stats page's numbers and stages focus time as advice, written only after approval (analytics-personal-stats rule 14, open question 6; assistant-chat rule 9)
- `tests/e2e/assistant-C3.spec.ts:542` the chat answers how Tempoloom works from the help pages with the page's link, and says when the help does not cover a question (assistant-chat rule 10)
- `tests/e2e/assistant-C5.spec.ts:324` an agenda and prep plan from the meeting context go into the event's description only after approval (assistant-chat; agendas and prep plans)
- `tests/e2e/assistant-C5.spec.ts:564` the chat memory limit refuses a new memory by chat and a Save past the limit, with the limit in the message; without a limit both work (plans-feature-inventory rules 2, 4; assistant-chat rule 22)
- `tests/e2e/assistant-chat.spec.ts:63` the assistant panel in the planner reads the calendar through tools and keeps the conversation after reload; a failed call keeps the draft (assistant-chat rules 1, 3, 11, edge case 5)
- `tests/e2e/assistant-chat.spec.ts:185` a send whose answer was lost waits for the first turn with the same message id; an edited draft is a new message (assistant-chat edge case 5)
- `tests/e2e/assistant-chat.spec.ts:249` in the first conversation, a send whose answer was lost after the turn finished is resent with the same id and conversation after the panel shows the new conversation (assistant-chat edge case 5)
- `tests/e2e/assistant-chat.spec.ts:290` events made, moved, resized and deleted by chat wait in preview mode; nothing is written before approval, the accepted ones after apply (assistant-chat rules 4, 12-14; preview mode rules 1, 6-8)
- `tests/e2e/assistant-chat.spec.ts:484` chat memories: remember proposes one, the user saves it, the list keeps it after reload, the model gets it in its data, delete removes it (assistant-chat rules 22, 23, 25)
- `tests/e2e/assistant-chat.spec.ts:637` the usage limit stops chat with the limit and its reset time; without a limit chat goes on (assistant-chat rule 27; plans-feature-inventory rule 2)
- `tests/e2e/assistant-chat.spec.ts:739` without a configured model the panel says the assistant is not configured and sends nothing (assistant-chat rule 1)
- `tests/e2e/assistant-P1.spec.ts:23` a reply in markdown shows bold, italic, lists and code without the markers; links and the user's own text stay plain text (assistant-chat rule 1)
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
- `tests/e2e/cache-window.spec.ts:19` a chunk older than the cache window still counts as done work after a full read
- `tests/e2e/calendar.spec.ts:44` free events do not block; a busy all-day event blocks its whole day (SCH-22, SCH-25)
- `tests/e2e/calendar.spec.ts:67` #tl_free opens busy time to tasks; #tl_busy closes free time, in title or description (SCH-23, SCH-24, events-tags 1-12)
- `tests/e2e/calendar.spec.ts:101` moving a chunk in the calendar locks it there; the planner shows the lock (CED-1, LCK-4)
- `tests/e2e/calendar.spec.ts:128` lock and unlock from the planner details panel (LCK-10, LCK-41)
- `tests/e2e/calendar.spec.ts:172` a title edit of a chunk in the calendar is put back (CED-41)
- `tests/e2e/chunk-edits.spec.ts:71` moving the first chunk later moves the task's start, so no chunk goes before it; moving it earlier sets an earlier start (CED-11)
- `tests/e2e/chunk-edits.spec.ts:136` a planner drag of the first chunk sets the task's start, so no chunk goes before it (CED-11, CED-50)
- `tests/e2e/chunk-edits.spec.ts:200` a chunk moved past the due date makes every chunk of its task busy (CED-12, DEF-12)
- `tests/e2e/chunk-edits.spec.ts:243` a shorter chunk gives its minutes back to the task and a longer chunk takes them from the rest (CED-13, CED-14)
- `tests/e2e/chunk-edits.spec.ts:289` past chunks: a delete brings the work back and reopens a done task; a shorter past chunk gives its minutes back (CED-13, CED-21, CED-22)
- `tests/e2e/edit-races.spec.ts:43` a meeting form opened before another client's change saves only its own fields
- `tests/e2e/edit-races.spec.ts:74` a habit form opened before another client's change saves only its own fields
- `tests/e2e/edit-races.spec.ts:107` the meeting Edit buttons stay off until every change of the page shows
- `tests/e2e/edit-races.spec.ts:140` a settings checkbox shows its new value while it saves, and a fast second click wins
- `tests/e2e/embeds.spec.ts:73` the share menu copies the URL and opens an email draft and the social networks' share pages with it (sharing rule 23)
- `tests/e2e/embeds.spec.ts:116` website embeds: script, object, iframe and URL load the booking page with its branding on another site; the script resizes its frame; a booking in the embed reaches the calendar (sharing rules 24, 26)
- `tests/e2e/embeds.spec.ts:197` embed redirect modes: none stays, top page sends the whole page to the redirect URL, frame moves only the frame; the last mode is remembered (sharing rule 25)
- `tests/e2e/event-content.spec.ts:58` task notes keep their markdown in the calendar, render in the planner and link back to the task (CNT-10 to CNT-14, AT-C1)
- `tests/e2e/event-content.spec.ts:97` a timer link in the focus time description and in habit notes reaches every event (tools-pomodoro-timer rule 19, T5)
- `tests/e2e/events-2-markers.spec.ts:29` chosen markers after the title replace the defaults on new and changed events; the planner shows plain titles; back before the title rewrites them (settings; rules 1, 5, 7)
- `tests/e2e/extras.spec.ts:11` a lowered external event is offered only by higher-priority booking links (events-external-priority rules 1-5, 9)
- `tests/e2e/extras.spec.ts:56` travel time wraps events at an address; flights get airport time instead (buffers-travel rules 1-6)
- `tests/e2e/focus-buffer-extras.spec.ts:74` reschedule moves a focus event to the first free time at least the chosen delay from now, and it stays there (rule 22)
- `tests/e2e/focus-buffer-extras.spec.ts:142` reschedule does not put a focus event back where the user deleted one of the goal (rules 21, 22)
- `tests/e2e/focus-buffer-extras.spec.ts:204` a recovery buffer gives its time to a habit when that is the habit's last slot, and keeps it where the habit has room (buffers rule 18)
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
- `tests/e2e/hours-sets.spec.ts:34` deleting a custom set in use asks for a replacement and moves its items there (HRS-10, AT-H4)
- `tests/e2e/hours-sets.spec.ts:87` a habit can use item-specific hours that tasks and other items cannot pick (item-specific hours, AT-H6)
- `tests/e2e/hours-sets.spec.ts:136` the hours menu of an item editor previews the chosen hours and links to the hours page (HRS-11)
- `tests/e2e/hours-sets.spec.ts:171` the hours preview button shows a drawn info icon, not a glyph that needs a symbol font
- `tests/e2e/hours-sets.spec.ts:188` a new user is asked once to review work, meeting and personal hours, and a change there moves events (HRS-15)
- `tests/e2e/item-changes.spec.ts:37` each item keeps a change log of its placements, moves and removals, each with the time and a reason code (SCH-114, SCH-116, SCH-119)
- `tests/e2e/item-changes.spec.ts:153` the change log names a skipped period, a kept conflict and a status change, and shows on the flexible meeting view (SCH-114, SCH-116, SCH-119)
- `tests/e2e/item-changes.spec.ts:234` a move the report does not explain names its cause: a higher-priority item, a settings change, or a plan that changed around it (SCH-119)
- `tests/e2e/library-entries.spec.ts:98` library habit entries 11, 35, 36, 43, 45, 46 add habits with their presets: wrap-up at the end of work hours, Lunch inside 11:30 to 14:00
- `tests/e2e/library-entries.spec.ts:203` library habit entries 40, 41, 42, 44 add habits with their presets: walk, exercise in personal hours, coding at P2, email at P4
- `tests/e2e/library-entries.spec.ts:438` library focus entry 7 fills free mornings first and puts the rest of its 8 h in other work hours
- `tests/e2e/library-entries.spec.ts:479` library focus entry 23 prefers 09:00 to 12:00 over busy mornings, and a window the user changes moves its 10 h
- `tests/e2e/library-entries.spec.ts:529` library entry 11 puts the wrap-up in the last 30 min of each day's work hours, on a shorter Friday, and follows an hours change
- `tests/e2e/library-entries.spec.ts:584` focus time keeps item-specific hours of several ranges when the form saves other fields
- `tests/e2e/library-entries.spec.ts:641` library entries 32, 34 and 37: flexible meetings repeat at their period with the guests, and the priority link offers time over P3 and P4 habits
- `tests/e2e/library.spec.ts:29` a habit entry fills the habit form; saving places it and shows Added; a second use gets a suffix; delete clears the badge (rules 3-5, 9; T1, T4)
- `tests/e2e/library.spec.ts:85` buffer and focus entries add their automation as set; prompts offer only the chat (rule 4, entries 3, 21, 25)
- `tests/e2e/link-cards.spec.ts:16` link cards show title, durations and priority with their actions, grouped by page; the priority changes from the card and the booking page follows (rules 5, 6, 9)
- `tests/e2e/link-groups.spec.ts:37` a link group gets its own booking page with its links, and a booker books from it (sharing rules 1-3, 7, edge case 4)
- `tests/e2e/link-groups.spec.ts:97` editing a group warns before it breaks URLs; old URLs stop working; delete moves or removes the links (sharing rules 4-6)
- `tests/e2e/live-updates.spec.ts:29` a calendar change synced before the live stream connects shows without a reload
- `tests/e2e/live-updates.spec.ts:57` a fresh planner load asks for its events once
- `tests/e2e/load-races-2.spec.ts:55` booking times of an older page that answers last do not replace the newer page
- `tests/e2e/load-races-2.spec.ts:83` the availability inspector of an older page that answers last does not replace the newer page
- `tests/e2e/load-races-2.spec.ts:108` an older guest lookup on the meeting form that answers last does not replace the newer one
- `tests/e2e/load-races.spec.ts:50` the Done view keeps the done list when an action started in the open view loads again
- `tests/e2e/load-races.spec.ts:93` the settings page shows each part when its data comes in, before a slow call answers
- `tests/e2e/load-races.spec.ts:116` the settings page shows an error when one call fails, and the parts that loaded
- `tests/e2e/load-races.spec.ts:150` a save that worked shows as saved when the reload after it fails
- `tests/e2e/load-races.spec.ts:189` an older help lookup that answers last does not replace the newer one
- `tests/e2e/mcp-guides.spec.ts:30` the Account page has a setup guide for ChatGPT, Claude, Claude Code and Cursor with this server's MCP URL, the sign-in steps and troubleshooting, and the URL connects (integrations-ai-tools rules 10-13, 15-20)
- `tests/e2e/mcp-oauth.spec.ts:63` an MCP client signs in with OAuth on the consent page, reads at once, and its writes wait in preview mode until the user applies them (integrations-ai-tools rules 1-3, 21)
- `tests/e2e/mcp-oauth.spec.ts:335` revoking one AI tool on the Account page stops only that tool; calendar access, its events and its staged changes stay (integrations-ai-tools rules 6-8, edge case 1)
- `tests/e2e/mcp.spec.ts:48` an MCP client with an API key reads the schedule, free time, the week summary and meeting context (SPEC-ASSIST-03 rules 1-3, T1, T2)
- `tests/e2e/mcp.spec.ts:255` the final list applies only what stays in it; attendees hear only at apply (SPEC-ASSIST-02 rules 6-9, T3)
- `tests/e2e/mcp.spec.ts:355` a staged change whose event moved after staging is skipped as stale (SPEC-ASSIST-02 rule 12, T5)
- `tests/e2e/mcp.spec.ts:399` a read-only server lists no write tools, refuses a write and stages nothing (SPEC-ASSIST-03 rule 9, T5; SPEC-PLANS-01 T3)
- `tests/e2e/next-up-queue.spec.ts:60` dragging a task inside the next-up queue changes its rank, and the scheduler places the queue in the new order (NXT-2, NXT-3, NXT-9)
- `tests/e2e/next-up-queue.spec.ts:84` the up and down arrows and drag and drop add a task to the next-up queue and take it out (NXT-5, NXT-10, NXT-11)
- `tests/e2e/next-up-queue.spec.ts:147` the planner tasks panel adds a task to the next-up queue with its up arrow (NXT-6)
- `tests/e2e/next-up-queue.spec.ts:181` an up arrow click moves only the task it adds to the next-up queue; other tasks keep their events (SCH-88, NXT-5)
- `tests/e2e/oneoff-links.spec.ts:49` a one-off link has its own settings and prefilled invitee, stays unlisted, leaves the source unchanged, counts against its limits, and the creator edits it from its URL (sharing rules 8-13, 16, 31-32)
- `tests/e2e/oneoff-links.spec.ts:164` a one-off link expires 30 days after creation: its URL then shows an expired page with no times (sharing rule 14)
- `tests/e2e/oneoff-links.spec.ts:213` shared times: up to 5 dates, offered times as buttons or text, merged text ranges, time links that open the booking page, and the last template kept (sharing rules 17-22)
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
- `tests/e2e/priorities.spec.ts:62` the priorities page shows P1 to P4 columns; a drag or the level menu changes the level, with kind and hours filters and a column width (PRI-51, PRI-52, NXT-6)
- `tests/e2e/priorities.spec.ts:128` the planner priorities view groups items by level and kind, with a level menu, drag and drop, search and edit (PRI-53)
- `tests/e2e/priorities.spec.ts:196` a level change on the priorities page leaves a locked task chunk in place (NXT-4, PRI-13)
- `tests/e2e/priorities.spec.ts:234` the task edit form edits every field and saves a total that is not a multiple of 15 minutes (PRI-50, PRI-53)
- `tests/e2e/priorities.spec.ts:333` an hours choice made in the task edit form before the hours sets load is saved (PRI-53, HRS-11)
- `tests/e2e/profile-formats.spec.ts:79` the planner, the hours page and the task and habit lists use the time format, date format and week start from the calendar account, also after a reload (PRF-6)
- `tests/e2e/profile-formats.spec.ts:180` a week start change from the calendar account moves an open planner to the week that keeps most of its days (PRF-6, planner edge case 4)
- `tests/e2e/profile.spec.ts:25` the profile shows account fields read-only and saves job title, company, size and use case (PRF-1, PRF-4, PRF-8)
- `tests/e2e/profile.spec.ts:61` a job title typed while the page reads the account again is saved (PRF-4)
- `tests/e2e/profile.spec.ts:93` without a picture from the calendar account the profile and booking pages show initials (edge case 1)
- `tests/e2e/scheduler-chunks.spec.ts:34` a 90-minute task with 60-minute chunks gets 60 and 30 minutes, not no free time (TSK-13)
- `tests/e2e/scheduler-chunks.spec.ts:49` +30 min on a 120-minute task with 60-minute chunks places 60, 60 and 30 minutes (TSK-13)
- `tests/e2e/scheduler-chunks.spec.ts:69` a 195-minute task with 60-90 minute chunks gets 75, 60 and 60 minutes, no short chunk (TSK-10, TSK-13)
- `tests/e2e/settings.spec.ts:20` editing work hours moves existing events into the new hours (HRS-1, HRS-7)
- `tests/e2e/settings.spec.ts:45` a custom hours set can hold a task (HRS-8, HRS-9)
- `tests/e2e/settings.spec.ts:65` a shorter planning window leaves later work unplaced, with the reason (WIN-1, WIN-6)
- `tests/e2e/settings.spec.ts:89` a planning window, task duration or chunk default typed while the page reads the account again is saved (WIN-1, TSK-1)
- `tests/e2e/settings.spec.ts:122` pausing stops new placements; resuming plans again (pause spec)
- `tests/e2e/settings.spec.ts:143` a break keeps a gap between task and habit events (buffers-breaks rule 1)
- `tests/e2e/settings.spec.ts:163` work habits count toward focus time; a deleted focus block is not reused (SPEC-FOCUS-01 AT 2, rule 21)
- `tests/e2e/settings.spec.ts:227` changing the time zone moves the work day (timezones spec, HRS-13)
- `tests/e2e/support-guidance.spec.ts:26` the account page lists the manual reset steps in order, each with a link to its page (planning-pause.md manual reset steps)
- `tests/e2e/support-guidance.spec.ts:79` the help explains invitations hidden by anti-spam rules, without a Google account (support rules 13, 15, 16)
- `tests/e2e/task-flow.spec.ts:47` the New task form keeps open for the next task with Create another, and closes without it (TSK-5, TSK-6)
- `tests/e2e/task-flow.spec.ts:95` the key C opens the New task form on pages other than the planner, such as Settings and Tasks (TSK-5)
- `tests/e2e/task-flow.spec.ts:128` suggestions-only mode removes task events and lists tasks as Suggested now and At risk (TSK-70, NXT-30 to NXT-33)
- `tests/e2e/task-flow.spec.ts:202` the next-up task is the one in progress, else the earliest chunk, else scheduler order (NXT-20)
- `tests/e2e/task-flow.spec.ts:256` in suggestions mode, focus time lists the tasks to work on and tasks get no events (platform-current-version T1)
- `tests/e2e/task-flow.spec.ts:290` Block time proposes work blocks as a preview; Discard writes nothing, a moved block and Apply write locked events (NXT-50)
- `tests/e2e/task-list.spec.ts:50` the task list filters by state, hours set, due date and start date, and sorts by due date, priority or scheduling order (TSK-60, TSK-61)
- `tests/e2e/task-list.spec.ts:122` scheduling order is the scheduler's order, with the urgency lift of a task short of time before its due date (TSK-61)
- `tests/e2e/task-list.spec.ts:155` bulk edit sets the start date, due date and priority of the selected tasks, marks them done or deletes them (TSK-45)
- `tests/e2e/task-list.spec.ts:241` snooze moves a task to a later start and places its chunks again, unlocked (TSK-24)
- `tests/e2e/task-list.spec.ts:298` snooze past the due date moves the due date with the start, and the task can still be edited (TSK-24, edge case 6)
- `tests/e2e/task-list.spec.ts:348` snooze moves a task made on the planner: its locked chunk is unlocked and placed again (TSK-24, TSK-7)
- `tests/e2e/task-list.spec.ts:439` task defaults in Settings fill new tasks: priority, duration, chunks, hours, start delay, due in and next up; older tasks keep theirs (TSK-1 to TSK-3)
- `tests/e2e/task-list.spec.ts:536` task defaults in Settings: the shortest and longest chunk fill new split tasks (TSK-1 to TSK-3)
- `tests/e2e/task-list.spec.ts:604` a drag on the planner makes a locked task of that length there; a click makes one of the default length (TSK-7, AT-T10)
- `tests/e2e/task-list.spec.ts:667` a task row has the select box at its left, the title and details in the middle and the buttons at its right
- `tests/e2e/task-progress.spec.ts:76` Start moves the first chunk to now and Stop ends it now; the rest is placed later (PRG-10, PRG-11)
- `tests/e2e/task-progress.spec.ts:149` a chunk whose time passed counts as done work, and shortening it in the calendar returns the cut minutes (PRG-1, PRG-2)
- `tests/e2e/task-progress.spec.ts:208` manual start mode moves an unstarted chunk or habit event later that day, and Start moves a running one to now (PRG-1, PRG-3 to PRG-5)
- `tests/e2e/task-progress.spec.ts:327` logging past work in the planner writes a past event for a task or a habit and reduces the remaining work (PRG-20 to PRG-22; habits rule 32)
- `tests/e2e/task-progress.spec.ts:418` Start with no chunk makes one from now up to the next busy event, Start on a running chunk changes nothing, and an early Stop removes it (edge cases 1 to 4)
- `tests/e2e/task-progress.spec.ts:497` manual start mode: a chunk the user locked or dragged that ends without Start still moves later that day (PRG-3)
- `tests/e2e/task-progress.spec.ts:576` Unlock on a started chunk or on logged work that ended keeps it as done work, and its event stays (PRG-1, PRG-3, PRG-20)
- `tests/e2e/task-progress.spec.ts:653` manual start mode: a chunk that ended without Start is work left in the task list, the Tasks panel and its title (PRG-3)
- `tests/e2e/task-progress.spec.ts:696` two Start requests at once make one chunk, and an early Stop is in the change log (edge cases 1 and 4)
- `tests/e2e/task-progress.spec.ts:749` Start now and End now in the planner move a task chunk to now and end it now (PRG-10, PRG-11, PRG-13)
- `tests/e2e/task-progress.spec.ts:881` a drag from a past time into the future logs work only up to now (PRG-21, edge case 6)
- `tests/e2e/tasks.spec.ts:9` a task with only a title gets P2, a due date in 3 days and work-hour chunks (TSK-1, AT-T3)
- `tests/e2e/tasks.spec.ts:43` the task form proposes a due date 3 local days ahead across a DST change (TSK-1)
- `tests/e2e/tasks.spec.ts:65` a P1 task takes the first free slot ahead of a P4 task, and due dates order one level (PRI-1, PRI-4)
- `tests/e2e/tasks.spec.ts:97` start after delays the first chunk (TSK-15)
- `tests/e2e/tasks.spec.ts:114` a next-up task goes before other tasks of any level (PRI-6, SCH-67)
- `tests/e2e/tasks.spec.ts:139` work that misses its due date goes late, turns busy and shows why (TSK-21, DEF-12, CNT-1)
- `tests/e2e/tasks.spec.ts:162` a chunk with room to spare stays free; the last chance turns busy (DEF-10, DEF-11)
- `tests/e2e/tasks.spec.ts:194` add time places more work and reopens a done task; filters show each state (TSK-30, TSK-41)
- `tests/e2e/tasks.spec.ts:226` a chunk too long for any hours range is not placed and shows the reason (SCH-116)
- `tests/e2e/tasks.spec.ts:246` task notes go into the event description (CNT-10)
- `tests/e2e/tasks.spec.ts:263` a task on personal hours is placed in the evening (HRS-1)
- `tests/e2e/tasks.spec.ts:281` a title typed while the last task is still being planned is kept
- `tests/e2e/task-timer.spec.ts:116` time logged with the timer on a task and on a habit counts in stats (analytics-personal-stats rule 15)
- `tests/e2e/task-time-used.spec.ts:77` Restart moves the running chunk to now, rounded down to 5 minutes, with its length, in the task list and the planner (PRG-12, PRG-13)
- `tests/e2e/task-time-used.spec.ts:141` Restart in manual start mode moves the started chunk to now, and Restart with no running chunk is refused (PRG-12)
- `tests/e2e/task-time-used.spec.ts:197` time-used action: Nothing keeps a time-used task open after the wait; Mark done waits the days, also for a task already time-used, and changes no event (PRG-40, PRG-42, PRG-43; AT 6)
- `tests/e2e/task-time-used.spec.ts:267` time-used action: Add the time again adds the first total after the wait days, and the scheduler places it (PRG-41; AT 7)
- `tests/e2e/task-time-used.spec.ts:333` time-used action: manual start mode hides the setting, and the action has no effect (PRG-44)
- `tests/e2e/task-time-used.spec.ts:387` Days to wait typed while the page reads the account again is saved (PRG-41, PRG-42)
- `tests/e2e/title-markers.spec.ts:40` an ended habit event gets the done marker; an ended task chunk gets the partly done marker until the task is done (marker table; rules 2, 5)
- `tests/e2e/title-markers.spec.ts:156` a template's emoji shows in the form and can be removed; the user's own emoji stays after the state marker (rules 3, 4)
- `tests/e2e/tools.spec.ts:6` the meeting cost calculator computes, rejects bad input and resets (tools-meeting-cost-calculator rules 1-6)
- `tests/e2e/tools.spec.ts:28` the pomodoro timer runs sessions and breaks, counts them and keeps them after reload (tools-pomodoro-timer)
- `tests/e2e/travel.spec.ts:58` a travel zone places habits in its local time on its dates; several entries are allowed, overlaps are refused, and delete returns home (rules 1-7, AT 1, 3, 4)
- `tests/e2e/travel.spec.ts:117` a booking link offers times in the travel zone on travel days (rule 3, AT 2)
- `tests/e2e/travel.spec.ts:158` the planner prompts for a travel zone when the browser is elsewhere, shows two time columns, and offers to end the trip back home (rules 8-10)
- `tests/e2e/travel.spec.ts:208` a browser that reports UTC gets a warning and never changes the home zone; an active trip shows on the hours page (planning-hours edge case 6, rules 11-12)
- `tests/e2e/webhook-delivery.spec.ts:104` with private receivers off, http, localhost and IP hosts are refused and a public https host is kept; the operator setting allows loopback (fields table, rule 13)
- `tests/e2e/webhook-delivery.spec.ts:142` an answer after 10 seconds is a failure and is cut at 10 seconds; only 200, 201, 202 and 204 count as success (rules 8, 12, 14)
- `tests/e2e/webhook-delivery.spec.ts:205` an endpoint that fails for the whole period is suspended, gets no new requests and its admins get an email; Resume sends the waiting request (rule 15)
- `tests/e2e/webhooks.spec.ts:100` booking, reschedule and cancel send signed requests with custom data; a new secret signs the next one (rules 2-7, 16-18, 23)
- `tests/e2e/webhooks.spec.ts:214` a failing receiver gets retries with one request id and Retry-After; too much custom data is dropped; removed and deleted endpoints stop (rules 2, 6, 8-10, 20)
- `tests/e2e/weekly-report-extras.spec.ts:50` the weekly report previews next week's calendar by day with the busiest and the lightest day, and lists the top open tasks and next week's habits by priority; each links into the app (rules 8, 9)
- `tests/e2e/weekly-report.spec.ts:170` with work hours Monday to Thursday 10:00 to 18:00 the weekly report goes out on Thursday between 10:00 and 11:00, and not on Friday
- `tests/e2e/weekly-report.spec.ts:203` the server sends the weekly report by its own clock in the first work hour of Friday
- `tests/e2e/weekly-report.spec.ts:299` without work hours the weekly report goes out on Friday between 09:00 and 10:00, and an empty week has zero totals
- `tests/e2e/weekly-report.spec.ts:333` work hours changed during the week move that week's report to the new last workday (edge case 3)
