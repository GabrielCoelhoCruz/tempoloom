# Pausing scheduling

Spec id: SPEC-PLANNING-13
Evidence: E-0043 (ev_d7b30359b03e), E-0110 (ev_8a78ca5cc5a3), E-0148 (ev_e7b99cd896e0)
Status of evidence: public docs only

## Summary

A user can take a break from Tempoloom without deleting the account. Pausing
removes managed events from the calendar and stops new ones, but keeps all
settings and items so that the user can turn them on again later. The user
can pause one automation or use a pause action for the whole account.

## Concepts and inputs

- `enabled`: boolean on each habit, buffer automation, focus time automation,
  flexible meeting, calendar mirroring policy and task integration.
- Account action "Pause scheduling" on the account management page (legacy
  evidence, E-0110).

## Behavior

### Pause one item

- **PAU-1.** The user can turn off any automation (habit, buffer, focus time,
  flexible meeting) from the automation list. Turning it off stops its
  scheduling and keeps its settings (E-0043).
- **PAU-2.** When an item is turned off, Tempoloom deletes its future managed
  events from the calendar. Past events stay. When it is turned on again, the
  scheduler places its events again (legacy evidence, E-0110).
- **PAU-3.** Turning off a calendar mirroring policy deletes its copies and
  stops mirroring (legacy evidence, E-0110). Mirroring spec owns details.
- **PAU-4.** Turning off a task integration stops syncing new tasks from it
  (legacy evidence, E-0110). Integration spec owns details.

### Pause the account (legacy evidence)

- **PAU-10.** The account page has a "Pause scheduling" action. After a
  confirmation step, it turns off all habits and all buffers (legacy
  evidence, E-0110).
- **PAU-11.** "Pause scheduling" does not touch tasks, calendar mirroring,
  focus time or flexible meetings. The confirmation text tells the user to
  handle these by hand (legacy evidence, E-0110).
- **PAU-12.** To return, the user turns the items on again one by one (legacy
  evidence, E-0110).

### Manual reset steps shown to the user (legacy evidence, E-0110)

The help text lists these steps; Tempoloom shows them on the account page:

1. Turn off each calendar mirroring policy.
2. Turn off each habit.
3. Delete open tasks or mark them done; their future chunks go away.
4. Turn off task integrations.
5. Turn off flexible meetings you own; decline those you attend.
6. Turn off recovery and travel buffers.
7. Turn off focus time.

## Outputs

- Future managed events of turned-off items are deleted from Google Calendar
  within 60 seconds. Proposed default for the time limit.
- The automation list shows turned-off items as off.

## Edge cases

1. A locked future event of a turned-off habit: Proposed default: Tempoloom
   deletes it too, because the item is off.
2. A flexible meeting where the user is only an attendee: turning it off is
   not possible; the user declines it (E-0110).
3. The user pauses and then the scheduling window moves: no new events are
   placed for off items.
4. Turning an item on again after a long pause: the scheduler places events
   only from now on, never in the past.

## Observed API shapes

Not yet observed.

## Open questions

1. Does the current reference have an account-wide pause? Only the per-
   automation switch is in the current pages. Proposed default: keep the
   account action and make it turn off all automations (habits, buffers,
   focus time, flexible meetings), not only habits and buffers.
2. Does the reference delete locked future events of a turned-off item?
3. Should "Pause scheduling" have a resume action that turns the same items
   back on? Proposed default: yes, it remembers which items it turned off.

## Acceptance tests

Fixture F0 from `planning-scheduler.md`.

1. **Turn off a habit.** Setup: habit "AT-PA1", 30 minutes daily, events in
   W. Action: turn it off. Expected within 60 s: no future "AT-PA1" event
   exists; past ones stay. Reload: the habit shows off with its settings.
2. **Turn it on again.** Setup: test 1. Action: turn it on. Expected within
   60 s: future "AT-PA1" events exist again. Reload: same.
3. **Account pause.** Setup: habit "AT-PA3", a recovery buffer automation, a
   task "AT-PA3 task" and focus time. Action: run "Pause scheduling" and
   confirm. Expected within 60 s: no future habit or buffer events; task
   chunks and focus time events remain. Reload: habit and buffer show off.
