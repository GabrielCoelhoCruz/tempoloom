# Locks

Spec id: SPEC-PLANNING-08
Evidence: E-0045 (ev_b090cc25cd53), E-0054 (ev_782851ade647), E-0068 (ev_6d15ce331135), E-0077 (ev_38c8b46b5b57), E-0081 (ev_dfcc5d3b7c8c), E-0085 (ev_afb3719f0f6f), E-0088 (ev_4fa475edc582), E-0089 (ev_e7262cc4064c), E-0103 (ev_170e73774b60), E-0105 (ev_3a08a4245510), E-0108 (ev_42940293d611), E-0120 (ev_796e1e3fe2ef), E-0130 (ev_9c04afccf625), E-0132 (ev_a9d46d5e4718), E-0176 (ev_eba8295888d0), E-0193 (ev_68ba14aa780b), E-0209 (ev_28b6d44e4b68), E-0216 (ev_d5d172ebc91e)
Status of evidence: public docs only

## Summary

A lock is a user decision that one managed event must stay where it is. A
locked event is busy and the scheduler never moves it, even when another
event overlaps it. Events lock when the user locks them, when the user moves
or edits them, and on a daily or weekly auto-lock schedule.

## Concepts and inputs

- `locked`: boolean on each managed event (one chunk, one habit occurrence,
  one flexible meeting occurrence, one focus time event, one buffer event).
- `lockSource`: `manual`, `user-edit`, `created-in-planner`, `auto-lock`.
  Proposed default; used for display and tests.
- Auto-lock setting per item kind (legacy evidence, E-0045, E-0068):

| Kind | Values | Default |
|---|---|---|
| Flexible meetings | `off`, `day`, `week` | `day` |
| Habits | `off`, `day`, `week` | `off` |
| Tasks | `off`, `day`, `week` | `off` |
| Focus time | `off`, `day`, `week` | `off` |

## Behavior

### Effect of a lock

- **LCK-1.** A locked event is busy (E-0089, E-0108, E-0045).
- **LCK-2.** The scheduler never moves, resizes or deletes a locked event,
  even when another event overlaps it (E-0108, E-0045, E-0120).
- **LCK-3.** Higher-priority items and next-up tasks place around locked
  events (legacy evidence, E-0209).
- **LCK-4.** A locked event's title carries the lock marker
  (`events-title-emoji.md`) (E-0085, E-0105).
- **LCK-5.** Locked time still counts toward its item. A locked chunk counts
  toward the task's placed minutes, and a locked habit event fulfils its
  occurrence. Proposed default; implied by E-0108.
- **LCK-6.** When an external event overlaps a locked event, Tempoloom keeps
  both and reports the overlap as an issue. Proposed default.

### Manual lock and unlock

- **LCK-10.** The user locks or unlocks a task chunk, habit event or flexible
  meeting event from the planner and from the Google Calendar add-on (legacy
  evidence, E-0108, E-0132). Task chunks can also be locked from the chat-app
  integration (legacy evidence, E-0132).
- **LCK-11.** In the planner, the lock and unlock actions are in the event's
  right-click menu and on a lock icon (E-0081, E-0176, E-0132).
- **LCK-12.** Proposed default: focus time and buffer events have the same
  lock and unlock actions.

### Automatic locks from user actions

- **LCK-20.** When the user drags a managed event to a new time (planner or
  Google Calendar), the event becomes locked (E-0108, E-0045, E-0077, E-0081, E-0176).
- **LCK-21.** Changing the duration of a managed event, in the planner or in
  Google Calendar, locks it (legacy evidence, E-0045, E-0132).
- **LCK-22.** Changing other details of a managed event in Google Calendar
  locks it, except for task chunks, where those changes are reverted (legacy
  evidence, E-0103, E-0108, E-0216; see `planning-calendar-edits.md`).
- **LCK-23.** An item created by clicking or dragging on a future time in the
  planner is locked at that time (legacy evidence, E-0054, E-0193).
- **LCK-24.** Snooze does not lock (legacy evidence, E-0054).

### Auto-lock schedule (legacy evidence)

- **LCK-30.** With `day`, Tempoloom locks every event of that kind that
  starts on the current day, once per day. With `week`, it locks every event
  of that kind that starts in the current week, once per week on the first
  day of the week (legacy evidence, E-0045, E-0108).
- **LCK-31.** The auto-lock job runs between 01:00 and 02:00 in the user's
  time zone (legacy evidence, E-0045). Evidence conflict: E-0108 says 04:00
  for flexible meetings. Proposed default: 01:00.
- **LCK-32.** An event placed after the job ran, in a day or week that is
  already locked, is not locked. The user locks it by hand, or turns the
  setting off and on again, which runs the lock job for the current day or
  week at once (legacy evidence, E-0045).
- **LCK-33.** The first day of the week comes from the user's Google
  Calendar setting (`settings-profile.md`).
- **LCK-34.** Current reference: a flexible meeting has an auto-lock rule
  that stops it from moving as its start gets close (E-0176). Flexible
  meeting spec owns its lead time.

### Unlock triggers

- **LCK-40.** An event unlocks when (legacy evidence, E-0045):
  - the user picks Unlock;
  - the user deletes the event or uses the Reschedule action (the event is
    then rescheduled or skipped, see `planning-calendar-edits.md`);
  - the user or an attendee declines it (flexible meetings only).
- **LCK-41.** After an unlock, the next scheduler run may move the item
  (E-0081, E-0176).

## Outputs

- Google event: busy, title with the lock marker.
- Planner: lock icon on the event; menu shows Unlock.
- Unplaced and issue report: overlaps on locked events (LCK-6).

## Edge cases

1. A locked chunk passes its task's due date: it stays; all chunks of the
   task become busy (`planning-defense.md` DEF-12).
2. The user changes the item's rules (for example, the task's hours set):
   locked events stay; only unlocked events move. Proposed default.
3. The user turns auto-lock from `week` to `off`: events already locked stay
   locked. Proposed default.
4. A locked event lies outside the item's hours after an hours change: it
   stays. Proposed default.
5. A locked event is in the past: no effect; past events never move anyway.

## Observed API shapes

Not yet observed.

## Open questions

1. Does `day` lock the current day's events or the next day's events? The
   legacy page says "the day of"; the current meeting page gives an example
   of locking "the day before". Proposed default: current day (LCK-30).
2. Which time does the auto-lock job run: 01:00 or 04:00? (LCK-31)
3. Does the current reference keep per-kind auto-lock for habits, tasks and
   focus time?
4. Does Start lock the moved chunk? Proposed default: yes
   (`planning-task-progress.md` PRG-10).

## Acceptance tests

Fixture F0 from `planning-scheduler.md`.

1. **Manual lock holds the event.** Setup: task "AT-L1", 60 minutes, split
   off, `startAfter` Monday W 10:00, placed at Monday W 10:00. Action: lock it; then create an external
   busy event Monday W 09:30 to 11:00 that the user accepts. Expected after
   60 s: "AT-L1" is still Monday 10:00 to 11:00, busy, with the lock marker;
   the issue list shows the overlap. Reload: same.
2. **Unlock lets it move.** Setup: test 1. Action: unlock "AT-L1". Expected
   within 60 s: "AT-L1" no longer overlaps the external event. Reload: same.
3. **Drag in Google locks.** Setup: habit "AT-L3", 30 minutes, window 12:00
   to 14:00. Action: in Google Calendar, move Tuesday's event to 13:30.
   Expected within 60 s: the event stays at 13:30, busy, lock marker. Action:
   accept an external meeting Tuesday 13:00 to 14:00. Expected after 60 s:
   the habit event has not moved. Reload: same.
4. **Weekly auto-lock.** Setup: habit auto-lock `week`; habit "AT-L4" daily.
   Action: advance the server test clock to the first day of the week 01:30.
   Expected within 60 s: all "AT-L4" events of that week are busy and locked;
   events in later weeks are not locked. Reload: same.
5. **New event after the lock run.** Setup: test 4. Action: create habit
   "AT-L5" for the same week. Expected: its events are not locked. Action:
   turn habit auto-lock off and on. Expected within 60 s: "AT-L5" events of
   the current week are locked.
