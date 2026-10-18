# Tasks

Spec id: SPEC-PLANNING-01
Evidence: E-0005 (ev_a5be14921792), E-0048 (ev_55efef88be5e), E-0054 (ev_782851ade647), E-0056 (ev_aa85baa4a4a9), E-0083 (ev_fd7912136937), E-0088 (ev_4fa475edc582), E-0105 (ev_3a08a4245510), E-0120 (ev_796e1e3fe2ef), E-0132 (ev_a9d46d5e4718), E-0172 (ev_d2989bf32eaf), E-0183 (ev_000dae433420), E-0190 (ev_39d8d5ed64d6), E-0191 (ev_91048df3c4da), E-0192 (ev_d71469f89e0b), E-0193 (ev_68ba14aa780b), E-0209 (ev_28b6d44e4b68), E-0216 (ev_d5d172ebc91e), E-0226 (ev_0dc4ddadd24f)
Status of evidence: public docs only

## Summary

A task is a piece of work with a total duration, a priority and an optional
due date. Tempoloom splits the duration into chunks and places each chunk as a
managed event inside the task's hours set, before the due date. The user sees
all tasks in a list, filters them by state, and changes, completes or deletes
them. Progress tracking (start, stop, log work) is in
`planning-task-progress.md`. Placement rules are in `planning-scheduler.md`.

Version note: the current reference version no longer creates chunk events
for tasks. It keeps tasks as a list and suggests them during focus time and
habit events (E-0183, E-0192; see `planning-next-up.md`). The glossary defines
a task as chunked and placed, so this spec specifies chunk placement from
legacy evidence. Most rules below are therefore marked "(legacy evidence)".

## Concepts and inputs

### Task fields

| Field | Type | Default | Allowed range |
|---|---|---|---|
| `title` | text | none (required) | 1 to 255 characters (Proposed default: limit) |
| `totalMinutes` | integer minutes | user default `defaultMinutes` | 15 or more, multiple of 15 (Proposed default: multiple of 15) |
| `splitUp` | boolean | user default `defaultSplitUp` | |
| `minChunkMinutes` | integer minutes | user default | 15 to `maxChunkMinutes` |
| `maxChunkMinutes` | integer minutes | user default | `minChunkMinutes` to `totalMinutes` |
| `priority` | P1, P2, P3, P4 | user default, P2 out of the box | |
| `dueAt` | date-time or empty | creation time + user default `dueIn` | after `startAfter` |
| `startAfter` | date-time | creation time + user default `startDelay` | any |
| `hoursSet` | reference | user default (work hours) | work, personal, meeting or a custom hours set; never item-specific hours |
| `notes` | markdown text | empty | see `planning-event-content.md` |
| `visibility` | `calendar-default` or `private` | user default | |
| `nextUp` | boolean plus rank | user default `defaultNextUp` (false) | see `planning-next-up.md` |
| `source` | `tempoloom` or an integration name | `tempoloom` | read-only |

Derived values, never set directly:

- `consumedMinutes`: minutes of chunks that ended, plus logged work.
- `remainingMinutes`: `totalMinutes` minus `consumedMinutes`, never below 0.
- `state`: see "States and filters".

When `splitUp` is false, `minChunkMinutes` and `maxChunkMinutes` both equal
`totalMinutes`.

### User task defaults

| Setting | Default | Evidence |
|---|---|---|
| `defaultPriority` | P2 | E-0193, E-0209 (legacy evidence) |
| `defaultNextUp` | false | E-0056 (legacy evidence) |
| `defaultMinutes` | Proposed default: 60 | value not in evidence |
| `defaultSplitUp` | Proposed default: true | value not in evidence |
| `defaultMinChunkMinutes` | Proposed default: 30 | value not in evidence |
| `defaultMaxChunkMinutes` | Proposed default: 120 | value not in evidence |
| `defaultHoursSet` | work hours | E-0056 offers work or personal (legacy evidence) |
| `startDelay` | Proposed default: 0 minutes | relative duration, E-0056 |
| `dueIn` | 3 days | E-0193 (legacy evidence) |
| `defaultVisibility` | `calendar-default` | E-0056 (legacy evidence) |
| `chunkCooldown` | Proposed default: `none` | options in E-0056 |
| `quickTaskMinutes` | 30 | E-0056; used for tasks made from chat-app messages or mail |

`chunkCooldown` options: `none` (place as many chunks as fit), `30m`, `1h`,
`2h`, `4h`, `once-per-day` (legacy evidence, E-0056).

### States

| State | Meaning | Filter label |
|---|---|---|
| `unscheduled` | Not done, `remainingMinutes` > 0, no future chunk | Open |
| `scheduled` | Not done, at least one future chunk | Open, Scheduled |
| `time-used` | Not done, `remainingMinutes` = 0, no future chunk | Open, Time used |
| `done` | The user marked it done, or an automatic rule did | Done |

## Behavior

### Creation

- **TSK-1.** Only `title` is required. Tempoloom fills every empty field from
  the user task defaults at creation time (legacy evidence, E-0193).
- **TSK-2.** `startDelay` and `dueIn` are relative. Example: with a delay of
  1 hour and a due-in of 3 days, a task created at Monday 10:00 gets
  `startAfter` Monday 11:00 and `dueAt` Thursday 10:00 (legacy evidence,
  E-0056).
- **TSK-3.** A change to the user task defaults applies to tasks created after
  the change. Existing tasks keep their values (legacy evidence, E-0056).
- **TSK-4.** Defaults apply to tasks created in Tempoloom and to tasks synced
  from task integrations. Tasks created from a chat-app message or a mail
  message use `quickTaskMinutes` for `totalMinutes` (legacy evidence, E-0056).
- **TSK-5.** The user can create a task from a "New task" button, with the
  keyboard key `C` from any page, and from the assistant chat (legacy
  evidence for the key, E-0054, E-0193; chat in E-0192).
- **TSK-6.** On the task creation form, a "create another" switch keeps the
  form open after save, so the user can add several tasks in a row (E-0192).
- **TSK-7.** The user can select a future time range in the planner (click
  or drag) and make a task there. The task gets `totalMinutes` equal to the selected
  range, and its one chunk is placed at that range and locked (legacy
  evidence, E-0054, E-0193).
- **TSK-8.** After a task is created or changed, the scheduler places or
  moves its chunks within 15 seconds (E-0088; see `planning-scheduler.md`).

### Chunking

- **TSK-10.** Each chunk lasts from `minChunkMinutes` to `maxChunkMinutes`,
  except as stated in TSK-13 (legacy evidence, E-0120, E-0193).
- **TSK-11.** Example of a valid result: a 6-hour task with chunks of 1 to
  2 hours can get chunks of 2 h, 1 h, 1.5 h and 1.5 h (legacy evidence,
  E-0120).
- **TSK-12.** The sum of the durations of future chunks equals
  `remainingMinutes` when space allows (legacy evidence, E-0120).
- **TSK-13.** When `remainingMinutes` is less than `minChunkMinutes`, the
  scheduler places one chunk of `remainingMinutes`. Proposed default; the
  evidence is silent.
- **TSK-14.** Two chunks of the same task are never back to back. The gap
  between them is at least the `chunkCooldown` value. With `once-per-day`, a
  task gets at most one chunk per calendar day (legacy evidence, E-0056,
  E-0193). Proposed default: with `none`, the gap is at least 15 minutes.
- **TSK-15.** Each chunk lies fully inside one interval of the task's hours
  set, after `startAfter`, and inside the scheduling window (legacy evidence,
  E-0172, E-0190).
- **TSK-16.** The chunk sizes and positions come from the placement rules in
  `planning-scheduler.md` (section "Placement of each demand", SCH-90).

### Due date and start

- **TSK-20.** The scheduler places all chunks so that they end at or before
  `dueAt` when space allows (legacy evidence, E-0193).
- **TSK-21.** When the remaining work does not fit before `dueAt`, the
  scheduler places the rest after `dueAt`, inside the scheduling window, and
  all chunks of the task become busy (legacy evidence, E-0120, E-0216).
- **TSK-22.** A task with an empty `dueAt` has no deadline. It sorts after
  all tasks of the same priority that have a due date. Proposed default; the
  glossary makes the due date optional, the legacy evidence always sets one.
- **TSK-23.** When the user changes `dueAt`, `startAfter`, `totalMinutes`,
  chunk sizes, `hoursSet` or `priority`, the scheduler re-places the unlocked
  future chunks (legacy evidence, E-0105).
- **TSK-24.** Snooze moves the whole task later: it sets `startAfter` to the
  chosen time and re-places all unlocked future chunks. Snoozed chunks are not
  locked (legacy evidence, E-0054, E-0132). Proposed default snooze choices:
  "1 hour", "3 hours", "tomorrow" (next day, start of the hours set), "next
  week" (next week's first day, start of the hours set), and a date-time
  picker.

### States and filters

- **TSK-30.** The task list has four filters: Open, Scheduled, Time used and
  Done. Open shows every task that is not done (legacy evidence, E-0190).
- **TSK-31.** Scheduled shows tasks with at least one future chunk. A task
  that is open but not scheduled is a task the scheduler cannot place; the
  list shows the reason from the unplaced report (legacy evidence, E-0190;
  reasons in `planning-scheduler.md`).
- **TSK-32.** A task enters `time-used` when its chunks used all of its time
  and no future chunk remains. It stays open until the user marks it done or
  adds time, unless the time-used rule in `planning-task-progress.md` acts
  (legacy evidence, E-0190, E-0048).
- **TSK-33.** Each filter is available on the tasks page and in the planner
  tasks panel (legacy evidence, E-0190).

### Actions on a task

- **TSK-40.** Mark done: the task becomes `done`. Tempoloom deletes the
  task's future chunks from the calendar and keeps past chunks. The user can
  mark a task done with no work logged (legacy evidence, E-0132, E-0190).
- **TSK-41.** Add time: the user enters a number of minutes. Tempoloom adds
  it to `totalMinutes` and places the new remaining work. Add time on a done
  task makes it open again (legacy evidence, E-0132, E-0190).
- **TSK-42.** Delete: Tempoloom removes the task and deletes all of its past
  and future chunks from the calendar. No logged work remains (legacy
  evidence, E-0132).
- **TSK-43.** Deleting chunks in Google Calendar never deletes the task. See
  `planning-calendar-edits.md` (legacy evidence, E-0191).
- **TSK-44.** Change priority, due date or start date: available on the
  tasks page, the planner and the task detail (legacy evidence, E-0132,
  E-0209).
- **TSK-45.** Bulk edit: on the tasks page the user selects several tasks and
  then sets the start date, sets the due date, sets the priority, marks them
  done, or deletes them (legacy evidence, E-0132).
- **TSK-46.** A task that comes from an integration takes its level from the
  source app; the user changes it there. Bulk priority edit skips those
  tasks. Exception: for Asana tasks the user may set the level in
  Tempoloom; Tempoloom does not send that level back to Asana (legacy
  evidence, E-0132, E-0209).

### Target calendar

- **TSK-50.** Each hours set has a setting "calendar for task chunks".
  Tempoloom writes a task's chunks to the calendar set on the task's hours
  set. Proposed default: the primary calendar (E-0172, E-0193).
- **TSK-51.** A user can point a hours set at a secondary calendar so that
  task chunks do not block the primary calendar for other people (legacy
  evidence, E-0054).

### Task list views

- **TSK-60.** The user can filter the task list by due date, start date,
  state and hours set (legacy evidence, E-0193).
- **TSK-61.** The user can sort the list by due date, by priority, or by
  scheduling order. Scheduling order is the order in which the scheduler
  processes tasks (legacy evidence, E-0193; order in `planning-scheduler.md`).

### Placement mode

- **TSK-70.** Proposed default: a user setting `taskPlacement` with values
  `chunks` (default, this spec) and `suggestions` (current reference
  behavior). With `suggestions`, Tempoloom creates no chunk events and shows
  tasks as described in `planning-next-up.md`.

## Outputs

- One managed event per chunk on the target calendar (TSK-50).
  - Title: the task title with the status marker from
    `events-title-emoji.md`.
  - Start and end: from the scheduler.
  - Free or busy: from `planning-defense.md`.
  - Description: the task notes plus a link to the task in the planner.
  - Visibility: the task's `visibility`.
  - Reminders: the calendar's default reminders
    (`planning-notifications.md`).
- Proposed default: each chunk event carries private extended properties
  that mark it as a Tempoloom task chunk and hold the task id.
- The task list shows title, priority, due date, state, scheduled minutes and
  remaining minutes.

## Edge cases

1. `totalMinutes` below 15: the form rejects the value (legacy evidence,
   E-0193).
2. `minChunkMinutes` above `maxChunkMinutes`: the form rejects the values.
3. `minChunkMinutes` is larger than every free interval in the hours set
   before the window end: the task stays `unscheduled` with reason
   "chunk too large" (legacy evidence, E-0190, E-0226).
4. `startAfter` is after the end of the scheduling window: the task stays
   `unscheduled` with reason "outside window" (legacy evidence, E-0190).
5. `dueAt` is in the past at creation: Proposed default: the scheduler places
   the work as early as possible and all chunks are busy.
6. `startAfter` is after `dueAt`: Proposed default: the form rejects it.
7. The user lowers `totalMinutes` below `consumedMinutes`: the task becomes
   `time-used` and its future chunks are deleted.
8. A task is marked done while a chunk is in progress: Proposed default: the
   chunk ends at the current time, rounded down to 5 minutes.
9. The task's hours set is deleted: the user must first pick another hours
   set (E-0172; see `planning-hours.md`).
10. A one-chunk task created on the planner (TSK-7) keeps its lock when its
    due date passes.

## Observed API shapes

Not yet observed.

## Open questions

1. Which placement mode should be the default: chunks (legacy, glossary) or
   suggestions (current reference)? Proposed default: chunks, with the
   `taskPlacement` setting (TSK-70).
2. The evidence gives no values for the default duration, split setting and
   chunk sizes. Proposed defaults are in the defaults table.
3. The legacy docs say the default start date comes from the chosen due
   date, but give no rule. Proposed default: `startAfter` = creation
   time + `startDelay`.
4. Is the due date required? Legacy always set one; the glossary says
   optional. Proposed default: optional (TSK-22).
5. The snooze choices are not listed in the evidence (TSK-24).
6. Upper limits for `totalMinutes` and for the due date distance are not in
   the evidence.
7. In the current reference version, is a start date still used, and how
   do task fields map to suggestions? The current-version page lists start
   date, due date, duration, priority and notes only.

## Acceptance tests

All tests use fixture F0 from `planning-scheduler.md`: a Google test account,
time zone Europe/Berlin, work hours Monday to Friday 09:00 to 17:00, empty
target week W, a busy blocker event so that nothing is placed before W,
scheduling window 3 weeks, `chunkCooldown` `none`. "Within
60 s" is the E2E tolerance for the 15-second target.

1. **Split task is placed in chunks.** Setup: F0. Action: create task
   "AT-T1 Report", 180 minutes, split on, chunks 60 to 120 minutes, P2,
   `startAfter` Monday W 00:00, `dueAt` Wednesday W 17:00. Expected within
   60 s: the primary calendar has 2 or 3 events with title containing
   "AT-T1 Report". Each lasts 60 to 120 minutes, the total is 180 minutes,
   each lies Monday to Wednesday between 09:00 and 17:00, no two touch, all
   end by Wednesday 17:00, and all are free. Reload: the planner shows the
   task under Scheduled with the same events; 2 minutes later the events
   have the same ids and times.
2. **Split off gives one event.** Setup: F0. Action: create task "AT-T2",
   90 minutes, split off. Expected: exactly one 90-minute event. Reload: same.
3. **Only title given.** Setup: F0 with defaults unchanged. Action: create
   task "AT-T3" with no other field. Expected: the task shows P2 and a due
   date 3 days after creation (plus or minus 1 minute), and its events lie
   in work hours. Reload: the same values.
4. **Start after the window.** Setup: F0. Action: create task "AT-T4",
   60 minutes, `startAfter` 5 weeks from now. Expected: no event for
   "AT-T4" in the next 5 weeks; the task is under Open and not under
   Scheduled, with reason "outside window". Reload: same.
5. **Mark done removes future chunks.** Setup: test 1 done. Action: mark
   "AT-T1 Report" done. Expected within 60 s: no future event for it remains;
   the task is under Done. Reload: same, and no event comes back after
   2 minutes.
6. **Add time reopens.** Setup: test 5 done. Action: add 60 minutes to
   "AT-T1 Report". Expected within 60 s: one new 60-minute event in work
   hours; the task is under Open and Scheduled. Reload: same.
7. **Delete task removes all chunks.** Setup: test 1 done. Action: delete
   the task. Expected within 60 s: no event for it in Google Calendar.
   Reload: the task is absent from all filters.
8. **Defaults affect only new tasks.** Setup: task "AT-T8a" with P2. Action:
   set `defaultPriority` to P3, then create "AT-T8b". Expected: "AT-T8a"
   is P2 and "AT-T8b" is P3. Reload: same.
9. **Target calendar per hours set.** Setup: F0 plus a secondary calendar
   "TL Personal" set as the task calendar of personal hours (every day 18:00
   to 21:00). Action: create task "AT-T9", 60 minutes, hours set personal.
   Expected: one event on "TL Personal" between 18:00 and 21:00, none on the
   primary calendar. Reload: same.
10. **Planner drag creates a locked task.** Setup: F0. Action: in the
    planner, drag Tuesday W 14:00 to 15:30 and create task "AT-T10".
    Expected: one event Tuesday 14:00 to 15:30, busy, with the lock marker.
    Reload: same; 2 minutes later it has not moved.
