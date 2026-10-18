# Task progress and time spent

Spec id: SPEC-PLANNING-02
Evidence: E-0048 (ev_55efef88be5e), E-0054 (ev_782851ade647), E-0068 (ev_6d15ce331135), E-0098 (ev_cefc23278fd5), E-0120 (ev_796e1e3fe2ef), E-0130 (ev_9c04afccf625), E-0132 (ev_a9d46d5e4718), E-0148 (ev_e7b99cd896e0), E-0190 (ev_39d8d5ed64d6), E-0192 (ev_d71469f89e0b), E-0216 (ev_d5d172ebc91e)
Status of evidence: public docs only

## Summary

Tempoloom tracks how much of each task is done. By default it counts a chunk
as worked when the chunk's time passes. The user can instead start chunks by
hand, start, stop or restart work, log work done outside chunks, and choose
what happens to a task whose time is used up. The same start setting applies
to habit events.

## Concepts and inputs

| Setting | Values | Default |
|---|---|---|
| `startMode` | `auto` (count a chunk when its time passes), `manual` (count only after Start) | `auto` (legacy evidence, E-0048, E-0068) |
| `timeUsedAction` | `nothing`, `re-add`, `mark-done` | `nothing` (legacy evidence, E-0048) |
| `timeUsedWaitDays` | integer days | Proposed default: 3; range 1 to 30 (Proposed default) |

Log work input: a task, a number of minutes, and the start time of the work.

Rounding: Tempoloom rounds "now" down to a multiple of 5 minutes for Start and
Restart (legacy evidence, E-0132).

## Behavior

### Counting work

- **PRG-1.** With `startMode` `auto`, when a chunk ends, Tempoloom adds its
  duration to `consumedMinutes`. Google Calendar is the record of what
  happened: past chunks count as done work (legacy evidence, E-0120, E-0048).
- **PRG-2.** A change to a past chunk changes the future plan. Shortening a
  past chunk returns the cut minutes to `remainingMinutes`, and the scheduler
  places them in the future (legacy evidence, E-0120, E-0132).
- **PRG-3.** With `startMode` `manual`, a chunk counts as not started until
  the user presses Start. If the chunk ends and the user did not press Start,
  the scheduler moves it to the best free time later the same day (legacy
  evidence, E-0048). Proposed default: if no time is free later that day, it
  goes to the next free time in the hours set.
- **PRG-4.** With `startMode` `manual`, pressing Start during a chunk moves
  the chunk start to the current time. Example: a chunk from 13:00 to 14:00,
  Start at 13:30, new start 13:30 (legacy evidence, E-0048). Proposed
  default: the chunk keeps its duration and ends at 14:30 if that time is
  free; else it ends at the first conflict.
- **PRG-5.** `startMode` applies to task chunks and habit events alike
  (legacy evidence, E-0048, E-0068).

### Start, stop, restart

- **PRG-10.** Start on a task moves the task's first upcoming chunk so that it
  begins now, rounded down to 5 minutes. Example: first chunk at 14:00, Start
  at 09:03, chunk moves to 09:00 (legacy evidence, E-0132). Proposed default:
  the chunk keeps its duration and gets the lock.
- **PRG-11.** Stop during a chunk ends that chunk at the current time. The
  unused part of the chunk returns to `remainingMinutes` and the scheduler
  places it later. Example: chunk 09:00 to 11:00, Stop at 09:30, the chunk
  becomes 09:00 to 09:30 (legacy evidence, E-0132). Proposed default: round
  the stop time to the nearest minute.
- **PRG-12.** Restart moves the start of the current chunk to now, rounded
  down to 5 minutes. Example: started at 09:00, interrupted until 09:15,
  Restart at 09:15 gives a chunk that starts at 09:15 (legacy evidence,
  E-0132). Proposed default: the chunk keeps its duration.
- **PRG-13.** Start, Stop and Restart are available in the planner, the
  Google Calendar add-on, the chat-app integration and the launcher
  integration (legacy evidence, E-0132).

### Logging work

- **PRG-20.** Log work takes minutes and a start time, and subtracts the
  minutes from `remainingMinutes`. Use it for work done outside the chunks
  (legacy evidence, E-0132).
- **PRG-21.** The user can log work by clicking or dragging on a past time
  in the planner, then choosing a task or a habit (legacy evidence, E-0054,
  E-0130, E-0132).
- **PRG-22.** Proposed default: logged work creates a past managed event at
  the given time on the task's target calendar, so the calendar keeps the
  record (PRG-1). The current reference lets the user choose the calendar for
  the logged work (E-0192).

### Timer (current reference)

- **PRG-30.** A "Start task" button starts a timer for the task (E-0192,
  E-0098).
- **PRG-31.** When the user stops the timer, a dialog lets the user edit the
  recorded minutes, keep the timer going, discard the record, complete the
  task, and pick the calendar that gets the logged event (E-0192).
- **PRG-32.** Tempoloom shows the calendar change that the timer creates as a
  preview, and writes it only after the user applies it (E-0192).

### Tasks whose time is used

- **PRG-40.** `timeUsedAction` `nothing`: a `time-used` task stays open until
  the user adds time or marks it done (legacy evidence, E-0048, E-0190).
- **PRG-41.** `timeUsedAction` `re-add`: after `timeUsedWaitDays` days in
  `time-used`, Tempoloom adds the task's original `totalMinutes` again and the
  scheduler places it. The task stays open until the user marks it done
  (legacy evidence, E-0048). Example: a 3-hour task gets a new 3 hours.
- **PRG-42.** `timeUsedAction` `mark-done`: after `timeUsedWaitDays` days in
  `time-used`, Tempoloom marks the task done (legacy evidence, E-0048).
- **PRG-43.** A change to `timeUsedAction` applies to tasks already in
  `time-used` and to later ones (legacy evidence, E-0048).
- **PRG-44.** With `startMode` `manual`, the `timeUsedAction` setting is
  hidden and has no effect (legacy evidence, E-0048).

## Outputs

- Chunk events change start or end time (Start, Stop, Restart, manual mode
  move).
- New chunk events appear for returned or re-added minutes.
- Past chunk titles get the progress marker from `events-title-emoji.md`.
- The task list shows `consumedMinutes` and `remainingMinutes`.

## Edge cases

1. Start on a task with no future chunk: Proposed default: Tempoloom creates
   one chunk from now, of length `min(remainingMinutes, maxChunkMinutes)`.
2. Start when the first chunk is already in progress: no change.
3. Start when the time from now to the chunk length overlaps a P1 external
   event: Proposed default: the chunk ends at the start of that event.
4. Stop less than 5 minutes after the chunk start: Proposed default:
   Tempoloom deletes the chunk and returns all its minutes.
5. Log work larger than `remainingMinutes`: `remainingMinutes` becomes 0 and
   the task enters `time-used`.
6. Log work in the future: the form rejects it.
7. `re-add` on a task whose due date passed: the new chunks are busy
   (`planning-defense.md`).

## Observed API shapes

Not yet observed.

## Open questions

1. Does Start keep the chunk length or cut it? Proposed default: keep (PRG-10).
2. Does logged work create a calendar event in the legacy version? Proposed
   default: yes (PRG-22).
3. The range and default of the wait days are not in the evidence.
4. In the current reference, does time spent with the timer change the plan
   of any remaining chunks? Tasks there have no chunks.

## Acceptance tests

Fixture F0 from `planning-scheduler.md`, plus a custom hours set "AT-Always"
(every day 00:00 to 24:00) so that tests can work near the current time.
Tests that wait for days may use the server test clock (Proposed default:
a test-only clock offset; Google events stay real).

1. **Start moves the first chunk.** Setup: task "AT-P1", 60 minutes, split
   off, hours AT-Always, `startAfter` tomorrow 10:00. Action: press Start at
   time T. Expected within 60 s: the event starts at T rounded down to
   5 minutes and lasts 60 minutes. Reload: same.
2. **Stop ends the chunk and returns minutes.** Setup: test 1, 10 minutes
   later. Action: press Stop at T2. Expected within 60 s: the event ends at T2
   (to the minute); a new event for "AT-P1" holds the remaining minutes later.
   Reload: the task shows the consumed minutes.
3. **Log work reduces remaining.** Setup: task "AT-P3", 120 minutes, chunks 60
   to 120, placed in W. Action: log 60 minutes yesterday at 15:00. Expected:
   future chunks of "AT-P3" total 60 minutes; a past event yesterday 15:00 to
   16:00 exists (Proposed default PRG-22). Reload: remaining 60.
4. **Auto mode counts a passed chunk.** Setup: `startMode` auto; task
   "AT-P4", 15 minutes, hours AT-Always, `startAfter` now. Action: wait until
   the chunk ends plus 60 s. Expected: the task is in `time-used`; the event
   stays at its time with the progress marker. Reload: same.
5. **Manual mode moves an unstarted chunk.** Setup: `startMode` manual; task
   "AT-P5", 15 minutes, hours AT-Always, `startAfter` now. Action: do not
   press Start; wait until the chunk ends plus 60 s. Expected: the event now
   starts later the same day; the task is still `scheduled`. Reload: same.
6. **Mark-done rule.** Setup: `timeUsedAction` `mark-done`, wait 1 day; a
   task in `time-used`. Action: advance 1 day plus 1 hour. Expected: the task
   is under Done; no event changed. Reload: same.
7. **Re-add rule.** Setup: `timeUsedAction` `re-add`, wait 1 day; task
   "AT-P7" of 60 minutes in `time-used`. Action: advance 1 day plus 1 hour.
   Expected: one or more new events for "AT-P7" totalling 60 minutes in the
   future. Reload: the task is open and scheduled.
