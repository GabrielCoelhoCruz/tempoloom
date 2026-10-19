# Planner

Spec id: SPEC-PLANNING-10
Evidence: E-0010 (ev_3ce2126cfbf4), E-0043 (ev_d7b30359b03e), E-0054 (ev_782851ade647), E-0081 (ev_dfcc5d3b7c8c), E-0089 (ev_e7262cc4064c), E-0098 (ev_cefc23278fd5), E-0129 (ev_bdc8d723c6ba), E-0130 (ev_9c04afccf625), E-0132 (ev_a9d46d5e4718), E-0139 (ev_28aa8ef849b8), E-0141 (ev_d12320a15a83), E-0183 (ev_000dae433420), E-0192 (ev_d71469f89e0b), E-0193 (ev_68ba14aa780b), E-0199 (ev_9b5fb0c6b1ba)
Status of evidence: public docs only

## Summary

The planner is the main page of Tempoloom. It shows a day or week calendar
with all events from the connected calendars, marks managed events by status,
and lets the user act on them: drag, resize, open details, and run actions
from a menu. Side panels show priorities, tasks, automations and the
assistant chat.

## Concepts and inputs

| Setting | Values | Default |
|---|---|---|
| `view` | `day`, `week` | Proposed default: `week` |
| `dayFilter` | `all-days`, `weekdays`, `rolling-9-days` | Proposed default: `all-days` |
| `weekStart` | weekday | from the user's Google Calendar setting (E-0199) |
| `hiddenCalendars` | set of calendar ids | empty |
| `sidePanel` | `priorities`, `tasks`, `details`, `automations`, `chat`, closed | Proposed default: `tasks` |

`dayFilter` and `hiddenCalendars` persist across sessions (E-0139).

## Behavior

### Calendar view

- **PLN-1.** The calendar view shows events from all connected calendars, that
  is, all calendars that affect the user's availability (legacy evidence,
  E-0139).
- **PLN-2.** Buttons above the calendar move one day or one week back or
  forward, return to today, and switch between day and week view (legacy
  evidence, E-0139).
- **PLN-3.** A gear menu sets `dayFilter`: all days, weekdays only, or a
  rolling 9 days that runs into the next week. The choice persists across
  sessions (legacy evidence, E-0139).
- **PLN-4.** The planner draws a free managed event with a dashed border and
  a busy event with a solid fill and border (E-0089, E-0139).
- **PLN-5.** A day with a busy all-day event shows a grey dashed pattern
  across the day, because the event uses the day's availability (legacy
  evidence, E-0139).
- **PLN-6.** A "view as" control shows the schedule as other people see it:
  free events look open and private details are hidden (legacy evidence,
  E-0139).
- **PLN-7.** The planner shows what is next and lets the user join the
  current or next meeting with one click, using the meeting's conference link
  (E-0010).
  Tempoloom decision: the line above the week shows the meeting in progress,
  else the next one in the coming 7 days (timed, not declined, not all day),
  with its time. "Join" opens the first `http` or `https` link of the
  location, else of the description, in a new tab. No vendor app is needed.

### Event interaction

- **PLN-10.** A click on any event opens its details in the details panel.
  The content depends on the event kind (legacy evidence, E-0139).
- **PLN-11.** A right-click on an event opens its action menu (legacy
  evidence, E-0139). Actions per kind:

| Kind | Actions |
|---|---|
| Task chunk | Start, Stop, Restart, Lock or Unlock, Reschedule (past chunk), Snooze, Add time, Log work, Mark done, Set due date, Send to next up, Delete task |
| Habit event | Start (manual start mode), Lock or Unlock, Skip, Snooze, Reschedule |
| Flexible meeting event | Reschedule, Skip, Lock or Unlock |
| Focus time event | Lock or Unlock, assign task search |
| External event | Set priority; "Make a habit" for a recurring event with no other attendees |

  Sources: E-0132 (tasks), E-0130 (habits), E-0081 (make a habit, current),
  E-0192 (task search, current). Legacy evidence for the task and habit rows.
- **PLN-12.** The user can drag and drop any managed event and drag its edge
  to change its length. This locks the event (legacy evidence, E-0139;
  `planning-locks.md` LCK-20, LCK-21).
- **PLN-13.** External events cannot be dragged in the planner. Proposed
  default; the evidence only names managed events.
- **PLN-14.** A click or drag on an empty future time opens a short form to
  create a task or a habit at that time. The created event is locked there
  (legacy evidence, E-0054, E-0193).
- **PLN-15.** A click or drag on a past time opens a form to log work for a
  task or a habit (legacy evidence, E-0054, E-0130, E-0132).
- **PLN-16.** The keyboard key `C` opens the task creation form from any page
  (legacy evidence, E-0054, E-0193).

### Side panels

- **PLN-20.** A connected calendars panel lists the connected calendars. The
  user can hide or show each one. Hiding does not disconnect it; the
  scheduler still treats its events as busy. An "Edit calendars" button opens
  the connected calendars settings (legacy evidence, E-0139).
- **PLN-21.** The details panel has three modes: priorities, tasks, and event
  details (legacy evidence, E-0139).
- **PLN-22.** The priorities mode lists all managed items by priority, with
  drag and drop between levels, a search box and an edit button
  (`planning-priorities.md` PRI-53).
- **PLN-23.** The tasks mode lists tasks by priority, with the next-up queue
  area at the top and the state filters (legacy evidence, E-0139;
  `planning-next-up.md`).
- **PLN-24.** Current reference: the planner also holds the automation list
  grouped by priority (`planning-priorities.md` PRI-54), suggested tasks, and
  the assistant chat on the right (E-0183, E-0098, E-0043).
- **PLN-25.** Current reference: changes proposed by the assistant chat, and
  the effect of creating or editing an automation, appear on the planner as a
  preview before the user applies them (E-0183, E-0043). Assistant chat spec
  owns the preview.

## Outputs

- No calendar change from viewing.
- Drag, resize, create and actions change Google Calendar as stated in the
  linked specs, within 15 seconds.
- Persisted UI settings: `dayFilter`, `hiddenCalendars`.

## Edge cases

1. A drag onto a time outside the item's hours: allowed; the event is locked
   there. Proposed default.
2. A drag of a chunk into the past: see `planning-calendar-edits.md` edge
   case 2.
3. A hidden calendar has an event that overlaps a managed event: the overlap
   still blocks scheduling (PLN-20).
4. The user's week start changes in Google Calendar: the week view and weekly
   rules use the new start after the next sync (E-0199).
5. The planner is open in two tabs: a change in one shows in the other within
   15 seconds. Proposed default.

## Observed API shapes

Not yet observed.

## Open questions

1. Which actions does the current planner offer on each event kind? Only the
   legacy pages list them.
2. Can the user drag external events in the current planner?
3. Default view and default side panel.

## Acceptance tests

Fixture F0 from `planning-scheduler.md`.

1. **Day filter persists.** Action: set `dayFilter` to weekdays. Expected:
   the week view shows Monday to Friday only. Reload: still weekdays only.
2. **Drag in planner updates Google.** Setup: task "AT-PL2", 60 minutes,
   placed Monday W 09:00. Action: drag it to Tuesday W 11:00 in the planner.
   Expected within 60 s: Google shows it Tuesday 11:00 to 12:00, busy, with
   the lock marker. Reload: same.
3. **Create on the planner.** Action: drag Wednesday W 15:00 to 16:00 and
   create habit "AT-PL3". Expected: Google has a locked busy event Wednesday
   15:00 to 16:00 titled with "AT-PL3". Reload: same.
4. **Log work on a past time.** Setup: task "AT-PL4", 120 minutes. Action:
   click yesterday 10:00 to 11:00 and log work for "AT-PL4". Expected: the
   task's remaining work is 60 minutes; future chunks total 60 minutes.
   Reload: same.
5. **Hidden calendar still blocks.** Setup: a connected secondary calendar
   with a busy event Thursday W 09:00 to 17:00. Action: hide that calendar
   in the panel; create task "AT-PL5", 60 minutes, due Friday W 17:00,
   `startAfter` Thursday W 00:00. Expected: the event is not shown in the
   planner, and "AT-PL5" is on Friday. Reload: the calendar is still hidden
   and still connected.
6. **Busy all-day pattern.** Setup: a busy all-day external event on Monday W.
   Expected: the planner shows the dashed pattern on Monday; no managed event
   is placed on Monday W. Reload: same.
