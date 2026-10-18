# Free/busy defense

Spec id: SPEC-PLANNING-07
Evidence: E-0043 (ev_d7b30359b03e), E-0054 (ev_782851ade647), E-0081 (ev_dfcc5d3b7c8c), E-0085 (ev_afb3719f0f6f), E-0088 (ev_4fa475edc582), E-0089 (ev_e7262cc4064c), E-0092 (ev_e2b256d2eb91), E-0108 (ev_42940293d611), E-0120 (ev_796e1e3fe2ef), E-0139 (ev_28aa8ef849b8), E-0196 (ev_96353e46340f), E-0216 (ev_d5d172ebc91e)
Status of evidence: public docs only

## Summary

Defense is the free or busy status of a managed event in Google Calendar. A
free event is visible to the user but shows as open time to other people. A
busy event blocks the time for others. Tempoloom places flexible events as
free while it has other options, and makes them busy when time gets short or
the start gets near. Locked events are always busy.

## Concepts and inputs

- **Free**: Google event transparency "transparent". Other people see open
  time (E-0089).
- **Busy**: Google event transparency "opaque". Other people see blocked time
  (E-0089).
- **Defense mode** of a habit (E-0196, E-0081):

| Mode | Status | Trade-off when time is short |
|---|---|---|
| `always-free` | always free | keep the ideal time, accept a shorter duration |
| `adaptive` (default) | Tempoloom chooses free or busy | Tempoloom chooses |
| `always-busy` | always busy | keep the full duration, accept a time further from ideal |

- **Initial status** of an automation's events (current reference): a "busy or
  free" setting in the automation's event settings (E-0043, E-0081).

## Behavior

### General

- **DEF-1.** Tempoloom first places flexible managed events as free, and
  makes them busy when it has few other options or the start is near
  (E-0088, E-0089).
- **DEF-2.** A locked managed event is always busy (E-0089, E-0108; see
  `planning-locks.md`).
- **DEF-3.** The status of a managed event never changes which item may take
  its time. The scheduler moves a busy chunk as easily as a free one (legacy
  evidence, E-0120; `planning-priorities.md` PRI-14).
- **DEF-4.** The scheduler computes the status of every unlocked future
  managed event on each run, and writes it to Google Calendar only when it
  changes. Proposed default.
- **DEF-5.** The title of a managed event carries a status marker: free,
  busy or locked (E-0089, E-0085). Format: `events-title-emoji.md`.
- **DEF-6.** The planner draws free events with a dashed outline and busy
  events with a solid fill (E-0089, E-0139).
- **DEF-7.** For task chunks, a free or busy change made in Google Calendar
  is reverted (legacy evidence, E-0216).

### Task chunks (legacy evidence)

- **DEF-10.** A chunk is free when the task could still get all its remaining
  work placed before `dueAt` in another way. A chunk is busy when no other
  way exists (legacy evidence, E-0120).
- **DEF-11.** Testable form (Proposed default): chunk C of task T is busy if
  and only if the scheduler, with C's interval made unavailable to T and all
  higher-or-equal items kept in place, cannot place T's remaining work so that
  it ends at or before `dueAt`. Otherwise C is free.
- **DEF-12.** When any chunk of a task ends after `dueAt`, all chunks of that
  task are busy (legacy evidence, E-0120, E-0216).
- **DEF-13.** A task with no `dueAt` has free chunks unless locked. Proposed
  default.

### Habits

- **DEF-20.** Habit status depends on the time left in the habit's window and
  the time left before the event starts (legacy evidence, E-0196; E-0081).
- **DEF-21.** `always-free`: the event is always free. `always-busy`: the
  event is always busy (legacy evidence, E-0196).
- **DEF-22.** `adaptive`: the event starts free and becomes busy when it is
  one of the last real chances for the habit in its window, or when the day
  fills up (E-0081, E-0196).
- **DEF-23.** Testable form of `adaptive` (Proposed default, borrowed from the
  flexible meeting rule DEF-30): the event is busy when its start is less than
  12 hours away, or when no other free slot of at least the habit's minimum
  duration exists in the habit's window on that day. Otherwise it is free.

### Flexible meetings (legacy evidence)

- **DEF-30.** A flexible meeting event starts free. It becomes busy when its
  start is less than 12 hours away, or when only one possible slot for it
  remains on that day (legacy evidence, E-0092).
- **DEF-31.** The flexible meeting spec owns the slot search; this rule only
  sets the status.

### Focus time, buffers, booking-link meetings

- **DEF-40.** Focus time does not switch between free and busy. Once placed,
  its events are protected (E-0089). Its status is the automation's "busy or
  free" setting. Proposed default: busy.
- **DEF-41.** Buffer events use their automation's "busy or free" setting
  (E-0043). Proposed default: busy. Buffer spec owns buffer rules.
- **DEF-42.** A meeting booked through a booking link is busy (E-0088).

### Secondary calendars

- **DEF-50.** A user who wants task chunks never to block other people can
  send them to a secondary calendar (`planning-hours.md` HRS-12). The
  scheduler still treats them as placed time (legacy evidence, E-0054).

## Outputs

- Google event transparency per DEF rules.
- Title status marker (DEF-5).
- Planner outline style (DEF-6).

## Edge cases

1. A habit in `always-free` mode is locked: it is busy (DEF-2 wins).
2. A chunk whose task has its due date moved later: it may turn free again on
   the next run (DEF-4).
3. A user marks a habit event busy in Google Calendar: Proposed default:
   Tempoloom treats this as an edit, locks the event (see
   `planning-calendar-edits.md`), and the event stays busy.
4. A flexible meeting with zero possible slots left that day (already in the
   only slot): busy (DEF-30).
5. A buffer whose automation is set to free gets locked: it becomes busy
   (DEF-2 wins).
6. A task chunk changed to busy in Google Calendar: Tempoloom reverts it and
   does not lock it (DEF-7).

## Observed API shapes

Not yet observed.

## Open questions

1. The exact thresholds of habit `adaptive` mode are not in the evidence.
   Proposed default in DEF-23.
2. Does the current reference still flip task-like events? Tasks no longer
   make events in the current version.
3. Is the flexible meeting rule (12 hours, one slot left) still current? It
   comes from a legacy page; the current page speaks of "minimum lead time"
   instead.
4. What status do buffer and focus events use by default in the current
   reference?

## Acceptance tests

Fixture F0 from `planning-scheduler.md`.

1. **Roomy task is free.** Setup: F0. Action: create task "AT-D1",
   120 minutes, split off, due Friday W 17:00, `startAfter` Monday W.
   Expected within 60 s: the event is transparent (free) and its title has
   the free marker. Reload: same.
2. **Tight task is busy.** Setup: F0. Action: create task "AT-D2",
   420 minutes, chunks 60 to 240, `startAfter` Monday W 09:00, due Monday W
   17:00. Expected within 60 s: every "AT-D2" event is opaque (busy) with the
   busy marker. Reload: same.
3. **Due date moved later frees the chunks.** Setup: test 2. Action: set the
   due date to Friday W 17:00. Expected within 60 s: all future "AT-D2" events
   are free. Reload: same.
4. **Lock makes busy.** Setup: test 1. Action: lock the "AT-D1" event in the
   planner. Expected within 60 s: it is busy with the lock marker. Reload:
   same.
5. **Habit always-busy.** Setup: habit "AT-D5", 30 minutes daily, defense
   `always-busy`. Expected: all its events are busy. Action: change to
   `always-free`. Expected within 60 s: all unlocked future events are free.
   Reload: same.
6. **Task chunk free/busy edit is reverted.** Setup: test 1. Action: in
   Google Calendar, set the "AT-D1" event to busy. Expected within 60 s: the
   event is free again. Reload: same.
