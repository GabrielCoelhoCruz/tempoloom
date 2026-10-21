# Scheduling engine

Spec id: SPEC-PLANNING-00
Evidence: E-0010 (ev_3ce2126cfbf4), E-0042 (ev_4ec67aadde4a), E-0043 (ev_d7b30359b03e), E-0045 (ev_b090cc25cd53), E-0048 (ev_55efef88be5e), E-0051 (ev_936bc1052a22), E-0052 (ev_3db8b91a422f), E-0056 (ev_aa85baa4a4a9), E-0068 (ev_6d15ce331135), E-0069 (ev_56fad64360d1), E-0077 (ev_38c8b46b5b57), E-0081 (ev_dfcc5d3b7c8c), E-0083 (ev_fd7912136937), E-0088 (ev_4fa475edc582), E-0089 (ev_e7262cc4064c), E-0090 (ev_4a54fa9f235a), E-0092 (ev_e2b256d2eb91), E-0103 (ev_170e73774b60), E-0104 (ev_173e10d4937f), E-0105 (ev_3a08a4245510), E-0108 (ev_42940293d611), E-0110 (ev_8a78ca5cc5a3), E-0120 (ev_796e1e3fe2ef), E-0132 (ev_a9d46d5e4718), E-0139 (ev_28aa8ef849b8), E-0141 (ev_d12320a15a83), E-0142 (ev_8d542e73bb87), E-0148 (ev_e7b99cd896e0), E-0161 (ev_e23f32e22a66), E-0172 (ev_d2989bf32eaf), E-0176 (ev_eba8295888d0), E-0183 (ev_000dae433420), E-0190 (ev_39d8d5ed64d6), E-0193 (ev_68ba14aa780b), E-0196 (ev_96353e46340f), E-0201 (ev_182273bc4ff5), E-0203 (ev_6fcb5f8189d7), E-0209 (ev_28b6d44e4b68), E-0212 (ev_7a9bb324e265), E-0216 (ev_d5d172ebc91e), E-0222 (ev_ab1116c8b050), E-0226 (ev_0dc4ddadd24f)
Status of evidence: public docs only

## Summary

The scheduler decides where every managed event goes. It reads the user's
calendars, items, rules and settings, places tasks, habits, flexible
meetings, buffers and focus time in a fixed order, sets each event's free or
busy status, writes only the differences to Google Calendar, and reports what
it could not place and why. For the same input it always gives the same
output.

This spec is the single source for the engine. Feature specs own the fields
and the user interface of each item kind; this spec owns order, constraints,
conflicts, stability and reporting. Where a feature spec of another group
defines a different placement rule inside one item kind (for example, how a
habit picks its slot), that spec wins for that kind; this spec still fixes
the processing order, the hard constraints and the report.

How to read the rules: each subsection lists **Observed rules** first, each
with its evidence. Rules seen only in legacy pages say "(legacy evidence)".
Then each subsection lists **Proposed defaults**: rules that the evidence
does not give, added so that the engine is complete and deterministic. Each
proposed rule starts with "Proposed default:".

## Concepts and inputs

### Terms

| Term | Meaning |
|---|---|
| Run | One execution of the engine. It produces a plan and a report. |
| Now | The time at the start of the run. |
| Grid | The set of allowed start times. |
| Window | From now to the window end (`planning-scheduling-window.md`). |
| Item | A task, habit, flexible meeting, buffer automation or focus time automation. |
| Demand | One unit of time an item needs: one task's remaining work, one habit occurrence, one meeting occurrence, one buffer next to one anchor event, one week of focus time. |
| Placement | A start and end for a demand (or for one chunk of a task demand). |
| Fixed interval | Time the engine cannot use or move (see "Blocking rules"). |
| Level | P1 to P4 (`planning-priorities.md`). |
| Effective level | The level the engine uses for a task after urgency (see "Effective priority"). |
| Band | A group in the processing order. |
| Stickiness | Keeping an existing valid placement instead of searching again. |

### Inputs (one snapshot per run)

0. **Now**: the run time. It is part of the snapshot, so a test can replay a
   run with the same result.
1. **User settings**: home time zone and any active travel zone, week start,
   hours sets, scheduling window, task defaults, urgency mode, chunk
   cooldown, start mode, auto-lock settings, break buffer length, marker
   settings, `taskPlacement`.
2. **Calendar events** from every connected calendar, from 24 hours before now
   to the window end. For each event: id, calendar id, start, end, all-day
   flag, transparency (free or busy), the user's response (organizer,
   accepted, tentative, declined, no answer), title, description, the user's
   response note, location, attendee count, stored level (default P1), and
   two flags: "booked through a booking link" and "managed by Tempoloom" (with
   item id).
3. **Items** of all kinds, with their rules, `enabled` flag, level, stack
   rank, creation time and id.
4. **Current placements**: every existing managed event with its item,
   demand key, times, lock flag, and per-task exclusions and per-item skips.
5. **Change flags**: which items had a rule change since the last run.
6. **Attendee availability** for flexible meetings (flexible meeting spec).

### Time model

- All arithmetic uses absolute instants. Hours ranges are wall-clock times in
  the user's active time zone for each date (`planning-hours.md` HRS-14,
  HRS-16).
- Proposed default: the grid has a 15-minute step for tasks, habits, focus
  time and buffers. Flexible meetings use their start-time interval setting
  (on the hour, or every 15 or 30 minutes) (E-0068). The actions Start,
  Restart and Stop use 5-minute rounding (`planning-task-progress.md`).
- Proposed default: the earliest start of any new placement is now rounded up
  to the next grid point.
- Proposed default: durations are whole minutes; task and habit durations are
  multiples of 15 minutes.

## Behavior

### Triggers

Observed rules:

- **SCH-1.** The engine reacts to calendar changes, such as a new, moved or
  cancelled meeting, and moves managed events within about 15 seconds
  (E-0088, E-0010). An unlocked managed event that a new blocking event
  overlaps moves, whether it is free, busy or past due (legacy evidence,
  E-0120).
- **SCH-2.** An invitation counts as a change in availability only after the
  user answers yes or maybe (E-0088).
- **SCH-3.** A change to an item's rules (for example a task's due date)
  re-places that item's events (legacy evidence, E-0105, E-0088).
- **SCH-4.** A change to an hours set re-places existing and future events
  (E-0172).
- **SCH-5.** A booking through a booking link, a change of level, and a user
  edit of a managed event each trigger a run (E-0088, E-0141, E-0103).
- **SCH-6.** Time-based triggers: the end of an unstarted event in manual
  start mode (legacy evidence, E-0048), the time-used actions (legacy
  evidence, E-0048), the auto-lock job (legacy evidence, E-0045), and new days
  entering the window (E-0042).
- **SCH-7.** Current reference: creating or editing an automation first shows
  its calendar effect as a preview; the user applies it (E-0043, E-0077,
  E-0081, E-0051).
  Tempoloom decision: while preview mode is on (`assistant-preview-mode.md`),
  saving a habit, focus time goal or buffer runs the scheduler on the changed
  rules without saving them, and stages the difference to the current plan;
  with preview mode off the save applies at once.

Proposed defaults:

- **SCH-8.** Proposed default: triggers that arrive within 2 seconds of each
  other start one run. Writes to Google finish within 15 seconds of the first
  trigger.
- **SCH-9.** Proposed default: a safety run happens every 10 minutes and at
  00:05 local time each day, to catch missed notifications and to extend the
  window.
- **SCH-10.** Proposed default: each run plans the whole window from the
  snapshot. Stickiness (SCH-88) keeps the result stable.
- **SCH-11.** Proposed default: the engine has a pure function
  `plan(snapshot) -> {placements, statuses, report}` with no side effects.
  A separate step turns a plan into Google writes. Preview (SCH-7) calls
  `plan` on a changed snapshot and shows the difference without writing.
- **SCH-12.** Proposed default: runs for one user never overlap. A trigger
  during a run starts a new run after it.

### Blocking rules

Which external time a managed item may not use. "Tasks and habits" includes
task chunks and habit events. A blocked interval is a fixed interval for the
named kinds.

Observed rules:

- **SCH-20.** A timed external event blocks all managed items when it is busy
  and the user organizes it, has no attendees, or answered yes or maybe
  (E-0088, E-0089, E-0141). SCH-24 is the one exception.
- **SCH-21.** An invitation the user declined or did not answer blocks
  nothing (E-0088).
- **SCH-22.** An external event marked free blocks nothing, except as SCH-23
  says (E-0089, E-0161).
- **SCH-23.** A free external event with the tag `#tl_busy` blocks tasks and
  habits; it does not block flexible meetings or booking links (E-0161,
  E-0203).
- **SCH-24.** A busy external event with the tag `#tl_free` does not block
  tasks and habits; it still blocks flexible meetings and booking links
  (E-0201, E-0203). Tags are read from the title, the description and the
  user's response note (E-0203).
- **SCH-25.** A busy all-day event blocks its whole day. A free all-day event
  blocks nothing (E-0226, E-0139).
- **SCH-26.** A meeting booked through a booking link blocks all managed items
  at any level (E-0141, E-0090).
- **SCH-27.** External events of every level block all managed items. A
  lowered level matters only to booking links (E-0141, E-0104).
- **SCH-28.** Events on every connected calendar block, including calendars
  hidden in the planner (legacy evidence, E-0139).
- **SCH-29.** A locked managed event blocks all other managed items (E-0108,
  E-0209).

Proposed defaults:

- **SCH-30.** Proposed default: an out-of-office event blocks like a busy
  event.
- **SCH-31.** Proposed default: `#tl_busy` and `#tl_free` also apply to focus
  time and buffers the same way as to tasks and habits.
- **SCH-32.** Proposed default: a managed event of this user always occupies
  its time for other managed items, whatever its calendar and its free or
  busy status (DEF-3). Exception: a demand kept as a conflict (SCH-84).
- **SCH-33.** Proposed default: a flexible meeting organized by another user
  is an external event for this user.

### Hard constraints

A placement that the engine creates or keeps must satisfy all of these. A
placement that would break one is not made; the demand is then reported.

Observed rules:

- **SCH-40.** Inside a range of the item's hours set (E-0088, E-0172).
- **SCH-41.** Inside the window (E-0042, E-0226).
- **SCH-42.** No overlap with a fixed interval for the item's kind (blocking
  rules above).
- **SCH-43.** Task chunks: start at or after `startAfter`; length within the
  chunk bounds; no chunk in an exclusion of the task; gap to the task's other
  chunks per the cooldown (legacy evidence, E-0193, E-0216, E-0056).
- **SCH-44.** Habit: no occurrence in a period that has an external event
  whose title contains one of the habit's reserved words (legacy evidence,
  E-0226). Habit spec owns reserved words.
- **SCH-45.** Flexible meeting: all required attendees are free; no move that
  breaks the minimum lead time; no more automatic moves per 24 hours than the
  meeting's move limit (E-0176, E-0226). Flexible meeting spec owns these.
- **SCH-46.** Break buffer: a gap of at least the break length between two
  managed task or habit events (E-0052). Buffer spec owns the length.
- **SCH-47.** Duration: at least the item's minimum duration (task chunk
  minimum, habit "can shorten to", meeting "can shorten to", focus minimum
  block) (E-0081, E-0176, E-0077, E-0226).

Proposed defaults:

- **SCH-48.** Proposed default: a placement lies fully inside one range of
  the hours set; it never spans the gap between two ranges.
- **SCH-49.** Proposed default: a new placement starts on the grid and at or
  after the earliest start (time model).
- **SCH-50.** Proposed default: two managed placements of this user never
  overlap, except when one is locked by the user (the user chose the overlap)
  or kept as a conflict (SCH-84).
- **SCH-51.** Proposed default: with chunk cooldown `none`, two chunks of one
  task have a gap of at least 15 minutes (`planning-tasks.md` TSK-14).

### What the engine never changes

Observed rules:

- **SCH-55.** It never moves, resizes or deletes an external event (E-0141,
  E-0104, E-0209, E-0142). The only engine-side change to external events is
  the focus time auto-decline option, which answers "no" to an invitation
  (E-0077; focus time spec).
- **SCH-56.** It never moves a meeting booked through a booking link (E-0141,
  E-0090).
- **SCH-57.** It never moves, resizes or deletes a locked managed event
  (E-0108, E-0045). Only the user's unlock, delete, Reschedule or decline
  ends a lock (`planning-locks.md`).
- **SCH-58.** It never places a task chunk in an exclusion, and never places
  again an occurrence the user skipped or deleted with skip meaning (legacy
  evidence, E-0216; E-0077). After a user deletes a managed event, the item
  does not return to the deleted interval: a task chunk goes to the next day
  or later (CED-20), focus time goes elsewhere (CED-25). Proposed default: a
  deleted habit occurrence goes to another time in its window (CED-24).
- **SCH-59.** It keeps user edits of non-task managed events (E-0103) and
  places nothing for items that are turned off (E-0043, E-0110).

Proposed defaults:

- **SCH-60a.** Proposed default: it never moves an event that has started
  (start at or before now). Exceptions: the user's Start, Stop and Restart
  actions, and manual start mode at the event's end
  (`planning-task-progress.md` PRG-3).
- **SCH-60b.** Proposed default: it never writes a Google update when the
  planned event equals the current event (same times, status, title,
  description, visibility). An unchanged plan produces zero writes.

### Processing order

Observed rules:

- **SCH-61.** Fixed things come first: external events, booking-link
  meetings and locked managed events are in place before any demand is
  placed (E-0141, E-0209).
- **SCH-62.** Higher levels go first: P1, then P2, then P3, then P4 (E-0141,
  E-0090).
- **SCH-63.** Current reference: inside a level, automations go in stack-rank
  order (E-0141, E-0043, E-0176).
- **SCH-64.** Legacy reference: inside a level, flexible meetings go first,
  then habits, then tasks (legacy evidence, E-0088, E-0090, E-0209, E-0142).
- **SCH-65.** Tasks of one level go by due date, soonest first (legacy
  evidence, E-0090, E-0209).
- **SCH-66.** Urgency can move a task ahead of a higher-level task that is due
  later (legacy evidence, E-0068, E-0088, E-0090, E-0209).
- **SCH-67.** Next-up tasks go before all other tasks, in queue order; P1
  habits and P1 flexible meetings go before them; locked events stay (legacy
  evidence, E-0209, E-0212).
- **SCH-68.** Focus time goes after all habits, tasks, flexible meetings and
  buffers, at any level (E-0077, E-0141, E-0090).
- **SCH-69.** Buffer automations have a level and take part in the level
  order (E-0141, E-0051).

Proposed defaults (the complete order):

- **SCH-70.** Proposed default: the engine processes demands in these bands:

  ```
  for level in [P1, P2, P3, P4]:
      band A(level): automations of this level (flexible meetings,
                     buffers, habits), by stack rank
      if level == P1:
          band N: next-up tasks, by queue rank
      band T(level): tasks whose effective level is this level and that are
                     not in the next-up queue, by task key
  band F: focus time automations (including the meeting overload
          automation), by stack rank among themselves
  ```

- **SCH-71.** Proposed default: stack rank is one list per level. A new
  automation is inserted after the last automation of the same level whose
  kind comes at or before it in the kind order "flexible meeting, buffer,
  habit"; if none, at the top of the level. This keeps the legacy kind order
  (SCH-64) until the user drags. Buffers come before habits because a buffer
  has only one possible position.
- **SCH-72.** Proposed default: task key = (due date ascending, tasks with no
  due date last; remaining minutes descending; creation time ascending; id
  ascending).
- **SCH-73.** Proposed default: demands of one item go in time order of their
  period (occurrence date, or week start).
- **SCH-74.** Proposed default: final tie-break for any two items in the same
  band and same rank: creation time ascending, then id ascending.
- **SCH-75.** Proposed default: with `taskPlacement` `suggestions`, bands N
  and T are empty.

### Effective priority

Observed rules:

- **SCH-76.** The urgency mode has three values: priority only, due date, and
  due date with remaining work (default) (legacy evidence, E-0068).

Proposed defaults:

- **SCH-77.** Proposed default: `priority-only`: effective level = level.
- **SCH-78.** Proposed default: `due-date`: when the due date is 48 hours or
  less from now (or past), effective level = one level higher (P3 becomes P2),
  never above P1.
- **SCH-79.** Proposed default: `due-date-and-work`: let `avail` be the
  minutes inside the task's hours set from `max(now, startAfter)` to the due
  date, minus fixed intervals for tasks. Let `ratio` = `avail` ÷
  `remainingMinutes`. If `ratio` < 1.25, effective level = two levels higher;
  else if `ratio` < 2, one level higher; else the level. Never above P1. A
  task with no due date keeps its level. `avail` ignores other managed
  items, so the value does not depend on processing order.
- **SCH-80.** Proposed default: effective level changes only the band of the
  task. It applies in rule PRI-10 the same way as a real level.

### Placement of each demand

Observed rules:

- **SCH-81.** Tasks: placed before the due date when possible, split into
  chunks within the bounds; next-up tasks as early as possible (legacy
  evidence, E-0193, E-0120, E-0212).
- **SCH-82.** Habits: as close as possible to the ideal time inside the
  habit's window; the duration may shrink down to "can shorten to"; in
  defense mode `always-free` the ideal time wins over full duration, in
  `always-busy` full duration wins over the ideal time (E-0081, E-0196).
- **SCH-83.** Flexible meetings: the best common time for all attendees, as
  close as possible to the preferred time (E-0088, E-0176).
- **SCH-84.** When no time is left: habits and flexible meetings are either
  removed, or left in place and flagged as overlapping, per the item's
  setting; buffers are removed by default and can be set to stay and overlap
  (E-0081, E-0176, E-0051).
- **SCH-85.** When remaining task work does not fit before the due date, the
  rest goes after the due date (legacy evidence, E-0120, E-0216).
- **SCH-86.** Focus time: placed toward the weekly goal, within daily minimum
  and maximum, in blocks of at least the minimum block; work tasks, work
  habits and events with the focus tag count toward the goal (E-0077,
  E-0083, E-0090, E-0203).
- **SCH-87.** Legacy note: a recovery buffer could overlap a free habit or
  task event, and was removed when that event became busy (legacy evidence,
  E-0069). The current reference uses buffer levels instead (E-0051); this
  spec follows the current reference.

Proposed defaults:

- **SCH-88.** Proposed default, stickiness: for each demand, the engine
  first tries to keep the demand's current placement. It keeps it when all
  are true: the event has not been deleted, the item had no rule change
  (input 5), the placement satisfies every hard constraint against the fixed
  intervals and the placements already made in this run, and (for tasks) the
  task has no due date or its current chunks cover all remaining work and
  end by the due date. Otherwise the engine searches a new placement.
- **SCH-89.** Proposed default, free intervals: for a demand of kind K, the
  free intervals are its hours ranges inside the window, after its own lower
  bounds (`startAfter`, earliest start), minus fixed intervals for K, minus
  placements already made in this run (with break buffer padding for task
  and habit neighbours), minus exclusions and skips.
- **SCH-90.** Proposed default, task placement (chunk mode):

  ```
  need = remainingMinutes - minutes of locked future chunks
  keep the valid sticky chunks (SCH-88) first, oldest start first (a chunk
  shorter than minChunk last: it is the rest, TSK-13), while their
  sum <= need;
      if the next sticky chunk would exceed need, shorten it to the rest
      when the rest >= minChunk, else drop it;
      drop a sticky chunk that would leave a rest with no split when the
      need before it had one (TSK-13)
  need = need - kept minutes
  if ceil(need / maxChunk) * minChunk > need and need > maxChunk:
      # no split (TSK-13): rest = need - (ceil(need / maxChunk) - 1) * maxChunk
      place need - rest with the loop below
      if all of it is placed: place rest with the loop below, in the
          free intervals minus the new chunks and their cooldown gap
      else: rest is unplaced
      stop
  for each free interval I in time order:
      cursor = I.start
      while need > 0 and cursor < I.end:
          room = floor_to_grid(I.end - cursor)
          len  = min(maxChunk, need, room)
          k    = ceil(need / maxChunk)
          if k * minChunk <= need:            # a split exists (TSK-13)
              len = min(len, need - (k - 1) * minChunk)
              rest = need - len
              if ceil(rest / maxChunk) * minChunk > rest:
                  len = need - ceil(rest / maxChunk) * minChunk
                                             # keep the rest splittable
          # else: need < minChunk, one short chunk of need
          if len < minChunk and not (need < minChunk and len == need):
              break                          # interval too small
          place chunk [cursor, cursor + len]
          need = need - len
          cursor = cursor + len + cooldown_gap
          if cooldown is once-per-day: move to the next day
  ```

  A new chunk keeps the cooldown gap (and the 15-minute minimum of SCH-51)
  from every chunk of the same task: kept, locked or new. Chunks after the
  due date are allowed (SCH-85). If `need` > 0 at the window end, the rest is
  unplaced.
- **SCH-91.** Proposed default, habit placement (unless the habit spec says
  otherwise): candidates are grid starts in the habit's window on each
  allowed day of the period. Score = absolute distance from the ideal start;
  ties go to the earlier start. Modes `adaptive` and `always-busy`: search all
  candidates at full duration first; if none fits, search again with the
  duration lowered in 15-minute steps down to the minimum. Mode
  `always-free`: at each candidate in score order, take the longest duration
  that fits, from full down to the minimum.
- **SCH-92.** Proposed default, flexible meeting placement (unless the
  flexible meeting spec says otherwise): candidates are starts on the
  meeting's start-time grid inside the meeting's hours, where all required
  attendees are free and the start is at least the lead time from now. Score
  = distance from the preferred time; ties go to the earlier start.
- **SCH-93.** Proposed default, buffer placement (unless the buffer spec says
  otherwise): one candidate per anchor event, directly before or after it as
  the automation says. If the candidate breaks a hard constraint, the buffer
  is removed or kept as a conflict per its setting.
- **SCH-94.** Proposed default, focus time placement (unless the focus time
  spec says otherwise): need = weekly goal minus credited minutes. Pass 1:
  for each workday of the week in order, place blocks until the day holds the
  daily minimum. Pass 2: for each day in order, add blocks until the day holds
  the daily maximum or the weekly need is met. In each day, use the longest
  free interval first (ties: earlier); a block is
  `min(interval length, day cap left, week need left)` and is placed only if
  it is at least the minimum block.
- **SCH-95.** Proposed default, kept as a conflict: a demand with the "keep as
  conflict" setting and no valid placement keeps its current placement, or,
  if it has none, gets its best candidate ignoring other managed placements.
  It is marked as a conflict in the report, its title gets the conflict
  marker (`events-title-emoji.md`), and it does not block later demands.

### Free and busy status

Observed rules (details in `planning-defense.md`):

| Kind | Status rule | Evidence |
|---|---|---|
| Any locked event | busy | E-0089, E-0108 |
| Task chunk | free if the task has another way to fit all remaining work by the due date; else busy; all busy when any chunk is after the due date | legacy evidence, E-0120, E-0216 |
| Habit event | by defense mode; `adaptive` starts free, turns busy when time gets short or near | E-0081, E-0196 |
| Flexible meeting event | free; busy when less than 12 hours ahead or only one slot left that day | legacy evidence, E-0092 |
| Focus time event | no switching; the automation's setting | E-0089, E-0043 |
| Buffer event | the automation's setting | E-0043 |
| Booking-link meeting | busy | E-0088 |

- **SCH-100.** Status never changes which item may take a placement
  (legacy evidence, E-0120; DEF-3).

Proposed defaults:

- **SCH-101.** Proposed default: the engine computes status after all bands
  are placed, with DEF-11 for tasks (using the free intervals the task saw
  when it was placed) and DEF-23 for `adaptive` habits.

### Booking link availability

Observed rules:

- **SCH-105.** A booking link of level L shows as open the time of unlocked
  managed events below L and of external events lowered below L; focus time
  events count as P2 (E-0141, E-0077, E-0088).
- **SCH-106.** After a booking, the engine moves the managed demand that held
  the time (E-0141, E-0088).

Proposed default:

- **SCH-107.** Proposed default: the engine exposes
  `openTimeForLink(level, range)` = hours of the link minus every blocking
  interval except: managed events with effective level below `level` that are
  not locked, and external events with stored level below `level`.

### Reporting what cannot be placed

Observed rules:

- **SCH-110.** A task that the engine cannot place is open but not scheduled;
  the evidence names two causes: a start date beyond the window and
  constraints that can never fit, such as a long chunk (legacy evidence,
  E-0190).
- **SCH-111.** Causes listed for items that do not get placed: busy all-day
  events, too many items at a high level, hours too narrow, minimum or
  maximum duration too large, a habit reserved word, no common time with
  attendees, no space left, and the window (legacy evidence, E-0226).
- **SCH-112.** The current reference flags conflicts and problems as issues
  and suggests fixes, including conflicts between external events, missing
  focus time and skipped routines (E-0141, E-0183, E-0148).
- **SCH-113.** A flexible meeting stops moving when it reaches its move limit
  and the conflict is flagged instead (E-0176).
- **SCH-114.** Legacy reference: a flexible meeting view shows the periods
  skipped because no time was found, and a change log explains each skip and
  move (legacy evidence, E-0092).

Proposed defaults:

- **SCH-115.** Proposed default: each run returns a report with one entry per
  demand that is not fully placed, kept as a conflict, or placed after its
  due date:

  ```
  { itemKind, itemId, demandKey, period,
    requiredMinutes, placedMinutes, missingMinutes,
    status: "unplaced" | "partial" | "after-due" | "conflict",
    reason, blockingEventIds[], firstSeenAt }
  ```

- **SCH-116.** Proposed default: the engine sets `reason` to the first code in
  this list that explains the shortfall:

  | Order | Code | Test |
  |---|---|---|
  | 1 | `outside-window` | the demand's earliest allowed start is after the window end |
  | 2 | `no-hours` | the hours set has no range between the earliest start and the window end (or the period end) |
  | 3 | `too-long-for-hours` | the minimum length is longer than every hours range in that span |
  | 4 | `all-day-block` | every day in that span is blocked by busy all-day events |
  | 5 | `reserved-word` | habits only: a reserved-word event exists in the period |
  | 6 | `no-common-time` | flexible meetings only: no slot where all attendees are free |
  | 7 | `move-limit` | flexible meetings only: the move limit or lead time stops the move |
  | 8 | `no-space-fixed` | the demand does not fit even with all managed placements of this run removed |
  | 9 | `no-space-priority` | the demand fits only without the managed placements made before it in this run |
  | 10 | `after-due` | tasks only: placed fully, but some work ends after the due date |

- **SCH-117.** Proposed default: `blockingEventIds` lists up to 5 events that
  cover the most minutes of the best candidate area, largest first.
- **SCH-118.** Proposed default: the report shows in the task list (open but
  not scheduled, with the reason), as a badge on the automation in the
  automation list, and in the issues list. An entry disappears on the first
  run that places the demand fully. Feature specs may word the reason for
  users (for example "no room in window" for habits, "goal not reached" for
  focus time); the stored code is always one from SCH-116.
- **SCH-119.** Proposed default: the engine keeps a change log per item for 30
  days: run time, action (placed, moved, removed, kept as conflict, status
  change), old and new times, and reason code.

  Tempoloom decision: a period that gets no event is logged as "skipped". A
  removal or skip carries the SCH-116 code of the run's report. A move that
  the report does not explain gets `no-space-fixed` (another event now covers
  the old time), `no-space-priority` (another item of the run took it),
  `rules-changed` (the item's settings changed) or `rearranged`; a snooze
  that moves a started event later is a move with `snoozed`. The log shows
  under each task and automation, and on the flexible meeting view.

## Outputs

- Google Calendar writes: creates, updates (time, status, title marker,
  description, visibility) and deletes of managed events only.
- Proposed default: writes go in this order: deletes, then updates, then
  creates, so that no moment shows two copies of one demand.
- Proposed default: every managed event carries private extended properties:
  app marker, item kind, item id, demand key. The engine uses them to match
  plan entries to existing events and keeps the same Google event id when it
  moves a demand.
- Flexible meeting writes send attendee update emails per
  `planning-notifications.md` NTF-20.
- The report and the change log (SCH-115 to SCH-119).

## Edge cases

1. Two demands have the same key and the same best slot: the processing
   order decides (SCH-70 to SCH-74); the later one searches again.
2. A locked event lies outside its hours: it stays and blocks others (SCH-29,
   SCH-57).
3. A user-locked event overlaps another managed event: both stay where they
   are if the other is also locked; an unlocked one moves (SCH-50).
4. The time zone changes between runs: hours ranges map to new instants;
   stickiness keeps placements that still fit; others move.
5. A daylight-saving change shortens a range: placements that no longer fit
   are searched again.
6. A demand's only candidate is taken by an equal-level item with a better
   rank: the demand is reported with `no-space-priority`.
7. All items are at P1: the order still works (bands A, N, T of P1), and
   lower items wait; the report shows `no-space-priority` (E-0226).
8. A task whose `startAfter` is after its due date: rejected by the form
   (`planning-tasks.md` edge case 6); the engine treats it as
   `outside-window` if it reaches it.
9. The window end falls inside a habit's week: see
   `planning-scheduling-window.md` edge case 1.
10. Google write fails for one event: the engine retries on the next run and
    does not report the demand as placed until the write succeeds. Proposed
    default.

## Observed API shapes

Not yet observed.

## Open questions

1. Does the current reference still place task chunks at all? It moved tasks
   to suggestions (E-0183). This spec keeps chunks per the glossary.
2. The exact urgency formula is not in the evidence (SCH-79).
3. Does the reference move items to better times when space opens up
   (pull-forward), or does it keep them (SCH-88)?
4. How do stack rank and the legacy kind order combine for items the user
   never dragged (SCH-71)?
5. What do habits and flexible meetings do by default when no time is left:
   remove or keep as conflict (SCH-84)?

## Acceptance tests

### Fixtures

**F0.** Google test account A. Time zone Europe/Berlin, week starts Monday,
24-hour format. W is the first Monday-to-Sunday week that starts at least
2 days after the test starts and has no daylight-saving change. The primary
calendar has no events in W, W+1 and W+2 except those the test makes, and one
busy event "F0 blocker" that the user organizes, from the test start to
Monday W 00:00, so that nothing is placed before W. Work and meeting hours:
Monday to Friday 09:00 to 17:00. Personal hours: every day 18:00 to 21:00.
Scheduling window 3 weeks. Task defaults: P2, split on, chunks 30 to 120
minutes, cooldown `none`, start mode `auto`, urgency mode `priority-only`.
No habits, buffers, focus time or flexible meetings unless the test adds
them. Markers on at the start of the title. A second Google test account B
exists for attendee tests.

**F1.** F0 without "F0 blocker", plus a custom hours set "AT-Always" (every
day 00:00 to 24:00) allowed for all kinds.

**Method.** Tests read Google Calendar through the API as account A. "Within
60 s" means: poll every 5 seconds for up to 60 seconds (the product target is
15 seconds). "Reload" means: reload the planner page, check the same state,
and read Google again after 2 minutes to check that nothing moved. Each run
saves the API responses and planner screenshots.

### Scenarios

1. **Higher level takes a slot; lower item moves or is reported.** Setup: F0;
   P3 habit "AT-S1 Walk", 60 minutes, Tuesday W only, window 14:00 to 15:00,
   remove when no time; external busy events Tuesday W 09:00 to 14:00 and
   16:00 to 17:00. Action: create P1 task "AT-S1 Fix", 120 minutes, split off,
   `startAfter` Tuesday W 00:00, due Tuesday W 16:00. Expected within 60 s:
   "AT-S1 Fix" is Tuesday 14:00 to 16:00; no "AT-S1 Walk" event on Tuesday;
   the report has "AT-S1 Walk" with reason `no-space-priority`. Reload: same.
2. **External events are never taken.** Setup: F0; external busy event
   "AT-S2 Offsite" Monday W 09:00 to 17:00, level lowered to P4. Action:
   create P1 task "AT-S2", 60 minutes, `startAfter` Monday W 00:00, due
   Monday W 17:00. Expected: "AT-S2" is Tuesday W 09:00 to 10:00, busy, and
   the report has reason `after-due`. "AT-S2 Offsite" is unchanged. Reload:
   same.
3. **Unanswered invitation does not block; acceptance does.** Setup: F0;
   task "AT-S3", 60 minutes, split off, placed Monday W 09:00. Action:
   account B invites A to Monday W 09:00 to 10:00. Expected after 60 s:
   "AT-S3" has not moved. Action: A accepts. Expected within 60 s: "AT-S3"
   no longer overlaps 09:00 to 10:00. Reload: same.
4. **Free and tagged events.** Setup: F0. External events on Monday W: a free
   event 09:00 to 12:00; a free event with `#tl_busy` 12:00 to 14:00; a busy
   event with `#tl_free` 14:00 to 17:00. Action: create task "AT-S4",
   480 minutes, chunks 60 to 120, `startAfter` Monday W 00:00. Expected:
   "AT-S4" chunks on Monday lie in 09:00 to 12:00 and 14:00 to 17:00; none in
   12:00 to 14:00. Reload: same.
5. **All-day events.** Setup: F0; a busy all-day event on Monday W and a free
   all-day event on Tuesday W. Action: create task "AT-S5", 60 minutes,
   `startAfter` Monday W 00:00. Expected: "AT-S5" is Tuesday W 09:00 to 10:00.
   Reload: same.
6. **Kind order inside a level.** Setup: F0; on Wednesday W only 10:00 to
   11:00 is free (busy external events fill the rest of work hours). Action:
   create, in this order, P2 task "AT-S6 task" (60 minutes, split off,
   `startAfter` Wednesday W, due Wednesday W 17:00), P2 habit "AT-S6 habit"
   (60 minutes, Wednesday window 10:00 to 11:00) and P2 flexible meeting
   "AT-S6 meet" with account B (60 minutes, Wednesday 10:00 to 11:00, B free).
   Expected within 60 s: "AT-S6 meet" holds 10:00 to 11:00; the habit and the
   task are not in that slot; the report lists the habit with
   `no-space-priority` and the task with `after-due` (it is placed on
   Thursday W and is busy). Reload: same.
7. **Focus time goes last.** Setup: F0; focus time goal 40 hours per week,
   minimum block 60 minutes. Action: create P4 task "AT-S7", 120 minutes,
   split off, `startAfter` Monday W. Expected within 60 s: "AT-S7" is Monday
   W 09:00 to 11:00 and no focus event overlaps it. Reload: same.
8. **No churn.** Setup: scenario 1 finished. Action: change an unrelated
   setting (the planner day filter) and wait 2 minutes; then trigger a
   safety run. Expected: every managed event in W has the same Google `etag`
   and `updated` time as before. Reload: same.
9. **Stability when a lower item arrives.** Setup: F0; P2 task "AT-S9a",
   120 minutes, split off, placed Monday W 09:00. Action: create P4 habit
   "AT-S9b", 60 minutes daily, window 09:00 to 12:00, ideal time 09:00.
   Expected: "AT-S9a" keeps its event id and times; "AT-S9b" on Monday is
   11:00 to 12:00. Reload: same.
10. **Unplaced reason: too long for hours.** Setup: F0 with Thursday and
    Friday work hours 09:00 to 12:00 and 13:00 to 17:00 and other weekdays off.
    Action: create task "AT-S10", 300 minutes, split off, `startAfter`
    Thursday W. Expected: no "AT-S10" event; the report gives
    `too-long-for-hours`. Reload: same.
11. **Unplaced reason: fixed versus priority.** Setup: F0 with external busy
    events filling all work hours of W, W+1 and W+2. Action: create task
    "AT-S11a", 60 minutes. Expected: reason `no-space-fixed`. Setup 2: F0
    with only Monday W 09:00 to 10:00 free in the whole window and a P1 task
    "AT-S11b" of 60 minutes placed there. Action: create P3 task "AT-S11c",
    60 minutes. Expected: reason `no-space-priority`. Reload: same.
12. **Locked events never move.** Setup: F0; task "AT-S12", 60 minutes,
    locked at Monday W 10:00. Action: create a P1 task "AT-S12 big",
    480 minutes, split off, `startAfter` Monday W, due Monday W 17:00.
    Expected: "AT-S12" is still Monday 10:00 to 11:00; "AT-S12 big" does
    not overlap it. Reload: same.
13. **Booking over a lower habit.** Setup: F0; P4 habit "AT-S13", 60 minutes,
    Tuesday window 10:00 to 14:00, placed Tuesday W 10:00; a P1 booking link.
    Action: account B books Tuesday W 10:00 to 11:00 through the link.
    Expected within 60 s: the booked meeting is busy at 10:00; "AT-S13"
    moved to another time in its window. Reload: same.
14. **Urgency boost (Proposed default SCH-79).** Setup: F0 with urgency mode
    `due-date-and-work`; P2 task "AT-S14a", 240 minutes, split off, due
    Friday W+2; P3 task "AT-S14b", 360 minutes, chunks 60 to 240, due
    Monday W 17:00; both `startAfter` Monday W 00:00. Expected: the first
    "AT-S14b" chunk starts Monday W 09:00, before any "AT-S14a" chunk.
    Reload: same.
15. **Next-up after P1 habits (Proposed default SCH-70).** Setup: F0; P1 habit
    "AT-S15 lunch", 60 minutes, Monday window 12:00 to 13:00; P2 habit
    "AT-S15 walk", 60 minutes, Monday window 09:00 to 10:00; next-up task
    "AT-S15 now", 60 minutes, split off, `startAfter` Monday W. Expected:
    lunch is 12:00 to 13:00; "AT-S15 now" is Monday 09:00 to 10:00; the walk
    habit is not at 09:00. Reload: same.
16. **Reaction time.** Setup: F0; task "AT-S16" placed Monday W 09:00. Action:
    create an external busy event Monday W 09:00 to 10:00. Expected: "AT-S16"
    moves within 60 s; the log shows the move within 15 s of the change
    notification. Reload: same.
17. **Preview does not write.** Setup: F0. Action: open the editor of a new
    habit "AT-S17", set it up, and view the preview without applying.
    Expected: the planner shows preview events; Google has no "AT-S17"
    event. Action: apply. Expected within 60 s: Google has the events.
