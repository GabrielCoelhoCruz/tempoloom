# Parity rows: A-core-planning

Group A (core planning). One row per user-visible feature or sub-feature.

| Feature | Evidence | Spec | Notes |
|---|---|---|---|
| Create a task with only a title; defaults fill the rest | E-0193, E-0056 | planning-tasks.md#creation | legacy only |
| Keyboard key C opens task creation | E-0054, E-0193 | planning-tasks.md#creation | legacy only |
| "Create another" switch on the task form | E-0192 | planning-tasks.md#creation | current version |
| Create a task from the create menu or the tasks page | E-0192 | planning-tasks.md#creation | current version |
| Create a task by click or drag on the planner (locked) | E-0054, E-0193 | planning-tasks.md#creation | legacy only |
| Create a task from the assistant chat | E-0192, E-0098 | planning-tasks.md#creation | assistant chat spec owns the chat |
| Task total duration, minimum 15 minutes | E-0193 | planning-tasks.md#task-fields | legacy only |
| Split a task into chunks with min and max chunk size | E-0193, E-0120, E-0056 | planning-tasks.md#chunking | legacy only |
| Chunk spacing and cooldown options | E-0056, E-0193 | planning-tasks.md#chunking | legacy only; default proposed |
| Task priority P1 to P4, default P2 | E-0193, E-0209 | planning-tasks.md#task-fields | legacy only |
| Task due date, default 3 days | E-0193 | planning-tasks.md#due-date-and-start | legacy only |
| Task earliest start (start after) | E-0193, E-0056 | planning-tasks.md#due-date-and-start | legacy only |
| Work past the due date is placed late and made busy | E-0120, E-0216 | planning-tasks.md#due-date-and-start | legacy only |
| Snooze a task | E-0054, E-0132 | planning-tasks.md#due-date-and-start | legacy only; choices proposed |
| Task notes shown in the event description | E-0193, E-0206 | planning-event-content.md#description |  |
| Task visibility: private or calendar default | E-0193, E-0056 | planning-event-content.md#visibility | legacy only |
| Default task settings page | E-0056 | planning-tasks.md#user-task-defaults | legacy only; values partly proposed |
| Relative default start delay and due-in | E-0056 | planning-tasks.md#creation | legacy only |
| Short default duration for tasks made from chat-app or mail messages | E-0056 | planning-tasks.md#user-task-defaults | legacy only; integration |
| Task state filters: open, scheduled, time used, done | E-0190 | planning-tasks.md#states-and-filters | legacy only |
| Unscheduled task shows why it is not placed | E-0190, E-0226 | planning-scheduler.md#reporting-what-cannot-be-placed | reason codes proposed |
| Mark a task done; future chunks removed | E-0132, E-0190, E-0054 | planning-tasks.md#actions-on-a-task |  |
| Add time to a task | E-0132, E-0190 | planning-tasks.md#actions-on-a-task | legacy only |
| Delete a task with all its events | E-0132 | planning-tasks.md#actions-on-a-task | legacy only |
| Bulk edit tasks | E-0132 | planning-tasks.md#actions-on-a-task | legacy only |
| Synced task priority editable only in source app (Asana exception) | E-0132, E-0209 | planning-tasks.md#actions-on-a-task | legacy only |
| Calendar for task chunks per hours set | E-0172, E-0193, E-0054 | planning-tasks.md#target-calendar |  |
| Task list filters: due date, start date, state, hours set | E-0193 | planning-tasks.md#task-list-views | legacy only |
| Task list sort, including scheduling order | E-0193 | planning-tasks.md#task-list-views | legacy only |
| Suggestions-only task mode (no chunk events) | E-0183, E-0192 | planning-tasks.md#placement-mode | current version; mode switch proposed |
| Start mode: count chunks automatically or only after Start | E-0048, E-0068 | planning-task-progress.md#counting-work | legacy only |
| Past chunks count as done work | E-0120 | planning-task-progress.md#counting-work | legacy only |
| Manual start mode moves an unstarted chunk later that day | E-0048 | planning-task-progress.md#counting-work | legacy only |
| Start a task (first chunk moves to now) | E-0132 | planning-task-progress.md#start-stop-restart | legacy only |
| Stop a task (chunk ends now, rest placed later) | E-0132 | planning-task-progress.md#start-stop-restart | legacy only |
| Restart a task | E-0132 | planning-task-progress.md#start-stop-restart | legacy only |
| Log work on a task | E-0132, E-0054 | planning-task-progress.md#logging-work | legacy only |
| Log work by clicking a past time in the planner | E-0054, E-0130, E-0132 | planning-task-progress.md#logging-work | legacy only |
| Task timer with stop dialog | E-0192, E-0098 | planning-task-progress.md#timer-current-reference | current version |
| Time-used action: nothing, re-add, or mark done after N days | E-0048, E-0068 | planning-task-progress.md#tasks-whose-time-is-used | legacy only |
| Next-up queue goes before all other tasks | E-0209, E-0212 | planning-next-up.md#next-up-queue-legacy-evidence | legacy only |
| Rank the next-up queue by drag and drop | E-0212 | planning-next-up.md#next-up-queue-legacy-evidence | legacy only |
| Add or remove tasks from the queue (arrows, drag) | E-0212, E-0139, E-0132 | planning-next-up.md#next-up-queue-legacy-evidence | legacy only |
| New task to queue: form switch and default setting | E-0056, E-0193, E-0212 | planning-next-up.md#next-up-queue-legacy-evidence | legacy only |
| Next-up task shown in the planner | E-0010 | planning-next-up.md#next-up-task | rule proposed |
| Suggested now and at-risk task lists | E-0192 | planning-next-up.md#task-suggestions-current-reference | current version; ranking proposed |
| Ask the assistant chat what to work on | E-0192, E-0098 | planning-next-up.md#task-suggestions-current-reference | assistant chat spec owns the chat |
| Saved task search tied to focus time | E-0192, E-0077 | planning-next-up.md#task-searches-tied-to-focus-time-and-habits-current-reference | current version |
| Saved task search per habit | E-0192, E-0081 | planning-next-up.md#task-searches-tied-to-focus-time-and-habits-current-reference | current version |
| Task search on the meeting overload automation | E-0192 | planning-next-up.md#task-searches-tied-to-focus-time-and-habits-current-reference | current version |
| Work blocks for tasks on request, as a preview | E-0192 | planning-next-up.md#work-blocks-on-request-current-reference | current version |
| Four priority levels P1 to P4 | E-0141, E-0090 | planning-priorities.md#ordering |  |
| Higher priority takes time from lower managed items | E-0141, E-0088 | planning-priorities.md#taking-time-overbooking |  |
| Booking-link meetings are never booked over | E-0141, E-0090 | planning-priorities.md#taking-time-overbooking |  |
| Stack rank inside a priority level | E-0141, E-0043 | planning-priorities.md#ordering | current version |
| Same-level kind order: meetings, habits, tasks | E-0090, E-0088, E-0142 | planning-priorities.md#ordering | legacy only |
| Tasks of one level ordered by due date | E-0090, E-0209 | planning-priorities.md#ordering | legacy only |
| Urgency mode setting (due date and remaining work) | E-0068 | planning-priorities.md#concepts-and-inputs | legacy only; formula proposed |
| Focus time placed last, protected as P2 once placed | E-0077, E-0141, E-0200 | planning-priorities.md#focus-time |  |
| Recurring external event priority: this one or all | E-0104 | events-external-priority.md#behavior | legacy only |
| Events from other connected calendars stay P1 | E-0104 | events-external-priority.md#behavior | legacy only |
| Booking link offers time of lower-priority items | E-0141, E-0088 | planning-priorities.md#booking-links-and-priority | booking link spec owns links |
| Priorities page with four columns and drag and drop | E-0090, E-0200 | planning-priorities.md#setting-priorities | legacy only |
| Planner priorities view | E-0090, E-0139 | planning-priorities.md#setting-priorities | legacy only |
| Automation list grouped by priority, drag to reorder, filter | E-0141, E-0043 | planning-priorities.md#setting-priorities | current version |
| Change task and habit priority in the Google Calendar add-on | E-0090 | planning-priorities.md#setting-priorities | legacy only; add-on |
| Priority mapping from task integrations | E-0209 | planning-priorities.md#priority-from-task-integrations-legacy-evidence-e-0209 | legacy only; integration spec |
| Overlapping external events flagged, not moved | E-0141 | events-external-priority.md#behavior | current version |
| Work hours | E-0172 | planning-hours.md#behavior |  |
| Meeting hours | E-0172 | planning-hours.md#behavior |  |
| Personal hours | E-0172 | planning-hours.md#behavior |  |
| Custom hours sets with title, description and allowed kinds | E-0172 | planning-hours.md#behavior | plan-gated in reference |
| Several ranges per day and copy to all days | E-0172 | planning-hours.md#behavior |  |
| Hours changes apply to existing events | E-0172 | planning-hours.md#behavior |  |
| Deleting a custom set asks for a replacement | E-0172 | planning-hours.md#behavior |  |
| Item-specific hours (not for tasks) | E-0172, E-0081, E-0077, E-0176 | planning-hours.md#item-specific-hours |  |
| Hours preview in item editors | E-0172 | planning-hours.md#behavior |  |
| Hours time zone label from Google | E-0172, E-0199 | planning-hours.md#behavior | source conflict with E-0222 |
| First-run review of hours | E-0098 | planning-hours.md#behavior | current version |
| Wrong-hours check: browser UTC or old travel zone | E-0222 | planning-hours.md#edge-cases | troubleshooting |
| Scheduling window setting | E-0042 | planning-scheduling-window.md#behavior | plan-gated in reference |
| Separate, longer window for calendar mirroring | E-0042 | planning-scheduling-window.md#behavior | mirroring spec owns it |
| Task with start after the window is not placed | E-0190, E-0226 | planning-scheduling-window.md#behavior | legacy only |
| Automatic rescheduling on calendar changes (about 15 s) | E-0088, E-0010 | planning-scheduler.md#triggers |  |
| Rule changes re-place the item's events | E-0105 | planning-scheduler.md#triggers | legacy only |
| Invitations block only after yes or maybe | E-0088 | planning-scheduler.md#blocking-rules |  |
| Free external events do not block | E-0089, E-0161 | planning-scheduler.md#blocking-rules |  |
| Busy all-day events block the whole day | E-0226, E-0139 | planning-scheduler.md#blocking-rules | troubleshooting |
| Free and busy event tags change what tasks and habits may use | E-0161, E-0201, E-0203 | planning-scheduler.md#blocking-rules | tag spec owns tag syntax |
| Processing order across all item kinds | E-0141, E-0090, E-0077, E-0209 | planning-scheduler.md#processing-order | full order proposed |
| Report of items that cannot be placed, with reasons | E-0226, E-0190, E-0141, E-0183 | planning-scheduler.md#reporting-what-cannot-be-placed | codes proposed |
| Change log explaining moves and skips | E-0092 | planning-scheduler.md#reporting-what-cannot-be-placed | legacy only; meetings |
| Preview of an automation's calendar effect before apply | E-0043, E-0077, E-0081, E-0051 | planning-scheduler.md#triggers | current version |
| Remove or keep as conflict when no time is left | E-0081, E-0176, E-0051 | planning-scheduler.md#placement-of-each-demand | current version |
| Managed events start free and turn busy when time is short | E-0088, E-0089 | planning-defense.md#general |  |
| Planner shows free dashed, busy solid | E-0089, E-0139 | planning-defense.md#general |  |
| Task chunk free/busy rule | E-0120, E-0216 | planning-defense.md#task-chunks-legacy-evidence | legacy only; test form proposed |
| Habit defense modes | E-0196, E-0081 | planning-defense.md#habits | adaptive thresholds proposed |
| Flexible meeting turns busy within 12 hours or last slot | E-0092 | planning-defense.md#flexible-meetings-legacy-evidence | legacy only |
| Focus time does not switch free and busy | E-0089 | planning-defense.md#focus-time-buffers-booking-link-meetings |  |
| Busy or free setting per automation | E-0043, E-0081 | planning-defense.md#focus-time-buffers-booking-link-meetings | current version |
| Task chunks on a secondary calendar to keep availability | E-0054 | planning-defense.md#secondary-calendars | legacy only |
| Locked events are busy and never move | E-0108, E-0045, E-0089 | planning-locks.md#effect-of-a-lock |  |
| Manual lock and unlock | E-0108, E-0132, E-0081 | planning-locks.md#manual-lock-and-unlock |  |
| Moving or resizing an event locks it | E-0108, E-0077, E-0081, E-0176 | planning-locks.md#automatic-locks-from-user-actions |  |
| Auto-lock per kind: off, day, week | E-0045, E-0068, E-0108 | planning-locks.md#auto-lock-schedule-legacy-evidence | legacy only; run time conflict |
| Unlock on delete, reschedule or decline | E-0045 | planning-locks.md#unlock-triggers | legacy only |
| Edits in Google Calendar are kept and lock the event | E-0103, E-0108 | planning-calendar-edits.md#other-detail-edits | legacy only |
| Moved chunk: old slot excluded for that task | E-0216 | planning-calendar-edits.md#moves-and-resizes-of-task-chunks-legacy-evidence | legacy only |
| Moving the first chunk sets the task's start | E-0216 | planning-calendar-edits.md#moves-and-resizes-of-task-chunks-legacy-evidence | legacy only |
| Chunk moved past the due date makes all chunks busy | E-0216 | planning-calendar-edits.md#moves-and-resizes-of-task-chunks-legacy-evidence | legacy only |
| Resizing a chunk returns or uses minutes | E-0216, E-0132 | planning-calendar-edits.md#moves-and-resizes-of-task-chunks-legacy-evidence | legacy only |
| Deleting a future chunk places it again from the next day | E-0216, E-0132 | planning-calendar-edits.md#deletes | legacy only |
| Deleting a past chunk revives the task | E-0216, E-0191 | planning-calendar-edits.md#deletes | legacy only; troubleshooting |
| Deleting chunks never deletes the task | E-0191 | planning-calendar-edits.md#deletes | legacy only |
| Deleting a habit event finds another time; Skip cancels | E-0081, E-0130, E-0103 | planning-calendar-edits.md#deletes | evidence conflict |
| Deleting a focus time event skips it | E-0077 | planning-calendar-edits.md#deletes | current version |
| Declining a flexible meeting reschedules it | E-0103, E-0045 | planning-calendar-edits.md#declines | legacy only |
| Task chunk detail edits in Google are reverted | E-0216 | planning-calendar-edits.md#other-detail-edits | legacy only |
| Planner day and week views with navigation | E-0139 | planning-planner.md#calendar-view | legacy only |
| Planner day filter: weekdays, rolling 9 days | E-0139 | planning-planner.md#calendar-view | legacy only |
| "View as" other people | E-0139 | planning-planner.md#calendar-view | legacy only |
| Busy all-day pattern in the planner | E-0139 | planning-planner.md#calendar-view | legacy only |
| See what is next and join a meeting in one click | E-0010 | planning-planner.md#calendar-view | marketing page |
| Event details panel and right-click action menu | E-0139, E-0129, E-0132, E-0130 | planning-planner.md#event-interaction | legacy only |
| Drag and resize managed events in the planner | E-0139 | planning-planner.md#event-interaction | legacy only |
| Make a habit from a recurring event | E-0081 | planning-planner.md#event-interaction | current version |
| Connected calendars panel: show or hide | E-0139 | planning-planner.md#side-panels | legacy only |
| Planner details panel modes | E-0139 | planning-planner.md#side-panels | legacy only |
| Planner with chat, automations and suggested tasks | E-0183, E-0098, E-0043 | planning-planner.md#side-panels | current version |
| Event start alert in the browser tab | E-0125 | planning-notifications.md#in-app-alerts |  |
| Event start chime | E-0125 | planning-notifications.md#in-app-alerts |  |
| Default reminders by managed event kind | E-0125 | planning-notifications.md#calendar-reminders |  |
| Reminders setting per automation | E-0043, E-0051 | planning-notifications.md#calendar-reminders | current version |
| Flexible meeting change emails with days-ahead limit | E-0125 | planning-notifications.md#flexible-meeting-change-notices |  |
| At-risk meeting digest and new recurring meeting email | E-0125 | planning-notifications.md#planned-notices-not-yet-in-the-reference | coming soon in reference |
| Markdown in event descriptions | E-0206 | planning-event-content.md#description |  |
| Desktop app links in descriptions | E-0206 | planning-event-content.md#description |  |
| Link to the planner item in event descriptions | E-0130, E-0193 | planning-event-content.md#description |  |
| Calendar event tips setting | E-0068 | planning-event-content.md#description | legacy only |
| Visibility settings for habits and buffers | E-0081, E-0195, E-0043 | planning-event-content.md#visibility | plan-gated in reference |
| Turn off one automation to pause it | E-0043, E-0110 | planning-pause.md#pause-one-item |  |
| Account "Pause scheduling" action | E-0110 | planning-pause.md#pause-the-account-legacy-evidence | legacy only |
| Manual reset steps on the account page | E-0110 | planning-pause.md#manual-reset-steps-shown-to-the-user-legacy-evidence-e-0110 | legacy only |
| Profile data from Google: name, picture, time zone, week start, formats | E-0199 | settings-profile.md#behavior |  |
| Editable profile fields | E-0199 | settings-profile.md#behavior |  |
| Google permissions requested only when a feature needs them | E-0079 | accounts-login-emails-permissions.md#provider-permissions | group D spec |
