# Changes to managed events in Google Calendar

Spec id: SPEC-PLANNING-09
Evidence: E-0045 (ev_b090cc25cd53), E-0054 (ev_782851ade647), E-0077 (ev_38c8b46b5b57), E-0081 (ev_dfcc5d3b7c8c), E-0088 (ev_4fa475edc582), E-0103 (ev_170e73774b60), E-0105 (ev_3a08a4245510), E-0108 (ev_42940293d611), E-0120 (ev_796e1e3fe2ef), E-0130 (ev_9c04afccf625), E-0132 (ev_a9d46d5e4718), E-0176 (ev_eba8295888d0), E-0190 (ev_39d8d5ed64d6), E-0191 (ev_91048df3c4da), E-0216 (ev_d5d172ebc91e)
Status of evidence: public docs only

## Summary

Users can move, resize, edit, delete and decline managed events directly in
Google Calendar. Tempoloom reads each change as an instruction: a move or
resize means "do it at this time" and locks the event; a delete means "not
now" (tasks, habits) or "skip this one" (focus time, flexible meetings).
Tempoloom keeps most edits, but reverts edits to task chunk details that
belong to the task. The planner gives the same results as Google Calendar.

## Concepts and inputs

- **Change source**: Google Calendar (any client) or the Tempoloom planner.
  Both follow the same rules (E-0132, E-0216).
- **User edit detection**: Proposed default: Tempoloom compares the Google
  event with the last version it wrote. Any difference that Tempoloom did not
  write is a user edit.
- **Exclusion**: a time interval in which the scheduler must not place a chunk
  of one given task again (legacy evidence, E-0216).
- **Reaction time**: Tempoloom applies the rules within 15 seconds of
  receiving the change (E-0088).

## Behavior

### Moves and resizes (all kinds)

- **CED-1.** A managed event that the user moves to another time becomes
  locked at the new time (E-0103, E-0108, E-0077, E-0081, E-0176).
- **CED-2.** A managed event whose duration the user changes becomes locked
  (legacy evidence, E-0132, E-0216).

### Moves and resizes of task chunks (legacy evidence)

- **CED-10.** When the user moves a chunk, the old interval becomes an
  exclusion for that task. The scheduler never places a chunk of the same
  task there again (legacy evidence, E-0216).
- **CED-11.** When the user moves the task's first chunk, the chunk's new
  start becomes the task's `startAfter`. Moving it earlier sets an earlier
  start; moving it later stops the scheduler from placing any chunk of the
  task before that time (legacy evidence, E-0216).
- **CED-12.** When the user moves a chunk so that it ends after `dueAt`, all
  chunks of the task become busy (legacy evidence, E-0216).
- **CED-13.** When the user shortens a chunk, the cut minutes return to the
  task's remaining work and the scheduler places them later (legacy evidence,
  E-0216, E-0132). This applies to past chunks too (PRG-2).
- **CED-14.** When the user lengthens a chunk, the added minutes come off the
  task's remaining work. Proposed default; the evidence is silent.

### Deletes

- **CED-20.** Deleting a future chunk, or a chunk in progress, means "later".
  The task keeps its total, and the scheduler places the minutes again,
  starting on the next day that has hours available (legacy evidence, E-0216,
  E-0132, E-0120).
- **CED-21.** Deleting a past chunk means "this work did not happen". Its
  minutes return to the task's remaining work and the scheduler places them
  in the future (legacy evidence, E-0216, E-0132).
- **CED-22.** If the task was in `time-used` or `done`, deleting a past chunk
  reopens it (legacy evidence, E-0216, E-0191).
- **CED-23.** Deleting chunks never deletes the task. Only the delete action
  in Tempoloom or in an integration deletes it (legacy evidence, E-0191).
- **CED-24.** Deleting a habit event means "find another time": the
  scheduler places the occurrence again within the habit's rules. To cancel
  one occurrence, the user uses the Skip action (E-0081). Evidence conflict:
  legacy pages say delete skips the habit for that day (E-0103, E-0130).
- **CED-25.** Deleting a focus time event skips it. The scheduler does not
  put focus time back into that time range (E-0077, E-0103).
- **CED-26.** Deleting a flexible meeting event skips that occurrence
  (legacy evidence, E-0103). Flexible meeting spec owns details.
- **CED-27.** A delete removes the lock of that event (legacy evidence,
  E-0045).

### Declines

- **CED-30.** When the user or an attendee declines a flexible meeting event,
  Tempoloom treats it as a reschedule: it unlocks the occurrence and finds the
  next best common time (legacy evidence, E-0103, E-0045).

### Other detail edits

- **CED-40.** For habit, flexible meeting, focus time and buffer events,
  Tempoloom keeps the user's edits of title, color, time, duration and
  attendees, and locks the event so that it does not overwrite them (legacy
  evidence, E-0103, E-0108).
- **CED-41.** For task chunks, Tempoloom reverts edits made in Google Calendar
  to these fields: title, description, color, conferencing data and
  location, visibility, and free/busy. The user changes title, description,
  color and visibility on the task in Tempoloom (legacy evidence, E-0216).
- **CED-42.** A reverted edit does not lock the chunk. Proposed default.

### Planner actions with the same effect

- **CED-50.** Drag and drop or resize in the planner equals CED-1, CED-2 and
  CED-10 to CED-14 (E-0132, E-0216).
- **CED-51.** The Reschedule action on a past chunk equals CED-21 (legacy
  evidence, E-0132).
- **CED-52.** The Reschedule action on a habit event offers choices for how
  far out to move it (legacy evidence, E-0105, E-0130).

## Outputs

- The edited event: locked (busy, lock marker) or reverted.
- New or moved chunk and occurrence events, per the rules.
- Task state changes (`time-used` or `done` to `scheduled`).

## Edge cases

1. The user moves a chunk onto a time occupied by another managed event: the
   moved chunk is locked there; the other event moves if it is unlocked and
   of lower or equal priority. Proposed default; locked events win.
2. The user moves a chunk into the past: Proposed default: Tempoloom treats
   it as logged work at that time and the chunk is done.
3. The user deletes a chunk of a task in `done`: the task reopens (CED-22).
   The task list shows it under Open again.
4. The user deletes a whole recurring series of habit events in Google
   Calendar: Proposed default: Tempoloom recreates the events and shows a
   notice that habits are removed from Tempoloom, not from the calendar.
5. The user edits a chunk title and moves it in one change: the time move is
   kept and locked; the title is reverted.
6. Two edits arrive within 15 seconds: Tempoloom applies them in the order of
   the Google `updated` time. Proposed default.

## Observed API shapes

Not yet observed.

## Open questions

1. Habit delete: reschedule (current page) or skip for the day (legacy
   pages)? Proposed default: reschedule, with a separate Skip action (CED-24).
2. Does deleting a past chunk of a task marked done really reopen it, or only
   for `time-used` tasks? E-0191 suggests both.
3. Does the current reference still revert task chunk edits? Tasks no longer
   make events there.
4. Does lengthening a chunk reduce the remaining work (CED-14)?

## Acceptance tests

Fixture F0 from `planning-scheduler.md`. "In Google Calendar" means the test
changes the event through the Google Calendar API as the test user.

1. **Moving the first chunk later.** Setup: task "AT-E1", 120 minutes, chunks
   of 60, `startAfter` Monday W, placed Monday. Action: in Google Calendar,
   move the first chunk to Wednesday W 15:00. Expected within 60 s: that
   chunk is locked at Wednesday 15:00 to 16:00; the other chunk starts after
   16:00 Wednesday or later; no chunk is on Monday or Tuesday. Reload: same.
2. **Moving the first chunk earlier.** Setup: task "AT-E2", 60 minutes,
   `startAfter` Tuesday W, placed Tuesday 09:00. Action: move it to Monday
   W 14:00. Expected: the task's `startAfter` shows Monday 14:00; the event is
   locked. Reload: same.
3. **Moving past the due date.** Setup: task "AT-E3", 120 minutes, chunks of
   60, due Wednesday W 17:00, both chunks free. Action: move one chunk to
   Thursday W 10:00. Expected within 60 s: both chunks are busy. Reload: same.
4. **Shortening a chunk.** Setup: task "AT-E4", 120 minutes, split off, one
   event Monday 09:00 to 11:00. Action: change its end to 10:00. Expected
   within 60 s: it is locked 09:00 to 10:00; a new 60-minute "AT-E4" event
   exists later. Reload: same.
5. **Deleting a future chunk.** Setup: task "AT-E5", 60 minutes, placed
   Monday W 09:00. Action: delete the event. Expected within 60 s: a new
   "AT-E5" event exists on Tuesday W or later, not on Monday. The task still
   shows 60 minutes total. Reload: same.
6. **Deleting a past chunk revives the task.** Setup: task "AT-E6" in
   `time-used` with one past chunk. Action: delete the past chunk. Expected
   within 60 s: the task is `scheduled` with a new future chunk of the same
   length. Reload: same.
7. **Task chunk title edit is reverted.** Setup: test 5 state. Action: rename
   the "AT-E5" event to "Something else". Expected within 60 s: the title is
   back to "AT-E5" with its marker; the event is not locked. Reload: same.
8. **Habit title edit is kept.** Setup: habit "AT-E8". Action: rename one
   event to "AT-E8 park". Expected after 60 s: the title stays, the event is
   locked. Reload: same.
9. **Focus time delete skips.** Setup: focus time placed Thursday W 13:00 to
   15:00. Action: delete it. Expected after 60 s: no focus event overlaps
   Thursday 13:00 to 15:00. Reload: same.
