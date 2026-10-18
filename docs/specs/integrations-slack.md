# Slack integration

Spec id: SPEC-INT-02
Evidence: E-0153 (ev_74bd257356a8), E-0035 (ev_d1ed7fdbfba5), E-0175 (ev_a882fe6f4503), E-0050 (ev_1ebfdf1c8d86), E-0112 (ev_e0d7410b3a66), E-0225 (ev_3b843f2311fe), E-0021 (ev_4fa8057a844a), E-0189 (ev_d31be1b5cb3f)
Status of evidence: public docs only

## Summary

The user connects a Slack workspace. Tempoloom then sets the user's Slack
status and Do Not Disturb (DND) from the calendar, and sends calendar
notifications and daily and weekly summaries as Slack messages. The Slack
app home and slash commands let the user see the agenda, manage tasks and
share booking links. In the current reference version, the user can also
use the assistant chat inside Slack.

## Concepts and inputs

### Scope and evidence

Most detail comes from legacy evidence (version 1.0 pages). The current
pages confirm status sync, focus-time DND, notifications, task creation,
booking links and the assistant chat, but give fewer details.

### Fields

Slack connection (one per Tempoloom user and Slack workspace):

| Field | Type | Default | Notes |
|---|---|---|---|
| `workspace_id`, `workspace_name` | string | | |
| `slack_user_id` | string | | |
| `bot_token` | secret | | Messages, app home, commands. |
| `user_token` | secret | | Status writes. |
| `dnd_granted` | bool | false | True after the extra DND consent. |

Status sync settings (per Tempoloom user, used for all linked workspaces):

| Field | Type | Default | Allowed values |
|---|---|---|---|
| `enabled` | bool | false | The user turns it on. |
| `display_mode` | enum | `category` (Proposed default) | `category`, `busy_only`, `custom` |
| `outside_hours_set` | hours set id or null | null | Work hours, personal hours, meeting hours. |
| `outside_hours_dnd` | bool | false | |
| `custom[category].text` | string, max 100 chars | see table below | May contain `{title}`. |
| `custom[category].emoji` | Slack emoji code | see table below | |
| `custom[category].dnd` | bool | false | |
| `calendars` | list of calendar ids | all calendars of the main account (Proposed default) | Any connected calendar. |

Status categories. The categories come from automatic event categories
(`events-categories-and-colors.md`). Default texts and emoji are Proposed defaults; the reference
shows only that the category mode names the category without details.

| Status category | Category id (`events-categories-and-colors.md`) | Default text | Default emoji |
|---|---|---|---|
| Meeting | `team_meeting` | In a meeting | `:calendar:` |
| External meeting | `external_meeting` | In an external meeting | `:handshake:` |
| One-on-one | `one_on_one` | In a 1:1 | `:busts_in_silhouette:` |
| Shallow solo work | `solo_work`, event shorter than 2 hours | Working | `:computer:` |
| Deep solo work | `solo_work`, event of 2 hours or more; also focus time | Focusing | `:headphones:` |
| Personal | `personal`, `personal_commitment` | Personal time | `:house:` |
| Vacation | `vacation` | On vacation | `:palm_tree:` |
| Travel | `travel`, except recovery buffers | Traveling | `:car:` |
| Recovery buffer | recovery buffers (`buffers-automation.md`) | Taking a break | `:coffee:` |
| Flight | `flight` | On a flight | `:airplane:` |
| Private | any event marked private | Busy | `:no_entry:` |

The 2-hour split between shallow and deep solo work follows the stats rule
of `events-categories-and-colors.md`. Using it for status is a Proposed
default.

"Private" covers mirrored events, tasks and habits that the user marked
private. In every display mode, a private event never shows its title.

Notification settings (per user, editable in Slack and in the web app under
Settings > Notifications):

| Notification | Default |
|---|---|
| New meeting invitation | on |
| Meeting updated | on |
| Meeting cancelled | on |
| Event starting soon | on, 5 minutes before start (Proposed default) |
| Conflicts | on |
| Daily digest | on |
| Weekly digest | on |

Defaults are Proposed defaults; the reference does not state them.

## Behavior

### Install and link

1. The user connects from Settings > Integrations > Slack (overview spec
   rules apply), or installs the app from the Slack app directory.
2. When the install starts in Slack, the app home asks the user to link a
   Tempoloom account. The link opens Tempoloom login, then returns to Slack.
3. A user can link several Slack workspaces. Each workspace is a separate
   install and connection.
4. A Slack workspace may require admin approval of the app. Slack shows this
   during consent.

### App home

5. The app has three tabs: Home, Messages and About.
6. Home has four sections: Agenda, Tasks, Booking links and Settings.
7. Agenda lists today's events from the included calendars, in start-time
   order. Each event has "Join" (when it has a conference link) and "Open in
   calendar". Overlapping events show a conflict marker.
8. Tasks lists the user's open tasks. Each task has these actions: start
   now (move it to next up), reschedule, mark done, and edit (title, due
   date, priority and the other task fields of `planning-tasks.md`). A "New
   task" button opens a task form in a Slack modal.
9. Booking links lists the user's booking links. The title opens the link.
   A copy action gives the URL. A "New booking link" action opens the
   booking link editor in the web app.
10. Settings shows status sync, notifications and calendar selection.
11. About shows app and workspace information.

### Slash commands

The reference uses its own product name as the command. Tempoloom uses
`/tempoloom`.

12. `/tempoloom agenda` replies, visible only to the user, with today's
    agenda (same content as rule 7).
13. `/tempoloom settings` opens the Settings view.
14. `/tempoloom <work|personal> task <title> (<options>)` creates a task.
    `work` selects work hours and `personal` selects personal hours. The
    options block uses the grammar in `integrations-task-sync.md`. Example
    from the reference, in our syntax: `/tempoloom work task Review metrics
    (critical nextup duration:30 mins, due:tomorrow)`. The reply confirms
    the task and links to it.
15. `/booking-link` shares a booking link in the current channel. With one
    link, it posts that link. With more than one, it asks the user to choose
    one first.

### Create a task from a message

16. The message action menu has "Create a task" (under more message
    shortcuts). It opens the task form. Proposed default: the title is the
    first 100 characters of the message, and the notes contain the message
    text and a permalink to the message.

### Notifications and digests

17. Tempoloom sends a Slack message (Messages tab) when:
    - the user gets an invitation to a new meeting;
    - a meeting is updated or cancelled;
    - an event starts soon;
    - events conflict;
    - the daily or weekly digest is due.
18. Each message has action buttons. Invitations have Accept and Decline
    (they change the user's RSVP in the calendar). All event messages have
    "Open in calendar". Conflict messages have "Resolve in Planner".
19. The daily digest lists the day's agenda, the overlapping events, and
    the meetings that still wait for the user's RSVP. Proposed default: send
    it at the start of the user's first work-hours interval of the day.
20. The weekly digest is sent at the end of the user's work week, as set by
    work hours. It shows how the week's time was spent by event category,
    and the conflicts in the next week.
21. A conflict is two or more busy events that overlap on the included
    calendars. Tempoloom does not report a conflict that involves a managed
    event the scheduler can move (task chunk, habit, focus time, flexible
    meeting). It does report conflicts that involve a travel buffer or a
    locked managed event.
22. The settings view shows a hint: the user can get duplicate messages
    when another calendar app for Slack also sends notifications.

### Status sync

23. Status sync uses only busy events. An event with free defense or free
    transparency never sets a status. Declined events never set a status.
    (Declined: Proposed default.)
24. Every minute, and on each calendar change, Tempoloom selects the current
    event: a busy, in-progress event on an included calendar.
25. When several events are in progress and have the same start and end,
    Tempoloom selects the one that was updated last. For other overlaps,
    Proposed default: select the event that started last; on a tie, the one
    updated last.
26. Status text by `display_mode`:
    - `category`: the category's default text. No title or other detail.
    - `busy_only`: the text "Busy" for every event.
    - `custom`: the user's text for the category. `{title}` is replaced
      with the event title as the user sees it in the calendar.
27. Tempoloom sets the status emoji from the category and sets the status
    expiration to the event end. (Expiration: Proposed default.)
28. When the selected event is deleted, moved away from now, or changes to
    free, Tempoloom clears the status it set.
29. When the user clears the status in Slack, Tempoloom does not set it
    again for that event. The next event that starts sets a status again.
30. Tempoloom changes or clears only a status that Tempoloom set. Proposed
    default: when the user has a manual status, Tempoloom does not replace
    it.
31. Outside hours: when `outside_hours_set` is set and now is outside that
    hours set, Tempoloom sets an outside-hours status (Proposed text "Outside
    working hours", emoji `:crescent_moon:`). When `outside_hours_dnd` is
    true, it also turns on DND until the next interval of the hours set
    starts. Events outside the hours set do not change the status.
32. DND by category: when the current event's category has `dnd` true,
    Tempoloom turns on Slack DND until the event end. Slack then tells
    people who message the user that notifications are paused.
33. The first time the user turns on any DND option, Tempoloom asks for the
    extra Slack permission to set DND. Until the user grants it, DND options
    stay off.
34. Current version: focus time events turn on DND automatically, and DND
    ends when the focus time event ends. Proposed default: this is the
    default value of `custom["Deep solo work"].dnd` and of focus time events
    in all display modes.
35. Zoom presence can also set the status (`integrations-video-
    conferencing.md`). While a Zoom call is in progress, the Zoom status
    wins. After the call, Tempoloom applies rule 24 again.
36. Turning status sync off clears the status that Tempoloom set. Turning it
    on again computes the status at once. This also resets a status that
    another app changed.
37. With several linked workspaces, Tempoloom sets the same status in each.
    (Proposed default.)
38. Legacy evidence: the reference shows the full habit name in the status
    when the habit uses its default privacy, in every display mode.
    Proposed default: Tempoloom always follows `display_mode`. See open
    questions.

### Assistant chat in Slack (current version)

39. The user can send natural-language requests to the app in a direct
    message. Tempoloom answers with the assistant chat (`assistant-chat.md`).
    Request kinds in the reference:
    - the day's schedule, or the schedule of a named day;
    - finding time with named people;
    - blocking time;
    - free time next week;
    - the best task for now.
40. Requests that change the calendar go to preview mode
    (`assistant-preview-mode.md`).

### Organization status policy

41. An enterprise admin can define status sync settings for the whole
    organization, a team or a role. Policies select users by directory
    attributes from user provisioning, for example department, job title,
    team or seniority. When a user's attributes change, the matching policy
    changes too. Team policies, benchmarks and interruption analytics
    belong to `teams-policies.md` (chat status policy rules). This spec requires only that a team
    policy can supply the status sync settings of a user.

### Disconnect and uninstall

42. Disconnect in Settings > Integrations > Slack stops notifications,
    status sync, commands and assistant chat for that user. Proposed
    default: Tempoloom first clears the status it set.
43. In Slack, a user can revoke only their own authorization from the app's
    configuration page. A workspace admin can remove the app for the whole
    workspace. Both change the affected connections to `disconnected`.
44. Slack messages that Tempoloom already sent stay in Slack under the
    workspace retention rules. Managed events stay on the calendar.

### Troubleshooting surface

45. When the status that Tempoloom set is changed by another app within 5
    minutes, the settings view shows a hint. The hint says that another app,
    for example a calendar app for Slack, can override the status. It also
    says that turning status sync off and on resets the status. (Detection rule:
    Proposed default.)

## Outputs

- Slack status: text (max 100 characters), emoji, expiration time.
- Slack DND snooze with an end time.
- Slack messages with action buttons; app home views; modals.
- Calendar changes only from user actions: RSVP from an invitation message,
  task actions, and task creation (task chunks per `planning-tasks.md`).

## Edge cases

1. `{title}` with an empty event title: replace with the category default
   text.
2. Status text longer than 100 characters after `{title}` replacement:
   truncate to 99 characters and add "…".
3. All-day busy event (for example vacation): the status lasts until the end
   of the day in the user's time zone.
4. The current event ends and the next one starts at the same minute: set
   the new status without a clear in between.
5. A private event in `custom` mode with `{title}`: use the category text
   without the title.
6. The user's Slack token is revoked: the connection becomes
   `disconnected`; no further status writes.
7. The calendar event is a mirrored copy (calendar mirroring): use the copy's
   busy state; the copy title follows the mirroring privacy rule.
8. Two linked workspaces and the user clears the status in one: Proposed
   default: do not set it again in that workspace for that event only.

## Observed API shapes

Not yet observed.

## Open questions

1. What is the default display mode, and what are the default texts and
   emoji per category?
2. How does the reference choose between overlapping events that do not
   have the same time range?
3. Does the reference overwrite a status that the user set by hand?
4. When is the daily digest sent, and how long before an event is the
   "starting soon" message sent?
5. Should Tempoloom copy the legacy habit-name behavior (rule 38)? It looks
   like a privacy defect.
6. In the current version, which settings remain in the Slack app home, and
   which moved to the web app?
7. Can a user override an organization status policy?
8. Which fields does the "Create a task" message shortcut fill in?

## Acceptance tests

Common setup: Tempoloom user with a Google Calendar test account and a Slack
test workspace. Slack connected, status sync on, `display_mode` =
`category`, all calendars included.

1. Status from a busy meeting.
   - Setup: no event now.
   - Action: create a Google Calendar event from now to now + 30 minutes,
     title "Design review", one other attendee, busy.
   - Expected: within 1 minute, the Slack status shows the meeting text and
     emoji, no title, and expires at the event end. Calendar unchanged.
   - Reload: reload Slack and the Tempoloom settings view. The status and
     the "status sync on" state remain.
2. Free event sets no status.
   - Action: create an event from now to now + 30 minutes, marked free.
   - Expected: no status within 2 minutes.
   - Reload: after reload, still no status.
3. Delete clears the status.
   - Setup: test 1 state.
   - Action: delete the event in Google Calendar.
   - Expected: within 1 minute, the status is empty.
   - Reload: the status is still empty after reload.
4. Custom text with the title.
   - Setup: `display_mode` = `custom`; deep solo work text = "Heads down:
     {title}".
   - Action: create a busy event now that the categorizer marks as deep solo
     work, title "Write spec".
   - Expected: the status is "Heads down: Write spec".
   - Reload: same status after reload.
5. Same time range overlap.
   - Action: create events A and B with the same start and end now. Then
     edit B's title.
   - Expected: the status follows B.
   - Reload: same status after reload.
6. Manual clear is respected.
   - Setup: test 1 state.
   - Action: clear the status in Slack. Wait 3 minutes.
   - Expected: the status stays empty. A second event that starts later
     sets the status again.
   - Reload: same result after reload.
7. DND by category.
   - Setup: meeting category `dnd` = true; DND permission granted.
   - Action: create a busy meeting from now to now + 15 minutes.
   - Expected: Slack DND is on until the event end.
   - Reload: Slack still shows DND until the end time.
8. Task from a slash command.
   - Action: run `/tempoloom work task Review metrics (high duration:1h
     due:tomorrow)`.
   - Expected: a task "Review metrics" exists with priority P2, duration 1
     hour, due tomorrow, work hours. Its chunks appear in Google Calendar
     before the due date (`planning-tasks.md`). The title has no options
     block.
   - Reload: reload the web app and Google Calendar. The task and chunks
     remain.
9. Share a booking link.
   - Setup: the user has exactly one booking link.
   - Action: run `/booking-link` in a channel.
   - Expected: the channel shows the link URL. With two links, the command
     first asks which link to post.
   - Reload: the message stays in the channel.
10. Conflict message.
    - Action: create two overlapping busy external events for tomorrow.
    - Expected: a conflict message with "Resolve in Planner". Creating a
      task chunk that overlaps a meeting creates no conflict message.
    - Reload: the message stays in the Messages tab.
11. Disconnect.
    - Setup: test 1 state.
    - Action: disconnect Slack in Settings > Integrations.
    - Expected: the status is cleared; new events set no status; no new
      messages arrive. Calendar unchanged.
    - Reload: the card shows "not connected".
